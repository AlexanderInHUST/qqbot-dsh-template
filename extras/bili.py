"""bili_watch: open a Bilibili video in the sandbox browser, skim it, and read what it is about.

Bilibili answers 412 to cookie-less server requests, so every API call runs inside the logged-in
sandbox browser (through Playwright MCP's browser_evaluate). The page is really opened and the video
plays muted, so it is visible on noVNC. Subtitles use the wbi-signed player API: the unsigned one
sometimes returns another video's subtitles.

Watching works like dragging the progress bar: a short video is sampled every 10 seconds, a longer one
at 30 evenly spaced points (every 30 s for a 15-minute video). At each point the video plays for a few
seconds and the frame is drawn into one contact sheet (a grid of thumbnails, each labelled with its
timestamp), so a whole video costs one image in the model's context instead of thirty - the relay rejects
requests with more than 32 images. One video takes about two minutes, like actually watching it (with 10
points and 1.5 s each she skimmed a 15-minute video in 40 s and went straight to the next thing). The
subtitles and danmaku around each point come back as text. At the end the video is paused so Bilibili
does not autoplay the next one, and Bilibili's "自动连播" switch is turned off on every watch: a video
she clicks on the home page opens in a new tab that plays by itself, and with autoplay on it went on to
the next one and the next, so her account history filled with things she never saw.
"""

import base64
import collections
import hashlib
import json
import os
import re
import time
import urllib.parse

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.fastmcp import Image

import store

BROWSER_MCP = os.environ.get("BROWSER_MCP_URL", "http://mcp-gw:8931/mcp")
BVID_RE = re.compile(r"BV[0-9A-Za-z]{10}")
MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
         12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
         57, 62, 11, 36, 20, 34, 44, 52]
SUBTITLE_CHARS = 5000
FRAME_EVERY_SEC = 10      # short videos: one frame every 10 s
MAX_FRAMES = 30           # longer videos: this many frames spread over the whole video
PLAY_MS_PER_FRAME = 3000  # let each point actually play a few seconds before grabbing the frame
# After a jump the video first has to buffer. Waiting for play() alone took up to ~10 s per point on
# 20-minute 1080p videos (2026-10-22: a 23-minute one took 358 s in total). So wait at most this long
# for playback to start, then play PLAY_MS_PER_FRAME regardless; a stalled video can't hang the tool.
BUFFER_WAIT_MS = 3000
CELL_W, CELL_H = 256, 144  # one thumbnail in the contact sheet (5 x 6 of them: 1280 x 864)
SHEET_COLS = 5
# 30 points x (3 s + seek) plus loading the page is two to four minutes. DSH doesn't time tools out
# (toolCallTimeoutMs in config/dsh/home.cordis.patch.yml is the timer maximum).

PAGE_INFO_JS = """async () => {
  const j = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
  const bvid = location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0];
  const view = (await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)).data || {};
  const nav = (await j('https://api.bilibili.com/x/web-interface/nav')).data || {};
  const rep = (await j(`https://api.bilibili.com/x/v2/reply?type=1&oid=${view.aid}&sort=1&ps=20`)).data || {};
  const xml = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${view.cid}`, { credentials: 'include' }).then((r) => r.text());
  const v = document.querySelector('video');
  if (v) { v.muted = true; v.play().catch(() => {}); }
  // keep "自动连播" off (stored in localStorage, so every tab follows it): tabs she opened from the
  // home page kept autoplaying one video after another (2026-10-24: 《FX战士久留美》第4话 she never saw)
  try { localStorage.setItem('recommend_auto_play', 'close'); } catch (e) {}
  document.querySelector('.continuous-btn .switch-btn.on')?.click();
  return {
    bvid, cid: view.cid, title: view.title, desc: (view.desc || '').slice(0, 500), owner: view.owner?.name,
    duration: view.duration, tname: view.tname, stat: view.stat, wbi: nav.wbi_img, isLogin: nav.isLogin,
    replies: (rep.replies || []).map((r) => ({ like: r.like, text: (r.content?.message || '').slice(0, 150) })),
    danmaku: [...xml.matchAll(/<d p="([0-9.]+)[^"]*">([^<]+)<\\/d>/g)].slice(0, 3000).map((m) => [Number(m[1]), m[2]]),
    videoDuration: v && Number.isFinite(v.duration) ? v.duration : null,
  };
}"""

SUBTITLE_JS = """async () => {
  const pl = await fetch('https://api.bilibili.com/x/player/wbi/v2?__QUERY__', { credentials: 'include' }).then((r) => r.json());
  const subs = pl.data?.subtitle?.subtitles || [];
  const pick = subs.find((s) => s.lan === 'ai-zh') || subs.find((s) => /zh/.test(s.lan)) || subs[0];
  if (!pick?.subtitle_url) return { cid: pl.data?.cid, lan: null, lines: [] };
  const s = await fetch(pick.subtitle_url.replace(/^\\/\\//, 'https://')).then((r) => r.json());
  return { cid: pl.data?.cid, lan: pick.lan, lines: (s.body || []).map((x) => [Math.round(x.from), x.content]) };
}"""


SHEET_INIT_JS = """() => {
  const c = document.createElement('canvas');
  c.width = __COLS__ * __CW__; c.height = Math.ceil(__N__ / __COLS__) * __CH__;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  window.__qqSheet = c;
  return true;
}"""

SEEK_JS = """async () => {
  const v = document.querySelector('video');
  if (!v) return null;
  v.muted = true;
  v.currentTime = __T__;
  // play() only resolves once enough is buffered; don't wait for that forever
  await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, __BUFFER_MS__))]);
  await new Promise((r) => setTimeout(r, __PLAY_MS__));
  let drawn = false;
  try {
    const c = window.__qqSheet, g = c.getContext('2d');
    const x = (__I__ % __COLS__) * __CW__, y = Math.floor(__I__ / __COLS__) * __CH__;
    g.drawImage(v, x, y, __CW__, __CH__);
    const t = Math.floor(v.currentTime), label = `${__I__ + 1}  ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    g.font = 'bold 16px sans-serif'; g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, g.measureText(label).width + 12, 24);
    g.fillStyle = '#fff'; g.fillText(label, x + 6, y + 18);
    drawn = true;
  } catch (e) { drawn = false; }  // tainted canvas: fall back to a page screenshot
  return { t: v.currentTime, duration: v.duration, drawn };
}"""

FINISH_JS = """() => {
  const v = document.querySelector('video');
  if (v) v.pause();
  try { return window.__qqSheet.toDataURL('image/jpeg', 0.75).split(',')[1]; } catch (e) { return null; }
}"""


def _bvid(video: str) -> str:
    m = BVID_RE.search(video or "")
    if not m:
        raise ValueError("给一个 BV 号或者带 BV 号的视频链接")
    return m.group(0)


def _wbi_query(params: dict, wbi_img: dict) -> str:
    key = "".join(u.rsplit("/", 1)[1].split(".")[0] for u in (wbi_img["img_url"], wbi_img["sub_url"]))
    mixin = "".join(key[i] for i in MIXIN)[:32]
    params = dict(params, wts=int(time.time()))
    q = urllib.parse.urlencode({k: re.sub(r"[!'()*]", "", str(params[k])) for k in sorted(params)})
    return q + "&w_rid=" + hashlib.md5((q + mixin).encode()).hexdigest()


def _result(call_result) -> object:
    """Pull the JSON value out of Playwright MCP's '### Result' markdown block."""
    text = "\n".join(c.text for c in call_result.content if getattr(c, "type", "") == "text")
    if "### Error" in text or call_result.isError:
        raise RuntimeError(text.strip().splitlines()[-1][:200])
    m = re.search(r"### Result\n(.*?)(?:\n### |\Z)", text, re.S)
    return json.loads(m.group(1)) if m else None


def _top_danmaku(items: list[str], n: int = 15) -> list[str]:
    norm = collections.Counter(re.sub(r"(.)\1{3,}", r"\1\1\1", d.strip()) for d in items if d and d.strip())
    return [f"{t}（×{c}）" if c > 1 else t for t, c in norm.most_common(n)]


def _condense(lines: list, limit: int = SUBTITLE_CHARS) -> str:
    """Keep the subtitle readable within a budget: evenly sample lines across the whole video."""
    rendered = [f"[{s // 60:02d}:{s % 60:02d}] {t}" for s, t in lines]
    total = sum(len(r) + 1 for r in rendered)
    if total <= limit:
        return "\n".join(rendered)
    keep = max(1, len(rendered) * limit // total)
    picked = [rendered[i * len(rendered) // keep] for i in range(keep)]
    return "（字幕太长，按时间均匀抽取）\n" + "\n".join(picked)


def _mmss(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 60:02d}:{sec % 60:02d}"


def plan_frames(length: float) -> list[int]:
    """Timestamps to look at: every 10 s for short videos, MAX_FRAMES evenly spread for longer ones."""
    if length <= 0:
        return [0]
    if length <= FRAME_EVERY_SEC * MAX_FRAMES:
        return list(range(min(5, int(length // 2)), int(length) - 1, FRAME_EVERY_SEC)) or [0]
    step = length / MAX_FRAMES
    return [round(step * (i + 0.5)) for i in range(MAX_FRAMES)]



def _around(t: float, subs: list, danmaku: list, before: float = 12, after: float = 8) -> str:
    """Subtitle lines and the most repeated danmaku near second t."""
    said = "".join(text for s, text in subs if t - before <= s <= t + after)[:200]
    dms = _top_danmaku([d for s, d in danmaku if t - before <= s <= t + after + 7], 4)
    parts = [f"[{_mmss(t)}]"]
    parts.append(f"字幕：{said}" if said else "（这段没有字幕）")
    if dms:
        parts.append("弹幕：" + " / ".join(dms))
    return " ".join(parts)


def _screenshot_image(call_result) -> Image | None:
    for c in call_result.content:
        if getattr(c, "type", "") == "image":
            fmt = (getattr(c, "mimeType", "") or "image/jpeg").split("/")[-1]
            return Image(data=base64.b64decode(c.data), format="jpeg" if fmt == "jpg" else fmt)
    return None


def _fill(js: str, values: dict) -> str:
    for k, v in values.items():
        js = js.replace(k, str(v))
    return js


# Watched history (2026-10-23). The bridge only lists the last 20 videos in the free-time prompt and she
# watches ~50 a day, and Bilibili keeps recommending the same series, so she rewatched the same ones (and
# after a timeout retried them at once). Every finished watch is recorded here; a repeat within
# bili.rewatchDays (config/extras.json, 0 = off) is refused unless she passes again=true.
WATCHED_FILE = "bili-watched.json"
WATCHED_KEEP = 500


def _rewatch_days() -> float:
    return float((store.extras_config().get("bili") or {}).get("rewatchDays", 14))


def watched_before(bvid: str, now: float | None = None) -> dict | None:
    days = _rewatch_days()
    if days <= 0:
        return None
    with store.LOCK:
        seen = store.load_json(store.state_path(WATCHED_FILE), {}).get(bvid)
    if not seen or (now or time.time()) - float(seen.get("at") or 0) > days * 86400:
        return None
    return seen


def record_watched(bvid: str, title: str | None, now: float | None = None) -> None:
    path = store.state_path(WATCHED_FILE)
    with store.LOCK:
        db = store.load_json(path, {})
        old = db.pop(bvid, {})  # re-insert so the dict stays oldest-first
        db[bvid] = {"title": str(title or old.get("title") or "")[:80], "at": now or time.time(), "n": int(old.get("n") or 0) + 1}
        for k in list(db)[:-WATCHED_KEEP]:
            del db[k]
        store.save_json(path, db)


def rewatch_refusal(bvid: str, seen: dict) -> str:
    when = time.strftime("%m-%d %H:%M", time.localtime(float(seen.get("at") or 0)))
    title = f"《{seen['title']}》" if seen.get("title") else ""
    return (f"这个视频{title}你 {when} 已经看过了，这次没再看一遍。换一个没看过的吧；"
            "有人托你重看、或者你真想再看一遍，就传 again=true。")


async def watch(video: str, again: bool = False) -> list:
    bvid = _bvid(video)
    seen = None if again else watched_before(bvid)
    if seen:
        raise ValueError(rewatch_refusal(bvid, seen))
    shots: list[float] = []
    image: Image | None = None
    async with streamablehttp_client(BROWSER_MCP) as (read, write, _), ClientSession(read, write) as browser:
        await browser.initialize()
        await browser.call_tool("browser_navigate", {"url": f"https://www.bilibili.com/video/{bvid}/"})
        info = _result(await browser.call_tool("browser_evaluate", {"function": PAGE_INFO_JS}))
        if not info or not info.get("cid"):
            raise RuntimeError("视频信息读不到（可能视频不存在或被删了）")
        sub = {"lan": None, "lines": []}
        if info.get("wbi"):
            js = SUBTITLE_JS.replace("__QUERY__", _wbi_query({"bvid": bvid, "cid": info["cid"]}, info["wbi"]))
            sub = _result(await browser.call_tool("browser_evaluate", {"function": js})) or sub
            if sub.get("cid") and sub["cid"] != info["cid"]:
                sub = {"lan": None, "lines": []}  # mismatched subtitle; better none than wrong
        length = info.get("videoDuration") or info.get("duration") or 0
        plan = plan_frames(length)
        dims = {"__COLS__": SHEET_COLS, "__CW__": CELL_W, "__CH__": CELL_H, "__N__": len(plan),
                "__PLAY_MS__": PLAY_MS_PER_FRAME, "__BUFFER_MS__": BUFFER_WAIT_MS}
        fill = lambda js, extra=None: _fill(js, {**dims, **(extra or {})})
        await browser.call_tool("browser_evaluate", {"function": fill(SHEET_INIT_JS)})
        all_drawn = True
        for i, t in enumerate(plan):
            seek = _result(await browser.call_tool("browser_evaluate", {"function": fill(SEEK_JS, {"__T__": t, "__I__": i})}))
            if not seek:
                break
            all_drawn = all_drawn and bool(seek.get("drawn"))
            shots.append(seek.get("t") or t)
        sheet = _result(await browser.call_tool("browser_evaluate", {"function": FINISH_JS}))
        if sheet and all_drawn:
            image = Image(data=base64.b64decode(sheet), format="jpeg")
        else:  # could not draw the frames (e.g. cross-origin video): one screenshot of the paused page instead
            image = _screenshot_image(await browser.call_tool("browser_take_screenshot", {"type": "jpeg"}))
    gap = (plan[1] - plan[0]) if len(plan) > 1 else FRAME_EVERY_SEC
    stat = info.get("stat") or {}
    subs = sub.get("lines") or []
    danmaku = [d for d in (info.get("danmaku") or []) if isinstance(d, list) and len(d) == 2]
    summary = {
        "bvid": bvid,
        "title": info.get("title"),
        "up": info.get("owner"),
        "partition": info.get("tname"),
        "duration": f"{(info.get('duration') or 0) // 60}分{(info.get('duration') or 0) % 60}秒",
        "stats": {k: stat.get(k) for k in ("view", "like", "coin", "favorite", "danmaku", "reply")},
        "desc": info.get("desc"),
        "hotComments": [r["text"] for r in sorted(info.get("replies") or [], key=lambda r: -(r.get("like") or 0))][:15],
        "topDanmaku": _top_danmaku([d for _, d in danmaku]),
        "subtitle": _condense(subs) if subs else "（这个视频没有字幕，只能靠画面、弹幕和评论了解）",
        "loggedIn": bool(info.get("isLogin")),
        "note": f"已经拖着进度条看了 {len(shots)} 个片段（大约每 {round(gap)} 秒一段）。下面那张图是这些片段拼成的缩略图，左上角的编号和时间对应下面的字幕和弹幕。视频已暂停，不会自动连播，看完就可以换下一个。",
    }
    timeline = "\n".join(f"{i + 1}. " + _around(t, subs, danmaku, before=gap / 2, after=gap / 2) for i, t in enumerate(shots))
    if shots:
        record_watched(bvid, info.get("title"))
    out: list = [json.dumps(summary, ensure_ascii=False, indent=1), timeline or "（没能拖动进度条）"]
    if image is not None:
        out.append(image)
    return out
