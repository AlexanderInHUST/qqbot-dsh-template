// 像人打字那样分条发送（条间隔、一次几条、被插话打断）
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { moodBubbleDelta } from '../inner-life.js';

export function createHumanSend(app) {
  const {
    captureSendGuard, cfg, log, onebotSend, randInt, sleep
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let getSocialV2State, isOutsideGroupKeyV2, moodEngineCfgV2, socialV2, waitAddressedV2;

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  // qqbot_agent：像人打字那样发（socialV2.send.human，enabled:true 才生效）。
  //   · 条间隔 = 打下一条要的时间：baseMs + 字数 × perCharMs，±jitter，夹在 [minMs, maxMs]；她传的 gapMs/gaps 不管用；
  //   · 一次最多几条按场景（maxBubbles：私聊 / 家里的群 / 别的群），多出来的并进最后一条；
  //   · cutOnInterrupt：两条之间对方插话（私聊里对方说了话，群里有人 @/引用/叫她），后面的不发了，返回 notSent 让她先看。
  // 以前固定 0.5 秒一条，三四条一下子全冒出来，不像打字。
  function humanSendCfgV2() {
    const h = cfg.socialV2?.send?.human ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    const mb = h.maxBubbles ?? {};
    const minMs = Math.max(100, num(h.minMs, 400));
    return {
      enabled: h.enabled === true,
      baseMs: Math.max(0, num(h.baseMs, 600)),
      perCharMs: Math.max(0, num(h.perCharMs, 120)),
      jitter: Math.min(0.9, Math.max(0, num(h.jitter, 0.3))),
      minMs,
      maxMs: Math.max(minMs, num(h.maxMs, 4000)),
      cutOnInterrupt: h.cutOnInterrupt !== false,
      maxBubbles: { private: Math.max(0, num(mb.private, 4)), home: Math.max(0, num(mb.home, 4)), group: Math.max(0, num(mb.group, 2)) },
    };
  }
  function bubbleCapV2(key) {
    const h = humanSendCfgV2();
    if (!h.enabled) return 0;
    const cap = String(key).startsWith('private:') ? h.maxBubbles.private : isOutsideGroupKeyV2(key) ? h.maxBubbles.group : h.maxBubbles.home;
    // qqbot_agent：兴奋时多一条、蔫的时候少一条（moodEngine.coupleBubbles），最少 1 条
    const me = moodEngineCfgV2();
    if (!cap || !me.enabled || !me.coupleBubbles) return cap;
    return Math.max(1, cap + moodBubbleDelta(socialV2.mood, Date.now(), me.halfLifeMinutes));
  }
  // 超过条数上限：前面的照发，多出来的并进最后一条（中间补个逗号，已经有标点就不补）
  function mergeBubblesV2(messages, cap) {
    if (!(cap >= 1) || messages.length <= cap) return messages;
    const tail = messages.slice(cap - 1).reduce((acc, m) => {
      if (!acc) return m;
      const glue = /[，。！？!?…~～、,.;；:：)）」』】\]]$/.test(acc) || /^[，。！？!?…~～、,.]/.test(m) ? '' : '，';
      return acc + glue + m;
    }, '');
    return [...messages.slice(0, cap - 1), tail];
  }
  function typingGapV2(nextMsg, h) {
    const chars = Math.max(1, [...String(nextMsg ?? '')].length);
    const raw = (h.baseMs + chars * h.perCharMs) * (1 + (Math.random() * 2 - 1) * h.jitter);
    return Math.round(Math.max(h.minMs, Math.min(h.maxMs, raw)));
  }
  // 发之前记下水位：之后对方插话就不再发后面的
  function interruptCheckV2(key) {
    const h = humanSendCfgV2();
    if (!h.enabled || !h.cutOnInterrupt) return null;
    const st = getSocialV2State(key);
    const baseline = Number(st.lastUnreadSeq) || 0;
    const isPrivate = String(key).startsWith('private:');
    return () => {
      if (isPrivate) return (st.unread || []).some((m) => m && !m.isSelf && (m.seq || 0) > baseline);
      return waitAddressedV2(st, baseline);
    };
  }
  function mergedHintV2(asked, cap) {
    return `你一次想发 ${asked} 条，这里一次最多 ${cap} 条，多出来的并进最后一条发了。下次挑最想说的说，别的等人问。`;
  }
  // 没发出去的几条：退回预占的发送额度，返回这几条
  function releaseNotSentV2(st, reservedAt, sentMessages) {
    const notSent = Array.isArray(sentMessages?.notSent) ? sentMessages.notSent : [];
    for (let i = 0; i < notSent.length; i++) {
      const idx = st.sendTimes.indexOf(reservedAt);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
    }
    return notSent;
  }
  function interruptHintV2(sentCount, notSent) {
    return `你发到第 ${sentCount} 条时对方插了句话，后面 ${notSent.length} 条没发（notSent）。先看看他说了啥（qq_get_unread_messages），还想说再发，不想说就算了。`;
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const human = humanSendCfgV2();
    if (human.enabled) {
      for (let i = 1; i < messages.length; i++) delays.push(typingGapV2(messages[i], human));
      return delays;
    }
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  // 返回发出去的条数组；被插话打断时数组上带 notSent（没发的那几条）
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const interrupted = messages.length > 1 ? interruptCheckV2(key) : null;
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    const unsent = []; // 发失败的那条和它后面没再发的
    let notSent = null;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      app.sendChain = app.sendChain
        .then(async () => {
          if (notSent) { notSent.push(msg); return; }
          // 一条发失败后面的就不发了：2026-10-27 15:45 第一条网络异常、第二条照发，
          // 她以为都没发出去又整段重发，群里同一句出现两次、顺序还倒了。
          if (failed.length) { unsent.push(msg); return; }
          if (i > 0 && interrupted && sent.length && !failed.length && interrupted()) {
            notSent = [msg];
            log(`[reserved2] 分条发送被插话打断 ${key}：发了 ${sent.length} 条，后面的不发了`);
            return;
          }
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
          unsent.push(msg);
        });
      if (i < delays.length) {
        const d = delays[i];
        app.sendChain = app.sendChain.then(() => (notSent || failed.length ? null : sleep(d)));
      }
    }
    return app.sendChain.then(() => {
      if (failed.length > 0) {
        // 错误文字会原样给她看，写清哪几条已经发出去了，免得她整段重发
        const quote = (list) => list.map((m) => `「${String(m).slice(0, 60)}」`).join('');
        const detail = sent.length
          ? `已经发出去 ${sent.length} 条：${quote(sent)}，别再发；没发出去的 ${unsent.length} 条：${quote(unsent)}，要补只补这几条。`
          : (messages.length > 1 ? `这 ${messages.length} 条都没发出去。` : '这条没发出去。');
        const err = new Error(`QQ 发送失败：${failed[0]?.message ?? '未知错误'}。${detail}`);
        err.sent = sent.slice();
        err.unsent = unsent.slice();
        throw err;
      }
      if (notSent) sent.notSent = notSent;
      return sent;
    });
  }

  return {
    exports: {
      bubbleCapV2,
      computeGapsV2,
      humanSendCfgV2,
      interruptHintV2,
      mergeBubblesV2,
      mergedHintV2,
      releaseNotSentV2,
      sendMessagesV2,
    },
    link() {
      ({
        getSocialV2State, isOutsideGroupKeyV2, moodEngineCfgV2, socialV2, waitAddressedV2
      } = app);
    },
    start() {},
  };
}
