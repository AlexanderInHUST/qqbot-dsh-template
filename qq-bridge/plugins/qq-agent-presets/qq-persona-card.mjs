// qqbot_agent：把人格卡放进系统提示。
//
// 以前人格卡只在 qq_get_prompt 的返回里：那是一条工具结果，会话一压缩就没了，压缩后她只剩唤醒提示里
// “【当前角色】鱼妹”这一行，说话就越来越不像她。现在 bridge 把处理好的二代人格卡写到
// state/role-card-v2.md（见 bridge.js 的 syncRoleCardFileV2），这个插件注册提示词变量 qq_role_card，
// persona 行的 prefix 里写 {{qq_role_card}}，每次装配系统提示时读一次（按 mtime + 大小缓存）。
//
// 文件不存在、是空的（bridge 关了 socialV2.systemPromptCard）、或读不了时填 fallback：
// 叫她去 qq_get_prompt 看，和以前一样。
import fs from 'node:fs'

export const name = 'qq-persona-card'

export const inject = ['systemPrompt']

export const DEFAULT_FILE = '/opt/qq-bridge/state/role-card-v2.md'
export const DEFAULT_FALLBACK = '（人格卡没有放在这里：第一次进入会话、或者拿不准自己是谁、怎么说话时，调用 qq_get_prompt 查看完整人格卡。）'
// 人格卡文件的上限：bridge 已经按 role.maxInjectChars（最多 2 万字）截过，这里只防坏文件
const MAX_BYTES = 256 * 1024

export function createRoleCardReader(file = DEFAULT_FILE, fallback = DEFAULT_FALLBACK) {
  let cached = null // { mtimeMs, size, text }
  return function read() {
    let st
    try {
      st = fs.statSync(file)
    } catch {
      cached = null
      return fallback
    }
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.text || fallback
    let text = ''
    try {
      if (st.isFile() && st.size <= MAX_BYTES) text = fs.readFileSync(file, 'utf8').trim()
    } catch {
      text = ''
    }
    cached = { mtimeMs: st.mtimeMs, size: st.size, text }
    return text || fallback
  }
}

export function apply(ctx, config = {}) {
  const file = typeof config?.file === 'string' && config.file ? config.file : DEFAULT_FILE
  const fallback = typeof config?.fallback === 'string' && config.fallback ? config.fallback : DEFAULT_FALLBACK
  const read = createRoleCardReader(file, fallback)
  ctx.effect(() => ctx.systemPrompt.variable('qq_role_card', () => read()), 'qq-persona-card.variable()')
}
