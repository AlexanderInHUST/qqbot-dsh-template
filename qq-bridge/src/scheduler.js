// 桥接里所有“每隔一会儿做一次”的事都登记在这里（2026-10-24 以前是散在各处的 10 个 setInterval）。
// 一个 1 秒的心跳挨个看谁到点了；同一件事上一次还没做完（async 没返回）就跳过这一拍，不会叠起来；
// 出错按名字记日志，同样的错 10 分钟只记一次。控制台 GET /api/scheduler 能看每件事最近一次跑了多久、错在哪。

const HEARTBEAT_MS = 1000;
const SAME_ERROR_QUIET_MS = 10 * 60 * 1000;

export function createScheduler({ log = () => {}, now = Date.now, heartbeatMs = HEARTBEAT_MS } = {}) {
  const jobs = new Map();
  let timer = null;

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(tick, heartbeatMs);
    timer.unref?.();
  }

  function noteError(job, error) {
    const message = String(error?.message ?? error);
    job.errors += 1;
    const t = now();
    if (job.lastError !== message || t - job.lastErrorLoggedAt >= SAME_ERROR_QUIET_MS) {
      log(`[定时] ${job.name} 出错：${message}`);
      job.lastErrorLoggedAt = t;
    }
    job.lastError = message;
    job.lastErrorAt = t;
  }

  function run(job) {
    const t = now();
    job.nextAt = t + job.everyMs;
    if (job.running) { job.skipped += 1; return; }
    job.running = true;
    job.lastRunAt = t;
    job.runs += 1;
    const done = () => { job.running = false; job.lastMs = now() - t; };
    let result;
    try {
      result = job.fn();
    } catch (error) {
      done();
      noteError(job, error);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(done, (error) => { done(); noteError(job, error); });
    } else {
      done();
    }
  }

  function tick() {
    const t = now();
    for (const job of jobs.values()) if (t >= job.nextAt) run(job);
  }

  return {
    // 同名再登记就替换掉旧的（比如切换模式时重开社交循环）。firstDelayMs 0 = 登记时马上跑一次。
    every(name, everyMs, fn, { firstDelayMs = everyMs } = {}) {
      if (!(everyMs > 0)) throw new Error(`定时任务 ${name} 的间隔不对：${everyMs}`);
      const job = {
        name, everyMs, fn, nextAt: now() + Math.max(0, firstDelayMs), running: false,
        runs: 0, skipped: 0, errors: 0, lastRunAt: 0, lastMs: 0, lastError: '', lastErrorAt: 0, lastErrorLoggedAt: 0,
      };
      jobs.set(name, job);
      ensureTimer();
      if (firstDelayMs <= 0) run(job);
      return job;
    },
    has(name) { return jobs.has(name); },
    cancel(name) { return jobs.delete(name); },
    // 测试用：不等心跳，直接看一遍
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      const t = now();
      return [...jobs.values()].map((job) => ({
        name: job.name,
        everyMs: job.everyMs,
        running: job.running,
        runs: job.runs,
        skipped: job.skipped,
        errors: job.errors,
        lastRunAgoMs: job.lastRunAt ? t - job.lastRunAt : null,
        lastMs: job.lastMs,
        nextInMs: Math.max(0, job.nextAt - t),
        lastError: job.lastError || null,
        lastErrorAgoMs: job.lastErrorAt ? t - job.lastErrorAt : null,
      }));
    },
  };
}
