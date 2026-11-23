// 叫醒她：投递唤醒、忙不忙、定时器（潜水到期、自由时间检查）、格式坏了自动重试
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { proactiveSlot } from '../proactive-schedule.js';

export function createWake(app) {
  const {
    PLAY_KEY, TURN_BUSY_LEASE_MS, appendActivity, armPendingWakeLease, cfg, collectors,
    compactingKeys, deliverPrompt, disarmPendingWakeLease, isSessionAllowed, log,
    markReadCalledKeys, pendingWakeKeys, playEnabledV2, promptQueues, turnLeaseNoted, v2TurnStartAt,
    wakeConfigMissCount, wakeConfigUpdatedKeys
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let FREE_TIME_REASONS, acknowledgeMessagesV2, buildWakePromptV2, dueRemindersV2, getSocialV2State, isNightSleepV2, lazyInBedV2,
    messageMediaStore, nightSleepBlocksV2, playHoldV2, quietLeftV2, quietNeededV2, readThroughSeqV2,
    replyTimingCfgV2, saveSocialV2State, socialV2, startFreeTimeV2, whenV2;

  // qqbot_agent：模型偶尔把工具参数 JSON 写坏（DeepSeek 报 MALFORMED_RESPONSE “tool input is invalid JSON”），
  // 回合直接报错结束、她手上的事就断了。这里自动让她接着做，连续最多 socialV2.malformedRetry.max 次（默认 2），
  // 都失败才照旧通知主人。返回 true 表示已经安排了重试（调用方不再通知主人）。
  const malformedRetryCounts = new Map();
  function isMalformedTurnErrorV2(error) {
    if (isRefusalTurnErrorV2(error)) return false;
    return error?.code === 'MALFORMED_RESPONSE' || /tool input is invalid JSON/i.test(String(error?.message ?? ''));
  }

  // qqbot_agent：DeepSeek 的内容审核掐断了她的输出（“unsupported stop reason refusal”，DSH 也报成 MALFORMED_RESPONSE）。
  // 2026-11-19 17:08 1000000004 群有人问“这个表情是什么🇹🇼”，她每次一想复述那句就被掐，
  // 按 JSON 写坏重试、收尾提醒、下一次唤醒（那条还在未读里）全都一样被掐，两分钟里 12 回，群里叫她也不回。
  // 现在统一过滤掉再重试：这一轮开始前到的未读（她这一轮看到的新消息）在未读和最近消息里都换成“被过滤了”，
  // 这一轮她什么都还没做的话从会话历史里剪掉（bridge.js 的 forkSessionV2，从这一轮开始前 fork），
  // 再叫她一次（socialV2.refusalRetry.max，默认 1）；还被掐就把那几条记成看过、算这一轮收了尾。
  // 返回 'retry'（安排了重试）、'gave-up'（重试过还不行）、'dropped'（不是唤醒的一轮，没重试）、false（不是拒答）。
  const REFUSAL_FILTERED_TEXT = '[这条消息被过滤了，看不到原话]';
  const refusalRetryCounts = new Map();
  function isRefusalTurnErrorV2(error) {
    return /stop reason refusal/i.test(String(error?.message ?? ''));
  }
  function filterRefusedMessagesV2(st, before) {
    const seqs = new Set(st.unread.filter((m) => Number.isSafeInteger(m.seq) && Number(m.time) <= before).map((m) => m.seq));
    for (const list of [st.unread, st.recentMessages]) {
      for (const m of list || []) {
        if (!seqs.has(m?.seq) || m.isSelf || m.filtered) continue;
        Object.assign(m, { text: REFUSAL_FILTERED_TEXT, plain: REFUSAL_FILTERED_TEXT, tail: REFUSAL_FILTERED_TEXT,
          media: [], hasMedia: false, forwardIds: [], hasForward: false, filtered: true });
      }
    }
    return seqs;
  }
  async function handleRefusedTurnV2(key, reason, turnStartedAt, cut) {
    if (reason?.kind !== 'error' || !isRefusalTurnErrorV2(reason.error)) {
      refusalRetryCounts.delete(key);
      return false;
    }
    malformedRetryCounts.delete(key);
    const st = getSocialV2State(key);
    const before = Number(turnStartedAt) > 0 ? Number(turnStartedAt) : Date.now();
    const seqs = filterRefusedMessagesV2(st, before);
    let cutDone = false;
    if (cut && !cut.output && Number.isSafeInteger(cut.base)) {
      try { cutDone = !!(await app.forkSessionV2(key, cut.base)); }
      catch (error) { log(`[拒答] ${key} 把这一轮从历史里剪掉没成：${error?.message ?? error}`); }
    }
    const rc = cfg.socialV2?.refusalRetry ?? {};
    const max = Math.max(0, Number(rc.max ?? 1) || 0);
    const n = (refusalRetryCounts.get(key) ?? 0) + 1;
    const wake = pendingWakeKeys.has(key);
    const what = `过滤了 ${seqs.size} 条消息，${cutDone ? '这一轮从历史里剪掉了' : cut?.output ? '这一轮她已经做了事，没剪' : '没剪历史'}`;
    if (wake && rc.enabled !== false && !socialV2.paused && n <= max) {
      refusalRetryCounts.set(key, n);
      saveSocialV2State();
      log(`[拒答] ${key} 这一轮被内容审核掐断，${what}，重试 (${n}/${max})`);
      appendActivity(`${key} 被内容审核掐断，过滤 ${seqs.size} 条后重试 ${n}/${max}`);
      const note = seqs.size
        ? `【系统】有 ${seqs.size} 条消息的原话看不到了，下面写成“${REFUSAL_FILTERED_TEXT}”。别猜它说了什么、别复述、也别追问；只有它的话就当没看到，有别的照常回。`
        : '';
      deliverPrompt(key, '', { wakeReason: st.lastWakeReason || 'message', wakeNote: note }).then((result) => {
        if (result && result.ok === false) {
          pendingWakeKeys.delete(key);
          disarmPendingWakeLease(key);
        }
      }).catch((error) => {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        log(`[拒答] ${key} 重试投递失败: ${error?.message ?? error}`);
      });
      return 'retry';
    }
    refusalRetryCounts.delete(key);
    const shown = [...seqs];
    const acked = shown.length ? acknowledgeMessagesV2(st, Math.max(...shown)) : 0;
    if (wake) markReadCalledKeys.add(key);
    saveSocialV2State();
    log(`[拒答] ${key} 这一轮被内容审核掐断，${what}，${wake ? '重试过了还不行' : '不是唤醒的一轮、不重试'}，${acked} 条未读记成看过`);
    appendActivity(`${key} 被内容审核掐断，跳过 ${acked} 条未读`);
    return wake ? 'gave-up' : 'dropped';
  }
  function retryMalformedTurnV2(key, reason) {
    if (reason?.kind !== 'error' || !isMalformedTurnErrorV2(reason.error)) {
      malformedRetryCounts.delete(key);
      return false;
    }
    const rc = cfg.socialV2?.malformedRetry ?? {};
    const max = Math.max(0, Number(rc.max ?? 2) || 0);
    if (rc.enabled === false || socialV2.paused) return false;
    const n = (malformedRetryCounts.get(key) ?? 0) + 1;
    if (n > max) {
      malformedRetryCounts.delete(key);
      log(`[reserved2] ${key} 工具参数 JSON 连续出错，已自动重试 ${max} 次仍失败，通知主人`);
      return false;
    }
    malformedRetryCounts.set(key, n);
    const st = getSocialV2State(key);
    // 2026-11-23 1100000003 群她连着 9 次把话写成 {"messages": 在玩2048呀}（文字没加引号），
    // 以前这里只说“没写完整、可能太长被截断”，她照样再写一遍。DSH 现在会自己补引号（control/patch-dsh-tool-json-bare-string.mjs），
    // 剩下的多半是真被截断或别的写法问题，所以两种都说清楚。
    const prompt = `【系统】刚才你调用工具时参数不是合法的 JSON，这一步被中断了，没有执行。最常见的是两种：文字没加双引号（要写成 {"messages": "在玩呀"}，不能写成 {"messages": 在玩呀}），或者内容太长被截断了（拆成几次发）。照这个改好，接着刚才的事继续做就行。（会话 ${key}，令牌 ${st.agentToken}）`;
    log(`[reserved2] ${key} 工具参数 JSON 出错，自动重试 (${n}/${max})`);
    appendActivity(`${key} 工具参数 JSON 出错，自动重试 ${n}/${max}`);
    deliverPrompt(key, prompt).then((result) => {
      // 没被 DSH 接受时 deliverPromptNow 已经通知过主人
      if (result && result.ok === false) log(`[reserved2] ${key} 自动重试投递失败：${result.error ?? ''}`);
    }).catch((error) => log(`[reserved2] ${key} 自动重试投递失败: ${error?.message ?? error}`));
    return true;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowed(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    // 自由时间会话只有“去玩”这几种唤醒；潜水到期、回复检查之类都和它无关
    if (key === PLAY_KEY && !['proactiveCheck', 'goPlay', 'admin'].includes(reason)) return;
    if (key !== PLAY_KEY && reason === 'proactiveCheck') {
      log(`[reserved2] 自由时间在 ${PLAY_KEY} 里过，不在 ${key} 里唤醒（proactiveCheck）`);
      return;
    }
    if (nightSleepBlocksV2(key, reason)) return;
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      // 主动找人碰上她正在这里聊：本来就在聊，不用再“想起来”去说
      if (reason === 'initiate') {
        log(`[主动找人] ${key} 正在聊，这次就不专门去说了`);
        return;
      }
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 sleep 定时已经摘掉，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!app.scheduler.has(`rate-retry:${key}`)) {
        app.scheduler.after(`rate-retry:${key}`, waitMs, () => {
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        });
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    cancelSleepTimerV2(key);
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    st.initiateNow = reason === 'initiate' ? Number(st.initiateThought?.at) || 0 : 0;
    st.freeTime = FREE_TIME_REASONS.has(reason) || key === PLAY_KEY ? startFreeTimeV2(key, now, reason) : null;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    if (compactingKeys.has(key)) return 'compacting';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = app.state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    if (compactingKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = app.state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    speaker: 75,
    nameMention: 70,
    talkBack: 65,
    addressed: 60,
    anyMessage: 50,
    replyGate: 42,
    reminder: 32,
    draw: 31,
    video: 31,
    timeout: 30,
    initiate: 25,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'proactiveCheck', 'goPlay', 'bootstrap', 'admin', 'initiate', 'reminder', 'draw', 'video']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (nightSleepBlocksV2(key, reason)) return;
    if (!isSessionAllowed(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelSleepTimerV2(key);
    st.pendingWakeReason = reason;
    // 合并窗口以全局配置为准：每个会话的 wakeConfig 里存着创建时的旧值，改配置要能直接生效。
    let batchMs = Math.max(1000, Number(cfg.socialV2?.wake?.batchWindowMs) || Number(st.wakeConfig?.batchWindowMs) || 8000);
    // qqbot_agent：消息叫来的，按对方的节奏等他说完（replyTiming，见 reply-timing.js）：
    // 不再死等 batchWindowMs，而是等到“最新一条之后安静够了”；到点还有人在说就再等，从第一条算最多 maxDelayMs
    const rt = !isTimerWakeReason(reason) ? replyTimingCfgV2() : null;
    const adaptive = !!rt?.enabled;
    const since = Date.now();
    // 群里是谁叫的她就只等这个人说完，旁人接着聊不再往后推：2026-10-27 19:57 大群里阿明 @ 她，
    // 补了一句“*故事”，又有个不相干的人说了一句，她 14 秒后才被叫醒
    // （wakeBy 是触发这次唤醒的那条消息刚记下的；等的时候又有人叫她就换成那个人）
    const waker = () => {
      const wb = st.wakeBy;
      return String(key).startsWith('group:') && wb?.userId && Number(wb.at || 0) >= since - 2000 ? wb.userId : null;
    };
    if (adaptive) batchMs = Math.max(300, quietLeftV2(key, st, Date.now(), waker()) ?? batchMs);
    const fire = () => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      if (adaptive && !isTimerWakeReason(finalReason)) {
        const left = quietLeftV2(key, st, Date.now(), waker()) ?? 0;
        const budget = rt.maxDelayMs - (Date.now() - since);
        if (left > 50 && budget > 50) {
          st.pendingWakeTimer = setTimeout(fire, Math.max(100, Math.min(left, budget)));
          st.pendingWakeTimer.unref?.();
          return;
        }
      }
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    };
    st.pendingWakeTimer = setTimeout(fire, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    const q = adaptive ? quietNeededV2(key, st, Date.now(), waker()) : null;
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 100) / 10}s 后发送${q ? `（等对方说完：${Math.round(q.ms / 100) / 10}s，${q.why}）` : ''}`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （它的 seq 还在已展示水位 readThroughSeqV2 之后）；
   *   · 定时器类（timeout/proactiveCheck/bootstrap/admin/initiate/reminder/draw）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleep 定时已经摘掉，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  // qqbot_agent：整个队列过一遍。以前一次只取队头一条，队头已处理过被跳过，后面没展示过的 @ 就留在队列里，
  // 要等下一回合结束才补：2026-10-28 08:43 群 1000000004 有人 @ 她，她正忙，回合结束时只看了队头的 talkBack，
  // 那条 @ 干等到 08:45 别人又说话才被顺带叫醒。补发的几条消息类唤醒会并进同一次计划唤醒（按优先级取最终原因）。
  // 返回第一条补发/定时器类的结果，都跳过了就返回最后一条跳过的。
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    let first = null;
    let skipped = null;
    // 先整个拿出来：会话还忙着时补发会再塞回队列，边取边塞会转不停
    const items = st.pendingWakeReasons.splice(0);
    for (const item of items) {
      const r = replayOnePendingWakeV2(key, st, item);
      if (!r) continue;
      if (r.action === 'skipped') skipped = r;
      else if (!first) first = r;
    }
    return first || skipped;
  }

  function replayOnePendingWakeV2(key, st, item) {
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else if (item.reason === 'reminder' && !dueRemindersV2(key).length) {
        log(`[提醒] ${key} 到点的事这一轮里已经看到了，跳过补发`);
      } else if (app.jobKindOfWakeReasonV2(item.reason) && !app.notesOfV2(key, app.jobKindOfWakeReasonV2(item.reason)).length) {
        log(`[reserved2] ${key} 没做成的${item.reason}这一轮里已经知道了，跳过补发`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    // qqbot_agent: 只看触发它的那条消息本身有没有展示过（标读或经等待/快照展示都算）。
    // 以前是「unread 里有任何 seq ≥ 它的消息」，回合末又来一条新消息就会把早已回过的 @ 再补发一次，
    // 她会对着几分钟前的消息再回一遍。
    const stillRelevant = Number(item.seq) > readThroughSeqV2(st);
    if (stillRelevant) {
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理（已展示到 seq${readThroughSeqV2(st)}），跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  // 潜水到期：定时里的 sleep:<key>（2026-11-08 以前是每个会话一个 setTimeout，超过 100 秒的分段续期）
  const sleepJobV2 = (key) => `sleep:${key}`;
  function cancelSleepTimerV2(key) {
    if (key) app.scheduler.cancel(sleepJobV2(key));
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowed(key)) return;
    const st = getSocialV2State(key);
    cancelSleepTimerV2(key);
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const wake = () => void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    const delay = until - Date.now();
    if (delay <= 0) {
      wake();
      return;
    }
    app.scheduler.at(sleepJobV2(key), until, wake);
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  // qqbot_agent：自由时间是全局的——她只有一个人，不会同时在两个会话里各玩各的。
  // 定时里一个 free-time-check 每分钟看一眼，到了 socialV2.proactiveNextAt 才真的检查（2026-11-08 以前是每个会话各一个 setTimeout）。
  // 下次检查时间存在 socialV2.proactiveNextAt（写进 social-v2.json），重启后接着用。
  function proactiveIntervalV2() {
    const p = cfg.socialV2?.proactive ?? {};
    const slotNow = proactiveSlot(p);
    const min = Math.max(60 * 1000, Number(slotNow?.checkIntervalMinMs ?? p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(slotNow?.checkIntervalMaxMs ?? p.checkIntervalMaxMs) || 90 * 60 * 1000);
    return Math.floor(min + Math.random() * (max - min));
  }
  function proactiveProbabilityV2(st) {
    const p = cfg.socialV2?.proactive ?? {};
    // 有作息表时用触发那一刻所在时间段的概率，而且不再叠加下面的夜间 ×0.3
    const slot = proactiveSlot(p);
    const probBase = Number(slot ? slot.probability : p.probability);
    let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
    const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
    if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
    if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
    const hour = new Date().getHours();
    if (!slot && (hour >= 23 || hour < 8)) prob *= 0.3;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
    if (aiCount >= 5) prob *= 0.3;
    return prob;
  }
  function runGlobalProactiveCheckV2() {
    if (Date.now() < socialV2.proactiveNextAt) return;
    socialV2.proactiveNextAt = Date.now() + proactiveIntervalV2();
    saveSocialV2State();
    // qqbot_agent：自由时间有自己的会话，不再挑一个安静的聊天去玩；正在玩就等下一轮
    if (!playEnabledV2()) return;
    const st = getSocialV2State(PLAY_KEY);
    const next = Math.round((socialV2.proactiveNextAt - Date.now()) / 60000);
    if (isNightSleepV2()) { log(`[reserved2] 自由时间检查：睡觉时间，跳过；下次约 ${next}min 后`); return; }
    if (lazyInBedV2()) { log(`[reserved2] 自由时间检查：醒了还在赖床，跳过；下次约 ${next}min 后`); return; }
    if (isConversationBusyV2(PLAY_KEY, st)) { log(`[reserved2] 自由时间检查：还在玩，跳过；下次约 ${next}min 后`); return; }
    const hold = playHoldV2();
    if (hold) { log(`[reserved2] 自由时间检查：答应了先不玩（到 ${whenV2(hold.until)}），跳过；下次约 ${next}min 后`); return; }
    const prob = proactiveProbabilityV2(st);
    const go = Math.random() < prob;
    log(`[reserved2] 自由时间检查：概率 ${prob.toFixed(2)}，${go ? '去玩' : '这次不玩'}；下次约 ${next}min 后`);
    if (go) void sendWakePromptV2(PLAY_KEY, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${PLAY_KEY}:`, error?.message ?? error));
  }

  function freeTimeTickV2() {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused) return;
    if (!socialV2.proactiveNextAt) socialV2.proactiveNextAt = Date.now() + proactiveIntervalV2();
    runGlobalProactiveCheckV2();
  }

  // 名字沿用以前的（各处在会话出现、模式切换时调它）；现在只是确保全局的 free-time-check 登记着
  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowed(key)) return;
    if (!socialV2.proactiveNextAt) socialV2.proactiveNextAt = Date.now() + proactiveIntervalV2();
    if (!app.scheduler.has('free-time-check')) app.scheduler.every('free-time-check', 60 * 1000, freeTimeTickV2);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    cancelSleepTimerV2(key);
    if (st.gateTimer) {
      clearTimeout(st.gateTimer);
      st.gateTimer = null;
    }
    app.scheduler.cancel(`rate-retry:${key}`);
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    app.scheduler.cancel('free-time-check');
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  return {
    exports: {
      cancelSleepTimerV2,
      clearAllSocialV2Timers,
      clearSocialV2Timers,
      isConversationBusyV2,
      isTimerWakeReason,
      replayPendingWakeReasonsV2,
      retryMalformedTurnV2,
      handleRefusedTurnV2,
      isRefusalTurnErrorV2,
      runGlobalProactiveCheckV2,
      scheduleProactiveCheckV2,
      scheduleWakeV2,
      sendWakePromptV2,
      setupSleepTimerV2,
      wakePriorityV2,
    },
    link() {
      ({
        FREE_TIME_REASONS, acknowledgeMessagesV2, buildWakePromptV2, dueRemindersV2, getSocialV2State, isNightSleepV2, lazyInBedV2,
        messageMediaStore, nightSleepBlocksV2, playHoldV2, quietLeftV2, quietNeededV2, readThroughSeqV2,
        replyTimingCfgV2, saveSocialV2State, socialV2, startFreeTimeV2, whenV2
      } = app);
    },
    start() {},
  };
}
