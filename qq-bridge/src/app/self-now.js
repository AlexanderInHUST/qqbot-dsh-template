// 【你现在】：她此刻的状态（所有会话同一份）
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { moodPhase } from '../inner-life.js';
import { proactiveSlot } from '../proactive-schedule.js';
import { defang } from '../qq-model-view.js';

export function createSelfNow(app) {
  const {
    PLAY_KEY, cfg, isSessionAllowedInCurrentMode
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let FREE_TIME_REASONS, PLAY_LAST_ITEM_MS, convLabelV2, crossSessionCountOnlyV2,
    crossSessionSummaryOnlyV2, whenV2, isConversationBusyV2, lifeLinesV2, moodEngineCfgV2,
    nightCfgOkV2, playHoldLineV2, playSessionsTextV2, selfClaimsLineV2, selfSleptV2, sleepStateV2, socialV2,
    todayPlaySessionsV2;

  // ── qqbot_agent：【你现在】她此刻的状态，所有会话（几个聊天 + 自由时间）看到的是同一份 ─────────────
  // 睡没睡、电脑上在玩什么、别处在跟谁聊、她自己定的心情（qq_set_mood）、bridge 算的身体感受。
  // 以前这些只在唤醒时零散地给（作息行、【别处的事】末尾），自由时间的东西每轮重开、重启就没了，
  // 她在一个窗口说“去睡了”，另一个窗口还在玩；这边刚生完气，那边又没事人一样。
  const MOOD_STALE_MS = 3 * 3600 * 1000;
  function playingNowV2() {
    const play = socialV2.conversations.get(PLAY_KEY);
    return !!play && isConversationBusyV2(PLAY_KEY, play) && FREE_TIME_REASONS.has(play.lastWakeReason);
  }
  function bodyFeelingsV2(now, sleep) {
    const out = [];
    if (sleep.kind === 'woken') out.push('困得眼睛都睁不开');
    else if (sleep.kind === 'awake') {
      if (sleep.lazy) out.push('醒了还赖在床上，不想起');
      else if (now - sleep.wokeAt < 30 * 60000) out.push('刚起床，还有点迷糊');
      else if (Number.isFinite(sleep.toBedMin) && sleep.toBedMin <= 60) out.push('有点困了');
    }
    let sent = 0;
    for (const [k, s] of socialV2.conversations) {
      if (k !== PLAY_KEY) sent += (Array.isArray(s.sendTimes) ? s.sendTimes : []).filter((t) => now - Number(t) < 3600000).length;
    }
    if (sent >= 40) out.push('这一个小时说了好多话，有点累');
    if (playingNowV2() && socialV2.playStartedAt && now - socialV2.playStartedAt >= 45 * 60000) out.push('盯着屏幕久了，眼睛有点酸');
    return out;
  }
  function minutesAgoTextV2(t, now) {
    const m = Math.max(0, Math.round((now - Number(t)) / 60000));
    return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${whenV2(t)}`;
  }
  // 别的聊天窗口：正在聊的、10 分钟内说过话的
  function otherChatsNowV2(key, now) {
    const neutral = crossSessionSummaryOnlyV2(key);
    const busy = [];
    const recent = [];
    for (const [k, s] of socialV2.conversations) {
      if (k === key || k === PLAY_KEY || !isSessionAllowedInCurrentMode(k)) continue;
      const label = convLabelV2(k, s, neutral);
      if (isConversationBusyV2(k, s)) busy.push(label);
      else if (Number(s.lastAiReplyAt) && now - Number(s.lastAiReplyAt) < 10 * 60000) recent.push(`${minutesAgoTextV2(s.lastAiReplyAt, now)}在${label}说过话`);
    }
    return { busy, recent };
  }
  // 今天（起床以后）在电脑上玩过的，去掉重复的，按时间排；多了只留最近的
  const TODAY_PLAY_MAX = 14;
  function todayPlayLineV2(sleep, now = Date.now()) {
    if (sleep.kind !== 'awake' || !sleep.wokeAt) return '';
    const seen = new Set();
    const items = [];
    // 日记那份（life.dayPlay）也是同样的条目，合在一起：升级前 playLog 只存了 6 小时
    const all = [...(socialV2.life?.dayPlay || []), ...(socialV2.playLog || [])].sort((a, b) => Number(a.at) - Number(b.at));
    for (const x of all) {
      if (!(Number(x.at) >= sleep.wokeAt && Number(x.at) <= now) || seen.has(x.what)) continue;
      seen.add(x.what);
      items.push(x);
    }
    if (!items.length) return '';
    const shown = items.slice(-TODAY_PLAY_MAX);
    const more = items.length - shown.length;
    const bv = shown.some((x) => /（BV[0-9A-Za-z]{10}）/.test(x.what)) ? '；要视频链接就是 https://www.bilibili.com/video/ 后面接括号里的 BV 号，别拿别的视频顶' : '';
    return `- 今天在电脑上（有人问你今天干了啥、看了什么，就照这些说，挑几样有意思的讲；这里没有的不是今天的事${bv}）：${more > 0 ? `更早还有 ${more} 样；` : ''}${shown.map((x) => `${whenV2(x.at)} ${x.what}`).join('；')}。`;
  }
  function selfNowPartsV2(key, now = Date.now()) {
    const sleep = sleepStateV2(now);
    const n = nightCfgOkV2();
    const lines = [];
    const slot = proactiveSlot(cfg.socialV2?.proactive, new Date(now));
    let slotLabel = String(slot?.label || slot?._说明 || '').trim();
    if (sleep.kind === 'awake' && slotLabel.includes('睡')) slotLabel = ''; // 睡觉时间每晚浮动时，作息表的“睡觉”段里她可能还醒着
    lines.push(`- 时间：${whenV2(now)} 星期${'日一二三四五六'[new Date(now).getDay()]}${slotLabel ? `（${slotLabel}）` : ''}`);
    if (sleep.kind === 'awake') {
      const lastNight = socialV2.sleptAt && socialV2.sleptAt < sleep.wokeAt && sleep.wokeAt - socialV2.sleptAt < 86400000 ? `，昨晚 ${whenV2(socialV2.sleptAt)} 睡的` : '';
      const woke = sleep.lazy ? `${whenV2(sleep.wokeAt)} 醒的，还赖在床上看手机，没起床（能回消息，不上电脑）` : `${whenV2(sleep.wokeAt)} 起的床${sleep.wakeWhy ? `（${sleep.wakeWhy}）` : ''}`;
      lines.push(`- 睡觉：醒着。${woke}${lastNight}；之前说过的“晚安”“去睡了”都是昨晚的事。今晚 ${sleep.bedClock ?? n.from}${sleep.bedWhy ? ` 左右睡（${sleep.bedWhy}）` : ' 睡觉'}。`);
    } else if (sleep.kind === 'asleep') {
      const where = socialV2.sleptAt && selfSleptV2(now) && socialV2.sleptKey ? `${whenV2(socialV2.sleptAt)} 在${convLabelV2(socialV2.sleptKey, socialV2.conversations.get(socialV2.sleptKey), crossSessionSummaryOnlyV2(key))}说了去睡，` : '';
      lines.push(`- 睡觉：${where}已经睡着了（${sleep.wakeClock ?? n.to} 起床）。`);
    } else if (sleep.kind === 'woken') {
      const here = sleep.awakeKeys.includes(key);
      const others = sleep.awakeKeys.filter((k) => k !== key).map((k) => convLabelV2(k, socialV2.conversations.get(k), crossSessionSummaryOnlyV2(key)));
      lines.push(`- 睡觉：本来已经睡了，${here ? '是主人在这里把你叫醒的' : `主人在${others.join('、')}把你叫醒了，你在那边陪着`}；迷迷糊糊的，聊完接着睡（${sleep.wakeClock ?? n.to} 起床）。`);
    }
    // 电脑那边
    const playing = playingNowV2();
    const play = socialV2.conversations.get(PLAY_KEY);
    const log6h = (socialV2.playLog || []).filter((x) => now - Number(x.at) < PLAY_LAST_ITEM_MS);
    const lastItem = log6h.at(-1);
    const page = String(play?.freeTime?.currentPage || '').slice(0, 80);
    if (key === PLAY_KEY) {
      if (playing || isConversationBusyV2(PLAY_KEY, play)) lines.push(`- 电脑：你现在就在电脑上玩${socialV2.playStartedAt ? `，${whenV2(socialV2.playStartedAt)} 开始的` : ''}${lastItem && Number(lastItem.at) >= socialV2.playStartedAt ? `，刚才${lastItem.what}` : ''}。`);
    } else if (playing) {
      lines.push(`- 电脑：自由时间的你正在电脑上玩（${whenV2(socialV2.playStartedAt)} 开始的${page ? `，现在开着 ${page}` : ''}${lastItem && Number(lastItem.at) >= socialV2.playStartedAt ? `，刚才${lastItem.what}` : ''}）。`);
    } else if (lastItem) {
      const range = socialV2.playStartedAt && socialV2.playEndedAt >= socialV2.playStartedAt ? `${whenV2(socialV2.playStartedAt)}~${whenV2(socialV2.playEndedAt)} ` : '';
      lines.push(`- 电脑：现在没在玩。上次${range}玩的，最后${lastItem.what}。`);
    } else if (sleep.kind === 'awake' && !(socialV2.playStartedAt >= sleep.wokeAt)) {
      lines.push('- 电脑：今天还没上电脑玩过。');
    }
    // 答应了先不玩（别的窗口用 qq_tell_myself 捎来的）
    const hold = playHoldLineV2(key, now);
    if (hold) lines.push(hold);
    const sessions = todayPlaySessionsV2(sleep, now);
    if (sessions.length) {
      const mins = sessions.reduce((n, x) => n + Math.max(1, Math.round(((x.end || now) - x.start) / 60000)), 0);
      const parts = [...new Set(sessions.map((x) => { const h = new Date(x.start).getHours(); return h < 12 ? '上午' : h < 18 ? '下午' : '晚上'; }))];
      lines.push(`- 今天上电脑玩了 ${sessions.length} 回：${playSessionsTextV2(sessions)}，加起来大概 ${mins} 分钟${parts.length >= 2 ? `（${parts.join('、')}都玩过，别说成只玩了一阵）` : ''}。`);
    }
    const today = todayPlayLineV2(sleep, now);
    if (today) lines.push(today);
    // 别的聊天窗口
    const chats = otherChatsNowV2(key, now);
    const chatBits = [];
    if (chats.busy.length) chatBits.push(`你正在${chats.busy.join('、')}聊着`);
    if (chats.recent.length) chatBits.push(chats.recent.join('，'));
    if (chatBits.length) lines.push(`- 别的窗口：${chatBits.join('；')}。`);
    // 心情：自己体会的（moodEngine，会慢慢淡回平常）或她自己用 qq_set_mood 定的
    const mood = socialV2.mood;
    const me = moodEngineCfgV2();
    const phase = mood?.text && mood.source === 'auto' ? moodPhase(mood, now, me.halfLifeMinutes) : '';
    // 心情是在别处定的：写上几点、在哪，免得她把那边的事当成这里刚发生的（10-23 技术群讲了黄鼠狼，心情原因写着它，私聊被问“今天干嘛了”就又讲一遍）
    const whyTextV2 = (hideWhy) => {
      if (!mood.why || hideWhy) return '';
      if (!mood.key || mood.key === key) return `（${mood.why}）`;
      const label = convLabelV2(mood.key, socialV2.conversations.get(mood.key), crossSessionSummaryOnlyV2(key));
      const where = mood.key === PLAY_KEY ? '在电脑上玩的时候' : `在${label}${/\d$/.test(label) ? ' ' : ''}里`;
      return `（${whenV2(mood.at)} ${where}：${mood.why}）`;
    };
    if (me.enabled && (!mood?.text || phase === 'gone')) {
      lines.push(`- 心情：${me.baseline}。`);
    } else if (phase) {
      const hideWhy = crossSessionCountOnlyV2(key, mood.key);
      lines.push(`- 心情：${mood.text}${whyTextV2(hideWhy)}${phase === 'fading' ? '，不过已经淡了不少' : ''}。`);
    } else if (mood?.text) {
      const hideWhy = crossSessionCountOnlyV2(key, mood.key);
      const stale = now - Number(mood.at) >= MOOD_STALE_MS;
      lines.push(`- 心情：${mood.text}${whyTextV2(hideWhy)}，${minutesAgoTextV2(mood.at, now)}定的${stale ? '，过了挺久了，现在不一定还这样，变了就改' : ''}。`);
    } else {
      lines.push('- 心情：还没写。心情有了起伏就用 qq_set_mood 记一下。');
    }
    const body = bodyFeelingsV2(now, sleep);
    if (body.length) lines.push(`- 身体：${body.join('，')}。`);
    const life = lifeLinesV2(key, sleep, now);
    lines.push(...life);
    const claims = selfClaimsLineV2(key, sleep, now);
    if (claims) lines.push(claims);
    const sig = JSON.stringify([sleep.kind, sleep.awakeKeys || [], playing, page, lastItem?.at || 0, mood?.at || 0, phase, chats.busy, body, life, sessions.length, claims, hold]);
    // 网页标题、心情原因、她说过的话都可能带【】，别让它们看着像一段提示
    return { lines: lines.map(defang), sig };
  }
  function selfNowBlockV2(key, st) {
    const { lines, sig } = selfNowPartsV2(key);
    if (st) st.selfNowSig = sig;
    return `【你现在】（几个窗口和电脑那边看到的都是这一份，说话要对得上；心情只影响语气）\n${lines.join('\n')}\n\n`;
  }
  // 等待期间状态变了（睡了/醒了、开始或停止玩、心情、别处的窗口）：在等待结果里给她一份新的
  function selfNowChangedV2(key, st) {
    if (!st) return null;
    const { lines, sig } = selfNowPartsV2(key);
    if (st.selfNowSig === sig) return null;
    st.selfNowSig = sig;
    return lines.join('\n');
  }

  return {
    exports: {
      MOOD_STALE_MS,
      minutesAgoTextV2,
      selfNowBlockV2,
      selfNowChangedV2,
      selfNowPartsV2,
    },
    link() {
      ({
        FREE_TIME_REASONS, PLAY_LAST_ITEM_MS, convLabelV2, crossSessionCountOnlyV2,
        crossSessionSummaryOnlyV2, whenV2, isConversationBusyV2, lifeLinesV2, moodEngineCfgV2,
        nightCfgOkV2, playHoldLineV2, playSessionsTextV2, selfClaimsLineV2, selfSleptV2, sleepStateV2, socialV2,
        todayPlaySessionsV2
      } = app);
    },
    start() {},
  };
}
