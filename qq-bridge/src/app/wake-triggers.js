// 什么时候叫醒她：直接叫醒的条件、群聊回复门控、接话
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { moodTalkFactor } from '../inner-life.js';
import { DynamicReplyGate, talkValueFor } from '../reply-gate.js';
import { isStickerMedia } from '../qq-model-view.js';

export function createWakeTriggers(app) {
  const {
    cfg, log, shouldBlockSilentReply
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let getSocialV2State, isConversationBusyV2, isNightSleepV2, isOutsideGroupKeyV2, moodEngineCfgV2, quietLeftV2,
    readThroughSeqV2, saveSocialV2State, scheduleWakeV2, socialV2;

  // 哪些消息直接叫醒她：私聊每条都叫；群里只有找她的（@/引用/叫名字或外号）、她指定的人、任意消息、
  // 她刚接了话的人接着说（talkBack）。别的群消息交给回复门控（armReplyGateV2）决定叫不叫。
  function evaluateWakeTriggerV2(st, event, kind, plainContent, quoteTargetIsSelf, key = `group:${event?.group_id ?? ''}`) {
    if (kind === 'private') return 'private';
    const reason = wakeTriggerReasonV2(key, st, event, plainContent, quoteTargetIsSelf);
    // 谁把她叫来的：接话（talkBack）在家里以外的群只认她直接在跟谁说
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (reason && speakerId) st.wakeBy = { userId: speakerId, at: Date.now() };
    return reason;
  }
  function wakeTriggerReasonV2(key, st, event, plainContent, quoteTargetIsSelf) {
    const tr = st.wakeConfig?.triggers ?? {};
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (tr.atMention && (atSelf || quoteTargetIsSelf)) return 'atMention';
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    // 群里别的机器人：只有 @/引用她才叫（它讲总结、复读时带到她的名字不算，也不按接话叫，免得两个机器人对聊）
    if (otherBotV2(speakerId)) return null;
    // 用 plainContent（当前消息自己的文字）：引用一条恰好提到她昵称的旧消息不算叫了名字
    if (tr.nameMention && mentionsSelfNameV2(plainContent)) return 'nameMention';
    if (tr.anyMessage) return 'anyMessage';
    if (speakerId && Array.isArray(tr.speakerIds) && tr.speakerIds.some((id) => String(id) === speakerId)) {
      return `speaker:${event?.sender?.card || event?.sender?.nickname || speakerId}`;
    }
    if (addressedGroupV2(key) && !toSomeoneElseV2(st, event, quoteTargetIsSelf)) {
      // 她正在等待的话，等待工具据此提前返回（waitAddressedV2）
      for (const m of [st.recentMessages?.at(-1), (st.unread || []).at(-1)]) if (m && !m.isSelf) m.addressed = true;
      return 'addressed';
    }
    if (talkBackV2(key, st, event, quoteTargetIsSelf)) return 'talkBack';
    return null;
  }
  // qqbot_agent：socialV2.wake.addressedGroups，这些群里大家说的话默认都是跟她说的，每条都叫她（3 秒合并）。
  // 2026-10-26 主人：“小群里默认都是叫她的，除非明确不是”。以前小群走回复门控（talkValue 0.8）加接话，
  // 阿明隔了几分钟回她、或者开个新话头没带她名字，常常叫不到她。
  // 明确不是对她说的照旧走门控：@ 了别人、引用别人的话、开头叫着别人（最近说过话的人的群名片/昵称）、别的机器人。
  function addressedGroupV2(key) {
    const list = cfg.socialV2?.wake?.addressedGroups;
    return Array.isArray(list) && list.some((k) => String(k) === String(key));
  }
  function toSomeoneElseV2(st, event, quoteTargetIsSelf) {
    const selfId = String(event?.self_id ?? '');
    const segs = Array.isArray(event?.message) ? event.message : [];
    if (segs.some((seg) => seg?.type === 'at' && String(seg.data?.qq) !== selfId && String(seg.data?.qq) !== 'all')) return true;
    if (!quoteTargetIsSelf && segs.some((seg) => seg?.type === 'reply')) return true;
    const own = ownTextV2(event).trim().toLowerCase();
    if (!own) return false;
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    for (const m of recent.slice(-50)) {
      if (!m || m.isSelf || !m.userId || String(m.userId) === speakerId) continue;
      const name = String(m.sender ?? '').trim().toLowerCase();
      if (name.length >= 2 && own.startsWith(name)) return true;
    }
    return false;
  }
  // qqbot_agent：socialV2.wake.otherBots，群里别的机器人的 QQ 号（2026-10-24 大群的小A 4000000009）
  function otherBotV2(userId) {
    const list = cfg.socialV2?.wake?.otherBots;
    return !!userId && Array.isArray(list) && list.some((id) => String(id) === String(userId));
  }
  // qqbot_agent：socialV2.replyOnlyGroups，这些群里她只在有人找她时说话（2026-10-24 主人：技术群和大群都不要主动说话）：
  // 回复门控不叫她、主动找人不找、自由时间不往这里分享（有人托的除外）。@/引用/叫名字/拍一拍/接话照旧。
  function replyOnlyGroupV2(key) {
    const list = cfg.socialV2?.replyOnlyGroups;
    return Array.isArray(list) && list.some((k) => String(k) === String(key));
  }
  // 她把概率、关键词、提问都关了（也没开任意消息、指定成员），就是不想被门控叫来看
  function softTriggersOnV2(st) {
    const tr = st.wakeConfig?.triggers ?? {};
    return Number(tr.probability) > 0 || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || !!tr.question
      || !!tr.anyMessage || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
  }
  // qqbot_agent：群聊回复门控（socialV2.replyGate，思路和权重来自 MaiBot 的 turn_trigger，见 src/reply-gate.js）。
  // 只管群，私聊每条都叫：
  //   · @/引用/叫名字或外号、指定成员、任意消息、接话、主人夜里叫她：直接叫醒（记一次“强制唤醒”）；
  //   · 别的消息不按她设的概率/关键词/提问直接叫：一批消息（quietMs 内没人再说）收齐后，
  //     按逻辑回归估计“她看了会回”的概率，再由一小时窗口的动态阈值决定叫不叫，让回复次数贴近 talkValue × 预计数；
  //   · 被门控叫来看了没说话，连着几次就退避（idleBackoff），新消息攒够 bypassPending 条不退避；
  //   · 一轮里的普通等待最多 groupWaitMaxMs，只有被叫到或门控觉得该回时提前返回。
  // 日志 grep 回复门控。
  function replyGateCfgV2() {
    const c = cfg.socialV2?.replyGate ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    const ib = c.idleBackoff ?? {};
    return {
      quietMs: Math.max(500, num(c.quietMs, 3000)),
      batchMaxAgeMs: Math.max(60000, num(c.batchMaxAgeMs, 15 * 60000)),
      groupWaitMaxMs: Math.max(5000, num(c.groupWaitMaxMs, 30000)),
      idleBaseMs: Math.max(0, num(ib.baseMs, 60000)),
      idleCapMs: Math.max(0, num(ib.capMs, 600000)),
      idleStartCount: Math.max(1, num(ib.startCount, 2)),
      idleBypassPending: Math.max(0, num(ib.bypassPending, 8)),
      talkValue: c.talkValue ?? {},
      talkSchedule: Array.isArray(c.talkSchedule) ? c.talkSchedule : [],
    };
  }
  function replyGateOnV2(key) {
    return /^group:\d+$/.test(String(key));
  }
  function replyGateOfV2(key) {
    let g = socialV2.replyGates[key];
    if (!(g instanceof DynamicReplyGate)) g = socialV2.replyGates[key] = new DynamicReplyGate();
    return g;
  }
  function talkValueOfV2(key) {
    if (replyOnlyGroupV2(key)) return 0;
    const c = replyGateCfgV2();
    const base = talkValueFor(key, { talkValue: c.talkValue, talkSchedule: c.talkSchedule }, { home: !isOutsideGroupKeyV2(key) });
    // qqbot_agent：开心、来劲时多说点，蔫了、不高兴时少说点（moodEngine.coupleTalk，×0.7~1.3）
    const me = moodEngineCfgV2();
    if (!me.enabled || !me.coupleTalk) return base;
    return Math.min(1, base * moodTalkFactor(socialV2.mood, Date.now(), me.halfLifeMinutes));
  }
  function keywordHitV2(keywords, plain) {
    if (!Array.isArray(keywords) || !keywords.length) return '';
    const lower = String(plain ?? '').toLowerCase();
    for (const kw of keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return String(kw);
      } else if (lower.includes(kwStr)) {
        return String(kw);
      }
    }
    return '';
  }
  // 还没给她看过的别人的消息（门控按这一批算）。太久以前的不算，免得几个小时前的话把条数撑大。
  function gatePendingV2(st, baseline = readThroughSeqV2(st), now = Date.now()) {
    const c = replyGateCfgV2();
    const kws = st.wakeConfig?.triggers?.keywords;
    return (st.unread || [])
      .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline && now - Number(m.time || 0) < c.batchMaxAgeMs)
      .map((m) => ({
        id: m.messageId || `seq${m.seq}@${m.time}`,
        text: String(m.plain ?? m.text ?? ''),
        atSelf: !!m.atSelf,
        // MaiBot 的 mention_bot 在这里只会是“说到她感兴趣的东西”：@/叫名字已经走强制唤醒了
        mentionsSelf: !!keywordHitV2(kws, m.plain),
      }));
  }
  function gateRecentV2(st) {
    return (Array.isArray(st.recentMessages) ? st.recentMessages : []).map((m) => ({ time: Number(m?.time) || 0, isSelf: !!m?.isSelf }));
  }
  function gateLogLineV2(d, n) {
    return `p=${d.probability.toFixed(3)} 阈值=${d.threshold.toFixed(3)} 保留=${d.keep.toFixed(2)} 预计=${d.expected.toFixed(1)} 目标=${d.target.toFixed(1)} 实际=${d.actual}（${n} 条）`;
  }
  // 强制唤醒（@/引用/叫名字…）：这批消息记一次 0.91，退避清零
  function gateForcedV2(key, st) {
    if (!replyGateOnV2(key)) return;
    replyGateOfV2(key).recordForcedBatch(gatePendingV2(st), Date.now());
    // 反正要叫她了，排着的门控检查撤掉（这一轮结束后 gateTurnEndedV2 会再看剩下的）
    if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; }
    st.gateIdleCount = 0;
    st.gateIdleUntil = 0;
  }
  // qqbot_agent：她刚接了谁的话，那个人接着说（replyGate.talkBack）。
  // 2026-10-23 技术群：她回完阿明“你要拿它来玩吗？”，阿明答“算了，有点复杂”，她没被叫回来——
  // 两次叫名字已经把一小时的额度（talkValue 0.15）用完，门控阈值是 1，接她话的也过不去。
  // 规则（“在聊着”）：她最后一次（不算自由时间那边）发言 windowMinutes 内，发言前她看过的最近 partners 位说话人
  // 又说话、且没 @ 别人，就叫醒她（3 秒合并，她正忙就回合结束后补发）。每句都算，话能一直接下去；
  // 被这样叫来她没开口（觉得不是冲她来的、话说完了），就不再叫，等她下次说话再算。
  // 2026-10-23 第一版每次发言只叫一次：一位群友 连着说“你这BOT怎么只会玩”“快乐教育是吧”，第二句就没人叫她了。
  // 2026-10-24 收紧（主人：“很多时候突然插出来说话有点尬，特别是大群里大家约着打游戏”）。
  // 那两天大群 1500 条里她占两成，接话是大头（日志里 20 次，门控 4 次、叫名字 8 次）：她回了 A，
  // A 转头跟别人约“下午锁和战号”、发图，也算接她的话。第一版家里以外的群只认她直接在跟谁说（引用/@ 的、把她叫来的、
  // 她开口前最后说话的），主人嫌太紧（“可以插话，但是明显和她没关系、她说了也没用的就别加入”），现在：
  // 所有群：
  //   · 只发图/表情的、引用别人的、@ 别人的不算接话；
  //   · 约游戏、喊人上号的话（talkBack.gameWords，默认见 GAME_WORDS，[] 关）不算：那是在喊大家，不是在回她；
  // 家里以外的群（outside，默认开）再加：
  //   · 她说完以后已经有 outside.crowdOthers（默认 3）个别人说过话，就是大家在自己聊了，不叫；
  //   · 这个人在她说完以后已经说过、别人接了他、他又说（sideTalk），是在跟那个人你来我往，不叫；
  //   · 谁算她在聊着的人照旧（她开口前看过的最近 3 位），再加上她引用/@ 的人和把她叫来的人；
  //   · outside.direct:true 回到第一版：只认她直接在跟谁说，窗口 outside.windowMinutes（direct 时默认 3 分钟），
  //     插进来 crowdOthers（direct 时默认 2）个人就不叫。
  // 离线按 10-22~10-24 的记录算（会叫她的消息条数，旧 / 第一版 / 现在）：大群 277/130/168、技术群 292/138/176，小群 138/127/127。
  // 2026-10-25 加了两条时间窗：
  //   · 她最后那段话像在问人（questionMinutes，默认 15），她直接在跟着说的人（引用/@ 的、把她叫来的、她开口前最后说话的）
  //     15 分钟内说话都算接话。那天 08:53 她在小群问阿明“你昨晚到底几点睡的”，阿明 5 分 22 秒后回“我给你说了呀”
  //     “你忘了”，过了 5 分钟、门控也没叫，她 12:36 来分享 2048 时才看到，又追问了一遍；
  //   · byKey 单独设时间窗，windowMinutes 填负数是不限（主人：“小群你改成无限长时间得了”）：她下次说话前，
  //     她聊着的人什么时候说话都叫她。被接话叫来她没开口就不再叫，这一条照旧。
  const QUESTION_RE = /[?？]|吗|呢|嘛|几点|几个|几天|多久|多少|什么|啥|怎么|咋|为什么|为啥|哪|谁|是不是|有没有|要不要|会不会|能不能|可不可以|对不对|好不好|行不行/;
  const GAME_WORDS = ['上号', '开黑', '开一把', '来一把', '打一把', '来几把', '排位', '组队', '车队', '上车', '三缺一', '四缺一',
    '五缺一', '缺一个', '来不来', '打不打', '几点打', '几点开', '什么时候战', '几点战', '速来', '进房', '房间号', '拉我', '带我',
    '等我一下', '开了没', '集合', '上线没', '开麦', '🔒'];
  function talkBackCfgV2(key) {
    const c = cfg.socialV2?.replyGate?.talkBack ?? {};
    const o = c.outside ?? {};
    const k = key && c.byKey && typeof c.byKey === 'object' ? c.byKey[key] ?? null : null;
    const direct = o.direct === true;
    const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
    // 分钟 → 毫秒；负数是不限
    const ms = (minutes) => (minutes < 0 ? Infinity : minutes * 60000);
    const windowMinutes = num(k?.windowMinutes, Math.max(0, num(c.windowMinutes, 5)));
    return {
      enabled: c.enabled !== false && k?.enabled !== false,
      windowMs: ms(windowMinutes),
      questionMs: ms(num(k?.questionMinutes, num(c.questionMinutes, 15))),
      partners: Math.max(1, num(c.partners, 3)),
      skipMedia: c.skipMedia !== false,
      gameWords: Array.isArray(c.gameWords) ? c.gameWords.map((w) => String(w ?? '').trim().toLowerCase()).filter(Boolean) : (c.gameWords === false ? [] : GAME_WORDS),
      outside: o.enabled !== false,
      direct,
      outsideWindowMs: k?.windowMinutes !== undefined ? ms(windowMinutes) : ms(Math.max(0, num(o.windowMinutes, direct ? 3 : windowMinutes))),
      crowdOthers: Math.max(0, num(o.crowdOthers, direct ? 2 : 3)),
      sideTalk: o.sideTalk !== false,
    };
  }
  // 这条消息有没有自己的字（只有图片、表情、@、引用的不算）
  function hasOwnTextV2(event) {
    if (!Array.isArray(event?.message)) return true;
    return event.message.some((seg) => seg?.type === 'text' && String(seg.data?.text ?? '').trim());
  }
  function ownTextV2(event) {
    if (!Array.isArray(event?.message)) return String(event?.raw_message ?? '');
    return event.message.filter((seg) => seg?.type === 'text').map((seg) => String(seg.data?.text ?? '')).join('');
  }
  // 只发了表情（表情包、QQ 小表情），没有字也没有照片截图
  function stickerOnlyV2(event) {
    if (!Array.isArray(event?.message) || hasOwnTextV2(event)) return false;
    const segs = event.message.filter((seg) => seg && seg.type !== 'at' && seg.type !== 'reply' && seg.type !== 'text');
    return segs.length > 0 && segs.every((seg) => {
      if (seg.type === 'mface' || seg.type === 'face') return true;
      if (seg.type !== 'image') return false;
      const d = seg.data ?? {};
      return isStickerMedia({ kind: 'image', subType: d.sub_type ?? d.subType, emojiId: d.emoji_id ?? d.emojiId, summary: d.summary });
    });
  }
  // 接话叫来她没开口时，她看过、没接的是谁的话（talkBackDeclined.ids）；旧的 talkBackDeclinedFor 当所有人都不接
  function talkBackDeclinedV2(st, lastAt) {
    const d = st.talkBackDeclined;
    if (d && Number(d.for) === lastAt) return Array.isArray(d.ids) && d.ids.length ? new Set(d.ids.map(String)) : 'all';
    return Number(st.talkBackDeclinedFor) === lastAt ? 'all' : null;
  }
  // 她最后一次自己开口的时间（自由时间那边发的不算）
  function lastSelfSpeechAtV2(st) {
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    for (let i = recent.length - 1; i >= 0; i--) if (recent[i]?.isSelf && !recent[i]?.byPlay) return Number(recent[i].time) || 0;
    return 0;
  }
  function talkBackV2(key, st, event, quoteTargetIsSelf = false) {
    const c = talkBackCfgV2(key);
    if (!c.enabled) return false;
    const outside = c.outside && isOutsideGroupKeyV2(key);
    const strict = outside && c.direct;
    const windowMs = outside ? c.outsideWindowMs : c.windowMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (!speakerId || !windowMs) return false;
    const selfId = String(event?.self_id ?? '');
    const segs = Array.isArray(event?.message) ? event.message : [];
    if (segs.some((seg) => seg?.type === 'at' && String(seg.data?.qq) !== selfId)) return false;
    // 引用的是别人的话：在跟那个人说
    if (!quoteTargetIsSelf && segs.some((seg) => seg?.type === 'reply')) return false;
    // 只发图的不算；只发表情的，是她直接在跟着说的人才算（下面再看）
    const stickerOnly = c.skipMedia && !hasOwnTextV2(event) && stickerOnlyV2(event);
    if (c.skipMedia && !hasOwnTextV2(event) && !stickerOnly) return false;
    if (c.gameWords.length) {
      const own = ownTextV2(event).toLowerCase();
      if (c.gameWords.some((w) => own.includes(w))) return false;
    }
    let last = -1;
    for (let i = recent.length - 1; i >= 0; i--) if (recent[i]?.isSelf && !recent[i]?.byPlay) { last = i; break; }
    if (last < 0) return false;
    const lastAt = Number(recent[last].time) || 0;
    if (!lastAt) return false;
    const declined = talkBackDeclinedV2(st, lastAt);
    if (declined === 'all' || declined?.has(speakerId)) return false;
    let first = last;
    while (first > 0 && recent[first - 1]?.isSelf) first--;
    const seenThrough = readThroughSeqV2(st);
    // 只发表情、或者这段话她已经有一回没接：只认她直接在跟着说的人
    if ((stickerOnly || declined) && !directPartnersV2(st, recent, first, last, seenThrough).has(speakerId)) return false;
    const elapsed = Date.now() - lastAt;
    if (elapsed > windowMs) {
      // 过了时间窗：她问了人，被问的人在 questionMinutes 内回话还算
      if (elapsed > c.questionMs || !directPartnersV2(st, recent, first, last, seenThrough).has(speakerId)) return false;
      if (!recent.slice(first, last + 1).some((m) => QUESTION_RE.test(String(m?.plain ?? m?.text ?? '')))) return false;
    }
    const partners = outside || elapsed > windowMs ? directPartnersV2(st, recent, first, last, seenThrough) : new Set();
    if (!strict) {
      const near = new Set();
      for (let i = first - 1; i >= 0 && near.size < c.partners; i--) {
        const m = recent[i];
        if (!m || m.isSelf || !m.userId) continue;
        if (lastAt - (Number(m.time) || 0) > 10 * 60000) break;
        if (Number.isSafeInteger(m.seq) && m.seq > seenThrough) continue;
        near.add(String(m.userId));
      }
      for (const id of near) partners.add(id);
    }
    if (!partners.has(speakerId)) return false;
    if (outside) {
      // 她说完以后说过话的别人（别的机器人不算；第一版连她在跟着说的人也不算）
      const others = new Set();
      let spoke = false;
      let sideTalk = false;
      for (let i = last + 1; i < recent.length; i++) {
        const m = recent[i];
        if (!m || m.isSelf || !m.userId || otherBotV2(m.userId)) continue;
        const id = String(m.userId);
        if (id === speakerId) { spoke = true; continue; }
        if (spoke) sideTalk = true;
        if (!strict || !partners.has(id)) others.add(id);
      }
      if (c.crowdOthers > 0 && others.size >= c.crowdOthers) return false;
      if (!strict && c.sideTalk && sideTalk) return false;
    }
    // 她正在等待的话，等待工具据此提前返回（waitAddressedV2）
    for (const m of [recent.at(-1), (st.unread || []).at(-1)]) if (m && !m.isSelf) m.talkBack = true;
    return true;
  }
  // 她最后这段话（recent[first..last]）直接在跟谁说：引用/@ 了谁就是谁；都没有就是把她叫来的人（10 分钟内）
  // 和她开口前最后一个她看过的说话人
  function directPartnersV2(st, recent, first, last, seenThrough) {
    const partners = new Set();
    for (let i = first; i <= last; i++) for (const id of recent[i]?.toUserIds ?? []) if (id) partners.add(String(id));
    if (partners.size) return partners;
    const firstAt = Number(recent[first]?.time) || 0;
    const wb = st.wakeBy;
    if (wb?.userId && firstAt - Number(wb.at || 0) <= 10 * 60000 && Number(wb.at || 0) <= firstAt) partners.add(String(wb.userId));
    for (let i = first - 1; i >= 0; i--) {
      const m = recent[i];
      if (!m || m.isSelf || !m.userId) continue;
      if (firstAt - (Number(m.time) || 0) > 10 * 60000) break;
      if (Number.isSafeInteger(m.seq) && m.seq > seenThrough) continue;
      partners.add(String(m.userId));
      break;
    }
    return partners;
  }
  // 她在这个群里真发了话（不算自由时间那边发的）：记一次回复，15 秒内的连着几次工具调用算一次
  function gateRecordReplyV2(key, st) {
    if (!replyGateOnV2(key)) return;
    const now = Date.now();
    st.gateIdleCount = 0;
    st.gateIdleUntil = 0;
    if (now - (Number(st.gateLastReplyAt) || 0) < 15000) return;
    st.gateLastReplyAt = now;
    replyGateOfV2(key).recordReply(now);
  }
  function afterSentV2(key) {
    const st = getSocialV2State(key);
    if (!st.recentMessages.at(-1)?.byPlay) gateRecordReplyV2(key, st);
  }
  // 返回不评估的原因；空串表示可以评估
  function gateBlockedV2(key, st) {
    if (cfg.socialV2?.enabled === false || app.currentMode !== 'reserved2') return '不在二代模式';
    if (socialV2.paused) return '已暂停';
    if (isNightSleepV2()) return '睡觉时间';
    if (shouldBlockSilentReply(key)) return '静默模式';
    if (!softTriggersOnV2(st)) return '她关了概率/关键词这些条件';
    if (isConversationBusyV2(key, st)) return '她正在这个群里';
    return '';
  }
  // 新消息进来（或一轮结束）：quietMs 内没人再说话再评估这一批
  function armReplyGateV2(key, delayMs) {
    if (replyOnlyGroupV2(key)) return;
    const st = getSocialV2State(key);
    if (st.gateTimer) clearTimeout(st.gateTimer);
    // qqbot_agent：replyTiming 开着时按对方的节奏等他说完（reply-timing.js），不再是死的 quietMs
    const delay = delayMs ?? quietLeftV2(key, st) ?? replyGateCfgV2().quietMs;
    st.gateTimer = setTimeout(() => { st.gateTimer = null; evaluateReplyGateV2(key); }, Math.max(200, delay));
    st.gateTimer.unref?.();
  }
  function evaluateReplyGateV2(key) {
    if (!replyGateOnV2(key) || replyOnlyGroupV2(key)) return null;
    const st = getSocialV2State(key);
    const c = replyGateCfgV2();
    const now = Date.now();
    const quietLeft = quietLeftV2(key, st, now) ?? (c.quietMs - (now - (Number(st.lastIncomingAt) || 0)));
    if (quietLeft > 50) { armReplyGateV2(key, quietLeft); return null; }
    const batch = gatePendingV2(st, readThroughSeqV2(st), now);
    if (!batch.length) return null;
    const blocked = gateBlockedV2(key, st);
    if (blocked) { log(`[reserved2] 回复门控：${key} 不评估（${blocked}）`); return null; }
    if (Number(st.gateIdleUntil) > now && !(c.idleBypassPending > 0 && batch.length >= c.idleBypassPending)) {
      log(`[reserved2] 回复门控：${key} 空闲退避中，还有 ${Math.round((st.gateIdleUntil - now) / 1000)}s（${batch.length} 条）`);
      armReplyGateV2(key, st.gateIdleUntil - now + 100);
      return null;
    }
    const d = replyGateOfV2(key).evaluateBatch(batch, gateRecentV2(st), talkValueOfV2(key), now);
    log(`[reserved2] 回复门控：${key} ${d.trigger ? '叫她来看' : '不叫'} talk=${talkValueOfV2(key).toFixed(2)} ${gateLogLineV2(d, batch.length)}`);
    saveSocialV2State();
    if (d.trigger) scheduleWakeV2(key, 'replyGate');
    return d;
  }
  // 门控叫来的一轮结束：没说话就记一次空闲，连着 idleStartCount 次开始退避（base × 2^n，最多 cap）
  function gateTurnEndedV2(key) {
    if (!replyGateOnV2(key)) return;
    const st = getSocialV2State(key);
    const c = replyGateCfgV2();
    // 接话叫来的一轮她没开口：她看过的这几个人的话她不接了，到她下次说话前不再按接话叫这几个人；
    // 她直接在跟着说的人另外说话还叫（2026-10-26 大群：她刚回了阿明，别人插了个“？”把她叫来，她没接，
    // 阿明接着发的表情和“可爱”就都叫不到她了）
    if (st.lastWakeReason === 'talkBack') {
      const wakeAt = Number(st.wakeConfig?.lastWakeAt) || 0;
      if ((Number(st.lastAiReplyAt) || 0) < wakeAt) {
        const lastAt = lastSelfSpeechAtV2(st);
        const seenThrough = readThroughSeqV2(st);
        const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
        const ids = new Set();
        for (let i = recent.length - 1; i >= 0; i--) {
          const m = recent[i];
          if (!m || (m.isSelf && !m.byPlay)) break;
          if (m.isSelf || !m.userId || (Number.isSafeInteger(m.seq) && m.seq > seenThrough)) continue;
          ids.add(String(m.userId));
        }
        const prev = talkBackDeclinedV2(st, lastAt);
        if (prev instanceof Set) for (const id of prev) ids.add(id);
        st.talkBackDeclined = { for: lastAt, ids: prev === 'all' ? [] : [...ids] };
        delete st.talkBackDeclinedFor;
        log(`[reserved2] 回复门控：${key} 接话叫来她没开口，这段话不再按接话叫她（${ids.size && prev !== 'all' ? `${ids.size} 人；她直接在跟着说的人另外说话还叫` : '所有人'}）`);
      }
    }
    if (st.lastWakeReason === 'replyGate') {
      const wakeAt = Number(st.wakeConfig?.lastWakeAt) || 0;
      if ((Number(st.lastAiReplyAt) || 0) < wakeAt) {
        st.gateIdleCount = (Number(st.gateIdleCount) || 0) + 1;
        const n = st.gateIdleCount - c.idleStartCount;
        const ms = n >= 0 && c.idleBaseMs > 0 && c.idleCapMs > 0 ? Math.min(c.idleCapMs, c.idleBaseMs * 2 ** n) : 0;
        st.gateIdleUntil = ms ? Date.now() + ms : 0;
        if (ms) log(`[reserved2] 回复门控：${key} 连续 ${st.gateIdleCount} 次叫来没说话，退避 ${Math.round(ms / 1000)}s`);
      }
    }
    // 这一轮里进来、她没看到的消息：再评估一次
    if (gatePendingV2(st).length) armReplyGateV2(key);
  }

  /** qqbot_agent：等待期间新到的消息（seq > baseline）里有没有人 @/引用/叫她的名字（addressedGroups 里的群：跟她说的话）。 */
  function waitAddressedV2(st, baseline) {
    return [...(st.unread || []), ...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].some((m) => m && !m.isSelf
      && (m.seq || 0) > baseline
      && (m.quoteTargetIsSelf || m.atSelf || m.talkBack || m.addressed || mentionsSelfNameV2(m.plain || m.text)));
  }

  /** qqbot_agent：她的昵称和外号（socialV2.wake.selfAliases），小写去重。 */
  function selfNamesV2() {
    const aliases = Array.isArray(cfg.socialV2?.wake?.selfAliases) ? cfg.socialV2.wake.selfAliases : [];
    return [...new Set([app.selfNickname, ...aliases].map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean))];
  }
  function mentionsSelfNameV2(text) {
    const lower = String(text ?? '').toLowerCase();
    return !!lower && selfNamesV2().some((n) => lower.includes(n));
  }

  return {
    exports: {
      addressedGroupV2,
      afterSentV2,
      armReplyGateV2,
      evaluateReplyGateV2,
      evaluateWakeTriggerV2,
      gateForcedV2,
      gateLogLineV2,
      gatePendingV2,
      gateRecentV2,
      gateRecordReplyV2,
      gateTurnEndedV2,
      mentionsSelfNameV2,
      otherBotV2,
      replyGateCfgV2,
      replyGateOfV2,
      replyGateOnV2,
      replyOnlyGroupV2,
      talkValueOfV2,
      waitAddressedV2,
    },
    link() {
      ({
        getSocialV2State, isConversationBusyV2, isNightSleepV2, isOutsideGroupKeyV2,
        moodEngineCfgV2, quietLeftV2, readThroughSeqV2, saveSocialV2State, scheduleWakeV2, socialV2
      } = app);
    },
    start() {},
  };
}
