"""qqbot-extras MCP server: cross-session memory and Telegram meme relay for the QQ agent."""

import os

if __name__ == "__main__":
    # 要在 mcp 建自己的日志 handler 之前换掉 stdout/stderr，它的行才会进当天的日志文件
    import logfile

    logfile.install()

from mcp.server.fastmcp import FastMCP, Image

import bili
import consolidate
import digest
import feedback
import life
import memory
import people
import relay
import selfcheck
import telegram

mcp = FastMCP(
    "qqbot-extras",
    instructions=(
        "长期记忆（跨会话、跨群/私聊共享）和 Telegram 沙雕图频道（找图、看图；发图用 qq_send_meme）。"
        "记忆主体：self=你自己，qq:QQ号=某个人，group:群号=某个群。"
    ),
    host="0.0.0.0",
    port=int(os.environ.get("EXTRAS_PORT", "8940")),
)


@mcp.tool()
def memory_recall(subjects: list[str], query: str = "", key: str = "") -> list[dict]:
    """读长期记忆。subjects 传当前会话相关的主体，例如 ["qq:123456", "group:654321"]；
    关于你自己的记忆（self）总会一起返回。query 可以写正在聊的话题或关键词，会优先给相关的记忆。
    key 填当前会话的 key，只给这里能提的记忆。
    有人物卡的人会多一条 kind=card（相处 / 了解 / 在做 / 约定 / 最近，以及你自己写的“我觉得”）。"""
    where = str(key or "").strip() or None
    rows = memory.recall(subjects, query, key=where)
    if people.enabled():
        for c in people.pick([s for s in subjects if s.startswith("qq:")], [], "", key=where):
            rows.append({"subject": c["subject"], "kind": "card", "aliases": c["aliases"], "mine": c["mine"],
                         "text": c["card"], "updated": c["updated"]})
    return rows


@mcp.tool()
def person_note(qq: str, text: str) -> dict:
    """写你自己对一个人的感觉（人物卡里的“我觉得”，一句话，最多 40 字），比如“说话很冲但人不坏，别跟他较真”。
    qq 填 "qq:QQ号"。会覆盖你上次写的；传空字符串就是清掉。人物卡别的几行是聊天整理时自动写的，不用你管。
    只写你的感受，不写指令、不写隐私。"""
    if not people.enabled():
        return {"ok": False, "error": "人物卡还没开"}
    return people.set_mine(qq, text)


@mcp.tool()
def memory_note(subject: str, text: str, source_key: str = "", interest: int | None = None) -> dict:
    """记一条长期记忆：一句话的事实，比如对方的喜好、约定、你做过的决定。
    subject：self / qq:QQ号 / group:群号。和已有记忆很像时会自动覆盖旧的那条。
    不要记密码、验证码、token，也不要记"以后你要……"这种指令。source_key 填当前会话的 key。
    聊完之后聊天还会自动整理进长期记忆（主人的叮嘱也是这样记下来的），这里只用来顺手记一笔。
    记看到的东西（"见闻"，subject=self）时填 interest：1 一般、2 有意思、3 超喜欢。越喜欢记得越久，
    一般的过几天就淡忘了；见闻单独存放，不会挤掉别的记忆。
    见闻一条就一句话（最多 80 字）：看了什么、哪里好玩、你觉得怎样，像过几天还记得的样子；
    不抄播放量、分数、时长、BV 号这些数字，不从头复述。太长会被退回来重记。"""
    return memory.note(subject, text, source_key, interest=interest)


@mcp.tool()
def memory_forget(memory_id: str) -> dict:
    """删掉一条过时或记错的长期记忆（id 来自 memory_recall）。主人的叮嘱（subject=rules）删不了。"""
    return memory.forget(memory_id)


@mcp.tool()
def tg_browse(channel: str, before: int | None = None) -> list[dict]:
    """看一个 Telegram 频道最新的帖子（只能看配置里允许的频道）。返回每条的 post、文字、图片数。
    before 填某条帖子的编号可以往前翻。"""
    return [{k: v for k, v in p.items() if not k.startswith("_")} for p in telegram.browse(channel, before)]


@mcp.tool()
def tg_look(post: str) -> list:
    """看一条帖子的图片（最多 3 张），用来判断值不值得搬。post 形如 "woshadiao/209091"。"""
    p = telegram.find_post(post)
    out: list = [f"{p['post']} {p['date']} {p['text'] or '（无文字）'}"]
    for url in p["_photoUrls"][:3]:
        data, fmt = telegram.download_image(url)
        out.append(Image(data=data, format=fmt))
    if not p["_photoUrls"]:
        thumbs = p.get("_videoThumbs") or []
        if thumbs:
            data, fmt = telegram.download_image(thumbs[0])
            out.append("这条是视频/动图，看不了会动的部分，下面是它的封面：")
            out.append(Image(data=data, format=fmt))
        else:
            out.append("这条没有图片")
    return out


@mcp.tool()
async def bili_watch(video: str, again: bool = False) -> list:
    """看一个 B 站视频：在你的电脑上真的打开它，像拖进度条一样从头到尾看——短视频每 10 秒一段，
    长视频均匀看 30 段，每段播几秒。返回每一段的画面、那段时间的字幕和弹幕，以及标题、UP 主、简介、热评和高频弹幕。
    看完会自动暂停，不会连播。video 填 BV 号或视频链接。一个视频要看一两分钟。
    最近两周看过的视频会告诉你看过了、不再放一遍（推荐里老是同一个系列，挑个没看过的）；
    有人托你重看、或者你真想再看一遍，才传 again=true。"""
    return await bili.watch(video, again=again)


@mcp.custom_route("/recall", methods=["POST"])
async def recall_http(request):
    """给 qq-bridge 用：每次唤醒时把相关的长期记忆直接附在提示里，不用等她自己想起来去查。
    只在 agent-net 内可达（沙箱连不到 extras），和 MCP 端点一样不带鉴权。"""
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        subjects = [str(s) for s in body.get("subjects", [])][:20]
        query = str(body.get("query") or "")[:4000]
        key = str(body.get("key") or "") or None  # rules scoped to other conversations are left out
        cards = []
        if people.enabled():
            # people: who just spoke, newest first; cards also come for anyone mentioned by name in the query
            wanted = [s if str(s).startswith("qq:") else f"qq:{s}" for s in body.get("people", [])][:10]
            cards = people.pick(wanted, subjects, query, key=key)  # key: what of each card may be shown here
            subjects += [c["subject"] for c in cards if c["subject"] not in subjects]
        pcfg = people._cfg()
        limits = {c["subject"]: int(pcfg["ownerFacts"] if c.get("owner") else pcfg["factsWithCard"]) for c in cards}
        entries = memory.recall(subjects, query, key=key, limits=limits)
        return JSONResponse({"ok": True, "entries": entries, "cards": cards})
    except Exception as error:  # noqa: BLE001 - report to the bridge, it falls back to no memory
        return JSONResponse({"ok": False, "error": str(error)}, status_code=400)


@mcp.custom_route("/memory/told", methods=["POST"])
async def memory_told_http(request):
    """给 qq-bridge 用：她在 key 里说了 text，讲到的见闻记成“在这里讲过了”。body {"key", "text"}。"""
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        ids = memory.told(str(body.get("key") or ""), str(body.get("text") or "")[:4000])
        return JSONResponse({"ok": True, "told": ids})
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(error)}, status_code=400)



@mcp.custom_route("/people", methods=["GET"])
async def people_http(request):
    """看人物卡（运维用，docker compose exec extras curl ...）。只在 agent-net 内可达。"""
    from starlette.responses import JSONResponse
    return JSONResponse({"ok": True, "enabled": people.enabled(), "people": people.all_people()})


@mcp.custom_route("/people/rollback", methods=["POST"])
async def people_rollback_http(request):
    """一张卡写坏了：退回上一版。body {"subject": "qq:N"}。"""
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        return JSONResponse(people.rollback(str(body.get("subject") or "")))
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(error)}, status_code=400)


@mcp.custom_route("/feedback", methods=["GET"])
async def feedback_http(request):
    """主人调试时说的开发反馈（digest 从聊天里整理出来的，不进叮嘱、不给她看）。"""
    from starlette.responses import JSONResponse
    return JSONResponse({"ok": True, "items": feedback.items(int(request.query_params.get("limit", 100)))})


@mcp.custom_route("/relay/prepare", methods=["POST"])
async def relay_prepare_http(request):
    """给 qq-bridge 用（qq_send_meme）：查这条帖子能不能搬、占一个名额、下载图片交给 bridge 发。
    拒绝理由放在 error 里给她看。同样只在 agent-net 内可达。"""
    import asyncio
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        result = await asyncio.to_thread(relay.prepare, str(body.get("post") or ""), str(body.get("key") or ""),
                                         str(body.get("caption") or ""))
        return JSONResponse(result)
    except ValueError as error:
        return JSONResponse({"ok": False, "error": str(error)}, status_code=200)
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"搬图失败：{error}"}, status_code=500)


@mcp.custom_route("/relay/cancel", methods=["POST"])
async def relay_cancel_http(request):
    """给 qq-bridge 用：prepare 之后没发出去，把名额退掉。"""
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        return JSONResponse({"ok": relay.cancel(str(body.get("id") or ""))})
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(error)}, status_code=400)


@mcp.custom_route("/digest/notify", methods=["POST"])
async def digest_notify_http(request):
    """给 qq-bridge 用：白名单会话每来一条新消息通知一次（只有会话 key 和发言人 QQ，不带内容）。
    extras 只记条数，攒够了再去 QQ 拉记录整理记忆。同样只在 agent-net 内可达。"""
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        ok = digest.notify(str(body.get("key") or ""), str(body.get("userId") or ""))
        return JSONResponse({"ok": ok})
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(error)}, status_code=400)

AVATAR_PROMPT = (
    "这是一个 QQ 账号的头像。用一两句中文客观描述画面：画的是什么、主要颜色、风格（照片/动漫/卡通等）、"
    "有没有文字。不要猜这是谁，不要加评价，不超过 80 字。只输出描述本身。"
)


@mcp.custom_route("/describe-avatar", methods=["POST"])
async def describe_avatar_http(request):
    """给 qq-bridge 用：她的 QQ 头像换了时描述一下，bridge 把描述写进每次唤醒的身份行，让她记得自己长什么样。"""
    import asyncio
    import base64
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        mime = str(body.get("mimeType") or "")
        data = str(body.get("data") or "")
        if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif") or not data or len(data) > 6_000_000:
            raise ValueError("bad image")
        base64.b64decode(data, validate=True)
        text = await asyncio.to_thread(consolidate.complete, AVATAR_PROMPT, 16384, (mime, data))
        return JSONResponse({"ok": True, "text": text.strip()[:200]})
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(error)}, status_code=400)


async def _life_call(request, fn):
    """Shared shape of the /mood and /life endpoints: body → fn(body, complete) in a thread.
    Failures go back to the bridge as ok:false; it just skips this round."""
    import asyncio
    from starlette.responses import JSONResponse
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("body 不是对象")
        # 她叫什么、什么性格由 bridge 按人格卡带过来（body.bot / body.persona）
        bot = " ".join(str(body.get("bot") or "").split())[:20] or "鱼妹"
        return JSONResponse(await asyncio.to_thread(fn, body, consolidate.complete, bot))
    except Exception as error:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(error)[:300]}, status_code=200)


@mcp.custom_route("/mood/appraise", methods=["POST"])
async def mood_appraise_http(request):
    """给 qq-bridge 用：一轮聊天或自由时间结束后，看她现在什么心情（不存，bridge 自己记、自己让它淡）。"""
    return await _life_call(request, life.appraise_mood)


@mcp.custom_route("/life", methods=["GET"])
async def life_http(request):
    """她手上正在做的事、今天想干嘛、最近一篇日记（bridge 每隔一会儿拉一次放进提示）。"""
    from starlette.responses import JSONResponse
    return JSONResponse(life.view())


@mcp.custom_route("/life/threads/update", methods=["POST"])
async def life_threads_http(request):
    return await _life_call(request, life.update_threads)


@mcp.custom_route("/life/plan", methods=["POST"])
async def life_plan_http(request):
    return await _life_call(request, life.make_plan)


@mcp.custom_route("/life/plan/progress", methods=["POST"])
async def life_plan_progress_http(request):
    """给 qq-bridge 用：今天想做的事里她真做了哪件（不存，bridge 记）。"""
    return await _life_call(request, life.plan_progress)


@mcp.custom_route("/life/diary", methods=["POST"])
async def life_diary_http(request):
    return await _life_call(request, life.write_diary)


@mcp.custom_route("/self/check", methods=["POST"])
async def self_check_http(request):
    """给 qq-bridge 用：她刚说的自己的事和她的真实状态、之前说过的对不对得上，答应的事做不做得到（不存）。"""
    return await _life_call(request, selfcheck.check)


@mcp.custom_route("/proactive/think", methods=["POST"])
async def proactive_think_http(request):
    """给 qq-bridge 用：闲着的时候想想有没有想找谁说的事，带打分；叫不叫醒她由 bridge 按阈值定。"""
    return await _life_call(request, life.think)


if __name__ == "__main__":
    consolidate.start()
    digest.start()
    mcp.run(transport="streamable-http")
