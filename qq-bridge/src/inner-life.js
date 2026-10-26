// qqbot_agent：她自己的心情、兴趣和“想找人说点什么”——这里只放纯函数，状态和调用在 bridge.js。
//
// 心情（socialV2.moodEngine）：一轮聊天 / 自由时间结束后让 extras 的小模型体会一下她现在什么心情
//   （一个词、为什么、valence 高兴程度 / arousal 兴奋程度，各 -2..2）。bridge 记下来，按半衰期淡回平常，
//   而且真的影响她做的事：群里愿意说多少（门控 talkValue ×0.7~1.3）、一次发几条（±1）、自由时间想玩什么。
//   以前只有 qq_set_mood 一种来源，48 小时她只调过一次，心情基本是空的或过期的；光有文字也没用
//   （MaiBot 0.12 把纯文字心情删了），所以要接到行为上。思路参考 Sentipolis（arXiv 2601.18027）：
//   快速评估 + 慢慢淡回、给模型看词不看数字。
// 兴趣（socialV2.life.interest）：自由时间里她每记一条见闻都打了 interest（1~3），按当时在玩的那一类
//   做指数平均；喜欢的那类以后抽“念头”时权重高一点，不喜欢的低一点。
// 主动找人（socialV2.initiate）：闲着时让 extras 想想有没有想跟谁说的事，每个念头 1~5 分打几项
//   （思路来自 Inner Thoughts，CHI 2025），过阈值才叫醒她去说；加每天次数、间隔、“找了两次都没回就别找了”。

export const DEFAULT_MOOD_HALF_LIFE_MIN = 120

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

// 心情还剩多少（刚定 1，每个半衰期减半）
export function moodIntensity(mood, now, halfLifeMin = DEFAULT_MOOD_HALF_LIFE_MIN) {
  if (!mood?.at) return 0
  const age = Math.max(0, now - Number(mood.at)) / 60000
  return 0.5 ** (age / Math.max(1, num(halfLifeMin, DEFAULT_MOOD_HALF_LIFE_MIN)))
}

// 淡过之后的 valence / arousal（没有数值的心情，比如她自己用 qq_set_mood 定的，算 0）
export function moodEffect(mood, now, halfLifeMin) {
  const k = moodIntensity(mood, now, halfLifeMin)
  // 淡到“当作平常”（moodPhase 'gone'）就不再影响行为，和提示里写的一致
  if (k < 0.25) return { k, valence: 0, arousal: 0 }
  return { k, valence: clamp(num(mood?.valence), -2, 2) * k, arousal: clamp(num(mood?.arousal), -2, 2) * k }
}

// 'fresh' 照原样写；'fading' 写“淡了不少”；'gone' 当作平常
export function moodPhase(mood, now, halfLifeMin) {
  const k = moodIntensity(mood, now, halfLifeMin)
  return k >= 0.5 ? 'fresh' : k >= 0.25 ? 'fading' : 'gone'
}

// 群里愿意说多少：开心、来劲时多说点，蔫了、不高兴时少说点
export function moodTalkFactor(mood, now, halfLifeMin) {
  const e = moodEffect(mood, now, halfLifeMin)
  return clamp(1 + 0.15 * e.valence + 0.1 * e.arousal, 0.7, 1.3)
}

// 一次发几条：兴奋时多一条，蔫的时候少一条
export function moodBubbleDelta(mood, now, halfLifeMin) {
  const { arousal } = moodEffect(mood, now, halfLifeMin)
  // 刚体会到的 1 衰减一点点就不到 1 了，留点余量
  return arousal >= 0.75 ? 1 : arousal <= -0.75 ? -1 : 0
}

// 自由时间抽念头的权重：低落 / 没劲时想看点安静的，兴奋时想玩点闹的
const CALM_KINDS = ['space', 'cook', 'wiki', 'acg']
const LIVELY_KINDS = ['game', 'tg', 'forum', 'hot']
export function moodActivityWeights(mood, now, halfLifeMin) {
  const e = moodEffect(mood, now, halfLifeMin)
  const out = {}
  const set = (ids, m) => { for (const id of ids) out[id] = (out[id] ?? 1) * m }
  if (e.valence <= -0.8 || e.arousal <= -0.8) { set(CALM_KINDS, 1.5); set(LIVELY_KINDS, 0.7) }
  else if (e.arousal >= 0.8) { set(LIVELY_KINDS, 1.5); set(CALM_KINDS.filter((id) => id !== 'acg'), 0.7) }
  return out
}

// ── 兴趣 ──────────────────────────────────────────────────────────────

// 记一条见闻的 interest（1~3）到这一类活动上：指数平均
export function updateInterest(interest, kind, value, now, alpha = 0.3) {
  if (!kind) return interest
  const v = clamp(Math.round(num(value, 2)), 1, 3)
  const e = interest[kind]
  interest[kind] = e && e.n > 0
    ? { ema: Math.round((e.ema + alpha * (v - e.ema)) * 1000) / 1000, n: e.n + 1, at: now }
    : { ema: v, n: 1, at: now }
  return interest
}

// 一类活动的兴趣系数：记过 2 条以上才算数；一般 0.7、有意思 1.05、超喜欢 1.4
export function interestFactor(entry) {
  if (!entry || !(entry.n >= 2)) return 1
  return clamp(0.7 + 0.35 * (num(entry.ema, 2) - 1), 0.7, 1.4)
}

// 兴趣和心情合起来的权重系数 { 活动id: 系数 }
export function activityMultipliers(list, { interest = {}, mood = null, now = Date.now(), halfLifeMin, useInterest = true, useMood = true } = {}) {
  const moodW = useMood ? moodActivityWeights(mood, now, halfLifeMin) : {}
  const out = {}
  for (const a of list) {
    const m = (useInterest ? interestFactor(interest[a.id]) : 1) * (moodW[a.id] ?? 1)
    if (m !== 1) out[a.id] = Math.round(m * 1000) / 1000
  }
  return out
}

// 她最近更喜欢玩的（给早上想今天干嘛用）
export function likedKinds(list, interest, n = 3) {
  return list
    .filter((a) => interest[a.id]?.n >= 2 && interest[a.id].ema >= 2)
    .sort((a, b) => interest[b.id].ema - interest[a.id].ema)
    .slice(0, n)
    .map((a) => a.name)
}

// ── 主动找人 ──────────────────────────────────────────────────────────

export function clockMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

// date 在不在 [from, to) 这段钟点里（可以跨午夜）
export function inClockWindow(from, to, date) {
  const f = clockMinutes(from)
  const t = clockMinutes(to)
  if (!Number.isFinite(f) || !Number.isFinite(t) || f === t) return true
  const m = date.getHours() * 60 + date.getMinutes()
  return f < t ? m >= f && m < t : m >= f || m < t
}

export function initiateCfg(c = {}) {
  const n = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    enabled: c.enabled === true,
    targets: Array.isArray(c.targets) ? c.targets.map(String) : [],
    intervalMinutes: Array.isArray(c.intervalMinutes) ? c.intervalMinutes : [30, 60],
    threshold: n(c.threshold, 3.5),
    perTargetPerDay: n(c.perTargetPerDay, 2),
    globalPerDay: n(c.globalPerDay, 4),
    minIntervalMinutes: n(c.minIntervalMinutes, 180),
    declineCooldownMinutes: n(c.declineCooldownMinutes, 120),
    maxUnanswered: n(c.maxUnanswered, 2),
    unansweredResetDays: n(c.unansweredResetDays, 3),
    minSilenceMinutes: n(c.minSilenceMinutes, 60),
    answerWindowMinutes: { private: n(c.answerWindowMinutes?.private, 360), group: n(c.answerWindowMinutes?.group, 30) },
    from: String(c.from ?? '09:00'),
    to: String(c.to ?? '22:30'),
    byKey: c.byKey && typeof c.byKey === 'object' && !Array.isArray(c.byKey) ? c.byKey : {},
  }
}

// 某一处单独的规矩（byKey 里的 threshold / perTargetPerDay / minIntervalMinutes / minSilenceMinutes /
// declineCooldownMinutes / maxUnanswered / unansweredResetDays），没写的用全局的；globalPerDay 一直按全局算
const PER_KEY = ['threshold', 'perTargetPerDay', 'minIntervalMinutes', 'minSilenceMinutes', 'declineCooldownMinutes', 'maxUnanswered', 'unansweredResetDays']
export function initiateCfgFor(c, key) {
  const o = c.byKey?.[key]
  if (!o || typeof o !== 'object') return c
  const out = { ...c }
  for (const k of PER_KEY) if (o[k] !== undefined && o[k] !== null && Number.isFinite(Number(o[k]))) out[k] = Number(o[k])
  return out
}

// 现在能不能主动去找 key：不能就返回原因（写日志用），能就返回 ''
// initiates：[{ key, at, thought, sent, declined, answeredAt }]，at 是叫醒她的时间
export function initiateBlockReason(initiates, key, now, c) {
  const day = initiates.filter((x) => x.sent && now - Number(x.at) < 86400000)
  if (c.globalPerDay > 0 && day.length >= c.globalPerDay) return `今天已经主动找过 ${day.length} 次人了`
  const mine = day.filter((x) => x.key === key)
  if (c.perTargetPerDay > 0 && mine.length >= c.perTargetPerDay) return `今天已经主动找过这里 ${mine.length} 次`
  const lastSent = mine.at(-1)
  if (lastSent && now - Number(lastSent.at) < c.minIntervalMinutes * 60000) return '离上次主动找这里太近'
  const lastDeclined = initiates.filter((x) => x.key === key && x.declined).at(-1)
  if (lastDeclined && now - Number(lastDeclined.at) < c.declineCooldownMinutes * 60000) return '上次想找这里她没开口，过会儿再说'
  let unanswered = 0
  for (const x of initiates.filter((y) => y.key === key && y.sent).reverse()) {
    if (x.answeredAt || now - Number(x.at) > c.unansweredResetDays * 86400000) break
    unanswered++
  }
  if (c.maxUnanswered > 0 && unanswered >= c.maxUnanswered) return `连着找了 ${unanswered} 次都没人理`
  return ''
}

// 来了一条别人的消息：最近一次主动找这里、还没人回的那次算回了（私聊 6 小时内、群里 30 分钟内）
export function markInitiateAnswered(initiates, key, now, c) {
  const x = initiates.filter((y) => y.key === key && y.sent && !y.answeredAt).at(-1)
  if (!x) return null
  const windowMs = (String(key).startsWith('private:') ? c.answerWindowMinutes.private : c.answerWindowMinutes.group) * 60000
  const since = Number(x.sentAt || x.at)
  if (now < since || now - since > windowMs) return null
  x.answeredAt = now
  return x
}

// extras 给的念头里挑一个：过阈值、目标还在可选名单里，分最高的那个
// threshold 可以是数，也可以是 key => 阈值 的函数（每处的阈值不一样）
export function bestThought(thoughts, threshold, keys) {
  const ok = new Set(keys)
  const th = typeof threshold === 'function' ? threshold : () => threshold
  return (Array.isArray(thoughts) ? thoughts : [])
    .filter((t) => t && ok.has(String(t.key)) && String(t.thought ?? '').trim() && num(t.score, -1) >= th(String(t.key)))
    .sort((a, b) => num(b.score) - num(a.score))[0] ?? null
}
