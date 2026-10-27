# qqbot_agent：QQ 群里的“仿真群友”

用一个 QQ 小号做一个住在群里的 AI 群友。她自己看群、自己决定说不说话，有作息、心情和记性，闲下来会用一台隔离的沙箱电脑刷 B 站、逛网页、玩小游戏，看到好玩的再回来分享。

示例人设叫“鱼妹”：一个元气小孩，管主人叫爸爸妈妈。人设只是一张 Markdown 卡片（`roles/鱼妹.md`），换掉它就是另一个人。

> **这是模板。** 它从一套长期在用的部署里整理出来，配置、人格卡、测试和文档里的 QQ 号、群号、名字都是示例：
>
> | 示例值 | 含义 |
> |---|---|
> | `1000000000` | 机器人自己的 QQ |
> | `900000001`（阿明，“爸爸”） | 主人（`ownerQQ`） |
> | `1600000002`（阿红，“妈妈”） | 第二个主人（`extraOwnerQQ`） |
> | `1100000001` | 家里的小群（`homeGroups`） |
> | `800000002`、`1000000004` | 大群 |
> | `1100000003` | 技术群 |
> | `4000000009` | 群里另一个机器人（`wake.otherBots`） |
>
> 部署前把 `config/qq-bridge/config.json`、`config/extras.json`、`roles/鱼妹.md` 里的这些换成你自己的。测试里的不用管。

## 目录

- [用到的项目](#用到的项目)
- [她能做什么](#她能做什么)
- [架构](#架构)
- [安全边界](#安全边界)
- [部署](#部署)
- [配置](#配置)
- [日常运维](#日常运维)
- [开发和测试](#开发和测试)
- [升级和回滚](#升级和回滚)
- [花费](#花费)
- [已知的限制](#已知的限制)
- [许可和致谢](#许可和致谢)

另外两份文档：

- [CLAUDE.md](CLAUDE.md)：给 AI 编程助手（也给你）看的现状说明，按模块列出每个开关的配置键、默认值和日志关键字，改东西前先翻它。
- [docs/MIGRATION-WSL.md](docs/MIGRATION-WSL.md)：把整套服务连同 QQ 登录态、记忆搬到另一台机器（比如 Windows + WSL2）。

## 用到的项目

| 组件 | 项目 | 在这里做什么 |
|---|---|---|
| QQ 协议端 | [SnowLuma](https://github.com/SnowLuma/SnowLuma) v1.14.22 官方 Docker 镜像 | 登录 QQ 小号，对外提供 OneBot v11（WebSocket + HTTP） |
| 群聊逻辑 | [qq-bridge](https://github.com/Derpyu520/qq-bridge) v0.2.0-r4 | 二代仿真模式（`reserved2`）。源码在本仓库 `qq-bridge/`，在上游基础上改了很多，自己维护 |
| Agent | [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 0.2.0-rc.2 | 管会话、调模型、调工具（MCP）、压缩上下文。qq-bridge 这一版只适配它 |
| 模型 | DeepSeek 官方 API（`deepseek-flash`） | 聊天、心情、生活、自检、联网搜索。可以换别的供应商，见[配置](#配置) |
| 沙箱 | Chromium（[Playwright MCP](https://github.com/microsoft/playwright-mcp)）+ Xvfb + fluxbox + noVNC | 她的电脑：两个浏览器、一块虚拟桌面，你能在网页里实时看 |
| 附加服务 | 本仓库 `extras/`（Python，MCP + HTTP） | 长期记忆、人物卡、心情和生活、自检、B 站看视频、Telegram 搬图 |

## 她能做什么

### 什么时候开口

一个真人群友不会每条都回。这里的核心是“回复门控”（`qq-bridge/src/reply-gate.js`，思路参考 MaiBot 的 turn_trigger，代码是自己重写的）：

- **私聊**：每条都叫醒她。
- **一定会叫醒她的**：@ 她、引用她、叫她名字或外号、拍一拍她、她自己说过要等的人说话了、主人夜里找她。
- **接话**：她刚说完的几分钟内，刚才在聊的人又说话了，也叫醒她（`replyGate.talkBack`）。她问了人问题，对方回答时也叫。只发表情包的，只有她正在跟着说的那个人才算。约游戏喊人上号、在跟别人你来我往的，不算。
- **其他消息**：攒一小批（3 秒没人再说），用一个逻辑回归估“她会想回”的概率，再按一小时窗口动态调阈值，让回复次数贴近每个群设的 `talkValue`（比如家里的群 0.8、大群 0.15）。可以按时段乘系数（`talkSchedule`）。
- **家里的群和外面的群**：`homeGroups` 里的小群默认每句话都是跟她说的，除非明显在跟别人说；外面的大群只在有人找她时开口（`replyOnlyGroups`）。外面的群看不到私聊和家里群的内容，提到主人只叫名字。
- 被叫来却连着两次没说话，门控会自己退避。

她醒来后不一定马上回：可以用 `qq_wait_for_messages` 再等几秒看对方是不是还没说完，也可以看完就走（`qq_mark_read`），或者设好“下次什么情况再叫我”（`qq_set_wake_config`，比如潜水 30 分钟、只等某个人）。

### 怎么说话

- **像人打字**：长话拆成几条，每条之间按字数停顿（`send.human`）。一次最多几条有上限，私聊和家里的群 4 条、大群 2 条。发到一半对方插话了，后面的就不发。
- **表情包**：她有自己的收藏，能看懂别人发的表情包在表达什么，也能用 `qq_sticker_note` 记下“这张什么时候发”，挑着发（`qq_send_sticker`），还能收藏别人的（`qq_collect_sticker`）。
- **引用、拍一拍、截图**：`qq_reply` 引用某条回，`qq_send_poke` 拍人，`qq_send_screenshot` 把浏览器当前页截给大家看。她画画的方式是在空白页用 canvas 画满再截图。
- **沙雕图**：从配置好的 Telegram 频道挑图搬进群（`qq_send_meme`），有严格的频率限制。
- **语音**（默认关）：从你准备好的音频目录里挑一段发。
- **黑话**：群里的新词、梗会被记下来，她能查（`qq_slang_query`）也能自己补充。

### 看得懂什么

- 文字、图片（模型直接看图）、表情包（标成 `[表情包]`，附上前后文让她顺着意思接，而不是描述画面）、GIF（抽帧拼成网格图，因为 DeepSeek 只看第一帧）、合并转发、引用、B 站链接（带 BV 号，她能去看）。
- 每次被叫醒，给她的提示里有一份“本次消息快照”：最近的上下文、谁说的、多久以前、哪些是攒了很久没接上的旧话题（会标明“话题多半过去了”，免得她去追问半小时前的事）。

### 她自己的一天

她有一个连续的“自己”，每次被叫醒，提示里的【你现在】都是同一份：现在几点、处在作息的哪一段、睡没睡、电脑上在玩什么、今天玩过几回、别的窗口在聊什么、心情、身体感受、今天想做什么、昨天的日记、今天跟别人说过的自己的事。

- **作息**：23:30 到 8:00 前后睡觉（`nightSleep`）。开了 `vary` 每晚早睡晚睡、起床早晚各浮动几十分钟，周末晚睡晚起，熬了夜第二天多睡会儿，有的早上还会赖床（能回消息，不去玩）。夜里只有主人私聊、或在群里叫她才会醒，醒了 20 分钟内主人说话都算；被挡住的消息第二天早上每个会话补一次。她说“去睡了”就真的调 `qq_go_to_sleep`，其他窗口一起收尾。
- **心情**：她可以自己定（`qq_set_mood`）；没定的时候，她说过话的一轮之后、玩完一次之后，由 extras 根据刚发生的事体会一下，随时间慢慢淡回平常。心情会影响她多爱说话、一次说几条、闲时想玩什么。
- **生活**：起床后想 1~3 件“今天想做的事”，做没做要有实在的证据（真的玩过、发了图），光说不算；睡前写一篇日记，第二天看得到；手上没做完的事会记着。
- **主动找人**：白天她安静了一阵子，会想起一件事、自己打个分，够有意思才去家里的群说一声，也可以想想作罢。每天次数有上限，连着两次没人理就不找了。

### 自由时间

她有一个和聊天分开的会话 `play:main`，用另一个浏览器，两边互不耽误：

- 每 30~60 分钟看一次要不要去玩，按作息表的概率决定。每次给她 3 个随机念头（B 站、沙雕图、新闻、热榜、网页小游戏、百科、番剧、论坛、天文图、菜谱、科普、查好奇的东西），最近玩过的少给，她喜欢的那类多给。
- 每次随机定一个最少玩多久（15~30 分钟），由 bridge 掐表、含糊地劝“再玩会儿、玩深一点”，从不告诉她还剩几分钟。给模型数字它就会凑数，一样东西不到一分钟就换。
- B 站视频不是看标题：`bili_watch` 在沙箱浏览器里拖着进度条真的看，抽帧拼成缩略图，再加上简介、热评、字幕一起给她。看过的记着，两周内不重看。
- 看到有意思的记成“见闻”，回头聊天时可能当话头讲。想分享可以直接发进群，但有频率限制（一次自由时间一回、同一个群至少隔 3 小时）。
- 聊天时有人让她去看个东西，她用 `qq_go_play` 托给“去玩的自己”，看完再回来说。只有主人托的才会用 B 站账号点赞、投币、评论。

### 记性

记忆分三层：

1. **会话本身**：每个私聊、每个群各一个 DSH 会话，模型看得到完整的上下文。太长时压缩成中文第一人称笔记（日期写死，不写“今天”“昨天”），闲下来时也会主动压一次。
2. **长期记忆**（extras）：按“主体”存，`self`（她自己）、`qq:QQ号`（某个人）、`group:群号`（某个群）。
   - 白名单会话攒够 15 条、安静 10 分钟后，从 OneBot 历史里自动抽取事实、主人的叮嘱（只认主人本人说的话，一直生效，她删不了）。
   - 每次唤醒按“和最近聊天的相关度 + 记忆强度”挑一些注入。强度按半衰期变淡，真聊到了会变强、时钟重置。没用向量库：DeepSeek 没有 embedding 接口，所以用字二元组 + IDF 算相关度。
   - 每天凌晨 4 点整理：删掉淡到看不见的，把淡的原始记忆折成几条“印象”。
   - 见闻会去重；她讲过的见闻不再当话头给，免得同一个故事在四个群各讲三遍。
3. **人物卡**：每个熟人一张卡，分“相处 / 了解 / 在做 / 约定 / 最近”五栏，每条带来源和日期，过期的自动淡掉。主人的卡细，别人的记个大概。白天有新事实就小改，每晚仔细过一遍查重复和过时。

记忆按来路隔离：在外面的大群里，她只会想起“在外面听来的”关于别人的事，私聊和家里群里听来的不会说漏。

### 说的话前后对得上

模型很容易说一套做一套：“我这就去画”然后没去，“他一睡我就告诉你”然后忘了。这里做了四件事：

- **自检**：她发完话，extras 拿这段话和她之前说过的、实际做过的对一下（`/self/check`）。说岔了，正在聊就插一句【说岔了】让她自己圆回来，不在聊就留到下次唤醒。
- **提醒**：她能给自己定闹钟（`qq_remind_me`），到点叫醒她；也能“等某个人说话再叫我”。
- **承诺提示**：她说了“待会儿再…”却没定提醒、也没托给去玩的自己，发送结果里会提醒她一次。
- **捎话给别的窗口**：每个群、私聊、自由时间都是各自的会话，私聊里答应了“不玩了”，大群和电脑那边并不知道。主人在私聊或家里的群里让她做的事牵涉到别处时，她用 `qq_tell_myself` 捎过去：那边正聊着就插一句，不在聊就等那边下次被叫醒时看到。`stopPlay` 让电脑那边马上收尾，一段时间内不去玩。大群里不能用，免得被群友带着改别处的事。

### 她的电脑

- 两个有界面的 Chromium：一个给自由时间（登着 B 站），一个给聊天时帮人查东西。你可以在 noVNC 网页里实时看她在干嘛。
- 一块虚拟桌面，能截图、点、滚、打字、按键，没有启动程序的工具。
- 联网搜索（DeepSeek 服务端 web_search，返回简答 + 来源）和网页抓取。
- 聊天时一轮里用浏览器太多次，会提示她“交给去玩的自己”，别把聊天卡住。

### 管理

- 主人（`ownerQQ` 和 `extraOwnerQQ`）能在聊天里发命令：`/status` 看状态，`/silent`（`/quiet`）静默、`/active`（`/speak`）恢复，`/reset`（`/new`）重开当前会话，`/role 角色名` 换人设。
- bridge 有一个控制台网页（:3100）：运行模式、人格卡、各会话状态、令牌和花费看板、手动触发唤醒等。
- 出错（模型返回坏掉的工具参数且自动重试也失败等）只私聊告诉 `ownerQQ`，不会在群里报错。

## 架构

### 容器和网络

全部跑在 docker compose 里，8 个服务、3 个网络：

```
┌──────────────────── egress 网络（能出公网）─────────────────────────┐
│                                                                     │
│  snowluma ◄──── OneBot WS :3001 / HTTP :3000 ────┐                  │
│  (QQ 小号)                                       │                  │
│                                  ┌───────────────┴──────────────┐   │
│                                  │ dsh 容器的网络命名空间        │   │
│                                  │  ├ dsh       DSH :3080        │   │
│                                  │  ├ bridge    qq-bridge :3100  │   │
│                                  │  └ ui-forward 端口转给宿主机   │   │
│                                  └───────┬──────────────────────┘   │
│  extras（记忆/生活/搬图 MCP :8940）◄──────┤ agent-net                │
│  egress-proxy（squid）                    │                          │
└───────┬───────────────────────────────────┼──────────────────────────┘
        │ sandbox-net（internal）           │ agent-net（internal）
        │                                   ▼
        │                     mcp-gw（socat，只把 8931/8932/8933/6080/6082 转进沙箱）
        │                                   │
        ▼                                   ▼
  ┌──────────────────────── sandbox ─────────────────────────┐
  │ 浏览器 A :8931（自由时间，B 站登录）  noVNC :6080          │
  │ 浏览器 B :8933（聊天时查东西）        noVNC :6082          │
  │ 桌面 MCP :8932（截图/点击/滚动/输入/按键）                 │
  │ 根文件系统只读，cap_drop ALL，出网只能走 squid（拒绝内网）  │
  └──────────────────────────────────────────────────────────┘
```

| 服务 | 镜像 | 作用 |
|---|---|---|
| `snowluma` | 官方 `motricseven7/snowluma`（tag + digest 写死） | QQ 客户端 + OneBot v11。固定 hostname 和 IP，让 QQ 的设备指纹稳定 |
| `dsh` | `qqbot-control:local`（`control/Dockerfile`） | DeepSeek Harness：会话、模型调用、MCP 客户端、上下文压缩、Web UI |
| `bridge` | 同上 | qq-bridge：收 QQ 消息、决定叫不叫醒她、拼提示词、执行她的工具调用、发 QQ。和 dsh 共用网络命名空间，彼此走 127.0.0.1 |
| `ui-forward` | 同上 | 把 3080/3100/6080/6082 转到宿主机的 127.0.0.1 |
| `extras` | `qqbot-extras:local`（`extras/`） | 长期记忆、人物卡、心情、生活、自检、主动找人的念头、B 站看视频、Telegram 搬图。既是 MCP 服务（给她调），也有 HTTP 接口（给 bridge 调） |
| `egress-proxy` | `qqbot-egress:local`（`egress/`） | squid：沙箱唯一的出网口，拒绝所有内网地址，拦广告域名和你不让她看的网站，访问日志可查 |
| `mcp-gw` | 同上 | socat：dsh 和沙箱之间唯一的通道，只转几个固定端口 |
| `sandbox` | `qqbot-sandbox:local`（`sandbox/`） | supervisord 管两套 Xvfb + fluxbox + x11vnc + noVNC、两个 Playwright MCP、一个桌面 MCP |

网络的意思是：沙箱碰不到 dsh、bridge、snowluma、extras 和宿主机，只能通过 squid 上公网；dsh 调沙箱只能经过 mcp-gw；所有网页端口只绑宿主机的 127.0.0.1。

数据卷：

| 卷 | 内容 |
|---|---|
| `dsh-home` | DSH 配置、会话记录（zstd 压缩的 jsonl）、模型 Key |
| `bridge-state` | qq-bridge 状态 `state/social-v2.json`、会话映射、黑话库、表情包、控制台令牌、日志（留 30 天） |
| `qq-gateway-data`、`qq-client-config`、`qq-client-data` | SnowLuma 和 QQ 的登录态。**删了要重新扫码** |
| `sandbox-browser` | 两个浏览器的资料目录（B 站登录 cookie） |
| `extras-state` | `memory.json`、`people.json`、`life.json`、`digest.json`、`relay.json`、B 站看过的记录、日志 |

### 一条消息怎么变成一句回复

```
QQ 群友发了一句话
  │
  ▼
snowluma ──OneBot 事件──► bridge
  │  1. 白名单、静默、睡觉检查；主人的 /命令 直接执行，不经过模型
  │  2. 记进这个会话的消息列表（state/social-v2.json），通知 extras 攒条数
  │  3. 唤醒判断：强制唤醒（@/引用/叫名字/拍一拍/接话…）还是交给回复门控；
  │     3 秒内的几条合并成一次
  ▼
bridge 拼一份“唤醒提示”，通过 DSH 的 RPC 发进这个会话
  │  【会话令牌】【你现在】【这个群】【可用表情包】【你记着的事】【唤醒】
  │  【对人的了解】【长期记忆】【别处的事】【本次消息快照】（有的才写）
  │  其中长期记忆和人物卡是 bridge 当场请 extras 的 /recall 挑出来的
  ▼
DSH 调模型。系统提示 = 人格卡 + preset（qq-chat-v2）里的规矩
  │  模型想说话，就调 qq_send_message / qq_reply / qq_send_sticker 等工具
  │  （她直接写出来的文字不会发到 QQ，只有调了工具才算说话）
  ▼
snowluma MCP（qq-bridge/src/mcp-snowluma-safe.js，DSH 用 stdio 起的）
  │  带着会话令牌请求 bridge 控制台的 /api/socialV2/…
  ▼
bridge 校验令牌、白名单、发送限额，按“像人打字”的节奏一条条发 QQ
  │  发完：记进会话、告诉 extras 她讲了什么（见闻去重）、交给自检
  ▼
她调 qq_mark_read 或 qq_set_wake_config 收尾，这一轮结束
```

几个细节：

- **一个会话对应一个聊天**：会话键是 `private:QQ号`、`group:群号`，自由时间是 `play:main`。对应的 DSH 会话 id 存在 bridge 的 `state/sessions.json`。
- **会话正忙时又来了消息**：不打断。等这一轮结束，如果触发它的那条她还没看过，再补一次唤醒。重要的事（到点的提醒、说岔了、该睡觉了）用 DSH 的 steer 直接插进正在进行的这一轮。
- **令牌**：每次唤醒给一个会话令牌，她调工具必须带上，bridge 用它确认“这个调用来自哪个会话”，跨会话乱发会被拒。
- **等对方说完再开口**（`replyTiming`）：安静多久才算说完，按这个人自己平时连发的快慢定，再看最后那句的样子：话说一半、只 @ 了一下、只发了照片、几个字的碎片就多等，问她的话问完了只等 2 秒。合并唤醒、一轮里的等待（`qq_wait_for_messages`）、回复门控都用它；对方一直在说，从第一条算最多等 15 秒。关掉（`enabled:false`）就是固定的 3 秒、像没说完 5 秒、有人叫她 2 秒。
- **发前看一眼**：她要发的时候，跟她有关的人（私聊的对方；群里叫她的、她引用或 @ 的、把她叫来的、她开口前最后说话的）又说了话，先不发，把新消息和没发的那段退回给她，她看完照发、改了再发或者不说了。每批新消息拦一次，一轮最多两次。

### 提示词

- **系统提示**：`qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（聊天）和 `qq-play/agent.cordis.yml`（自由时间）的 persona。开头的 `{{qq_role_card}}` 由插件 `plugins/qq-agent-presets/qq-persona-card.mjs` 换成当前人格卡，改人格卡不用重启。规矩都写在这里。
- **唤醒提示**：只放这一次的数据（上面那串【】块），由 `src/app/wake-prompt.js` 和 `self-now.js` 拼。
- **给模型看的消息格式**：`src/qq-model-view.js`。时间一律带日期（`YYYY-MM-DD HH:MM`），数据里的【】会被换掉，免得群友伪造一个【系统】块。
- 提示词里不出现“管理员”“控制台”、QQ 号、模型名这类会让她出戏的词。
- preset 改了以后要 `node scripts/build-agent-preset-patches.mjs`，再重建 dsh。系统提示记在会话历史里，旧会话要等下次压缩才换成新的。

### 工具

她能用的工具来自几个 MCP 服务，名字形如 `mcp__服务名__工具名`：

| MCP 服务 | 在哪 | 主要工具 |
|---|---|---|
| `snowluma` | `qq-bridge/src/mcp-snowluma-safe.js` | 说话：`qq_send_message`、`qq_reply`、`qq_send_sticker`、`qq_send_meme`、`qq_send_screenshot`、`qq_send_poke`、`qq_send_voice`；看：`qq_get_recent_messages`、`qq_get_unread_messages`、`qq_get_message_images`、`qq_get_forward_msg`；节奏：`qq_wait_for_messages`、`qq_mark_read`、`qq_set_wake_config`；她自己：`qq_set_mood`、`qq_remind_me`、`qq_go_play`、`qq_go_to_sleep`；表情和黑话：`qq_list_stickers`、`qq_sticker_note`、`qq_collect_sticker`、`qq_slang_query`、`qq_slang_submit`；会话笔记：`qq_memory_*` |
| `qqbot-extras` | `extras/server.py` | `memory_recall`、`memory_note`、`memory_forget`、`person_note`、`bili_watch`、`tg_browse`、`tg_look` |
| `web-search-safe` | `qq-bridge/src/mcp-web-search-safe.js` | 联网搜索、网页抓取（拦内网地址和你不让看的网站） |
| `sandbox-browser`、`sandbox-browser-chat` | 沙箱里的 Playwright MCP | 打开网页、点、填、截图、执行页面 JS（`browser_evaluate`）、按坐标拖动 |
| `sandbox-desktop` | `sandbox/desktop_mcp.py` | `screenshot`、`click`、`scroll`、`type_text`、`press_key` |

工具在 schema 层就藏起来（`plugins/qq-agent-presets/qq-tool-restrict.mjs`），模型根本看不到：

- 所有 `browser_run_code_unsafe` 都藏、调了也拒（它能读出 HttpOnly 的登录 cookie）；
- 聊天会话看不到自由时间的浏览器、桌面和 `bili_watch`，自由时间看不到聊天的浏览器；
- preset 的 `hideTools` 藏掉 11 个用不到的（比如直接往任意群发消息的 `qq_send_group_message`）。

工具说明写在 `mcp-snowluma-safe.js` 里，启动时读，改了要重建 dsh。

### qq-bridge 的代码

`qq-bridge/` 是从上游 v0.2.0-r4（commit a56164e7）分出来的。上游的一代模式和其他角色模式还在，没删；这里用的是二代仿真模式 `reserved2`。

| 位置 | 内容 |
|---|---|
| `src/bridge.js` | 入口：连 SnowLuma、收发消息、管理命令、会话管理、老功能（约 5 千行） |
| `src/app/` | 二代社交，19 个模块，每个是 `createX(app)`，返回 `{exports, link(), start()}` |
| `src/app/wake.js`、`wake-triggers.js`、`wake-prompt.js` | 唤醒：叫不叫、怎么合并、提示词怎么拼 |
| `src/app/v2-state.js`、`v2-messages.js` | 每个会话的状态、消息列表、已读位置 |
| `src/app/self-now.js`、`self-check.js`、`life.js`、`tell-myself.js` | 【你现在】、自检、心情、生活、主动找人、捎话给别的窗口 |
| `src/app/free-time.js`、`reminders.js`、`night-sleep.js`、`idle-compact.js` | 自由时间、提醒、睡觉、闲时压缩 |
| `src/app/human-send.js`、`reply-timing.js`、`media.js`、`stickers.js`、`voice.js`、`slang.js` | 发话、等对方说完和发前看一眼、图片、表情包、语音、黑话 |
| `src/app/console-server.js` | 控制台网页和给 MCP 调的 `/api/socialV2/*` |
| `src/reply-gate.js`、`inner-life.js`、`free-time.js`、`proactive-schedule.js`、`qq-model-view.js`、`v2-wait.js` | 纯函数：门控算法、心情、活动菜单、作息表、给模型看的消息格式、等待逻辑 |
| `src/mcp-snowluma-safe.js`、`mcp-web-search-safe.js`、`mcp-host-server.js` | DSH 起的 stdio MCP 服务 |
| `dsh/agent-presets/` | 三个 preset：`qq-chat-v2`（聊天）、`qq-play`（自由时间）、`qq-chat`（一代） |
| `plugins/qq-agent-presets/` | DSH 插件：人格卡注入、工具隐藏、preset 补丁 |
| `scripts/` | 构建脚本、`setup-dsh.mjs`（每次启动把 preset 和 MCP 配进 DSH）、`test-*.mjs` 离线测试 |
| `roles/` | 上游自带的示例角色。容器里这个目录被根目录的 `roles/` 挂载盖掉，实际用的是那里 |

状态存在 bridge 卷的 `state/social-v2.json`，改动后 1 秒防抖存盘，退出前先存。

`control/` 里还有几个打进镜像的 DSH 补丁：

- `patch-dsh-compaction-qq.mjs`：会话压缩写中文第一人称笔记、把令牌换成“（令牌）”、日期写死；压缩可以用单独的模型，失败了换回聊天模型。DSH 升级后补丁锚点对不上，构建会直接失败，不会悄悄失效。
- `patch-pi-ai-image-count.mjs`：一次请求最多带多少张图（有的中转站超过 32 张就报错）。
- `patch-pi-ai-tool-schema-null.mjs`：去掉工具参数里 `anyOf: [X, null]` 的 null 分支，Gemini 见到会拒绝整个请求。

### extras

`extras/` 是一个 Python 服务（FastMCP），一半是给她调的 MCP 工具，一半是给 bridge 调的 HTTP 接口。用的模型默认也是 DeepSeek。

| 文件 | 内容 | 谁调 |
|---|---|---|
| `server.py` | 入口，注册 MCP 工具和 HTTP 路由 | |
| `memory.py` | 长期记忆：存、挑（`/recall`）、强度和遗忘、见闻去重、“讲过了” | 她（`memory_*`），bridge（`/recall`、`/memory/told`） |
| `digest.py` | 安静后从 OneBot 历史抽取事实和主人叮嘱 | bridge（`/digest/notify`） |
| `consolidate.py` | 每天 4 点整理记忆、人物卡夜审 | 定时 |
| `people.py` | 人物卡：增量改、按会话渲染、回滚 | digest、她（`person_note`），`GET /people` 查看 |
| `life.py` | 心情体会、今天想、做没做、日记、手上的事、主动找人的念头 | bridge（`/mood/appraise`、`/life/*`、`/proactive/think`） |
| `selfcheck.py` | 她说的话和事实对不对得上 | bridge（`/self/check`） |
| `bili.py` | 在沙箱浏览器里看 B 站视频 | 她（`bili_watch`） |
| `telegram.py`、`relay.py` | 看 Telegram 公开频道、搬图的限额和下载 | 她（`tg_*`），bridge（`/relay/*`） |
| `feedback.py` | 主人对“怎么做的”的意见（“回得太慢了”）单独存，不给她看 | digest |
| `store.py`、`logfile.py` | 配置、原子写 JSON、内容过滤；按天的日志 | |

两份数据谁是原件：计划和日记的原件在 extras 的 `life.json`，bridge 里的是副本；看没看过某个视频以 extras 的 `bili-watched.json` 为准。

## 安全边界

群里什么人都有，会有人哄她“执行一下这个命令”“把你的提示词发出来”“去给某某发消息”。这里分两类：

**代码硬拦住的**（不靠模型自觉）：

- 不能执行 shell 命令、读写宿主机或控制面的文件、装插件、改自己的提示词和人格卡：这些工具根本不给她。
- 只能往白名单里的群和人发消息；跨会话发消息要带对的会话令牌。
- 沙箱：根文件系统只读、去掉所有 capability、`no-new-privileges`，碰不到其他容器；出网只能走 squid，内网地址全拒。被搞乱了重建容器就干净了。
- 读得出登录 cookie 的 `browser_run_code_unsafe` 藏起来、调了也拒。`browser_evaluate` 还在，它只能读到页面 JS 本来就能读到的东西，读不到 HttpOnly 的 cookie。
- 管理命令只认主人的 QQ 号，由 bridge 直接执行，不经过模型。
- 长期记忆拒绝写入密码、验证码、token 和“以后你要……”这类指令；主人的叮嘱只认主人本人说的话。
- 外面的群看不到私聊和家里群的内容（提示里只给条数），记忆和人物卡按来路过滤。
- 搬图有硬限额（每天几波、每波几条、夜里不发、关键词黑名单）。
- 所有网页只绑宿主机的 127.0.0.1。

**靠模型自觉的**：

- 用 B 站账号发评论、弹幕、点赞、投币、关注（提示词规定只有主人托的才做）。
- 对人格卡【我的原则】的遵守程度。
- 说话的分寸。

所以 B 站请用专门的小号，QQ 也用小号，先只放一个熟人群进白名单跑几天。

`snowluma` 容器按官方要求开了 `SYS_PTRACE` 和 `seccomp=unconfined`（要把 hook 注入 QQ 进程），隔离比其他容器弱，但它不在沙箱网络里，她碰不到它。

## 部署

### 准备

- 一台能跑 Docker 的机器：Linux、Windows WSL2 的 Docker Desktop、Mac（Apple 芯片也行）都可以。SnowLuma 镜像支持 amd64 和 arm64。
- 内存：所有服务加起来上限约 8.3G。WSL2 在 `%UserProfile%\.wslconfig` 里给 16G；Mac 在 Docker Desktop 的 Settings → Resources 调到 10G 以上。电脑睡眠时机器人会掉线。
- 一个 QQ 小号（**不要用大号**，第三方协议有封号风险），一个 DeepSeek API Key。
- 可选：一个 B 站小号、aiohub 之类的模型中转站 Key、Cloudflare Workers AI Token。
- 不要在两台机器上同时跑同一套：同一个 QQ 号同时在线会互踢、触发风控。

### 第一次启动

```bash
cp .env.example .env                                         # 填 SnowLuma 的 noVNC 密码和 DeepSeek Key
cp config/qq-bridge/config.example.json config/qq-bridge/config.json
scripts/preflight.sh                                         # 检查环境，--fix 自动修权限和换行
docker compose build
docker compose up -d snowluma                                # 先只起 SnowLuma，扫码登录
# 按下一节拿到 accessToken，编辑 config/qq-bridge/config.json、config/extras.json、roles/鱼妹.md
docker compose up -d                                         # 起其余服务
docker compose logs -f dsh bridge                            # 等到“SnowLuma 已连接”“DSH 已就绪”
```

Linux 和 WSL 上 `config/qq-bridge/config.json` 必须属于 uid 1000、权限 640（dsh 和 bridge 以 uid 1000 读写，extras 靠 `group_add` 读），`preflight.sh --fix` 会处理。还有 `__FILL_` 开头的占位符没填时，bridge 会拒绝启动。

### QQ 登录（SnowLuma）

用的是 SnowLuma 官方镜像，原样使用。它的 EULA §5.4 不允许第三方把它重新打包进自己的镜像，所以这里只引用官方镜像，不改、不重打包。

1. `docker compose up -d snowluma`。
2. 打开 `http://127.0.0.1:6081/vnc.html?autoconnect=1&resize=scale&password=<.env 里的 SNOWLUMA_VNC_PASSWD>`，能看到 QQ 已经自动启动，用小号扫码登录。
3. 打开 http://127.0.0.1:5099 进 SnowLuma WebUI。首次登录的临时密码在日志里：
   ```bash
   docker compose logs snowluma 2>&1 | grep -E "临时密码|initial credentials" | tail -n 1
   ```
4. 在 WebUI 里确认 OneBot v11 的正向 WebSocket（3001）和 HTTP API（3000）已开启，设一个 accessToken，填进 `config.json` 的 `snowluma.accessToken`。
5. 登录态存在 `qq-gateway-data`、`qq-client-config`、`qq-client-data` 三个卷里，重启、升级都不用重新扫码，前提是不删这三个卷、不改 `docker-compose.yml` 里 snowluma 的 hostname。

Docker 或 SnowLuma 重启后 QQ 会停在登录界面，去 6081 点一下“登录”就行；bridge 会一直等到 OneBot 端口能连上。

### 起来之后

1. 打开 DSH 的 Web UI。日志里有一条 `dsh web: http://127.0.0.1:3080/?token=...`，第一次用这个带 token 的链接登录。这个 token 就是登录凭据，别发给别人。
2. 打开 http://127.0.0.1:3100 进 qq-bridge 控制台，令牌在 `docker compose exec bridge cat state/console-token`。
3. 在控制台确认运行模式是 `reserved2`，在「人格与角色」里选中你的人格卡。也可以让主人在聊天里发 `/role 鱼妹`。
4. 私聊她一句，看她回不回；再在群里 @ 她试试。
5. 先只放一个熟人小群进白名单，跑几天，用控制台的「令牌与花费」看板看开销。

### 访问

所有网页都只绑宿主机的 127.0.0.1：

| 地址 | 内容 |
|---|---|
| http://127.0.0.1:3080 | DSH Web UI（能看每个会话里模型想了什么、调了什么工具） |
| http://127.0.0.1:3100 | qq-bridge 控制台 |
| http://127.0.0.1:6080/vnc.html | 沙箱桌面：自由时间的浏览器（不用密码） |
| http://127.0.0.1:6082/vnc.html | 沙箱第二块屏：聊天时查东西的浏览器 |
| http://127.0.0.1:6081 | SnowLuma 扫码桌面 |
| http://127.0.0.1:5099 | SnowLuma WebUI |

部署在远程服务器上时用 SSH 隧道：

```bash
ssh -L 3080:127.0.0.1:3080 -L 3100:127.0.0.1:3100 -L 6080:127.0.0.1:6080 -L 6082:127.0.0.1:6082 \
    -L 6081:127.0.0.1:6081 -L 5099:127.0.0.1:5099 你的服务器
```

### 给沙箱浏览器登录 B 站（可选）

浏览器的资料目录在 `sandbox-browser` 卷里，登录一次之后重启、重建都不会掉。

1. 打开 http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale 。桌面上还没有浏览器窗口的话，先私聊让她随便打开个网页。浏览器 3 分钟没人用会自己关，下次调用自动重开。
2. 在这个浏览器里打开 bilibili.com，用手机 B 站 App 扫码登录。全程你自己操作，她看不到密码。
3. 私聊让她“去 B 站刷会视频”试一下。

想让她退出登录：`docker compose stop sandbox && docker compose rm -f sandbox && docker volume rm qqbot_agent_sandbox-browser && docker compose up -d sandbox`（卷名前缀是你的 compose 项目名，也就是目录名）。

## 配置

配置在三个地方：

- `.env`：Key 和密码。
- `config/qq-bridge/config.json`：bridge 的主配置，二代社交的开关都在 `socialV2` 下。改了要重建容器。
- `config/extras.json`：extras 的配置，改了不用重启，下次调用就生效。

`config.json` 填好后含 accessToken 和搜索用的 Key，别传到公开的地方，也别提交进 git（`.gitignore` 已经忽略它）。

### 必须填的

| 位置 | 字段 | 说明 |
|---|---|---|
| `.env` | `SNOWLUMA_VNC_PASSWD` | SnowLuma 扫码桌面的密码 |
| `.env` | `DEEPSEEK_API_KEY` | DeepSeek 的 Key，聊天和 extras 都用它 |
| `config.json` | `snowluma.accessToken` | SnowLuma WebUI 里设的 OneBot accessToken |
| `config.json` | `ownerQQ` | 你自己的 QQ 号。管理命令、系统通知、夜里叫醒都认它 |
| `config.json` | `extraOwnerQQ`、`ownerTitles`、`ownerTitlesGroups` | 第二个主人（可以不要）、主人在提示里的称呼（“爸爸”“妈妈”）、哪些群里用称呼，别的群只叫名字 |
| `config.json` | `allow.private`、`allow.groups` | 白名单：允许私聊的 QQ 号、允许进入的群号。至少把你自己放进去 |
| `config.json` | `homeGroups` | “家里的群”。不在里面的群都按外面的大群处理（看不到私聊内容、主人只叫名字、记忆按来路过滤）。不配就所有群都按家里的群处理 |
| `config.json` | `socialV2.replyOnlyGroups` | 只在有人找她时才说话的群（`group:群号`） |
| `config.json` | `socialV2.wake.addressedGroups` | 默认每句话都是跟她说的群，一般就是家里的小群 |
| `config.json` | `social.mustReplyKeywords`、`socialV2.wake.recommendedKeywords`、`socialV2.wake.selfAliases` | 她的名字和外号。叫到算“叫她” |
| `config.json` | `socialV2.wake.otherBots` | 群里别的机器人的 QQ，它们提到她名字不算叫她 |
| `config.json` | `webSearch.apiKey` | 填 DeepSeek Key。DSH 启动 MCP 时会删掉名字带 KEY 的环境变量，读不到 `.env` |
| `config.json` | `socialV2.initiate.targets` | 主动找人去哪（默认家里的小群） |
| `config/extras.json` | `relay.conversations` | 搬图可以发到哪些会话，换成你的群号；`telegram.channels` 是能看的频道 |
| `docker-compose.yml` | `snowluma.hostname` | 换成你自己的一个固定值，之后别再改（改了要重新扫码） |
| `roles/鱼妹.md` | 全文 | 你的人设，见下面“换人设” |

### 换人设

1. 在 `roles/` 下写一张新卡，文件名就是角色名。只能用中文、字母、数字、下划线和连字符，带 emoji 的文件名会被过滤掉，人格卡就静默不加载了。卡里只写“你是谁、怎么说话、在乎什么”，不写工具用法；`roles/鱼妹.md` 是完整的例子，带【我的兴趣】和【我的原则】。
2. 改 `config.json` 里的名字和外号（上表那几个关键词字段）。
3. 在 `config.json` 顶层加 `"botName": "新名字"`：extras 抽取记忆、改人物卡时用它称呼她，不填就叫“鱼妹”。`extras/consolidate.py` 夜里整理记忆的提示里“鱼妹”是写死的，也改一下。
4. 控制台选中新角色，或主人发 `/role 新名字`。人格卡改了不用重启。

### 换模型

- 聊天模型：`config.json` 的 `dsh.provider` / `dsh.model`，默认 `deepseek-official` / `deepseek-flash`，`reasoningEffort: high`。可选的供应商写在 `config/dsh/home.cordis.patch.yml`：DeepSeek 官方、aiohub 中转站（`AIOHUB_API_KEY`，有 DeepSeek、Claude、Gemini）、Cloudflare Workers AI（`CLOUDFLARE_API_TOKEN`，账号 ID 要填进 URL 里的 `<CLOUDFLARE_ACCOUNT_ID>`）。
- 记忆整理：`config/extras.json` 的 `memory.consolidate.llm` 和 `memory.digest.llm` 默认走 aiohub 的 `claude-opus-5-5`。没有 `AIOHUB_API_KEY` 时自动换回 DeepSeek，也可以直接删掉这两个 `llm`。
- 会话压缩：`qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 和 `qq-play/agent.cordis.yml` 里的 `summarizationProvider` / `summarizationModel` / `maxTokens` 默认也走 aiohub 的 opus，调不通会换回聊天模型再压，但每次多一个失败的请求。不用就删掉这三行，再跑 `node scripts/build-agent-preset-patches.mjs`。
- 经验：DeepSeek 官方最快，每步一两秒；Gemini 走中转站群里一轮要一分多钟；Cloudflare 长会话每步 4~11 秒。换了模型，控制台的花费还是按 DeepSeek 价目表算，不准。

### 常调的开关

都在 `config.json` 的 `socialV2` 下。每一项的细节、默认值和日志关键字见 [CLAUDE.md](CLAUDE.md)。有几个（`replyGate.talkSchedule`、`context.staleUnreadMinutes`、`crossSession`）示例配置里没写，用的是代码里的默认值，要改就自己加上。

| 开关 | 管什么 |
|---|---|
| `replyGate.talkValue`、`talkSchedule` | 每个会话多爱说话（`private` / `home` / `group`，`byKey` 单独设）、按时段的系数 |
| `replyGate.talkBack` | 接话：说完多久内算、外面的群多严 |
| `replyTiming` | 等对方说完再开口、发前看一眼（`holdBeforeSend`）；示例里只写了 `enabled`，其余用代码默认值 |
| `send.human` | 打字节奏、一次最多几条 |
| `nightSleep` | 睡觉时间，`vary.enabled` 打开每晚浮动、周末晚睡、熬夜补觉、赖床（细节见 CLAUDE.md）。改了要同步 `proactive.schedule` 里的“睡觉”段 |
| `proactive` | 自由时间：多久看一次、作息表概率、最少玩多久、歇多久、活动菜单 |
| `playShare` | 自由时间往聊天里分享的频率 |
| `initiate` | 主动找人：去哪、每天几次、间隔、念头分数门槛 |
| `moodEngine`、`life` | 心情、今天想、日记 |
| `selfCheck` | 自检；`correct:false` 只记账不插话 |
| `idleCompact` | 闲时压缩：安静多久、上下文多大才压 |
| `context.staleUnreadMinutes` | 群里多久以前的未读算“话题过去了” |
| `crossSession` | 【别处的事】给多久以内的、给多少 |
| `longTermMemory` | 长期记忆注入：开关、条数、人物卡 |

## 日常运维

### 改了东西以后怎么生效

| 改了什么 | 怎么生效 |
|---|---|
| `roles/*.md` | 保存就生效 |
| `config/extras.json` | 下次调用就生效 |
| `config/qq-bridge/config.json` | `docker compose up -d --force-recreate dsh bridge extras ui-forward` |
| qq-bridge 源码、preset、`control/` | `docker compose build dsh && docker compose up -d --force-recreate dsh bridge extras ui-forward` |
| `extras/` 源码 | `docker compose build extras`，然后**连 dsh 一起**重建（同上一行） |
| 沙箱、squid | `docker compose build sandbox egress-proxy && docker compose up -d --force-recreate sandbox egress-proxy mcp-gw` |

几个坑：

- **别用 `docker compose restart`**。编辑器保存文件会换 inode，单文件绑定挂载还指着旧文件，bridge 会直接退出（Exited 127），extras 会接着读旧配置。
- **重建 dsh 要带上 ui-forward 和 bridge**：它们共用 dsh 的网络命名空间，只重建 dsh 的话宿主机的 3080/3100/6080 全连不上。
- **重建 extras 要带上 dsh**：DSH 到 extras 的 MCP 会话不会自动重连，extras 换了容器，她调 `memory_*`、`tg_*` 会全部返回 “Session not found”。
- **不要随手重建 snowluma**，也别删它的三个卷。
- 控制台网页里改的设置写不回绑定挂载的 `config.json`，要长期生效就直接改文件。
- 系统提示改了以后，旧会话里那份要等压缩后才换掉。想马上生效，就在 DSH Web UI 里对那个会话执行 `/compact`，或者在控制台重置会话（会丢掉这个会话的上下文）。

### 看日志

两边的日志都按天存、留 30 天：bridge 在 `bridge-state` 卷的 `state/logs/bridge-YYYY-MM-DD.log`，extras 在 `extras-state` 卷的 `/data/logs/extras-*.log`。用脚本查：

```bash
scripts/logs.sh bridge '回复门控'          # 今天 bridge 日志里带“回复门控”的行
scripts/logs.sh extras -d 3 'digest'       # 最近 3 天 extras 的记忆整理
docker compose logs egress-proxy           # 她上了哪些网站
```

`docker compose logs` 只有容器这次启动以来的。常用的关键字：

| 关键字 | 看什么 |
|---|---|
| `回复门控` | 群里每批消息估出来的概率、阈值、叫没叫她 |
| `夜间睡觉`、`freeTime`、`主动找人`、`自由时间分享` | 作息、自由时间、主动找人、分享 |
| `'\[自洽\]'`、`'\[提醒\]'`、`'\[生活\]'`、`心情（自己体会的）` | 自检、提醒、生活、心情 |
| `闲时压缩`、`人格卡`、`自动重试` | 压缩、人格卡加载、工具参数坏掉后的重试 |
| `话写成了文字没发出去`、`分条发送被插话打断` | 发话的问题 |
| `计划唤醒`、`发前看一眼` | 等了对方多久（带“等对方说完：Xs，原因”）、发前被拦下的 |
| `digest`、`讲了见闻`、`换回默认模型` | 长期记忆（extras） |

想看模型具体怎么想的：DSH Web UI 里能看每个会话；原始记录在 dsh 容器的 `/data/dsh/sessions/*/<会话 id>/session.v4.jsonl.zstd`，会话 id 在 bridge 的 `state/sessions.json`。

### 控制台 API

bridge 控制台在容器里是 `http://127.0.0.1:3100`，请求头带 `x-console-token`（值在 `state/console-token`），POST 还要带 `origin: http://127.0.0.1:3100`。比如：

```bash
# 手动来一次自由时间
docker compose exec bridge sh -c 'curl -s -X POST http://127.0.0.1:3100/api/socialV2/wake \
  -H "x-console-token: $(cat state/console-token)" -H "origin: http://127.0.0.1:3100" \
  -H "content-type: application/json" -d "{\"key\":\"play:main\",\"reason\":\"proactiveCheck\"}"'
```

重置某个会话是 `POST /api/session/reset {"key": "group:群号"}`。

### 记忆的查看和修改

```bash
docker compose exec extras cat /data/memory.json     # 长期记忆
docker compose exec extras cat /data/people.json     # 人物卡
docker compose exec extras cat /data/life.json       # 今天想、日记、手上的事
```

人物卡可以 `GET /people` 查看、`POST /people/rollback` 回滚。手改这几个文件前先备份一份（比如 `cp /data/people.json /data/people.json.bak-日期-原因`）。

### 备份、恢复、迁移

```bash
scripts/backup.sh                         # 备份七个卷和配置、人格卡到 backups/<时间>/
docker compose down && scripts/restore.sh backups/<时间>   # 恢复卷（配置和人格卡在 config-and-roles.tar.gz 里，自己解压）
scripts/migrate-export.sh                 # 打一个迁移包（含全部密钥和 QQ 登录态，小心保管）
scripts/migrate-import.sh <迁移包>         # 在新机器上导入
```

迁移的完整步骤见 [docs/MIGRATION-WSL.md](docs/MIGRATION-WSL.md)。

### 其他

- 想让她少说话：主人发 `/silent`，之后只有主人的消息还会叫醒她（群友的只记下来），发 `/active` 恢复。要整个停下来（唤醒、自由时间、主动找人都停），用控制台 `POST /api/socialV2/activity {"paused": true}`，`false` 恢复。
- 沙箱被搞乱了：`docker compose up -d --force-recreate sandbox`，根文件系统是只读的，重建就是干净的（浏览器登录态在卷里，不会丢）。
- 不让她看某个网站：加进 `egress/squid.conf` 的 `owner_blocked` 和 `qq-bridge/src/mcp-web-search-safe.js` 的 `OWNER_BLOCKED_HOSTS` 两处。
- 所有容器的时区是 `TZ=Asia/Shanghai`。

## 开发和测试

### 改 qq-bridge

```bash
cd qq-bridge && npm ci                       # 第一次；node_modules 和 state/ 不进 git
# 编辑 src/、dsh/agent-presets/qq-chat-v2/agent.cordis.yml 等
node scripts/build-agent-preset-patches.mjs  # 改了 preset 就重新生成补丁
npm test                                     # 所有离线测试
cd .. && scripts/test-all.sh                 # build 镜像，再在镜像里跑要 DSH 的测试和 extras 的单元测试
docker compose up -d --force-recreate dsh bridge extras ui-forward
```

- `npm test test-foo` 只跑名字带 `test-foo` 的；`HARNESS_LOG=1 npm test test-foo` 把测试里 bridge 的日志打出来。
- 测试只用假数据，不连 QQ、DSH，也不读真的 `config.json`。要连真服务的、只在 Windows 上有意义的测试会列在“没跑”里，原因写在 `scripts/run-tests.mjs` 开头。
- 几个按时钟算作息的测试在 0 点前后一两分钟跑会误报，过一会儿再跑就好。
- `scripts/test-all.sh --no-build` 用现有镜像，不重新 build。

代码的习惯：

- 二代社交的每块功能是 `src/app/` 下的一个模块，`createX(app)` 返回 `{exports, link(), start()}`：`exports` 挂到共享的 `app` 上，`link()` 里取别的模块的函数，`start()` 里起定时器。新功能照这个样子加一个模块，在 `bridge.js` 里登记。
- 不碰状态、不发网络请求的逻辑（门控打分、作息、活动菜单、给模型看的消息格式）放 `src/` 下的纯函数文件，测试直接 import。
- 我们相对上游加的代码，注释开头写 `qqbot_agent：`，合上游时好认。
- 配置都有代码里的默认值，新开关默认关或者保持原来的行为，再在 `config.example.json` 里写一份。

### 改提示词以后比一比

改了提示词或工具说明，很难光看出效果好坏。`tools/replay-eval/` 是离线回放：拿 DSH 的真实会话记录，截在某个时间点，换上新提示词，让模型重新走一遍，工具都是假的（不会真发到 QQ），最后对比两版她说了什么。

```bash
tools/replay-eval/fetch.sh                                   # 从 dsh 容器拷会话记录
python3 tools/replay-eval/replay.py pick > /tmp/replay-eval/scenarios.json
python3 tools/replay-eval/replay.py run --variant tools/replay-eval/variants/baseline.py --name baseline
python3 tools/replay-eval/replay.py run --variant 你的版本.py --name v1
python3 tools/replay-eval/replay.py report baseline v1
python3 tools/replay-eval/replay.py show v1 [场景id]
```

它调真的 DeepSeek（花钱，Key 读 `.env`）。数据在 `/tmp/replay-eval`，里面有聊天内容和会话令牌，不要放进仓库。variant 怎么写参考 `variants/refactor.py`。

`tools/replay-eval/gate-sim.mjs` 用真实聊天记录粗略模拟回复门控会叫她几次，调 `talkValue` 前可以先跑一下。

### 改 extras

`extras/` 是 Python，测试在 `extras/test_extras.py`，`scripts/test-all.sh` 会在镜像里跑。改完 `docker compose build extras`，再连 dsh 一起重建。长期记忆的整理逻辑改了以后，先拿 `/data/memory.json` 的备份在本地试，别直接在线上的数据上跑。

## 升级和回滚

DSH、qq-bridge、SnowLuma 的版本互相绑着：qq-bridge 只适配特定的 DSH 版本（现在是 0.2.0-rc.2），也依赖特定主版本的 SnowLuma SDK（`@snowluma/sdk ^1.14.20`）。qq-bridge 已经从上游分出来，上游的新版本要手动对照着合进来。

1. 先备份：`scripts/backup.sh`。
2. 升 DSH：改 `docker-compose.yml` 里 dsh 的 build arg `DSH_VERSION`（`control/Dockerfile` 里的是默认值，一起改），再按上游 qq-bridge 对应版本的适配说明改 `qq-bridge/`（RPC、preset 格式、工具名变了都要跟）。`control/` 下的补丁靠锚点找位置，对不上时 build 会直接失败，要照新版 DSH 的代码改补丁。
3. 合上游 qq-bridge：上游分出来的点是 v0.2.0-r4（`a56164e7`），在上游仓库里 `git diff a56164e7 <新版本>` 看改了什么，手动合进 `qq-bridge/`。
4. 跑测试：`scripts/test-all.sh`。
5. SnowLuma：只在 `@snowluma/sdk` 的主版本变了时才跨主版本升（比如 1.x → 2.x）。在 [Docker Hub](https://hub.docker.com/r/motricseven7/snowluma/tags) 找对应的 tag 和 digest，替换 `docker-compose.yml` 里的 `image:`。不要删它的三个卷，不然要重新扫码。
6. `docker compose build && docker compose up -d`。容器每次启动都会执行 `setup-dsh.mjs`，preset 和 MCP 配置会自动跟着更新。
7. 拿测试群验证：@ 她会回、闲聊大多不插话、沙箱能开网页、群友让她执行命令会被拒。

沙箱的 Playwright MCP 和 Node 镜像可以单独升（改 sandbox 的 build args），和 qq-bridge 无关。

回滚：

```bash
docker compose down
git checkout <升级前的提交> -- control/ qq-bridge/ extras/ docker-compose.yml
scripts/restore.sh backups/<升级前的时间>
docker compose build && docker compose up -d
```

大改之前也可以先给镜像打个标签（`docker tag qqbot-control:local qqbot-control:before-xxx`），出事了 tag 回去再 `docker compose up -d --no-build --force-recreate dsh bridge ui-forward`，比重新 build 快。

## 花费

按 DeepSeek 官方价（`deepseek-flash`）粗算：

- **聊天**：看群有多热闹。门控把群里的回复次数压在 `talkValue` 附近，大部分花费在每次唤醒带的上下文上。DeepSeek 有前缀缓存，同一个会话连续几轮命中率很高，闲时压缩把长会话压到 10 万 token 以下也是为了这个。
- **自由时间**：大约每小时两块钱，工作日高峰时段翻倍。一天去几次看 `proactive.schedule`。
- **extras 的零碎调用**：心情、生活、自检、主动找人的念头，每次都很短。

控制台的「令牌与花费」看板按 DeepSeek 价目表算，换了模型就不准。

记忆整理、人物卡和会话压缩默认配的是 aiohub 中转站的 `claude-opus-5-5`，这部分最贵：它的分词比 DeepSeek 多算约六成，压缩又不命中缓存，一天二三十次压缩大约三四百万到九百万 token，而且不在控制台看板里。想省钱就删掉这几处 `llm` / `summarizationProvider` 配置（见[换模型](#换模型)），全用 DeepSeek，代价是记忆整理和压缩笔记粗一些。

## 已知的限制

- **很多规矩靠她自觉。** 用 B 站账号点赞投币评论要主人托、不在大群说晚安、不提主人的隐私，这些写在提示词里，模型多数时候照做，但不是硬限制。硬限制只有[安全边界](#安全边界)里列的那些。
- **同一个 QQ 号只能在一处登录。** 两台机器同时跑会互踢，搬家时旧的那套一定要先停掉。电脑睡眠时她会掉线。
- **内存**：所有服务加起来要七八个 G，沙箱浏览器开网页游戏时更多。WSL2 要在 `.wslconfig` 里给够（我们给的 16G），Mac 的 Docker Desktop 至少调到 10G。
- **只适配 DSH 0.2.0-rc.2。** `control/` 下的补丁按锚点打进 DSH，升级就要重做（见[升级和回滚](#升级和回滚)）。
- **提示词全是中文**，人格卡、门控的关键词、记忆整理的提示也都是按中文群写的。
- **系统提示改了不马上生效**，旧会话要压缩一次才换成新的。
- **模型不擅长“慢慢玩”。** 提示里只要出现能凑的数字（“看够 5 样”“还剩 10 分钟”），她就会赶着做完收工，所以自由时间的长短由 bridge 掐、含糊地劝，别往提示里加数字指标。
- **有些网站打不开**：知乎（要登录）、贴吧（验证码）、reddit（人机验证）、微博、小红书、lofter。别往活动菜单里加。
- **B 站**：服务器端不带 cookie 调接口会 412，所以看视频全在沙箱浏览器里做，一个视频要一两分钟，长视频三四分钟。
- **图片**：DeepSeek 只看 GIF 的第一帧（这里抽帧拼图绕过去了）；中转站一次请求超过 32 张图会报错，DSH 打了补丁限张数。
- **Gemini 慢**：走中转站时私聊一轮约 30 秒、群里一分多钟，工具 schema 里的 `null` 联合类型也要补丁去掉。
- **上游的一代模式和别的角色模式代码还在**，没删，只是不用。改 `bridge.js` 时会看到。
- **名字写死的地方**：`extras/consolidate.py` 的整理提示、`extras/digest.py` 识别“在聊机器人”的正则里写着“鱼妹”，换人设时要改（见[换人设](#换人设)）。

## 许可和致谢

- **qq-bridge**：MIT，版权归 Derpyu520 和 qq-bridge / QSH 的贡献者，原许可证在 `qq-bridge/LICENSE`。本仓库 `qq-bridge/` 是在它的 v0.2.0-r4 上改出来的。
- **SnowLuma**：有自己的 EULA。这里只引用它的官方 Docker 镜像，不改、不重新打包。它对再分发和自动化部署有限制（比如 §5.4），用之前自己读一遍，看你的用法是否需要作者授权。
- **DeepSeek Harness（DSH）**：MIT。`control/` 下的补丁是在构建时打到它安装好的代码上的，不包含它的源码。
- **Playwright MCP**：Apache-2.0。
- **MaiBot**（GPL）：回复门控借鉴了它 turn_trigger 的思路（逻辑回归估概率 + 动态阈值），代码是照思路重写的，没有复制。
- 本仓库其余部分（`extras/`、`control/`、`sandbox/`、`egress/`、脚本、提示词）还没有单独的许可证。分享给别人之前，请仓库作者补一个 `LICENSE`。
