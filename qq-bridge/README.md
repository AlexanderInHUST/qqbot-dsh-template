# qq-bridge

QQ（SnowLuma，OneBot v11）和 DeepSeek Harness 之间的桥接。2026-10-24 从上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) v0.2.0-r4（a56164e7）分出来，之后都在这个仓库里改，跑在 docker compose 的 bridge 容器里（control/Dockerfile 直接 `COPY qq-bridge/`）。

怎么部署、现在有哪些功能、开关在哪、日志怎么查，都在仓库根目录的 README.md 和 CLAUDE.md。QQ 会话的权限边界见 [RULES.md](RULES.md)。

```
QQ ──► SnowLuma（OneBot v11 WS）──► bridge ──► DSH Web API
                                       ▲            │
                                       └── 她调的 QQ 工具（原生工具 / MCP）
```

## 改代码

```sh
npm ci                                  # 第一次；node_modules 和 state/ 不进 git
node scripts/build-agent-preset-patches.mjs   # 改了 dsh/agent-presets 以后
npm test                                # 所有离线测试；npm test test-foo 只跑名字带 test-foo 的
cd .. && scripts/test-all.sh            # 镜像里跑要 DSH 的测试和 extras 的单元测试
```

## 目录

```
src/bridge.js        入口：收发 QQ、DSH 会话、出口关卡等
src/app/             二代社交（reserved2）的模块，每个 createX(app)
src/*.js             纯函数库（能力表、家里外面、门控、定时……）
dsh/agent-presets/   qq-chat-v2（聊天）、qq-play（自由时间）、qq-chat（黑话学习）的 preset
plugins/             DSH 插件 qq-agent-presets（人格卡、工具藏起来、原生 QQ 工具）
public/              控制台网页
scripts/             测试（test-*.mjs）、构建和运维脚本
config.example.json  配置模板（真的 config.json 不进 git）
```

## SnowLuma 的几个已知行为

- **连上了不等于收得到。** SnowLuma 的 `[Hook]` 会退化：进程和 WebSocket 都活着，但收不到 QQ 的消息（它自己的日志里是 `receive path stale … reporting good=false`）。桥接看每 30 秒心跳里的 `status.good`，每 60 秒再问一次 `get_status`，退化时日志和控制台的“SnowLuma 上游”卡片会写出来。`good` 不能从 `get_login_info` 取：它只返回 `{user_id, nickname}`，SDK 不校验，`good` 会一直是 `null`。连着但一个事件包都没有的情况另外由 src/rx-watch.js 重连、告警。
- **HTTP token 和 WS token 是两个值。** `snowluma.accessToken` 里存的是 HTTP 那个，所以每次启动第一次 WS 连接几乎都会失败一次（`code=1006`），桥接从 SnowLuma 的 `config/onebot_<QQ号>.json` 重新找到 WS token 后才连上。一直连不上时先看 `snowluma.homeDir` 读不读得到这个文件。
- **端点自愈会改写 `wsUrl`。** 连不上时桥接重新发现 SnowLuma 的端点并写回 config.json。要指向别处时设 `"snowluma": { "followDiscoveredEndpoint": false }`，这样只自愈 token。
- `@snowluma/sdk` 的 npm 发布版有 ESM 扩展名的 bug，`npm ci` 时 postinstall 的 scripts/patch-snowluma-sdk.mjs 修。
- SnowLuma 上游 2026-11 起没了，我们用的镜像存了一份，见 CLAUDE.md 的“坑”。

SnowLuma 是独立的第三方项目，和腾讯、QQ 没有关系；使用前读它的 EULA 和《QQ 用户协议》。
