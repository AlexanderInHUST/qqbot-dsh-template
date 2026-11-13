// QQ 原生工具（2026-11-08，架构调整第 3 步）：照 src/qq-capabilities.js 的能力表把 QQ 工具直接注册成 DSH 工具，
// 不再经过 MCP 进程（src/mcp-snowluma-safe.js）。DSH 执行工具时带着是哪个会话调的（exec.agent.id），
// 这里放进 x-agent-session 头，桥接换成那个会话自己的令牌，所以参数里不用 key 和 token。
// 行的 config.side 选哪一边的工具：'play'（qq-play，发东西写 to）或 'chat'（qq-chat-v2，只管调用它的这个聊天）。
// socialV2.tools 里关掉的不注册（改了配置要重建 dsh）。
// 和 qq-tool-restrict 一样是 bundle 里的唯一实现，preset 目录下的同名文件只是 re-export 壳。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilitiesFor, capabilityEnabled, checkArgs, parametersOf } from '../../src/qq-capabilities.js'
import { serializeModelData } from '../../src/qq-model-view.js'

export const name = 'qq-native-tools'

export const inject = ['tools']

// 插件真实位置是 <bridge>/plugins/qq-agent-presets/，桥接的 config.json、state/ 在 <bridge> 下（同 MCP 那边的 ROOT）
const ROOT = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '../..')

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// 和 mcp-snowluma-safe.js 的 readConsoleToken 同一口径：config.json 里合格的 consoleToken，没有就 state/console-token
function readConsoleToken(cfg) {
  const configured = String(cfg.consoleToken ?? '').trim()
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value)
      if (text && text !== '{}') return text.slice(0, 500)
    } catch {}
  }
  return fallback
}

const OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

// 一边的工具定义（测试直接调它，指着测试里的桥接）。consoleToken 是函数：每次请求都重新读，令牌换了不用重启
export function nativeToolDefs({ side, cfg, base, consoleToken, log = console.error }) {
  // 用 node:http 不用 fetch：qq_wait_for_messages 私聊里最多等 600 秒，fetch（undici）300 秒没回头就断（headersTimeout）
  function request(method, urlPath, { headers, payload, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
      const req = http.request(new URL(urlPath, base), { method, headers }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => { finish(); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }) })
        res.on('error', (e) => { finish(); reject(e) })
      })
      const timer = setTimeout(() => {
        const e = new Error('timeout')
        e.name = 'TimeoutError'
        req.destroy(e)
      }, timeoutMs)
      const onAbort = () => req.destroy(signal.reason ?? new Error('aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      function finish() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      req.on('error', (e) => { finish(); reject(e) })
      req.end(payload)
    })
  }

  async function bridge(method, urlPath, { sessionId, body, timeoutMs, signal }) {
    const headers = { 'x-agent-call': '1', 'x-agent-session': sessionId }
    const token = consoleToken()
    if (token) headers['x-console-token'] = token
    let payload
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
      headers.origin = base
    }
    const res = await request(method, urlPath, { headers, payload, timeoutMs, signal })
    let data = null
    try { data = JSON.parse(res.text) } catch {}
    if (res.status < 200 || res.status >= 300) throw new Error(errorText(data?.error, `桥接 HTTP ${res.status}`))
    // 有的接口用 200 + {ok:false} 说业务失败（被拦、没发出去），不能当成功
    if (data && typeof data === 'object' && data.ok === false) throw new Error(errorText(data.error, '没说原因'))
    return data
  }

  // 会话 id → 窗口 key（会话重置后是新的 id，旧的留着也不会再用）
  const keyOf = new Map()
  let loggedFirst = false
  async function whoami(sessionId, signal) {
    if (keyOf.has(sessionId)) return keyOf.get(sessionId)
    const data = await bridge('GET', '/api/socialV2/whoami', { sessionId, timeoutMs: 10000, signal })
    keyOf.set(sessionId, data.key)
    if (!loggedFirst) {
      loggedFirst = true
      log(`[qq-native-tools] 第一次调用：会话 ${sessionId} 是 ${data.key}`)
    }
    return data.key
  }

  return capabilitiesFor(side).filter((cap) => capabilityEnabled(cap, cfg)).map((cap) => ({
      name: cap.name,
      description: cap.description(cfg),
      parameters: parametersOf(cap, cfg),
      output: OUTPUT,
      async execute(rawArgs, exec) {
        // 聊天那边以前的 MCP 版要填 key、token，压缩前的会话记录里都是这么调的：照填的话拿掉，key 不是这里就说清楚该用什么
        let args = rawArgs ?? {}
        let claimedKey
        if (side === 'chat' && args && typeof args === 'object' && !Array.isArray(args) && ('key' in args || 'token' in args)) {
          const { key, token: _token, ...rest } = args
          claimedKey = key
          args = rest
        }
        // DSH 不替原生工具查参数
        const bad = checkArgs(cap, args)
        if (bad) throw new Error(`${cap.errorPrefix}${bad}`)
        const sessionId = String(exec?.agent?.id ?? '')
        if (!sessionId) throw new Error(`${cap.errorPrefix}不知道是哪个会话调的`)
        try {
          const key = await whoami(sessionId, exec.signal)
          if (claimedKey !== undefined && claimedKey !== null && claimedKey !== '' && String(claimedKey) !== key) {
            throw new Error(`${cap.name} 只管这个聊天（${key}），不用填 key；要现在去别处说一句用 qq_send_elsewhere，要别处的你以后去做用 qq_tell_myself，这里都做不到就照实说`)
          }
          const req = cap.call(args, { key })
          const data = await bridge(req.method, req.path, { sessionId, body: req.body, timeoutMs: req.timeoutMs, signal: exec.signal })
          return { text: serializeModelData(data) }
        } catch (error) {
          const message = error?.name === 'TimeoutError' ? '桥接太久没回' : error?.name === 'AbortError' ? '这一轮停了' : (error?.message ?? String(error))
          throw new Error(`${cap.errorPrefix}${message}`)
        }
      },
  }))
}

export function apply(ctx, config = {}) {
  const side = typeof config?.side === 'string' ? config.side : 'play'
  const cfg = loadConfig()
  const defs = nativeToolDefs({
    side,
    cfg,
    base: `http://127.0.0.1:${Number(cfg.consolePort) || 3100}`,
    consoleToken: () => readConsoleToken(loadConfig()),
  })
  for (const def of defs) ctx.tools.register(def)
  console.error(`[qq-native-tools] ${side} 注册了 ${defs.length} 个工具：${defs.map((d) => d.name).join(', ')}`)
}
