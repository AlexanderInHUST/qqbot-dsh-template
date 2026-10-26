// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // qqbot_agent：隔离沙箱容器里的浏览器与虚拟桌面（无 shell、无宿主文件、无登录态）。
  // 沙箱只在内部网络，出网经过拒绝内网地址的代理，见 qqbot_agent/sandbox/。
  'mcp__sandbox-browser__',
  'mcp__sandbox-browser-chat__',
  'mcp__sandbox-desktop__',
  // qqbot_agent：跨会话长期记忆与 Telegram 搬图（白名单频道、限频、只发到白名单会话），见 qqbot_agent/extras/。
  'mcp__qqbot-extras__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

// qqbot_agent：沙箱前缀整体放行，但其中个别工具等于在沙箱里执行任意代码，单独拒绝。
// browser_run_code_unsafe 在 Playwright 服务进程里跑任意 JS（官方标注 RCE-equivalent），
// 能读到包括 HttpOnly 在内的全部 cookie，也能起子进程，相当于沙箱里的 shell。
export const SANDBOX_DENIED_TOOLS = Object.freeze([
  'mcp__sandbox-browser__browser_run_code_unsafe',
  'mcp__sandbox-browser-chat__browser_run_code_unsafe',
])
// 不管挂在哪个 MCP 下（虚拟桌面那台以后也换成 Playwright、新加一台浏览器），叫这个名字的一律当执行任意代码（2026-10-24）
const CODE_EXEC_SUFFIX = '__browser_run_code_unsafe'
const isCodeExec = (name) => SANDBOX_DENIED_TOOLS.includes(name) || name.endsWith(CODE_EXEC_SUFFIX)

// qqbot_agent：沙箱里有两台浏览器。玩的那台（sandbox-browser，带 B 站登录，noVNC 里能看到）只给自由时间的
// qq-play 会话用；聊天会话用另一台无头的 sandbox-browser-chat，互不抢页面。守卫行 config.browser 选哪一边：
//   'chat'：拒绝玩的浏览器、虚拟桌面和 bili_watch（它们都在玩的那台上）
//   'play'：拒绝聊天浏览器
//   不写：和以前一样（一代 qq-chat 用）
export const BROWSER_SIDE_DENIED = Object.freeze({
  chat: Object.freeze({
    prefixes: ['mcp__sandbox-browser__', 'mcp__sandbox-desktop__'],
    exact: ['mcp__qqbot-extras__bili_watch'],
    reason: '这是你自由时间玩的那台电脑，聊天的时候用 mcp__sandbox-browser-chat__*；想认真看视频、玩游戏就用 qq_go_play 去玩',
  }),
  play: Object.freeze({
    prefixes: ['mcp__sandbox-browser-chat__'],
    exact: [],
    reason: '这是聊天用的浏览器，玩的时候用 mcp__sandbox-browser__*',
  }),
})

export function apply(ctx, config = {}) {
  const side = BROWSER_SIDE_DENIED[config?.browser] ?? null
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前不存在的工具名会单独抛错，不会导致整批限制失败
  // （restrict 的 unknown 校验是整批原子性的），等注册表变了再试（见下）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  const restrictOne = (name) => {
    try {
      ctx.tools.restrict({ deny: [name] })
      return true
    } catch {
      return false
    }
  }
  // qqbot_agent：守卫行 config.hideTools 列这个 preset 用不着的工具（全名），从工具清单里藏起来、执行时也拒绝。
  // 2026-10-24 数过三天的会话记录：二代模式里旧的只读工具、qq_send_group_message 这些从没调过，每次请求白带着它们的说明。
  const hideTools = Array.isArray(config?.hideTools) ? config.hideTools.filter((n) => typeof n === 'string' && n) : []
  // 名字现在不存在的先记下来，执行期白名单仍然兜底。
  const pending = new Set()
  for (const name of [...KNOWN_DANGEROUS_GLOBAL_TOOLS, ...SANDBOX_DENIED_TOOLS, ...hideTools]) {
    if (!restrictOne(name)) pending.add(name)
  }
  if (pending.size) console.error(`[qq-tool-restrict] 现在还没注册、等出现了再藏：${[...pending].join(', ')}`)

  // qqbot_agent：另一边的浏览器（聊天会话里玩的那台和 bili_watch，自由时间里聊天那台）反正执行时会被拒，
  // 也从工具清单里藏起来：一台 Playwright 二三十个工具，以前聊天会话每次请求都带着两台的（2026-10-24）。
  // 守卫行 config.hideOtherSide:false 回到只在执行时拒绝。
  // 同一遍扫描顺手把别的 MCP 下叫 browser_run_code_unsafe 的也藏起来。
  const hideSide = side && config?.hideOtherSide !== false
  const canScan = typeof ctx.tools.schemas === 'function'
  const hidden = new Set()
  const hideOtherSide = () => {
    if (!canScan) return
    let names = []
    try {
      names = ctx.tools.schemas().map((s) => s?.name).filter((n) => typeof n === 'string')
    } catch {
      return
    }
    for (const name of names) {
      if (hidden.has(name)) continue
      const otherSide = hideSide && (side.exact.includes(name) || side.prefixes.some((prefix) => name.startsWith(prefix)))
      if (!otherSide && !isCodeExec(name)) continue
      if (restrictOne(name)) hidden.add(name)
    }
  }
  hideOtherSide()

  // qqbot_agent：preset 装上时 MCP 还没连上，browser_run_code_unsafe 这些名字不存在，restrict 抛错，
  // 以前就一直留在模型的工具清单里（2026-10-24 查 dsh 日志：每次启动两个都是 skip）。
  // 工具注册表一变（MCP 连上、注入器注册 dev_*）就把没藏住的再 restrict 一遍。
  // restrict 自己也会触发 tools/change，用 busy 挡住重入。
  if ((pending.size || canScan) && typeof ctx.on === 'function') {
    let busy = false
    let dispose
    dispose = ctx.on('tools/change', () => {
      if (busy) return
      busy = true
      const before = hidden.size
      try {
        for (const name of [...pending]) {
          if (!restrictOne(name)) continue
          pending.delete(name)
          console.error(`[qq-tool-restrict] ${name} 注册上了，已从工具清单里藏起来`)
        }
        hideOtherSide()
      } finally {
        busy = false
      }
      if (hidden.size > before) console.error(`[qq-tool-restrict] 按名字又藏起 ${hidden.size - before} 个工具（另一边的浏览器、执行代码的；共 ${hidden.size}）`)
      // MCP 重连可能带来新工具，能扫就一直听着
      if (!pending.size && !canScan) dispose?.()
    })
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (isCodeExec(name)) return `工具 "${name}" 在沙箱里等于执行任意代码，已拒绝`
    if (hideTools.includes(name)) return `工具 "${name}" 在这里用不着，已拒绝`
    if (SAFE_EXACT.has(name)) return
    if (side && (side.exact.includes(name) || side.prefixes.some((prefix) => name.startsWith(prefix)))) return `工具 "${name}" ${side.reason}`
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
