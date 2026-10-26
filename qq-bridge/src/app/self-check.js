// 说的话前后对得上：发完话核对、说过的自己的事
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { truncateText } from '../md-to-plain.js';
import { defang } from '../qq-model-view.js';
import { SENSITIVE_RE } from '../sensitive.js';

export function createSelfCheck(app) {
  const {
    PLAY_KEY, api, cfg, isSessionAllowedInCurrentMode, log, redactKnownTokensOnly
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let SELF_CLAIMS_KEEP_MS, SELF_CLAIMS_MAX, chatLinesV2, condPromiseSaidV2, convLabelV2,
    crossSessionBlockV2, crossSessionCountOnlyV2, extrasPostV2, getSocialV2State, whenV2,
    reminderWhenTextV2, remindersOfV2, saveSocialV2State, selfNowPartsV2, sleepStateV2, socialV2,
    turnRunningV2;

  // ── qqbot_agent：她说的自己的事前后对得上（socialV2.selfCheck） ──────────────────────────────────
  // 2026-10-23：小群 13:01 前一句“我吃完也去躺一下下”、十秒后“还没吃呢”；晚上主人问“你去玩了一整天一样”，
  // 她玩了 5 回，只看得到最后那回，说“就晚上玩了一阵”；答应妈妈“他一睡我就告诉你”，可她根本不会知道。
  // 她发完话以后（同一会话 debounceMs 内的几条合成一批）交给 extras /self/check：抽出她说的自己的事记进
  // selfClaims（之后每个窗口的【你现在】都看得到），和【你现在】、别处的事、之前说过的对一下；
  // 对不上、或者答应了做不到的，插一句【说岔了】让她自己顺口改。只看她自己的事，别人的事不管。
  function selfCheckCfgV2() {
    const c = cfg.socialV2?.selfCheck ?? {};
    const n = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled === true,
      ledger: c.ledger !== false, // 抽出来的话记进 selfClaims、写进【你现在】
      correct: c.correct !== false, // 对不上时插话让她改
      debounceMs: Math.max(500, n(c.debounceMs, 4000)),
      timeoutMs: Math.max(5000, n(c.timeoutMs, 60000)),
      contextLines: Math.max(2, Math.min(30, n(c.contextLines, 10))),
      minIntervalMinutes: Math.max(0, n(c.minIntervalMinutes, 10)), // 同一会话两次【说岔了】至少隔这么久
      perHour: Math.max(0, n(c.perHour, 6)), // 全局一小时最多几次【说岔了】
      pendingMinutes: Math.max(1, n(c.pendingMinutes, 30)), // 她已经走了：下次唤醒提示里带上，过了这么久就算了
      showClaims: Math.max(0, Math.min(20, n(c.showClaims, 10))),
    };
  }
  // 粗筛：说的是她自己的状态、做过的事、答应的事才去查（大部分接话、吐槽不用查）
  const SELF_REF_RE = /我|俺|咱|人家|本鱼/;
  const SELF_STATE_RE = /吃|饭|饿|饱|睡|醒|起床|困|玩|看了|看过|看完|刷到|刷了|翻了|画了|画的|写的|去了|回来|在(?:看|玩|弄|忙|画|写)|待会|等会|一会|晚点|明天|下次|盯着|守着|看着|告诉你|跟你说|汇报|今天|昨天|上午|下午|中午|晚上|刚才|刚刚|一整天|一阵|几回|没(?:玩|看|吃|睡)/;
  const SELF_START_RE = /^(?:还没|刚|才|正|已经|一直)(?:吃|睡|醒|起|玩|看|在)/;
  // 中文常省主语（“也不是一整天啦，就晚上玩了一阵”）：没提到别人、又像在说自己做了什么的也查
  const SELF_IMPLIED_RE = /(?:玩|看|吃|睡|醒|刷|画)(?:了|过|完)|一整天|一阵|几回|还没(?:吃|睡|玩|看)|刚(?:醒|起|吃|睡|玩)/;
  function selfTalkWorthCheckingV2(text) {
    const t = String(text ?? '').trim();
    if (!t || /^\[(?:表情包|截图|图片|语音)/.test(t)) return false;
    return SELF_START_RE.test(t) || (SELF_REF_RE.test(t) && SELF_STATE_RE.test(t)) || (!/[你他她]|大家/.test(t) && SELF_IMPLIED_RE.test(t)) || condPromiseSaidV2(t);
  }
  const selfCheckQueue = new Map(); // key -> { texts, timer }
  let selfCheckInFlight = 0;
  function queueSelfCheckV2(key, list) {
    const c = selfCheckCfgV2();
    if (!c.enabled || key === PLAY_KEY || app.currentMode !== 'reserved2') return;
    const texts = (Array.isArray(list) ? list : []).map((m) => redactKnownTokensOnly(String(m ?? '')).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean);
    if (!texts.length) return;
    const q = selfCheckQueue.get(key) || { texts: [], timer: null };
    q.texts.push(...texts);
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => {
      selfCheckQueue.delete(key);
      void runSelfCheckV2(key, q.texts).catch((error) => log(`[自洽] ${key} 出错：${error?.message ?? error}`));
    }, c.debounceMs);
    selfCheckQueue.set(key, q);
  }
  // 起床以后（没起床就最近 12 小时）她说过的自己的事
  function selfClaimsSinceV2(now = Date.now()) {
    const sleep = sleepStateV2(now);
    const since = sleep.kind === 'awake' && sleep.wokeAt ? sleep.wokeAt : now - 12 * 3600000;
    return (socialV2.selfClaims || []).filter((x) => Number(x.at) >= since && Number(x.at) <= now);
  }
  const CLAIM_PRIVATE_RE = /爸|妈|主人|私聊|老公|老婆|宝宝|宝贝/;
  // 【你现在】里的那一行：不写在哪说的（只标“这里”），家里以外的群看不到私聊、家里群说的带称呼的那些
  function selfClaimsLineV2(key, sleep, now = Date.now()) {
    const c = selfCheckCfgV2();
    if (!c.enabled || !c.ledger || !c.showClaims) return '';
    const names = Object.values(cfg.ownerTitles || {}).map(String).filter(Boolean);
    const list = selfClaimsSinceV2(now).filter((x) => {
      if (x.key === key || !crossSessionCountOnlyV2(key, x.key)) return true;
      return !CLAIM_PRIVATE_RE.test(x.text) && !names.some((nm) => x.text.includes(nm));
    });
    // 差不多的话只留最后一次（10-24 早上十条里有“八点就醒了”“起来了”、“打算装睡”“被赶去睡就装睡”）
    const kept = [];
    for (const x of list.slice().reverse()) {
      if (kept.length >= c.showClaims) break;
      if (!kept.some((y) => claimsSimilarV2(x.text, y.text))) kept.push(x);
    }
    if (!kept.length) return '';
    return `- 今天你说过的自己的事（再说到要对得上，真变了就说变了）：${kept.reverse().map((x) => `${whenV2(x.at)}${x.key === key ? '（这里）' : ''} ${x.text}`).join('；')}。`;
  }
  function claimBigramsV2(t) {
    const s = String(t).replace(/[\s，,。！？!?~～…、“”"'（）()]/g, '');
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  }
  function claimsSimilarV2(a, b) {
    const x = claimBigramsV2(a);
    const y = claimBigramsV2(b);
    if (!x.size || !y.size) return a === b;
    let common = 0;
    for (const g of x) if (y.has(g)) common++;
    return common / Math.min(x.size, y.size) >= 0.5;
  }
  function addSelfClaimsV2(key, claims, now = Date.now()) {
    if (!Array.isArray(socialV2.selfClaims)) socialV2.selfClaims = [];
    const recent = new Set(socialV2.selfClaims.filter((x) => now - Number(x.at) < 3 * 3600000).map((x) => x.text));
    let added = 0;
    for (const raw of claims) {
      const text = truncateText(String(raw ?? '').replace(/\s+/g, ' ').trim(), 40);
      if (!text || recent.has(text) || SENSITIVE_RE.test(text)) continue;
      recent.add(text);
      socialV2.selfClaims.push({ at: now, key, text });
      added++;
    }
    socialV2.selfClaims = socialV2.selfClaims.filter((x) => now - Number(x.at) < SELF_CLAIMS_KEEP_MS).slice(-SELF_CLAIMS_MAX);
    return added;
  }
  const selfCheckSteers = []; // 最近一小时插过的【说岔了】时间
  async function runSelfCheckV2(key, texts) {
    const c = selfCheckCfgV2();
    if (!c.enabled || !isSessionAllowedInCurrentMode(key)) return null;
    const said = texts.filter(selfTalkWorthCheckingV2);
    if (!said.length) return null;
    if (selfCheckInFlight >= 2) { log(`[自洽] ${key} 同时在查的太多，这批跳过`); return null; }
    const now = Date.now();
    const st = getSocialV2State(key);
    const others = selfClaimsSinceV2(now).map((x) => ({ time: whenV2(x.at), where: x.key === key ? '这里' : convLabelV2(x.key, socialV2.conversations.get(x.key)), text: x.text }));
    const reminders = remindersOfV2(key).filter((r) => !r.firedAt).map((r) => (r.wait ? `等${r.wait.who}${r.wait.words.length ? `说“${r.wait.words.join('/')}”` : '说话'}：${r.note}` : `${reminderWhenTextV2(r.due, now)}：${r.note}`));
    const body = {
      key,
      place: convLabelV2(key, st),
      now: whenV2(now),
      said,
      context: chatLinesV2(st, now - 30 * 60000, c.contextLines),
      facts: selfNowPartsV2(key, now).lines.filter((l) => !l.startsWith('- 今天你说过的自己的事')),
      elsewhere: crossSessionBlockV2(key).slice(0, 4000),
      claims: others,
      reminders,
    };
    selfCheckInFlight++;
    let data;
    try {
      data = await extrasPostV2('/self/check', body, c.timeoutMs);
    } catch (error) {
      log(`[自洽] ${key} 查不了：${error?.message ?? error}`);
      return null;
    } finally {
      selfCheckInFlight--;
    }
    const claims = (Array.isArray(data.claims) ? data.claims : []).map(String);
    if (c.ledger && claims.length) {
      const n = addSelfClaimsV2(key, claims);
      if (n) log(`[自洽] ${key} 记下她说的自己的事：${claims.slice(0, 4).join('；')}`);
    }
    const problems = [];
    for (const x of Array.isArray(data.conflicts) ? data.conflicts : []) {
      const saidText = truncateText(String(x?.said ?? ''), 40);
      const truth = truncateText(String(x?.truth ?? ''), 80);
      if (saidText && truth) problems.push({ kind: 'conflict', said: saidText, truth });
    }
    for (const x of Array.isArray(data.promises) ? data.promises : []) {
      const saidText = truncateText(String(x?.said ?? ''), 40);
      const why = truncateText(String(x?.why ?? ''), 80);
      // 这一轮已经记了等人说话的提醒：答应的是真的
      if (saidText && why && !remindersOfV2(key).some((r) => r.wait && now - Number(r.at) < 10 * 60000)) problems.push({ kind: 'promise', said: saidText, why });
    }
    saveSocialV2State();
    if (!problems.length) return { claims, problems };
    log(`[自洽] ${key} 对不上：${problems.map((p) => `“${p.said}” ${p.kind === 'conflict' ? `↔ ${p.truth}` : `（${p.why}）`}`).join('；')}`);
    if (!c.correct) return { claims, problems };
    if (now - Number(st.selfCheckSteerAt || 0) < c.minIntervalMinutes * 60000) { log(`[自洽] ${key} 刚提醒过，这次不插话`); return { claims, problems }; }
    while (selfCheckSteers.length && now - selfCheckSteers[0] > 3600000) selfCheckSteers.shift();
    if (c.perHour && selfCheckSteers.length >= c.perHour) { log(`[自洽] 这一小时提醒够多了，这次不插话`); return { claims, problems }; }
    const text = selfCheckTextV2(problems);
    st.selfCheckSteerAt = now;
    selfCheckSteers.push(now);
    if (turnRunningV2(key)) {
      try {
        const accepted = await api.sessions.prompt({ sessionId: app.state.sessions[key], mode: 'steer', content: [{ type: 'text', text: `【说岔了】${key}（令牌 ${st.agentToken}）${text}` }] });
        if (accepted?.result?.ok) { log(`[自洽] ${key} 插了一句【说岔了】`); return { claims, problems, steered: true }; }
      } catch (error) {
        log(`[自洽] ${key} 插话失败：${error?.message ?? error}`);
      }
    }
    // 她已经走了：下次在这里被叫醒时带上（过了 pendingMinutes 就算了）
    st.selfCheckPending = { at: now, text };
    saveSocialV2State();
    log(`[自洽] ${key} 她不在，下次叫醒时带上`);
    return { claims, problems, pending: true };
  }
  function selfCheckTextV2(problems) {
    const lines = problems.slice(0, 3).map((p) => (p.kind === 'conflict'
      ? `- 你说“${defang(p.said)}”，可实际上${defang(p.truth)}`
      : `- 你答应了“${defang(p.said)}”，可${defang(p.why)}`));
    const hasPromise = problems.some((p) => p.kind === 'promise');
    return `你刚才说的跟真实情况对不上：\n${lines.join('\n')}\n像平常人那样顺口改一句就行（“啊不对，我记岔了……”“诶我说错了”），一两句，别长篇解释，别提有人提醒你。${hasPromise ? '答应的事要兑现就用 qq_remind_me 的 waitFor/waitWords 等那个人说话，不然就照实说你没法知道。' : ''}要是你本来就是在开玩笑、逗人，或者话题早过去了没人在意，就不用管。`;
  }
  function selfCheckPromptLineV2(key, now = Date.now()) {
    const st = getSocialV2State(key);
    const p = st.selfCheckPending;
    if (!p) return '';
    if (now - Number(p.at) > selfCheckCfgV2().pendingMinutes * 60000) { st.selfCheckPending = null; return ''; }
    st.selfCheckPendingShown = p.at;
    return `【说岔了】${whenV2(p.at)} 你在这里${p.text}\n\n`;
  }
  function markSelfCheckShownV2(key) {
    const st = getSocialV2State(key);
    if (st.selfCheckPending && Number(st.selfCheckPendingShown) === Number(st.selfCheckPending.at)) {
      st.selfCheckPending = null;
      saveSocialV2State();
    }
  }

  return {
    exports: {
      addSelfClaimsV2,
      markSelfCheckShownV2,
      queueSelfCheckV2,
      runSelfCheckV2,
      selfCheckCfgV2,
      selfCheckPromptLineV2,
      selfClaimsLineV2,
      selfTalkWorthCheckingV2,
    },
    link() {
      ({
        SELF_CLAIMS_KEEP_MS, SELF_CLAIMS_MAX, chatLinesV2, condPromiseSaidV2, convLabelV2,
        crossSessionBlockV2, crossSessionCountOnlyV2, extrasPostV2, getSocialV2State, whenV2,
        reminderWhenTextV2, remindersOfV2, saveSocialV2State, selfNowPartsV2, sleepStateV2,
        socialV2, turnRunningV2
      } = app);
    },
    start() {},
  };
}
