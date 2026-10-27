// 回话的时机（socialV2.replyTiming）：等对方说完再开口、发前看一眼
// 2026-10-26：她常在别人一句话分几条发的中间插进来（合并唤醒、等待、门控都是死的 3 秒，被 @ 只等 2 秒；
// 想好了要发的时候对方又补了一句，她也看不到，照发）。现在：
//   · 安静多久按这个人自己的连发节奏和这条的内容定（纯函数在 ../v2-wait.js 的 adaptiveQuietMs），
//     合并唤醒（wake.js）、一轮里的等待（console-server 的 /api/socialV2/wait）、回复门控（wake-triggers.js）三处都用 quietNeededV2；
//   · 发前看一眼（preSendHoldV2）：她调发送工具时，她最后一次看消息以后跟她有关的人又说了话
//     （私聊：对方；群：她引用或 @ 的人、把她叫来的人、她开口前最后说话的人、在跟她说话的人），
//     先不发，把新消息和没发的草稿退回给她，她看完再决定照发、改一改还是不说了。每批新消息只拦一次，一轮最多 maxHoldsPerTurn 次。
import { adaptiveQuietMs, replyTimingCfg, typingRhythmMs } from '../v2-wait.js';

export function createReplyTiming(app) {
  const {
    PLAY_KEY, cfg, log, sleep
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let getSocialV2State, isOutsideGroupKeyV2, mentionsSelfNameV2, noteModelMessagesV2,
    readThroughSeqV2, saveSocialV2State;

  function replyTimingCfgV2() {
    return replyTimingCfg(cfg.socialV2?.replyTiming);
  }
  function replyTimingOnV2() {
    return replyTimingCfgV2().enabled;
  }
  function otherBotV2(userId) {
    const bots = Array.isArray(cfg.socialV2?.wake?.otherBots) ? cfg.socialV2.wake.otherBots.map(String) : [];
    return !!userId && bots.includes(String(userId));
  }
  // 这条是不是在跟她说（私聊都是）
  function toHerV2(key, m) {
    if (!m || m.isSelf) return false;
    if (String(key).startsWith('private:')) return true;
    if (m.quoteTargetIsSelf || m.atSelf) return true;
    if (otherBotV2(m.userId)) return false;
    return !!(m.talkBack || m.addressed || mentionsSelfNameV2(m.plain || m.text));
  }
  // 家里以外的群正热闹：60 秒里 ≥6 条、≥3 个人
  function hotV2(key, st, now = Date.now()) {
    if (String(key).startsWith('private:') || !isOutsideGroupKeyV2(key)) return false;
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = recent.filter((m) => m && !m.isSelf && now - Number(m.time || 0) < 60000);
    return last.length >= 6 && new Set(last.map((m) => String(m.userId ?? m.sender ?? ''))).size >= 3;
  }
  // 最新一条别人的话；给了 userId 就只看这个人的
  function lastIncomingOfV2(st, userId = null) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m && !m.isSelf && (userId == null || String(m.userId) === String(userId))) return m;
    }
    return null;
  }
  /**
   * 最新一条别人的话之后，她该等多久（{ms, why}）。没开 replyTiming 时返回 null。
   * userId：只等这个人说完（群里被某人叫来时用，旁人接着聊不算）。
   */
  function quietNeededV2(key, st, now = Date.now(), userId = null) {
    const c = replyTimingCfgV2();
    if (!c.enabled) return null;
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = lastIncomingOfV2(st, userId) ?? (userId != null ? lastIncomingOfV2(st) : null);
    if (!last) return { ms: c.baseMs, why: '默认' };
    return adaptiveQuietMs({
      msg: last,
      toHer: toHerV2(key, last),
      rhythmMs: typingRhythmMs(recent, last.userId, c),
      hot: hotV2(key, st, now),
    }, c);
  }
  /** 离“对方说完了”还差多久（毫秒，≤0 就是已经安静够了）；没开时返回 null。userId 同上。 */
  function quietLeftV2(key, st, now = Date.now(), userId = null) {
    const q = quietNeededV2(key, st, now, userId);
    if (!q) return null;
    const mine = userId != null ? lastIncomingOfV2(st, userId) : null;
    const at = mine ? Number(mine.time) || 0 : Number(st?.lastIncomingAt) || 0;
    return q.ms - (now - at);
  }

  // 她还没看过的别人的话（unread 和 recent 合起来，按 seq 去重）
  function unseenMessagesV2(st, seen = readThroughSeqV2(st)) {
    const all = [...(st.unread || []), ...(Array.isArray(st.recentMessages) ? st.recentMessages : [])];
    return [...new Map(all.filter((m) => m && !m.isSelf && Number(m.seq) > seen).map((m) => [m.seq, m])).values()]
      .sort((a, b) => a.seq - b.seq);
  }
  // 没看过的里面，跟她要发的这段话有关的
  function relevantUnseenV2(key, st, { replyToMessageId, atUserId } = {}, now = Date.now()) {
    const seen = readThroughSeqV2(st);
    const unseen = unseenMessagesV2(st, seen);
    if (!unseen.length) return [];
    if (String(key).startsWith('private:')) return unseen;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const ids = new Set();
    if (atUserId != null && String(atUserId)) ids.add(String(atUserId));
    if (replyToMessageId != null && String(replyToMessageId).trim()) {
      const target = recent.find((m) => m && String(m.messageId ?? '') === String(replyToMessageId).trim());
      if (target?.userId && !target.isSelf) ids.add(String(target.userId));
    }
    for (const wb of [...(st.wakeBys || []), st.wakeBy]) {
      if (wb?.userId && now - Number(wb.at || 0) <= 10 * 60000) ids.add(String(wb.userId));
    }
    // 她开口前看到的最后一个说话的人（3 分钟内）
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (!m || m.isSelf || Number(m.seq) > seen) continue;
      if (m.userId && now - Number(m.time || 0) <= 3 * 60000) ids.add(String(m.userId));
      break;
    }
    return unseen.filter((m) => toHerV2(key, m) || (m.userId && ids.has(String(m.userId)) && !otherBotV2(m.userId)));
  }

  /**
   * 发前看一眼。drafts 是她这次要发的几条；byPlay：自由时间那边发进来的不拦。
   * 要拦就返回给她的结果（不发），不拦返回 null。
   */
  async function preSendHoldV2(key, { drafts = [], replyToMessageId = null, atUserId = null, byPlay = false } = {}) {
    const c = replyTimingCfgV2();
    if (!c.enabled || !c.holdBeforeSend || byPlay || key === PLAY_KEY) return null;
    const st = getSocialV2State(key);
    const turnAt = Number(st.wakeConfig?.lastWakeAt) || 0;
    const hold = st.sendHold && st.sendHold.turnAt === turnAt ? st.sendHold : { turnAt, count: 0 };
    if (hold.count >= c.maxHoldsPerTurn) return null;
    const relevant = relevantUnseenV2(key, st, { replyToMessageId, atUserId });
    if (!relevant.length) return null;
    // 对方可能还在打字：等他这段说完（最多 holdQuietMaxMs），一起给她看
    const start = Date.now();
    while (Date.now() - start < c.holdQuietMaxMs) {
      const left = quietLeftV2(key, st);
      if (!(left > 50)) break;
      await sleep(Math.max(50, Math.min(200, left)));
    }
    const newMessages = unseenMessagesV2(st);
    const readThroughSeq = noteModelMessagesV2(st, newMessages);
    hold.count += 1;
    st.sendHold = hold;
    saveSocialV2State();
    const waited = Date.now() - start;
    log(`[reserved2] [发前看一眼] ${key}：她要发的时候有 ${relevant.length} 条跟她有关的新消息（没看过的共 ${newMessages.length} 条），先退回给她${waited > 200 ? `（等对方说完 ${Math.round(waited / 100) / 10}s）` : ''}，这一轮第 ${hold.count} 次`);
    const who = String(key).startsWith('private:') ? '对方' : '跟你有关的人';
    return {
      ok: true,
      key,
      sent: 0,
      held: true,
      notSent: drafts,
      newMessages,
      readThroughSeq,
      unreadCount: st.unread.length,
      hint: `你要发的时候${who}又说了话（newMessages），你这段还没发出去（notSent）。先看看他说了什么：意思没变就照发，要改就改了再发，已经不用说了就别发。`,
    };
  }

  return {
    exports: {
      preSendHoldV2,
      quietLeftV2,
      quietNeededV2,
      relevantUnseenV2,
      replyTimingCfgV2,
      replyTimingOnV2,
    },
    link() {
      ({
        getSocialV2State, isOutsideGroupKeyV2, mentionsSelfNameV2, noteModelMessagesV2,
        readThroughSeqV2, saveSocialV2State
      } = app);
    },
    start() {},
  };
}
