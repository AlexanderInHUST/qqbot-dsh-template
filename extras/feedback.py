"""The owners' feedback about how the bot is built ("回得太慢了", "这个 bug 修一下", "换个模型试试").

It used to land in rules, so she would quote deployment talk back at people as if it were a
standing instruction. digest.py routes it here instead: a list for the developers to read
(GET /feedback), never shown to her.
"""

import time

from store import LOCK, load_json, save_json, secret_reason, state_path

PATH = state_path("feedback.json")
MAX_ITEMS = 300


def add(key: str, text: str, uid: str) -> dict:
    text = " ".join(str(text).split())[:300]
    if not text:
        raise ValueError("text 不能为空")
    reason = secret_reason(text)  # dev talk is where keys and tokens get pasted
    if reason:
        raise ValueError(reason)
    with LOCK:
        db = load_json(PATH, {"items": []})
        if any(i["text"] == text for i in db["items"][-50:]):
            return {"ok": True, "duplicate": True}
        db["items"].append({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "key": key, "from": uid, "text": text})
        del db["items"][:-MAX_ITEMS]
        save_json(PATH, db)
    return {"ok": True}


def items(limit: int = 100) -> list[dict]:
    with LOCK:
        return load_json(PATH, {"items": []})["items"][-limit:]
