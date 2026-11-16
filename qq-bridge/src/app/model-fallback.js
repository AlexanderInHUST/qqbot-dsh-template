// 官方 DeepSeek 连不上时换备用（2026-11-03，主人：“ds 官网好像崩了，连接超时就自动用 aiohub 的 ds 做 fallback”）。
// DSH 的 llm-retry 只在同一个供应商里重试，不会换供应商，所以在 bridge 这边做：
// 一轮因为超时 / 连不上 / 服务端错误结束，而且用的是主模型，就把所有会话换成 socialV2.modelFallback 的备用模型
// （递增 modelSelectionEpoch，下一条消息 ensureChatModel 重新 selectModel），再让出错的那个会话接着做一次。
// 换过去以后至少 minMinutes 分钟，之后每 probeMinutes 分钟看一眼官方接口通不通（不带 key，401 也算通），通了换回来。
// 只在内存里记，bridge 重启就回到主模型。

export function createModelFallback(app) {
  const { cfg, log } = app;
  let appendActivity, deliverPrompt, getSocialV2State, socialV2;
  let active = null; // { since, reason, key }
  const retried = new Map(); // key -> 这次出错已经让她接着做过了
  const waiting = new Map(); // sessionId -> { key, since }：在等模型出字
  const turnAt = new Map(); // sessionId -> 这一轮开始的时间
  const stalled = new Set(); // key：卡住被 bridge 停掉的，这一轮结束时按连不上处理

  function fallbackCfgV2() {
    const c = cfg.socialV2?.modelFallback ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled !== false,
      provider: String(c.provider || 'aiohub'),
      model: String(c.model || 'deepseek-v4.1-flash-1017'),
      reasoningEffort: c.reasoningEffort ? String(c.reasoningEffort) : '',
      primaryProvider: String(c.primaryProvider || 'deepseek-official'), // 只有用的是它时才换
      codes: Array.isArray(c.codes) ? c.codes.map(String) : ['TIMEOUT', 'TRANSPORT', 'SERVER', 'STREAM_CLOSED'],
      // 一步发出去以后这么久一个字都没出就当连不上（0 关）
      stallMs: Math.max(0, num(c.stallSeconds, 120)) * 1000,
      minMs: Math.max(0, num(c.minMinutes, 10)) * 60000,
      probeMs: Math.max(1000, num(c.probeMinutes, 5) * 60000),
      probeUrl: String(c.probeUrl || 'https://api.deepseek.com/models'),
    };
  }

  // 换着备用时给聊天会话用哪个模型；没换返回 null（照 cfg.dsh）
  function chatRouteV2() {
    const c = fallbackCfgV2();
    if (!active || !c.enabled || String(cfg.dsh?.provider || 'deepseek-official') !== c.primaryProvider) return null;
    return { provider: c.provider, model: c.model, effort: c.reasoningEffort || String(cfg.dsh?.reasoningEffort || 'high') };
  }

  function isOutageErrorV2(error) {
    const c = fallbackCfgV2();
    if (c.codes.includes(String(error?.code ?? ''))) return true;
    return /idle timeout|transport failed|ended before message_stop|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b50[234]\b/i
      .test(String(error?.message ?? ''));
  }

  function switchV2(on, why, key = '') {
    active = on ? { since: Date.now(), reason: why, key } : null;
    app.modelSelectionEpoch += 1;
    const r = chatRouteV2() ?? { provider: cfg.dsh?.provider || 'deepseek-official', model: cfg.dsh?.model || 'deepseek-flash' };
    log(`[换备用模型] ${on ? '换成' : '换回'} ${r.provider}/${r.model}：${why}`);
    appendActivity?.(`${on ? '换成备用模型' : '换回主模型'} ${r.provider}/${r.model}：${why}`);
    app.scheduler.cancel('model-fallback-probe');
    if (on) scheduleProbeV2(fallbackCfgV2().minMs);
  }

  function scheduleProbeV2(ms) {
    app.scheduler.after('model-fallback-probe', ms, () => void probeV2());
  }

  async function probeV2() {
    if (!active) return;
    const c = fallbackCfgV2();
    let ok = false;
    let why = '';
    try {
      const res = await fetch(c.probeUrl, { signal: AbortSignal.timeout(10000) });
      ok = res.status < 500;
      why = `HTTP ${res.status}`;
    } catch (error) {
      why = String(error?.message ?? error);
    }
    if (!active) return;
    if (ok) {
      // 换模型、换回来都只记日志，不往群里说（2026-11-08 主人说的）
      switchV2(false, `官方接口通了（${why}）`);
    } else {
      log(`[换备用模型] 官方接口还不通（${why}），${Math.round(c.probeMs / 60000)} 分钟后再看`);
      scheduleProbeV2(c.probeMs);
    }
  }

  // 一轮结束时调用：是连不上导致的错误就换备用、让她接着做，返回 true（调用方跳过后面的收尾和报错）
  function fallbackTurnV2(key, reason) {
    const wasStalled = stalled.delete(key);
    const outage = (reason?.kind === 'error' && isOutageErrorV2(reason.error))
      || (wasStalled && (reason?.kind === 'aborted' || reason?.kind === 'error'));
    if (!outage) {
      retried.delete(key);
      return false;
    }
    const c = fallbackCfgV2();
    if (!c.enabled || socialV2.paused) return false;
    if (String(cfg.dsh?.provider || 'deepseek-official') !== c.primaryProvider) return false;
    const code = wasStalled ? `${Math.round(c.stallMs / 1000)} 秒没出字`
      : String(reason.error?.code || '') || String(reason.error?.message ?? '').slice(0, 60);
    if (!active) switchV2(true, `${key} 这一轮出错（${code}）`, key);
    // 备用的也出错就不再接着试，照常报错
    if (retried.has(key)) {
      retried.delete(key);
      return false;
    }
    retried.set(key, Date.now());
    const st = getSocialV2State(key);
    const prompt = `【系统】刚才网络断了一下，这一步没做完，没有执行。接着刚才的事继续做就行。（会话 ${key}，令牌 ${st.agentToken}）`;
    log(`[换备用模型] ${key} 让她接着做（${code}）`);
    deliverPrompt(key, prompt).then((result) => {
      if (result && result.ok === false) log(`[换备用模型] ${key} 接着做投递失败：${result.error ?? ''}`);
    }).catch((error) => log(`[换备用模型] ${key} 接着做投递失败: ${error?.message ?? error}`));
    return true;
  }

  // 官方排队的时候只发 SSE 心跳，DSH 的空闲超时一直被续上，一步能卡六分钟（2026-11-03 17:33~17:39 大群），
  // 最后才报 STREAM_CLOSED。所以 bridge 自己看：一步开始（或上一个字）以后 stallMs 没再出字，就停掉这一轮，
  // 结束时按连不上处理（换备用、让她接着做）。工具在跑的时候不算（tool/call 到下一个 step/start 之间不计时）。
  function noteModelEventV2(sessionId, key, type) {
    if (type === 'turn/start') turnAt.set(sessionId, Date.now());
    if (type === 'step/start' || type === 'assistant/chunk') waiting.set(sessionId, { key, since: Date.now() });
    else if (type === 'assistant/message' || type === 'tool/call' || type === 'turn/end') waiting.delete(sessionId);
    if (type === 'turn/end') turnAt.delete(sessionId);
  }

  function checkStallsV2() {
    const c = fallbackCfgV2();
    if (!c.stallMs || !c.enabled || socialV2.paused) return;
    if (String(cfg.dsh?.provider || 'deepseek-official') !== c.primaryProvider) return;
    const now = Date.now();
    for (const [sessionId, w] of waiting) {
      if (now - w.since < c.stallMs) continue;
      // 已经换着备用了：只管换之前开始的那一轮（还在用主模型）
      if (active && (turnAt.get(sessionId) ?? 0) >= active.since) continue;
      waiting.delete(sessionId);
      stalled.add(w.key);
      log(`[换备用模型] ${w.key} 这一步 ${Math.round((now - w.since) / 1000)} 秒没出字，停掉这一轮`);
      void app.withTimeout(app.api.stopSessionWork(sessionId), app.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork')
        .catch((error) => { stalled.delete(w.key); log(`[换备用模型] ${w.key} 停不掉这一轮：${error?.message ?? error}`); });
    }
  }

  return {
    exports: {
      chatRouteV2, fallbackCfgV2, fallbackTurnV2, isOutageErrorV2, noteModelEventV2, checkStallsV2,
      modelFallbackActiveV2: () => (active ? { ...active } : null),
    },
    link() {
      ({ appendActivity, deliverPrompt, getSocialV2State, socialV2 } = app);
    },
    start() {
      app.scheduler.every('model-fallback-stall', 15000, checkStallsV2);
    },
  };
}
