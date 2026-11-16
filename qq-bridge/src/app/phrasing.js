// 她别老一个说法、别把说过的再说一遍（2026-11-15，主人：“有些话似乎反复说？句式有点雷同？”）。
// 两件事：
// 1. 老说法：数她这几天在各处说过的话（src/repeat-phrases.js），用了好几回的说法写进唤醒提示【你最近的说法】，
//    发出去的话里又用上了，发送结果里提醒一次。家里以外的群只数她在家里以外的群说的（家里、私聊的话不往外带）。
// 2. 自由时间的她发进聊天前先看一眼：聊天那边的她刚在那里说过话（play 不知道），这次先不发，把那边最近说的给她看。
//    11-15 15:04 聊天的她刚跟爸爸讲完 Simple 那关，15:31 play 那边又发了一遍“Simple 推通啦”。
//    每个聊天记 playSeenSelfAt（play 看到哪儿了），那以后聊天的她又说过话才拦，一批只拦一次。
// 配置 socialV2.phrasing，都有代码默认。

import { phrasesUsed, repeatedOpener, repeatedPhrases } from '../repeat-phrases.js';

export function createPhrasing(app) {
  const { cfg, log, PLAY_KEY } = app;
  let getSocialV2State, isOutsideGroupKeyV2, registerWakeSectionV2, saveSocialV2State, socialV2, whenV2;
  const hinted = new Map(); // `${key}|${说法}` → 上次在发送结果里提醒的时间（只在内存里）

  function phrasingCfgV2() {
    const c = cfg.socialV2?.phrasing ?? {};
    const num = (v, d, min = 0) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : d);
    return {
      enabled: c.enabled !== false,
      windowMs: num(c.windowHours, 72, 1) * 3600000,
      minLen: num(c.minLen, 4, 3),
      minCount: num(c.minCount, 3, 2),
      sameCount: num(c.sameCount, 4, 2),
      maxShow: num(c.maxShow, 5, 1),
      openerBursts: num(c.openerBursts, 5, 2),
      openerMin: num(c.openerMin, 3, 2),
      openerMs: num(c.openerHours, 24, 1) * 3600000,
      burstGapMs: num(c.burstGapMinutes, 3, 1) * 60000,
      hintMs: num(c.hintMinutes, 120, 0) * 60000,
      playLookFirst: c.playLookFirst !== false,
      playLookMs: num(c.playLookHours, 12, 1) * 3600000,
      playLookShow: num(c.playLookShow, 12, 1),
    };
  }

  const textOf = (m) => String(m?.plain ?? m?.text ?? '').trim();
  const dayOf = (t) => {
    const d = new Date(Number(t));
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const recentOf = (k) => (Array.isArray(socialV2.conversations.get(k)?.recentMessages) ? socialV2.conversations.get(k).recentMessages : []);

  // 她在 k 这里连着说的几段话（中间没别人说话、隔不到 burstGapMs），每段 { lines, at }
  function burstsOf(k, since) {
    const out = [];
    let cur = null;
    for (const m of recentOf(k)) {
      if (!m || Number(m.time) < since) continue;
      if (!m.isSelf) { cur = null; continue; }
      const text = textOf(m);
      if (!text) continue;
      if (cur && Number(m.time) - cur.last <= phrasingCfgV2().burstGapMs) {
        cur.lines.push(text);
        cur.last = Number(m.time);
      } else {
        cur = { lines: [text], at: Number(m.time), last: Number(m.time) };
        out.push(cur);
      }
    }
    return out;
  }

  // 给 viewKey 看的那份：家里以外的群只数家里以外的群
  function sourcesFor(viewKey) {
    const outside = viewKey !== PLAY_KEY && isOutsideGroupKeyV2(viewKey);
    return [...socialV2.conversations.keys()].filter((k) => k !== PLAY_KEY && (!outside || isOutsideGroupKeyV2(k)));
  }

  function repeatedPhrasesForV2(viewKey, now = Date.now()) {
    const c = phrasingCfgV2();
    if (!c.enabled) return [];
    const since = now - c.windowMs;
    const groups = [];
    const others = [];
    for (const k of sourcesFor(viewKey)) {
      for (const b of burstsOf(k, since)) groups.push({ lines: b.lines, tag: `${k}|${dayOf(b.at)}` });
      for (const m of recentOf(k)) if (m && !m.isSelf && Number(m.time) >= since) others.push(textOf(m));
    }
    return repeatedPhrases(groups, { minLen: c.minLen, minCount: c.minCount, sameCount: c.sameCount, maxShow: c.maxShow, exclude: others });
  }

  function repeatedOpenerForV2(key, now = Date.now()) {
    const c = phrasingCfgV2();
    if (!c.enabled || key === PLAY_KEY) return null;
    return repeatedOpener(burstsOf(key, now - c.openerMs).map((b) => b.lines), { last: c.openerBursts, minCount: c.openerMin });
  }

  const quoteList = (list) => list.map((p) => `“${p.text}”（${p.count} 回）`).join('、');

  function phrasingPromptLineV2(key) {
    const phrases = repeatedPhrasesForV2(key);
    const opener = repeatedOpenerForV2(key);
    if (!phrases.length && !opener) return '';
    const parts = [];
    if (phrases.length) parts.push(`这几天你说的话里这几个说法用了好几回：${quoteList(phrases)}。`);
    if (opener) parts.push(`你在这里最近几段话，${opener.count} 段开头都是“${opener.text}”。`);
    return `【你最近的说法】${parts.join('')}同一个说法别老用：换个说法，或者这次就不说这句${opener ? '；开头也换换，或者直接说事' : ''}。在聊的那样东西本来就叫这个名字的不用管。\n\n`;
  }

  // 发出去以后：这次的话里用上了老说法、或者又是那个开头，提醒一次（同一处同一个说法 hintMinutes 内只提一次）
  function repeatHintV2(key, sentLines, now = Date.now()) {
    const c = phrasingCfgV2();
    if (!c.enabled || key === PLAY_KEY) return null;
    const lines = (Array.isArray(sentLines) ? sentLines : [sentLines]).map((x) => String(x?.text ?? x ?? '')).filter(Boolean);
    if (!lines.length) return null;
    const fresh = (text) => {
      const k = `${key}|${text}`;
      if (c.hintMs && now - (hinted.get(k) || 0) < c.hintMs) return false;
      hinted.set(k, now);
      return true;
    };
    const used = phrasesUsed(lines, repeatedPhrasesForV2(key, now)).filter((p) => fresh(p.text));
    const opener = repeatedOpenerForV2(key, now);
    const firstLine = lines.find((l) => !/^\s*\[/.test(l)) || '';
    const openerHit = opener && firstLine.trim().startsWith(opener.text) && fresh(`开头:${opener.text}`) ? opener : null;
    if (hinted.size > 500) for (const [k, t] of hinted) if (now - t > Math.max(c.hintMs, 3600000)) hinted.delete(k);
    if (!used.length && !openerHit) return null;
    const bits = [];
    if (used.length) bits.push(`${quoteList(used)}这几天你已经说了好几回了`);
    if (openerHit) bits.push(`这里最近 ${openerHit.count} 段话你都是“${openerHit.text}”开头`);
    log(`[说法] ${key}：${bits.join('；')}`);
    return `${bits.join('；')}。下次换个说法，或者干脆不说这句。`;
  }

  // 自由时间的她发进 key 之前先看一眼聊天那边的她在这里说过什么。要拦就返回给她的结果，不拦返回 null。
  function playLookFirstV2(key, drafts = [], now = Date.now()) {
    const c = phrasingCfgV2();
    if (!c.enabled || !c.playLookFirst || key === PLAY_KEY) return null;
    const st = getSocialV2State(key);
    const since = Math.max(Number(st.playSeenSelfAt) || 0, now - c.playLookMs);
    const recent = recentOf(key).filter((m) => m && Number(m.time) > since && textOf(m));
    const chatSelf = recent.filter((m) => m.isSelf && !m.byPlay);
    if (!chatSelf.length) return null;
    st.playSeenSelfAt = now;
    saveSocialV2State();
    const chatSaid = recent.slice(-c.playLookShow).map((m) => ({
      who: m.isSelf ? (m.byPlay ? '你（自由时间这边发的）' : '聊天那边的你') : String(m.sender || '某人').slice(0, 16),
      text: textOf(m).slice(0, 200),
      time: whenV2(m.time),
    }));
    log(`[说法] [先看一眼] play 要往 ${key} 发，聊天那边的她在那里说过 ${chatSelf.length} 句（play 没看过），先退回给她看`);
    return {
      ok: true,
      key,
      sent: 0,
      held: true,
      notSent: drafts,
      chatSaid,
      hint: '先别急着发：聊天那边的你刚在这里说过话（chatSaid 是这里最近说的，按时间排）。你要说的事那边已经讲过了就别再讲一遍，有新进展只说新的那一点；没讲过就照发（notSent），要改就改了再发，不用说了就别发。',
    };
  }

  return {
    exports: {
      phrasingCfgV2,
      phrasingPromptLineV2,
      playLookFirstV2,
      repeatHintV2,
      repeatedOpenerForV2,
      repeatedPhrasesForV2,
    },
    link() {
      ({ getSocialV2State, isOutsideGroupKeyV2, registerWakeSectionV2, saveSocialV2State, socialV2, whenV2 } = app);
      registerWakeSectionV2({ name: 'phrasing', order: 114, where: 'both', build: ({ key }) => phrasingPromptLineV2(key) });
    },
    start() {},
  };
}
