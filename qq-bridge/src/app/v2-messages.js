// 二代消息记录：收消息、她发的话、已读水位、唤醒快照、工具日志
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import fs from 'node:fs';
import { sanitizeForwardId } from '../forward.js';
import { markInitiateAnswered } from '../inner-life.js';
import { truncateText, truncateTextTail } from '../md-to-plain.js';
import { compactModelMessage, isStickerMedia } from '../qq-model-view.js';

export function createV2Messages(app) {
  const {
    FEEDBACK_FILE, PLAY_KEY, TOOL_LOG_FILE, atomicWriteJson, cfg, createCappedLogger, log,
    ownerLabelFor, readJsonSafe, redactKnownTokensOnly, redactSensitiveText, sanitizeMediaSummary
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let extrasPostV2, getSocialV2State, whenV2, initiateCfgV2, mentionsSelfNameV2, noteReminderWaitV2,
    ownStickerTextV2, queueSelfCheckV2, saveSocialV2State, seenForwardIds, socialV2, v2ToolEnabled;

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      if (kind !== 'face' && isStickerMedia(item)) {
        const own = ownStickerTextV2(item);
        if (own) item.inYourStickers = own;
      }
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? ownerLabelFor(cfg, userId, key) : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    // qqbot_agent：她主动找过这里，有人接话了
    const ic = initiateCfgV2();
    if (ic.enabled) {
      const answered = markInitiateAnswered(socialV2.life.initiates, key, Date.now(), ic);
      if (answered) log(`[主动找人] ${key}：有人回了（${answered.thought}）`);
    }
    // qqbot_agent：她在等这个人说这句话（qq_remind_me 的 waitFor）
    if ((socialV2.reminders || []).some((r) => r.wait && !r.firedAt)) noteReminderWaitV2(key, msg);
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? ownerLabelFor(cfg, userId, key) : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  // qqbot_agent：自由时间会话（play:main）用自己的令牌发到聊天里的东西记成 byPlay。聊天会话的等待只看
  // 别人的消息，以前完全看不到“去玩的自己”刚在同一个群里说了什么，会把同一件事再讲一遍或者说反
  // （2026-10-22 大群：play 已经发完看视频的感想，聊天那边还在说“还没看完”）。等待结果和唤醒快照里
  // 用 yourPlaySelfSent 交给聊天会话，交过一次就标 shownToChat，不再重复给。
  const PLAY_SENT_WINDOW_MS = 30 * 60 * 1000;
  const PLAY_SENT_HINT = 'yourPlaySelfSent 是自由时间那边的你刚刚发到这里的，大家已经看到了：接着它往下聊，别再讲一遍，也别说得和它矛盾。';
  function selfSenderFieldsV2(byPlay) {
    return byPlay ? { sender: '我（自由时间那边的我发的）', byPlay: true } : { sender: '我' };
  }
  function unseenPlaySentV2(st) {
    const after = Date.now() - PLAY_SENT_WINDOW_MS;
    return (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && m.byPlay && !m.shownToChat && Number(m.time) > after);
  }
  function playSentViewV2(list) {
    return list.slice(-12).map((m) => ({ text: m.text, time: m.time }));
  }
  function markPlaySentShownV2(list) {
    if (!list?.length) return;
    for (const m of list) m.shownToChat = true;
    saveSocialV2State();
  }

  function recordSentMessagesV2(key, messages, opts = {}) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        ...selfSenderFieldsV2(opts.byPlay),
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000,
        // 这句话引用/@ 了谁（接话 talkBack 在家里以外的群只认她直接在跟谁说）
        ...(Array.isArray(opts.toUserIds) && opts.toUserIds.length ? { toUserIds: opts.toUserIds.map(String) } : {})
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    reportToldV2(key, list);
    queueSelfCheckV2(key, list);
    // qqbot_agent：主动找人叫醒的这一轮，她真开口了
    if (!opts.byPlay && st.initiateNow && list.length) {
      const rec = socialV2.life.initiates.find((x) => x.key === key && Number(x.at) === Number(st.initiateNow));
      if (rec && !rec.sent) {
        rec.sent = true;
        rec.sentAt = now;
        log(`[主动找人] ${key}：她开口了（${rec.thought}）`);
      }
    }
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    saveSocialV2State();
  }

  // 她这次发言引用的那条是谁说的、@ 了谁（不算她自己）
  function toUserIdsV2(quotedInfo, atUserId) {
    const self = String(app.selfUserId ?? '');
    return [...new Set([quotedInfo?.userId, atUserId].filter((x) => x !== undefined && x !== null && String(x) && String(x) !== self).map(String))];
  }

  // qqbot_agent：她在这里说的话交给 extras，讲到的见闻记成“在这里讲过了”（2026-10-23 同一只偷鞋的黄鼠狼
  // 讲了四个地方，每处还不止一次）。讲过的见闻 extras 不再当话头给，给的时候标上在哪讲过。
  // socialV2.longTermMemory.reportTold:false 关掉。不等结果，失败只记日志。
  function reportToldV2(key, list) {
    const ltm = cfg.socialV2?.longTermMemory ?? {};
    if (ltm.enabled === false || ltm.reportTold === false || key === PLAY_KEY) return;
    const text = list.map((m) => redactKnownTokensOnly(String(m ?? ''))).join('\n').trim().slice(0, 4000);
    if (!text) return;
    extrasPostV2('/memory/told', { key, text }, 5000)
      .then((data) => { if (Array.isArray(data.told) && data.told.length) log(`[memory] ${key} 讲了见闻 ${data.told.join(',')}，记成在这里讲过了`); })
      .catch((error) => log(`[memory] 记“讲过了”失败 (${key})：${error?.message ?? error}`));
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  // qqbot_agent：群里攒了很久的未读，叫醒时开头那段过了 staleUnreadMinutes（默认 30）的不给原文，只给条数和时间段。
  // 以前快照从最早的未读给 12 条，bridge 叫她来看的那几句根本不在里面，她就去接一个多小时前的话
  // （2026-10-23 14:48 大群：30 条未读从 12:50 攒起，快照里是 12:50~13:19 的，她接了 13:27 的“俺妹”）。
  // 只跳开头连着的一段（游标要连续）：遇到还没过去的、或在叫她的（@/引用/叫名字/接她的话）就停，
  // 所以夜里被挡的 @ 早上照样看得到。私聊不跳。
  function staleUnreadPrefixV2(key, st, now = Date.now()) {
    if (!String(key).startsWith('group:') || !v2ToolEnabled('getUnread')) return [];
    const minutes = Number(cfg.socialV2?.context?.staleUnreadMinutes ?? 30);
    if (!(minutes > 0)) return [];
    const cutoff = now - minutes * 60000;
    const out = [];
    for (const m of st.unread) {
      if (!Number.isSafeInteger(m?.seq) || m.seq <= 0 || !(Number(m.time) > 0) || Number(m.time) >= cutoff) break;
      if (m.quoteTargetIsSelf || m.atSelf || m.talkBack || mentionsSelfNameV2(m.plain || m.text)) break;
      out.push(m);
    }
    return out;
  }

  // 过了 10 分钟的消息带一句“多久以前”：time 是毫秒时间戳，她算不出来
  function withAgoV2(msg, now = Date.now()) {
    const t = Number(msg?.time);
    if (!(t > 0)) return msg;
    const minutes = Math.floor((now - t) / 60000);
    if (minutes < 10) return msg;
    return { ...msg, ago: minutes < 120 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前` };
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const now = Date.now();
    const stale = staleUnreadPrefixV2(key, st, now);
    const staleSeqs = new Set(stale.map((m) => m.seq));
    // 跳过的那段最后几句当 recent 给（只当背景），其余只报条数
    const staleShown = v2ToolEnabled('getRecent') && maxRecent > 0 ? stale.slice(-maxRecent) : [];
    const staleHidden = stale.slice(0, stale.length - staleShown.length);
    const packet = {
      ...(staleHidden.length ? { olderSkipped: { count: staleHidden.length, from: whenV2(staleHidden[0].time), to: whenV2(staleHidden[staleHidden.length - 1].time) } } : {}),
      messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0,
      readThroughSeq: readThroughSeqV2(st, staleHidden), partial: st.unread.length > staleHidden.length
    };
    let middleHidden = []; // 群里放不下、中间只给条数的（见下面）
    const shownCount = () => staleHidden.length + middleHidden.length + packet.messages.length + packet.recent.filter((m) => staleSeqs.has(m.seq)).length;
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(withAgoV2(msg, now)));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...staleHidden, ...middleHidden, ...packet.messages, ...packet.recent]);
      packet.partial = shownCount() < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = shownCount() < st.unread.length;
      return false;
    };
    const fresh = st.unread.filter((m) => !staleSeqs.has(m.seq));
    if (v2ToolEnabled('getUnread') && String(key).startsWith('group:') && context.keepNewestInGroups !== false && fresh.length > 1) {
      // qqbot_agent：群里放不下时留最新的和叫她的，中间放不下的只报条数（middleSkipped，记成看过）。
      // 以前从最早的给 12 条，2026-10-27 11:32 大群有人“@鱼妹 在不在”，未读 30 条，跳过旧的 14 条后剩 16 条，
      // 快照给了 11:07~11:17 的 12 条，叫她来的那条 @ 在后面 4 条里没放进来；提示让她接着读，她当成是更早的，
      // 看着没人找她就走了，那人又问“人呢”。context.keepNewestInGroups:false 回到从早的给。
      const callsHer = (m) => m.quoteTargetIsSelf || m.atSelf || m.talkBack || mentionsSelfNameV2(m.plain || m.text);
      const picked = new Set();
      const want = [...fresh.filter(callsHer).reverse(), ...[...fresh].reverse()];
      for (const msg of want) {
        if (picked.size >= maxUnread) break;
        if (picked.has(msg) || !tryAdd('messages', msg)) continue;
        picked.add(msg);
      }
      packet.messages.sort((a, b) => a.seq - b.seq);
      middleHidden = fresh.filter((m) => !picked.has(m));
      if (middleHidden.length) {
        packet.middleSkipped = { count: middleHidden.length, from: whenV2(middleHidden[0].time), to: whenV2(middleHidden.at(-1).time) };
        packet.readThroughSeq = readThroughSeqV2(st, [...staleHidden, ...middleHidden, ...packet.messages, ...packet.recent]);
        packet.partial = shownCount() < st.unread.length;
        log(`[reserved2] ${key} 快照放不下，中间 ${middleHidden.length} 条只给条数（${packet.middleSkipped.from}~${packet.middleSkipped.to}），留了最新的和叫她的 ${packet.messages.length} 条`);
      }
    } else if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of fresh.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (staleShown.length) {
      // 跳过的那段的最后几句（unread 里的，给了就算看过）
      for (const msg of [...staleShown].reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    } else if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => (!Number.isSafeInteger(m.seq) || !unread.has(m.seq))
        && !(m.byPlay && !m.shownToChat)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    // 投递成功后连跳过的一起记成看过，游标才能越过它们
    Object.defineProperty(packet, 'skippedEntries', { value: [...staleHidden, ...middleHidden] });
    // 放进 recent 的旧未读：提示里写明是当时没接上的、话题多半过去了（不进 JSON）。
    // 2026-10-25 12:36 她来小群分享 2048，recent 里是 3 小时前阿明回她的“我给你说了呀”“你忘了”，
    // 没有 olderSkipped 就没有“别回头接”那句，她觉得晾着不好，又追问了一遍昨晚几点睡。
    const staleInRecent = packet.recent.filter((m) => staleSeqs.has(m.seq));
    if (staleInRecent.length) {
      const times = staleShown.filter((m) => packet.recent.some((r) => r.seq === m.seq)).map((m) => m.time);
      Object.defineProperty(packet, 'staleRecent', { value: { count: staleInRecent.length, from: whenV2(times[0]), to: whenV2(times.at(-1)) } });
    }
    if (stale.length) log(`[reserved2] ${key} 快照跳过过时未读 ${stale.length} 条（${whenV2(stale[0].time)}~${whenV2(stale[stale.length - 1].time)}，其中 ${staleShown.length} 条放进 recent 当背景）`);
    const playSent = unseenPlaySentV2(st);
    if (playSent.length) {
      packet.yourPlaySelfSent = playSentViewV2(playSent);
      // 不进 JSON：投递成功后用它标 shownToChat
      Object.defineProperty(packet, 'playSentEntries', { value: playSent, enumerable: false });
    }
    return packet;
  }

  return {
    exports: {
      PLAY_SENT_HINT,
      acknowledgeMessagesV2,
      appendFeedbackEntry,
      appendSocialV2Message,
      appendSocialV2Poke,
      appendToolLog,
      buildWakeSnapshotV2,
      markPlaySentShownV2,
      noteModelMessagesV2,
      playSentViewV2,
      readFeedbackEntries,
      readThroughSeqV2,
      readToolLog,
      recordSentMessagesV2,
      requestedReadThroughSeqV2,
      sanitizeToolArgs,
      selfSenderFieldsV2,
      toUserIdsV2,
      unseenPlaySentV2,
      withAgoV2,
    },
    link() {
      ({
        extrasPostV2, getSocialV2State, whenV2, initiateCfgV2, mentionsSelfNameV2,
        noteReminderWaitV2, ownStickerTextV2, queueSelfCheckV2, saveSocialV2State, seenForwardIds,
        socialV2, v2ToolEnabled
      } = app);
    },
    start() {},
  };
}
