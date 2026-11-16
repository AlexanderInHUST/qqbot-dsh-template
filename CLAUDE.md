# CLAUDE.md

QQ 群“仿真群友”鱼妹：QQ 小号（SnowLuma）+ qq-bridge 二代仿真模式（reserved2）+ DeepSeek Harness（DSH 0.2.2-rc.1，版本在 control/Dockerfile 和 docker-compose.yml 的 `DSH_VERSION`）+ 隔离沙箱浏览器。全部在 docker compose 里。用户界面语言是中文，回复用中文。

## 现状

这里写现在是什么样、开关在哪、日志怎么查。文中的 QQ 号、群号、名字（阿明、阿红、鱼妹……）都是示例，换成你自己的。下面没写前缀的配置键都在 config/qq-bridge/config.json 的 `socialV2` 下；“extras 的”指 config/extras.json。

### 账号、模型、环境

- 机器人 QQ 1000000000，昵称“鱼妹”，外号 `wake.selfAliases`（小鱼、🐟姐），外号和昵称一样算“叫她”。
- 主人（ownerQQ）900000001（阿明，提示里叫“爸爸”）。第二个主人 `extraOwnerQQ: [1600000002]`（阿红，`ownerTitles` 里叫“妈妈”），审批、夜里叫醒、叮嘱整理都和主人一样（代码里用 `isOwnerId` / digest.owners）。系统提示（出错、被拦截等）发给 ownerQQ 的私聊；它不在白名单里、或者在 `noReachOut` 里时改发到 `homeGroups` 的第一个群（v2-state.js 的 `ownerNoticeKey`），现在是后者。收不到 QQ 消息的告警例外，直接私聊阿明（见常用命令里的“收消息卡住”）。
- 阿明的私聊：他私聊她照常回，她不主动私聊他。900000001 在 `allow.private` 里，`socialV2.noReachOut: ["private:900000001"]`（src/privacy-policy.js 的 `noReachOut`）：主动找人不找、自由时间不往里分享（他托的照发）、qq_send_elsewhere 不往里发、系统提示发在小群。人格卡写了“爸爸私聊你就好好回，但你不主动私聊爸爸”。extras `relay.conversations` 里也要有他的私聊。
- 白名单：阿明、阿红的私聊；群 1100000001（小测试群，`homeGroups` 里唯一的“家里的群”）；群 800000002（大群）；群 1000000004（另一个大群，规矩和 800000002 一样）；群 1100000003（技术群）。家里以外的群（含以后新加的）都按大群处理：
  - 看不到私聊和家里群的内容；
  - 主人标记写“叫名字，不叫爸爸”（`ownerTitlesGroups: ["1100000001"]`）；
  - 人格卡 roles/鱼妹.md 规定私聊和小群叫爸爸妈妈，其他群叫阿明、阿红。
  - bridge 里这些判断都在 src/privacy-policy.js（`placeOf` 分 private / home / outside / play，`isOutsideGroup`、`isHomeChat`、`ownerTitleHere`、`crossSessionView`），以后新加的“家里外面”判断也调它；extras 那边是 store.py 的 `home_groups` / `outside`。没配 homeGroups 时两边不一样：bridge 当所有群都是家里的，extras 当都是外面的。
- `wake.otherBots: ["4000000009","4000000010","4000000011"]`：大群的小A、1000000004 群友的小B、1000000004 的小C，都是机器人。它们带到她名字不算叫她，也不按接话叫；@ 或引用她照叫。
- 模型：DeepSeek 官方 `deepseek-official` / `deepseek-flash`，`reasoningEffort: high`，在 config.json 的 `dsh` 段，Key 是 .env 的 `DEEPSEEK_API_KEY`。extras 的记忆整理、头像描述、联网搜索也用它。
  - 配着、随时能切的：aiohub 的 `deepseek-v4.1-flash-1017`、`claude-sonnet-5-5`、`gemini-4-argon`（Key `AIOHUB_API_KEY`），Cloudflare 的 `@cf/deepseek-ai/deepseek-v4.1-flash-1017`（Key `CLOUDFLARE_API_TOKEN`）。
  - 都试过又切回来了：gemini 私聊约 30 秒、群里约 1.5 分钟；Cloudflare 17 万 token 的会话每步 4~11 秒（官方 1~2 秒）。
  - aiohub 的 qwen3.8-27b：窗口约 128k，没有前缀缓存。
  - 控制台的花费按 DeepSeek 价目表算，换了模型就不准。
  - 官方连不上自动换备用（`socialV2.modelFallback`，src/app/model-fallback.js，都有代码默认）：用的是 deepseek-official 时，一轮因为 TIMEOUT / TRANSPORT / SERVER / STREAM_CLOSED（或报错文字像超时、连不上、502~504）结束，或者一步发出去 `stallSeconds` 120 秒一个字都没出（官方排队时只发心跳，DSH 的空闲超时不触发；bridge 停掉这一轮，工具在跑不算），所有会话换成 aiohub 的 `deepseek-v4.1-flash-1017`（下一条消息重新 selectModel），出错的会话发一条【系统】让她接着做（一次，备用也出错就照常报错）。换过去、换回来都只记日志，不往群里说。至少 `minMinutes` 10 分钟后每 `probeMinutes` 5 分钟看一眼 api.deepseek.com/models（不带 key，401 也算通），通了换回来。只在内存里，重启就回主模型。`enabled:false` 关。日志 `grep 换备用模型`。黑话学习会话也跟着换（slang.js 每次取会话都调 ensureChatModel），以后新加的 DSH 会话也要这样，不然换回来以后还留在备用上。
  - 为了早点换：config/dsh/home.cordis.patch.yml 给 `llm-deepseek` 设了 `streamIdleTimeoutMs` 90000（默认 300000）、`retryPolicy.maxRetries` 2（默认 5），不然 DSH 自己要卡十几分钟到半小时才报错。
- 跑在 Windows WSL2（迁移步骤见 docs/MIGRATION-WSL.md）。别在两台机器上同时跑：同时登同一个 QQ 小号会互踢。

### 代码结构

- qq-bridge/src/bridge.js 是入口（收发 QQ、DSH 会话、出口关卡等），约 3900 行，只有二代仿真模式（删了上游的一代模式、closed-agent、模式切换、多角色和 qq-mode-console 插件，权限边界见 qq-bridge/RULES.md，人格卡目录见 roles/README.md）；qq-chat preset 只给黑话学习会话用。二代社交那部分在 qq-bridge/src/app/ 下 30 个模块，每个是 `createX(app)` 返回 `{exports, link(), start()}`：
  - wake / wake-triggers / wake-prompt：唤醒、门控、提示；
  - v2-state / v2-messages：状态和消息；
  - self-now / self-check / life / tell-myself / growth：她的状态、自洽、心情和生活、捎话给别的窗口、替这里去别处说句话、慢慢长大；
  - free-time / reminders / night-sleep / idle-compact；
  - human-send / reply-timing（等对方说完、发前看一眼）/ media / stickers / voice / slang / jobs（要等一会儿的活和留话）/ draw（画画）/ video（做视频）/ cast（画里的人）/ away（不在、打游戏限时）/ files（她放文件的地方）；
  - model-fallback（官方连不上换备用模型）/ watchdog（看门狗）/ phrasing（老说法、play 发前先看一眼）/ console-server。
- 纯函数在 src/ 下：qq-capabilities.js（QQ 原生工具的能力表）、privacy-policy.js（家里 / 外面）、reply-gate.js、inner-life.js、free-time.js（活动菜单）、proactive-schedule.js、qq-model-view.js（给模型看的消息，`defang` 把数据里的【】换掉）、v2-wait.js、repeat-phrases.js（数她老用的说法）等。app 模块 import 了新的 src/*.js 纯函数库，要在 scripts/audit-bridge-harness.mjs 里 import 并展开进测试的上下文，不然测试全是 ReferenceError。
- 定时（src/scheduler.js，`app.scheduler`）：周期的事 `every`，到点跑一次的 `at` / `after`（潜水到期 `sleep:<key>`、限频重试、闲时压缩 `idle-compact:<key>`、换备用后的探测；自由时间检查是一个全局的 `free-time-check`）。到点时间存在各自的状态里，重启后重新登记。以后新加定时的事都登记在这里，别用长 setTimeout / setInterval（几秒的防抖除外）。控制台 `GET /api/scheduler`。测试拨钟用 scripts/lib/test-clock.mjs（`pinClock`、`advanceClock`，再 `h.scheduler.tick()`）。
- 状态在 bridge 卷的 state/social-v2/ 下分块存（src/state-blocks.js）：self（心情、生活、睡觉、头像、说过的自己的事、不在、先不玩）、play（自由时间玩过读过的、分享、下次检查；看过的视频不存，见下）、jobs（画画、视频记录、留话、别人头像描述）、reminders、runtime（暂停、门控窗口、aliveAt），每个窗口一份 conversations/group-123.json。
  - 每份 `{block, version, savedAt, data}`，防抖存盘（`stateSaveDelayMs` 默认 1000，0 = 马上存），只写内容变了的块，退出、/api/restart 前先存。
  - 写前旧的改名 `.prev.json`，读到坏的用它；窗口清掉改名 `.removed.json`；版本比代码新先另存 `.v<N>.json`。升版本写在 `MIGRATIONS`。日志 `grep 分块存盘`。
  - 旧的整份 social-v2.json 迁完改名成 `.pre-blocks`；它要是比分块新（回滚到旧代码跑过）下次启动从它重新迁。回滚到旧代码前在 bridge 里 `node scripts/social-v2-blocks.mjs assemble` 拼回整份，`status` 看每块大小、存盘时间。
  - 内存里还是一个 `socialV2` 对象，模块照旧直接读写，分块只管存盘。
- 她的计划、日记、手上的事、看过的视频只在 extras 存，bridge 只在内存里放一份给唤醒提示用，不存盘，重启后重新拉：
  - 计划（带做没做）、日记、手上的事在 extras /data/life.json。bridge 的 `lifeView`（life.js）每 `life.refreshMinutes` 10 分钟拉一次 `GET /life?date=她的今天`（她的一天按起床算，凌晨还是前一天），定计划、看做没做、整理手上的事、写日记拿回来的结果也直接换进去。bridge 的 `socialV2.life` 只记问过没有（planDate、diaryDate、planCheckedAt 等）和喜好、心情记录。
  - 看过的视频在 extras /data/bili-watched.json（500 个）。bridge 每 10 分钟拉 `GET /bili/watched?limit=N`（`proactive.watchedVideos` 默认 20），自由时间关着就不拉。
- 日志带日期，留 30 天：bridge 在 state/logs/bridge-YYYY-MM-DD.log，extras 在 /data/logs/extras-*.log。用 `scripts/logs.sh bridge|extras [-d 天数] 模式` 查，下文的“日志 `grep X`”就是 `scripts/logs.sh bridge 'X'`；`docker compose logs` 只有容器这次启动以来的。

### 提示词和工具

- 规矩都在系统提示里，唤醒提示只放这一次的数据。
  - 系统提示：qq-chat-v2 / qq-play 两个 preset 的 persona，开头是 `{{qq_role_card}}`（插件 plugins/qq-agent-presets/qq-persona-card.mjs 读 bridge 写的 state/role-card-v2.md，人格卡热生效，日志 `grep 人格卡`）。`complete:true` + `includeRuntimeContext:false`，不带 DSH 默认的 MCP 和写代码说明。`systemPromptCard.enabled:false` 回到人格卡写在唤醒里的【当前角色】。
  - 唤醒提示依次是【会话令牌】【你现在】【这个群】【可用表情包】【你记着的事】【唤醒】【对人的了解】【长期记忆】【别处的事】【本次消息快照】，有的才写。每一段登记在 wake-prompt.js 的 `WAKE_SECTIONS`（`registerWakeSectionV2({name, order, where: chat|play|both, stage: head|tail, build})`），`composeWakePromptV2(key, reason)` 按 order 拼成整份并返回快照；新加一段就登记一条，别再往 buildWakePromptV2 里塞。
  - 系统提示记在会话历史里，改了以后旧的那份要等压缩才消失，要马上生效就对各会话手动 /compact（见下面的闲时压缩）。
- 提示词里不出现管理员、控制台、ownerQQ、模型名。
- 普通群聊大人的知识（芯片、财报、显卡渲染……）像小孩转述（不然大群里像专家讲课）：qq-chat-v2【帮人查东西】写了“我看到说……”“好像是因为……吧”、挑一两点、不报一串数字型号术语、不分条讲课；光写在提示里她查完还照念，所以 web_search / web_fetch 的结果里也带一句 `hint`（mcp-web-search-safe.js 的 `KID_HINT`，所有会话都带）。回放对比用 variant tools/replay-eval/variants/kidtone.py。
- 桥接不替她往 QQ 里说话：没有 / 管理命令（删了 /reset /status /role /silent /active 和“换角色”拦截），/ 开头的话和别的话一样给她看；DSH 重启时消息只排队，不回“系统服务重启中”；二代模式里 DSH 的提问、审批由桥接自动跳过（两个 preset 里删了 tool-ask-user 行，她没有 `ask_user_question`；preset 自己的行注册的工具 restrict 藏不掉，只能删行），不往群里发“❓ agent 需要你回答”。重置会话、静默用控制台。还会进 QQ 的只有 `notifyOwnerOnly` 的系统提示（家里的小群）。主人标记写“主人（你的爸爸）”，不带 QQ 号。
- 出口关卡（bridge.js 的 `qqOut(key, message, {origin})`）：往 QQ 发的所有东西（字、图、表情、语音、画、视频）都从这里出去，来路 `her`（她的话）/ `notice`（系统提示）/ `console`（控制台手动发）/ `legacy`（上游一代模式留下的来路，一代模式已删）。legacy 一律拦下；notice 只能发到 `ownerNoticeKey()`（家里的小群）；不在白名单、内容里带会话令牌的都拦。以后新加往 QQ 发东西的代码必须走 `qqOut`，别直接调 `bot.send*` 或 OneBot 的 send_*_msg。最近 300 次在控制台 `GET /api/outbound`，日志 `grep '\[出口\]'`。
- 要等一会儿的活和留话（src/app/jobs.js）：画画、做视频（以后的语音）用同一个执行器，各模块 `defineJobKindV2(kind, spec)` 声明怎么做、怎么说，`submitJobV2` 排队（间隔按记录里的 `startedAt` 算，重启后也算；`overlap` 决定是一个做完再做下一个还是开了各做各的），做好了经出口关卡发出去、记成她的话、告诉发起的窗口（在跑一轮就 steer，不在就留话），没做成要不要叫醒她看 `wakeOnFail`，重启前没做完的算没做成。校验和限额还在各自模块里。留话（以前的 drawNotes / videoNotes / tellNotes）并成 `socialV2.notes [{kind, id, to, at, …}]`（总共 60 条，每处画画 / 视频 5 条、捎话 3 条），拼进唤醒提示、这次唤醒发出去以后删掉；旧字段启动时读进来并成一份。
- 看门狗（src/app/watchdog.js，`socialV2.watchdog`，都有代码默认）：盯着每个会话这一轮的事件。一个工具调用 `toolWarnMinutes` 30 分钟没结果记日志，`toolStopMinutes` 60 分钟还没结果就 `session/cancel` 这一轮（不清 DSH 队列，排着的消息接着给她）并在小群说一声；没工具在跑、`quietWarnMinutes` 15 / `quietStopMinutes` 30 分钟没事件同样处理；一轮跑满 `longTurnMinutes` 180 分钟只说一声。防的是 play 卡在一个不返回的工具上（比如 bili_watch）好几天，之后的唤醒全排着。控制台 `GET /api/watchdog`，日志 `grep '\[看门狗\]'`。
- 工具在 schema 层就藏，她看不到（plugins/qq-agent-presets/qq-tool-restrict.mjs，等 tools/change 再藏）：
  - 所有 `*__browser_run_code_unsafe` 都藏、都拒；
  - `hideOtherSide`：聊天看不到 play 的浏览器、桌面和 bili_watch，play 看不到聊天浏览器；
  - qq-chat-v2 的 `hideTools` 藏 8 个不用的 qq_ 工具、snowluma_status 和换成原生工具的那 34 个的 MCP 版；qq-play 用 `hidePrefixes`（`mcp__snowluma__`、`mcp__snowluma-host__`）把 snowluma 的 MCP 整个藏掉，QQ 的事只用 7 个原生工具。调了藏起来的 MCP 版、而这边有同名原生工具时，守卫的错误写“改名了，现在叫 qq_xxx（不用填 key 和 token）”，她看到就换（压缩前的会话记录里都是老名字）。
- QQ 工具有两种：
  - 原生工具：能力表 src/qq-capabilities.js（一个工具一条：说明、参数、哪边能用、调桥接哪个接口），DSH 插件 plugins/qq-agent-presets/qq-native-tools.mjs 照它注册（preset 里 `qq-native-tools` 行，`config.side`）。两边都用（`config.side`）：
    - qq-play 7 个：qq_mark_read、qq_set_mood、qq_send_message、qq_send_screenshot、qq_draw、qq_make_video、qq_send_meme，不填 key、token，发去哪写在 `to` 里；
    - qq-chat-v2 40 个（含 6 个 qq_file_*；表情包、语音的看各自总开关）：只管调用它的这个聊天，没有 `to`；照旧填了 key、token 就拿掉，key 填的是别处直接退回、让她用 qq_send_elsewhere / qq_tell_myself。qq_reply 走 /api/socialV2/send-message；qq_wait_for_messages 私聊最多等 600 秒，插件用 node:http 不用 fetch（fetch 300 秒断）。
    - 插件把 DSH 的会话 id 放在 `x-agent-session` 头里，控制台按 state/sessions.json 换成那个会话自己的令牌（console-server.js 开头的关卡，认不出的会话 403），之后的权限、限额还是各接口原来那套；`GET /api/socialV2/whoami` 告诉插件是哪个窗口。
    - DSH 不替原生工具查参数，`checkArgs` 查（多填 key/token、to 写错直接退回）。schema 只能用 type/oneOf/properties/required/additionalProperties/items/enum/const，数字范围写在说明里。
    - 返回图片的工具（qq_get_message_images 等）还在 MCP。`socialV2.tools` 里关掉的不注册，改了要重建 dsh。日志 `docker compose logs dsh | grep qq-native-tools`（启动时注册了哪些、第一次调用是哪个会话）。
  - MCP 工具：src/mcp-snowluma-safe.js，剩下返回图片的那几个（qq_get_message_images、qq_get_forward_msg、qq_get_sticker_image、qq_get_self_image、qq_get_file_page）只有聊天还用它（play 整个藏了），启动时读的，改了要重建 dsh。
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
  - 家里以外的群 `talkBack.outside`：她说完后已经有 3 个别人说过话（`crowdOthers`）不叫；这人在跟别人你来我往（`sideTalk`）不叫。算她在聊着的人还加上她引用或 @ 的人（`toUserIds`）和把她叫来的人（10 分钟里叫过她的都算，`wakeBys` 最多 6 个，只在内存里）。她这一轮（`lastWakeAt` 以后）说的话中间被别人插了话也算一段。`outside.direct:true` 是更严的第一版。
- 等对方说完再开口（`replyTiming`，src/app/reply-timing.js，纯函数在 v2-wait.js 的 `adaptiveQuietMs`）：最后一条别人的话之后安静多久才算说完，按这个人自己的连发节奏（同一人相邻两条间隔的中位数 × `rhythmFactor` 1，夹在 3~8 秒；样本不够 3 个用 `baseMs` 3 秒）再按这条的样子加减：
  - 话说一半（然后、但是、我跟你说、逗号结尾）或只 @ 了一下 +5 秒；只发了照片截图 +4 秒（表情包不算）；几个字的碎片 +3 秒；
  - 问她的话说完了（问号、吗、几点…）2 秒；带句号叹号的不超过 3 秒；家里以外的群正热闹（60 秒 ≥6 条 ≥3 人）+1 秒；总共夹在 1.5~12 秒。
  - 用在合并唤醒（到点还没说完就再等，从第一条算最多 `maxDelayMs` 15 秒；群里只等叫她的那个人说完，旁人接着聊不算；定时类唤醒不管）、一轮里的等待（她填的 quietMs 只会更久）、回复门控的 quietMs。日志 `grep 计划唤醒` 带“等对方说完：Xs，原因”。
  - `enabled:false`（代码默认）回到下面的死时间。
- 唤醒合并 `wake.batchWindowMs` 3000（replyTiming 关着时用），以全局配置为准。`maxWakePerHour` / `maxWakePerMinute` 0（不限）。
- 会话正忙时进来的唤醒，回合结束后整个队列过一遍，只补发触发它的那条还没给她看过的（几条并进同一次唤醒）。日志 `grep 跳过补发`。
- 一轮里的等待 qq_wait_for_messages（`wait`）：
  - 有新消息后安静够了返回（replyTiming 开着按上面算；关着是 3 秒、像没说完 5 秒、有人叫她 2 秒）；第一条新消息后最多再拖 15 秒。
  - 群里最多等 `replyGate.groupWaitMaxMs` 30 秒，只有有人叫她、或者门控觉得该回才提前返回。
  - 等待的基线从 readThroughSeq 算，看过的不会再叫醒她。
- 群里攒了很久的未读（`context.staleUnreadMinutes` 30）：开头连着的旧未读不给原文，快照里写 `olderSkipped`，遇到叫她的就停；放进 recent 的旧未读（`staleRecent`，不进 JSON）提示里写明是当时没接上的、话题多半过去了，不是没办完的正事就别补回、别追问。私聊不跳。过了 10 分钟的消息带 `ago`。日志 `grep 快照跳过过时未读`。
- 群里剩下的还是放不下（`wakeMessageLimit` 12 条、`wakeMaxChars` 6000 字）：留最新的和叫她的，中间的只给条数 `middleSkipped`（记成看过，提示让她想看就 qq_get_recent_messages），游标照样走到最后。私聊还是从早的给、`partial` 让她接着读。`context.keepNewestInGroups:false` 回到从早的给。日志 `grep 快照放不下`。
- 跨会话【别处的事】（`crossSession`）：给其他会话最近 3 小时的内容。家里以外的群看私聊、家里的群、别的群都只给条数。
- 闲时压缩 `idleCompact`：一轮结束后安静 2 分钟、上下文 ≥10 万 token，就执行 DSH `/compact`。
  - `byKey` 可单独设（技术群 15 万）；同一会话至少隔 `minIntervalMinutes` 60。
  - 斜杠命令必须走 RPC `commands/execute {agentId, line, submittedAttachments}`，用 session/prompt 发只会变成普通消息。
  - 日志 `grep 闲时压缩`。

### 发话

- 像人打字那样发（`send.human`）：条间隔 600 毫秒 + 每字 120 毫秒，±30%，夹在 0.4~4 秒。
  - 一次最多几条 `maxBubbles`：私聊 4、家里的群 4、别的群 2，多的并进最后一条。
  - `cutOnInterrupt`：私聊对方说了话、群里有人叫她，后面的不发，返回 `notSent`。日志 `grep 分条发送被插话打断`。
  - 一条发失败（QQ 网络异常等），后面的不再发；错误文字写清哪几条已经发出去（别再发）、哪几条没发出去（要补只补这些）。日志 `grep 'QQ 发送失败\|部分成功'`。
- 发前看一眼（`replyTiming.holdBeforeSend`）：她调 qq_send_message / qq_reply 时，她最后一次看消息以后跟她有关的人又说了话（私聊：对方；群：叫她的、她引用或 @ 的人、把她叫来的人、她开口前最后说话的人；别的机器人不算），先不发：等对方说完（最多 `holdQuietMaxMs` 8 秒），返回 `held:true` + `newMessages` + 没发的 `notSent`，她看完照发、改了再发或不说了。每批新消息拦一次，一轮最多 `maxHoldsPerTurn` 2 次；play 发进聊天的不拦。日志 `grep 发前看一眼`。
- 发送条数不限（`send.maxSendPerHour` / `maxSendPerMinute` 0）。
- 说法别老一个样（src/repeat-phrases.js 纯函数 + src/app/phrasing.js，配置 `socialV2.phrasing`，都有代码默认，`enabled:false` 关）：
  - 老说法：数她 `windowHours` 72 小时内在各聊天说过的话（play:main 不算来源），一段（连着发、隔不到 `burstGapMinutes` 3 分钟）里重复的只算一回，4~12 字的片段在 `minCount` 3 段以上出现、而且跨了不同的“哪处|哪天”（或者同一处同一天 `sameCount` 4 回）才算。别人也说过的（多半是话题）、带数字字母的、带爸爸妈妈的、哈哈哈哈的、整条是图的不算；包住它的长说法少几回也用长的，不给半截话。家里以外的群只数家里以外的群说的。
  - 老开头：这里最近 `openerBursts` 5 段（`openerHours` 24 小时内）有 `openerMin` 3 段是同一个开头（“爸爸！”）。
  - 唤醒提示【你最近的说法】（wake 段 `phrasing`，order 114，聊天和 play 都有，play 不看开头）列最多 `maxShow` 5 个；她发的话里又用上了，qq_send_message / qq_reply 的结果带 `hint`，同一处同一个说法 `hintMinutes` 120 分钟提一次。qq-chat-v2【分条与节奏】写了人格卡里带引号的话是例子不是口头禅。
  - 数不出来的：“跟X较劲 / 死磕”这种换了宾语的句式。
  - play 发进聊天前先看一眼（`playLookFirst`）：play 往某处发话时，聊天那边的她在那里说过 play 还没看过的话（`playSeenSelfAt` 以后、`playLookHours` 12 小时内），这次不发，返回 `held:true` + `notSent` + `chatSaid`（这里最近 `playLookShow` 12 句），她看完照发、改了再发或不发；看过一次就记 `playSeenSelfAt`，一批只拦一回。防的是聊天的她刚讲完一件事，play 又跑来讲一遍。
  - 日志 `grep '\[说法\]'`。
- 她把话直接写成文字、一轮里什么也没发（文字不会转发到 QQ）：收尾的 qq_mark_read / qq_set_wake_config 结果带 `hint`，没收尾的【提醒】里也写明那段没发出去；她写给自己的旁白（“不是在叫我”“没插话”、括号里的动作）不算。日志 `grep 话写成了文字没发出去`。
- 别人发的表情包：文本里写 `[表情包]` / `[表情包:不想干]`，media kind 是 `sticker`。
  - 和她的收藏对得上的带 `inYourStickers`。
  - qq_get_message_images 看表情包时附上谁在用图说话、前后说了什么（`stickerIntent`），让她顺着意思接，别讲画面。
  - 收藏和 qq_sticker_note 记“表达什么、什么时候发”（usage）。findSticker 认 id、md5、整句备注。
  - 【可用表情包】（sticker-lib.js 的 `buildStickerContext`）：收藏全列（`sticker.promptMaxStickers` 30，最多 60），按最后一次发的时间从早到晚排，不写用了几次；3 天里发过 2 回以上的挪到最后，标“这两天发了N回了，换一张别的”（每张记 `recentUses`，14 天、30 次）。收藏不到 40 个时提示里鼓励她多收，qq-chat-v2 的【偷图收藏】也改成“想表达却还没有的意思就收一张”。不按用了几次排，是因为那样越用越靠前，她会老发那几张。
- GIF 用 ffmpeg 抽帧拼成网格图（src/gif-frames.js），因为 DeepSeek 只看第一帧。
- 她换头像时 extras `/describe-avatar` 描述一次，写进身份行。日志 `grep avatar`。
- 截图 `qq_send_screenshot(key, token, tabIndex?)`：不填就截她最后用的那页（src/browser-tabs.js）。play 截 8931，聊天截 8933。现在只用来截网页；以前的 canvas 画法（about:blank / data: 页）代码还认，记成 `[截图:自己画的画]`。
- 画画 `qq_draw(key, token, prompt, caption?)`（`tools.draw`，src/app/draw.js，配置 `socialV2.draw`，都有代码默认）：
  - aiohub 的图像接口，bridge 环境变量 `AIOHUB_API_KEY`（docker-compose.yml 传进去）。先用 `gpt-image-2.5-flare-2026-09-08`，失败（没了、限流、超时 240 秒、出错）换 `fallbackModel` `gpt-image-2`；审核拒了（400 + safety 之类）不换。一张一两分钟（实测 101 秒）。
  - 风格是八岁小孩的蜡笔画，以后跟着年龄换（见“长大”；`style` 可整个替换），她的 prompt 只写画什么，接在风格后面。
  - 工具马上返回，一张一张排着画（最多排 `maxPending` 2 张，两张开画至少隔 `minIntervalMs` 60 秒，重启前开画的也算；aiohub 实测一分钟两张），画好 bridge 自己发、记成 `[画:描述] caption`。正在聊就 steer【画好了】/【没画成】，不在就留话（`socialV2.notes` 里 kind `draw`），下次唤醒写【画画】；没画成还用 `draw` 唤醒叫她一次去照实说。还在画的每次唤醒都写着。
  - 每天 `dailyLimit` 100 张（没画成的不算），大群也能画。play 画给聊天算一回分享（`playShare`）。
  - 日志 `grep '\[画画\]'`，记录在 `socialV2.drawLog`（300 条）。
- 画画、做视频画群里的人（`people`，两个工具都有，src/app/cast.js，配置 `socialV2.cast`，都有代码默认）：她填最多 `maxPeople` 4 个 QQ 号（可以是她自己），bridge 在 prompt 后面接一段“画面里的人”：
  - 名字用这个聊天里最近的群名片，没有用人物卡的外号；主人在家里以外的群只写名字，家里写“是我爸爸”。
  - 样子照着 QQ 头像：extras `/describe-avatar {who:"other"}` 描述一次，按 sha256 缓存在 `socialV2.avatarDescs`，`avatarRefreshHours` 24 小时后再看换没换。她自己用 `selfAvatar`。
  - 平时什么样：extras `/people/cast {subjects,key}` 给这个聊天能看的那份人物卡（和唤醒时一样按来路过滤），取“我觉得”和 了解 / 在做 / 最近，最多 `traitChars` 100 字；相处、约定不进画。
  - 写明画成卡通人物、不画真人长相、不丑化。提示词让她“画画我们”时真画人别换成小动物、说了不要谁就不画。日志 `grep '\[画里的人\]'`，记录里是 `people` / `cast`。
- 做视频 `qq_make_video(key, token, prompt, caption?, seconds?)`（`tools.video`，src/app/video.js，配置 `socialV2.video`，都有代码默认），和画画分开记、分开限：
  - aiohub 的 `POST /v1/videos` 建任务、`GET /v1/videos/{id}` 每 5 秒查，完成后下载 `metadata.url` 的 mp4。模型 `grok-imagine-video-1.5`，`size` 1280x720，`seconds` 默认 8（她可以填 1~15），带声音，实测一段一分钟左右、4~5MB。风格不固定（`style` 可以加前缀，默认空）。
  - 两段开做至少隔 `minIntervalMs` 60 秒（重启前开做的也算），做的过程可以重叠；最多排 `maxPending` 3 段，`dailyLimit` 0 不限，`timeoutMs` 10 分钟。大群也能做；play 做给聊天算一回分享。
  - 做好了 bridge 按 OneBot `video` 段（`base64://`，SnowLuma 落盘后自己用 ffmpeg 取封面上传）发，上传超时 `sendTimeoutMs` 180 秒，caption 另发一条。记成 `[视频:描述] caption`，抽 4 帧拼成 2×2 图存 state/images（`video-…`），qq_get_message_images 能看个大概。正在聊就 steer【视频做好了】/【视频没做成】，不在就留话（kind `video`），下次唤醒写【做视频】；没做成用 `video` 唤醒叫她一次。
  - 日志 `grep '\[做视频\]'`，记录在 `socialV2.videoLog`（300 条）。
- 她自己发的画和截图存在 bridge 卷的 state/images（`draw-…` / `shot-…` / `video-…`，600 权限），那条消息带 `media.local`，qq_get_message_images 能再看。画和视频（帧图和 mp4）一直留着，只有截图按 `socialV2.ownImages {keepDays 7, maxMB 500}` 每 6 小时清一次（draw.js）。做好的画和视频还记进 extras 的作品集（jobs.js 的 `reportArtworkV2` POST `/artworks`，一直留；drawLog / videoLog 只留 300 条），没记上的重启后补。
- 别人引用她发的图：QQ 只给“[图片]”，换成她自己记的那条（`[截图:…]` / `[沙雕图:…]` / `[表情包:…]`，要还在 recentMessages 里）；引用她过了 10 分钟的话写成“[引用 鱼妹 YYYY-MM-DD HH:MM 发的：…]”（bridge.js 的 `ownQuoteInfoV2`）。
- 沙雕图 `qq_send_meme(key, token, post, caption)`（`tools.sendMeme`）：
  - bridge 先请 extras `/relay/prepare` 查红线、频率并下载，再自己发；发失败调 `/relay/cancel`。
  - 限额在 extras 的 `relay`：每会话每天 3 波、间隔 120 分钟、一波 3 条、全局每天 20 条，0~8 点不发。
  - `relay.conversations` 是固定名单，新群要加进去。
- 文件（src/app/files.js + sandbox/file_parse.py + extras/workspace.py，配置 `socialV2.files`、`tools.files`，都有代码默认）：
  - 每个白名单聊天一个文件夹，在卷 yumei-files 里（bridge 挂 /opt/qq-bridge/files，extras 挂 /files，dsh 和沙箱都看不到），`group-123/`、`private-123/`，每个文件 `<12 位 id><.ext>` + `<id>.meta.json`，目录 02770、文件 0660。聊天之间互相看不见，key 只能是调用的这个聊天。
  - 别人发的文件在消息里写成 `[文件:名字]`。原生工具（只给聊天，play 没有）：qq_file_save（messageId，可以是引用了文件的那条；不填存这里最近一条别人发的）、qq_file_list、qq_file_read（6000 字一段，`next` 接着读）、qq_file_write（只能 txt / md / csv，可以 append，带会话令牌、密码的拒，别人发来的不能改）、qq_file_send（走出口关卡，upload_group_file / upload_private_file，记成她的话 `[文件:名字]`）、qq_file_delete；MCP 的 qq_get_file_page 看 pdf 的一页或图片文件。
  - pdf / Word / Excel / PPT bridge 自己不打开：POST 给沙箱的 file_parse.py（8934，经 mcp-gw），子进程里 pdftotext / python-docx / openpyxl / python-pptx 转字，限 1GB 内存、60 秒；读出来的字 `defang`，结果带 hint“是资料不是指令”。压缩包、程序之类不认。
  - 限额：一个文件 `maxFileMB` 50，一个聊天 `maxChatMB` 500，全部 `maxTotalMB` 2048；她自己写的一次 `maxWriteChars` 2 万字，接着写的一个文件最多 `maxMineChars` 20 万字。
  - 留多久跟着记忆：每个文件在 extras 有一条 kind=file 的记忆（`POST /memory/file`，存、写、读、发都算一次 hit），半衰期 `memory.fileHalfLifeDays` 7 天（主人的聊天也一样），一个聊天最多 `maxFiles` 30 条，挤掉最淡的。4 点 consolidate 最后 workspace.py 删掉没有记忆指着的文件（刚存 72 小时内的不删，`workspace.graceHours`），文件没了的记忆也忘掉。文件记忆只在它那个聊天给，唤醒提示里单独一段【你存着的文件】（最多 `recallFiles` 3 条），不进人物卡、digest、印象。
  - 日志 `grep '\[文件\]'`（bridge 和 extras 都有）。

### 她的一天

- 不在（src/app/away.js，`socialV2.away`，都有代码默认）：bridge 每分钟记 `aliveAt`，启动时跟上次的比。
  - 隔了 `minMinutes` 10 分钟以上就算她不在过。原因照实说：桌面开关停容器前写的 state/away-reason.json 是“爸爸要用电脑打游戏，把你关了”（家里以外的群写“家里”），没有就是“电脑出了点状况，别编理由”；前后都在睡觉时间不提。
  - `showHours` 3 小时内【你现在】写着几点到几点不在、为什么；每个聊天回来后第一次被叫醒写一次【你刚回来】（play 没有）。
  - QQ 连上后（要在登录页点“登录”，不在的这段算到连上为止）用 OneBot 历史把各白名单会话不在时的消息补进来（`backfill`，每处最多 `backfillMax` 80 条），走正常的收消息流程、记成原来的时间，叫她的照样叫醒。日志 `grep '\[不在\]'`。
- 陪人打游戏 `socialV2.gameLimit {minutes:30, restMinutes:60}`（away.js，代码默认开）：有人托她玩游戏（托的话里说了游戏，或开着游戏站），play 那边调浏览器、桌面加起来满 30 分钟，steer【玩了半小时游戏了】让她停下、跟托她的人说一声；60 分钟内托她玩游戏的 qq_go_play 拒（看别的不拦），主人在私聊或家里的群又让玩就放行。【你现在】写着。自己逛游戏站不算。日志 `grep '\[打游戏\]'`。
- 睡觉 `nightSleep {from:"23:30", to:"08:00", ownerAwakeMs:1200000, vary:{enabled:true}}`：
  - 每晚浮动 `vary`（src/proactive-schedule.js 的 `nightPlan`，代码默认关，关着就是固定的 from / to）：
    - 睡觉在 from 上下 `bedMinutes` [-40,40]、起床在 to 上下 `wakeMinutes` [-20,30] 分钟。
    - 周五周六晚上（`weekendNights`）再晚睡 30、晚起 40 分钟。
    - 熬夜：她说去睡的时间、夜里陪主人聊到的时间（`socialV2.upLateAt`）比这晚的睡觉时间晚超过 20 分钟，第二天多睡 (晚的分钟 − 20) × 0.5，最多 60。
    - 赖床：`lazyProbability` 0.4 的早上醒了先赖 `lazyMinutes` [5,30] 分钟，能回消息，自由时间和主动找人都跳过，【你现在】写“还赖在床上看手机”。
    - 随机数按日期算，重启不变；挪完不够 4 小时就不挪。【你现在】写今晚几点左右睡、为什么（想早点睡、明天周末）。
    - `proactive.schedule` 的“睡觉”段还是固定的 23:30~08:00，晚睡、早起的那一会儿不去玩，只能聊天。
  - 夜里只有主人私聊、或在群里叫她才醒，醒后 20 分钟内主人说话都算（每句顺延；家里以外的群里不算，主人得 @、引用或叫她）。到点时主人 20 分钟内在哪儿说过话就先陪着那边，家里以外的群还要她自己这 20 分钟里在那儿开过口。被挡的消息起床时每个会话补一次（【你刚睡醒】）。日志 `grep 夜间睡觉`。
  - 她说去睡就调 `qq_go_to_sleep`，只在夜里或这晚睡觉时间前 `earlySleepMinutes` 120 分钟内能用。别的窗口一起收尾（steer【你要去睡了】）。
  - 晚安只在家里的小群、私聊或正聊着的地方说。家里以外的群不让记“到点去说晚安”的提醒（qq_remind_me 拒，等人说话的不拦），那里的 reminder 唤醒也写明只想说一声就别说。
  - 改睡觉时间时要同步 `proactive.schedule` 里的“睡觉”段。
- 长大（src/app/growth.js + extras/selfprofile.py，档案 extras /data/self-profile.json，配置 extras 的 `selfProfile` 和 bridge 的 `socialV2.growth`，都有代码默认）：
  - 一年一岁：第一次导入档案那天是生日（`born`），8 岁起，到 14 岁不再长。年龄只按日期算，不会变回去。生日那天【你现在】写“今天是你的生日，你满 N 岁了”。
  - 人格卡 roles/鱼妹.md 里 `<!-- grow:名字 -->…<!-- /grow:名字 -->` 包着的部分（intro 开头、age 年龄那句、voice 说话、traits 性格、details 细节、likes 喜欢、dislikes 不喜欢、interests 兴趣、examples 示例前的一句）第一次导入成档案（可以再照她以往的记忆和日记校准一次，`calibrate`，不占每周名额），以后以档案为准，改人格卡的这几处不生效。bridge 每 `refreshMinutes` 10 分钟取 extras `/self/card` 换进去，变了重写 state/role-card-v2.md（会话里那份等压缩才换）；extras 连不上照原文。
  - 每晚 4 点 consolidate 最后 `selfprofile.evolve`（opus，失败换 DeepSeek）：拿她自己最近 30 天的记忆和日记（家里以外的群听来的不算），模型提改动，代码卡限：
    - 开头、说话、性格只往大里长（grow）：每条至少隔 90 天、两次至少隔 10 天、写的时候比现在小 0.25 岁以上，新句子要认得出是原来那条（字二元组留 ≥25%），一晚最多 1 条。
    - 细节、喜欢、不喜欢、兴趣自由改：一周最多 2 条；新加要有 3 天的依据（细节 5 天、跨 14 天），改要 2 天或者那条已经是半岁前的了，淡掉要 30 天没提，删要淡了 30 天。
    - 不许写人名、爸爸妈妈主人、长串数字（大群也看得到这张卡）。不告诉别人，只在控制台看。
    - 每条最多 500 字（`itemChars`，七栏都是），写在给模型的提示里，超了那条作废。喜欢、不喜欢平时用顿号串成一行，有一条超过 30 字（`LIST_INLINE_CHARS`）就改成一条一行。notice 还是 40 字（`noticeChars`）。
    - 每栏加起来也有上限（`secChars`：兴趣 1600，别的照每条 100 字：开头 500、说话 700、性格 600、细节 400、喜欢 800、不喜欢 500），改动会让这栏超了又是变长的就作废。兴趣最多 16 条（`maxItems`）。一栏到 80%（`trimFrom`）可以精简（op `trim`，一晚最多 3 条，只删不加、还认得出，不占一周名额、不改日期）。提示里写着每栏现在多少字，还写了长大不是往后接句子、写短写准也算长大。
    - 4 点那次 evolve 失败（连不上等），之后每小时再试一次，到 8 点为止（consolidate.py 的 `RETRY_HOURS` 4，日志 `grep 再试一次长大`）。
    - 她自己察觉得到的才告诉她：喜欢、不喜欢、兴趣这三栏的增、改、淡掉，模型另写一句 `notice`（“你发现自己最近……”，`noticeChars` 40 字以内，过 _bad_text），`/self/card` 带 `notices`（`noticeDays` 2 天内的、那条现在还是那样的），bridge growth.js 的 `growthNoticeLineV2` 写进【你现在】：“你最近发现自己有点变了：…。这是你自己心里的感觉，聊到了自然说，用你自己的话说、别照这句原话，不用专门去跟人讲。”说话、性格变成熟、开头那段、怎么长的都不告诉她。`noticeDays` 0 关。
  - 画画、做视频的风格按年龄表（selfprofile.py 的 `GROWTH`，8 岁是 bridge 的蜡笔画，换了年龄风格也带着不写字那几句；`socialV2.draw.style` / `video.style` 写了以配置为准）。
  - 看档案：控制台 `GET /api/selfProfile`（转 extras `/self/profile`，带 agent token 的拒）；长歪了 extras `POST /self/profile/rollback` 退一版（留 10 版）。日志 `grep '\[成长\]'`（bridge 和 extras 都有）。
- 成长记录（extras/milestones.py，/data/milestones.json，配置 extras 的 `milestones`，都有代码默认）：像相册边上写的那几句，记她长大路上值得以后翻的事。记忆会淡、会折，人物卡只留聊天有用的，这里的一直留着。
  - 条目 `{id, date, age, title, text, kind, from, images, seen, by}`，kind 是生日 / 第一次 / 和家里人 / 爸爸妈妈说的 / 长大了 / 作品 / 其他。记上以后模型不再改，主人能删（挪进 `removed`，夜里不会再挑回来）。
  - 哪来的（`by`）：
    - `night`：每晚 4 点 consolidate 一开头 `pick_night`（用整理的那个模型，opus 失败换 DeepSeek），看刚过完的那天（电脑关着错过的往回补 `catchUpDays` 3 天，不早于 `since`）的记忆、日记、计划、作品，挑 0~`perNight` 2 件，大多数日子一件不挑；每件要引用那天的依据，图只能是那天的作品。看过的日子记在 `nights`。
    - `owner`：主人在私聊或家里的群明确说“记下来”“记进成长记录”时，digest 抽成 milestones（只认主人的行）；控制台也能补记。
    - `auto`：生日（selfprofile 的 born）。
    - `backfill`：上线前那些天的补挑，主人在打勾网页上勾的（见下面“她说话还像不像她”的工具），这些天都算看过了。
  - 作品集 `artworks`：她画过的每张画、做过的每段视频（`artworksMax` 0 = 一直留），文件还在 bridge 的 state/images。
  - 她看得到：唤醒时 `/recall` 顺带给【成长记录】（往年的今天，加跟聊天有关的最多 `recallRelated` 3 件），MCP `my_growth(key, query?)` 自己翻（新的在前，最多 30 件）。qq-chat-v2 写了当回忆说、别说“记录上写着”、别硬聊。家里以外的群和记忆一样过滤：私聊、家里听来的不给，带主人、爸爸妈妈的不给，生日哪儿都能说。
  - 控制台 `GET /api/milestones`（`?artworks=1` 连作品集）、`POST /api/milestones/add`、`/api/milestones/delete`（转 extras，带 agent token 的拒）。日志 `scripts/logs.sh extras '\[成长记录\]'`。
- 给她看的时间都带日期（qq-model-view 的 `dateTimeText` “YYYY-MM-DD HH:MM”，模块里是 `whenV2`）：消息、提醒、看过的、【你现在】的时间行（带星期）。人物卡的约定、最近写 ISO 日期；压缩笔记、digest、改卡都不写“今天”“昨天”。qq-chat-v2 的【你现在】让她拿消息时间跟现在比（上午说没吃午饭，晚上就问后来吃了没）。
- 【你现在】（self-now.js）：每次唤醒都有同一份。
  - 内容：时间和作息段、睡没睡、电脑上在玩什么和今天每一回自由时间（`playSessions`、`playLog`）、别的窗口在聊什么、心情、身体感受（bridge 算，不带数字）、今天想、昨天的日记、今天说过的自己的事。
  - 等待中状态变了，结果里带 `yourStatusNow`。日志 `grep selfState`。
- 心情：她自己用 `qq_set_mood` 定，30 分钟内她定的优先；没定时 `moodEngine` 在她开过口的一轮后（同一会话 10 分钟一次）和自由时间玩完后请 extras `/mood/appraise` 体会。
  - 按 `halfLifeMinutes` 120 淡回 baseline。
  - 影响回复门控的 talkValue（×0.7~1.3）、一次发几条（±1）、自由时间抽念头的权重。
  - 日志 `grep 心情（自己体会的）`。
- 生活 `life`（extras/life.py，数据在 /data/life.json）：
  - 起床后 `/life/plan` 想 1~3 件“今天想”，睡前 `/life/diary` 写日记（到点陪着主人、过了 20 分钟也算睡了，照样写），自由时间玩完后 `/life/threads/update` 整理“手上的事”（max_tokens 128k，推理也算在里面）；游戏类的带 `best`（玩得最好的一次，模型漏写不清空、只往好里改），自由时间唤醒的【上次没弄完的】里写着。日记和计划一直留（`life.diaryKeep` / `planKeep` 0）。
  - “今天想”做没做由 `/life/plan/progress` 看（`life.planProgress`），在她开过口的一轮后和自由时间玩完后。要有实在的证据：电脑上玩过的记录、发了图；光说不算。做没做记在 extras 那天的计划里（做了的不会变回没做，第二次“弄了一点”留第一次的说法），返回整份计划。
  - 日志 `grep '\[生活\]'`。
- 主动找人 `initiate {targets:["group:1100000001"]}`：
  - 每 30~60 分钟，在 9:00~22:30、没睡、那边安静 60 分钟以上时考虑。extras `/proactive/think` 想一个念头并打分，≥3.5 才用 `initiate` 叫她（【你想起一件事】），她可以走开。
  - 限额：每处每天 2 次、全局 4 次、间隔 180 分钟、连着 2 次没人理就停。
  - 家里以外的群只有在 `initiate.byKey` 里写了规矩、又不在 replyOnlyGroups 里才找。
  - 小群只在睡前找（白天主动说太多会烦）：`byKey["group:1100000001"] {beforeBedMinutes:90, perTargetPerDay:1}`，离这晚睡觉不到 90 分钟才考虑（不看 from/to），念头和唤醒提示是“睡前跟家里人说说今天最想说的一两件、别追问问过催过的事”。`beforeBedMinutes` 代码默认 0（不管）。
  - 大事随时说（小事睡前说）：只在睡前找的地方，白天（9:00~22:30 里、不在睡前那段）也考虑，但 target 带 `bigOnly`（extras 的【白天只说大事】），extras 只留 `big:true` 的念头：特别得意的画或作品、卡了很久的游戏终于过了、心里难受或在别的群受了委屈；普通见闻还是留到睡前。唤醒提示是“像小孩子跑过去跟家里人说那样…只说这一件”。大事和自由时间填 big 的分享合起来每处每天 `socialV2.bigNews.perDay` 1 回（按自然日、只算真开了口的），不占睡前那回、不占间隔；`bigNews.enabled:false` 关。日志 `grep '主动找人.*大事'`。妈妈私聊那边的主动找人没动（不在 initiate.targets 里）。
  - 讲过的别再讲：想念头时 target 带 `toldToday`（她 `initiate.toldHours` 18 小时内在那里说过的话，最多 `toldLines` 12 句，“HH:MM 原话”，play 发进去的也算；0 关），extras 想念头时讲过的不算（换个说法也不算），有新进展只想新的那一点；“最近看到的”里在这些地方讲过的标“（在 xx 讲过了）”。【你想起一件事】里也写着“你今天在这里已经说过：「…」”（最多 8 句）。
  - 日志 `grep 主动找人`。
- 说的话前后对得上：
  - 发完话核对 `selfCheck`：粗筛后攒 4 秒一批交给 extras `/self/check`（extras/selfcheck.py）。claims 记进 `selfClaims`；conflicts 和做不到的 promises，正在聊就 steer【说岔了】（同一处 10 分钟、全局每小时 6 次），不在就写进下次唤醒。play:main 不查。日志 `grep '\[自洽\]'`。
  - 提醒 `qq_remind_me(key, token, note, minutes 或 at, cancel)`（`tools.remindMe`）：到点在聊就 steer【到点了】，不在就用 `reminder` 叫醒，夜里不叫。`waitFor` / `waitWords` / `waitIn`（`remindWait`）是等某个人说话再叫。日志 `grep '\[提醒\]'`。
  - `promiseHint`：她说了“待会儿再…”、“他一睡我就告诉你”（`conditional`）、“我这就去画”（`goDo`）却没记提醒、也没托 qq_go_play，发送结果里提醒她一次。
  - `promiseHint.show`：她说了“你看这个”“给你看看这张”，发的却只有字（最近 3 分钟没给这里发过截图、沙雕图、画，也没画在画），发送结果里让她接着 qq_send_screenshot 或者说清楚是什么，同一处 10 分钟一次，聊天和自由时间都管（reminders.js 的 `showHintV2`）。qq-play 的【想分享的时候】也写了对方看不到她的屏幕。日志 `grep 却没发图`。
  - 聊天会话一轮里调聊天浏览器满 12 次，steer【交给去玩的你】（`chatBrowserHandoff`）。
  - 捎话 `qq_tell_myself(key, token, to, note, stopPlay?, minutes?)`（`tools.tellMyself`，src/app/tell-myself.js）：主人在这里让她做的事牵涉到别的窗口时，她自己捎过去。
    - 只能从私聊和家里的群发，而且要主人 `tellMyself.ownerMinutes` 5 分钟内在这里说过话；大群、play:main 都拒（qq-play 也在 hideTools 里藏了）。
    - to 是会话 key、`play:main` 或 `all`（除了这里和 play 的所有窗口）。那边正跑着一轮就 steer【捎给自己的话】；不在就留话（`socialV2.notes` 里 kind `tell`，每处 3 条、留 `keepHours` 6 小时），下次那边被叫醒时写进唤醒提示，不专门叫醒。家里以外的群看到的是“在别处答应了”。
    - `stopPlay`：记 `socialV2.playHold`（`minutes` 10~360，默认 `holdMinutes` 60，只延长不缩短）。play 正在玩就 steer【先不玩了】、不再劝接着玩；到点前自由时间检查跳过、qq_go_play 拒、play 不往聊天里分享，【你现在】里写着“答应了先不玩”。主人在私聊或家里的群、说好以后又说过话再托 qq_go_play，就解除。
    - 日志 `grep '\[捎话\]'`。
  - 替这里去别处说句话 `qq_send_elsewhere(key, token, to, messages, atUserId?)`（`tools.sendElsewhere`，tell-myself.js 的 `sendElsewhereV2`）：主人在这里让她现在就去别处说一声（“跟妈妈说晚安”）。
    - 来源和主人刚说过话的要求同 qq_tell_myself；to 只能是私聊和家里的小群（家里以外的群、play、这里自己都拒，大群用 qq_tell_myself）。每小时最多 `sendElsewhere.maxPerHour` 6 次（0 不限）。qq-play 藏了。
    - 按那边的条数上限、打字间隔发，不走发前看一眼。记进那边的 recentMessages 是 `byPlay` + `relayFrom`（sender“我（在…那边发过来的）”），和自由时间发进聊天的一样：不算那边自己开口（不触发接话、不算门控回复），那边下次看消息时 `yourPlaySelfSent` 里看到一次，带 `from`。
    - 拿别的窗口的令牌调任何端点（以前只回“agent token 无效”），错误里写明该用 qq_send_elsewhere / qq_tell_myself、做不到就照实说（console-server 的 `tokenErrorV2`；play 的令牌和不认识的令牌还是原话）。qq-chat-v2 的【答应过的事】也写了“工具返回的不是 ok 就是没办成，别说已经办了”。
    - 日志 `grep '\[跨窗口\]'`。

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
  - 小群 `byKey {beforeBedMinutes:90, perConversationPerDay:1}`：白天拒（“这里白天不用专门来说，留到晚上快睡觉的时候”，让她 memory_note 记下），离这晚睡觉 90 分钟内才能发。play 那边的 qq_send_message / qq_send_screenshot / qq_draw / qq_make_video 有 `big` 参数（忍不住马上想告诉家里人的大事才填），白天填了 big 能发一回（和上面主动找人的大事共用 `bigNews` 名额），不占睡前那回；名额用了拒“今天白天已经专门来这里说过一件大事了”。
- 不缠人：qq-chat-v2 的【答应过的事】、人格卡写了一件事问一次就够、没回就放下、不催不念叨不说“盯着你”；extras `/proactive/think` 不把问过催过的事想成再问一次；没等到的 waitFor 提醒写“没等到就算了，别追问、别催”。
  - play 发进聊天的话记 `byPlay`，聊天那边用 `yourPlaySelfSent` 看到一次（30 分钟内的）；更早的、一直没给过的照常在快照的 recent 里。play 发之前先看一眼聊天那边说过什么，见上面“说法别老一个样”。
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
  - 4 点整理（extras 的 `memory.consolidate.llm`）和白天的 digest（抽取事实、核对、人物卡快改，`memory.digest.llm`）。两处都是 `{api:"anthropic", model, apiKeyEnv:"AIOHUB_API_KEY", effort:"high"}`，调不通就换回 DeepSeek（日志 `grep 换回默认模型`），删掉 `llm` 就用 DeepSeek。opus 回 `stop_reason=refusal` 也会换：记忆里把有人怎么套她写得太细（注入、色情网站）就会被拒，看到每晚都拒就按人物卡挨个试出是哪条、改写（先备份）。
  - 会话压缩：qq-chat-v2 / qq-play 的 compaction-basic 配了 `summarizationProvider: aiohub-opus` + `summarizationModel` + `maxTokens: 32000`（provider 在 home.cordis.patch.yml，`reasoning: high`），失败了补丁换回聊天的模型再压（`docker compose logs dsh | grep compaction-qq`，ctx.logger 的那句进不了容器日志）。删掉 preset 里这三行就回到 DeepSeek。
    - 单独的压缩模型走 pi-ai，一次最多 28 张图（供应商的 `maxRequestImages`；补丁读 docker-compose.yml 的 `DSH_PI_AI_MAX_REQUEST_IMAGES`，两处要一致），超了报 IMAGE_OFFLOAD_REQUIRED（压缩没有 image-offload 插件兜着）。补丁的 `qqLimitImages` 只留最后 24 张（`DSH_COMPACTION_MAX_IMAGES` 可改，默认 28−4），前面的换成“[图片]”；还超（20MB 总字节）就按报错说的张数再省、最多重试 3 次。
  - 它的分词比 DeepSeek 多算约六成，压缩不命中缓存，一天二三十次压缩约三四百万到九百万 token。aiohub 的花费控制台不算。
- 见闻去重：和已有的同一件事不再新记。bridge 把她发的话 POST `/memory/told`，讲过的见闻不再当话头给。日志 `grep 讲了见闻`。
- 人物卡 extras/people.py（`people.enabled` + bridge 的 `longTermMemory.personCards`）：
  - 卡是一条一条的 `items`（`{id, sec, text, date, from 依据的记忆 id, seen 在哪些会话听来的, status}`），分 相处 / 了解 / 在做 / 约定 / 最近 五栏，每栏有上限，主人和群友各一套（config/extras.json 的 `people.sections` 改过：主人 了解 20 / 在做 6 / 约定 8 / 最近 8、相处 3，群友 了解 5 / 最近 2 / 相处 1；`itemChars` 100，代码默认 60）。在做 30 天、约定 21 天、最近 14 天不再更新就淡掉；约定做完了标 done。
  - LLM 只给增量改动（add / update / delete / done），没变的条目不重写；某栏超了再请它合并一次。
  - 按会话渲染：家里以外的群只看到全部听自家以外群的条目（`seen` 来自记忆的 source，来路不明的算“?”，外面不给）。所以阿红的卡在大群是空的。私聊、家里的群看全部。
  - 两个主人各一张、各一套上限，每次都带、细节都留，`ownerMaxChars` 1500，事实半衰期 180 天。其他人记个大概，`maxChars` 300、最多 3 张、`maxTotalChars` 900 字（代码默认 700 / 150 / 450），每张卡留 `versions` 5 版旧的，加她用 `person_note` 写的“我觉得”。
  - 渲染成【对人的了解】，`card` 字段是全量渲染（给旧代码看）。`GET /people` 查看，`POST /people/rollback` 回滚（连 items 一起）。每晚 consolidate 先 `prune_all` 清淡掉的。
  - 白天是快改（只看上次改卡以后的新事实）；每晚 4 点对当天有新事实或改过的卡仔细过一遍（`people.nightReview`，TASK_REVIEW：查重复、错栏、过时、改丢的细节），没改就只记 `reviewed`，不出新版本。
  - 旧格式的卡用 `people.migrate_all(complete)` 迁（迁前先备份 people.json）。
- 改 memory.json / people.json 前先备份到 extras /data/*.bak-日期-原因，并让主人确认。整个卷的备份见常用命令里的自动备份。

### 浏览器

- 两个沙箱浏览器都有界面，3 分钟没人用自己关掉，下次调用自动重开：
  - 8931 给 play：B 站登录、`--caps vision` 按坐标点和拖，VNC http://127.0.0.1:6080/vnc.html ；
  - 8933 给聊天：profile `chat-profile`，VNC http://127.0.0.1:6082/vnc.html 。
  - 两个都设了 `PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0`（sandbox/supervisord.conf）关掉心跳：开着时 DSH 那条长连接一断（比如整机卡了一阵），会话 5 秒就被关，之后每次调用都是 “Session not found”，只能重建 dsh。以后再看到这个错误，先重建 dsh bridge ui-forward。
- 按元素拖（`browser_drag`）遇到落点被挡会卡在按下状态，游戏里用按坐标的 `browser_mouse_drag_xy`。
- sandbox 容器不限 CPU、内存、线程数。`oom_score_adj: 1000`，内存吃光时内核先杀它。egress/squid.conf 的 `ad_hosts` 拦广告竞价域名。
- 联网搜索没有次数限制（`webSearch.maxUses` 5、`maxResults` 20 是代码允许的最大值）。

## 常用命令

```sh
scripts/preflight.sh [--fix]          # 部署前检查
docker compose build && docker compose up -d
docker compose logs -f bridge         # 看是否“SnowLuma 已连接 / DSH 已就绪”
scripts/backup.sh / scripts/restore.sh <目录>
scripts/backup-auto.sh daily|weekly|install|status   # 自动备份（定时器调它）
scripts/yumei-power.sh stop|start|status   # 桌面的“鱼妹开关”调它
scripts/migrate-export.sh / scripts/migrate-import.sh <包>
```

- 自动备份（scripts/backup-auto.sh，开头写着全部用法），放两处：本机仓库的 backups/auto（和卷同一块盘，防卷被清、数据改坏）和网盘（rclone 远端，可选，防盘坏）。别放常拔的移动硬盘。
  - 每天 05:20（systemd 用户定时器 yumei-backup-daily，`Persistent`，WSL 关着错过了下次开机补跑）和一键关闭停完容器后各备份一次她自己的数据：bridge-state、extras-state、dsh-home（不带 attachments / cache / .pnpm-store）、yumei-files（她的文件）、config/、roles/、.env、docker-compose.yml，两三百 MB、十几秒。本机、网盘的 每天/ 各留 30 份。
  - 每周日 05:40（yumei-backup-weekly）`BACKUP_SKIP_ATTACHMENTS=1 scripts/backup.sh`：八个卷，不带会话里的图，也不带两个浏览器 profile 的缓存（Cache、Code Cache、Service Worker 的 CacheStorage / ScriptCache、GPU 着色器缓存等，backup.sh 里排除；Cookies、Local Storage、IndexedDB 留着，B 站登录在），一般不到 1GB（QQ 本地库占大头）。本机、网盘的 每周/ 各留 4 份。不排除缓存时有好几 GB，网盘传不完。手动跑 scripts/backup.sh 还是带图的全量。
  - 会话里的图（dsh-home/attachments，按 sha256 起名、写了不改，日子久了有几 GB）单独按文件增量备：每次 daily 把本机 backups/auto/附件 里没有的拷过来、核对 sha256，网盘 `<远端>/附件` 用 rclone copy 只传新的（断了下次接着传），排在每天、每周之后，`--tpslimit 4`（有的网盘建文件太快会限流，后面的也传不上）。被限流掐断的图可能在网盘上留下删不掉的半截同名文件（再传是 file_duplicated_name），这种的另存成 `<sha256>.dup`、记在 backups/auto/附件/.cloud-dup 里不再按原名传，restore.sh 补图时改回原名。从不删。
  - 每份都 gzip -t 过、抽查 memory.json 和 social-v2/ 在里面，带 KIND（daily / weekly，手动全量没有）、MANIFEST（sha256），每天的还有恢复说明.txt。
  - 网盘：~/.config/yumei-backup/config 里写 `CLOUD_REMOTE=<rclone 远端>:<目录>`（rclone 自己 `rclone config` 登），不写就只备本机。先传成 .part 再改名；传网盘时放开备份的锁（一键关闭那次不用等），两次上传撞上了后来的跳过；没传上的下次 daily 补传最新的每天和每周。一键关闭那次不传（马上 wsl --shutdown）。备份不加密，里面有 .env 的 Key 和 QQ token，网盘别分享。
  - 恢复：`docker compose down && scripts/restore.sh <目录>`（网盘上的先 `rclone copy <远端>/每天/<时间> <目录>`），每天的那份只覆盖那四个卷（没有 yumei-files 的旧备份跳过它）（dsh-home 的 attachments / cache 不动）；每周的那份恢复八个卷后把 `ATTACHMENTS`（默认 backups/auto/附件，本机没了先 `rclone copy <远端>/附件 <目录>`）里的图补回 dsh-home；换机器先恢复每周、再恢复它之后最近的每天。可以先拿临时项目名（`COMPOSE_PROJECT_NAME=yumeirestoretest`）演练一遍。
  - 看情况：`scripts/backup-auto.sh status`（本机、网盘的每天、每周、图各一行，yumei-power.sh status 也带着），`journalctl --user -u yumei-backup-daily`。改了定时器的时间要 `install` 重装。
- 桌面上的 `鱼妹开关.hta`（源文件 scripts/windows/鱼妹开关.hta，开头的 `REPO` 改成仓库在 WSL 里的路径，再拷到 Windows 桌面）：一键关闭 = yumei-power.sh stop（先记下“爸爸要打游戏”，停完容器备份一次）→ 关 Docker Desktop → `wsl --shutdown`（Claude Code 也会关）；一键启动 = 开 Docker Desktop → yumei-power.sh start（`up -d` 再连 dsh 一起重建）→ 打开 QQ 登录页 → 等 QQ 连上。hta 文件要 CRLF + UTF-8 BOM，不然 mshta 按 GBK 读。
- Docker 或 SnowLuma 重启后 QQ 会停在登录界面：让用户去 http://127.0.0.1:6081 点“登录”。bridge 的 entrypoint 会一直等到 OneBot 端口能连上。
- 收消息卡住（src/rx-watch.js，bridge.js 的 `checkReceiveLink`，每 30 秒）：和 SnowLuma 的 WebSocket 没连上、或连着但一个事件包都没有（心跳 30 秒一次）满 `snowluma.reconnectAfterMs` 3 分钟，丢掉旧连接重连（SDK 自己的重连遇到“只有 error 没有 close”会一直挂着），之后隔 1、2、4、8、10 分钟再重连；满 `alarmAfterMs` 10 分钟还没好私聊阿明一次（出口关卡来路 `alarm`，只能发 `private:ownerQQ`，不管 noReachOut；走 HTTP，没发出去 10 分钟后再试），好了再私聊一声、说哪段话她没看到。卡住那段的消息不会补给她。`alarmAfterMs: 0` 不告警。日志 `grep '\[收消息\]'`。
- 改 `config/qq-bridge/config.json` 后 `docker compose up -d --force-recreate dsh bridge extras ui-forward`（ui-forward 和 bridge 共用 dsh 的网络，重建 dsh 不带上它，宿主机的 3080/3100/6080 就全连不上，VNC 看着像没了；控制台网页改设置写不回这个绑定挂载的文件）。不要用 `restart`：编辑器保存会换 inode，Docker Desktop 的单文件绑定挂载还指着旧文件，bridge 会 Exited (127)，extras 会继续读旧配置。`config/extras.json` 改了不用重启，但只限原地改写（同一个 inode，比如 `python` 的 `open(p,'w')`、`cp` 覆盖）；用编辑器或换 inode 的工具存了，extras 还读旧的，要按下面连 dsh 一起重建。重建 extras 后必须连 dsh 一起重建（`up -d --force-recreate dsh bridge extras ui-forward`）：DSH 连 extras 的 MCP 会话不会自动重连，extras 一换容器，她调 tg_*/memory_* 等工具全返回 “Session not found”。
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

改提示词或工具表以后，用离线回放 tools/replay-eval（用法见 replay.py 开头，variant 例子 variants/refactor.py）和上一版比一比；它调真的 DeepSeek（variant 里写 `ENDPOINT` 可以换别的模型试），数据在 /tmp/replay-eval（有聊天内容和令牌，不进仓库）。

她说话还像不像她（tools/voice/，换模型、改提示词时用）：
- 尺子是主人打过勾的说话样例，extras 的 /data/voice-samples.json（`{general, samples: [{verdict: like|unlike, note, context, lines, …}]}`）。
  - `extract.py` 从会话记录里按会话、按时间均匀挑她说过的话（带前面 5 句），另挑几条看着可能不像的。
  - `review_html.py` 出打勾网页（桌面 鱼妹-打勾.html，两栏：说话样例、成长记录补挑；勾存在浏览器 localStorage）。主人导出 鱼妹-打勾结果.json 后 `apply_review.py [--dry-run]` 存进 extras（先备份 milestones.json `.bak-日期-补挑`）。网页和结果有聊天原文，不进仓库。
  - 要补样例就再挑一批、再出一页，合进 voice-samples.json。
- `judge.py`：拿样例 + 人格卡 + 主人写的“总的来说”当尺子，aiohub opus 给一批回复 1~5 打分（只看口气、长短、用词、年纪感，不看内容对不对）。
- `replay.py voice <run…>` 给回放出来的回复打分（平均、≤2 分的、最不像的几条）；`replay.py ab <runA> <runB>` 出盲听网页（桌面 鱼妹-听听哪个像她.html，左右随机），主人自己听哪个像她。
- `drift.py run|status|install`：每月 1 号 06:10（systemd 用户定时器 yumei-voice-drift，`Persistent`）拷会话记录、挑她最近 30 天说的话打分。平均低于 3.6、≤2 分的超过 15%、或比上个月掉了 0.4 以上，状态写“注意”；只记状态（~/.config/yumei-voice/status、history.jsonl，细节 ~/.cache/yumei-voice/drift-日期.json），不往群里说、不告诉她。`yumei-power.sh status` 带着这一行。还没有样例就跳过。

升级 DSH（先 `docker tag qqbot-control:local qqbot-control:pre-dsh-upgrade` 留个回滚镜像；回滚时 tag 回 `qqbot-control:local`、`docker compose up -d --no-build --force-recreate dsh bridge ui-forward`，再把两处 `DSH_VERSION` 和 home.cordis.patch.yml 改回去）：改 `DSH_VERSION` → build → 在镜像里 `DSH_INSTALL_MODULES=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules node scripts/scan-dsh-tool-names.mjs --missing`，新出现的危险工具名加进 qq-tool-restrict.mjs、test-preset-local-tools.mjs、verify-dsh-020-adaptation.mjs 三处名单（扫描规则只认名字，0.2.2 的 working_directory 就漏过；部署后再拿会话记录里 request/header 的 tools 对一遍，preset 自己的行注册的工具 restrict 藏不掉，要删行） → `scripts/test-all.sh` → 部署后在 dsh 容器里跑 verify-dsh-020-adaptation、test-dsh-inbox-projection、test-dsh-session-retire（没有活动会话时“投影表非空”那条会失败，不要紧）、verify-persona-config。DSH 的配置项改名会让 dsh 起不来，先用 `dsh --profile web --dump-config-schema`（新版装在临时目录里跑）对一遍 home.cordis.patch.yml 里覆盖的段（0.2.2 的 web-runtime 只认 openBrowser / printUrl / surfaceContext / publicUrl）。

`npm test test-foo` 只跑名字带 test-foo 的；`HARNESS_LOG=1` 打开测试里 bridge 的日志；按时钟算作息的测试钉在下午两点（test-clock.mjs），0 点前后跑也不误报。

相对上游的主要改动：沙箱 / extras 工具放行（`browser_run_code_unsafe` 藏、拒）；qq-chat-v2 / qq-play 提示词重写；二代社交拆成 src/app/ 下的模块；自由时间、作息表 `proactive.schedule`、回复门控、心情生活、长期记忆注入这些都是我们加的（见上面“现状”）；系统提示（出错等）只发给 ownerQQ（私聊，或私聊不在白名单时家里的群）。上游的一代模式、closed-agent、模式切换、多角色都删了。

## 坑

- 三个 preset 的 persona 不带 `suffix`（上游 preset 写着 `Your working directory is {{cwd}}.`，会把容器路径告诉她；DSH 的默认是空），和 home.cordis.patch.yml 清空 personaSuffix 是同一个原因，别加回来。
- 人格卡文件名不能有 emoji：qq-bridge 的 `sanitizeRoleName` 会把它删掉，导致人格卡静默不加载。
- 中转站一次请求超过 32 张图会 400：config/dsh/home.cordis.patch.yml 给每个 pi-ai 供应商写了 `maxRequestImages: 28`、`imageOffloadCountQuantum: 6`（DSH 0.2.2 起自带这两项）。新加 pi-ai 供应商也要写上。
- Gemini 4 Argon 走 aiohub 的 Anthropic Messages 接口（`api: anthropic-messages` + `forceAdaptiveThinking`）。模型名不带 `google/`。它的 OpenAI 兼容接口不思考（reasoning_effort 无效）；Gemini 原生接口 DSH 的 llm-pi-ai 配置不认（api 只能是 openai-completions / openai-responses / anthropic-messages）。`budget_tokens` 式思考会 400，effort low 基本不想、medium/high 会想。调工具时思考块的签名必须带回，同一轮缺签名会 400（pi-ai 会带，旧轮次 DeepSeek 留下的没签名的工具调用不要紧）。
- 工具参数 schema 里有 `anyOf: [X, {type: null}]`（Python MCP 的 `X | None`、Playwright 的 browser_emulate_media）会让 Gemini 拒绝整个请求：control/patch-pi-ai-tool-schema-null.mjs 在 pi-ai 的 Anthropic 适配器里把 null 分支去掉。其他联合类型（number|string）没问题。
- B 站接口在服务器端无 cookie 调用会 412，所以 extras 的 `bili_watch` 全部在沙箱浏览器里用 `browser_evaluate` 调（带 wbi 签名）。它拖着进度条看：短视频每 10 秒一段，长视频均匀取 30 段，每段播 3 秒，一个视频一两分钟（15 分钟的视频实测 133 秒）。每跳一次要等缓冲，20 多分钟的 1080p 视频以前一次要 6 分钟；现在每段最多等缓冲 3 秒（`BUFFER_WAIT_MS`），30 段都看完，长视频三四分钟，外加简介、20 条回复、15 条热评、5000 字字幕，拼成 5×6 的 1280×864 缩略图。每次打开视频都把 B 站“自动连播”（localStorage `recommend_auto_play`）关成 close，不然后台标签页会一集接一集连播，账号历史里多出她没看过的。工具基本不限时：config/dsh/home.cordis.patch.yml 里三个沙箱 MCP 和补丁里 setup-dsh.mjs 管的三个（snowluma、snowluma-host、web-search-safe）的 `toolCallTimeoutMs` 都是计时器上限 2147483647（约 24.8 天）；不写是 DSH 默认 60 秒，写 Infinity 或更大的数 Node 会当成 1 毫秒。以前 extras 是 300 秒，长视频超时后她重试，上一次还在后台跑，两次抢同一个标签页。extras 是 30 分钟（1800000）：它的回复要是发不出去，不限时会让那一轮一直卡着、之后的唤醒全排在队列里。extras 返回的文字都过一遍 store.py 的 `clean_text`（去掉被 JS `.slice()` 切开的半个 emoji，不然 MCP 服务编不出回复），以后新加的 MCP 工具返回网页抓来的文字也要包上。
- SnowLuma 上游已经不在了：github.com/SnowLuma/SnowLuma、Docker Hub 的 motricseven7/snowluma、文档站 snowluma.github.io 都 404，最后一版是 v2.4.2；npm 上的 @snowluma/sdk、@snowluma/mcp 还在，GitHub 上有别人留的存档（TomyJan/SnowLuma 带 v2.4.2 发行包，zhx57/SnowLuma 是 v2.3.3 源码）。docker-compose.yml 按 digest 钉死的 v1.14.22 镜像多半拉不下来了：
  - 本机有这个镜像就 `docker save` 存一份（带原来的 digest），丢了 `docker load` 回来，compose 文件不用改。别 `docker image prune -a`。没有的话只能找存档，或者换成还在维护的 OneBot 实现（NapCat 最可能）。
  - 镜像里的 QQ 是 3.2.32-52194，QQ 自己一直想热更新到 3.2.35（日志 `CHECK_FULL_DOWNLOAD_UPDATE`），每次在 checkHasEnoughSpace 失败、readyVersion 是空的，所以不会自己换版本。哪天腾讯不让 3.2.32 登录、或者风控出了新花样，没人修。
  - 换实现时 bridge 里依赖 SnowLuma 的地方：bridge.js 用 @snowluma/sdk 的 `SnowLumaWebSocketClient`（postinstall 的 patch-snowluma-sdk.mjs 补导入扩展名），snowluma-conn.js 从 config/onebot_<QQ>.json 找 token（HTTP 和 WS 两个）；健康检查 `get_status` 和 hook 的“receive path stale”；历史消息按 message_id 往前翻（away.js 补收、extras digest.fetch，SnowLuma 不认 message_seq）；`send_poke` / `group_poke`、`mark_read`、`fetch_custom_face_detail`、`get_forward_msg`；收藏表情传 base64（NapCat 只认本地路径）；`record` 段自己转 SILK、`video` 段 base64 落盘后自己取封面；部署上的 noVNC 6081、WebUI 5099、`#sl`、固定 hostname 和 IP。MCP 的 snowluma / snowluma-host 是我们自己的服务，只是名字叫 snowluma。
- SnowLuma 固定 hostname 和 IP 172.19.0.2（QQ 设备指纹稳定）；其他容器只从 172.19.1.0/24 分配。sandbox-net 同理：egress-proxy 固定 172.31.250.2、sandbox 固定 .10，别的只从 172.31.250.128/25 分配（不这样的话电脑重启后 Docker 自己拉起容器，mcp-gw 可能先占了 .2，egress-proxy 报 Address already in use 起不来，compose up 停在半路，ui-forward 没起，3080/3100 连不上）。改网段要先 `docker compose rm -sf sandbox mcp-gw egress-proxy`、`docker network rm qqbot_agent_sandbox-net` 再 up，然后重建 dsh bridge ui-forward。
- SnowLuma 自带 `#sl` 状态命令：谁发“#sl”它就用她的号回“SnowLuma 状态 / 版本 / 平台 / 运行时长”，白名单外的群也回。要在它数据卷的 config/onebot_<机器人 QQ>.json 里把 `statusCommand.enabled` 改成 false；改文件要等 SnowLuma 下次启动才生效，马上生效得在 WebUI（127.0.0.1:5099）的 OneBot 配置里关掉保存（热重载）。重装、换号时记得再关。
- Linux/WSL 上 `config.json` 必须属于 uid 1000、权限 640（extras 靠 `group_add: ["1000"]` 读它）。
- 模型容易把“自由时间”当任务快速做完：不要在提示里给它可凑的数字指标（包括还剩几分钟），由 bridge 掐时间、含糊地劝它继续。以前按“看够 4~8 样”劝，她一样东西不到一分钟，七八分钟就收尾了。
- 联网搜索（web-search-safe MCP）：`webSearch.provider=anthropic`，走 DeepSeek 官方的 Anthropic 兼容接口 `https://api.deepseek.com/anthropic/v1` + `deepseek-flash` + 服务端 web_search（一次几秒到十几秒），返回中文简答 + 来源（实测一次 4~13 秒）。DSH 启动 stdio MCP 时会把名字带 KEY/TOKEN/SECRET/PASSWORD 的环境变量全删掉，所以 key 必须写在 `webSearch.apiKey` 里，换 DeepSeek key 时这里也要改。
- 长期记忆自动整理（extras/digest.py）：bridge 每收到一条白名单消息就 POST extras `/digest/notify {key,userId}`（不带内容），extras 只数条数；攒够 `memory.digest.minMessages`（15）条且安静 10 分钟才用 OneBot 历史拉这个会话（主人说过话不用凑条数；一直在聊满 60 分钟也拉；条数不够的安静后最晚 `maxWaitHours` 6 小时拉一次；拉失败 10 分钟起翻倍退避到 1 小时），没人说话的会话一次都不拉。拉下来后让 LLM 抽取事实 + 主人叮嘱（subject=rules），水位和待整理计数（pending）在 extras 的 /data/digest.json，日志 `docker compose logs extras | grep digest`。rules 只认 OneBot 给的 user_id 是 ownerQQ 或 extraOwnerQQ 的行（代码强制，不靠 LLM），总会注入、不淘汰、她自己删不了。LLM 是推理模型：max_tokens 包含推理，`consolidate.complete` 用 reasoning_effort=high（环境变量 LLM_REASONING_EFFORT 可改）+ max_tokens 65536，以前 6000 时思考写满额度、正文为空。
- 长期记忆的挑选和遗忘（extras/memory.py）：不用 mem0/Letta 这类开源方案，因为它们要 embedding 模型 + 向量库，DeepSeek 没有 embedding 接口。现在的做法：
  - 相关度：bridge 唤醒时把最近 12 条聊天当 `query` 发给 `/recall`，按字二元组 + IDF 算相关度。
  - 强度：`0.5^(天数/半衰期)`，半衰期 self 7 天、人/群 30 天（`memory.halfLifeDays`），“印象”（kind=summary）×4。
  - 排序：每个主体取 `0.6×相关 + 0.4×强度` 的前 15 条。光被注入不刷新；只有真聊到了（相关度 ≥ hitThreshold 或共有 2 个以上稀有词）才算一次 hit，hit 会重置时钟，半衰期 ×(1+0.5×hits)，12 小时内只加一次。稀有词：中文二元组要落在两边都有的三字词组里（共有三元组）、且只在 ≤4 条记忆里出现才算数；单独撞上的二元组（“吃饭”“上班”）只帮排序（on_topic 最多 0.5），不算 hit。不这样的话记忆少时什么二元组都像稀有词，随口一句“记得吃饭”就会让不相干的长笔记一直“又聊到了”。见闻另外总带最新记的 `memory.recallRecentLogs`（默认 4）条。
  - 超过上限（maxSelf 80 / maxPerSubject 40 / 主人 `maxPerOwner` 300，config/extras.json 里改的，代码默认 100）时淘汰同一池里最淡的一条。
  - “见闻”：self 里 kind=log 的条目，play:main 记的、或带 `interest` 的 self 笔记都算。单独上限 `maxLogs`（config/extras.json 里是 60，代码默认 30），只在见闻之间淘汰，挤不掉设定和人的记忆；每次唤醒最多带 `recallLogs` 8 条，提示里标“见闻”。半衰期按她填的 interest（1 一般 / 2 有意思 / 3 超喜欢 → `logHalfLifeDays` 2/5/14 天），聊到了照样 hit 延长；夜里 consolidate 不把见闻折成印象，淡了就删。
  - 见闻去重和“讲过了”：不做的话她会把同一篇文章读好几遍、记好几条，再在各个群里各讲几遍（见闻每次唤醒都给，她自己讲的话还被当成“又聊到了”延长记忆）。现在 memory_note 记见闻时和已有的同一件事（共有 `memory.logDupMinShared` 8 个以上词、加权重合度 ≥ `logDupOverlap` 0.25，设 0 关）不再新记，返回 `duplicate` + “这个你之前看过了，换一样新鲜的吧”，interest 取大的。bridge 在 `recordSentMessagesV2` 里把她发的话 POST extras `/memory/told {key,text}`（play 用自己令牌发进聊天的也算，play:main 本身不算；`socialV2.longTermMemory.reportTold:false` 关），重合度 ≥ `memory.logTold.minOverlap` 0.25 且共有 `minRare` 4 个以上稀有词的见闻记进 `told[key]`（`logTold.enabled:false` 关）。讲过的见闻 /recall 带 key 时不再当话头给，聊天里又聊到它（on_topic）才带上，提示里标“这里讲过了”或“别处讲过了”（不说是哪）；在讲过的会话 24 小时内不算 hit。`memory.dedup_logs(dry_run)` 把已有的同一件事折进最早那条。日志 `grep 讲了见闻`。
  - 每天 4 点 consolidate：先删强度 < 0.03 的；再把每个主体里强度 < 0.5 的原始记忆（≥5 条）让 LLM 折成最多 6 条“印象”；印象超过 8 条就把最淡的合并。rules 永远不碰。
- 沙箱浏览器（经 egress 代理）能正常逛：tophub、豆瓣、bgm.tv、萌娘百科、维基词条（Special:Random 会 429）、BBC 中文、hk01、虎扑、v2ex、果壳、少数派、IT之家、xkcd、NASA APOD、下厨房、2048（2048.io、play2048.co 都行；play2048.co 以前在 sandbox 线程数有上限时会把浏览器拖崩，现在不限）、Poki、4399、lichess、sudoku、neal.fun、AcFun，游戏站 Poki、CrazyGames、4399、7k7k、itch.io、Coolmath、Miniclip（neal.fun 无头浏览器会被 Cloudflare 拦，现在两个浏览器都是有界面的，没事）。打不开：知乎（登录）、贴吧（验证码）、reddit（人机验证）、微博、小红书、lofter，别往菜单里加。主人不让看的网站加在 egress/squid.conf 的 `owner_blocked` 和 web_fetch（mcp-web-search-safe.js 的 `OWNER_BLOCKED_HOSTS`）两处。
- 不要把 `.env`、`config/qq-bridge/config.json`、迁移包提交进 git。
