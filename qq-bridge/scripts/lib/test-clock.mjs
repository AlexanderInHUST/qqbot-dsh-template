// 测试用的钟：拨到某个时刻、往前拨，bridge 里的 Date 和定时（src/scheduler.js）都跟着走。
// 用法：在 import 别的东西以后、建 bridgeHarness 之前 pinClock('14:00')（今天的那个钟点）或 pinClock(时间戳)；
// 之后 advanceClock(ms) 往前拨，再 h.scheduler.tick() 让到点的事跑起来。
// 只挪 Date.now / new Date()，setTimeout 还是真的毫秒（测试里那些几十毫秒的等待不受影响）。
// 作息相关的测试钉在白天，不会在 0 点前后跑出跨天的误报。

const RealDate = globalThis.Date
const realNow = RealDate.now.bind(RealDate)
let offset = 0

export const clockNow = () => realNow() + offset

// 'HH:MM' 是今天（真实日期）的那个钟点；数字或 Date 是绝对时刻
export function setClock(target) {
  let ms
  if (typeof target === 'string' && /^\d{1,2}:\d{2}$/.test(target)) {
    const [h, m] = target.split(':').map(Number)
    const d = new RealDate(realNow())
    d.setHours(h, m, 0, 0)
    ms = d.getTime()
  } else {
    ms = Number(target instanceof RealDate ? target.getTime() : target)
  }
  if (!Number.isFinite(ms)) throw new Error(`setClock 的时间不对：${target}`)
  offset = ms - realNow()
  return ms
}

export function advanceClock(ms) {
  offset += Number(ms) || 0
  return clockNow()
}

export function resetClock() {
  offset = 0
}

// 给一个 realm（本进程的 globalThis，或 vm 的 context）换上跟着钟走的 Date
export function makeClockDate(BaseDate, now = clockNow) {
  class ClockDate extends BaseDate {
    constructor(...args) {
      if (args.length === 0) super(now())
      else super(...args)
    }
    static now() { return now() }
  }
  return ClockDate
}

let installed = false
// 钉住本进程的 Date（测试文件自己算的钟点）；bridgeHarness 看到钉住了就给 vm 也换上
export function pinClock(target) {
  if (!installed) {
    globalThis.Date = makeClockDate(RealDate)
    installed = true
  }
  return setClock(target)
}

export const clockPinned = () => installed
