// qqbot_agent：按作息表决定“主动机会”的概率和检查间隔。
//
// cfg.socialV2.proactive.schedule 是一个时间段数组，按顺序取第一个命中的：
//   [{ from: '19:00', to: '22:30', probability: 0.8, checkIntervalMinMs?: 3600000, checkIntervalMaxMs?: 7200000 }, ...]
// 时间是容器本地时间（TZ），from > to 表示跨零点。表里没覆盖到的时间段概率为 0（等于在睡觉）。
// 没配 schedule 时返回 null，调用方沿用原来的 probability 和夜间 ×0.3。

function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 24 && min < 60 ? h * 60 + min : NaN;
}

// 夜里固定睡觉（cfg.socialV2.nightSleep = { enabled, from: '22:30', to: '07:30' }）：现在是否在睡觉时间里
export function inNightSleep(nightCfg, date = new Date()) {
  if (!nightCfg || nightCfg.enabled === false) return false;
  const from = toMinutes(nightCfg.from);
  const to = toMinutes(nightCfg.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function proactiveSlot(proactiveCfg, date = new Date()) {
  const slots = proactiveCfg?.schedule;
  if (!Array.isArray(slots)) return null;
  const now = date.getHours() * 60 + date.getMinutes();
  for (const slot of slots) {
    const from = toMinutes(slot?.from);
    const to = toMinutes(slot?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    const inside = from < to ? now >= from && now < to : now >= from || now < to;
    if (inside) {
      const p = Number(slot.probability);
      return { ...slot, probability: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0 };
    }
  }
  return { probability: 0 };
}

// 某个钟点（'08:00'）在 after 之后第一次出现的时间戳（毫秒）。用于“提前睡了，睡到第二天起床时间”。
export function nextClockTime(hhmm, after = Date.now()) {
  const m = toMinutes(hhmm);
  if (!Number.isFinite(m)) return NaN;
  const d = new Date(after);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  if (d.getTime() <= after) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// 离下一次 hh:mm 还有几分钟（0 表示正是这一分钟）
export function minutesUntilClock(hhmm, date = new Date()) {
  const m = toMinutes(hhmm);
  if (!Number.isFinite(m)) return NaN;
  const now = date.getHours() * 60 + date.getMinutes();
  return (m - now + 1440) % 1440;
}

// qqbot_agent：每晚睡觉、起床的时间有点浮动（nightSleep.vary）。from / to 是平常的时间，每晚在这上下随机挪一点，
// 周五周六晚上睡得晚、起得晚，熬夜了第二天起得晚，有的早上醒了先赖会儿床。
// 随机数按日期算（同一晚算几次都一样，重启也不变）；熬夜多晚（late）是调用方按她实际几点睡的给的。
export const SLEEP_VARY_DEFAULTS = {
  enabled: false,
  bedMinutes: [-40, 40], // 睡觉时间在 from 上下挪多少分钟
  wakeMinutes: [-20, 30], // 起床时间在 to 上下挪多少分钟
  weekendNights: [5, 6], // 星期几的晚上算周末（5 = 周五晚上）
  weekendBedLater: 30, // 周末晚上再晚睡多少分钟
  weekendWakeLater: 40, // 周末早上再晚起多少分钟
  lazyProbability: 0.4, // 醒了先赖床的概率
  lazyMinutes: [5, 30], // 赖多久
  lateGraceMinutes: 20, // 比打算的晚睡这么多以内不算熬夜
  lateWakeFactor: 0.5, // 熬夜的分钟数 × 这个 = 第二天多睡多久
  lateWakeMaxMinutes: 60,
};
const VARY_MIN_SLEEP_MS = 4 * 3600000;

function rangeOf(value, fallback) {
  const r = Array.isArray(value) && value.length === 2 ? value.map(Number) : null;
  return r && r.every(Number.isFinite) ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : fallback;
}
function numOf(value, fallback, min = 0) {
  const x = Number(value);
  return Number.isFinite(x) && x >= min ? x : fallback;
}
export function sleepVaryCfg(nightCfg) {
  const v = nightCfg?.vary ?? {};
  const d = SLEEP_VARY_DEFAULTS;
  return {
    enabled: v.enabled === true,
    bedMinutes: rangeOf(v.bedMinutes, d.bedMinutes),
    wakeMinutes: rangeOf(v.wakeMinutes, d.wakeMinutes),
    weekendNights: Array.isArray(v.weekendNights) ? v.weekendNights.map(Number).filter((x) => x >= 0 && x <= 6) : d.weekendNights,
    weekendBedLater: numOf(v.weekendBedLater, d.weekendBedLater),
    weekendWakeLater: numOf(v.weekendWakeLater, d.weekendWakeLater),
    lazyProbability: Math.min(1, numOf(v.lazyProbability, d.lazyProbability)),
    lazyMinutes: rangeOf(v.lazyMinutes, d.lazyMinutes).map((x) => Math.max(0, x)),
    lateGraceMinutes: numOf(v.lateGraceMinutes, d.lateGraceMinutes),
    lateWakeFactor: numOf(v.lateWakeFactor, d.lateWakeFactor),
    lateWakeMaxMinutes: numOf(v.lateWakeMaxMinutes, d.lateWakeMaxMinutes),
  };
}

// 本地日期 'YYYY-MM-DD'，以及往前往后挪几天
export function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function shiftDay(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n, 12).getTime());
}
function atClock(day, minutes) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
}
// 按字符串算的 [0,1) 伪随机（FNV-1a + 一次搅拌）
function seeded(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
// 两个均匀数取平均：落在中间的多，两头的少
function between(day, what, [lo, hi]) {
  return lo + (hi - lo) * (seeded(`${day}|${what}|a`) + seeded(`${day}|${what}|b`)) / 2;
}

// day 那天晚上的睡觉安排（day 是晚上那天的日期；睡觉时间在中午前的算第二天凌晨）。
// late：她这晚实际比 bedAt 晚睡了多少毫秒（陪主人聊、说了去睡又被叫醒），用来算第二天多睡多久。
// 返回 null 表示没开 vary 或时间配得不对，调用方按原来固定的时间算。
export function nightPlan(nightCfg, day, { late = 0 } = {}) {
  if (!nightCfg || nightCfg.enabled === false) return null;
  const v = sleepVaryCfg(nightCfg);
  const from = toMinutes(nightCfg.from);
  const to = toMinutes(nightCfg.to);
  if (!v.enabled || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  const baseBedAt = atClock(from >= 12 * 60 ? day : shiftDay(day, 1), from);
  const baseWakeAt = nextClockTime(nightCfg.to, baseBedAt);
  const weekday = new Date(atClock(day, 12 * 60)).getDay();
  const weekend = v.weekendNights.includes(weekday);
  let bedOffset = Math.round(between(day, 'bed', v.bedMinutes)) + (weekend ? v.weekendBedLater : 0);
  let wakeOffset = Math.round(between(day, 'wake', v.wakeMinutes)) + (weekend ? v.weekendWakeLater : 0);
  // 挪完至少还要睡 4 个钟头，不够就不挪
  if (baseWakeAt + wakeOffset * 60000 - (baseBedAt + bedOffset * 60000) < VARY_MIN_SLEEP_MS) { bedOffset = 0; wakeOffset = 0; }
  const bedAt = baseBedAt + bedOffset * 60000;
  const lateMin = Math.max(0, Number(late) / 60000 - v.lateGraceMinutes);
  const sleepInMin = Math.round(Math.min(v.lateWakeMaxMinutes, lateMin * v.lateWakeFactor));
  const wakeAt = baseWakeAt + (wakeOffset + sleepInMin) * 60000;
  const lazyMin = seeded(`${day}|lazy`) < v.lazyProbability ? Math.round(between(day, 'lazyMin', v.lazyMinutes)) : 0;
  return { day, bedAt, wakeAt, lazyUntil: wakeAt + lazyMin * 60000, lazyMin, bedOffset, wakeOffset, sleepInMin, weekend, baseBedAt, baseWakeAt };
}
