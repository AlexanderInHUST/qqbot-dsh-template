// 二代仿真模式：等待/结束回合相关的轻量判断工具。
// 这些是“提示/软信号”，不是硬规则；最终是否等待、是否发催话仍由 AI 自主决定。

// 常见“话说一半/没说完”的结尾特征。
const UNFINISHED_TAIL_RE = /(?:你知道|等一下|我跟你讲|我跟你说|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;

// 以中文逗号/顿号/分号/冒号等“非终止标点”结尾，也常表示还没说完。
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;

// 明确以终止标点/省略号结尾的消息视为说完。
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

export function looksLikeUnfinished(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (FINISHED_TAIL_RE.test(s)) return false;
  if (UNFINISHED_TAIL_RE.test(s)) return true;
  if (UNFINISHED_PUNCT_RE.test(s)) return true;
  return false;
}

// AI 等不到下文时可以用的“催话”短句。
export const UNFINISHED_PROMPT_REPLIES = ['什么', '啥', '你说啊', '然后呢', '？'];

// 建议的“结束前再等一轮”的等待时长范围（毫秒）。
export const END_ROUND_WAIT_MIN_MS = 5 * 60 * 1000;
export const END_ROUND_WAIT_MAX_MS = 10 * 60 * 1000;

// ── qqbot_agent：回话的时机（socialV2.replyTiming，2026-10-26） ──────────────
// 以前合并唤醒、等待、门控一律“安静 3 秒”，被 @ 了只等 2 秒；可很多人一句话分三四条发，
// 条与条之间 3~8 秒（大群一半以上的连发间隔超过 5 秒），她就在人家第二条还没打完时插进来。
// 现在按这个人自己的连发节奏等（他连发间隔的中位数，夹在 3~8 秒），再按这条的内容加减：
// 话说一半、几个字的碎片、只 @ 了一下、只发了张图 → 多等；问她的话说完了（问号、吗）→ 2 秒；
// 家里以外的群正热闹 → 多等一点。

export const REPLY_TIMING_DEFAULTS = Object.freeze({
  enabled: false,
  baseMs: 3000,          // 没有节奏数据时的安静时间
  minMs: 1500,
  maxMs: 12000,
  rhythmFactor: 1,       // 连发间隔中位数 × 这个（离线回放三天：1.3 和 1.0 抢话一样少，1.0 少等半秒）
  rhythmMinSamples: 3,   // 少于这么多个间隔就用 baseMs
  rhythmMinMs: 3000,
  rhythmMaxMs: 8000,
  rhythmGapMaxMs: 30000, // 同一人两条隔得比这久不算连发
  fragmentChars: 4,      // 这么短、没有结尾标点的算碎片
  fragmentExtraMs: 3000,
  unfinishedExtraMs: 5000, // 以“然后”“但是”、逗号结尾，或只 @ 了一下
  photoExtraMs: 4000,    // 只发了张图（不是表情包），多半还有下文
  questionMs: 2000,      // 问她的话、已经问完了
  hotExtraMs: 1000,      // 家里以外的群正热闹（60 秒里 ≥6 条、≥3 人）
  maxDelayMs: 15000,     // 合并唤醒最多拖这么久（从第一条算）
  holdBeforeSend: true,  // 发前看一眼
  maxHoldsPerTurn: 2,
  holdQuietMaxMs: 8000,  // 拦下来时等对方说完最多等这么久
});

export function replyTimingCfg(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = { ...REPLY_TIMING_DEFAULTS, enabled: c.enabled === true }; // 配置里写了 enabled:true 才开
  for (const k of Object.keys(REPLY_TIMING_DEFAULTS)) {
    if (k === 'enabled') continue;
    if (k === 'holdBeforeSend') { if (c[k] !== undefined) out[k] = c[k] !== false; continue; }
    const v = Number(c[k]);
    if (c[k] !== undefined && c[k] !== null && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  out.maxMs = Math.max(out.minMs, out.maxMs);
  out.rhythmMaxMs = Math.max(out.rhythmMinMs, out.rhythmMaxMs);
  return out;
}

/** 这个人连发的节奏：recent 里同一人相邻两条的间隔（中间没别人插话），返回中位数 × rhythmFactor（夹在 rhythmMin~MaxMs），样本不够返回 0。 */
export function typingRhythmMs(recent, userId, cfg = REPLY_TIMING_DEFAULTS) {
  if (!userId || !Array.isArray(recent)) return 0;
  const id = String(userId);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1];
    const b = recent[i];
    if (!a || !b || a.isSelf || b.isSelf || String(a.userId ?? '') !== id || String(b.userId ?? '') !== id) continue;
    const gap = Number(b.time) - Number(a.time);
    if (gap >= 300 && gap <= cfg.rhythmGapMaxMs) gaps.push(gap);
  }
  const recentGaps = gaps.slice(-20);
  if (recentGaps.length < Math.max(1, cfg.rhythmMinSamples)) return 0;
  const sorted = [...recentGaps].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(Math.min(cfg.rhythmMaxMs, Math.max(cfg.rhythmMinMs, median * cfg.rhythmFactor)));
}

const MEDIA_TAG_RE = /\[(?:图片|闪照|表情包(?::[^\]]*)?|表情\d*|语音|视频|动画表情)\]/g;
const QUESTION_END_RE = /(?:[?？]+|[吗嘛么呢][?？~～]*|(?:干嘛|干啥|什么|啥|怎么样?|咋样?|几点|多少|哪[里儿个]?|谁|为啥|为什么)[了啊呀呢]?)$/;
// 几个字就说完的回话，不算碎片
const SHORT_COMPLETE_RE = /^(?:好+的?|嗯+|哦+|噢+|行|对+|是+|ok|okk|好吧|可以|没事|晚安|早+|草+|笑死|哈+|h+|6+|？+|\?+|！+|收到|谢谢|谢了|牛+|绝了|确实|真的|666+)$/i;

/** 这条消息的形状：bareAt 只 @ 了人、photoOnly 只有照片截图、fragment 几个字没说完、unfinished 话说一半、question 问句说完了 */
export function messageShape(msg, cfg = REPLY_TIMING_DEFAULTS) {
  const plain = String(msg?.plain ?? msg?.text ?? '').trim();
  const media = Array.isArray(msg?.media) ? msg.media : [];
  const withoutAt = plain.replace(/@\S+/g, '').trim();
  const words = withoutAt.replace(MEDIA_TAG_RE, '').replace(/\[引用[^\]]*\]/g, '').trim();
  const hasPhoto = media.some((m) => m && m.kind === 'image');
  const bareAt = /@\S/.test(plain) && !words && !media.length;
  const photoOnly = !words && hasPhoto && !/\[表情包/.test(plain);
  const chars = [...words].length;
  const finished = FINISHED_TAIL_RE.test(words);
  const question = !!words && QUESTION_END_RE.test(words);
  const unfinished = !!words && looksLikeUnfinished(words);
  const fragment = !!words && !finished && !unfinished && !question && chars <= cfg.fragmentChars && !SHORT_COMPLETE_RE.test(words);
  return { bareAt, photoOnly, fragment, unfinished, question, finished, chars };
}

/**
 * 她该等对方安静多久再开口。
 *   msg     最新一条别人的话；toHer 是不是在跟她说（私聊总是）
 *   rhythmMs  这个人的节奏（typingRhythmMs），0 = 没数据
 *   hot     家里以外的群正热闹
 * 返回 { ms, why }，why 是日志用的几个字。
 */
export function adaptiveQuietMs({ msg, toHer = false, rhythmMs = 0, hot = false }, cfg = REPLY_TIMING_DEFAULTS) {
  const why = [];
  let ms = rhythmMs > 0 ? rhythmMs : cfg.baseMs;
  why.push(rhythmMs > 0 ? `节奏${Math.round(rhythmMs / 100) / 10}s` : '默认');
  const s = messageShape(msg, cfg);
  if (s.unfinished || s.bareAt) { ms += cfg.unfinishedExtraMs; why.push(s.bareAt ? '只@了一下' : '话说一半'); }
  else if (s.photoOnly) { ms += cfg.photoExtraMs; why.push('只发了图'); }
  else if (s.fragment) { ms += cfg.fragmentExtraMs; why.push('碎片'); }
  else if (toHer && s.question) { ms = Math.min(ms, cfg.questionMs); why.push('问她'); }
  else if (s.finished) { ms = Math.min(ms, Math.max(cfg.baseMs, cfg.questionMs)); why.push('说完了'); }
  if (hot && !(toHer && s.question)) { ms += cfg.hotExtraMs; why.push('群里热闹'); }
  return { ms: Math.round(Math.min(cfg.maxMs, Math.max(cfg.minMs, ms))), why: why.join('、') };
}
