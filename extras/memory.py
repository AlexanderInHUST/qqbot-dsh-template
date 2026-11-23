"""Long-term memory shared by every QQ conversation.

Subjects: "self" (the bot herself), "qq:<number>" (a person), "group:<number>" (a group),
and "rules": standing instructions from the owner (ownerQQ). Rules are written only by
digest.py, which checks the real QQ sender of each message; the model cannot add, change
or delete them, they are never evicted or consolidated, and every wake gets all of them.
qq-bridge's own qq_memory_* stays per-conversation and short-lived; this store is what
survives /reset, new sessions, and moving between private chat and groups.

Which memories a wake gets, and which ones fade:
- relevance: how much of a memory's words (Chinese character bigrams / English words, weighted
  by how rare they are across all memories) show up in the current chat (the `query`);
- strength: exponential decay since the memory was written or last came up in a chat, with a
  half-life per subject (self 7 days, people/groups 30 days by default). Each time a memory is
  relevant to a chat it counts as a "hit": the clock restarts and its half-life grows
  (spaced repetition), so things that keep coming up stay, one-off details fade.
- recall ranks by relevance first, strength second; just being shown does not refresh anything.
- "见闻" (kind="log", subject self): what she saw while playing (play:main, or any note with an
  `interest`). They have their own cap (maxLogs) and only evict each other, so a busy afternoon of
  videos never pushes out her settings or what she knows about people. Their half-life follows how
  much she liked it (interest 1 一般 / 2 有意思 / 3 超喜欢 → logHalfLifeDays), hits still extend it,
  and they are never folded into summaries: boring ones just fade away. The newest recallRecentLogs
  of them always come along, chat or not, so "what did you do today" has today's things to go on.
- "文件" (kind="file", 2026-11-16): a file in her workspace (the bridge's files/<chat>/, see workspace.py) and
  what she knows about it. The memory is what keeps the file: when it fades away or gets pushed out, the
  4 AM cleanup deletes the file too. Shown only in the chat the file belongs to (fileKey); it fades like her
  own things (fileHalfLifeDays, owners' chats too), and talking about it, reading or sending it is a hit.
  Never folded into summaries, never handed to digest / people / life / selfprofile / milestones.
- consolidate.py (nightly) folds faded memories into a few summary entries (which decay 4x
  slower) and deletes what has faded almost completely.

Keep what will be needed (2026-11-24, 主人："memory 是需要预测之后可能会用到的东西，才留下了的"):
- 群友的事是他们人物卡的收件箱（friendInbox）：唤醒时不给原文，只给卡；people.py 改过卡、过了 inboxDays 就挪进
  存档。主人的事照旧给。
- 见闻的半衰期夜里按“以后还会不会用到”定（themes.py 填 keep 0/1/2，代替她自评的 interest）；刚记的 logProtectHours
  内挤不掉（等夜里看过再说），maxLogs 放大，让价值而不是条数决定留谁。反复出现的见闻夜里并成“主题”（kind=theme，
  带着每次出现的日期 days），比单条见闻淡得慢。
- 存档（memory-archive.json）：淡掉、被挤掉、折成印象、她自己忘掉（forgot）、群友的事进了卡以后，原文都挪到这里，
  唤醒时不给；成长记录、长大、外面的人物卡（figures.py）夜里回看时还读得到。
"""

import difflib
import math
import re
import time
import uuid

from store import (LOCK, extras_config, home_groups, load_json, outside, owner_subjects, owner_words, rejection_reason,
                   save_json, secret_reason, source_key, state_path)

PATH = state_path("memory.json")
ARCHIVE_PATH = state_path("memory-archive.json")
RULES = "rules"
SUBJECT_RE = re.compile(r"^(self|qq:\d{5,12}|group:\d{5,12})$")
DAY = 86400


def _cfg() -> dict:
    return {
        "maxPerSubject": 40, "maxSelf": 80, "recallPerSubject": 15, "maxChars": 0,  # maxChars 为 0 表示不限字数
        "maxRules": 60,
        "maxLogs": 30, "recallLogs": 8,      # 见闻：单独的上限，每次唤醒最多带几条
        "recallRecentLogs": 4,               # 其中至少几条是最新记的（不管聊没聊到）
        "maxLogChars": 0,                    # 见闻一条最多几个字（0 不限）：太长她就在抄流水账
        "logHalfLifeDays": {"1": 2, "2": 5, "3": 14},  # 见闻按兴趣：一般 / 有意思 / 超喜欢
        "halfLifeDays": {"self": 7, "default": 30, "owner": 180},  # owner：阿明、阿红的事淡得很慢，也从不被忘掉
        "maxPerOwner": 100,
        "summaryHalfLifeFactor": 4,  # 概括比原始记忆淡得慢
        "hitBoost": 0.5,             # 每次在聊天里被提到，半衰期 ×(1 + hitBoost×次数)，最多算 6 次
        "hitThreshold": 0.15,        # 记忆里（按稀有度加权）这么多比例的词在聊天里出现，才算“聊到了”
        # 同一件事的见闻只留一条（同一篇文章她看了好几遍、每遍都记）：两条重合到这个比例、且共有 logDupMinShared
        # 个以上的词就算同一件事，不新加。0 关掉（只剩逐字很像才合并的老规矩）
        "logDupOverlap": 0.25, "logDupMinShared": 8,
        # 讲过的见闻：她在哪个会话把它讲出来了（bridge 发 /memory/told），之后不再拿它当话头，
        # 只有聊天里又说到它才带上（标“讲过了”）。enabled:false 回到旧行为
        "logTold": {},
        "fileHalfLifeDays": 7, "maxFiles": 30, "recallFiles": 3,  # 文件：淡得和她自己的事一样快；每个聊天最多记几个
        "logProtectHours": 36,       # 刚记的见闻这么久内不被挤掉：等 4 点那次看过“以后用不用得到”再说
        "keepHalfLifeDays": {"0": 1, "1": 4, "2": 14},  # 夜里定的 keep：0 鸡毛蒜皮 / 1 可能聊到 / 2 多半还会用到
        "themeHalfLifeDays": 21, "themeDayBoost": 0.5, "maxThemes": 80,  # 主题：每多出现一天半衰期多 0.5 倍（最多 6 倍）
        "friendInbox": True,         # 群友的事只进人物卡，唤醒时不给原文
        "inboxDays": 4, "inboxMaxDays": 14,  # 进了卡、过了 inboxDays 挪进存档；一直没进卡的 inboxMaxDays 后也挪
        "recallThemes": 3,           # 每次唤醒最多带几条主题（按跟聊天的相关、再按强度）
        "archiveMax": 50000,
        **extras_config().get("memory", {}),
        "_owners": owner_subjects(),
    }


def _told_cfg(cfg: dict) -> dict:
    c = cfg.get("logTold") or {}
    return {"enabled": c.get("enabled", True) is not False,
            "minOverlap": float(c.get("minOverlap", 0.25)),  # 她说的话和这条见闻重合多少
            "minRare": int(c.get("minRare", 4))}              # 至少共有几个少见的词（人名、地名、事情本身）


_RUN_RE = re.compile(r"[a-z0-9一-鿿]+")
_UNIT_RE = re.compile(r"[a-z0-9]+|[一-鿿]")


def tokens(text: str) -> set[str]:
    """Bigrams over units (one Chinese character or one English word / number), so "B站" and
    "看B站" share "b站"; plus English words of 2+ letters on their own. No word segmenter needed."""
    out = set()
    for run in _RUN_RE.findall(str(text).lower()):
        units = _UNIT_RE.findall(run)
        out.update(u for u in units if u.isascii() and len(u) > 1)
        if len(units) == 1 and not units[0].isascii():
            out.add(units[0])
        out.update(units[i] + units[i + 1] for i in range(len(units) - 1))
    return out


def _trigrams(text: str) -> set[str]:
    """Three units in a row (same units as tokens()): a shared trigram means the two texts share a
    phrase, not just two words that each happen to be somewhere in both."""
    out = set()
    for run in _RUN_RE.findall(str(text).lower()):
        units = _UNIT_RE.findall(run)
        out.update(units[i] + units[i + 1] + units[i + 2] for i in range(len(units) - 2))
    return out


def _rare_shared(text: str, shared: set[str], query_tri: set[str], idf: dict[str, float],
                 rare_idf: float, run_idf: float) -> tuple[int, int]:
    """Rare words the memory and the chat share, as (strong, loose). Strong: English words / numbers
    in at most 2 memories, and Chinese bigrams in at most 4 memories that sit inside a phrase both
    texts have (a shared trigram). Loose: other Chinese bigrams in at most 2 memories. With the pool
    this small any bigram looks rare: 2026-10-23 "吃饭" and "在吃" from "在吃辣面…记得吃饭" made a
    300-char note about 封门村 "come up" in a chat about 吉伊卡哇, so yesterday's long notes kept getting
    refreshed and beat everything she saw today. Loose words still help ranking ("你的柯基呢"), but
    only strong ones make a memory count as having come up again."""
    in_phrase = set()
    for run in _RUN_RE.findall(str(text).lower()):
        u = _UNIT_RE.findall(run)
        for i in range(len(u) - 2):
            if u[i] + u[i + 1] + u[i + 2] in query_tri:
                in_phrase.update((u[i] + u[i + 1], u[i + 1] + u[i + 2]))
    strong = loose = 0
    for t in shared:
        w = idf.get(t, 99)
        if (t.isascii() and w >= rare_idf) or (not t.isascii() and t in in_phrase and w >= run_idf):
            strong += 1
        elif w >= rare_idf:
            loose += 1
    return strong, loose


def _idf(entries: list[dict]) -> dict[str, float]:
    df: dict[str, int] = {}
    for e in entries:
        for t in tokens(e["text"]):
            df[t] = df.get(t, 0) + 1
    n = len(entries) + 1
    return {t: math.log(n / c) + 0.1 for t, c in df.items()}


def relevance(text: str, query_tokens: set[str], idf: dict[str, float]) -> float:
    """Share of the memory's (idf-weighted) words that appear in the query, 0..1."""
    toks = tokens(text)
    if not toks or not query_tokens:
        return 0.0
    total = sum(idf.get(t, 1.0) for t in toks)
    return sum(idf.get(t, 1.0) for t in toks & query_tokens) / total if total else 0.0


def overlap(a: set[str], b: set[str], idf: dict[str, float]) -> float:
    """How much of the shorter text (idf-weighted) the other one covers, 0..1: "same story" even when
    one is a short retelling of the other."""
    w = lambda s: sum(idf.get(t, 1.0) for t in s)  # noqa: E731
    low = min(w(a), w(b))
    return w(a & b) / low if low else 0.0


def _rare_cut(pool_size: int) -> float:
    """idf of a word that is in at most 4 memories."""
    return math.log((pool_size + 1) / 4) + 0.1


def strength(e: dict, cfg: dict | None = None, now: float | None = None) -> float:
    """1.0 right after it was written / came up, halves every half-life. Rules never fade."""
    if e["subject"] == RULES:
        return 1.0
    cfg = cfg or _cfg()
    now = now or time.time()
    hl = cfg["halfLifeDays"]
    days = float(hl.get(e["subject"].split(":")[0], hl.get("default", 30)))
    if e["subject"] in cfg.get("_owners", ()):
        days = max(days, float(hl.get("owner", 180)))
    if _is_file(e):
        days = float(cfg["fileHalfLifeDays"])
    elif e.get("kind") == "log" and e.get("keep") is not None:
        kh = cfg["keepHalfLifeDays"]
        days = float(kh.get(str(e["keep"]), kh.get("1", 4)))
    elif e.get("kind") == "log":
        lh = cfg["logHalfLifeDays"]
        days = float(lh.get(str(_interest(e.get("interest"))), lh.get("2", 5)))
    elif e.get("kind") == "theme":
        days = float(cfg["themeHalfLifeDays"]) * min(6.0, 1 + float(cfg["themeDayBoost"]) * max(0, len(e.get("days") or []) - 1))
    elif e.get("kind") == "summary":
        days *= float(cfg["summaryHalfLifeFactor"])
    days *= 1 + float(cfg["hitBoost"]) * min(int(e.get("hits", 0)), 6)
    age = max(0.0, now - max(e["updated"], e.get("lastHit", 0))) / DAY
    return 0.5 ** (age / max(days, 0.1))


def _interest(value) -> int:
    try:
        return min(3, max(1, int(value)))
    except (TypeError, ValueError):
        return 2


def _owner_aliases() -> list[str]:
    """The owners' names from their cards (阿明、阿红…)."""
    try:
        import people
        db = people.all_people()
        return [a for s in owner_subjects() for a in (db.get(s) or {}).get("aliases") or []]
    except Exception:  # noqa: BLE001 - names are a nicety, titles and QQ numbers are enough
        return []


def _is_log(e: dict) -> bool:
    return e.get("kind") == "log"


def _is_file(e: dict) -> bool:
    return e.get("kind") == "file"


def _is_theme(e: dict) -> bool:
    return e.get("kind") == "theme"


def is_friend(subject: str, cfg: dict | None = None) -> bool:
    """A person who isn't an owner: their facts are an inbox for their card (friendInbox)."""
    cfg = cfg or _cfg()
    return str(subject).startswith("qq:") and subject not in cfg["_owners"]


def _inbox(e: dict, cfg: dict) -> bool:
    if "_inboxOn" not in cfg:
        cfg["_inboxOn"] = inbox_on(cfg)
    return cfg["_inboxOn"] and is_friend(e["subject"], cfg) and not _is_file(e)


def inbox_on(cfg: dict | None = None) -> bool:
    """Friends' facts only feed their cards: needs the cards (people.enabled), otherwise they stay memories."""
    cfg = cfg or _cfg()
    if not cfg.get("friendInbox", True):
        return False
    import people
    return people.enabled()


# ---- 存档：不再给她看、但夜里回看还读得到的原文 ----

def _load_archive() -> dict:
    return load_json(ARCHIVE_PATH, {"entries": []})


def _archive_put(entries: list[dict], reason: str, cfg: dict | None = None, **extra) -> None:
    """Move entries into memory-archive.json (call with LOCK held). Files and rules never go there."""
    rows = [e for e in entries if not _is_file(e) and e["subject"] != RULES]
    if not rows:
        return
    cfg = cfg or _cfg()
    now = time.time()
    db = _load_archive()
    have = {e["id"] for e in db["entries"]}
    for e in rows:
        if e["id"] in have:
            continue
        db["entries"].append({**e, "archivedAt": now, "archiveReason": reason, **extra})
    limit = int(cfg.get("archiveMax") or 0)
    if limit and len(db["entries"]) > limit:
        db["entries"] = db["entries"][-limit:]
    save_json(ARCHIVE_PATH, db)


def archive(ids, reason: str, **extra) -> list[dict]:
    """Move these memories out of memory.json into the archive. Returns what moved."""
    want = set(ids)
    cfg = _cfg()
    with LOCK:
        db = _load()
        gone = [e for e in db["entries"] if e["id"] in want and e["subject"] != RULES and not _is_file(e)]
        if gone:
            _archive_put(gone, reason, cfg, **extra)
            db["entries"] = [e for e in db["entries"] if e not in gone]
            save_json(PATH, db)
    return gone


def archived(subjects=None, since: float = 0, until: float | None = None, with_forgotten: bool = False) -> list[dict]:
    """Archived memories created in [since, until) (all subjects when None). What she chose to forget
    (memory_forget: wrong or unwanted) is left out unless with_forgotten."""
    wanted = set(subjects) if subjects is not None else None
    with LOCK:
        rows = list(_load_archive()["entries"])
    return [dict(e) for e in rows if (wanted is None or e["subject"] in wanted)
            and (with_forgotten or e.get("archiveReason") != "forgot")
            and float(e.get("created", 0)) >= since and (until is None or float(e.get("created", 0)) < until)]


def add_archived(entries: list[dict], reason: str) -> int:
    """Put old memories straight into the archive (backfill from old session records). Skips ids and
    texts already there or in memory.json. Returns how many went in."""
    with LOCK:
        live = _load()["entries"]
        arc = _load_archive()["entries"]
        seen_ids = {e["id"] for e in live} | {e["id"] for e in arc}
        seen_texts = {(e["subject"], e["text"]) for e in live} | {(e["subject"], e["text"]) for e in arc}
        fresh = []
        for e in entries:  # 同一批里重复的也只放一条（会话记录里同一句可能出现好几回）
            if e["id"] not in seen_ids and (e["subject"], e["text"]) not in seen_texts:
                fresh.append(e)
                seen_ids.add(e["id"])
                seen_texts.add((e["subject"], e["text"]))
        if fresh:
            _archive_put(fresh, reason)
    return len(fresh)


def _load() -> dict:
    return load_json(PATH, {"entries": []})


def _check_subject(subject: str, trusted: bool = False) -> str:
    subject = subject.strip()
    if subject == RULES:
        if trusted:
            return subject
        raise ValueError("主人的叮嘱只能由主人在聊天里亲口交代，会自动整理，不能自己写")
    if not SUBJECT_RE.match(subject):
        raise ValueError('subject 只能是 "self"、"qq:QQ号" 或 "group:群号"')
    return subject


def _reason(subject: str, text: str) -> str | None:
    # The owner's rules are instructions by nature; only keep secrets out of them.
    return secret_reason(text) if subject == RULES else rejection_reason(text)


def check_scope(scope, groups=None) -> list[str]:
    """A rule's scope: [] = everywhere, otherwise a list of "private" / "group:N".
    `groups` (whitelisted group numbers) limits which groups are allowed when given."""
    if scope in (None, "", "global", []):
        return []
    items = [scope] if isinstance(scope, str) else scope
    if not isinstance(items, list):
        raise ValueError("scope 只能是 global、private、group:群号 或它们的列表")
    out = []
    for s in items:
        s = str(s).strip()
        if s == "global":
            return []
        if re.match(r"^private:\d+$", s):  # the digest prompt says "this conversation" = its key, also in private chats
            s = "private"
        if s != "private" and not re.match(r"^group:\d{5,12}$", s):
            raise ValueError(f"scope {s} 不对：只能是 global、private 或 group:群号")
        if s.startswith("group:") and groups is not None and s[6:] not in groups:
            raise ValueError(f"scope {s} 不是白名单里的群")
        if s not in out:
            out.append(s)
    return out


def in_scope(e: dict, key: str | None) -> bool:
    """Does a rule apply in conversation `key`? No key (old callers / the tool): every rule."""
    scope = e.get("scope") or []
    if not scope or not key:
        return True
    return ("private" in scope and key.startswith("private:")) or key in scope


def heard_in(e: dict) -> list[str]:
    """Where a memory was heard: an impression (summary) keeps the places of what it was folded from."""
    return list(e["seen"]) if e.get("seen") else [source_key(e.get("source"))]


def shown_in(e: dict, key: str | None, homes: set[str], owner_terms=()) -> bool:
    """May this memory come up in conversation `key`? Outside groups (the big groups…) only get what
    was heard in outside groups: not the owners' private chats, not the home group. Her own things are
    hers to tell, except where they involve an owner (主人/爸爸/妈妈/阿明…); what she saw in her free time
    (见闻 from play:main) goes everywhere. The owner's rules have their own scope (in_scope)."""
    if not key or not outside(key, homes) or e["subject"] == RULES:
        return True
    if e["subject"] == "self":
        if any(w in e["text"] for w in owner_terms):
            return False
        # 印象是几条折起来的，原话里的“爸爸”可能折没了：折进去的有私聊、家里听来的就不给（2026-11-24）
        return e.get("kind") != "summary" or not any(s != "?" and not outside(s, homes) for s in heard_in(e))
    seen = heard_in(e)
    return bool(seen) and all(outside(s, homes) for s in seen)


def recall(subjects: list[str], query: str = "", key: str | None = None,
           limits: dict[str, int] | None = None) -> list[dict]:
    """Every rule that applies in `key`, then per subject the memories most related to `query`
    (the current chat), ties broken by strength. Memories that are clearly related count as having
    come up again. `limits` lowers recallPerSubject for some subjects (people who have a card)."""
    cfg = _cfg()
    tcfg = _told_cfg(cfg)
    limits = limits or {}
    wanted = [RULES, "self"] + [_check_subject(s) for s in subjects if s.strip() not in ("self", RULES)]
    now = time.time()
    qt = tokens(query)
    with LOCK:
        db = _load()
        pool = [e for e in db["entries"] if e["subject"] != RULES]
        idf = _idf(pool)
        rare_idf = math.log((len(pool) + 1) / 2) + 0.1  # in at most 2 memories
        run_idf = _rare_cut(len(pool))
        qtri = _trigrams(query)
        homes = home_groups() if key else set()
        terms = owner_words(aliases=_owner_aliases()) if key and outside(key, homes) else []
        out, hit = [], False
        for subject in dict.fromkeys(wanted):
            # 文件只在它所在的那个聊天给（私聊的文件不会因为对方在群里说话就出现在群里）
            # 群友的事（收件箱）不给原文，卡上有（friendInbox）；她自己查（没有 key）时照给
            rows = [e for e in db["entries"] if e["subject"] == subject and shown_in(e, key, homes, terms)
                    and (not _is_file(e) or (key and e.get("fileKey") == key)) and not (key and _inbox(e, cfg))]
            scored = []
            if subject == RULES:
                rows.sort(key=lambda e: e["created"])  # every rule, oldest first
                scored = [(e, 0.0) for e in rows if in_scope(e, key)]
            else:
                for e in rows:
                    shared = tokens(e["text"]) & qt
                    rel = relevance(e["text"], qt, idf) if len(shared) >= 2 else 0.0  # one shared word is chance
                    strong, loose = _rare_shared(e["text"], shared, qtri, idf, rare_idf, run_idf)
                    # fully on-topic at hitThreshold, or when 2+ rare words (names, titles, numbers…) come up;
                    # loose rare words alone rank it up a little but never make it a hit
                    on_topic = min(1.0, max(rel / max(float(cfg["hitThreshold"]), 0.01), strong / 2,
                                            min(0.5, (strong + loose) / 2)))
                    # 讲过的见闻不再当话头（2026-10-23 她把同一只偷鞋的黄鼠狼讲了四个地方）：
                    # 聊天里又说到它才带上。她自己查（没有 key）时都给
                    if key and tcfg["enabled"] and _is_log(e) and e.get("told") and on_topic < 1.0:
                        continue
                    scored.append((e, on_topic, 0.6 * on_topic + 0.4 * strength(e, cfg, now)))
                scored.sort(key=lambda x: x[2], reverse=True)
                logs = [x for x in scored if _is_log(x[0])]
                # 最新记的几条见闻总给（recallRecentLogs）：问她今天干了啥，手里得有今天的事，
                # 不能全被昨天那些聊到过、强度一直是满的长笔记占了
                newest = sorted(logs, key=lambda x: x[0]["created"], reverse=True)[: int(cfg["recallRecentLogs"])]
                picked = {x[0]["id"] for x in newest}
                logs = (newest + [x for x in logs if x[0]["id"] not in picked])[: int(cfg["recallLogs"])]
                logs.sort(key=lambda x: x[2], reverse=True)
                files = [x for x in scored if _is_file(x[0])][: int(cfg["recallFiles"])]
                themes_ = [x for x in scored if _is_theme(x[0])][: int(cfg["recallThemes"])]
                per = min(int(cfg["recallPerSubject"]), int(limits.get(subject, cfg["recallPerSubject"])))
                scored = ([x for x in scored if not _is_log(x[0]) and not _is_file(x[0]) and not _is_theme(x[0])][:per]
                          + themes_ + logs + files)
                scored = [(e, rel) for e, rel, _ in scored]
            for e, rel in scored:
                # 刚在这里讲过的：聊天里那些词是她自己说的，不算“又想起来了”，不延长它
                own_words = tcfg["enabled"] and key and now - float((e.get("told") or {}).get(key, 0)) < DAY
                if subject != RULES and rel >= 1.0 and not own_words:
                    # spaced repetition: coming up again within one conversation (12 h) only restarts the clock
                    if now - e.get("lastHit", 0) > DAY / 2:
                        e["hits"] = int(e.get("hits", 0)) + 1
                    e["lastHit"] = now
                    hit = True
                out.append({"id": e["id"], "subject": subject, "text": e["text"],
                            "updated": time.strftime("%Y-%m-%d", time.localtime(e["updated"])),
                            **({"kind": e["kind"]} if e.get("kind") in ("summary", "log", "file", "theme") else {}),
                            **({"days": len(e.get("days") or [])} if _is_theme(e) else {}),
                            **({"file": e.get("file"), "name": e.get("name")} if _is_file(e) else {}),
                            **({"scope": e["scope"]} if e.get("scope") else {}),
                            **({"told": sorted(e["told"])} if tcfg["enabled"] and e.get("told") else {})})
        if hit:
            save_json(PATH, db)
    return out


def told(key: str, text: str) -> list[str]:
    """She just said `text` in conversation `key`: every 见闻 it retells (or clearly mentions) is marked as
    told there, so it stops coming up as something to share (recall). Returns the ids marked."""
    cfg = _cfg()
    tcfg = _told_cfg(cfg)
    key = str(key or "").strip()
    if not tcfg["enabled"] or not re.match(r"^(private|group):\d{5,12}$", key):
        return []
    said = tokens(text)
    if len(said) < 2:
        return []
    now = time.time()
    with LOCK:
        db = _load()
        pool = [e for e in db["entries"] if e["subject"] != RULES]
        idf = _idf(pool)
        cut = _rare_cut(len(pool))
        ids = []
        for e in pool:
            if not _is_log(e):
                continue
            shared = tokens(e["text"]) & said
            rare = sum(1 for t in shared if idf.get(t, 99) >= cut)
            if rare >= tcfg["minRare"] and overlap(tokens(e["text"]), said, idf) >= tcfg["minOverlap"]:
                e["told"] = {**(e.get("told") or {}), key: now}
                ids.append(e["id"])
        if ids:
            save_json(PATH, db)
    return ids


def same_story(a: str, b: str, idf: dict[str, float], cfg: dict) -> bool:
    """Two 见闻 about the same thing (she read the same article twice and noted it twice)."""
    if not float(cfg["logDupOverlap"]) > 0:
        return False
    ta, tb = tokens(a), tokens(b)
    return len(ta & tb) >= int(cfg["logDupMinShared"]) and overlap(ta, tb, idf) >= float(cfg["logDupOverlap"])


def note(subject: str, text: str, source: str = "", trusted: bool = False, interest: int | None = None,
         scope: list[str] | None = None) -> dict:
    """trusted=True only from digest.py (owner verified by QQ sender); unlocks subject "rules".
    A self note with an `interest` (1-3), or any self note from the play session, is a 见闻 (kind=log).
    `scope` (rules only, already checked with check_scope): where the rule applies; empty = everywhere."""
    cfg = _cfg()
    subject = _check_subject(subject, trusted)
    scope = list(scope or []) if subject == RULES else []
    is_log = subject == "self" and (bool(interest) or source == "play:main")
    text = " ".join(text.split())
    if not text:
        raise ValueError("text 不能为空")
    if cfg["maxChars"] and len(text) > cfg["maxChars"] and subject != RULES:
        raise ValueError(f"一条最多 {cfg['maxChars']} 个字，写成一句事实")
    if is_log and cfg["maxLogChars"] and len(text) > cfg["maxLogChars"]:
        raise ValueError(f"见闻一条最多 {cfg['maxLogChars']} 个字（这条 {len(text)} 字）：用一句话记你记住的样子，"
                         "看到了什么、哪里好玩、你觉得怎样；别抄播放量、分数、时长、编号这些数字，重新记一句")
    reason = _reason(subject, text)
    if reason:
        raise ValueError(reason)
    now = time.time()
    with LOCK:
        db = _load()
        # 见闻 and the rest of a subject are separate pools: dedup and eviction stay inside one pool.
        same = [e for e in db["entries"] if e["subject"] == subject and not _is_file(e) and not _is_theme(e)
                and _is_log(e) == is_log]
        if is_log and same:
            # The same story again (2026-10-22 she read one 果壳 article four times and noted it each time,
            # so it came up three times as often): keep the first note, don't refresh it.
            idf = _idf([e for e in db["entries"] if e["subject"] != RULES] + [{"text": text}])
            dup = next((e for e in same if same_story(e["text"], text, idf, cfg)), None)
            if dup:
                dup["interest"] = max(_interest(dup.get("interest")), _interest(interest or 1))
                save_json(PATH, db)
                return {"ok": True, "duplicate": dup["id"],
                        "hint": f"这件事你 {time.strftime('%m-%d', time.localtime(dup['created']))} 已经记过了"
                                f"（「{dup['text'][:40]}…」），没再记一遍。这个你之前看过了，换一样新鲜的吧。"}
        # Near-duplicate of an existing memory: update it instead of piling up copies.
        for e in same:
            if difflib.SequenceMatcher(None, e["text"], text).ratio() > 0.75:
                e.update(text=text, updated=now, source=source)
                if subject == RULES:
                    _set_scope(e, scope)
                if is_log:
                    e["interest"] = max(_interest(e.get("interest")), _interest(interest or 1))
                save_json(PATH, db)
                return {"ok": True, "updated": e["id"]}
        if subject == RULES and len(same) >= cfg["maxRules"]:
            # Never silently drop one of the owner's instructions to make room.
            raise ValueError(f"主人的叮嘱已经有 {len(same)} 条（上限 maxRules），先在 memory.json 里清理")
        entry = {"id": uuid.uuid4().hex[:8], "subject": subject, "text": text,
                 "created": now, "updated": now, "hits": 0, "source": source}
        if is_log:
            entry.update(kind="log", interest=_interest(interest or 1))
        _set_scope(entry, scope)
        db["entries"].append(entry)
        cap = (cfg["maxLogs"] if is_log else cfg["maxSelf"] if subject == "self"
               else cfg["maxPerOwner"] if subject in cfg["_owners"] else cfg["maxPerSubject"])
        if subject != RULES and len(same) + 1 > cap:
            # Evict the most faded memory of this subject (summaries fade slower, so they survive longer).
            # 见闻刚记的先不挤（logProtectHours）：夜里还没看过它以后用不用得到；全是刚记的才挤最淡的
            pool = same
            if is_log:
                fresh = now - float(cfg["logProtectHours"]) * 3600
                pool = [e for e in same if e["created"] < fresh] or same
            victim = min(pool, key=lambda e: strength(e, cfg, now))
            db["entries"].remove(victim)
            _archive_put([victim], "evicted", cfg)
        save_json(PATH, db)
        return {"ok": True, "added": entry["id"]}


def dedup_logs(dry_run: bool = True) -> list[dict]:
    """One-off cleanup (docker compose exec extras python3 -c ...): fold 见闻 about the same story into the
    oldest one (interest/hits: the larger, told: both). Returns [{keep, drop, text}]; dry_run writes nothing."""
    cfg = _cfg()
    with LOCK:
        db = _load()
        pool = [e for e in db["entries"] if e["subject"] != RULES]
        idf = _idf(pool)
        kept, out = [], []
        for e in sorted((e for e in pool if _is_log(e)), key=lambda e: e["created"]):
            k = next((k for k in kept if same_story(k["text"], e["text"], idf, cfg)), None)
            if k is None:
                kept.append(e)
                continue
            out.append({"keep": k["id"], "drop": e["id"], "text": e["text"][:60]})
            if not dry_run:
                k["interest"] = max(_interest(k.get("interest")), _interest(e.get("interest")))
                k["hits"] = max(int(k.get("hits", 0)), int(e.get("hits", 0)))
                k["lastHit"] = max(k.get("lastHit", 0), e.get("lastHit", 0))
                if e.get("told"):
                    k["told"] = {**e["told"], **(k.get("told") or {})}
                db["entries"].remove(e)
        if out and not dry_run:
            save_json(PATH, db)
    return out


def get(memory_id: str) -> dict | None:
    with LOCK:
        return next((e for e in _load()["entries"] if e["id"] == memory_id), None)


def _set_scope(e: dict, scope: list[str]) -> None:
    if scope:
        e["scope"] = list(scope)
    else:
        e.pop("scope", None)


def update(memory_id: str, text: str, source: str = "", trusted: bool = False, scope: list[str] | None = None) -> dict:
    """Rewrite one memory in place (used by digest.py when a fact or rule changed).
    `scope` None keeps a rule's scope; a list (maybe empty = everywhere) replaces it."""
    text = " ".join(text.split())
    with LOCK:
        db = _load()
        e = next((e for e in db["entries"] if e["id"] == memory_id), None)
        if e is None:
            raise ValueError("没有这条记忆")
        _check_subject(e["subject"], trusted)
        reason = _reason(e["subject"], text) if text else "text 不能为空"
        if reason:
            raise ValueError(reason)
        now = time.time()
        e.update(text=text, updated=now, source=source)
        if scope is not None and e["subject"] == RULES:
            _set_scope(e, scope)
        save_json(PATH, db)
    return {"ok": True, "updated": memory_id}


def forget(memory_id: str, trusted: bool = False) -> dict:
    with LOCK:
        db = _load()
        target = next((e for e in db["entries"] if e["id"] == memory_id), None)
        if target and target["subject"] == RULES and not trusted:
            raise ValueError("主人的叮嘱只有主人能让你忘掉，不能自己删")
        before = len(db["entries"])
        if target:
            _archive_put([target], "forgot")
        db["entries"] = [e for e in db["entries"] if e["id"] != memory_id]
        save_json(PATH, db)
    return {"ok": True, "removed": before - len(db["entries"])}


def entries_for(subjects: list[str], files: bool = False) -> list[dict]:
    """Raw entries of the given subjects, without counting as a hit (for digest.py). File memories only
    with files=True: they are about a file in one chat, not facts about the person or group."""
    wanted = set(subjects)
    with LOCK:
        return [dict(e) for e in _load()["entries"] if e["subject"] in wanted and (files or not _is_file(e))]


def by_subject() -> dict[str, list[dict]]:
    """Every non-rule memory grouped by subject, each with its current "strength" (for consolidate.py).
    The owner's rules are left out: the nightly job must never rewrite or drop them."""
    cfg, now = _cfg(), time.time()
    with LOCK:
        db = _load()
    groups: dict[str, list[dict]] = {}
    for e in db["entries"]:
        if e["subject"] != RULES and not _is_file(e):
            groups.setdefault(e["subject"], []).append({**e, "strength": strength(e, cfg, now)})
    return groups


def fold(subject: str, old_ids: list[str], texts: list[str]) -> list[str]:
    """Replace some memories of one subject with summary entries (the nightly job).
    Returns the new ids; does nothing if no usable text came back."""
    if subject == RULES:
        raise ValueError("主人的叮嘱不能被整理")
    cfg = _cfg()
    clean = []
    for t in texts:
        t = " ".join(str(t).split())
        if cfg["maxChars"]:
            t = t[: cfg["maxChars"]]
        if t and not rejection_reason(t):
            clean.append(t)
    if not clean:
        return []
    now = time.time()
    old = set(old_ids)
    with LOCK:
        db = _load()
        gone = [e for e in db["entries"] if e["id"] in old and e["subject"] == subject]
        created = min((e["created"] for e in gone), default=now)
        seen = sorted({s for e in gone for s in heard_in(e)})  # the impression may be shown where all of them may
        db["entries"] = [e for e in db["entries"] if e not in gone]
        ids = [uuid.uuid4().hex[:8] for _ in clean]
        _archive_put(gone, "folded", cfg, into=ids)
        for i, t in zip(ids, clean):
            db["entries"].append({"id": i, "subject": subject, "text": t, "kind": "summary",
                                  "created": created, "updated": now, "hits": 0, "source": "consolidate",
                                  **({"seen": seen} if seen else {})})
        save_json(PATH, db)
    return ids


def drop_faded(threshold: float) -> list[dict]:
    """Really forget: delete non-rule memories whose strength fell below threshold. The owners' never go,
    except the files in their chats (a file nobody talks about any more is let go everywhere)."""
    cfg, now = _cfg(), time.time()
    with LOCK:
        db = _load()
        gone = [e for e in db["entries"] if e["subject"] != RULES and (e["subject"] not in cfg["_owners"] or _is_file(e))
                and strength(e, cfg, now) < threshold]
        if gone:
            _archive_put(gone, "faded", cfg)
            db["entries"] = [e for e in db["entries"] if e not in gone]
            save_json(PATH, db)
    return gone


# ---- 主题、keep、收件箱（夜里 themes.py / consolidate.py 用） ----

def set_keep(keeps: dict[str, int]) -> int:
    """The night's guess of whether each 见闻 will be needed again (0/1/2): its half-life from now on."""
    with LOCK:
        db = _load()
        n = 0
        for e in db["entries"]:
            if _is_log(e) and e["id"] in keeps:
                e["keep"] = min(2, max(0, int(keeps[e["id"]])))
                e["judged"] = time.time()
                n += 1
        if n:
            save_json(PATH, db)
    return n


def themes() -> list[dict]:
    with LOCK:
        return [dict(e) for e in _load()["entries"] if _is_theme(e)]


def put_theme(text: str, days: list[str], members: list[str], theme_id: str | None = None,
              seen: list[str] | None = None, figure: str | None = None) -> str:
    """Write or update a theme: one long-lived memory for something that kept coming back on different days.
    `days` are dates (YYYY-MM-DD) it came up, `members` the 见闻 ids it was made from (live or archived).
    Updating merges days / members. Over maxThemes the most faded theme is archived."""
    cfg = _cfg()
    text = " ".join(str(text).split())
    reason = rejection_reason(text) if text else "空的"
    if reason:
        raise ValueError(reason)
    now = time.time()
    with LOCK:
        db = _load()
        e = next((x for x in db["entries"] if _is_theme(x) and x["id"] == theme_id), None) if theme_id else None
        if e is None:
            e = {"id": "t" + uuid.uuid4().hex[:7], "subject": "self", "kind": "theme", "text": text, "created": now,
                 "updated": now, "hits": 0, "source": "consolidate", "days": [], "members": []}
            db["entries"].append(e)
        e["text"] = text
        e["updated"] = now
        e["days"] = sorted(set(e.get("days") or []) | {str(d) for d in days})
        e["members"] = list(dict.fromkeys((e.get("members") or []) + [str(m) for m in members]))[-200:]
        if seen:
            e["seen"] = sorted(set(e.get("seen") or []) | set(seen))
        if figure:
            e["figure"] = figure
        pool = [x for x in db["entries"] if _is_theme(x)]
        if len(pool) > int(cfg["maxThemes"]):
            victim = min((x for x in pool if x is not e), key=lambda x: strength(x, cfg, now))
            db["entries"].remove(victim)
            _archive_put([victim], "evicted", cfg)
        save_json(PATH, db)
    return e["id"]


def inbox_due(now: float | None = None) -> dict[str, list[dict]]:
    """Friends' facts older than inboxDays, by subject (people.py should card them, then they are archived)."""
    cfg, now = _cfg(), now or time.time()
    cut = now - float(cfg["inboxDays"]) * DAY
    out: dict[str, list[dict]] = {}
    with LOCK:
        for e in _load()["entries"]:
            if _inbox(e, cfg) and e["created"] < cut:
                out.setdefault(e["subject"], []).append(dict(e))
    return out


def archive_inbox(carded_at: dict[str, float], now: float | None = None) -> list[dict]:
    """Archive friends' facts that are older than inboxDays and older than their card's last rewrite
    (carded_at[subject]); ones never carded go after inboxMaxDays anyway."""
    cfg, now = _cfg(), now or time.time()
    cut, hard = now - float(cfg["inboxDays"]) * DAY, now - float(cfg["inboxMaxDays"]) * DAY
    with LOCK:
        db = _load()
        gone = [e for e in db["entries"] if _inbox(e, cfg) and e["created"] < cut
                and (e["created"] <= float(carded_at.get(e["subject"]) or 0) or e["created"] < hard)]
        if gone:
            carded = [e for e in gone if e["created"] <= float(carded_at.get(e["subject"]) or 0)]
            _archive_put(carded, "carded", cfg)
            _archive_put([e for e in gone if e not in carded], "inbox-expired", cfg)
            db["entries"] = [e for e in db["entries"] if e not in gone]
            save_json(PATH, db)
    return gone


# ---- 文件（工作区里的文件，workspace.py 清理时看这里） ----

_FILE_KEY_RE = re.compile(r"^(private|group):(\d{5,12})$")
_FILE_ID_RE = re.compile(r"^[a-z0-9]{6,32}$")


def _file_subject(key: str) -> str:
    m = _FILE_KEY_RE.match(str(key or ""))
    if not m:
        raise ValueError("key 只能是 private:QQ号 或 group:群号")
    return f"qq:{m.group(2)}" if m.group(1) == "private" else f"group:{m.group(2)}"


def note_file(key: str, fid: str, name: str, text: str = "", touch: bool = False) -> dict:
    """She has (or just made, read, sent) file `fid` in chat `key`: write or refresh what she knows about it.
    `text` empty keeps the old text; `touch` counts as the file coming up again (spaced repetition, like a
    recall hit). Over maxFiles in one chat the most faded file memory goes (its file goes at 4 AM)."""
    cfg = _cfg()
    key = str(key or "").strip()
    subject = _file_subject(key)
    fid = str(fid or "").strip()
    if not _FILE_ID_RE.match(fid):
        raise ValueError("文件 id 不对")
    name = " ".join(str(name or "").split())[:80] or fid
    text = " ".join(str(text or "").split())[:300]
    # 文件里抄来的话可能像指令、带验证码：那就只记个名字（文件还是那个文件）
    if text and rejection_reason(text):
        text = ""
    label = name if not rejection_reason(name) else "一个文件"
    now = time.time()
    with LOCK:
        db = _load()
        e = next((e for e in db["entries"] if _is_file(e) and e.get("fileKey") == key and e.get("file") == fid), None)
        if e is None:
            e = {"id": uuid.uuid4().hex[:8], "subject": subject, "kind": "file", "fileKey": key, "file": fid,
                 "name": name, "text": text or f"文件「{label}」", "created": now, "updated": now, "hits": 0,
                 "source": key}
            db["entries"].append(e)
            same = [x for x in db["entries"] if _is_file(x) and x.get("fileKey") == key]
            if len(same) > int(cfg["maxFiles"]):
                victim = min((x for x in same if x is not e), key=lambda x: strength(x, cfg, now))
                db["entries"].remove(victim)
            out = {"ok": True, "added": e["id"]}
        else:
            e["name"] = name
            if text:
                e.update(text=text, updated=now)
            out = {"ok": True, "updated": e["id"]}
        if touch:
            if now - float(e.get("lastHit", 0)) > DAY / 2:
                e["hits"] = int(e.get("hits", 0)) + 1
            e["lastHit"] = now
        save_json(PATH, db)
    return out


def forget_file(key: str, fid: str) -> dict:
    """The file was deleted (she deleted it, or it is gone): its memory goes too."""
    with LOCK:
        db = _load()
        before = len(db["entries"])
        db["entries"] = [e for e in db["entries"] if not (_is_file(e) and e.get("fileKey") == key and e.get("file") == fid)]
        if len(db["entries"]) != before:
            save_json(PATH, db)
    return {"ok": True, "removed": before - len(db["entries"])}


def file_refs() -> dict[str, set[str]]:
    """Every file she still remembers: {chat key: {file id}} (workspace.cleanup keeps exactly these)."""
    out: dict[str, set[str]] = {}
    with LOCK:
        for e in _load()["entries"]:
            if _is_file(e) and e.get("fileKey") and e.get("file"):
                out.setdefault(e["fileKey"], set()).add(e["file"])
    return out


def forget_missing_files(present: dict[str, set[str]]) -> list[dict]:
    """Drop file memories whose file is no longer on disk (deleted by hand, restored backup…)."""
    with LOCK:
        db = _load()
        gone = [e for e in db["entries"] if _is_file(e) and e.get("file") not in present.get(e.get("fileKey"), set())]
        if gone:
            db["entries"] = [e for e in db["entries"] if e not in gone]
            save_json(PATH, db)
    return gone
