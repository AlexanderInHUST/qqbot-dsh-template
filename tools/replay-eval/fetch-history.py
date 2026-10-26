# 在 extras 容器里跑：把白名单群最近几天的 QQ 聊天记录拉成 JSON，给门控模拟（gate-sim.mjs）用。
# 输出里有聊天内容，别放进仓库。
#   sg docker -c 'docker compose exec -T extras venv/bin/python - 3' < tools/replay-eval/fetch-history.py > /tmp/replay-eval/history.json
import json
import sys
import time

import digest

days = float(sys.argv[1]) if len(sys.argv) > 1 else 3
since = time.time() - days * 86400
bot = digest._bot_id()


def fetch(key):
    # SnowLuma 不认 message_seq，按最老一条的 message_id 往前翻
    kind, _, num = key.partition(":")
    action, field = ("get_group_msg_history", "group_id") if kind == "group" else ("get_friend_msg_history", "user_id")
    seen, out, anchor = set(), [], None
    for _ in range(60):
        body = {field: int(num), "count": 100}
        if anchor is not None:
            body["message_id"] = anchor
        batch = digest._onebot(action, body).get("messages") or []
        fresh = [m for m in batch if m.get("message_id") not in seen]
        if not fresh:
            break
        for m in fresh:
            seen.add(m.get("message_id"))
        out += fresh
        oldest = min(fresh, key=lambda m: (m.get("time", 0), m.get("message_seq", 0)))
        if oldest.get("time", 0) <= since:
            break
        anchor = oldest.get("message_id")
    out.sort(key=lambda m: (m.get("time", 0), m.get("message_seq", 0)))
    return out


out = {}
for key in digest.conversations():
    msgs = fetch(key)
    by_id = {m.get("message_id"): m for m in msgs}
    rows = []
    for m in msgs:
        if m.get("time", 0) < since:
            continue
        segs = m.get("message") or []
        uid = str(m.get("user_id") or (m.get("sender") or {}).get("user_id") or "")
        reply_ids = [(s.get("data") or {}).get("id") for s in segs if s.get("type") == "reply"]
        quote_self = False
        for rid in reply_ids:
            q = by_id.get(rid) or (by_id.get(int(rid)) if str(rid or "").lstrip("-").isdigit() else None)
            if q and str(q.get("user_id")) == bot:
                quote_self = True
        ats = [str((s.get("data") or {}).get("qq")) for s in segs if s.get("type") == "at"]
        rows.append({
            "time": m.get("time"),
            "userId": uid,
            "isSelf": uid == bot,
            "sender": (m.get("sender") or {}).get("card") or (m.get("sender") or {}).get("nickname") or uid,
            "text": digest.render(m),
            "plain": "".join((s.get("data") or {}).get("text", "") for s in segs if s.get("type") == "text").strip(),
            "atSelf": bot in ats,
            "atOther": any(a != bot for a in ats),
            "quoteSelf": quote_self,
            "hasReply": bool(reply_ids),
        })
    out[key] = rows
json.dump({"bot": bot, "since": since, "conversations": out}, sys.stdout, ensure_ascii=False)
