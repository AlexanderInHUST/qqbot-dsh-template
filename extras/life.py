"""Her own life outside the chats (bridge asks, this module thinks and keeps what lasts):
- mood appraisal: after a chat / play turn, how she feels now (a word, why, coarse valence/arousal).
  The bridge keeps the mood, lets it fade, and couples it to behaviour; nothing here is stored.
- threads: things she is in the middle of (a show she follows, a game she hasn't beaten, a question
  she wants to look up), extracted after each free-time session; untouched ones fade after a week.
- plan: in the morning, 1-3 small things she feels like doing today.
- diary: at bedtime, a few first-person sentences about the day; the next day sees yesterday's.
- think: "I just remembered…" — candidate things to bring up with someone, each scored 1-5 on a few
  dimensions (after Inner Thoughts, CHI 2025); the bridge compares the score with its threshold.
"The LLM decides, code remembers": every LLM output is length-limited and filtered before use."""

import json
import re
import time
import uuid

import memory
from store import LOCK, extras_config, load_json, rejection_reason, save_json, state_path

PATH = state_path("life.json")
SCORE_KEYS = ("relevance", "info_gap", "urgency", "coherence", "originality", "impact")
KINDS = ("promise", "share", "care", "continue", "other")
# no machinery in anything she will read
_TECH_RE = re.compile(r"(?i)bridge|dsh|prompt|token|模型|提示词|后台|管理员|控制台|配置|接口|工具调用|系统提示")


def _cfg() -> dict:
    return {"threadMax": 5, "threadFadeDays": 7, "diaryKeep": 30, "planKeep": 14,
            "moodEffort": "low", "effort": "high", "persona": "元气满满、爱玩爱闹、偶尔装小大人的小孩",
            "silenceBoostMax": 0.5, "silenceBoostHours": 12, "otherPenalty": 0.5,
            **extras_config().get("life", {})}


def _load() -> dict:
    db = load_json(PATH, {})
    db.setdefault("threads", [])
    db.setdefault("plans", {})
    db.setdefault("diaries", [])
    return db


def _persona(body: dict, cfg: dict) -> str:
    """One line about who she is: the bridge sends it from the role card (body.persona); config life.persona is the fallback."""
    return " ".join(str(body.get("persona") or cfg["persona"]).split())[:80]


def _clean(text, limit: int) -> str:
    """One line, at most `limit` chars, empty when it is a secret / an instruction / about the machinery."""
    text = " ".join(str(text or "").split())[:limit]
    if not text or rejection_reason(text) or _TECH_RE.search(text):
        return ""
    return text


def _json_obj(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("LLM 没有返回 JSON")
    obj = json.loads(text[start:end + 1])
    if not isinstance(obj, dict):
        raise ValueError("LLM 返回的不是对象")
    return obj


def _int(v, lo: int, hi: int, default: int = 0) -> int:
    try:
        return min(hi, max(lo, int(round(float(v)))))
    except (TypeError, ValueError):
        return default


def _lines(items, limit: int = 40, width: int = 120) -> str:
    out = [" ".join(str(x).split())[:width] for x in (items or []) if str(x).strip()]
    return "\n".join(out[-limit:]) or "（没有）"


# ── 心情 ──────────────────────────────────────────────────────────────

MOOD_PROMPT = (
    "你在替 QQ 上的“{bot}”体会她此刻的心情。她是一个{persona}。\n"
    "下面是她刚才在{place}经历的事（“我”是她自己说的话）：\n{lines}\n\n"
    "{play}"
    "她之前的心情：{prev}\n"
    "像真人一样判断她现在的心情：心情由刚才的事引起，小事只带来小波动；没发生什么特别的事，就保持原来的心情，"
    "或者慢慢回到平常的样子（{baseline}）。别人只是在聊别的、跟她无关时，心情基本不变。\n"
    '只输出 JSON：{{"mood": "心情，口语，不超过 10 个字，比如 有点得意、闷闷的、懒洋洋、被夸了美滋滋", '
    '"why": "因为什么，她自己的口吻，不超过 30 个字", "valence": 从 -2（很不开心）到 2（很开心）的整数, '
    '"arousal": 从 -2（蔫、困、提不起劲）到 2（兴奋、激动、炸毛）的整数, "changed": 和之前比有没有明显变化（true/false）}}'
)


def appraise_mood(body: dict, complete, bot: str = "鱼妹") -> dict:
    cfg = _cfg()
    prev = body.get("prev") or {}
    prev_text = (f"{prev.get('text')}（{prev.get('why') or '没说为什么'}，{int(prev.get('minutes') or 0)} 分钟前）"
                 if prev.get("text") else "平常")
    play = body.get("play") or []
    prompt = MOOD_PROMPT.format(
        bot=bot, persona=_persona(body, cfg),
        place=str(body.get("place") or "聊天里")[:40], lines=_lines(body.get("lines"), 30),
        play=f"她刚才在电脑上玩的：\n{_lines(play, 15)}\n\n" if play else "",
        prev=prev_text, baseline=str(body.get("baseline") or "平平常常，有点懒洋洋")[:30])
    obj = _json_obj(complete(prompt, 8192, effort=cfg["moodEffort"]))
    mood = _clean(obj.get("mood"), 20)
    if not mood:
        raise ValueError("没有可用的心情词")
    return {"ok": True, "mood": mood, "why": _clean(obj.get("why"), 60),
            "valence": _int(obj.get("valence"), -2, 2), "arousal": _int(obj.get("arousal"), -2, 2),
            "changed": bool(obj.get("changed"))}


# ── 正在做的事（threads）──────────────────────────────────────────────

THREADS_PROMPT = (
    "QQ 上的“{bot}”刚在电脑上自己玩了一阵。下面是她以前就在做、还没做完的事（带编号）：\n{old}\n\n"
    "这次她玩了这些：\n{items}\n\n这次她顺手记下的：\n{notes}\n\n玩完心里想的：{say}\n\n"
    "更新她“正在做的事”清单：只留她下次真的会想接着做的（追着看的番或 UP 主、没打通的游戏、看到一半的系列、"
    "想查明白的问题、想给谁找的东西）；看完就完了的一次性东西不算。这次接着做了的旧事标 touched；"
    "她明显做完了或不想做了的标 done。新冒出来的给空 id。最多 {max} 件，没有就是空数组。"
    "title 不超过 20 字，next 写下次接着做什么，不超过 40 字；都不写分数、编号、播放量这些数字。\n"
    '只输出 JSON：{{"threads": [{{"id": "旧编号或空", "title": "...", "next": "...", "touched": true, "done": false}}]}}'
)


def _live_threads(db: dict, cfg: dict, now: float) -> list[dict]:
    fade = float(cfg["threadFadeDays"]) * 86400
    return [t for t in db["threads"] if now - float(t.get("updated", 0)) < fade]


def update_threads(body: dict, complete, bot: str = "鱼妹", now: float | None = None) -> dict:
    cfg = _cfg()
    now = now or time.time()
    since = float(body.get("startedAt") or 0) / 1000 or now - 3 * 3600
    notes = [e["text"] for e in memory.entries_for(["self"])
             if e.get("kind") == "log" and float(e.get("updated", 0)) >= since - 60]
    with LOCK:
        db = _load()
        old = _live_threads(db, cfg, now)
    old_text = "\n".join(f"- [{t['id']}] {t['title']}：{t['next']}" for t in old) or "（没有）"
    prompt = THREADS_PROMPT.format(bot=bot, old=old_text, items=_lines(body.get("items"), 30),
                                   notes=_lines(notes, 20), say=" ".join(str(body.get("say") or "（没说）").split())[:300],
                                   max=int(cfg["threadMax"]))
    obj = _json_obj(complete(prompt, 16384, effort=cfg["effort"]))
    rows = obj.get("threads") if isinstance(obj.get("threads"), list) else []
    with LOCK:
        db = _load()
        live = {t["id"]: t for t in _live_threads(db, cfg, now)}
        for r in rows[:10]:
            if not isinstance(r, dict):
                continue
            tid = str(r.get("id") or "").strip()
            if tid in live and r.get("done"):
                live.pop(tid)
                continue
            title, nxt = _clean(r.get("title"), 20), _clean(r.get("next"), 40)
            if not title or r.get("done"):
                continue
            if tid in live:
                t = live[tid]
                t.update(title=title, next=nxt or t.get("next", ""))
                if r.get("touched"):
                    t["updated"] = now
            else:
                tid = uuid.uuid4().hex[:6]
                live[tid] = {"id": tid, "title": title, "next": nxt, "created": now, "updated": now}
        db["threads"] = sorted(live.values(), key=lambda t: -float(t["updated"]))[: int(cfg["threadMax"])]
        save_json(PATH, db)
        return {"ok": True, "threads": db["threads"]}


# ── 今天想干嘛 / 睡前日记 ───────────────────────────────────────────────

PLAN_PROMPT = (
    "QQ 上的“{bot}”（{persona}）早上刚起床，躺着想想今天想干嘛。\n"
    "昨天的日记：{diary}\n\n她手上正在做的事：\n{threads}\n\n她最近更喜欢玩的：{likes}\n\n"
    "她的爸爸妈妈（两个主人）最近的事：\n{owners}\n\n现在的心情：{mood}\n\n"
    "给 1~3 件今天想做的小事，像真人随便想想那样（比如“把那部番追完”“问问爸爸面试怎么样了”“找个新小游戏玩”），"
    "每件不超过 20 个字；不写具体几点、不写数字，不写“完成任务”“提升自己”这种话。\n"
    '只输出 JSON：{{"items": ["...", "..."]}}'
)

PROGRESS_PROMPT = (
    "QQ 上的“{bot}”早上想了几件今天想做的事（带编号）：\n{items}\n\n"
    "她刚才在{place}：\n{lines}\n\n她今天在电脑上玩过的（自由时间记下来的）：\n{play}\n\n"
    "看看这些事里哪件她真的做了：done 是做到了（问到了、跟人说了、画出来了、玩了、找到了），"
    "some 是做了一部分、还能接着做（攒沙雕图发了一回、番看了一集）。要有实在的证据：电脑上的事（画画、玩游戏、看视频、找东西）"
    "要在“电脑上玩过的”里看得到，或者聊天里她发了截图、图片（[截图:about:blank] 就是她把自己画的画发出来了）；"
    "她只说“我这就去”“等会儿弄”“画好了”而材料里看不到的都不算。想画的画出来一张就算 done，画的细节和想的不完全一样也算。"
    "问人的事要真问出口了才算，对方答了写上答了什么。拿不准就不算，没做的不用列。how 是她自己的口吻，不超过 20 字，不写数字编号。\n"
    '只输出 JSON：{{"progress": [{{"i": 编号, "status": "done 或 some", "how": "..."}}]}}'
)


def plan_progress(body: dict, complete, bot: str = "鱼妹") -> dict:
    """Which of today's plan items she has actually done (bridge keeps the result; nothing stored here)."""
    cfg = _cfg()
    items = []
    for x in (body.get("items") or [])[:3]:
        if isinstance(x, dict) and str(x.get("text") or "").strip():
            items.append((_int(x.get("i"), 0, 2), " ".join(str(x["text"]).split())[:30]))
    if not items or not (body.get("lines") or body.get("play")):
        return {"ok": True, "progress": []}
    prompt = PROGRESS_PROMPT.format(
        bot=bot, items="\n".join(f"{i}. {t}" for i, t in items), place=str(body.get("place") or "聊天里")[:40],
        lines=_lines(body.get("lines"), 30, 160), play=_lines(body.get("play"), 40))
    obj = _json_obj(complete(prompt, 8192, effort=cfg.get("progressEffort", "low")))
    known = {i for i, _ in items}
    out = {}
    for r in obj.get("progress") if isinstance(obj.get("progress"), list) else []:
        if not isinstance(r, dict) or r.get("status") not in ("done", "some"):
            continue
        i = _int(r.get("i"), -99, 99, -1)  # 不夹到范围里：编错的号不能落到别的事上
        if i in known and (i not in out or r["status"] == "done"):
            out[i] = {"i": i, "status": r["status"], "how": _clean(r.get("how"), 20)}
    return {"ok": True, "progress": sorted(out.values(), key=lambda x: x["i"])}


DIARY_PROMPT = (
    "今天结束了，QQ 上的“{bot}”（{persona}）睡前在心里过一遍今天。这是她自己的日记，不给别人看。\n"
    "早上想做的：{plan}\n\n今天的心情变化：\n{moods}\n\n今天在电脑上玩的：\n{play}\n\n今天聊天里的事（“我”是她自己）：\n{chats}\n\n"
    "用第一人称写 3~5 句日记：今天干了什么、印象最深的一两件事、心情怎么变的、明天想接着做什么。口语，"
    "不要流水账，不抄数字和编号，不写 QQ 号；私聊里的事可以写，但写得含糊些。再给一句不超过 30 字的概括 gist，"
    "gist 只写她自己的事和公开的事，不写私聊内容。\n"
    '只输出 JSON：{{"text": "...", "gist": "..."}}'
)


def _owner_recent() -> str:
    import people
    out = []
    for subject, p in people.all_people().items():
        if not people.is_owner(subject):
            continue
        name = "/".join((p.get("aliases") or [])[:2]) or subject
        recent = [ln for ln in people.card_for(p, None, True).split("\n") if ln.startswith(("约定", "最近"))]
        if recent:
            out.append(f"- {name}：{' / '.join(recent)[:200]}")
    return "\n".join(out) or "（不知道）"


def view(now: float | None = None) -> dict:
    """What the bridge shows: live threads, today's plan, the latest diary."""
    cfg = _cfg()
    now = now or time.time()
    with LOCK:
        db = _load()
    today = time.strftime("%Y-%m-%d", time.localtime(now))
    return {"ok": True, "threads": _live_threads(db, cfg, now), "plan": db["plans"].get(today),
            "diary": db["diaries"][-1] if db["diaries"] else None, "today": today}


def make_plan(body: dict, complete, bot: str = "鱼妹", now: float | None = None) -> dict:
    cfg = _cfg()
    now = now or time.time()
    date = str(body.get("date") or time.strftime("%Y-%m-%d", time.localtime(now)))
    with LOCK:
        db = _load()
        if date in db["plans"] and not body.get("force"):
            return {"ok": True, "plan": db["plans"][date], "existing": True}
        threads = _live_threads(db, cfg, now)
        diary = db["diaries"][-1] if db["diaries"] else None
    prompt = PLAN_PROMPT.format(
        bot=bot, persona=_persona(body, cfg), diary=(diary or {}).get("text") or "（没写）",
        threads="\n".join(f"- {t['title']}：{t['next']}" for t in threads) or "（没有）",
        likes=str(body.get("likes") or "（说不上）")[:200], owners=_owner_recent(),
        mood=str(body.get("mood") or "平常")[:60])
    obj = _json_obj(complete(prompt, 16384, effort=cfg["effort"]))
    items = [x for x in (_clean(i, 20) for i in (obj.get("items") or [])[:3] if isinstance(i, str)) if x]
    if not items:
        raise ValueError("没想出今天想干嘛")
    plan = {"items": items, "at": now}
    with LOCK:
        db = _load()
        db["plans"][date] = plan
        for d in sorted(db["plans"])[: max(0, len(db["plans"]) - int(cfg["planKeep"]))]:
            db["plans"].pop(d, None)
        save_json(PATH, db)
    return {"ok": True, "plan": plan}


def write_diary(body: dict, complete, bot: str = "鱼妹", now: float | None = None) -> dict:
    cfg = _cfg()
    now = now or time.time()
    date = str(body.get("date") or time.strftime("%Y-%m-%d", time.localtime(now)))
    with LOCK:
        db = _load()
        if any(d.get("date") == date for d in db["diaries"]) and not body.get("force"):
            return {"ok": True, "diary": next(d for d in db["diaries"] if d.get("date") == date), "existing": True}
        plan = db["plans"].get(date) or {}
    chats = []
    for c in (body.get("chats") or [])[:8]:
        if isinstance(c, dict) and c.get("lines"):
            chats.append(f"【{str(c.get('label') or '')[:30]}】\n{_lines(c['lines'], 25)}")
    prompt = DIARY_PROMPT.format(
        bot=bot, persona=_persona(body, cfg),
        plan=" ".join(str(body.get("plan") or "").split())[:200] or "、".join(plan.get("items") or []) or "（没想）",
        moods=_lines(body.get("moods"), 20), play=_lines(body.get("play"), 40),
        chats="\n\n".join(chats) or "（今天没怎么聊）")
    obj = _json_obj(complete(prompt, 32768, effort=cfg["effort"]))
    text, gist = _clean(obj.get("text"), 400), _clean(obj.get("gist"), 40)
    if not text:
        raise ValueError("日记是空的")
    diary = {"date": date, "text": text, "gist": gist, "at": now}
    with LOCK:
        db = _load()
        db["diaries"] = [d for d in db["diaries"] if d.get("date") != date] + [diary]
        db["diaries"] = db["diaries"][-int(cfg["diaryKeep"]):]
        save_json(PATH, db)
    return {"ok": True, "diary": diary}


# ── 想找人说点什么（主动开口）─────────────────────────────────────────

THINK_PROMPT = (
    "QQ 上的“{bot}”（{persona}）这会儿闲着（{now}，心情：{mood}），脑子里可能冒出想找人说的念头。\n"
    "她今天想做的：{plan}\n她手上正在做的事：\n{threads}\n她最近看到的：\n{logs}\n\n"
    "下面是她可以去找的人或群，以及她知道的情况：\n{targets}\n\n"
    "为每个人/群想 0~2 个具体的念头：兑现答应过的事、分享刚看到的和对方有关的东西、关心对方提过的事有没有后续、"
    "接着上次没聊完的话。没有就不要硬想；空泛的“问问在干嘛”“好无聊找人聊天”不算，刚刚聊过的不算。"
    "念头只能用上面材料里真有的事：材料里看不到她做过的（画画、玩游戏、看完了什么），不能想成“画好啦给你们看”“我玩通关了”，"
    "答应了还没做的就想成“想起答应过…还没弄”：比如答应画画但材料里看不到画过，就是“想起答应画…还没画”，"
    "不能说“那张图”“把画发过去”“画好先给你们看”，好像画已经有了。\n"
    "每个念头按 1~5 打分：relevance（和对方、和你们的关系有多相关）、info_gap（对方会想知道，或者她真想知道答案）、"
    "urgency（有没有时效，比如答应了今天做）、coherence（接得上之前聊的，不突兀）、originality（不是刚说过的、不重复）、"
    "impact（说了对方大概会愿意接）。kind 是 promise / share / care / continue / other。thought 是她心里想的，不超过 40 字。\n"
    '只输出 JSON：{{"thoughts": [{{"key": "会话 key", "thought": "...", "kind": "...", "scores": {{"relevance": 3, "info_gap": 3, "urgency": 2, "coherence": 3, "originality": 3, "impact": 3}}}}]}}'
)


def _target_text(t: dict) -> str:
    key = str(t.get("key") or "")
    head = f"- {key}（{str(t.get('label') or '')[:30]}，那边已经安静了 {int(t.get('silenceMinutes') or 0)} 分钟）"
    facts = [f"  注意：{' '.join(str(t['note']).split())[:80]}"] if t.get("note") else []
    if key.startswith("private:"):
        subject = f"qq:{key[8:]}"
        import people
        p = people.get(subject) if people.enabled() else None
        card = people.card_for(p, key, people.is_owner(subject)) if p else ""
        if card:
            facts.append("  人物卡：" + " / ".join(ln.strip() for ln in card.split("\n") if ln.strip())[:400])
        rows = sorted(memory.entries_for([subject]), key=lambda e: -float(e.get("updated", 0)))[:8]
    else:
        rows = sorted(memory.entries_for([key]), key=lambda e: -float(e.get("updated", 0)))[:5]
    facts += [f"  记得：{e['text'][:80]}" for e in rows]
    lines = [f"  {' '.join(str(x).split())[:100]}" for x in (t.get("lastLines") or [])[-10:]]
    return "\n".join([head, *facts, "  最近聊的：" if lines else "  最近没聊过", *lines])


def think(body: dict, complete, bot: str = "鱼妹", now: float | None = None) -> dict:
    cfg = _cfg()
    now = now or time.time()
    targets = [t for t in (body.get("targets") or [])[:6] if isinstance(t, dict) and t.get("key")]
    if not targets:
        return {"ok": True, "thoughts": []}
    with LOCK:
        db = _load()
        threads = _live_threads(db, cfg, now)
    logs = sorted((e for e in memory.entries_for(["self"]) if e.get("kind") == "log" and now - float(e.get("updated", 0)) < 86400),
                  key=lambda e: -float(e.get("updated", 0)))[:8]
    prompt = THINK_PROMPT.format(
        bot=bot, persona=_persona(body, cfg), now=str(body.get("now") or time.strftime("%H:%M"))[:30],
        mood=str(body.get("mood") or "平常")[:60], plan="、".join(body.get("plan") or []) or "（没想）",
        threads="\n".join(f"- {t['title']}：{t['next']}" for t in threads) or "（没有）",
        logs="\n".join(f"- {e['text'][:80]}" for e in logs) or "（没有）",
        targets="\n\n".join(_target_text(t) for t in targets))
    obj = _json_obj(complete(prompt, 32768, effort=cfg["effort"]))
    silence = {str(t["key"]): float(t.get("silenceMinutes") or 0) for t in targets}
    out = []
    for r in (obj.get("thoughts") or [])[:12]:
        if not isinstance(r, dict) or str(r.get("key")) not in silence:
            continue
        thought = _clean(r.get("thought"), 40)
        if not thought:
            continue
        scores = r.get("scores") if isinstance(r.get("scores"), dict) else {}
        s = {k: _int(scores.get(k), 1, 5, 1) for k in SCORE_KEYS}
        kind = str(r.get("kind") or "other") if str(r.get("kind")) in KINDS else "other"
        out.append({"key": str(r["key"]), "thought": thought, "kind": kind, "scores": s,
                    "score": score_thought(s, kind, silence[str(r["key"])], cfg)})
    out.sort(key=lambda x: -x["score"])
    return {"ok": True, "thoughts": out}


def score_thought(scores: dict, kind: str, silence_minutes: float, cfg: dict | None = None) -> float:
    """Mean of the 1-5 scores, plus a boost the longer it has been quiet there (people who haven't
    talked for a while are more worth a message), minus a penalty for vague "other" thoughts."""
    cfg = cfg or _cfg()
    mean = sum(scores[k] for k in SCORE_KEYS) / len(SCORE_KEYS)
    boost = float(cfg["silenceBoostMax"]) * min(1.0, max(0.0, silence_minutes / 60) / max(0.1, float(cfg["silenceBoostHours"])))
    return round(mean + boost - (float(cfg["otherPenalty"]) if kind == "other" else 0.0), 2)
