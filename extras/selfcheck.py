"""Does what she just said about herself match what she knows (bridge asks after each batch she sends)?
- claims: the concrete things she said about herself today (ate, slept, played, watched, about to do),
  short and neutral, so every chat window can see them and stay consistent;
- conflicts: things that contradict her recorded state, what she can see elsewhere, or what she said earlier;
- promises: promises she has no way to keep (she only sees messages when woken; she cannot watch anyone).
Conservative on purpose: when unsure it is not a conflict. Nothing is stored here; the bridge keeps the claims.
Ideas from dialogue NLI / DECODE (contradiction against one's own earlier turns) and chain-of-verification;
the prompt and code are our own."""

import re

import life
from store import extras_config

PROMPT = (
    "你在帮 QQ 上的“{bot}”核对她刚说的话有没有前后矛盾。她是一个{persona}，人设是住在电脑里的一条小鱼，"
    "有自己的电脑（看视频、刷网页、玩小游戏），同时在几个 QQ 聊天窗口里和人聊天。现在 {now}，她在{place}。\n\n"
    "【她此刻的真实状态】这是记下来的事实，比她自己说的准：\n{facts}\n\n"
    "【别的窗口里的事】她在那边看到过、说过的，她知道这些：\n{elsewhere}\n\n"
    "【她今天之前说过的自己的事】\n{claims}\n\n"
    "【她记着的提醒】\n{reminders}\n\n"
    "【这里最近的聊天】（“我”是她）\n{context}\n\n"
    "【她刚发的话】\n{said}\n\n"
    "做三件事：\n"
    "1. claims：从“她刚发的话”里抽出她对自己今天的具体陈述：吃没吃、睡没睡、醒没醒、在不在玩、玩过/看过什么、"
    "正在做什么、待会儿打算做什么。每条不超过 20 字，省掉主语，不写别人的名字和称呼（“跟爸爸说了晚安”写成“说了晚安”），"
    "不写数字分数。玩笑、比喻、人设上的想象（“我是海里的鱼，吃水草”“我只吃小饼干”）、问别人的话、评价别人的话都不算。没有就是空数组。\n"
    "2. conflicts：她刚说的自己的事，和【她此刻的真实状态】、或和她今天之前说过的（包括这里最近聊天里她自己说的）明显对不上的。"
    "比如状态里写着今天玩了 5 回、上午下午晚上都有，她说“就晚上玩了一阵”；她刚说过吃完了，又说还没吃。"
    "吃饭、午睡这类状态里没记的事，只和她自己之前说的比，之前没说过就不算矛盾。她转述别人的话、别人的事，"
    "只有材料里明明白白写着相反的才算，材料里找不到不算。说法不同但意思能对上的不算（“刷了几个视频”对上看过视频；"
    "“刚起”对上一小时前起床）。truth 用“你”称呼她，一句话写清实际是怎样，不提“记录”“状态”“材料”这些词。\n"
    "3. promises：她刚答应的事里，她根本做不到的。她只在被叫醒的时候才看得到消息，看不到别人在别处做了什么，"
    "没法一直盯着谁，也不会自己知道别人什么时候睡了、走了、回来了；除非【她记着的提醒】里有等那个人说话的提醒。"
    "“待会儿/明天再弄”这种定时的、有提醒的、靠别人来找她的都不算；跟正在聊的人说“等你回来/下班/有空了我给你看”也不算，"
    "对方回来自然会来找她。why 一句话说为什么做不到。\n"
    "先弄清每句话说的是谁：她接别人话时常省主语（别人说“我不玩了”，她回“那就不玩啦”“累一天了”，说的是对方），这种不算她自己的事。"
    "conflicts 和 promises 只挑“她刚发的话”里的句子，这里最近聊天里她以前说过的不要再挑。\n"
    "拿不准就不算：宁可漏掉，不要冤枉她。只管她自己说的话，别人说错了不管。\n"
    '只输出 JSON：{{"claims": ["..."], "conflicts": [{{"said": "她的原话片段", "truth": "..."}}], '
    '"promises": [{{"said": "她的原话片段", "why": "..."}}]}}'
)


def _block(items, limit: int, width: int = 160) -> str:
    return life._lines(items, limit, width)


_PUNCT = re.compile(r"[\s，,。.！!？?、~～…\"“”'‘’：:；;（）()]+")


def _in_said(fragment: str, said: list) -> bool:
    """模型挑出来的原话片段确实在这一批里（它有时把聊天里她以前说的又挑一遍）。"""
    f = _PUNCT.sub("", fragment)
    whole = _PUNCT.sub("", "".join(said))
    if not f:
        return False
    if f in whole:
        return True
    grams = {f[i:i + 2] for i in range(len(f) - 1)}
    return bool(grams) and sum(g in whole for g in grams) / len(grams) >= 0.7


def check(body: dict, complete, bot: str = "鱼妹") -> dict:
    cfg = {**life._cfg(), "selfCheckEffort": "low", **(extras_config().get("selfCheck") or {})}
    said = [str(x) for x in (body.get("said") or []) if str(x).strip()][:12]
    if not said:
        return {"ok": True, "claims": [], "conflicts": [], "promises": []}
    claims = body.get("claims") or []
    claim_lines = [f"{c.get('time', '')} 在{c.get('where', '')}：{c.get('text', '')}" for c in claims if isinstance(c, dict)]
    prompt = PROMPT.format(
        bot=bot, persona=life._persona(body, cfg),
        now=str(body.get("now") or "")[:10], place=str(body.get("place") or "聊天里")[:40],
        facts=_block(body.get("facts"), 30, 400),
        elsewhere=(str(body.get("elsewhere") or "").strip()[:4000] or "（没有）"),
        claims=_block(claim_lines, 30), reminders=_block(body.get("reminders"), 10),
        context=_block(body.get("context"), 30), said=_block(said, 12, 200))
    obj = life._json_obj(complete(prompt, 16384, effort=cfg["selfCheckEffort"]))
    out_claims = []
    for c in obj.get("claims") if isinstance(obj.get("claims"), list) else []:
        text = life._clean(c, 40)
        if text and text not in out_claims:
            out_claims.append(text)
    conflicts = []
    for c in obj.get("conflicts") if isinstance(obj.get("conflicts"), list) else []:
        if not isinstance(c, dict):
            continue
        s, t = life._clean(c.get("said"), 40), life._clean(c.get("truth"), 80)
        if s and t and _in_said(s, said):
            conflicts.append({"said": s, "truth": t})
    promises = []
    for c in obj.get("promises") if isinstance(obj.get("promises"), list) else []:
        if not isinstance(c, dict):
            continue
        s, w = life._clean(c.get("said"), 40), life._clean(c.get("why"), 80)
        if s and w and _in_said(s, said):
            promises.append({"said": s, "why": w})
    # 说岔了的那句不当成她的事记下来（不然别的窗口照着错的说）
    out_claims = [c for c in out_claims if not any(_in_said(c, [x["said"]]) for x in conflicts)]
    return {"ok": True, "claims": out_claims[:8], "conflicts": conflicts[:3], "promises": promises[:3]}
