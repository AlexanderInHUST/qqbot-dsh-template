"""Check and fetch a Telegram post for qq-bridge to send into a whitelisted QQ conversation, with hard rate limits.

The sending itself is done by qq-bridge (qq_send_meme), so the chat sessions see what was sent."""

import base64
import time
import uuid

import telegram
from store import LOCK, bridge_config, extras_config, load_json, save_json, state_path

PATH = state_path("relay.json")


def _cfg() -> dict:
    return {
        # 频率按“波”算：一波里可以连着搬几张（batchWindowMinutes 内、最多 postsPerBatch 条），
        # 波与波之间至少隔 minIntervalMinutes，每个会话每天最多 perConversationPerDay 波，
        # 全局每天最多 globalPerDay 条。
        "perConversationPerDay": 2, "minIntervalMinutes": 240, "globalPerDay": 20,
        "postsPerBatch": 4, "batchWindowMinutes": 15,
        "quietHours": [0, 8], "maxImagesPerRelay": 3, "captionMaxChars": 60,
        "attribution": True, "blockedKeywords": [],
        # 只往这些会话搬图（key 列表）；空 = bridge 白名单里的都行
        "conversations": [],
        **extras_config().get("relay", {}),
    }


def _target(key: str) -> tuple[str, int]:
    """Validate a qq-bridge conversation key against the bridge's own allow/deny lists."""
    kind, _, num = key.strip().partition(":")
    if kind not in ("group", "private") or not num.isdigit():
        raise ValueError('key 的格式是 "group:群号" 或 "private:QQ号"，就是当前会话的 key')
    bc = bridge_config()
    allow = {str(x) for x in bc.get("allow", {}).get("groups" if kind == "group" else "private", [])}
    deny = {str(x) for x in bc.get("deny", {}).get("groups" if kind == "group" else "private", [])}
    if num not in allow or num in deny:
        raise ValueError("这个会话不在白名单里，不能发")
    return kind, int(num)


def _check_limits(cfg: dict, key: str, post: str, state: dict) -> float:
    """Raise if this relay is not allowed; return the batch id (start time) it belongs to."""
    hour = time.localtime().tm_hour
    start, end = cfg["quietHours"]  # [开始, 结束) 小时，跨零点也行；两者相等表示不设休息时间
    if start != end and ((start <= hour < end) if start < end else (hour >= start or hour < end)):
        raise ValueError("现在是休息时间，不搬图")
    now = time.time()
    day_ago = now - 86400
    recent = [r for r in state["sent"] if r["time"] > day_ago]
    mine = [r for r in recent if r["key"] == key]
    if any(r["post"] == post for r in state["sent"] if r["key"] == key):
        raise ValueError("这条之前在这个会话里发过了")
    if len(recent) >= cfg["globalPerDay"]:
        raise ValueError("今天搬的图已经够多了，明天再说")
    batches = sorted({r.get("batch", r["time"]) for r in mine})
    if batches:
        last = batches[-1]
        in_last = [r for r in mine if r.get("batch", r["time"]) == last]
        if now - last < cfg["batchWindowMinutes"] * 60:
            if len(in_last) >= cfg["postsPerBatch"]:
                raise ValueError("这一波已经搬了好几张了，先停一停")
            return last  # 同一波里接着搬
        if now - last < cfg["minIntervalMinutes"] * 60:
            raise ValueError(f"刚搬过一波了，隔 {cfg['minIntervalMinutes']} 分钟再说")
    if len(batches) >= cfg["perConversationPerDay"]:
        raise ValueError("今天在这里已经搬过好几波了，别刷屏")
    return now


def prepare(post: str, key: str, caption: str = "") -> dict:
    """qq-bridge 发图前调用（它的 qq_send_meme）：查白名单、红线、频率，下载图片交给 bridge 去发。
    通过就先占一个名额（防止并发绕过限频）；bridge 发失败了调 cancel 退掉。"""
    cfg = _cfg()
    key = key.strip()
    _target(key)
    if cfg["conversations"] and key not in cfg["conversations"]:
        raise ValueError("这个会话里不搬图")
    p = telegram.find_post(post)
    if not p["_photoUrls"]:
        raise ValueError("这条没有图片（视频和纯文字不搬）")
    text = p["text"] + " " + caption
    for word in cfg["blockedKeywords"]:
        if word and word in text:
            raise ValueError("这条内容碰到了红线关键词，不搬")
    caption = " ".join(caption.split())[: cfg["captionMaxChars"]]
    with LOCK:
        _check_limits(cfg, key, p["post"], load_json(PATH, {"sent": []}))
    images = []
    for url in p["_photoUrls"][: cfg["maxImagesPerRelay"]]:
        data, fmt = telegram.download_image(url)
        images.append({"data": base64.b64encode(data).decode(), "format": fmt})
    tail = caption
    if cfg["attribution"]:
        tail = (tail + " " if tail else "") + f"（t.me/{p['post'].split('/')[0]}）"
    rid = uuid.uuid4().hex
    with LOCK:  # 下载期间可能有别的请求占了名额，再查一次
        state = load_json(PATH, {"sent": []})
        batch = _check_limits(cfg, key, p["post"], state)
        state["sent"].append({"time": time.time(), "key": key, "post": p["post"], "batch": batch, "id": rid})
        state["sent"] = [x for x in state["sent"] if x["time"] > time.time() - 30 * 86400]
        save_json(PATH, state)
    return {"ok": True, "id": rid, "post": p["post"], "images": images, "text": tail}


def cancel(rid: str) -> bool:
    """bridge 没发出去：把 prepare 占的名额退掉。"""
    with LOCK:
        state = load_json(PATH, {"sent": []})
        kept = [x for x in state["sent"] if not (rid and x.get("id") == rid)]
        if len(kept) == len(state["sent"]):
            return False
        state["sent"] = kept
        save_json(PATH, state)
    return True
