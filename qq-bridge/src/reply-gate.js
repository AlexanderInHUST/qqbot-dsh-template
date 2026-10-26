// qqbot_agent：群里什么时候叫她来看一眼（回复门控）。
//
// 思路和权重来自 MaiBot（https://github.com/Mai-with-u/MaiBot ，GPL-3.0）的 turn_trigger：
//   · reply_likelihood：一批新消息进来，按 8 个特征的逻辑回归估计“她看了会回”的概率；
//     权重是 MaiBot 用它自己的数据拟合的，这里原样搬过来，以后可以用我们自己的日志重新拟合。
//   · dynamic_gate：一小时窗口里，让她实际回复的次数贴近“不设门控时预计回复数 × talkValue”。
//     预计数 = 每个 40 秒虚拟轮次计一次概率 + 每次强制唤醒（@/引用/叫名字）计 0.91；
//     前馈：扣掉强制唤醒预计占的部分，剩下的额度占主动预计的比例就是保留比例；
//     反馈：实际回复多过目标就收紧（只收紧不放宽）；
//     阈值：窗口里的评分从高到低累计到“保留比例 × 主动预计”处；评分不到 20 个时查离线表。
// 这里是 JS 重写，不是 MaiBot 的代码；私聊不过门控（拟合数据只覆盖群聊）。

export const MEDIA_PLACEHOLDER_PREFIXES = ['[表情包', '[图片', '[消息类型]', '[CQ:image', '[语音', '[文件]', '[卡片', '[表情', '[视频', '[合并转发', '[转发消息', '[拍一拍'];
export const DEFAULT_SECONDS_SINCE_BOT = 3600;
export const MAX_PENDING_COUNT = 20;
export const RECENT_WINDOW_MS = 5 * 60 * 1000;

const W = {
  intercept: -1.2005,
  mentionBot: 1.5852,
  atOther: -1.1157,
  questionMark: 0.4807,
  placeholderOnly: -1.0281,
  recentSelfRatio: 2.6525,
  recentMessageCount: -0.0367,
  logSecondsSinceBot: 0.0571,
  pendingCount: 0.1012,
};

export const REPLY_WINDOW_MS = 3600 * 1000;
export const FORCED_TURN_EXPECTED_REPLIES = 0.91;
export const MIN_WINDOW_SCORE_COUNT = 20;
export const VIRTUAL_ROUND_MS = 40 * 1000;
const MAX_COUNTED_IDS = 2000;

// 保留多少比例的主动回复 → 概率阈值（MaiBot 的离线统计表）
const STATIC_KEEP_RATIO_THRESHOLDS = [
  [0.0, 1.0], [0.1, 0.605], [0.2, 0.482], [0.3, 0.430], [0.4, 0.376], [0.5, 0.336],
  [0.6, 0.313], [0.7, 0.290], [0.8, 0.250], [0.9, 0.206], [1.0, 0.0],
];

export function staticThreshold(keepRatio) {
  for (let i = 1; i < STATIC_KEEP_RATIO_THRESHOLDS.length; i++) {
    const [lr, lt] = STATIC_KEEP_RATIO_THRESHOLDS[i - 1];
    const [hr, ht] = STATIC_KEEP_RATIO_THRESHOLDS[i];
    if (keepRatio <= hr) return lt + (ht - lt) * ((keepRatio - lr) / (hr - lr));
  }
  return 0;
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

export function estimateReplyProbability(f) {
  const logit = W.intercept
    + W.mentionBot * (f.mentionBot ? 1 : 0)
    + W.atOther * (f.atOther ? 1 : 0)
    + W.questionMark * (f.hasQuestionMark ? 1 : 0)
    + W.placeholderOnly * (f.placeholderOnly ? 1 : 0)
    + W.recentSelfRatio * clamp01(f.recentSelfRatio)
    + W.recentMessageCount * Math.max(0, Number(f.recentMessageCount) || 0)
    + W.logSecondsSinceBot * Math.log1p(Math.max(0, Number(f.secondsSinceBot ?? DEFAULT_SECONDS_SINCE_BOT)))
    + W.pendingCount * Math.min(MAX_PENDING_COUNT, Math.max(0, Number(f.pendingCount) || 0));
  return 1 / (1 + Math.exp(-logit));
}

/**
 * 从一批新消息和最近的聊天算特征。
 * batch：这批别人发的消息 [{ text, atSelf?, atOther?, mentionsSelf? }]
 * recent：会话里最近的消息（含她自己的）[{ time(ms), isSelf }]，batch 里的已经在里面也没关系（按 time 去重不需要，只数 5 分钟内）
 */
export function likelihoodFeatures(batch, recent, now) {
  const texts = batch.map((m) => String(m.text ?? '').trim()).filter(Boolean);
  const hasAtBot = batch.some((m) => m.atSelf);
  const atOther = !hasAtBot && batch.some((m) => m.atOther || /@/.test(String(m.text ?? '')));
  const hasQuestionMark = texts.some((t) => t.includes('?') || t.includes('？'));
  const placeholderOnly = texts.length > 0 && texts.every((t) => MEDIA_PLACEHOLDER_PREFIXES.some((p) => t.startsWith(p)));
  let selfCount = 0;
  let total = 0;
  let lastSelf = 0;
  for (const m of recent) {
    const t = Number(m?.time) || 0;
    if (m?.isSelf && t > lastSelf) lastSelf = t;
    if (t && now - t <= RECENT_WINDOW_MS) {
      total += 1;
      if (m.isSelf) selfCount += 1;
    }
  }
  return {
    mentionBot: batch.some((m) => m.mentionsSelf),
    atOther,
    hasQuestionMark,
    placeholderOnly,
    recentSelfRatio: selfCount / Math.max(1, total),
    recentMessageCount: total,
    secondsSinceBot: lastSelf ? Math.max(0, (now - lastSelf) / 1000) : DEFAULT_SECONDS_SINCE_BOT,
    pendingCount: batch.length,
  };
}

export class DynamicReplyGate {
  constructor() {
    this.proactive = []; // [startedAt, p]
    this.forced = []; // [at, expected]
    this.replies = []; // at
    this.counted = new Set();
    this.countedOrder = [];
    this.roundStartedAt = null;
    this.roundIds = new Set();
  }

  takeUncounted(ids) {
    const fresh = [];
    for (const id of ids) {
      const k = String(id ?? '');
      if (!k || this.counted.has(k)) continue;
      fresh.push(k);
      this.counted.add(k);
      this.countedOrder.push(k);
    }
    while (this.countedOrder.length > MAX_COUNTED_IDS) this.counted.delete(this.countedOrder.shift());
    return fresh;
  }

  isRoundOpen(now) {
    return this.roundStartedAt !== null && now - this.roundStartedAt < VIRTUAL_ROUND_MS;
  }

  recordProactiveDemand(p, now) {
    if (this.isRoundOpen(now) && this.proactive.length) {
      this.proactive[this.proactive.length - 1][1] = p;
      return;
    }
    this.roundStartedAt = now;
    this.proactive.push([now, p]);
  }

  closeRound() {
    this.roundStartedAt = null;
    this.roundIds = new Set();
  }

  recordForcedTurn(now) {
    this.closeRound();
    this.forced.push([now, FORCED_TURN_EXPECTED_REPLIES]);
  }

  recordReply(now) {
    this.replies.push(now);
  }

  prune(now) {
    const before = now - REPLY_WINDOW_MS;
    while (this.proactive.length && this.proactive[0][0] < before) this.proactive.shift();
    while (this.forced.length && this.forced[0][0] < before) this.forced.shift();
    while (this.replies.length && this.replies[0] < before) this.replies.shift();
  }

  evaluate(p, frequency, now) {
    this.prune(now);
    const scores = this.proactive.map((x) => x[1]);
    const expectedProactive = scores.reduce((a, b) => a + b, 0);
    const expectedForced = this.forced.reduce((a, x) => a + x[1], 0);
    const expectedTotal = expectedProactive + expectedForced;
    const actual = this.replies.length;
    const freq = clamp01(frequency);
    const target = freq * expectedTotal;
    let keep;
    if (freq >= 1) keep = 1;
    else if (expectedProactive <= 0) keep = freq;
    else {
      const ff = (target - expectedForced) / expectedProactive;
      const fb = Math.min(1, Math.max(0, 1 + (target - actual) / Math.max(1, target)));
      keep = Math.min(1, Math.max(0, ff * fb));
    }
    const threshold = resolveThreshold(scores, expectedProactive, keep);
    return { trigger: p >= threshold, probability: p, threshold, expected: expectedTotal, target, actual, keep };
  }

  // 一批消息：先按虚拟轮次计预计数，再判这批放不放行
  evaluateBatch(batch, recent, frequency, now) {
    const fresh = new Set(this.takeUncounted(batch.map((m) => m.id)));
    if (fresh.size) {
      if (!this.isRoundOpen(now)) this.roundIds = new Set();
      for (const id of fresh) this.roundIds.add(id);
      const roundBatch = batch.filter((m) => this.roundIds.has(String(m.id)));
      this.recordProactiveDemand(estimateReplyProbability(likelihoodFeatures(roundBatch, recent, now)), now);
    }
    const features = likelihoodFeatures(batch, recent, now);
    const d = this.evaluate(estimateReplyProbability(features), frequency, now);
    if (d.trigger) this.closeRound();
    return { ...d, features };
  }

  // 强制唤醒（@/引用/叫名字）：这批消息记一次 0.91，同一批只记一次
  recordForcedBatch(batch, now) {
    if (this.takeUncounted(batch.map((m) => m.id)).length) this.recordForcedTurn(now);
  }

  toJSON() {
    return { proactive: this.proactive, forced: this.forced, replies: this.replies };
  }

  static fromJSON(o, now = Date.now()) {
    const g = new DynamicReplyGate();
    const ok = (x) => Array.isArray(x) && Number.isFinite(Number(x[0])) && Number.isFinite(Number(x[1]));
    if (Array.isArray(o?.proactive)) g.proactive = o.proactive.filter(ok).map((x) => [Number(x[0]), Number(x[1])]);
    if (Array.isArray(o?.forced)) g.forced = o.forced.filter(ok).map((x) => [Number(x[0]), Number(x[1])]);
    if (Array.isArray(o?.replies)) g.replies = o.replies.map(Number).filter(Number.isFinite);
    g.prune(now);
    return g;
  }
}

function resolveThreshold(scores, expectedProactive, keep) {
  if (keep >= 1) return 0;
  if (keep <= 0) return 1;
  if (scores.length < MIN_WINDOW_SCORE_COUNT) return staticThreshold(keep);
  const budget = keep * expectedProactive;
  let acc = 0;
  for (const s of [...scores].sort((a, b) => b - a)) {
    acc += s;
    if (acc >= budget) return s;
  }
  return 0;
}

/**
 * 这个会话现在的 talkValue（0~1，1 = 不设门控）。
 * cfg：socialV2.replyGate；home：是不是家里的群。
 * 时段：talkSchedule [{ from:"HH:MM", to:"HH:MM", factor }]，乘在基础值上（跨午夜可以）。
 */
export function talkValueFor(key, gateCfg, { home = false, now = new Date() } = {}) {
  const tv = gateCfg?.talkValue ?? {};
  const byKey = tv.byKey ?? {};
  let v;
  if (Object.prototype.hasOwnProperty.call(byKey, key)) v = Number(byKey[key]);
  else if (String(key).startsWith('private:')) v = tv.private ?? 1;
  else v = home ? (tv.home ?? 0.8) : (tv.group ?? 0.15);
  v = clamp01(v);
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const s of Array.isArray(gateCfg?.talkSchedule) ? gateCfg.talkSchedule : []) {
    const from = clockMinutes(s?.from);
    const to = clockMinutes(s?.to);
    if (from === null || to === null) continue;
    const inside = from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
    if (inside) v = clamp01(v * Number(s.factor ?? 1));
  }
  return v;
}

function clockMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
