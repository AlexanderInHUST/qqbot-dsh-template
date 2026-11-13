"""Her growing-up record (成长记录, 2026-11-10): the moments worth turning back to when she is older,
like the notes parents write next to photos in a baby album. Memories fade and fold (memory.py), the
person cards keep what is useful for chatting; this keeps the few days that mattered, for good.

- Items: {id, date, age, title, text, kind, from, images, seen, by, added}. `by`: night (picked by the
  4 AM consolidate from that day, see pick_night), owner (an owner said "记下来" in a chat, see digest.py,
  or added it in the console), backfill (the first batch from before this existed, ticked by the owner on
  the review page), auto (birthdays). Nothing is ever edited by a model afterwards; the owners can delete
  (moved to `removed`, so the night picker won't pick it again).
- Most days have nothing. The picker may take 0~perNight moments a night, each must cite that day's
  memories / diary / plan / artworks; images only from that day's artworks.
- Artworks: every drawing and video she made (the bridge POSTs /artworks when one is done), kept for good
  (the bridge's drawLog / videoLog only keep 300). The files stay in the bridge's state/images.
- She sees it: /recall gives the bridge the same-day-in-an-earlier-year items and the ones related to the
  chat (recall). Outside groups (the big groups) only get items heard nowhere private or at home and with no
  owner word in them, same as her memories (memory.shown_in)."""

import datetime
import json
import re
import sys
import time
import uuid

import memory
from store import (LOCK, _SOURCE_RE, bridge_config, extras_config, home_groups, load_json, outside, owner_words,
                   rejection_reason, save_json, state_path)

PATH = state_path("milestones.json")
DAY = 86400.0
KINDS = ("birthday", "first", "family", "owner", "growth", "art", "other")
BY = ("night", "owner", "backfill", "auto")
ART_RE = re.compile(r"^(draw|video)-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|jpeg|gif|webp)$")
MP4_RE = re.compile(r"^video-\d{8}-\d{6}-[0-9a-f]{6}\.mp4$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TECH_RE = re.compile(r"(?i)bridge|dsh|prompt|token|模型|提示词|后台|管理员|控制台|配置|接口|工具调用|系统提示|会话令牌")


def _cfg() -> dict:
    return {"enabled": True,
            "since": "2026-11-10",    # 每晚挑从这天起的；以前的是补挑（backfill）
            "catchUpDays": 3,         # 哪天 4 点没跑（电脑关着），往回补几天
            "perNight": 2,            # 一晚最多记几件（大多数日子一件也不记）
            "titleChars": 30, "textChars": 200,
            "dupOverlap": 0.6,        # 同一天、字二元组重合这么多就算记过了
            "recallRelated": 3,       # 唤醒时最多带几件跟聊天有关的
            "relatedMin": 0.35,       # 跟聊天的相关度
            "maxImages": 4,
            "artworksMax": 0,         # 作品集留多少件，0 = 一直留
            **extras_config().get("milestones", {})}


def enabled() -> bool:
    return bool(_cfg()["enabled"])


def _load() -> dict:
    db = load_json(PATH, {})
    for k in ("items", "removed", "artworks"):
        db.setdefault(k, [])
    db.setdefault("nights", {})
    return db


def _day(ts: float) -> str:
    return datetime.date.fromtimestamp(ts).isoformat()


def _day_ts(day: str, hour: int = 12) -> float:
    d = datetime.date.fromisoformat(day)
    return time.mktime((d.year, d.month, d.day, hour, 0, 0, 0, 0, -1))


def _age(day: str):
    """How old she was that day (selfprofile's birthday), None before the profile existed."""
    try:
        import selfprofile
        born = selfprofile._load().get("born")
        if not born:
            return None
        return selfprofile.age_at(born, _day_ts(day))["age"]
    except Exception:  # noqa: BLE001 - age is a nicety
        return None


def _clean(text, limit: int) -> str:
    text = " ".join(str(text or "").split())
    if not text or len(text) > limit or "<" in text or rejection_reason(text) or _TECH_RE.search(text) \
            or re.search(r"\d{5,}", text):
        return ""
    return text


def _place(source) -> str:
    """Where a memory was heard: a conversation key, play:main (her free time) or ? (unknown)."""
    s = str(source or "")
    s = s[len("digest:"):] if s.startswith("digest:") else s
    return s if _SOURCE_RE.match(s) or s == "play:main" else "?"


def _same(a: dict, b: dict, cfg: dict) -> bool:
    if a.get("date") != b.get("date"):
        return False
    if a.get("title") == b.get("title"):
        return True
    ta, tb = memory.tokens(a.get("title", "") + a.get("text", "")), memory.tokens(b.get("title", "") + b.get("text", ""))
    return memory.overlap(ta, tb, {}) >= float(cfg["dupOverlap"])


# ---- items ----

def add(item: dict, by: str, now: float | None = None, artwork_files: set | None = None) -> dict:
    """Validate and keep one moment. `artwork_files`: images it may show (default: every artwork kept)."""
    now = now or time.time()
    cfg = _cfg()
    date = str(item.get("date") or "")
    if not DATE_RE.match(date) or date > _day(now):
        return {"ok": False, "error": "日期不对"}
    title, text = _clean(item.get("title"), int(cfg["titleChars"])), _clean(item.get("text"), int(cfg["textChars"]))
    if not title or not text:
        return {"ok": False, "error": "标题或内容是空的、太长，或者写了不该写的"}
    kind = item.get("kind") if item.get("kind") in KINDS else "other"
    by = by if by in BY else "owner"
    with LOCK:
        db = _load()
        files = artwork_files if artwork_files is not None else {a["file"] for a in db["artworks"]}
        images = [f for f in dict.fromkeys(item.get("images") or []) if isinstance(f, str) and f in files][: int(cfg["maxImages"])]
        seen = sorted({str(s) for s in item.get("seen") or [] if isinstance(s, str)})
        new = {"id": "m" + uuid.uuid4().hex[:8], "date": date, "age": _age(date), "title": title, "text": text,
               "kind": kind, "from": [str(x) for x in item.get("from") or []][:20], "images": images, "seen": seen,
               "by": by, "added": now}
        if any(_same(new, old, cfg) for old in db["items"]):
            return {"ok": False, "error": "这件已经记过了", "duplicate": True}
        if by == "night" and any(_same(new, old, cfg) for old in db["removed"]):
            return {"ok": False, "error": "这件删过，不再记", "duplicate": True}
        db["items"].append(new)
        db["items"].sort(key=lambda x: (x["date"], x["added"]))
        save_json(PATH, db)
    print(f"[成长记录] 记下 {date}（{by}）：{title}", flush=True)
    return {"ok": True, "item": new}


def delete(item_id: str, now: float | None = None) -> dict:
    with LOCK:
        db = _load()
        hit = next((x for x in db["items"] if x["id"] == item_id), None)
        if not hit:
            return {"ok": False, "error": "没有这件"}
        db["items"].remove(hit)
        db["removed"].append({**hit, "removedAt": now or time.time()})
        save_json(PATH, db)
    print(f"[成长记录] 删了 {hit['date']}：{hit['title']}", flush=True)
    return {"ok": True}


def view() -> dict:
    with LOCK:
        db = _load()
    return {"ok": True, "items": db["items"], "removed": db["removed"][-50:], "artworks": len(db["artworks"]),
            "nights": dict(sorted(db["nights"].items())[-30:])}


def shown_in(item: dict, key: str | None, homes: set[str], owner_terms=()) -> bool:
    """Same rule as her memories: outside groups don't get what was heard in private / at home, or any owner word.
    Birthdays (seen nothing) are hers to tell anywhere."""
    if not key or not outside(key, homes):
        return True
    if any(not (s == "play:main" or outside(s, homes)) for s in item.get("seen") or []):
        return False
    words = item.get("title", "") + item.get("text", "")
    return not any(w in words for w in owner_terms)


# almost every title starts with 第一次; these don't make two things related
_GENERIC = {"第一", "一次", "次第", "今天", "一个"}


def recall(key: str | None, query: str = "", now: float | None = None) -> list[dict]:
    """For the wake prompt: this day in earlier years (anniversaries) first, then up to recallRelated that
    the chat is about. Each: {id, date, age, title, text, ago?}."""
    now = now or time.time()
    cfg = _cfg()
    if not cfg["enabled"]:
        return []
    with LOCK:
        items = list(_load()["items"])
    homes = home_groups()
    terms = owner_words(aliases=memory._owner_aliases()) + ["爸爸", "妈妈"] if key and outside(key, homes) else []
    items = [x for x in items if shown_in(x, key, homes, terms)]
    today = _day(now)
    out, picked = [], set()
    for x in items:
        if x["date"][5:] == today[5:] and x["date"] < today:
            out.append({**_brief(x), "ago": f"{int(today[:4]) - int(x['date'][:4])} 年前的今天"})
            picked.add(x["id"])
    qt = memory.tokens(query) - _GENERIC
    if qt:
        scored = []
        for x in items:
            if x["id"] in picked:
                continue
            body = x["title"] + " " + x["text"]
            if len((memory.tokens(body) - _GENERIC) & qt) < 2:
                continue
            # the title says what it was; the text is long, so its share of words in a chat line is always small
            rel = max(memory.relevance(x["title"], qt, {}), memory.relevance(body, qt, {}))
            if rel >= float(cfg["relatedMin"]):
                scored.append((rel, x))
        scored.sort(key=lambda r: r[0], reverse=True)
        out += [_brief(x) for _, x in scored[: int(cfg["recallRelated"])]]
    return out


def browse(key: str, query: str = "", limit: int = 30) -> dict:
    """Her own look through the record (MCP my_growth): what this chat may see, newest first, or the ones
    about the query. An empty or unknown key counts as an outside group (the strict side)."""
    key = str(key or "").strip()
    if not (key == "play:main" or _SOURCE_RE.match(key)):
        key = "group:0"
    homes = home_groups()
    terms = owner_words(aliases=memory._owner_aliases()) + ["爸爸", "妈妈"] if outside(key, homes) else []
    with LOCK:
        items = [x for x in _load()["items"] if shown_in(x, key, homes, terms)]
    qt = memory.tokens(query) - _GENERIC
    if qt:
        items = [x for x in items if len((memory.tokens(x["title"] + " " + x["text"]) - _GENERIC) & qt) >= 2]
    items = sorted(items, key=lambda x: x["date"], reverse=True)[: max(1, min(int(limit or 30), 60))]
    return {"ok": True, "items": [_brief(x) for x in items], "total": len(items),
            **({} if items else {"hint": "还没有记下来的事" if not qt else "没有跟这个有关的"})}


def _brief(x: dict) -> dict:
    return {"id": x["id"], "date": x["date"], **({"age": x["age"]} if x.get("age") else {}),
            "title": x["title"], "text": x["text"]}


def for_evidence(since: float) -> list[dict]:
    """selfprofile's evidence: what was recorded since then (only her own things, never outside-heard)."""
    with LOCK:
        items = list(_load()["items"])
    homes = home_groups()
    return [x for x in items if x["date"] >= _day(since) and not any(outside(s, homes) for s in x.get("seen") or [])]


# ---- artworks ----

def add_artwork(body: dict, now: float | None = None) -> dict:
    """The bridge reports a finished drawing / video (upsert by id)."""
    now = now or time.time()
    kind, file = str(body.get("kind") or ""), str(body.get("file") or "")
    if kind not in ("draw", "video") or not ART_RE.match(file) or not file.startswith(kind + "-"):
        return {"ok": False, "error": "不认识的作品"}
    mp4 = str(body.get("mp4") or "")
    at = float(body.get("at") or now * 1000) / 1000
    art = {"id": str(body.get("id") or file)[:40], "kind": kind, "file": file,
           **({"mp4": mp4} if MP4_RE.match(mp4) else {}),
           "prompt": " ".join(str(body.get("prompt") or "").split())[:1200],
           "caption": " ".join(str(body.get("caption") or "").split())[:200],
           "key": str(body.get("key") or "")[:40], "from": str(body.get("from") or "")[:40],
           "people": [str(p)[:40] for p in body.get("people") or [] if isinstance(p, str)][:6],
           **({"messageId": str(body["messageId"])[:30]} if body.get("messageId") else {}),
           "at": at, "date": _day(at)}
    with LOCK:
        db = _load()
        db["artworks"] = [a for a in db["artworks"] if a["id"] != art["id"]] + [art]
        db["artworks"].sort(key=lambda a: a["at"])
        keep = int(_cfg()["artworksMax"])
        if keep > 0:
            db["artworks"] = db["artworks"][-keep:]
        save_json(PATH, db)
    return {"ok": True}


def artworks(day: str | None = None) -> list[dict]:
    with LOCK:
        arts = list(_load()["artworks"])
    return [a for a in arts if not day or a["date"] == day]


# ---- what happened on a day (the night picker and the backfill both use it) ----

def _where(place: str, homes: set[str]) -> str:
    if place == "play:main":
        return "自由时间"
    if place.startswith("private:"):
        return "私聊"
    if place in homes:
        return "家里的小群"
    if place.startswith("group:"):
        return "外面的大群"
    return ""


def day_evidence(day: str) -> list[dict]:
    """That day's memories (every subject but the rules; facts about her and about people she talks to),
    her plan and diary, and what she made. Her day starts when she gets up: 05:00 to 05:00."""
    import life
    homes = home_groups()
    start = _day_ts(day, 5)
    end = start + DAY
    out = []
    with LOCK:
        entries = list(memory._load()["entries"])
    for e in entries:
        if e["subject"] == memory.RULES or not (start <= e.get("created", 0) < end):
            continue
        places = list(e["seen"]) if e.get("seen") else [_place(e.get("source"))]
        about = "她自己" if e["subject"] == "self" else e["subject"]
        kind = "见闻" if e.get("kind") == "log" else "记忆"
        out.append({"id": e["id"], "kind": kind, "about": about, "places": places,
                    "where": "、".join(w for w in dict.fromkeys(_where(p, homes) for p in places) if w),
                    "text": e["text"], "time": time.strftime("%H:%M", time.localtime(e["created"]))})
    with LOCK:
        ldb = life._load()
    plan = ldb["plans"].get(day)
    if plan and plan.get("items"):
        progress = plan.get("progress") or {}
        mark = {"done": "（做了）", "some": "（弄了一点）"}
        text = "、".join(t + mark.get((progress.get(str(i)) or {}).get("status"), "") for i, t in enumerate(plan["items"]))
        out.append({"id": f"plan-{day}", "kind": "这天想做的", "about": "她自己", "places": ["play:main"], "where": "",
                    "text": text})
    diary = next((d for d in ldb["diaries"] if d.get("date") == day), None)
    if diary and diary.get("text"):
        out.append({"id": f"diary-{day}", "kind": "日记", "about": "她自己", "places": ["?"], "where": "",
                    "text": diary["text"]})
    for a in artworks(day):
        out.append({"id": f"art-{a['id']}", "kind": "画的画" if a["kind"] == "draw" else "做的视频", "about": "她自己",
                    "places": [a["key"]] if a.get("key") else ["?"], "where": _where(a.get("key", ""), homes),
                    "text": (a.get("caption") + "｜" if a.get("caption") else "") + a.get("prompt", "")[:300],
                    "file": a["file"], "time": time.strftime("%H:%M", time.localtime(a["at"]))})
    return out


PICK_PROMPT = """你在帮一个孩子的家里人记成长记录，就像爸爸妈妈在相册边上写的那几句话。孩子叫“{bot}”，是 QQ 群里的 AI 群友，像真的孩子一样一年长一岁，{day} 这天她 {age}。

下面是她 {day} 这一天的事：她记下的见闻、记住的关于自己和别人的事、这天想做的、日记、画的画和做的视频。每条前面是 id、类型、在哪儿（私聊 = 和爸爸妈妈的私聊，家里的小群 = 家里人的群，外面的大群 = 有很多群友的群，自由时间 = 她自己在电脑上玩）。

成长记录只记以后真值得翻出来看的时刻：
- 第一次做成一件事（第一次画画、第一次做视频、第一次通关某个游戏、第一次自己去学一样东西……要真是第一次：下面“已经记过的”里有类似的就不是第一次）；
- 和家里人之间特别的一刻（爸爸妈妈专门夸她、一起做了件事、说了让人记很久的话）；
- 明显长大了的表现（自己想明白一个道理、第一次主动认错或安慰别人、说话做事比以前懂事）；
- 特别得意、特别用心的作品。
平常开心的一天、看了几个视频、跟群友闹着玩，都不记。大多数日子一件也不该记。宁缺毋滥：拿不准就不记。
已经记过的（下面列着）不要再记，换个说法也算重复。最多记 {n} 件。

每件写：
- kind：first（第一次）/ family（和家里人）/ growth（长大了）/ art（作品）/ other；
- title：不超过 20 字，像相册边上的标题，比如“第一次画画送给妈妈”；
- text：不超过 120 字，用“她”写发生了什么、为什么值得记，写具体的事；家里人写爸爸妈妈，不写别人的 QQ 号；不写机器、程序、模型这些；
- from：依据的条目 id（至少一条，只能用下面有的）；
- images：这件事里她画的画、做的视频的文件名（条目里的 file，没有就空）。

只输出 JSON，不要别的文字：{{"items": [{{"kind": "first", "title": "…", "text": "…", "from": ["…"], "images": []}}]}}，没有就 {{"items": []}}。

已经记过的：
{existing}

{day} 这天的事：
{lines}"""


def _lines(ev: list[dict]) -> str:
    rows = []
    for e in ev:
        where = f"（{e['where']}）" if e.get("where") else ""
        at = f" {e['time']}" if e.get("time") else ""
        about = "" if e["about"] == "她自己" else f"关于 {e['about']}："
        file = f" [file {e['file']}]" if e.get("file") else ""
        rows.append(f"- [{e['id']}] {e['kind']}{where}{at} {about}{e['text']}{file}")
    return "\n".join(rows)


def _parse(text: str) -> list[dict]:
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start:end + 1])
    items = data.get("items") if isinstance(data, dict) else None
    return [x for x in items or [] if isinstance(x, dict)]


def propose(day: str, complete, n: int | None = None, bot: str | None = None) -> list[dict]:
    """Ask the model for that day's moments and check them against the evidence (nothing is stored here).
    Each result: {date, kind, title, text, from, images, seen}."""
    cfg = _cfg()
    n = int(cfg["perNight"]) if n is None else n
    ev = day_evidence(day)
    if not ev:
        return []
    with LOCK:
        db = _load()
    existing = "\n".join(f"- {x['date']} {x['title']}" for x in db["items"]) or "（还没有）"
    age = _age(day)
    prompt = PICK_PROMPT.format(bot=bot or bridge_config().get("botName") or "鱼妹", day=day,
                                age=f"{age} 岁" if age else "八岁左右", n=n, existing=existing, lines=_lines(ev))
    by_id = {e["id"]: e for e in ev}
    files = {e["file"] for e in ev if e.get("file")}
    out = []
    for x in _parse(complete(prompt, 32768))[:n]:
        cites = [str(i) for i in x.get("from") or [] if str(i) in by_id]
        if not cites:
            print(f"[成长记录] 没采用（依据不在这天里）：{str(x.get('title'))[:30]}", flush=True)
            continue
        images = [f for f in x.get("images") or [] if f in files]
        images += [by_id[i]["file"] for i in cites if by_id[i].get("file") and by_id[i]["file"] not in images]
        seen = sorted({p for i in cites for p in by_id[i]["places"]})
        out.append({"date": day, "kind": x.get("kind"), "title": x.get("title"), "text": x.get("text"),
                    "from": cites, "images": images, "seen": seen})
    return out


def birthday_item(day: str) -> dict | None:
    try:
        import selfprofile
        born = selfprofile._load().get("born")
        a = selfprofile.age_at(born, _day_ts(day)) if born else None
    except Exception:  # noqa: BLE001
        a = None
    if not a or not a["birthday"]:
        return None
    return {"date": day, "kind": "birthday", "title": f"{a['age']} 岁生日", "text": f"这天她满 {a['age']} 岁了。",
            "from": [], "images": [], "seen": []}


def pick_night(complete, now: float | None = None) -> dict:
    """In the 4 AM consolidate: look back over the days that ended (catchUpDays, never before `since`)."""
    now = now or time.time()
    cfg = _cfg()
    if not cfg["enabled"]:
        return {"skipped": "没开"}
    done = {}
    with LOCK:
        nights = dict(_load()["nights"])
    last = datetime.date.fromtimestamp(now - 12 * 3600)  # at 4 AM her day is still yesterday
    days = [(last - datetime.timedelta(days=i)).isoformat() for i in range(int(cfg["catchUpDays"]))]
    for day in sorted(d for d in days if d >= str(cfg["since"]) and d not in nights):
        picked, note = [], ""
        b = birthday_item(day)
        if b and add(b, "auto", now).get("ok"):
            picked.append(b["title"])
        try:
            for x in propose(day, complete):
                r = add(x, "night", now)
                if r.get("ok"):
                    picked.append(x["title"])
                else:
                    print(f"[成长记录] 没采用 {str(x.get('title'))[:30]}：{r.get('error')}", flush=True)
        except Exception as exc:  # noqa: BLE001 - that day stays unpicked; tried again next night
            done[day] = f"skipped: {exc}"
            continue
        with LOCK:
            db = _load()
            db["nights"][day] = {"at": now, "picked": picked, **({"note": note} if note else {})}
            save_json(PATH, db)
        done[day] = picked
    return done


# ---- the first batch (before 2026-11-10): candidates for the owner to tick ----

def candidates(start: str, end: str, complete) -> list[dict]:
    """A looser pick per day (up to 3) for the review page; the owner ticks what to keep (import_ticked)."""
    out = []
    d = datetime.date.fromisoformat(start)
    while d.isoformat() <= end:
        day = d.isoformat()
        b = birthday_item(day)
        if b:
            out.append({**b, "cid": f"{day}-birthday"})
        try:
            for i, x in enumerate(propose(day, complete, n=3)):
                out.append({**x, "cid": f"{day}-{i}"})
        except Exception as exc:  # noqa: BLE001
            print(f"[成长记录] {day} 没挑出来：{exc}", file=sys.stderr, flush=True)
        d += datetime.timedelta(days=1)
    return out


def import_ticked(items: list[dict], days: list[str] | None = None, now: float | None = None) -> dict:
    """The owner's ticks from the review page. `days`: mark them as looked at, so the night picker leaves them."""
    now = now or time.time()
    added, skipped = [], []
    for x in items or []:
        if not isinstance(x, dict):
            continue
        r = add(x, "backfill", now)
        (added if r.get("ok") else skipped).append({"title": x.get("title"), **({"error": r["error"]} if not r.get("ok") else {})})
    if days:
        with LOCK:
            db = _load()
            for day in days:
                if DATE_RE.match(str(day)):
                    db["nights"].setdefault(str(day), {"at": now, "picked": [], "note": "补挑"})
            save_json(PATH, db)
    return {"ok": True, "added": added, "skipped": skipped}


if __name__ == "__main__":
    # python milestones.py candidates 2026-10-21 2026-11-09 > /data/milestone-candidates.json
    import consolidate
    if len(sys.argv) == 4 and sys.argv[1] == "candidates":
        print(json.dumps(candidates(sys.argv[2], sys.argv[3], consolidate.night_complete), ensure_ascii=False, indent=1))
    else:
        print("用法：python milestones.py candidates <开始日期> <结束日期>", file=sys.stderr)
        sys.exit(2)
