// 看门狗（2026-11-08）：看着每个窗口这一轮跑得正不正常。
// 11-05 ~ 11-07 自由时间卡在一个没回结果的 bili_watch 上两天半，之后的唤醒全排在 DSH 队列里，
// bridge 日志照样写“唤醒 play:main”，看着一切正常，没人知道。现在：
//   一个工具调用 toolWarnMinutes 没结果记日志，toolStopMinutes 还没结果就取消这一轮（session/cancel，
//   不清 DSH 队列，排着的消息取消后照常给她），并在主人通知的地方说一声；
//   一轮里没有工具在跑、quietWarnMinutes 一个事件都没有记日志，quietStopMinutes 取消；
//   一轮跑了 longTurnMinutes 还没完只说一声，不停。
// 配置 socialV2.watchdog，都有代码默认；日志 grep '\[看门狗\]'，控制台 GET /api/watchdog。

export function createWatchdog(app) {
  const { cfg, log } = app;
  let notifyOwnerOnly;
  const turns = new Map(); // sessionId -> { key, startAt, lastEventAt, open: Map(callId -> {tool, at, warned}), warned:Set, cancelledAt }
  const recent = []; // 最近做过的事，控制台看

  function watchdogCfgV2() {
    const c = cfg.socialV2?.watchdog ?? {};
    const min = (v, d) => Math.max(0, v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d) * 60000;
    return {
      enabled: c.enabled !== false,
      notify: c.notify !== false,
      toolWarnMs: min(c.toolWarnMinutes, 30),
      toolStopMs: min(c.toolStopMinutes, 60), // 0 = 不停
      quietWarnMs: min(c.quietWarnMinutes, 15),
      quietStopMs: min(c.quietStopMinutes, 30),
      longTurnMs: min(c.longTurnMinutes, 180),
    };
  }

  function noteV2(entry) {
    recent.push({ at: Date.now(), ...entry });
    if (recent.length > 100) recent.splice(0, recent.length - 100);
  }

  // bridge.js 的事件循环里每个当前会话的事件都调一次
  function noteTurnEventV2(sessionId, key, event) {
    const type = event?.type;
    const now = Date.now();
    if (type === 'turn/start') {
      turns.set(sessionId, { key, startAt: now, lastEventAt: now, open: new Map(), warned: new Set(), cancelledAt: 0 });
      return;
    }
    let t = turns.get(sessionId);
    if (!t) {
      // bridge 重启时正在跑的那一轮没看到 turn/start，从这里开始算
      // （只认一轮里才有的事件；session/title 这类一轮结束后也会来的不算）
      if (!['tool/call', 'step/start', 'assistant/chunk'].includes(type)) return;
      t = { key, startAt: now, lastEventAt: now, open: new Map(), warned: new Set(), cancelledAt: 0 };
      turns.set(sessionId, t);
    }
    t.lastEventAt = now;
    if (type === 'tool/call') {
      const callId = event.data?.callId;
      if (callId != null) t.open.set(String(callId), { tool: String(event.data?.name ?? ''), at: now, warned: false });
    } else if (type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      if (callId != null) t.open.delete(String(callId));
    } else if (type === 'turn/end') {
      turns.delete(sessionId);
    }
  }

  function forgetSessionV2(sessionId) { turns.delete(sessionId); }

  function minutes(ms) { return Math.round(ms / 60000); }

  async function cancelTurnV2(sessionId, t, why) {
    t.cancelledAt = Date.now();
    log(`[看门狗] ${t.key} 这一轮${why}，取消这一轮`);
    noteV2({ key: t.key, action: 'cancel', why });
    try {
      const res = await app.withTimeout(app.api.callUnary('session/cancel', { sessionId }), app.DSH_CONTROL_TIMEOUT_MS, 'session/cancel');
      if (res?.result && !res.result.ok && res.result.error?.code !== 'session/not-found') {
        throw new Error(res.result.error?.message || res.result.error?.code || 'session/cancel 失败');
      }
    } catch (error) {
      log(`[看门狗] ${t.key} 取消不掉：${error?.message ?? error}`);
      noteV2({ key: t.key, action: 'cancel-failed', why: String(error?.message ?? error).slice(0, 200) });
      if (watchdogCfgV2().notify) await notifyOwnerOnly?.(t.key, `⚠️ 看门狗：这一轮${why}，取消不掉，可能要重建 dsh`);
      return;
    }
    if (watchdogCfgV2().notify) await notifyOwnerOnly?.(t.key, `⚠️ 看门狗：这一轮${why}，已经取消，排着的消息会接着给她`);
  }

  async function checkTurnsV2() {
    const c = watchdogCfgV2();
    if (!c.enabled || app.currentMode !== 'reserved2') return;
    const now = Date.now();
    for (const [sessionId, t] of turns) {
      // 会话已经换掉（重置、退役）就不管了
      if (app.state.sessions?.[t.key] !== sessionId) { turns.delete(sessionId); continue; }
      // 取消过的等它自己结束；10 分钟还没结束再试一次
      if (t.cancelledAt && now - t.cancelledAt < 10 * 60000) continue;
      let oldest = null;
      for (const [callId, call] of t.open) if (!oldest || call.at < oldest.at) oldest = { callId, ...call };
      if (oldest) {
        const age = now - oldest.at;
        if (c.toolStopMs && age >= c.toolStopMs) {
          await cancelTurnV2(sessionId, t, `里 ${oldest.tool} 调了 ${minutes(age)} 分钟还没结果`);
          continue;
        }
        const call = t.open.get(oldest.callId);
        if (c.toolWarnMs && age >= c.toolWarnMs && call && !call.warned) {
          call.warned = true;
          log(`[看门狗] ${t.key} 的 ${oldest.tool} 调了 ${minutes(age)} 分钟还没结果`);
          noteV2({ key: t.key, action: 'tool-slow', tool: oldest.tool, minutes: minutes(age) });
        }
      } else {
        const quiet = now - t.lastEventAt;
        if (c.quietStopMs && quiet >= c.quietStopMs) {
          await cancelTurnV2(sessionId, t, ` ${minutes(quiet)} 分钟没有动静`);
          continue;
        }
        if (c.quietWarnMs && quiet >= c.quietWarnMs && !t.warned.has(`quiet:${t.lastEventAt}`)) {
          t.warned.add(`quiet:${t.lastEventAt}`);
          log(`[看门狗] ${t.key} 这一轮 ${minutes(quiet)} 分钟没有动静`);
          noteV2({ key: t.key, action: 'quiet', minutes: minutes(quiet) });
        }
      }
      const long = now - t.startAt;
      if (c.longTurnMs && long >= c.longTurnMs && !t.warned.has('long')) {
        t.warned.add('long');
        log(`[看门狗] ${t.key} 这一轮跑了 ${minutes(long)} 分钟还没完`);
        noteV2({ key: t.key, action: 'long', minutes: minutes(long) });
        if (c.notify) await notifyOwnerOnly?.(t.key, `⚠️ 看门狗：这一轮跑了 ${minutes(long)} 分钟还没完`);
      }
    }
  }

  function watchdogSnapshotV2() {
    const now = Date.now();
    return {
      config: watchdogCfgV2(),
      turns: [...turns.entries()].map(([sessionId, t]) => ({
        key: t.key, sessionId,
        runningMinutes: minutes(now - t.startAt),
        quietSeconds: Math.round((now - t.lastEventAt) / 1000),
        openTools: [...t.open.values()].map((c) => ({ tool: c.tool, seconds: Math.round((now - c.at) / 1000) })),
        cancelledAt: t.cancelledAt || null,
      })),
      recent: recent.slice(-50),
    };
  }

  return {
    exports: { checkTurnsV2, forgetWatchdogSessionV2: forgetSessionV2, noteTurnEventV2, watchdogCfgV2, watchdogSnapshotV2 },
    link() {
      ({ notifyOwnerOnly } = app);
    },
    start() {
      app.scheduler.every('watchdog', 60 * 1000, checkTurnsV2);
    },
  };
}
