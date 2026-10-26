"""Read public Telegram channels through their t.me/s/<channel> web preview (no login)."""

import html
import re
import time
from urllib.parse import urlparse

import httpx

from store import extras_config

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
IMAGE_HOST_SUFFIXES = (".telesco.pe", ".cdn-telegram.org", ".telegram.org")
MAX_IMAGE_BYTES = 5 * 1024 * 1024
POST_RE = re.compile(r"^([A-Za-z0-9_]{4,32})/(\d{1,9})$")

_cache: dict[str, tuple[float, list[dict]]] = {}


def allowed_channels() -> list[str]:
    return [c.lower() for c in extras_config().get("telegram", {}).get("channels", [])]


def _check_channel(channel: str) -> str:
    channel = channel.strip().lstrip("@").lower()
    if channel not in allowed_channels():
        raise ValueError(f"只能看这些频道：{', '.join(allowed_channels()) or '（未配置）'}")
    return channel


def _strip(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def _parse(page: str, channel: str) -> list[dict]:
    posts = []
    for block in page.split('class="tgme_widget_message_wrap')[1:]:
        m = re.search(r'data-post="([^"]+)"', block)
        if not m or not m.group(1).lower().startswith(channel + "/"):
            continue
        text_m = re.search(r'tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', block, re.S)
        photos = re.findall(r"tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)", block)
        # 视频/动图帖没有 photo_wrap，只有一张封面（video_thumb）；拿封面给她看个大概
        thumbs = re.findall(r"tgme_widget_message_video_thumb[^>]*background-image:url\('([^']+)'\)", block)
        date_m = re.search(r'datetime="([^"]+)"', block)
        posts.append({
            "post": m.group(1),
            "text": _strip(text_m.group(1))[:300] if text_m else "",
            "images": len(photos),
            "hasVideo": "tgme_widget_message_video" in block,
            "date": date_m.group(1)[:16] if date_m else "",
            "_photoUrls": photos,
            "_videoThumbs": thumbs,
        })
    return posts


def browse(channel: str, before: int | None = None) -> list[dict]:
    channel = _check_channel(channel)
    url = f"https://t.me/s/{channel}" + (f"?before={int(before)}" if before else "")
    cached = _cache.get(url)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    r = httpx.get(url, headers=UA, timeout=20, follow_redirects=True)
    r.raise_for_status()
    posts = _parse(r.text, channel)
    if not posts:
        raise ValueError("这个频道的网页预览打不开（可能被 Telegram 限制了网页展示），换一个频道")
    posts.reverse()  # newest first
    limit = int(extras_config().get("telegram", {}).get("postsPerBrowse", 10))
    _cache[url] = (time.time(), posts[:limit])
    return posts[:limit]


def find_post(post: str) -> dict:
    m = POST_RE.match(post.strip())
    if not m:
        raise ValueError('post 的格式是 "频道名/编号"，从 tg_browse 的结果里拿')
    channel = _check_channel(m.group(1))
    for _, (_, posts) in list(_cache.items()):
        for p in posts:
            if p["post"].lower() == post.strip().lower():
                return p
    # Not in cache (e.g. after a restart): open the page that ends at this post.
    for p in browse(channel, before=int(m.group(2)) + 1):
        if p["post"].lower() == post.strip().lower():
            return p
    raise ValueError("找不到这条帖子，先用 tg_browse 看一下最新的")


def download_image(url: str) -> tuple[bytes, str]:
    host = urlparse(url).hostname or ""
    if urlparse(url).scheme != "https" or not host.endswith(IMAGE_HOST_SUFFIXES):
        raise ValueError("只下载 Telegram 图床上的图片")
    with httpx.stream("GET", url, headers=UA, timeout=30) as r:
        r.raise_for_status()
        data = b""
        for chunk in r.iter_bytes():
            data += chunk
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("图片太大")
    if data[:3] == b"\xff\xd8\xff":
        return data, "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return data, "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return data, "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return data, "gif"
    raise ValueError("下载到的不是图片")
