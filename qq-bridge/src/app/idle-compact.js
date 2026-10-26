// 闲时自动压缩会话
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。

export function createIdleCompact(app) {
  const {
    api, cfg, compactingKeys, idleCompactTimers, log, sessionContextTokens
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let getSocialV2State, isConversationBusyV2, replayPendingWakeReasonsV2;

  // ── 闲时自动压缩 ────────────────────────────────────────────────────────
  // DSH 默认要到上下文窗口的 80% 才压缩（1M 窗口就是 80 万 token），一直拖着大上下文
  // 每次唤醒都慢。这里在她收尾、安静 idleMs 之后，上下文超过 minContextTokens 就发一次 /compact。
  // qqbot_agent：byKey 可以给某个会话单独定 minContextTokens / idleMs / minIntervalMinutes；
  // minIntervalMinutes（默认 60）：同一会话两次闲时压缩至少隔这么久。10-23 技术群一直有人聊，
  // 每轮都涨过 10 万，一天压了 5 回（11:14、12:04、12:26、13:50、14:25），每压一次她都要重新认一遍群。
  function idleCompactCfgV2(key) {
    const base = cfg.socialV2?.idleCompact ?? {};
    const c = { ...base, ...(key && base.byKey?.[key] ? base.byKey[key] : {}) };
    return {
      enabled: c.enabled !== false,
      idleMs: Math.max(10000, Number(c.idleMs) || 120000),
      minContextTokens: Math.max(1000, Number(c.minContextTokens) || 100000),
      maxRunMs: Math.max(60000, Number(c.maxRunMs) || 600000),
      minIntervalMs: Math.max(0, Number(c.minIntervalMinutes ?? 60) || 0) * 60000
    };
  }
  const idleCompactLastAt = new Map(); // key -> 上次闲时压缩完成的时间

  function cancelIdleCompactV2(key) {
    const t = idleCompactTimers.get(key);
    if (t) clearTimeout(t);
    idleCompactTimers.delete(key);
  }

  function scheduleIdleCompactV2(key) {
    const ic = idleCompactCfgV2(key);
    cancelIdleCompactV2(key);
    if (!ic.enabled || !key) return;
    const sid = app.state.sessions[key];
    const tokens = sid ? sessionContextTokens.get(sid) : 0;
    if (!tokens || tokens < ic.minContextTokens) return;
    // 离上次压缩还不够 minIntervalMs：推到那时候（期间她又聊起来会重新排）
    const last = idleCompactLastAt.get(key) || 0;
    const wait = Math.max(ic.idleMs, last ? last + ic.minIntervalMs - Date.now() : 0);
    if (wait > ic.idleMs) log(`[reserved2] ${key} 闲时压缩：${Math.round((Date.now() - last) / 60000)} 分钟前刚压过，推到 ${Math.round(wait / 60000)} 分钟后`);
    const timer = setTimeout(() => {
      idleCompactTimers.delete(key);
      void runIdleCompactV2(key).catch((error) => log(`[reserved2] ${key} 闲时压缩异常：${error?.message ?? error}`));
    }, wait);
    timer.unref?.();
    idleCompactTimers.set(key, timer);
  }

  async function runIdleCompactV2(key) {
    const ic = idleCompactCfgV2(key);
    const sid = app.state.sessions[key];
    if (!ic.enabled || !sid || app.currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    const tokens = sessionContextTokens.get(sid) ?? 0;
    if (tokens < ic.minContextTokens) return;
    const last = idleCompactLastAt.get(key) || 0;
    if (last && Date.now() - last < ic.minIntervalMs) return;
    // 她又在忙了：等这一轮结束时会重新排一次
    if (isConversationBusyV2(key, st)) return;
    compactingKeys.add(key);
    // 兜底：RPC 卡住也别让会话一直判忙
    const guard = setTimeout(() => {
      if (compactingKeys.delete(key)) log(`[reserved2] ${key} 闲时压缩超过 ${Math.round(ic.maxRunMs / 1000)}s，解除忙碌`);
    }, ic.maxRunMs);
    guard.unref?.();
    const started = Date.now();
    log(`[reserved2] ${key} 闲时压缩开始（上下文约 ${Math.round(tokens / 1000)}k token）`);
    try {
      // 斜杠命令要走 commands/execute；用 session/prompt 发 "/compact" 只会变成一条普通用户消息。
      // 默认的 30 秒 RPC 超时不够：10-22 21:08 一次 19.9 万 token 的压缩就是 30 秒被掐断的。按 maxRunMs 等。
      const r = await api.callUnary('commands/execute', { agentId: sid, line: '/compact', submittedAttachments: [] },
        AbortSignal.timeout(ic.maxRunMs), 'none');
      const secs = Math.round((Date.now() - started) / 1000);
      if (!r.result?.ok) {
        log(`[reserved2] ${key} 闲时压缩被拒绝（${secs}s）：${r.result?.error?.code}: ${r.result?.error?.message}`);
      } else {
        const outcome = r.result.value?.result;
        log(`[reserved2] ${key} 闲时压缩${outcome?.kind === 'success' ? '完成' : '失败'}（${secs}s）：${outcome?.text ?? '未知命令'}`);
        // 压缩后的真实大小要等下一次模型请求才知道；先清掉，避免对同一份旧数字重复压缩
        sessionContextTokens.delete(sid);
        if (outcome?.kind === 'success') idleCompactLastAt.set(key, Date.now());
      }
    } finally {
      clearTimeout(guard);
      compactingKeys.delete(key);
      replayPendingWakeReasonsV2(key);
    }
  }

  return {
    exports: {
      cancelIdleCompactV2,
      idleCompactCfgV2,
      idleCompactLastAt,
      runIdleCompactV2,
      scheduleIdleCompactV2,
    },
    link() {
      ({
        getSocialV2State, isConversationBusyV2, replayPendingWakeReasonsV2
      } = app);
    },
    start() {},
  };
}
