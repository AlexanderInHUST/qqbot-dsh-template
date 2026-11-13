// 捎话给别的窗口的自己（qq_tell_myself）、答应了先不玩（playHold）
// 2026-10-26 16:04：主人在私聊让她别玩了，她答应了，可大群那个窗口和电脑那边（play:main）各是各的会话，
// 谁也不知道私聊里说了什么，接着玩。现在私聊、家里的小群里主人让她做的事牵涉到别的窗口时，
// 她用 qq_tell_myself 捎过去：那边正聊着就插一句【捎给自己的话】，不在聊就记着，下次那边被叫醒时写进唤醒提示（不为这个专门叫醒）。
// stopPlay：电脑那边马上收尾，一段时间内不去玩（自由时间检查跳过、qq_go_play 拒、play 不往聊天里分享）。
// 只能从私聊和家里的群发（主人：不要被大群污染了），而且要主人 5 分钟内在那里说过话。
import { truncateText } from '../md-to-plain.js';
import { isHomeChat, noReachOut } from '../privacy-policy.js';
import { defang } from '../qq-model-view.js';
import { SENSITIVE_RE } from '../sensitive.js';

export function createTellMyself(app) {
  const {
    PLAY_KEY, api, appendActivity, canonicalV2Key, cfg, isSessionAllowedInCurrentMode, log, shouldBlockSilentReply
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let bubbleCapV2, computeGapsV2, convLabelV2, getSocialV2State, isConversationBusyV2, isOutsideGroupKeyV2,
    leaveNoteV2, markNotesShownV2, mergeBubblesV2, noteNotesShownV2, notesOfV2, recordSentMessagesV2, saveSocialV2State,
    sendMessagesV2, socialV2, tellWindowV2, turnRunningV2, whenV2;

  const TELL_NOTE_MAX_CHARS = 150;
  const TELL_NOTES_PER_KEY = 3;
  function tellCfgV2() {
    const c = cfg.socialV2?.tellMyself ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      ownerMinutes: Math.max(0, num(c.ownerMinutes, 5)), // 0 = 不要求主人刚说过话
      holdMinutes: Math.min(360, Math.max(10, num(c.holdMinutes, 60))),
      keepMs: Math.max(1, num(c.keepHours, 6)) * 3600 * 1000,
    };
  }
  // 主人 since 以后、ownerMinutes 分钟内在 key 说过话
  function ownerSpokeV2(key, since = 0, now = Date.now()) {
    const recent = socialV2.conversations.get(key)?.recentMessages;
    const windowMs = tellCfgV2().ownerMinutes * 60000;
    return (Array.isArray(recent) ? recent : []).some((m) => m && !m.isSelf && m.isOwner
      && Number(m.time) > since && (!windowMs || now - Number(m.time) < windowMs));
  }
  // 能发的地方：私聊、家里的群（大群、play 都不行）
  function tellSourceOkV2(key) {
    return isHomeChat(cfg, key);
  }
  // 给 to 那边看的“在哪答应的”：家里以外的群只写“别处”
  function tellFromLabelV2(from, to) {
    return isOutsideGroupKeyV2(to) ? '别处' : convLabelV2(from, socialV2.conversations.get(from));
  }

  // ── 答应了先不玩 ─────────────────────────────────────────
  function playHoldV2(now = Date.now()) {
    const h = socialV2.playHold;
    if (!h) return null;
    if (!(Number(h.until) > now)) {
      socialV2.playHold = null;
      saveSocialV2State();
      log('[捎话] 说好先不玩的时间过了');
      return null;
    }
    return h;
  }
  function clearPlayHoldV2(why) {
    if (!socialV2.playHold) return;
    socialV2.playHold = null;
    saveSocialV2State();
    log(`[捎话] 不再拦着去玩：${why}`);
  }
  // 【你现在】里的一行（不写是谁让的、在哪说的）
  function playHoldLineV2(key, now = Date.now()) {
    const h = playHoldV2(now);
    if (!h) return '';
    return key === PLAY_KEY
      ? `- 电脑：你 ${whenV2(h.at)} 答应了先不玩，${whenV2(h.until)} 前别玩了，手上的停下收尾。`
      : `- 电脑：你 ${whenV2(h.at)} 答应了先不玩，${whenV2(h.until)} 前别去电脑上玩，聊天这边也别陪人玩游戏；有人叫你去玩就说晚点再说。`;
  }
  // qq_go_play 被拦的理由；null = 可以去。主人在私聊或家里的群、说好以后又说过话（又让她去玩了），就不拦了
  function playHoldBlocksV2(key, now = Date.now()) {
    const h = playHoldV2(now);
    if (!h) return null;
    if (tellSourceOkV2(key) && ownerSpokeV2(key, Number(h.at), now)) {
      clearPlayHoldV2(`主人在 ${key} 又让去玩了`);
      return null;
    }
    return `你 ${whenV2(h.at)} 答应了先不玩，${whenV2(h.until)} 前先别去；跟这边说一声晚点再玩就好，不用说是谁让的`;
  }
  // 电脑那边正在玩：马上收尾
  async function stopPlayNowV2(from, note, now) {
    const st = getSocialV2State(PLAY_KEY);
    for (const r of Array.isArray(st.playRequests) ? st.playRequests : []) if (r && !r.done) r.done = true;
    const ft = st.freeTime;
    if (ft) {
      ft.minUntil = 0; // 不再劝她接着玩
      ft.asked = [];
      ft.curfewSent = true; // 也不再插【可以歇了】【玩了好久了】
      ft.restOfferSent = true;
    }
    saveSocialV2State();
    const sessionId = app.state.sessions?.[PLAY_KEY];
    if (!sessionId || !isConversationBusyV2(PLAY_KEY, st)) return 'idle';
    const markRead = 'qq_mark_read()';
    const text = `【先不玩了】你 ${whenV2(now)} 在${convLabelV2(from, socialV2.conversations.get(from))}答应了先不玩了${note ? `：${defang(note)}` : ''}。手上的马上停下，别再往聊天里发东西（聊天那边的你会跟大家说），关掉多余的标签页，调用 ${markRead}。`;
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
      return accepted?.result?.ok ? 'steered' : 'failed';
    } catch (error) {
      log(`[捎话] 让电脑那边收尾失败：${error?.message ?? error}`);
      return 'failed';
    }
  }

  // ── 捎话 ─────────────────────────────────────────────────
  // 留话存在 socialV2.notes（kind 'tell'，见 jobs.js），每处最多 TELL_NOTES_PER_KEY 条、留 keepHours
  let tellSeq = 0;
  function tellNotesOfV2(key, now = Date.now()) {
    return notesOfV2(key, 'tell', now);
  }
  // 捎给 to：那边正聊着就插一句，插不进去就记着等那边下次被叫醒
  async function deliverTellV2(from, to, note, now) {
    const st = getSocialV2State(to);
    const fromLabel = tellFromLabelV2(from, to);
    const tail = to === PLAY_KEY
      ? '照着做，不用回话。'
      : '照着做。这边要是得跟人说一声，就像自己想起来的那样自然地说，别提是谁让的、在哪答应的，那边聊的内容也别搬过来。';
    if (await tellWindowV2(to, `【捎给自己的话】${to}（令牌 ${st.agentToken}）你 ${whenV2(now)} 在${fromLabel}答应了：${defang(note)}\n${tail}`, '[捎话]')) return 'steered';
    leaveNoteV2('tell', to, { id: `t${(now % 1e8).toString(36)}${(tellSeq++).toString(36)}`, from, note }, now);
    return 'stored';
  }
  // 拼进 key 的唤醒提示
  function tellPromptLineV2(key, now = Date.now()) {
    const list = tellNotesOfV2(key, now);
    noteNotesShownV2(key, 'tell', list.map((n) => n.id));
    if (!list.length) return '';
    const tail = key === PLAY_KEY
      ? '是你自己捎来的，照着做。'
      : '是你自己捎来的，不是这里的人说的。照着做；这里没人提就不用专门说，要跟这里的人说就自然地说，别提是谁让的、在哪答应的。';
    return `【捎给自己的话】你在别的窗口答应了，到这里也要照着做：\n${list.map((n) => `- ${whenV2(n.at)} 在${tellFromLabelV2(n.from, key)}：${defang(n.note)}`).join('\n')}\n${tail}\n\n`;
  }
  function markTellShownV2(key) {
    markNotesShownV2(key, ['tell']);
  }

  // POST /api/socialV2/tell-myself 的主体（令牌、白名单、工具开关在 console-server 里查过了）
  // body: { to: 会话 key | "play:main" | "all", note, stopPlay?, minutes? }
  async function tellMyselfV2(key, body, now = Date.now()) {
    if (!tellSourceOkV2(key)) return { ok: false, status: 403, error: '只能在私聊和家里的小群里用' };
    const c = tellCfgV2();
    if (c.ownerMinutes && !ownerSpokeV2(key, 0, now)) return { ok: false, status: 403, error: '只有主人刚在这里让你做的事才能捎过去' };
    const note = truncateText(String(body?.note ?? '').replace(/\s+/g, ' ').trim(), TELL_NOTE_MAX_CHARS);
    const stopPlay = body?.stopPlay === true || body?.stopPlay === 'true';
    const toRaw = String(body?.to ?? '').trim();
    if (!note && !stopPlay) return { ok: false, status: 400, error: 'note 不能为空：写清楚那边要做什么' };
    if (note && SENSITIVE_RE.test(note)) return { ok: false, status: 403, error: '内容含敏感信息' };
    let targets = [];
    if (toRaw === 'all') {
      targets = [...socialV2.conversations.keys()].filter((k) => k !== key && k !== PLAY_KEY && isSessionAllowedInCurrentMode(k));
    } else if (toRaw) {
      if (toRaw === key) return { ok: false, status: 400, error: 'to 是这里自己；这里的事直接做就好' };
      if (toRaw !== PLAY_KEY && (!/^(private|group):\d+$/.test(toRaw) || !isSessionAllowedInCurrentMode(toRaw) || !socialV2.conversations.has(toRaw))) {
        return { ok: false, status: 400, error: 'to 要填你待过的聊天的 key（比如 group:123）、"play:main" 或 "all"' };
      }
      if (toRaw === PLAY_KEY && stopPlay) targets = []; // 叫停就够了，不用另外记
      else targets = [toRaw];
    } else if (!stopPlay) {
      return { ok: false, status: 400, error: 'to 不能为空' };
    }
    const result = { ok: true };
    const parts = [];
    if (stopPlay) {
      const minutes = Number(body?.minutes) > 0 ? Math.min(360, Math.max(10, Math.round(Number(body.minutes)))) : c.holdMinutes;
      const until = Math.max(Number(socialV2.playHold?.until) || 0, now + minutes * 60000);
      socialV2.playHold = { from: key, at: now, until, ...(note ? { note } : {}) };
      saveSocialV2State();
      const play = await stopPlayNowV2(key, note, now);
      result.stopPlay = { until: whenV2(until), play };
      parts.push(`${play === 'steered' ? '电脑那边已经让你停下收尾了' : play === 'failed' ? '电脑那边没插上话，不过到点就不会再劝你玩' : '电脑那边本来就没在玩'}；${whenV2(until)} 前不会去玩，有人托你去玩也会被拦下`);
      log(`[捎话] ${key} 答应了先不玩，到 ${whenV2(until)}（电脑那边：${play}）${note ? `：${note}` : ''}`);
    }
    if (note && targets.length) {
      const delivered = {};
      for (const to of targets) delivered[to] = await deliverTellV2(key, to, note, now);
      result.delivered = delivered;
      const steered = targets.filter((k) => delivered[k] === 'steered');
      const stored = targets.filter((k) => delivered[k] === 'stored');
      if (steered.length) parts.push(`${steered.join('、')} 正聊着，已经插了一句`);
      if (stored.length) parts.push(`${stored.join('、')} 下次被叫醒时会看到`);
      log(`[捎话] ${key} → ${targets.map((k) => `${k}(${delivered[k]})`).join(' ')}：${note}`);
    }
    result.hint = `捎过去了：${parts.join('；') || '没有要捎的'}。这边跟对方说一声“好”就行，不用讲你怎么办到的。`;
    return result;
  }

  // ── 替这里去别的窗口说句话（qq_send_elsewhere） ──────────────────
  // 2026-10-27：爸爸在私聊让她跟妈妈说晚安，她拿私聊的令牌往小群发，被“agent token 无效”挡回来，
  // 回头跟爸爸说“我喊啦，她没应我”（10-22 17:22 也这样往小群发过一次）。qq_tell_myself 只是记给那边的自己（不叫醒、6 小时就过期），她又快睡了，
  // 这种“现在就去那边说一句”的事没有工具能做。现在主人刚在这里说过话，就能直接发到私聊和家里的小群；
  // 那边的会话下次看消息时在 yourPlaySelfSent 里看到一次（和自由时间那边发进聊天的一样，记成 byPlay，
  // 不算那边自己开口：不触发接话、不算门控回复）。家里以外的群不行（主人：不要被大群污染了），那边用 qq_tell_myself。
  const sendElsewhereTimes = [];
  function sendElsewhereCfgV2() {
    const c = cfg.socialV2?.sendElsewhere ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return { maxPerHour: Math.max(0, num(c.maxPerHour, 6)) }; // 0 = 不限
  }
  // POST /api/socialV2/send-elsewhere 的主体（来源的令牌、工具开关在 console-server 里查过了）
  // body: { to, messages: string | string[], atUserId? }
  async function sendElsewhereV2(key, body, now = Date.now()) {
    if (!tellSourceOkV2(key)) return { ok: false, status: 403, error: '只能在私聊和家里的小群里用' };
    if (tellCfgV2().ownerMinutes && !ownerSpokeV2(key, 0, now)) {
      return { ok: false, status: 403, error: '只有主人刚在这里让你去那边说的才能发；没发出去，跟这边照实说就好' };
    }
    const to = canonicalV2Key(String(body?.to ?? '').trim()) ?? String(body?.to ?? '').trim();
    const m = /^(private|group):(\d+)$/.exec(to);
    if (!m) return { ok: false, status: 400, error: 'to 要填那个聊天的 key，比如 "group:123" 或 "private:456"' };
    if (to === key) return { ok: false, status: 400, error: 'to 是这里自己；这里的话用 qq_send_message 说' };
    if (isOutsideGroupKeyV2(to)) {
      return { ok: false, status: 403, error: '只能发到私聊和家里的小群；要那个群里的你跟大家说一声，用 qq_tell_myself 捎过去' };
    }
    if (!isSessionAllowedInCurrentMode(to)) return { ok: false, status: 403, error: '那个聊天不在能说话的范围里，没发出去' };
    if (noReachOut(cfg, to)) return { ok: false, status: 403, error: '那边你不主动去找，没发出去；要跟那个人说，就去家里的小群说，或者等他来找你' };
    if (shouldBlockSilentReply(to)) return { ok: false, status: 403, error: '现在不能往那边发（静默模式），没发出去' };
    const raw = Array.isArray(body?.messages) ? body.messages : [body?.messages];
    const asked = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!asked.length) return { ok: false, status: 400, error: 'messages 不能为空：写你要在那边说的话' };
    const atUserId = body?.atUserId !== undefined && body?.atUserId !== null && String(body.atUserId).trim() !== '' ? String(body.atUserId).trim() : null;
    if (atUserId && (m[1] === 'private' || !/^\d+$/.test(atUserId))) return { ok: false, status: 400, error: m[1] === 'private' ? '私聊不需要 @' : 'atUserId 要填 QQ 号' };
    const messages = mergeBubblesV2(asked, bubbleCapV2(to));
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    for (const msg of messages) {
      if (msg.length > maxChars) return { ok: false, status: 400, error: `单条消息不能超过 ${maxChars} 字` };
      if (SENSITIVE_RE.test(msg)) return { ok: false, status: 403, error: '消息含敏感信息，已阻止发送' };
    }
    const c = sendElsewhereCfgV2();
    while (sendElsewhereTimes.length && now - sendElsewhereTimes[0] >= 3600000) sendElsewhereTimes.shift();
    if (c.maxPerHour && sendElsewhereTimes.length >= c.maxPerHour) {
      return { ok: false, status: 429, error: '这一小时往别处发得太多了，先不发了；没发出去，跟这边照实说' };
    }
    sendElsewhereTimes.push(now);
    const st = getSocialV2State(to);
    const fromLabel = convLabelV2(key, socialV2.conversations.get(key));
    const record = (list) => recordSentMessagesV2(to, list, { byPlay: true, relayFrom: key, relayFromLabel: fromLabel, toUserIds: atUserId ? [atUserId] : [] });
    const delays = computeGapsV2(messages, 'auto', 0, [], sendCfg);
    try {
      const sent = await sendMessagesV2(to, messages, delays, null, atUserId);
      if (sent.length) record(sent);
      st.lastActionAt = now;
      saveSocialV2State();
      const notSent = Array.isArray(sent.notSent) ? sent.notSent : [];
      log(`[跨窗口] ${key} → ${to}：发了 ${sent.length}/${messages.length} 条${notSent.length ? '（那边有人插话，后面的没发）' : ''}：${sent.join(' / ').slice(0, 120)}`);
      appendActivity(`${key} → ${to} [跨窗口] 发了 ${sent.length}/${messages.length} 条`);
      const merged = asked.length > messages.length ? `你写了 ${asked.length} 条，那边一次最多 ${messages.length} 条，多的并进最后一条了。` : '';
      return {
        ok: true, to, sent: sent.length,
        ...(notSent.length ? { notSent, interrupted: true } : {}),
        hint: notSent.length
          ? `${to} 那边发了前 ${sent.length} 条，正好有人说话，后面 ${notSent.length} 条（notSent）没发。跟这边说的时候照实说发了哪些。`
          : `已经在 ${to} 说了。${merged}那边的你下次看消息时会知道这几句是你从这里发的。跟这边说一声就好，不用讲你怎么办到的；那边有人回话，是那边的你去接。`,
      };
    } catch (error) {
      if (error?.sent?.length) record(error.sent);
      if (!error?.sent?.length) {
        const i = sendElsewhereTimes.lastIndexOf(now);
        if (i >= 0) sendElsewhereTimes.splice(i, 1);
      }
      saveSocialV2State();
      log(`[跨窗口] ${key} → ${to} 发送失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `${error?.message ?? error}跟这边照实说没发出去（或只发了一部分），别说已经发了。` };
    }
  }

  return {
    exports: {
      clearPlayHoldV2,
      markTellShownV2,
      playHoldBlocksV2,
      playHoldLineV2,
      playHoldV2,
      sendElsewhereV2,
      tellMyselfV2,
      tellNotesOfV2,
      tellPromptLineV2,
      tellSourceOkV2,
    },
    link() {
      ({
        bubbleCapV2, computeGapsV2, convLabelV2, getSocialV2State, isConversationBusyV2, isOutsideGroupKeyV2,
        leaveNoteV2, markNotesShownV2, mergeBubblesV2, noteNotesShownV2, notesOfV2, recordSentMessagesV2, saveSocialV2State,
        sendMessagesV2, socialV2, tellWindowV2, turnRunningV2, whenV2
      } = app);
      app.defineNoteKindV2('tell', { keepMs: () => tellCfgV2().keepMs, perTarget: TELL_NOTES_PER_KEY });
    },
    start() {},
  };
}
