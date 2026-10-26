// 睡觉：夜里挡唤醒、主人叫醒、一起睡、到点收尾
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { inNightSleep, minutesUntilClock, nextClockTime } from '../proactive-schedule.js';

export function createNightSleep(app) {
  const {
    PLAY_KEY, api, cfg, isSessionAllowedInCurrentMode, log, markReadCalledKeys
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let FREE_TIME_REASONS, acknowledgeMessagesV2, convLabelV2, crossSessionSummaryOnlyV2,
    getSocialV2State, isConversationBusyV2, isTimerWakeReason, mentionsSelfNameV2, readThroughSeqV2,
    saveSocialV2State, scheduleWakeV2, socialV2, wakePriorityV2;

  // qqbot_agent：夜里固定睡觉。睡觉时间里谁叫都不醒（@、名字、提问、概率、回复检查、潜水到期、自由时间都不算），
  // 只有主人亲自叫她（私聊她，或在群里 @她/引用她/叫她名字/拍她）才会醒；醒着陪主人聊的那一会儿
  // （ownerAwakeMs，默认 20 分钟，主人每说一句就顺延）主人在这个会话里说话也会叫醒她。
  // 夜里被挡掉的消息类唤醒记下来，早上起床后每个会话补一次。
  const nightOwnerAwakeUntil = new Map(); // key -> ts
  const nightMissedWakes = new Map(); // key -> 夜里最重要的那个唤醒原因
  function nightSleepCfgV2() {
    const n = cfg.socialV2?.nightSleep ?? {};
    return { ...n, ownerAwakeMs: Math.max(60000, Number(n.ownerAwakeMs) || 20 * 60 * 1000) };
  }
  // 固定的睡觉时间，或者她自己用 qq_go_to_sleep 提前睡了（见 selfSleptV2）
  function isNightSleepV2() {
    return inNightSleep(cfg.socialV2?.nightSleep) || selfSleptV2();
  }
  function ownerAwakeV2(key) {
    return (nightOwnerAwakeUntil.get(key) || 0) > Date.now();
  }
  // 主人这条消息算不算“亲自叫她”
  function ownerCallsHerV2(key, event, kind, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return true;
    if (ownerAwakeV2(key)) return true;
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return true;
    return mentionsSelfNameV2(plainContent);
  }
  function noteOwnerNightWakeV2(key) {
    nightOwnerAwakeUntil.set(key, Date.now() + nightSleepCfgV2().ownerAwakeMs);
    log(`[reserved2] 夜间睡觉：主人在 ${key} 叫醒了她`);
  }
  // 返回 true 表示这次唤醒被睡觉挡掉
  function nightSleepBlocksV2(key, reason) {
    if (!isNightSleepV2()) return false;
    // goPlay 是聊天会话里发起的，能发起说明那边醒着（go-play 接口自己按夜间规则把关）
    if (reason === 'admin' || reason === 'goPlay' || ownerAwakeV2(key)) return false;
    if (!isTimerWakeReason(reason) || reason === 'bootstrap') {
      const cur = nightMissedWakes.get(key);
      if (!cur || wakePriorityV2(reason) > wakePriorityV2(cur)) nightMissedWakes.set(key, reason);
    }
    log(`[reserved2] 夜间睡觉，忽略唤醒 ${key}（${reason}）`);
    return true;
  }
  function nightSleepLineV2(key, st) {
    if (isNightSleepV2() && ownerAwakeV2(key)) {
      return '【现在是你的睡觉时间】你本来已经睡着了，是主人亲自把你叫醒的。迷迷糊糊、带点困意地回主人就好；别的群友这时候找你可以不理。聊完跟主人说一声，接着回去睡。\n\n';
    }
    if (st?.morningWakeAt && Date.now() - Number(st.morningWakeAt) < 30 * 60 * 1000) {
      return '【你刚睡醒】昨晚你在睡觉，夜里有人找过你但你没看到。现在起床了，像刚醒的人一样看看消息，想回的回一下（可以说刚起床才看到），过时的话题就算了。\n\n';
    }
    return '';
  }
  function nightCfgOkV2() {
    const n = cfg.socialV2?.nightSleep ?? {};
    return n.enabled !== false && !!n.from && !!n.to ? n : null;
  }
  // 她自己用 qq_go_to_sleep 说了去睡（提前睡，或夜里被叫醒后接着睡）：睡到 sleptAt 之后的第一个起床时间
  function selfSleptV2(now = Date.now()) {
    const n = nightCfgOkV2();
    if (!n || !socialV2.sleptAt) return false;
    const until = nextClockTime(n.to, socialV2.sleptAt);
    return Number.isFinite(until) && now < until;
  }
  // 能不能用 qq_go_to_sleep：夜里，或睡觉时间前 nightSleep.earlySleepMinutes（默认 120）分钟以内
  function earlySleepAllowedV2(now = Date.now()) {
    const n = nightCfgOkV2();
    if (!n) return false;
    if (isNightSleepV2()) return true;
    const early = Math.max(0, Number(n.earlySleepMinutes ?? 120));
    const left = minutesUntilClock(n.from, new Date(now));
    return Number.isFinite(left) && left > 0 && left <= early;
  }
  function sleepStateV2(now = Date.now()) {
    const n = nightCfgOkV2();
    if (!n) return { kind: 'off' };
    if (isNightSleepV2()) {
      const awakeKeys = [...nightOwnerAwakeUntil].filter(([, t]) => t > now).map(([k]) => k);
      const early = !inNightSleep(n, new Date(now));
      return { kind: awakeKeys.length ? 'woken' : 'asleep', awakeKeys, early };
    }
    // 最近一次起床：now 之前 24 小时内的那个 to
    const wokeAt = nextClockTime(n.to, now - 86400000);
    return { kind: 'awake', wokeAt, toBedMin: minutesUntilClock(n.from, new Date(now)) };
  }

  // 她说去睡了：所有地方一起睡。别的正在进行的窗口插一句让它收尾（自由时间那边也是），之后谁叫都不醒，只有主人亲自叫才醒。
  function goToSleepV2(key, note) {
    const n = nightCfgOkV2();
    if (!n) return { ok: false, error: '没有配置睡觉时间' };
    const now = Date.now();
    if (!earlySleepAllowedV2(now)) {
      return { ok: false, error: `现在还不到睡觉的时候（每天 ${n.from} 睡、${n.to} 起）。真困了就用 qq_set_mood 记一下“有点困”，别跟大家说去睡了。` };
    }
    socialV2.sleptAt = now;
    socialV2.sleptKey = key;
    const woken = [...nightOwnerAwakeUntil.keys()];
    nightOwnerAwakeUntil.clear();
    // 这一轮就算收尾了：不再要沉睡前等待，也不再提醒她设唤醒
    if (key !== PLAY_KEY) {
      const st = getSocialV2State(key);
      acknowledgeMessagesV2(st, readThroughSeqV2(st));
      st.lastActionAt = now;
      if (st.wakeConfig) { st.wakeConfig.noActionCount = 0; st.wakeConfig.confirmedAt = now; st.wakeConfig.confirmedBy = 'go_to_sleep'; }
    }
    markReadCalledKeys.add(key);
    saveSocialV2State();
    log(`[selfState] 夜间睡觉：${key} 说去睡了${note ? `（${note}）` : ''}，所有会话一起睡到 ${n.to}${woken.length ? `；之前被主人叫醒的 ${woken.join('、')} 也一起睡了` : ''}`);
    void steerSleepV2(key, 'self').catch(() => {});
    return { ok: true, sleepUntil: n.to, hint: `睡了。别的窗口和电脑那边的你会自己收尾。晚安说过了就直接结束这一轮：不用 qq_wait_for_messages、不用再设唤醒。之后只有主人亲自叫你才会醒，明早 ${n.to} 起床。` };
  }
  // 往正在进行的其他会话里插一句让她收尾去睡。why：'self' 她自己在 fromKey 说了去睡；'night' 到了睡觉时间
  async function steerSleepV2(fromKey, why) {
    if (app.currentMode !== 'reserved2' || socialV2.paused) return;
    for (const [k, st] of [...socialV2.conversations]) {
      if (k === fromKey || !isSessionAllowedInCurrentMode(k) || !isConversationBusyV2(k, st)) continue;
      if (why === 'night' && ownerAwakeV2(k)) continue; // 正陪着主人的不催
      const sessionId = app.state.sessions?.[k];
      if (!sessionId) continue;
      const from = fromKey ? convLabelV2(fromKey, socialV2.conversations.get(fromKey), crossSessionSummaryOnlyV2(k)) : '';
      let text;
      if (k === PLAY_KEY) {
        if (!FREE_TIME_REASONS.has(st.lastWakeReason)) continue;
        if (st.freeTime) st.freeTime.curfewSent = true; // 免得 freeTimeCurfewV2 再插一句【该睡觉了】
        const markRead = `mcp__snowluma__qq_mark_read(key="${PLAY_KEY}", token=${st.agentToken})`;
        text = why === 'self'
          ? `【你要去睡了】你刚在${from}说了要去睡觉，现在所有地方一起睡。手上的停下，关掉多余的标签页，调用 ${markRead}，明天再玩。`
          : `【该睡觉了】已经到睡觉时间啦。手上这个看完就收尾：关掉多余的标签页，调用 ${markRead}，明天再玩。`;
      } else {
        text = why === 'self'
          ? `【你要去睡了】你刚在${from}说了要去睡觉，现在所有地方一起睡。这边要是正聊着，就简单说一声“我去睡啦”，然后 qq_mark_read 结束，不用再等消息。`
          : '【该睡觉了】到睡觉时间了。这边要是正聊着，就跟大家说一声去睡了，然后 qq_mark_read 结束，不用再等消息。';
      }
      try {
        const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
        log(`[selfState] 去睡了，让 ${k} 收尾（${accepted?.result?.ok ? '已插话' : '插话没被接受'}）`);
      } catch (error) {
        log(`[selfState] 让 ${k} 收尾失败：${error?.message ?? error}`);
      }
    }
  }
  // 到了睡觉时间（从醒着变成睡着）：主人刚在哪个会话里跟她聊着的，算主人陪着（不打断）；其他正在进行的窗口让她收尾
  let lastNightStateV2 = null;
  function nightStartTickV2() {
    const night = isNightSleepV2();
    const was = lastNightStateV2;
    lastNightStateV2 = night;
    if (was !== false || !night || app.currentMode !== 'reserved2' || socialV2.paused) return;
    if (socialV2.sleptAt && Date.now() - socialV2.sleptAt < 2 * 60000) return; // 她自己刚说去睡，goToSleepV2 已经插过话
    const awakeMs = nightSleepCfgV2().ownerAwakeMs;
    const now = Date.now();
    for (const [k, s] of socialV2.conversations) {
      if (k === PLAY_KEY) continue;
      const lastOwner = (Array.isArray(s.recentMessages) ? s.recentMessages : []).filter((m) => m && !m.isSelf && m.isOwner).reduce((t, m) => Math.max(t, Number(m.time) || 0), 0);
      if (lastOwner && now - lastOwner < awakeMs) {
        nightOwnerAwakeUntil.set(k, lastOwner + awakeMs);
        log(`[reserved2] 夜间睡觉：到点时主人正在 ${k} 跟她聊，先陪着`);
      }
    }
    void steerSleepV2(null, 'night').catch(() => {});
  }

  return {
    exports: {
      goToSleepV2,
      isNightSleepV2,
      nightCfgOkV2,
      nightOwnerAwakeUntil,
      nightSleepBlocksV2,
      nightSleepLineV2,
      nightStartTickV2,
      noteOwnerNightWakeV2,
      ownerAwakeV2,
      ownerCallsHerV2,
      selfSleptV2,
      sleepStateV2,
      steerSleepV2,
    },
    link() {
      ({
        FREE_TIME_REASONS, acknowledgeMessagesV2, convLabelV2, crossSessionSummaryOnlyV2,
        getSocialV2State, isConversationBusyV2, isTimerWakeReason, mentionsSelfNameV2,
        readThroughSeqV2, saveSocialV2State, scheduleWakeV2, socialV2, wakePriorityV2
      } = app);
    },
    start() {
    app.scheduler.every('night-start', 60 * 1000, nightStartTickV2);

    // 起床后补一次夜里被挡掉的唤醒
    app.scheduler.every('night-missed-wakes', 60 * 1000, () => {
      if (!nightMissedWakes.size || isNightSleepV2() || socialV2.paused || app.currentMode !== 'reserved2') return;
      for (const [key, reason] of [...nightMissedWakes]) {
        nightMissedWakes.delete(key);
        const st = getSocialV2State(key);
        st.morningWakeAt = Date.now();
        log(`[reserved2] 起床了，补一次夜里被挡掉的唤醒 ${key}（${reason}）`);
        scheduleWakeV2(key, reason);
      }
    });
    },
  };
}
