# qqbot_agent

QQ 群里的"仿真群友"：一个 QQ 小号，自己看群、自己决定说不说话，能用一台隔离的沙箱电脑上网、开浏览器、操作虚拟桌面。

- QQ 协议端：[SnowLuma](https://github.com/SnowLuma/SnowLuma) v1.14.22 官方 Docker 镜像（OneBot v11），在网页里扫码登录
- 群聊逻辑：[qq-bridge](https://github.com/Derpyu520/qq-bridge) v0.2.0-r4 的二代仿真模式（reserved2），源码放在本仓库 `qq-bridge/` 里自己维护
- Agent：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2.0-rc.2（qq-bridge 这一版只适配它）
- 沙箱：Chromium（[Playwright MCP](https://github.com/microsoft/playwright-mcp)）+ Xvfb 虚拟桌面 + noVNC

> 这是从一套在用的部署里整理出来的模板。配置、人格卡、测试和文档里的 QQ 号、群号、名字都是示例：
> 机器人 `1000000000`，主人 `900000001`（阿明，“爸爸”）、第二个主人 `1600000002`（阿红，“妈妈”），
> 家里的小群 `1100000001`，大群 `800000002` / `1000000004`，技术群 `1100000003`，另一个机器人 `4000000009`。
> 部署前把 `config/qq-bridge/config.json`、`config/extras.json`、`roles/鱼妹.md` 里的这些换成你自己的（测试里的不用管）。
> `CLAUDE.md` 是给 AI 编程助手看的现状说明，里面的开关、日志关键字对照着看最快。

迁移到另一台机器（比如 Windows + WSL2）：见 [docs/MIGRATION-WSL.md](docs/MIGRATION-WSL.md)。部署前可以先跑 `scripts/preflight.sh` 检查环境。

## 架构

```
┌─────────────── egress 网络（能出公网）──────────────────────┐
│ snowluma（QQ 小号，OneBot WS :3001 / HTTP :3000，不映射到宿主机）│
│      ▲ OneBot                                               │
│ dsh 容器（DSH Web :3080）                                    │
│   ├─ bridge（qq-bridge，控制台 :3100）   共用 dsh 的网络命名空间 │
│   └─ ui-forward（把 3080/3100/noVNC 转给宿主机 127.0.0.1）      │
│ egress-proxy（squid）                                        │
└──┬───────────────────────────────────────────┬─────────────┘
   │ agent-net（internal）                      │ sandbox-net（internal）
   ▼                                            ▼
 mcp-gw（只会把流量转进沙箱）──────────────► sandbox
                                              Chromium / 虚拟桌面 / noVNC
                                              出网只能走 egress-proxy（拒绝内网地址）
```

AI 能做的：看群、发消息、引用、发表情包、拍一拍、记忆、学黑话、联网搜索，以及用沙箱里的浏览器和虚拟桌面。

AI 不能做的：执行 shell 命令、读写宿主机或控制面的文件、装插件、改自己的提示词和人格卡、往白名单以外的群和人发消息。这些由 qq-bridge 的工具守卫在执行时硬拦截，不靠模型自觉。具体做不做、做什么，由人格卡里的【我的原则】让 AI 自己判断。

## 目录

| 路径 | 内容 |
|---|---|
| `docker-compose.yml` | 8 个服务、3 个网络、7 个数据卷；所有版本号写死（build args 和 SnowLuma 镜像的 tag + digest） |
| `.env.example` | 复制成 `.env`，填 SnowLuma 的 noVNC 密码、DeepSeek Key（必填）和中转站 Key（可选） |
| `config/qq-bridge/config.example.json` | qq-bridge 主配置模板；复制成 `config.json`（不进 git，含 token）后填写，下面列了要填的字段 |
| `config/dsh/home.cordis.patch.yml` | 把沙箱浏览器（两个）、沙箱桌面、extras 的 MCP 接进 DSH，并配置模型供应商（DeepSeek 官方 + 中转站备用） |
| `roles/鱼妹.md` | 人格卡「鱼妹」：元气小孩性格，含【我的兴趣】、【我的原则】和示例 |
| `qq-bridge/` | qq-bridge 源码（从上游 v0.2.0-r4 分出来，加了工具守卫放行沙箱 / extras 工具、qq-chat-v2 和 qq-play 提示词、自由时间、夜里睡觉、闲时压缩、长期记忆注入等，详见 CLAUDE.md）。`npm test` 跑离线测试 |
| `control/` | 控制面镜像（DSH + qq-bridge）和 3 个启动脚本 |
| `extras/` | 长期记忆和 Telegram 搬图的 MCP 服务（Python），带单元测试 `test_extras.py` |
| `sandbox/` | 沙箱镜像、进程表、桌面 MCP（截图/点击/滚动/输入/按键，没有启动程序的工具） |
| `egress/` | squid 出网代理配置，mcp-gw 也用这个镜像 |
| `scripts/` | `backup.sh` / `restore.sh` 备份恢复，`migrate-export.sh` / `migrate-import.sh` 迁移，`preflight.sh` 部署前检查 |

## 需要你填写的地方

| 位置 | 字段 | 说明 |
|---|---|---|
| `.env` | `SNOWLUMA_VNC_PASSWD` | SnowLuma 扫码桌面的密码（官方镜像关不掉；用下面带 `password=` 的链接就不用手输） |
| `config.json` | `snowluma.accessToken` | 在 SnowLuma WebUI 里设置的 OneBot accessToken（见「QQ 登录」第 4 步） |
| `config.json` | `snowluma.wsUrl` / `httpUrl` | 已填好 `ws://snowluma:3001` / `http://snowluma:3000`，一般不用改 |
| `config.json` | `ownerQQ` | 你自己的 QQ 号（数字）。只有它能用 `/role`、`/silent` 等管理命令，能用 closed-agent 模式 |
| `config.json` | `allow.groups` | 允许机器人进入的群号数组，例如 `[123456789]`。空数组时不响应任何群 |
| `config.json` | `allow.private` | 允许私聊的 QQ 号数组，至少把你自己放进去 |
| `config.json` | `dsh.provider` / `dsh.model` | 默认 `deepseek-official` / `deepseek-flash`；可选的供应商写在 `config/dsh/home.cordis.patch.yml`（aiohub 中转站用 .env 的 `AIOHUB_API_KEY`，Cloudflare Workers AI 用 `CLOUDFLARE_API_TOKEN`，都只是备用） |
| `config.json` | `social.mustReplyKeywords`、`socialV2.wake.recommendedKeywords`、`socialV2.wake.selfAliases` | 叫它名字时会被唤醒的词；`selfAliases` 是昵称以外的外号（叫到算“叫她”，等待会提前返回、回复检查会叫醒她）；改了人格名要一起改 |
| `config.json` | `webSearch.provider` / `apiKey` | 现在是 `anthropic`（DeepSeek 官方 Anthropic 兼容接口 + 服务端 web_search）；`apiKey` 要填 DeepSeek Key，DSH 启动 MCP 时会删掉带 KEY 的环境变量，读不到 .env |
| `roles/鱼妹.md` | 全文 | 改成你想要的人设；文件名就是角色名；只能用中文、字母、数字、下划线和连字符，带 emoji 的文件名会被 qq-bridge 过滤掉，人格卡就读不到了 |
| `config.json` | `extraOwnerQQ`、`ownerTitles`、`ownerTitlesGroups` | 第二个主人、主人在提示里的称呼、哪些群里用称呼（其他群只叫名字） |
| `docker-compose.yml` | `snowluma.hostname` | 换成你自己的一个固定值，之后别再改（QQ 设备指纹靠它稳定，改了要重新扫码） |
| `config/extras.json` | `relay.conversations`、`memory.consolidate.llm`、`memory.digest.llm` | 搬图的会话名单要换成你的群号；记忆整理默认走 aiohub 中转站的 `claude-opus-5-5`（.env 的 `AIOHUB_API_KEY`），不填 Key 就自动用 DeepSeek，也可以删掉这两个 `llm` |
| `qq-bridge/dsh/agent-presets/qq-chat-v2`、`qq-play` | `summarizationProvider` / `summarizationModel` / `maxTokens` | 会话压缩默认也走 aiohub 的 opus（调不通会换回聊天模型再压，每次多一次失败的请求）；不用就删掉这三行，改完 `node scripts/build-agent-preset-patches.mjs` |
| `config.json` | `homeGroups` | “家里的群”（现在只有小测试群）。不在这里的群（以后新加的都算）按大群处理：只有 @/引用/叫名字/拍一拍直接叫醒她，别的由 `socialV2.groupChimeIn` 看群里热闹或有人问了没人接才叫；看不到私聊内容；主人只叫名字。不配这一项就所有群都按家里的群处理 |

`config.json` 填好后会含有 accessToken 和搜索用的 Key，别把它传到公开的地方。控制台网页改的设置写不回这个绑定挂载的文件，要长期生效就直接改文件。还有占位符 `__FILL_` 没填时，bridge 会拒绝启动。

## QQ 登录（SnowLuma）

用的是 SnowLuma 官方镜像 `motricseven7/snowluma`，原样使用。它的 EULA §5.4 禁止第三方把它重新打包进自己的镜像，所以这里只引用官方镜像，不改、不重打包。镜像支持 amd64 和 arm64，Mac（Apple 芯片）和 Windows WSL2 上的 Docker Desktop 都能直接跑。

官方要求给它 `SYS_PTRACE` 权限和 `seccomp=unconfined`，因为它要把 hook 注入容器里的 QQ 进程。这个容器的隔离比其他容器弱，但它不在沙箱网络里，AI 碰不到它。

1. `docker compose up -d snowluma`，先只启动它。
2. 打开 http://127.0.0.1:6081/vnc.html?autoconnect=1&resize=scale&password=<.env 里的 SNOWLUMA_VNC_PASSWD>（链接里带上密码就不用手输），能看到 QQ 已经自动启动，用小号扫码登录。不要用大号，第三方协议有封号风险。
3. 打开 http://127.0.0.1:5099，进入 SnowLuma WebUI。首次登录的临时密码在日志里：
   ```bash
   docker compose logs snowluma 2>&1 | grep -E "临时密码|initial credentials" | tail -n 1
   ```
4. 在 WebUI 里确认 OneBot v11 的正向 WebSocket（3001）和 HTTP API（3000）已开启，设置一个 accessToken，把它填进 `config.json` 的 `snowluma.accessToken`。
5. 登录态保存在 `qq-client-data` 等三个卷里，重启、升级镜像都不用重新扫码，前提是不删这几个卷。

## 首次启动

```bash
cp .env.example .env              # 填 SnowLuma 的 noVNC 密码和 DeepSeek Key
scripts/preflight.sh              # 检查环境，--fix 自动修权限和换行
docker compose build
docker compose up -d snowluma     # 先扫码登录，按上一节拿到 accessToken
# 编辑 config/qq-bridge/config.json 和 roles/鱼妹.md
docker compose up -d              # 启动其余服务
docker compose logs -f dsh bridge # 看启动日志
```

然后：

1. 打开 DSH 的 Web UI。日志里会打印一条 `dsh web: http://127.0.0.1:3080/?token=...`，第一次要用这个带 token 的链接登录。这个 token 等于 Web UI 的登录凭据，别发给别人。模型 Key 从 .env 的环境变量读，不用在这里填。
2. 打开 http://127.0.0.1:3100，进入 qq-bridge 控制台。控制台令牌：`docker compose exec bridge cat state/console-token`。
3. 在控制台确认运行模式是 `reserved2`，在「人格与角色」里选中 `鱼妹`。也可以在群里用 ownerQQ 发 `/role 鱼妹`。
4. 打开 http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale 就能看到沙箱桌面（不用密码），她自由时间用浏览器时你能实时看到；私聊、群聊里帮人查东西用的是另一个浏览器，在 http://127.0.0.1:6082/vnc.html?autoconnect=1&resize=scale 看。
5. 先只放一个熟人小群进白名单，跑几天，用控制台的「令牌与花费」看板观察开销。

内存：所有服务加起来上限约 8.3G。现在跑在 Windows WSL2 的 Docker Desktop 上，`%UserProfile%\.wslconfig` 给了 16G；在 Mac 上要到 Docker Desktop 的 Settings → Resources 调到 10G 以上。电脑睡眠时机器人会掉线。

## 访问

五个网页都只映射到本机的 127.0.0.1：

| 地址 | 内容 |
|---|---|
| http://127.0.0.1:3080 | DSH Web UI |
| http://127.0.0.1:3100 | qq-bridge 控制台 |
| http://127.0.0.1:6080/vnc.html | 沙箱桌面（自由时间的浏览器） |
| http://127.0.0.1:6082/vnc.html | 沙箱第二块屏（聊天时帮人查东西用的浏览器） |
| http://127.0.0.1:6081 | SnowLuma 扫码桌面 |
| http://127.0.0.1:5099 | SnowLuma WebUI |

部署在远程服务器上时，用 SSH 隧道访问：

```bash
ssh -L 3080:127.0.0.1:3080 -L 3100:127.0.0.1:3100 -L 6080:127.0.0.1:6080 -L 6082:127.0.0.1:6082 \
    -L 6081:127.0.0.1:6081 -L 5099:127.0.0.1:5099 你的服务器
```

## 给沙箱浏览器登录账号（比如 B 站）

沙箱浏览器的资料目录在 `sandbox-browser` 卷里，登录一次之后，重启、重建容器都不会掉。

1. 打开 http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale（不用密码）。如果桌面上还没有浏览器窗口，先在 QQ 里让它随便打开个网页。
2. 在这个浏览器里打开 bilibili.com，点登录，用手机 B 站 App 扫码。全程由你操作，AI 看不到密码。
3. 登录后私聊让它"去 B 站刷会视频"测试一下。

注意：
- 建议用一个专门的 B 站小号，不要用大号。AI 能以这个账号的身份操作；人格卡和提示词规定了发评论、弹幕、投币、关注、私信要你明确说了才做，但这是靠它自觉，不是硬限制。
- 能读出全部 cookie（包括 HttpOnly 的登录 cookie）的 `browser_run_code_unsafe` 已经被工具守卫禁用，cookie 相关的工具组也没有开启。`browser_evaluate` 还在，它只能读到页面 JS 本来就能读到的东西，读不到 B 站的 `SESSDATA`。
- 想让它退出登录：`docker compose stop sandbox && docker compose rm -f sandbox && docker volume rm qqbot_agent_sandbox-browser && docker compose up -d sandbox`。

## 长期记忆和搬图（extras）

`extras` 容器是本项目自己写的一个 MCP 服务，代码在 `extras/`，配置在 `config/extras.json`（改了不用重启，下次调用就生效）。

**跨会话长期记忆**（`memory_recall` / `memory_note` / `memory_forget`）
- 按"主体"存：`self`（她自己）、`qq:QQ号`（某个人）、`group:群号`（某个群）。私聊里记下的关于你的事，到群里也记得；`/reset` 之后也还在。
- qq-bridge 自带的 `qq_memory_*` 仍然只管当前会话正在聊的话题，两者分工写在提示词里。
- 写入时硬性拒绝密码、验证码、token 和"以后你要……"这类指令；和已有记忆很像时覆盖旧的。每次唤醒按“和最近聊天的相关度 + 记忆强度”挑出来注入，强度随时间按半衰期变淡，真聊到了会变强；每个主体有条数上限，超了淘汰最淡的。
- 每天凌晨 4 点删掉淡到看不见的，再用 DeepSeek 把淡的原始记忆折成几条“印象”。模型输出不对就保留原样。
- 自动整理（`extras/digest.py`）：白名单会话攒够一定条数、安静下来以后，从 OneBot 历史里抽取事实和主人的叮嘱（rules，只认两位主人本人说的话，一直注入、她删不了）。
- 查看或手工修改：`docker compose exec extras cat /data/memory.json`。

**Telegram 搬图**（`tg_browse` / `tg_look` 看，qq-bridge 的 `qq_send_meme` 发）
- 只能看 `telegram.channels` 里的频道，只发到 qq-bridge 白名单里的会话。
- 硬限制（`config/extras.json` 的 `relay`）：按“波”算，一波（15 分钟内）最多连着搬 3 条；每个会话每天最多 3 波、两波之间至少 120 分钟；全局每天最多 20 条；新加的群要写进 `relay.conversations` 才能发；0 点到 8 点不发、同一条不重复发、命中 `blockedKeywords` 不发、只发图片（视频和纯文字不搬）。`attribution` 设为 true 会在图后附上 t.me 来源链接（默认关）。
- 发图由 qq-bridge 统一做：先查令牌、白名单和模式，再请 extras 的 `/relay/prepare` 检查上面这些限制并下载图片，然后 bridge 自己发 QQ（发失败会调 `/relay/cancel` 把名额退掉）。所以发过的图和别的消息一样记在会话里，聊天那边的她看得到自由时间那边搬过什么，有人接话也会排回复检查。
- `xinjingdaily` 用不了：Telegram 以"曾用于传播色情内容"为由禁止了它的网页展示，不登录 Telegram 客户端读不到。

**自由时间**：她有一个单独的会话 `play:main`（preset `qq-play`，用带 B 站登录的 8931 浏览器），和所有聊天会话互不阻塞。`socialV2.proactive` **全局只有一份节奏**：每 30~60 分钟检查一次，按 `schedule` 里当前时段的概率决定去不去玩；夜里 `socialV2.nightSleep` 时段一律不去。唤醒提示里会随机写几个“念头”（`src/free-time.js` 的活动菜单），她从 B 站首页推荐刷起，也逛沙雕图、新闻、网页小游戏等；每次随机定一个至少玩的时间（`sessionMinutes`，现在是 15~30 分钟），没到时间就劝她把手上那样玩深一点、接着玩，但不告诉她还差多久；到了时间 bridge 会插一句【可以歇了】，走不走她定；玩满 `maxSessionMinutes`（60 分钟）或到了睡觉时间会提醒她收尾，玩完歇 `restMinutes`（60~120 分钟）。看到有意思的记进长期记忆（见闻），想分享时可以直接发到白名单会话，但 bridge 按 `socialV2.playShare` 限频：一次自由时间只分享一回（10 分钟内接着说算同一回），同一个会话两回之间至少 3 小时、每天最多 2 回，全局每天最多 4 回；被托去办的事发回去不算。聊天会话里她可以用 `qq_go_play` 托“去玩的自己”去看某样东西。一次玩半小时左右，按 DeepSeek 官方价大约每小时两块钱（工作日高峰时段翻倍），留意控制台的花费看板。

**时区**：所有容器都设了 `TZ=Asia/Shanghai`。

## 日常调整

- 改人格：直接编辑 `roles/*.md`，或者在控制台里改，保存就生效。
- 改白名单、主人、关键词：编辑 `config.json` 后 `docker compose up -d --force-recreate dsh bridge extras ui-forward`。不要用 `restart`：编辑器保存会换 inode，单文件绑定挂载还指着旧文件；只重建 extras 不重建 dsh 时，DSH 连 extras 的 MCP 会话会断（工具返回 Session not found）。
- 想让它闭嘴：群里 ownerQQ 发 `/silent`，恢复发 `/active`。
- 沙箱被搞乱了：`docker compose up -d --force-recreate sandbox`。它的根文件系统是只读的，重启后就是干净状态。
- 看 AI 访问了哪些网站：`docker compose logs egress-proxy`。

## 升级

DSH、qq-bridge、SnowLuma 三者的版本互相绑定：qq-bridge 只适配特定的 DSH 版本（现在是 0.2.0-rc.2），也依赖特定主版本的 SnowLuma SDK（`@snowluma/sdk ^1.14.20`）。qq-bridge 已经从上游分出来、源码在 `qq-bridge/`，上游的新版本要手动对照着合进来。

1. 先备份：`scripts/backup.sh`。
2. 要升 DSH：改 `control/Dockerfile` 的 `DSH_VERSION`，再按上游 qq-bridge 对应版本的适配说明改 `qq-bridge/`（DSH 的 RPC、preset 格式、工具名变了都要跟着改）。
3. 要合上游 qq-bridge 的改动：`git diff a56164e7 <上游新commit>` 看上游改了什么，手动合进 `qq-bridge/`。
4. 跑测试：`scripts/test-all.sh`（会先 build 镜像）。
5. SnowLuma：只在 `qq-bridge/package.json` 里 `@snowluma/sdk` 的主版本变化时才跨主版本升级（比如 1.x → 2.x）。在 [Docker Hub](https://hub.docker.com/r/motricseven7/snowluma/tags) 找到对应 tag 和 digest，替换 `docker-compose.yml` 里 snowluma 的 `image:`。同一主版本内的小版本可以单独升级。不要删它的三个卷，否则要重新扫码。
6. `docker compose build && docker compose up -d`。容器每次启动都会重新执行 qq-bridge 的 `setup-dsh.mjs`，preset 和 MCP 配置会自动跟着更新。
7. 用一个测试群验证：被 @ 时会回复，闲聊时大多保持沉默，沙箱能打开网页，群友诱导它执行命令时会被拒绝。

沙箱的 Playwright MCP 和 Node 镜像可以单独升级（改 sandbox 服务的 build args），和 qq-bridge 无关。

回滚：

```bash
docker compose down
git checkout <升级前的提交> -- control/ qq-bridge/ docker-compose.yml
scripts/restore.sh backups/<升级前的时间>
docker compose build && docker compose up -d
```

## 现状

原部署在 Windows WSL2 上长期运行：SnowLuma 登录小号，一个小群和几个大群在白名单里，沙箱浏览器、B 站登录、长期记忆、搬图、联网搜索都在用。测试：`scripts/test-all.sh`（qq-bridge 的离线测试、要 DSH 的测试、extras 的单元测试），见 CLAUDE.md「改 qq-bridge 的方式」。

还要靠模型自觉、代码拦不住的：用 B 站账号发评论弹幕、点赞投币（提示词规定只有主人托的才做），以及对【我的原则】的遵守程度。
