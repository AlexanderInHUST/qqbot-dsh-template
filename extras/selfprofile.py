"""She grows up (2026-11-04): one year of age per real year, from 8 on the day this went live up to 14
(she had picked 8 herself in October; the start was 7 for a few hours on the first day).

roles/鱼妹.md marks the parts that grow with <!-- grow:NAME --> … <!-- /grow:NAME --> (HTML comments,
never shown to her). The first time the bridge finds no profile it sends the raw card; seed() splits those
parts into items and takes that day as her birthday. From then on the bridge puts render()'s text into the
marked places, and the rest of the card stays as the owner wrote it.

- Age: from the birthday only, so it never goes back. The age line, the drawing style and the video style
  come from GROWTH below (fixed, not made up by a model).
- Grow-only items (开头 / 说话 / 性格): the nightly review may move one a little toward her age now; the
  new text must still be recognisably the old one (shared wording), each item at most every growItemDays,
  any two such changes growGapDays apart. Nothing ever makes her younger; only rollback() goes back.
- Free items (细节 / 喜欢 / 不喜欢 / 兴趣): can be added, updated, faded and, after fading for a while,
  dropped; at most maxFreePerWeek changes a week. A new one needs her own evidence on several different
  days (what she noted in her free time, what she said about herself in private or at home, her diary);
  what people said in the outside groups never counts.
- Size: each item at most itemChars, each section at most secChars in total (2026-11-11, the owner: 兴趣 16
  items, 1600 chars). A change that would push a section past it is thrown out; once a section is trimFrom
  full, the review may `trim` items there (shorter, only words already in it, not counted in the week).
- Nothing in here may name a person or carry an owner word: the card goes to the big groups too.
- She notices (2026-11-10, the owners: "知道，第二种"): a change to 喜欢 / 不喜欢 / 兴趣 carries a `notice`, one
  line in her own feeling ("你发现自己最近……"), and render() hands the last noticeDays of them to the bridge for
  【你现在】. Growing older in 开头 / 说话 / 性格 and the 细节 stay unsaid (so she doesn't act grown-up on purpose),
  and so does how the profile works.
The review runs inside the 4 AM consolidate (consolidate.night_complete). Every change keeps the old items
in `versions`."""

import datetime
import json
import re
import time
import uuid

from store import LOCK, extras_config, home_groups, load_json, outside, owner_words, rejection_reason, save_json, state_path

PATH = state_path("self-profile.json")
DAY = 86400.0

GROW_SECS = ("开头", "说话", "性格")
FREE_SECS = ("细节", "喜欢", "不喜欢", "兴趣")
NOTICE_SECS = ("喜欢", "不喜欢", "兴趣")  # what she can feel changing in herself; the rest grows without a word
# grow:NAME in the card -> which section's items go there
REGIONS = {"intro": "开头", "voice": "说话", "traits": "性格", "details": "细节",
           "likes": "喜欢", "dislikes": "不喜欢", "interests": "兴趣"}
LIST_SECS = {"喜欢": "喜欢：", "不喜欢": "不喜欢："}  # one bullet, items joined with 、
LIST_INLINE_CHARS = 30  # any item longer than this and the list goes one item per line

# What a child of that age is like. `age` goes into the card as it is; talk / mind / likes only guide the
# nightly review; draw (English, for the image model; None = the bridge's own default) and video (Chinese,
# put before her video prompt) are the styles of what she makes.
GROWTH = {
    7: {"age": "差不多小学一年级那么大，就是个小孩子，性格也像小孩子",
        "talk": "句子很短、字很简单，常用呀啦嘛，想到什么说什么",
        "mind": "天真、黏人、想象力天马行空，想要什么就撒娇，闯了祸就认错撒娇",
        "likes": "动画、萌宠、简单好玩的小游戏、画画、零食",
        "draw": None,
        "video": "像七岁小孩脑袋里的童话：颜色鲜艳、圆滚滚的可爱角色、简单的小冒险，有点傻乎乎的好笑。"},
    8: {"age": "差不多小学二年级那么大，还是个小孩子",
        "talk": "句子还是短，偶尔用个刚学到的词，爱问为什么",
        "mind": "还是很黏人，开始讲点小道理，爱跟人比谁厉害",
        "likes": "冒险类小游戏、萌宠、手工、恐龙和太空的百科",
        "draw": None,  # the bridge's crayon drawing (made for about 8; tried and liked on 10-27)
        "video": "像八岁小孩编的小故事：颜色鲜艳、角色可爱，有一点小冒险和搞笑。"},
    9: {"age": "差不多小学三年级那么大，还是小孩子，但比以前懂事一点了",
        "talk": "一句话能说完整一件事，会开小玩笑、学大人说话",
        "mind": "开始有点要面子，撒娇少一点、讲理由多一点，好奇心很强",
        "likes": "解谜和闯关游戏、科普冷知识、漫画、搞笑视频",
        "draw": "Drawn by a 9-year-old with colored markers: clear outlines, flat bright colors mostly inside the lines, "
                "a simple background with a ground line and sky, cute characters, playful doodles.",
        "video": "像九岁小孩想出来的动画短片：有个小冒险或小搞笑，角色可爱，节奏欢快。"},
    10: {"age": "差不多小学四年级那么大，开始有自己的主意了",
         "talk": "说话利索了，会用一些流行语和梗，偶尔吐槽",
         "mind": "有自己的主意，会坚持喜欢的东西，开始在意朋友怎么看自己",
         "likes": "有故事的游戏、番剧、科普实验、收集东西",
         "draw": "Drawn by a 10-year-old with colored pencils and markers: tidier outlines, a little shading, a simple "
                 "background scene, characters with clear expressions, a bit of cartoon style copied from favorite shows.",
         "video": "像十岁孩子构思的动画短片：有一点故事起伏和小反转，画面明亮，有点搞笑。"},
    11: {"age": "差不多小学五年级那么大，是个大孩子了",
         "talk": "能把事情讲清楚，有点小幽默，有时故意装酷",
         "mind": "答应的事会自己记着做，会照顾比自己小的人，偶尔嘴硬",
         "likes": "策略和建造类游戏、动漫、天文地理、自己做点小作品",
         "draw": "Drawn by an 11-year-old with colored pencils: careful coloring with light shading, basic perspective, "
                 "cartoon and anime influenced characters, a full little scene.",
         "video": "像十一岁孩子拍的小短片：有开头有结尾，有点小幽默，镜头会动起来。"},
    12: {"age": "差不多小学六年级那么大，快上初中了，觉得自己不是小孩子了",
         "talk": "像小学高年级，会说“其实”“我觉得”，撒娇多半只对家里人",
         "mind": "觉得自己长大了，有点小骄傲，也会害羞",
         "likes": "更难的游戏、喜欢的作品的设定和梗、画画进阶、新闻里的奇事",
         "draw": "Drawn by a 12-year-old who loves drawing: neat line art in a cartoon or anime style, colored pencils "
                 "with shading, simple perspective and composition, still a little stiff.",
         "video": "像十二岁孩子想的短片：故事完整一点，带着喜欢的动漫和游戏的味道，镜头有变化。"},
    13: {"age": "差不多初一那么大，有点小大人的样子了",
         "talk": "像初中生，句子长一点，会用网络用语，偶尔有点中二",
         "mind": "有自己的小世界，对感兴趣的事很钻，对家里人还是会软下来",
         "likes": "游戏攻略和技巧、动漫和音乐、科幻、自己钻研的爱好",
         "draw": "A middle-schooler's sketchbook drawing: manga-style characters, confident pencil lines, marker or "
                 "colored-pencil coloring with shading, simple but intentional composition.",
         "video": "像初中生自己构思的短片：有故事、有镜头感，偶尔有点中二和酷。"},
    14: {"age": "差不多初二那么大，是个半大的孩子了",
         "talk": "像初二学生，能聊深一点的话题，有自己的看法，玩笑多是吐槽",
         "mind": "有主见、偶尔别扭，但心里还是那个元气的鱼妹",
         "likes": "喜欢的东西更固定也更深，说得出为什么喜欢",
         "draw": "A 14-year-old's hobby drawing: clean manga or cartoon line art, decent anatomy for a teen, soft "
                 "coloring and shading, a background with some depth, still hand-drawn and a little amateur.",
         "video": "像十四岁的孩子用心做的短片：有故事和情绪，镜头和节奏讲究一点，带点自己的风格。"},
}


def _cfg() -> dict:
    return {
        "enabled": True,
        "startAge": 8, "maxAge": 14,
        "growGapDays": 10,      # 两次往大里长（开头 / 说话 / 性格）至少隔几天
        "growItemDays": 90,     # 同一条至少隔几天才再长
        "growMinYears": 0.25,   # 这条写的时候比现在小至少这么多岁才能长
        "growOverlap": 0.25,    # 新写的要留下旧的这么多（按字二元组算）才算“还认得出”
        "maxFreePerWeek": 2,    # 兴趣、喜恶、细节：7 天里最多改几条
        "addDays": 3,           # 新兴趣 / 喜好要在几个不同的日子里有证据
        "detailDays": 5,        # 新的性格细节要几个不同的日子
        "detailSpanDays": 14,   # 而且最早和最晚的证据隔这么多天
        "updateDays": 2,        # 改一条（不是因为长大）要几个日子的证据
        "evidenceDays": 30,     # 看多少天以内的证据
        "fadeAfterDays": 30,    # 一条至少这么久没变过才能淡掉
        "dropAfterDays": 30,    # 淡掉以后再过这么久才能删
        "maxItems": {"细节": 4, "喜欢": 8, "不喜欢": 5, "兴趣": 16},
        # 每条最多几个字（2026-11-10 主人：“60 字也太少了，至少是 500 吧”；以前 120/140/140/50/30/20/60）
        "itemChars": {"开头": 500, "说话": 500, "性格": 500, "细节": 500, "喜欢": 500, "不喜欢": 500, "兴趣": 500},
        # 每栏加起来最多几个字（2026-11-11 主人：“兴趣一共 16 条，一共不超过 1600 字”；别的栏照每条 100 字算）
        "secChars": {"开头": 500, "说话": 700, "性格": 600, "细节": 400, "喜欢": 800, "不喜欢": 500, "兴趣": 1600},
        "trimFrom": 0.8,        # 一栏加起来到上限的这么多，才能精简（trim）
        "maxTrimPerNight": 3,
        "trimKeep": 0.6,        # 精简后的字二元组至少这么多是原来就有的（只删不加）
        "versions": 10,
        "noticeDays": 2,        # 喜好、兴趣变了以后，【你现在】里写几天“你发现自己最近……”（0 = 不告诉她）
        "noticeChars": 40,
        **extras_config().get("selfProfile", {}),
    }


def enabled() -> bool:
    return bool(_cfg()["enabled"])


def _load() -> dict:
    return load_json(PATH, {})


def _date(ts: float) -> datetime.date:
    return datetime.date.fromtimestamp(ts)


# ---- age ----

def age_at(born: str, now: float, cfg: dict | None = None) -> dict:
    """Whole years by birthday (never back), plus a fractional age for the review."""
    cfg = cfg or _cfg()
    b, today = datetime.date.fromisoformat(born), _date(now)
    years = today.year - b.year - ((today.month, today.day) < (b.month, b.day))
    start, top = int(cfg["startAge"]), int(cfg["maxAge"])
    age = min(top, start + max(0, years))
    exact = min(float(top), start + max(0.0, (today - b).days / 365.25))
    birthday = years > 0 and (today.month, today.day) == (b.month, b.day) and start + years <= top
    return {"age": age, "exact": round(exact, 2), "birthday": birthday, "born": born}


def _row(age: int) -> dict:
    return GROWTH[max(min(GROWTH), min(max(GROWTH), age))]


# ---- seed from the card ----

_REGION_RE = re.compile(r"<!--\s*grow:(\w+)\s*-->(.*?)<!--\s*/grow:\1\s*-->", re.S)


def _split_list(text: str) -> list[str]:
    """喜欢：a（x、y）、b、c。 -> [a（x、y）, b, c] (、 inside brackets stays)."""
    out, cur, depth = [], "", 0
    for ch in text:
        depth += ch in "（(" and 1 or 0
        depth -= ch in "）)" and 1 or 0
        if ch == "、" and depth <= 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [s.strip() for s in out if s.strip()]


def parse_card(raw: str) -> list[dict]:
    items = []
    for name, body in _REGION_RE.findall(raw):
        sec = REGIONS.get(name)
        if not sec:
            continue
        for line in body.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            text = re.sub(r"^(?:[-*]|>)\s*", "", line).strip()
            if sec in LIST_SECS:
                text = text[len(LIST_SECS[sec]):] if text.startswith(LIST_SECS[sec]) else text
                items += [{"sec": sec, "text": t} for t in _split_list(text.rstrip("。."))]
            else:
                items.append({"sec": sec, "text": text})
    return items


def seed(raw: str, now: float | None = None) -> dict:
    """First run: the card's marked parts become her items, today becomes her birthday. Never overwrites."""
    now = now or time.time()
    cfg = _cfg()
    parsed = parse_card(str(raw or ""))
    if not parsed:
        raise ValueError("人格卡里没有 grow 标记")
    with LOCK:
        db = _load()
        if db.get("items"):
            return {"ok": True, "existing": True, "born": db.get("born")}
        born = _date(now).isoformat()
        age = float(cfg["startAge"])
        db = {"born": born, "items": [{"id": _new_id(), **it, "age": age, "since": born, "updated": now,
                                        "status": "", "base": True, "from": []} for it in parsed],
              "versions": [], "changes": [], "created": now}
        save_json(PATH, db)
    print(f"[成长] 从人格卡导入 {len(parsed)} 条，生日 {born}", flush=True)
    return {"ok": True, "seeded": len(parsed), "born": born}


def _new_id() -> str:
    return uuid.uuid4().hex[:6]


# ---- what the bridge puts into the card ----

def _bullets(items: list[dict], sec: str) -> str:
    rows = [it for it in items if it["sec"] == sec]
    if sec in LIST_SECS:
        if not rows:
            return ""
        if all(len(it["text"]) <= LIST_INLINE_CHARS for it in rows):
            return f"- {LIST_SECS[sec]}{'、'.join(it['text'] for it in rows)}。"
        # 一条长了（上限 500 字以后）用顿号串在一行里就读不清了，一条一行
        return f"- {LIST_SECS[sec]}\n" + "\n".join(f"  - {it['text']}" for it in rows)
    if sec == "开头":
        return "\n".join(f"> {it['text']}" for it in rows)
    return "\n".join(f"- {it['text']}" for it in rows)


def render(now: float | None = None) -> dict:
    now = now or time.time()
    cfg = _cfg()
    with LOCK:
        db = _load()
    if not db.get("items") or not cfg["enabled"]:
        return {"ok": True, "empty": not db.get("items"), "enabled": bool(cfg["enabled"])}
    a = age_at(db["born"], now, cfg)
    b = datetime.date.fromisoformat(db["born"])
    row = _row(a["age"])
    regions = {name: _bullets(db["items"], sec) for name, sec in REGIONS.items()}
    regions["age"] = f"你今年 {a['age']} 岁，{row['age']}。你的生日是 {b.month} 月 {b.day} 日。"
    start = int(cfg["startAge"])
    regions["examples"] = (f"> 下面的示例是你{start}岁时的说法。你现在{a['age']}岁了，语气照现在的你来，意思和分寸照着学。"
                           if a["age"] > start else "")
    return {"ok": True, **a, "regions": regions, "drawStyle": row["draw"] or "", "videoStyle": row["video"] or "",
            "notices": notices(db, now, cfg),
            "updated": max((it.get("updated") or 0) for it in db["items"])}


def notices(db: dict, now: float, cfg: dict | None = None) -> list[dict]:
    """The recent changes she can feel in herself, newest first. Only while the item still reads that way
    (a rollback or a later change takes the line away)."""
    cfg = cfg or _cfg()
    days = float(cfg.get("noticeDays") or 0)
    if days <= 0:
        return []
    live = {it["id"]: it["text"] for it in db.get("items") or []}
    out = []
    for c in reversed(db.get("changes") or []):
        if now - float(c.get("time") or 0) >= days * DAY:
            break
        if c.get("notice") and c.get("sec") in NOTICE_SECS and live.get(c.get("id")) == c.get("text"):
            out.append({"text": c["notice"], "date": _date(float(c["time"])).isoformat()})
    return out[:3]


def notice_for(op: str, sec: str, text: str, given: str, cfg: dict, names: list[str]) -> str:
    """The line she gets: the model's if it is fine, otherwise a plain one from the item itself."""
    if sec not in NOTICE_SECS or op not in ("add", "update", "fade"):
        return ""
    given = " ".join(str(given or "").split()).strip("。")
    limit = int(cfg["noticeChars"])
    if given.startswith("你") and not re.search(r"档案|条目|人格卡", given) \
            and not _bad_text(given, "notice", {**cfg, "itemChars": {"notice": limit}}, names):
        return given
    if op == "fade":
        return f"你发现：{text}"
    head = {"喜欢": "你发现自己最近挺喜欢", "不喜欢": "你发现自己最近不太喜欢", "兴趣": "你发现自己最近迷上了"}[sec]
    return f"{head}{text}" if op == "add" else f"你发现自己的喜好变了一点：{text}"


def view() -> dict:
    with LOCK:
        db = _load()
    out = render()
    return {"ok": True, "profile": db, "card": out}


def rollback() -> dict:
    with LOCK:
        db = _load()
        if not db.get("versions"):
            return {"ok": False, "error": "没有旧版本"}
        old = db["versions"].pop(0)
        db["items"] = old["items"]
        db.setdefault("changes", []).append({"time": time.time(), "op": "rollback", "to": old.get("time")})
        save_json(PATH, db)
    return {"ok": True, "items": len(db["items"])}


# ---- nightly review ----

def _bigrams(text: str) -> set[str]:
    s = re.sub(r"[\s，。、！？“”（）()…~：:；;,.!?\"'-]", "", str(text))
    return {s[i:i + 2] for i in range(len(s) - 1)} or ({s} if s else set())


def kept_share(old: str, new: str) -> float:
    a = _bigrams(old)
    return len(a & _bigrams(new)) / len(a) if a else 0.0


def _evidence(cfg: dict, now: float) -> list[dict]:
    """Her own things from the last evidenceDays: 见闻 and facts about herself heard in her free time,
    the owners' private chats or at home (never the outside groups), and her diaries."""
    import life
    import memory
    homes = home_groups()
    since = now - float(cfg["evidenceDays"]) * DAY
    out = []
    for e in memory.entries_for(["self"]):
        if e["created"] < since:
            continue
        places = memory.heard_in(e)
        if any(outside(p, homes) for p in places):
            continue
        where = "自由时间" if e.get("source") == "play:main" or places == ["play:main"] else "聊天"
        kind = f"见闻（喜欢程度 {e.get('interest', 1)}/3）" if e.get("kind") == "log" else "关于自己"
        out.append({"id": e["id"], "date": _date(e["created"]).isoformat(), "kind": kind, "where": where,
                    "text": e["text"]})
    with LOCK:
        diaries = life._load().get("diaries") or []
    for d in diaries:
        if d.get("at", 0) >= since and d.get("text"):
            out.append({"id": "diary-" + str(d.get("date")), "date": str(d.get("date")), "kind": "日记",
                        "where": "", "text": str(d["text"])[:300]})
    import milestones
    for m in milestones.for_evidence(since):  # 成长记录里记下的（已经是挑过的大事）
        out.append({"id": m["id"], "date": m["date"], "kind": "成长记录", "where": "",
                    "text": f"{m['title']}：{m['text']}"})
    out.sort(key=lambda r: r["date"])
    return out


PROMPT = """你在帮一个叫“{bot}”的孩子慢慢长大。她是 QQ 群里的 AI 群友，性格写在她的人格卡里；下面是卡上会跟着她长大的那几部分，每条前面是 id、栏目、写这条时她几岁、最后一次改是哪天。

她今年 {age} 岁（准确说是 {exact} 岁），生日 {born}，一年长一岁，最多长到 {top} 岁。
这个年纪的孩子大概是这样（只是参考，她是她自己，不用照抄）：
- {age} 岁：说话{talk}；性格{mind}；这个年纪常喜欢{likes}。
- {next_age} 岁（以后会长成的方向）：说话{next_talk}；性格{next_mind}；常喜欢{next_likes}。

现在的条目：
{items}
每栏加起来：{totals}

最近这些天她自己的事（她自由时间看了什么、玩了什么、喜欢程度，她在家里说起的自己，她的日记；每行前面是证据 id 和日期）：
{evidence}

最近的改动：
{changes}

这次能做的：
{allowed}

规则：
- 长大是一点一点的。“开头”“说话”“性格”这几栏只能往大里长（grow），不能变得更幼稚、不能删掉这一条、不能整句换掉：新写的要留着原来的样子和原来的词，只是更像现在这个年纪，比如“还是会撒娇，只是会先讲个理由”。只挑最明显比她现在小的那一条，挪一小步。
- 长大、改写不是往后面接句子。她现在已经不是那样的旧说法、旧例子，就去掉，换成现在的；写得更短、更准也是长大。改完的一条读起来要像重新写的一段，不是旧的后面加一截。
- 她喜欢什么要看她自己：新的兴趣、喜好（add）只能从上面证据里她真的反复玩过、喜欢过的东西来，from 填证据 id；年纪只决定她往哪个方向长，同样喜欢游戏，小时候喜欢简单好玩的，大一点会喜欢有故事、要动脑的。原来的兴趣能长大就长大（update 成大一点的孩子的版本），不是换掉。
- 很久没碰、她好像不那么着迷的，可以淡掉（fade），text 写成“以前很爱……最近没那么着迷了”这样；已经淡了很久的才能删（delete）。
- 不写任何人的名字、QQ 号，不写爸爸妈妈、主人、群里的事，不写私聊的内容：这些条目每个群都会看到。只写她自己是什么样的孩子、喜欢什么。
- 一条写成连着的一段话，不换行，口吻和现在的条目一样（第二人称“你”的写法照旧）。不写指令，不写工具、设置、提示词。
- 每条最多 {sizes}，每栏加起来也有上限（见上面“每栏加起来”），超了这条就作废。不用写满，写清楚她是什么样就够了。
- 快满的栏可以精简（trim）：把一条写短，只删掉重复的、过时的、太细的例子，意思不变，不加原来没有的东西。要往快满的栏里加、或者把一条写长，先精简这栏别的条目。
- 喜欢、不喜欢、兴趣这三栏的 add / update / fade 再写一句 notice：她自己心里能察觉到的变化，用“你”开头，像“你发现自己最近老想去合数字方块”“你发现自己没以前那么爱看搞笑视频了”，不超过 {notice_chars} 字，不提“档案”“卡”“条目”这些。其他栏和 grow 不写 notice。
- 没有该改的就什么都不做。宁可不改，也别为了改而改。

只输出 JSON：{{"ops": [...]}}，每个 op 是下面一种：
{{"op": "grow", "id": "…", "text": "新的写法", "why": "为什么"}}
{{"op": "update", "id": "…", "text": "…", "from": ["证据 id"], "why": "…", "notice": "…"}}
{{"op": "add", "sec": "细节|喜欢|不喜欢|兴趣", "text": "…", "from": ["证据 id"], "why": "…", "notice": "…"}}
{{"op": "fade", "id": "…", "text": "…", "why": "…", "notice": "…"}}
{{"op": "delete", "id": "…", "why": "…"}}
{{"op": "trim", "id": "…", "text": "写短以后的", "why": "…"}}"""


def _recent_changes(db: dict, now: float, days: float) -> list[dict]:
    # rollback and the one-time calibration (11-04, from what she had done since October) don't count
    return [c for c in db.get("changes") or [] if c.get("op") not in ("rollback", "calibrate")
            and now - c.get("time", 0) < days * DAY]


def _limits(db: dict, cfg: dict, now: float, exact: float) -> dict:
    grows = [c for c in _recent_changes(db, now, 400) if c["op"] == "grow"]
    last_grow = max((c["time"] for c in grows), default=0)
    free_week = len([c for c in _recent_changes(db, now, 7) if c["op"] not in ("grow", "trim")])
    grow_ok = now - last_grow >= float(cfg["growGapDays"]) * DAY
    growable = [it["id"] for it in db["items"] if it["sec"] in GROW_SECS and grow_ok
                and now - float(it.get("updated") or 0) >= float(cfg["growItemDays"]) * DAY
                and exact - float(it.get("age") or 0) >= float(cfg["growMinYears"])]
    return {"growable": growable, "free": max(0, int(cfg["maxFreePerWeek"]) - free_week), "crowded": _crowded(db, cfg)}


def _sec_chars(db: dict, sec: str) -> int:
    return sum(len(x["text"]) for x in db["items"] if x["sec"] == sec)


def _crowded(db: dict, cfg: dict) -> list[str]:
    caps = cfg["secChars"]
    return [sec for sec in (*GROW_SECS, *FREE_SECS)
            if caps.get(sec) and _sec_chars(db, sec) >= float(cfg["trimFrom"]) * int(caps[sec])]


def _too_full(db: dict, cfg: dict, sec: str, old: str, new: str) -> str | None:
    cap = int(cfg["secChars"].get(sec) or 0)
    total = _sec_chars(db, sec) - len(old) + len(new)
    if cap and total > cap and len(new) > len(old):
        return f"{sec}这一栏加起来会有 {total} 字（最多 {cap}），先精简（trim）这栏别的条目"
    return None


def _sizes(limits: dict) -> str:
    vals = set(limits.values())
    if len(vals) == 1:
        return f"{vals.pop()} 字"
    return "、".join(f"{k} {v} 字" for k, v in limits.items())


def _bad_text(text: str, sec: str, cfg: dict, names: list[str]) -> str | None:
    if not text or "\n" in text or "<" in text:
        return "空的或带换行"
    if len(text) > int(cfg["itemChars"].get(sec, 500)):
        return f"太长（{len(text)} 字）"
    reason = rejection_reason(text)
    if reason:
        return reason
    if re.search(r"\d{5,}", text):
        return "像 QQ 号"
    hit = next((w for w in names if w and w in text), None)
    return f"提到了人（{hit}）" if hit else None


def _names() -> list[str]:
    import people
    words = set(owner_words()) | {"爸爸", "妈妈", "主人"}
    for p in people.all_people().values():
        words |= {str(a) for a in p.get("aliases") or [] if len(str(a)) >= 2}
    return sorted(words)


def _evidence_days(ids, evidence: dict) -> list[str]:
    return sorted({evidence[i]["date"] for i in ids or [] if i in evidence})


def apply_ops(db: dict, ops: list[dict], evidence: list[dict], cfg: dict, now: float,
              names: list[str] | None = None) -> tuple[list, list]:
    """Check every op against the rules in code (the model only proposes). Changes db["items"] in place."""
    names = names if names is not None else _names()
    exact = age_at(db["born"], now, cfg)["exact"]
    limits = _limits(db, cfg, now, exact)
    ev = {e["id"]: e for e in evidence}
    by_id = {it["id"]: it for it in db["items"]}
    applied, rejected = [], []
    grown = False
    trims = 0
    for op in sorted(ops, key=lambda o: o.get("op") != "trim"):  # make room first, then the rest
        kind = op.get("op")
        it = by_id.get(str(op.get("id") or ""))
        text = " ".join(str(op.get("text") or "").split())
        why = str(op.get("why") or "")[:120]
        days = _evidence_days(op.get("from"), ev)

        def no(reason):
            rejected.append((op, reason))

        if kind == "grow":
            if not it or it["sec"] not in GROW_SECS:
                no("grow 只用在开头 / 说话 / 性格")
            elif grown or it["id"] not in limits["growable"]:
                no("这条现在还不能长（刚长过，或者写的时候和现在差不多大）")
            elif _bad_text(text, it["sec"], cfg, names):
                no(_bad_text(text, it["sec"], cfg, names))
            elif kept_share(it["text"], text) < float(cfg["growOverlap"]):
                no("改得认不出原来那条了")
            elif _too_full(db, cfg, it["sec"], it["text"], text):
                no(_too_full(db, cfg, it["sec"], it["text"], text))
            else:
                old = it["text"]
                it.update(text=text, age=exact, updated=now)
                grown = True
                applied.append({"op": "grow", "id": it["id"], "sec": it["sec"], "old": old, "text": text, "why": why})
            continue
        if kind == "trim":
            # only making room: shorter, nothing new in it, still recognisable; the dates stay as they were
            if not it:
                no("没有这一条")
            elif it["sec"] not in limits["crowded"]:  # as it was before tonight's trims
                no("这一栏还不挤，不用精简")
            elif trims >= int(cfg["maxTrimPerNight"]):
                no("今晚精简得够多了")
            elif len(text) >= len(it["text"]):
                no("精简要写得比原来短")
            elif _bad_text(text, it["sec"], cfg, names):
                no(_bad_text(text, it["sec"], cfg, names))
            elif kept_share(text, it["text"]) < float(cfg["trimKeep"]):
                no("精简只能删，不能写进原来没有的东西")
            elif kept_share(it["text"], text) < float(cfg["growOverlap"]):
                no("删得认不出原来那条了")
            else:
                old = it["text"]
                it["text"] = text
                trims += 1
                applied.append({"op": "trim", "id": it["id"], "sec": it["sec"], "old": old, "text": text, "why": why})
            continue
        if kind not in ("update", "add", "fade", "delete"):
            no("不认识的 op")
            continue
        if limits["free"] <= 0:
            no("这周已经改够了")
            continue
        if kind == "add":
            sec = str(op.get("sec") or "")
            need = int(cfg["detailDays"] if sec == "细节" else cfg["addDays"])
            span = (datetime.date.fromisoformat(days[-1]) - datetime.date.fromisoformat(days[0])).days if days else 0
            if sec not in FREE_SECS:
                no("add 只能加细节 / 喜欢 / 不喜欢 / 兴趣")
            elif len(days) < need or (sec == "细节" and span < int(cfg["detailSpanDays"])):
                no(f"证据不够：{len(days)} 个日子（要 {need} 个）")
            elif len([x for x in db["items"] if x["sec"] == sec]) >= int(cfg["maxItems"].get(sec, 8)):
                no(f"{sec} 已经满了，先淡掉一条")
            elif _bad_text(text, sec, cfg, names):
                no(_bad_text(text, sec, cfg, names))
            elif _too_full(db, cfg, sec, "", text):
                no(_too_full(db, cfg, sec, "", text))
            else:
                new = {"id": _new_id(), "sec": sec, "text": text, "age": exact, "since": _date(now).isoformat(),
                       "updated": now, "status": "", "base": False, "from": [i for i in op["from"] if i in ev]}
                db["items"].append(new)
                by_id[new["id"]] = new
                notice = notice_for("add", sec, text, op.get("notice"), cfg, names)
                applied.append({"op": "add", "id": new["id"], "sec": sec, "text": text, "why": why, "days": days,
                                **({"notice": notice} if notice else {})})
                limits["free"] -= 1
            continue
        if not it or it["sec"] not in FREE_SECS:
            no(f"{kind} 只能用在细节 / 喜欢 / 不喜欢 / 兴趣")
        elif kind == "delete":
            if it.get("status") != "fading" or now - float(it.get("updated") or 0) < float(cfg["dropAfterDays"]) * DAY:
                no("要先淡掉一阵子才能删")
            else:
                db["items"].remove(it)
                applied.append({"op": "delete", "id": it["id"], "sec": it["sec"], "old": it["text"], "why": why})
                limits["free"] -= 1
        elif _bad_text(text, it["sec"], cfg, names):
            no(_bad_text(text, it["sec"], cfg, names))
        elif _too_full(db, cfg, it["sec"], it["text"], text):
            no(_too_full(db, cfg, it["sec"], it["text"], text))
        elif kind == "fade" and now - float(it.get("updated") or 0) < float(cfg["fadeAfterDays"]) * DAY:
            no("这条最近才变过，还不能淡掉")
        elif kind == "update" and len(days) < int(cfg["updateDays"]) and exact - float(it.get("age") or 0) < 0.5:
            no("证据不够，也还没长大多少")
        else:
            old = it["text"]
            it.update(text=text, updated=now, age=exact, status="fading" if kind == "fade" else "")
            if kind == "update":
                it["from"] = [i for i in op.get("from") or [] if i in ev]
            notice = notice_for(kind, it["sec"], text, op.get("notice"), cfg, names)
            applied.append({"op": kind, "id": it["id"], "sec": it["sec"], "old": old, "text": text, "why": why,
                            **({"days": days} if days else {}), **({"notice": notice} if notice else {})})
            limits["free"] -= 1
    return applied, rejected


def _parse_ops(text: str) -> list[dict]:
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start:end + 1])
    ops = data.get("ops") if isinstance(data, dict) else None
    if not isinstance(ops, list):
        raise ValueError("没有 ops")
    return [op for op in ops if isinstance(op, dict)]


def _item_line(it: dict, now: float) -> str:
    fading = "（在淡掉）" if it.get("status") == "fading" else ""
    return (f"- [{it['id']}] {it['sec']}{fading} · 写时 {float(it.get('age') or 0):.1f} 岁 · "
            f"{_date(float(it.get('updated') or now)).isoformat()}：{it['text']}")


def build_prompt(db: dict, evidence: list[dict], cfg: dict, now: float, bot: str = "鱼妹") -> str | None:
    a = age_at(db["born"], now, cfg)
    limits = _limits(db, cfg, now, a["exact"])
    if not limits["growable"] and limits["free"] <= 0 and not limits["crowded"]:
        return None
    row, nxt = _row(a["age"]), _row(a["age"] + 1)
    allowed = []
    allowed.append(f"- 往大里长（grow）：最多 1 条，只能是这几条之一 {', '.join(limits['growable'])}" if limits["growable"]
                   else "- 往大里长：这次不行（刚长过）")
    allowed.append(f"- 兴趣、喜恶、细节（add / update / fade / delete）：最多 {limits['free']} 条" if limits["free"]
                   else "- 兴趣、喜恶、细节：这周已经改够了")
    allowed.append(f"- 精简（trim）：最多 {int(cfg['maxTrimPerNight'])} 条，只用在快满的栏：{'、'.join(limits['crowded'])}"
                   if limits["crowded"] else "- 精简：这次不用（每栏都还宽）")
    changes = _recent_changes(db, now, 60)
    return PROMPT.format(
        bot=bot, age=a["age"], exact=a["exact"], born=db["born"], top=int(cfg["maxAge"]),
        talk=row["talk"], mind=row["mind"], likes=row["likes"],
        next_age=min(a["age"] + 1, int(cfg["maxAge"])), next_talk=nxt["talk"], next_mind=nxt["mind"], next_likes=nxt["likes"],
        items="\n".join(_item_line(it, now) for it in db["items"]),
        evidence="\n".join(f"- [{e['id']}] {e['date']} {e['kind']}{('·' + e['where']) if e['where'] else ''}：{e['text']}"
                           for e in evidence) or "（没有）",
        changes="\n".join(f"- {_date(c['time']).isoformat()} {c['op']} {c.get('sec', '')}：{c.get('text') or c.get('old', '')}"
                          for c in changes) or "（没有）",
        allowed="\n".join(allowed),
        totals="、".join(f"{sec} {_sec_chars(db, sec)}/{cfg['secChars'][sec]} 字" for sec in (*GROW_SECS, *FREE_SECS)
                        if cfg["secChars"].get(sec)),
        sizes=_sizes(cfg["itemChars"]), notice_chars=int(cfg["noticeChars"]))


def evolve(complete, now: float | None = None, bot: str = "鱼妹", dry_run: bool = False) -> dict:
    """The nightly look: ask the model for small changes, keep only what the rules allow."""
    now = now or time.time()
    cfg = _cfg()
    with LOCK:
        db = _load()
    if not cfg["enabled"] or not db.get("items"):
        return {"ok": True, "skipped": "没开或还没导入"}
    evidence = _evidence(cfg, now)
    prompt = build_prompt(db, evidence, cfg, now, bot)
    if not prompt:
        return {"ok": True, "skipped": "这次没有能改的"}
    ops = _parse_ops(complete(prompt))
    with LOCK:
        db = _load()
        before = [dict(it) for it in db["items"]]
        applied, rejected = apply_ops(db, ops, evidence, cfg, now)
        for op, why in rejected:
            print(f"[成长] 没采用 {json.dumps(op, ensure_ascii=False)[:160]}：{why}", flush=True)
        for c in applied:
            print(f"[成长] {c['op']} {c['sec']}：{c.get('old', '')} → {c.get('text', '')}（{c.get('why', '')}）", flush=True)
        if applied and not dry_run:
            db.setdefault("versions", []).insert(0, {"time": now, "items": before})
            del db["versions"][int(cfg["versions"]):]
            db.setdefault("changes", []).extend({"time": now, **c} for c in applied)
            db["changes"] = db["changes"][-300:]
        if not dry_run:
            db["reviewed"] = now
            save_json(PATH, db)
    return {"ok": True, "applied": applied, "rejected": [[op, why] for op, why in rejected], "dryRun": dry_run}
