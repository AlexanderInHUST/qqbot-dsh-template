# CLAUDE.md

QQ 群“仿真群友”鱼妹：QQ 小号（SnowLuma）+ qq-bridge 二代仿真模式（reserved2）+ DeepSeek Harness（DSH）+ 隔离沙箱浏览器。全部在 docker compose 里。用户界面语言是中文，回复用中文。

## 现状

这里写现在是什么样、开关在哪、日志怎么查。文中的 QQ 号、群号、名字（阿明、阿红、鱼妹……）都是示例，换成你自己的。下面没写前缀的配置键都在 config/qq-bridge/config.json 的 `socialV2` 下；“extras 的”指 config/extras.json。

### 账号、模型、环境

- 机器人 QQ 1000000000，昵称“鱼妹”，外号 `wake.selfAliases`（小鱼、🐟姐），外号和昵称一样算“叫她”。
- 主人（ownerQQ）900000001（阿明，提示里叫“爸爸”）。第二个主人 `extraOwnerQQ: [1600000002]`（阿红，`ownerTitles` 里叫“妈妈”），管理命令、审批、夜里叫醒、叮嘱整理都和主人一样（代码里用 `isOwnerId` / digest.owners），系统提示仍只私聊发给 ownerQQ。
- 白名单：两个主人的私聊；群 1100000001（小测试群，`homeGroups` 里唯一的“家里的群”）；群 800000002（大群）；群 1000000004（另一个大群，规矩和 800000002 一样）；群 1100000003（技术群）。家里以外的群（含以后新加的）都按大群处理：
  - 看不到私聊和家里群的内容；
  - 主人标记写“叫名字，不叫爸爸”（`ownerTitlesGroups: ["1100000001"]`）；
  - 人格卡 roles/鱼妹.md 规定私聊和小群叫爸爸妈妈，其他群叫阿明、阿红。
- `wake.otherBots: ["4000000009"]`：大群的小A，也是机器人。它带到她名字不算叫她，也不按接话叫；@ 或引用她照叫。
- 模型：DeepSeek 官方 `deepseek-official` / `deepseek-flash`，`reasoningEffort: high`，在 config.json 的 `dsh` 段，Key 是 .env 的 `DEEPSEEK_API_KEY`。extras 的记忆整理、头像描述、联网搜索也用它。
  - 配着、随时能切的：aiohub 的 `deepseek-v4.1-flash-1017`、`claude-sonnet-5-5`、`gemini-4-argon`（Key `AIOHUB_API_KEY`），Cloudflare 的 `@cf/deepseek-ai/deepseek-v4.1-flash-1017`（Key `CLOUDFLARE_API_TOKEN`）。
  - 都试过又切回来了：gemini 私聊约 30 秒、群里约 1.5 分钟；Cloudflare 17 万 token 的会话每步 4~11 秒（官方 1~2 秒）。
  - aiohub 的 qwen3.8-27b：窗口约 128k，没有前缀缓存。
  - 控制台的花费按 DeepSeek 价目表算，换了模型就不准。
- 跑在 Windows WSL2（迁移步骤见 docs/MIGRATION-WSL.md）。别在两台机器上同时跑：同时登同一个 QQ 小号会互踢。

### 代码结构

- qq-bridge/src/bridge.js 是入口和老功能，约 5 千行。二代社交那部分在 qq-bridge/src/app/ 下 19 个模块，每个是 `createX(app)` 返回 `{exports, link(), start()}`：
  - wake / wake-triggers / wake-prompt：唤醒、门控、提示；
  - v2-state / v2-messages：状态和消息；
  - self-now / self-check / life / tell-myself：她的状态、自洽、心情和生活、捎话给别的窗口；
  - free-time / reminders / night-sleep / idle-compact；
  - human-send / media / stickers / voice / slang；
  - console-server。
- 纯函数在 src/ 下：reply-gate.js、inner-life.js、free-time.js（活动菜单）、proactive-schedule.js、qq-model-view.js（给模型看的消息，`defang` 把数据里的【】换掉）、v2-wait.js 等。
- 状态在 bridge 卷的 state/social-v2.json，防抖存盘（`stateSaveDelayMs` 默认 1000，0 = 马上存），退出、/api/restart 前先存。
- 两份数据谁是原件：
  - 计划和日记的原件在 extras /data/life.json，bridge 的 `life.plan` 是副本，做没做只记在 bridge；
  - 看没看过视频以 extras /data/bili-watched.json 为准，bridge 的 `watchedVideos` 只是提示用的缓存。
- 日志带日期，留 30 天：bridge 在 state/logs/bridge-YYYY-MM-DD.log，extras 在 /data/logs/extras-*.log。用 `scripts/logs.sh bridge|extras [-d 天数] 模式` 查，下文的“日志 `grep X`”就是 `scripts/logs.sh bridge 'X'`；`docker compose logs` 只有容器这次启动以来的。

### 提示词和工具

- 规矩都在系统提示里，唤醒提示只放这一次的数据。
  - 系统提示：qq-chat-v2 / qq-play 两个 preset 的 persona，开头是 `{{qq_role_card}}`（插件 plugins/qq-agent-presets/qq-persona-card.mjs 读 bridge 写的 state/role-card-v2.md，人格卡热生效，日志 `grep 人格卡`）。`complete:true` + `includeRuntimeContext:false`，不带 DSH 默认的 MCP 和写代码说明。`systemPromptCard.enabled:false` 回到人格卡写在唤醒里的【当前角色】。
  - 唤醒提示依次是【会话令牌】【你现在】【这个群】【可用表情包】【你记着的事】【唤醒】【对人的了解】【长期记忆】【别处的事】【本次消息快照】，有的才写。
  - 系统提示记在会话历史里，改了以后旧的那份要等压缩才消失，要马上生效就对各会话手动 /compact（见下面的闲时压缩）。
- 提示词里不出现管理员、控制台、ownerQQ、模型名。主人标记写“主人（你的爸爸）”，不带 QQ 号。
- 工具在 schema 层就藏，她看不到（plugins/qq-agent-presets/qq-tool-restrict.mjs，等 tools/change 再藏）：
  - 所有 `*__browser_run_code_unsafe` 都藏、都拒；
  - `hideOtherSide`：聊天看不到 play 的浏览器、桌面和 bili_watch，play 看不到聊天浏览器；
  - preset 的 `hideTools` 藏 11 个不用的 qq_ 工具，qq-chat-v2 和 qq-play 里是同一份名单。
- 工具说明在 src/mcp-snowluma-safe.js，启动时读的，改了要重建 dsh。
- 会话压缩用中文第一人称笔记（control/patch-dsh-compaction-qq.mjs，构建时打进 dsh-compaction-basic），32~48 位十六进制串换成“（令牌）”，事情写几月几号几点、不写今天昨天。压缩用哪个模型见下面长期记忆一节。DSH 升级后锚点对不上，构建会直接失败。
- 模型把工具参数 JSON 写坏（`MALFORMED_RESPONSE`）时，bridge 发一条【系统】让她接着做，连续最多 `malformedRetry.max` 2 次，都失败才私聊通知主人。日志 `grep 自动重试`。

### 什么时候叫醒她

- 私聊：每条都叫。
- 群：全部走回复门控（`replyGate`，src/reply-gate.js，思路来自 MaiBot 的 turn_trigger，GPL，照思路重写的）。
  - 强制唤醒：@、引用、叫名字或外号、拍她（`poke`，同一人 `cooldownMs` 180 秒内只叫一次，主人不限）、她指定的人、接话、主人夜里叫她。
  - 小群默认都是跟她说的（`wake.addressedGroups: ["group:1100000001"]`，唤醒原因 `addressed`，算强制）：每条都叫，除非明确在跟别人说（@ 别人、引用别人、开头叫着最近说过话的人的群名片），那种照旧走门控；别的机器人不算。提示里有【家里的小群】，系统提示有对应的一条。等待里也算有人叫她。
  - 别的消息攒一批（`quietMs` 3000 内没人再说），按逻辑回归估“她会回”的概率，再用一小时窗口的动态阈值让回复次数贴近 `talkValue`：private 1 / home 0.8 / group 0.15，可以 `byKey` 单独设，`talkSchedule` 按时段乘系数。她的关键词只当一个特征。
  - 门控叫来她没说话连着 2 次就退避（`idleBackoff`）。
  - 日志 `grep 回复门控`，状态在 `replyGates`。
- 只回找她的群 `replyOnlyGroups: ["group:800000002","group:1100000003","group:1000000004"]`：门控不叫（talkValue 当 0）、主动找人不找、自由时间不往里分享（有人托的照发）。【这个群】写明只在有人找她时说话。
- 接话 `replyGate.talkBack`（唤醒原因 `talkBack`，算强制）：她说完 5 分钟内，她开口前看过的最近 3 位说话人又说话就叫，每句都算，3 秒合并。
  - 她最后那段话像在问人（问号、吗、几点、什么……），她直接在跟着说的人（引用或 @ 的、把她叫来的、她开口前最后说话的）`questionMinutes` 15 分钟内回话也算。
  - `talkBack.byKey` 单独设时间窗，`windowMinutes` 负数是不限：小群 `group:1100000001` 是 -1，她下次说话前，她聊着的人什么时候说话都叫她。
  - 不算的：只发图或表情的（只发表情的、是她直接在跟着说的人就算；照片截图都不算）、引用或 @ 别人的、约游戏喊人上号的（`gameWords`）。被接话叫来她没开口，她看过的那几个人这段就不再叫（`talkBackDeclined`），她直接在跟着说的人另外说话还叫。
  - 家里以外的群 `talkBack.outside`：她说完后已经有 3 个别人说过话（`crowdOthers`）不叫；这人在跟别人你来我往（`sideTalk`）不叫。算她在聊着的人还加上她引用或 @ 的人（`toUserIds`）和把她叫来的人（`wakeBy`）。`outside.direct:true` 是更严的第一版。
- 唤醒合并 `wake.batchWindowMs` 3000，以全局配置为准。`maxWakePerHour` / `maxWakePerMinute` 0（不限）。
- 会话正忙时进来的唤醒，回合结束后只在触发它的那条还没给她看过时补发。日志 `grep 跳过补发`。
- 一轮里的等待 qq_wait_for_messages（`wait`）：
  - 有新消息后安静 3 秒返回；对方像没说完要 5 秒；有人叫她只等 2 秒；第一条新消息后最多再拖 15 秒。
  - 群里最多等 `replyGate.groupWaitMaxMs` 30 秒，只有有人叫她、或者门控觉得该回才提前返回。
  - 等待的基线从 readThroughSeq 算，看过的不会再叫醒她。
- 群里攒了很久的未读（`context.staleUnreadMinutes` 30）：开头连着的旧未读不给原文，快照里写 `olderSkipped`，遇到叫她的就停；放进 recent 的旧未读（`staleRecent`，不进 JSON）提示里写明是当时没接上的、话题多半过去了，不是没办完的正事就别补回、别追问。私聊不跳。过了 10 分钟的消息带 `ago`。日志 `grep 快照跳过过时未读`。
- 跨会话【别处的事】（`crossSession`）：给其他会话最近 3 小时的内容。家里以外的群看私聊、家里的群、别的群都只给条数。
- 闲时压缩 `idleCompact`：一轮结束后安静 2 分钟、上下文 ≥10 万 token，就执行 DSH `/compact`。
  - `byKey` 可单独设（技术群 15 万）；同一会话至少隔 `minIntervalMinutes` 60。
  - 斜杠命令必须走 RPC `commands/execute {agentId, line, submittedAttachments}`，用 session/prompt 发只会变成普通消息。
  - 日志 `grep 闲时压缩`。

### 发话

- 像人打字那样发（`send.human`）：条间隔 600 毫秒 + 每字 120 毫秒，±30%，夹在 0.4~4 秒。
  - 一次最多几条 `maxBubbles`：私聊 4、家里的群 4、别的群 2，多的并进最后一条。
  - `cutOnInterrupt`：私聊对方说了话、群里有人叫她，后面的不发，返回 `notSent`。日志 `grep 分条发送被插话打断`。
- 发送条数不限（`send.maxSendPerHour` / `maxSendPerMinute` 0）。
- 她把话直接写成文字、一轮里什么也没发（文字不会转发到 QQ）：收尾的 qq_mark_read / qq_set_wake_config 结果带 `hint`，没收尾的【提醒】里也写明那段没发出去；她写给自己的旁白（“不是在叫我”“没插话”、括号里的动作）不算。日志 `grep 话写成了文字没发出去`。
- 别人发的表情包：文本里写 `[表情包]` / `[表情包:不想干]`，media kind 是 `sticker`。
  - 和她的收藏对得上的带 `inYourStickers`。
  - qq_get_message_images 看表情包时附上谁在用图说话、前后说了什么（`stickerIntent`），让她顺着意思接，别讲画面。
  - 收藏和 qq_sticker_note 记“表达什么、什么时候发”（usage）。findSticker 认 id、md5、整句备注。
- GIF 用 ffmpeg 抽帧拼成网格图（src/gif-frames.js），因为 DeepSeek 只看第一帧。
- 她换头像时 extras `/describe-avatar` 描述一次，写进身份行。日志 `grep avatar`。
- 截图 `qq_send_screenshot(key, token, tabIndex?)`：不填就截她最后用的那页（src/browser-tabs.js）。play 截 8931，聊天截 8933。画图就是在 about:blank 用 canvas 画满再截，截出去的 about:blank / data: 页记一笔玩过的“画了一张画”。
- 沙雕图 `qq_send_meme(key, token, post, caption)`（`tools.sendMeme`）：
  - bridge 先请 extras `/relay/prepare` 查红线、频率并下载，再自己发；发失败调 `/relay/cancel`。
  - 限额在 extras 的 `relay`：每会话每天 3 波、间隔 120 分钟、一波 3 条、全局每天 20 条，0~8 点不发。
  - `relay.conversations` 是固定名单，新群要加进去。

### 她的一天

- 睡觉 `nightSleep {from:"23:30", to:"08:00", ownerAwakeMs:1200000}`：
  - 夜里只有主人私聊、或在群里叫她才醒，醒后 20 分钟内主人说话都算（每句顺延）。被挡的消息早上每个会话补一次（【你刚睡醒】）。日志 `grep 夜间睡觉`。
  - 她说去睡就调 `qq_go_to_sleep`，只在夜里或睡前 `earlySleepMinutes` 120 分钟内能用。别的窗口一起收尾（steer【你要去睡了】）。
  - 晚安只在家里的小群、私聊或正聊着的地方说。家里以外的群不让记“到点去说晚安”的提醒（qq_remind_me 拒，等人说话的不拦），那里的 reminder 唤醒也写明只想说一声就别说。
  - 改睡觉时间时要同步 `proactive.schedule` 里的“睡觉”段。
- 给她看的时间都带日期（qq-model-view 的 `dateTimeText` “YYYY-MM-DD HH:MM”，模块里是 `whenV2`）：消息、提醒、看过的、【你现在】的时间行（带星期）。人物卡的约定、最近写 ISO 日期；压缩笔记、digest、改卡都不写“今天”“昨天”。qq-chat-v2 的【你现在】让她拿消息时间跟现在比（上午说没吃午饭，晚上就问后来吃了没）。
- 【你现在】（self-now.js）：每次唤醒都有同一份。
  - 内容：时间和作息段、睡没睡、电脑上在玩什么和今天每一回自由时间（`playSessions`、`playLog`）、别的窗口在聊什么、心情、身体感受（bridge 算，不带数字）、今天想、昨天的日记、今天说过的自己的事。
  - 等待中状态变了，结果里带 `yourStatusNow`。日志 `grep selfState`。
- 心情：她自己用 `qq_set_mood` 定，30 分钟内她定的优先；没定时 `moodEngine` 在她开过口的一轮后（同一会话 10 分钟一次）和自由时间玩完后请 extras `/mood/appraise` 体会。
  - 按 `halfLifeMinutes` 120 淡回 baseline。
  - 影响回复门控的 talkValue（×0.7~1.3）、一次发几条（±1）、自由时间抽念头的权重。
  - 日志 `grep 心情（自己体会的）`。
- 生活 `life`（extras/life.py，数据在 /data/life.json）：
  - 起床后 `/life/plan` 想 1~3 件“今天想”，睡前 `/life/diary` 写日记，自由时间玩完后 `/life/threads/update` 整理“手上的事”。
  - “今天想”做没做由 `/life/plan/progress` 看（`life.planProgress`），在她开过口的一轮后和自由时间玩完后。要有实在的证据：电脑上玩过的记录、发了图；光说不算。
  - 日志 `grep '\[生活\]'`。
- 主动找人 `initiate {targets:["group:1100000001"]}`：
  - 每 30~60 分钟，在 9:00~22:30、没睡、那边安静 60 分钟以上时考虑。extras `/proactive/think` 想一个念头并打分，≥3.5 才用 `initiate` 叫她（【你想起一件事】），她可以走开。
  - 限额：每处每天 2 次、全局 4 次、间隔 180 分钟、连着 2 次没人理就停。
  - 家里以外的群只有在 `initiate.byKey` 里写了规矩、又不在 replyOnlyGroups 里才找。
  - 日志 `grep 主动找人`。
- 说的话前后对得上：
  - 发完话核对 `selfCheck`：粗筛后攒 4 秒一批交给 extras `/self/check`（extras/selfcheck.py）。claims 记进 `selfClaims`；conflicts 和做不到的 promises，正在聊就 steer【说岔了】（同一处 10 分钟、全局每小时 6 次），不在就写进下次唤醒。play:main 不查。日志 `grep '\[自洽\]'`。
  - 提醒 `qq_remind_me(key, token, note, minutes 或 at, cancel)`（`tools.remindMe`）：到点在聊就 steer【到点了】，不在就用 `reminder` 叫醒，夜里不叫。`waitFor` / `waitWords` / `waitIn`（`remindWait`）是等某个人说话再叫。日志 `grep '\[提醒\]'`。
  - `promiseHint`：她说了“待会儿再…”、“他一睡我就告诉你”（`conditional`）、“我这就去画”（`goDo`）却没记提醒、也没托 qq_go_play，发送结果里提醒她一次。
  - 聊天会话一轮里调聊天浏览器满 12 次，steer【交给去玩的你】（`chatBrowserHandoff`）。
  - 捎话 `qq_tell_myself(key, token, to, note, stopPlay?, minutes?)`（`tools.tellMyself`，src/app/tell-myself.js）：主人在这里让她做的事牵涉到别的窗口时，她自己捎过去。
    - 只能从私聊和家里的群发，而且要主人 `tellMyself.ownerMinutes` 5 分钟内在这里说过话；大群、play:main 都拒（qq-play 也在 hideTools 里藏了）。
    - to 是会话 key、`play:main` 或 `all`（除了这里和 play 的所有窗口）。那边正跑着一轮就 steer【捎给自己的话】；不在就记进 `socialV2.tellNotes`（每处 3 条、留 `keepHours` 6 小时），下次那边被叫醒时写进唤醒提示，不专门叫醒。家里以外的群看到的是“在别处答应了”。
    - `stopPlay`：记 `socialV2.playHold`（`minutes` 10~360，默认 `holdMinutes` 60，只延长不缩短）。play 正在玩就 steer【先不玩了】、不再劝接着玩；到点前自由时间检查跳过、qq_go_play 拒、play 不往聊天里分享，【你现在】里写着“答应了先不玩”。主人在私聊或家里的群、说好以后又说过话再托 qq_go_play，就解除。
    - 日志 `grep '\[捎话\]'`。

### 自由时间

- 自由时间是独立会话 `play:main`（preset qq-play），和聊天互不阻塞。`proactiveCheck` 只对它生效。下次检查时间存 `proactiveNextAt`。
- 玩多久（`proactive`），由 bridge 掐时间、含糊地劝，不给她数字：
  - 每次随机定至少玩 `sessionMinutes` [15,30] 分钟，没到就劝她接着玩、优先玩深（活动的 `deep`）。到点 steer 一次【可以歇了】，满 60 分钟或到 23:30 steer【玩了好久了】/【该睡觉了】。
  - 玩完歇 [60,120] 分钟，检查间隔 30~60 分钟，按作息表概率决定去不去。
  - 日志 `grep freeTime`。
- 活动菜单在 src/free-time.js（`proactive.activities` 可以整个替换）：B 站、沙雕图、新闻、热榜、网页小游戏（只给游戏站，她自己挑）、百科、番剧、论坛、天文图、菜谱、科普、查好奇的东西。每次抽 3 个念头，最近玩过的权重减半，喜欢的那类（`life.interest`）权重高。
- 托付：聊天会话用 `qq_go_play(key, token, note, minutes?)` 托“去玩的自己”去看。
  - 托的时候 5 分钟内主人说过话才标【主人托的】，只有这种才用 B 站账号点赞、投币、评论。
  - 填了 minutes 就像平常一样劝到那个时间。
- 往聊天里分享（`playShare`）：一次自由时间一回，同一会话至少隔 180 分钟、每会话每天 2 回、全局 4 回，`byKey` 可单独设。有人托的不拦。日志 `grep 自由时间分享`。
  - play 发进聊天的话记 `byPlay`，聊天那边用 `yourPlaySelfSent` 看到一次。
- 看过的：
  - B 站视频 extras 记 500 个，`bili.rewatchDays` 14 天内重看要 `again=true`；
  - 文章 `readPages` 14 天，重看 steer【看过了】；
  - 唤醒提示列最近的。日志 `grep 看过的`。
- 见闻（memory_note）最多 80 字（extras 的 `memory.maxLogChars`），太长退回让她重记。

### 长期记忆（extras）

- 自动整理 extras/digest.py：bridge 每条白名单消息 POST `/digest/notify`，攒够 15 条且安静 10 分钟才用 OneBot 历史拉一次。
  - 抽出 facts、主人叮嘱 rules、开发反馈 feedback。rules 带 `scope`，只认主人说的行；feedback 存 /data/feedback.json，从不给她。
  - `antiPollution` 过滤玩笑、技术闲聊（`tech_reason`）。日志 `grep digest`。
- 挑选和遗忘 extras/memory.py：按字二元组 + IDF 算相关度，强度按半衰期衰减，聊到了才算 hit 延长。每天 4 点 consolidate。不用向量库，因为 DeepSeek 没有 embedding 接口。
- 按来路过滤（`recall(key=…)`，MCP 的 memory_recall 也带 key）：家里以外的群里，别人的事实只给全部听自家以外群的（`seen` / source，“?” 不给）；她自己的事照给，但提到主人的（主人、爸爸妈妈、主人 QQ 号、卡上的名字）不给；rules 照旧按 scope。私聊、家里的群全给。折成印象时 `seen` 取并集。
- 维护性质的活用 aiohub 的 `claude-opus-5-5`（effort high），别的（聊天、心情、生活、自洽、主动找人、头像、搜索）还是 DeepSeek：
  - 4 点整理（extras 的 `memory.consolidate.llm`）和白天的 digest（抽取事实、核对、人物卡快改，`memory.digest.llm`）。两处都是 `{api:"anthropic", model, apiKeyEnv:"AIOHUB_API_KEY", effort:"high"}`，调不通就换回 DeepSeek（日志 `grep 换回默认模型`），删掉 `llm` 就用 DeepSeek。
  - 会话压缩：qq-chat-v2 / qq-play 的 compaction-basic 配了 `summarizationProvider: aiohub-opus` + `summarizationModel` + `maxTokens: 32000`（provider 在 home.cordis.patch.yml，`reasoning: high`），失败了补丁换回聊天的模型再压（`docker compose logs dsh | grep compaction-qq`，ctx.logger 的那句进不了容器日志）。删掉 preset 里这三行就回到 DeepSeek。
    - 单独的压缩模型走 pi-ai，一次最多 `DSH_PI_AI_MAX_REQUEST_IMAGES` 28 张图，超了报 IMAGE_OFFLOAD_REQUIRED（压缩没有 image-offload 插件兜着）。补丁的 `qqLimitImages` 只留最后 24 张（`DSH_COMPACTION_MAX_IMAGES` 可改，默认 28−4），前面的换成“[图片]”；还超（20MB 总字节）就按报错说的张数再省、最多重试 3 次。
  - 它的分词比 DeepSeek 多算约六成，压缩不命中缓存，一天二三十次压缩约三四百万到九百万 token。aiohub 的花费控制台不算。
- 见闻去重：和已有的同一件事不再新记。bridge 把她发的话 POST `/memory/told`，讲过的见闻不再当话头给。日志 `grep 讲了见闻`。
- 人物卡 extras/people.py（`people.enabled` + bridge 的 `longTermMemory.personCards`）：
  - 卡是一条一条的 `items`（`{id, sec, text, date, from 依据的记忆 id, seen 在哪些会话听来的, status}`），分 相处 / 了解 / 在做 / 约定 / 最近 五栏，每栏有上限，主人和群友各一套（`people.sections` 可改，`itemChars` 60）。在做 30 天、约定 21 天、最近 14 天不再更新就淡掉；约定做完了标 done。
  - LLM 只给增量改动（add / update / delete / done），没变的条目不重写；某栏超了再请它合并一次。
  - 按会话渲染：家里以外的群只看到全部听自家以外群的条目（`seen` 来自记忆的 source，来路不明的算“?”，外面不给）。所以阿红的卡在大群是空的。私聊、家里的群看全部。
  - 两个主人各一张、各一套上限，每次都带、细节都留，`ownerMaxChars` 700，事实半衰期 180 天。其他人记个大概，`maxChars` 150、最多 3 张、450 字，加她用 `person_note` 写的“我觉得”。
  - 渲染成【对人的了解】，`card` 字段是全量渲染（给旧代码看）。`GET /people` 查看，`POST /people/rollback` 回滚（连 items 一起）。每晚 consolidate 先 `prune_all` 清淡掉的。
  - 白天是快改（只看上次改卡以后的新事实）；每晚 4 点对当天有新事实或改过的卡仔细过一遍（`people.nightReview`，TASK_REVIEW：查重复、错栏、过时、改丢的细节），没改就只记 `reviewed`，不出新版本。
  - 旧格式的卡用 `people.migrate_all(complete)` 迁。
- 改 memory.json / people.json 前先备份到 extras /data/*.bak-日期-原因，并让主人确认。

### 浏览器

- 两个沙箱浏览器都有界面，3 分钟没人用自己关掉，下次调用自动重开：
  - 8931 给 play：B 站登录、`--caps vision` 按坐标点和拖，VNC http://127.0.0.1:6080/vnc.html ；
  - 8933 给聊天：profile `chat-profile`，VNC http://127.0.0.1:6082/vnc.html 。
- 按元素拖（`browser_drag`）遇到落点被挡会卡在按下状态，游戏里用按坐标的 `browser_mouse_drag_xy`。
- sandbox 容器不限 CPU、内存、线程数。`oom_score_adj: 1000`，内存吃光时内核先杀它。egress/squid.conf 的 `ad_hosts` 拦广告竞价域名。
- 联网搜索没有次数限制（`webSearch.maxUses` 5、`maxResults` 20 是代码允许的最大值）。

## 常用命令

```sh
scripts/preflight.sh [--fix]          # 部署前检查
docker compose build && docker compose up -d
docker compose logs -f bridge         # 看是否“SnowLuma 已连接 / DSH 已就绪”
scripts/backup.sh / scripts/restore.sh
scripts/migrate-export.sh / scripts/migrate-import.sh <包>
```

- Docker 或 SnowLuma 重启后 QQ 会停在登录界面：让用户去 http://127.0.0.1:6081 点“登录”。bridge 的 entrypoint 会一直等到 OneBot 端口能连上。
- 改 `config/qq-bridge/config.json` 后 `docker compose up -d --force-recreate dsh bridge extras ui-forward`（ui-forward 和 bridge 共用 dsh 的网络，重建 dsh 不带上它，宿主机的 3080/3100/6080 就全连不上，VNC 看着像没了；控制台网页改设置写不回这个绑定挂载的文件）。不要用 `restart`：编辑器保存会换 inode，Docker Desktop 的单文件绑定挂载还指着旧文件，bridge 会 Exited (127)，extras 会继续读旧配置。`config/extras.json` 改了不用重启。重建 extras 后必须连 dsh 一起重建（`up -d --force-recreate dsh bridge extras ui-forward`）：DSH 连 extras 的 MCP 会话不会自动重连，extras 一换容器，她调 tg_*/memory_* 等工具全返回 “Session not found”。
- bridge 控制台 API 在 bridge 容器内 `http://127.0.0.1:3100`，鉴权头 `x-console-token`（值在 `state/console-token`），POST 时要带 `origin: http://127.0.0.1:3100`。例如手动触发一次自由时间：`POST /api/socialV2/wake {"key":"play:main","reason":"proactiveCheck"}`；重置会话：`POST /api/session/reset {"key":...}`。
- DSH 会话记录在 dsh 容器 `/data/dsh/sessions/*/<session-id>/session.v4.jsonl.zstd`（zstd 压缩），会话 id 在 bridge 的 `state/sessions.json`。看模型怎么想的就解压它看 `reasoning` 块。

## 改 qq-bridge 的方式

qq-bridge 的源码就在本仓库 `qq-bridge/`（从上游 v0.2.0-r4 / a56164e7 分出来）。control/Dockerfile 直接 `COPY qq-bridge/`。改它：

```sh
cd qq-bridge && npm ci            # 第一次；node_modules 和 state/ 不进 git
# …编辑 src/bridge.js、dsh/agent-presets/qq-chat-v2/agent.cordis.yml 等…
node scripts/build-agent-preset-patches.mjs
npm test                          # scripts/run-tests.mjs：所有离线测试，连真服务的和 Windows 专用的会列在“没跑”里
cd .. && scripts/test-all.sh      # build 镜像，再在镜像里跑要 DSH 的测试、verify-persona-config 和 extras 的单元测试
docker compose up -d --force-recreate dsh bridge ui-forward
```

改提示词或工具表以后，用离线回放 tools/replay-eval（用法见 replay.py 开头，variant 例子 variants/refactor.py）和上一版比一比；它调真的 DeepSeek，数据在 /tmp/replay-eval（有聊天内容和令牌，不进仓库）。


`npm test test-foo` 只跑名字带 test-foo 的；`HARNESS_LOG=1` 打开测试里 bridge 的日志；几个按时钟算作息的测试在 0 点前后一两分钟跑会误报。

相对上游的主要改动：沙箱 / extras 工具放行（`browser_run_code_unsafe` 藏、拒）；qq-chat-v2 / qq-play 提示词重写；二代社交拆成 src/app/ 下的模块；自由时间、作息表 `proactive.schedule`、回复门控、心情生活、长期记忆注入这些都是我们加的（见上面“现状”）；系统提示（出错等）只私聊发给 ownerQQ。上游的一代模式、其他角色模式代码还在，没删。

## 坑

- 三个 preset 的 persona 不带 `suffix`（上游 preset 写着 `Your working directory is {{cwd}}.`，会把容器路径告诉她；DSH 的默认是空），和 home.cordis.patch.yml 清空 personaSuffix 是同一个原因，别加回来。
- 人格卡文件名不能有 emoji：qq-bridge 的 `sanitizeRoleName` 会把它删掉，导致人格卡静默不加载。
- 中转站一次请求超过 32 张图会 400：control/patch-pi-ai-image-count.mjs 给 DSH 的 pi-ai 适配器加了上限（`DSH_PI_AI_MAX_REQUEST_IMAGES`）。
- Gemini 4 Argon 走 aiohub 的 Anthropic Messages 接口（`api: anthropic-messages` + `forceAdaptiveThinking`）。模型名不带 `google/`。它的 OpenAI 兼容接口不思考（reasoning_effort 无效）；Gemini 原生接口 DSH 的 llm-pi-ai 配置不认（api 只能是 openai-completions / openai-responses / anthropic-messages）。`budget_tokens` 式思考会 400，effort low 基本不想、medium/high 会想。调工具时思考块的签名必须带回，同一轮缺签名会 400（pi-ai 会带，旧轮次 DeepSeek 留下的没签名的工具调用不要紧）。
- 工具参数 schema 里有 `anyOf: [X, {type: null}]`（Python MCP 的 `X | None`、Playwright 的 browser_emulate_media）会让 Gemini 拒绝整个请求：control/patch-pi-ai-tool-schema-null.mjs 在 pi-ai 的 Anthropic 适配器里把 null 分支去掉。其他联合类型（number|string）没问题。
- B 站接口在服务器端无 cookie 调用会 412，所以 extras 的 `bili_watch` 全部在沙箱浏览器里用 `browser_evaluate` 调（带 wbi 签名）。它拖着进度条看：短视频每 10 秒一段，长视频均匀取 30 段，每段播 3 秒，一个视频一两分钟（15 分钟的视频实测 133 秒）。每跳一次要等缓冲，20 多分钟的 1080p 视频以前一次要 6 分钟；现在每段最多等缓冲 3 秒（`BUFFER_WAIT_MS`），30 段都看完，长视频三四分钟，外加简介、20 条回复、15 条热评、5000 字字幕，拼成 5×6 的 1280×864 缩略图。每次打开视频都把 B 站“自动连播”（localStorage `recommend_auto_play`）关成 close，不然后台标签页会一集接一集连播，账号历史里多出她没看过的。工具都不限时：config/dsh/home.cordis.patch.yml 里四个 MCP 和补丁里 setup-dsh.mjs 管的三个（snowluma、snowluma-host、web-search-safe）的 `toolCallTimeoutMs` 都是计时器上限 2147483647（约 24.8 天）；不写是 DSH 默认 60 秒，写 Infinity 或更大的数 Node 会当成 1 毫秒。以前 extras 是 300 秒，长视频超时后她重试，上一次还在后台跑，两次抢同一个标签页。
- SnowLuma 固定 hostname 和 IP 172.19.0.2（QQ 设备指纹稳定）；其他容器只从 172.19.1.0/24 分配。
- Linux/WSL 上 `config.json` 必须属于 uid 1000、权限 640（extras 靠 `group_add: ["1000"]` 读它）。
- 模型容易把“自由时间”当任务快速做完：不要在提示里给它可凑的数字指标（包括还剩几分钟），由 bridge 掐时间、含糊地劝它继续。以前按“看够 4~8 样”劝，她一样东西不到一分钟，七八分钟就收尾了。
- 联网搜索（web-search-safe MCP）：`webSearch.provider=anthropic`，走 DeepSeek 官方的 Anthropic 兼容接口 `https://api.deepseek.com/anthropic/v1` + `deepseek-flash` + 服务端 web_search（一次几秒到十几秒），返回中文简答 + 来源（实测一次 4~13 秒）。DSH 启动 stdio MCP 时会把名字带 KEY/TOKEN/SECRET/PASSWORD 的环境变量全删掉，所以 key 必须写在 `webSearch.apiKey` 里，换 DeepSeek key 时这里也要改。
- 长期记忆自动整理（extras/digest.py）：bridge 每收到一条白名单消息就 POST extras `/digest/notify {key,userId}`（不带内容），extras 只数条数；攒够 `memory.digest.minMessages`（15）条且安静 10 分钟才用 OneBot 历史拉这个会话（主人说过话不用凑条数；一直在聊满 60 分钟也拉；条数不够的安静后最晚 `maxWaitHours` 6 小时拉一次；拉失败 10 分钟起翻倍退避到 1 小时），没人说话的会话一次都不拉。拉下来后让 LLM 抽取事实 + 主人叮嘱（subject=rules），水位和待整理计数（pending）在 extras 的 /data/digest.json，日志 `docker compose logs extras | grep digest`。rules 只认 OneBot 给的 user_id 是 ownerQQ 或 extraOwnerQQ 的行（代码强制，不靠 LLM），总会注入、不淘汰、她自己删不了。LLM 是推理模型：max_tokens 包含推理，`consolidate.complete` 用 reasoning_effort=high（环境变量 LLM_REASONING_EFFORT 可改）+ max_tokens 65536，以前 6000 时思考写满额度、正文为空。
- 长期记忆的挑选和遗忘（extras/memory.py）：不用 mem0/Letta 这类开源方案，因为它们要 embedding 模型 + 向量库，DeepSeek 没有 embedding 接口。现在的做法：
  - 相关度：bridge 唤醒时把最近 12 条聊天当 `query` 发给 `/recall`，按字二元组 + IDF 算相关度。
  - 强度：`0.5^(天数/半衰期)`，半衰期 self 7 天、人/群 30 天（`memory.halfLifeDays`），“印象”（kind=summary）×4。
  - 排序：每个主体取 `0.6×相关 + 0.4×强度` 的前 15 条。光被注入不刷新；只有真聊到了（相关度 ≥ hitThreshold 或共有 2 个以上稀有词）才算一次 hit，hit 会重置时钟，半衰期 ×(1+0.5×hits)，12 小时内只加一次。稀有词：中文二元组要落在两边都有的三字词组里（共有三元组）、且只在 ≤4 条记忆里出现才算数；单独撞上的二元组（“吃饭”“上班”）只帮排序（on_topic 最多 0.5），不算 hit。不这样的话记忆少时什么二元组都像稀有词，随口一句“记得吃饭”就会让不相干的长笔记一直“又聊到了”。见闻另外总带最新记的 `memory.recallRecentLogs`（默认 4）条。
  - 超过上限（maxSelf 80 / maxPerSubject 40）时淘汰最淡的一条。
  - “见闻”：self 里 kind=log 的条目，play:main 记的、或带 `interest` 的 self 笔记都算。单独上限 `maxLogs`（config/extras.json 里是 60，代码默认 30），只在见闻之间淘汰，挤不掉设定和人的记忆；每次唤醒最多带 `recallLogs` 8 条，提示里标“见闻”。半衰期按她填的 interest（1 一般 / 2 有意思 / 3 超喜欢 → `logHalfLifeDays` 2/5/14 天），聊到了照样 hit 延长；夜里 consolidate 不把见闻折成印象，淡了就删。
  - 见闻去重和“讲过了”：不做的话她会把同一篇文章读好几遍、记好几条，再在各个群里各讲几遍（见闻每次唤醒都给，她自己讲的话还被当成“又聊到了”延长记忆）。现在 memory_note 记见闻时和已有的同一件事（共有 `memory.logDupMinShared` 8 个以上词、加权重合度 ≥ `logDupOverlap` 0.25，设 0 关）不再新记，返回 `duplicate` + “这个你之前看过了，换一样新鲜的吧”，interest 取大的。bridge 在 `recordSentMessagesV2` 里把她发的话 POST extras `/memory/told {key,text}`（play 用自己令牌发进聊天的也算，play:main 本身不算；`socialV2.longTermMemory.reportTold:false` 关），重合度 ≥ `memory.logTold.minOverlap` 0.25 且共有 `minRare` 4 个以上稀有词的见闻记进 `told[key]`（`logTold.enabled:false` 关）。讲过的见闻 /recall 带 key 时不再当话头给，聊天里又聊到它（on_topic）才带上，提示里标“这里讲过了”或“别处讲过了”（不说是哪）；在讲过的会话 24 小时内不算 hit。`memory.dedup_logs(dry_run)` 把已有的同一件事折进最早那条。日志 `grep 讲了见闻`。
  - 每天 4 点 consolidate：先删强度 < 0.03 的；再把每个主体里强度 < 0.5 的原始记忆（≥5 条）让 LLM 折成最多 6 条“印象”；印象超过 8 条就把最淡的合并。rules 永远不碰。
- 沙箱浏览器（经 egress 代理）能正常逛：tophub、豆瓣、bgm.tv、萌娘百科、维基词条（Special:Random 会 429）、BBC 中文、hk01、虎扑、v2ex、果壳、少数派、IT之家、xkcd、NASA APOD、下厨房、2048（2048.io、play2048.co 都行；play2048.co 以前在 sandbox 线程数有上限时会把浏览器拖崩，现在不限）、Poki、4399、lichess、sudoku、neal.fun、AcFun，游戏站 Poki、CrazyGames、4399、7k7k、itch.io、Coolmath、Miniclip（neal.fun 无头浏览器会被 Cloudflare 拦，现在两个浏览器都是有界面的，没事）。打不开：知乎（登录）、贴吧（验证码）、reddit（人机验证）、微博、小红书、lofter，别往菜单里加。主人不让看的网站加在 egress/squid.conf 的 `owner_blocked` 和 web_fetch（mcp-web-search-safe.js 的 `OWNER_BLOCKED_HOSTS`）两处。
- 不要把 `.env`、`config/qq-bridge/config.json`、迁移包提交进 git。
