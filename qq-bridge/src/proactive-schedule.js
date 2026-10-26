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
