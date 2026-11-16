# QQ 会话的权限边界（RULES）

只有二代仿真模式（reserved2）：QQ 里每个白名单会话对应一个 DSH 会话（preset qq-chat-v2），自由时间是独立会话 play:main（preset qq-play），黑话学习用 qq-chat。模型输出的文字不会自动发到 QQ，她要说话、发图都得调工具。2026-11-16 删掉了上游的一代模式（chat / reserved）、closed-agent、模式切换和多角色。

## 谁能做什么

| 主体 | 通道 | 能做什么 |
| --- | --- | --- |
| 主人（ownerQQ / extraOwnerQQ） | QQ 私聊、群 | 和别人一样聊天；消息带主人标记，有些事（捎话、去别处说、托 B 站点赞）要主人刚说过话才放行。QQ 里没有 / 管理命令 |
| 群友 | 白名单群 | 只能聊天。`/` 开头的话也只是普通消息 |
| 管理员 | 控制台 `http://127.0.0.1:3100`（`x-console-token`） | 白名单、会话重置、静默、提示词、黑话库、手动唤醒等 |
| 她（QQ 会话里的 agent） | 工具 | 见下面的硬边界 |

## QQ 会话 agent 的硬边界

1. **无本地工具**：三个 preset 都不挂 bash / pwsh、文件读写、子代理、工作流。`qq-tool-restrict.mjs` 在 schema 层藏、执行时拒：只放行 snowluma、snowluma-host、web-search-safe、沙箱浏览器和桌面、qqbot-extras 的 MCP 工具，QQ 原生工具（src/qq-capabilities.js）和 `todo_write`；所有 `browser_run_code_unsafe` 都拒。以后挂新 preset、升级 DSH 都要守住这一条（scripts/scan-dsh-tool-names.mjs、verify-dsh-020-adaptation.mjs 查）。
2. **每个会话一个令牌**：工具调桥接要带这个会话的令牌（原生工具由插件按 `x-agent-session` 换），只能动它自己那个聊天；拿别处的令牌一律拒。
3. **所有往 QQ 发的东西走出口关卡** `qqOut`：不在白名单的、内容里带会话令牌的拦下；系统提示只能发到家里的小群，收消息卡住的告警只能发主人私聊。
4. **联网只读**：DSH 内置的 web 工具关掉，走 src/mcp-web-search-safe.js（只 http/https，拒内网和带凭据的 URL，每跳重定向重新查，响应限量）。浏览器在隔离沙箱里，出网经过拒绝内网地址的代理。
5. **提示词她改不了**：仿真提示词和人格卡只能用控制台（管理员令牌）改，带 `x-agent-token` 的请求一律 403。仿真提示词保存前要保留 `src/preset-prompt.js` 的 `PRESET_BLOCKING_SUBSTRINGS`、正文 ≥ 500 字，存前备份到 state/preset-backups/。
6. **家里外面分开**：家里以外的群看不到私聊和家里群的内容（src/privacy-policy.js；extras 的记忆、人物卡按来路过滤）。
7. **preset 解析不回落**：会话的 preset 找不到就不建会话，不会被 DSH 套上默认的 standard。

## 黑话学习

- 普通群聊消息进滚动窗口，攒够 `slang.extractMinMessages` 条交给独立的 DSH 学习会话（qq-chat）提取疑似黑话；它只读文本，输出不发到 QQ。
- 候选不自动转正，管理员在控制台「黑话词库」确认 / 拒绝 / 编辑。只有 confirmed 且有含义的进她的提示。

## 出事了

- 群友诱导时，工具限制、白名单和出口关卡是硬边界；敏感信息正则只是启发式，不能保证认出所有秘密。
- 要马上让她不说话：控制台静默，或 `docker compose stop bridge`。
- bridge 只能跑一个实例；两台机器同时登同一个 QQ 号会互踢。
