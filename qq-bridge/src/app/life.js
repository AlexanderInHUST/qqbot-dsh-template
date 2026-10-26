// 心情、生活（手上的事、今天想、日记）、主动找人
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { activities as freeTimeActivities } from '../free-time.js';
import { bestThought, clockMinutes, inClockWindow, initiateBlockReason, initiateCfg, initiateCfgFor, likedKinds, moodPhase, updateInterest } from '../inner-life.js';
import { mdToPlain } from '../md-to-plain.js';
import { SENSITIVE_RE } from '../sensitive.js';

export function createLife(app) {
  const {
    PLAY_KEY, cfg, isSessionAllowedInCurrentMode, log, pendingWakeKeys
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let FREE_TIME_REASONS, MOOD_STALE_MS, convLabelV2, crossSessionSummaryOnlyV2, emptyLifeV2, whenV2,
    isConversationBusyV2, isNightSleepV2, isOutsideGroupKeyV2, minutesRangeV2, nightCfgOkV2,
    nightOwnerAwakeUntil, replyOnlyGroupV2, saveSocialV2State, sendWakePromptV2, sleepStateV2, socialV2;

  // ── qqbot_agent：她自己的心情、生活和主动找人（纯函数在 src/inner-life.js，要想的交给 extras/life.py）─────────
  // 心情 socialV2.moodEngine：一轮结束后 extras 体会一下她现在什么心情，按半衰期淡回平常，接到门控 / 条数 / 想玩什么上。
  // 生活 socialV2.life：自由时间里没弄完的事（threads）、按见闻 interest 学到的喜好、早上想今天干嘛、睡前日记。
  // 主动找人 socialV2.initiate：闲着时 extras 想想有没有想跟谁说的事，打分过阈值才叫醒她去说，有次数、间隔、没人理就停。
  
  function loadLifeV2(raw) {
    const l = emptyLifeV2();
    if (!raw || typeof raw !== 'object') return l;
    const now = Date.now();
    for (const [k, t] of Object.entries(raw.moodAppraisedAt && typeof raw.moodAppraisedAt === 'object' ? raw.moodAppraisedAt : {})) {
      if (Number(t) > 0 && Number(t) <= now) l.moodAppraisedAt[k] = Number(t);
    }
    l.moodLog = (Array.isArray(raw.moodLog) ? raw.moodLog : []).filter((x) => x && typeof x.text === 'string' && now - Number(x.at) < 86400000).slice(-40);
    for (const [k, e] of Object.entries(raw.interest && typeof raw.interest === 'object' ? raw.interest : {})) {
      if (e && Number.isFinite(Number(e.ema)) && Number(e.n) > 0) l.interest[k] = { ema: Number(e.ema), n: Number(e.n), at: Number(e.at) || 0 };
    }
    l.initiates = (Array.isArray(raw.initiates) ? raw.initiates : []).filter((x) => x && typeof x.key === 'string' && now - Number(x.at) < 7 * 86400000).slice(-50);
    const next = Number(raw.initiateNextAt);
    l.initiateNextAt = next > 0 && next < now + 12 * 3600 * 1000 ? next : 0;
    l.planDate = String(raw.planDate || '');
    l.diaryDate = String(raw.diaryDate || '');
    const items = (v, n) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim().slice(0, 30)).filter(Boolean).slice(0, n) : []);
    if (raw.plan && typeof raw.plan === 'object' && items(raw.plan.items, 3).length) {
      l.plan = { date: String(raw.plan.date || ''), items: items(raw.plan.items, 3), at: Number(raw.plan.at) || 0, progress: {} };
      for (const [i, p] of Object.entries(raw.plan.progress && typeof raw.plan.progress === 'object' ? raw.plan.progress : {})) {
        if (l.plan.items[i] && (p?.status === 'done' || p?.status === 'some')) l.plan.progress[i] = { status: p.status, how: String(p.how || '').slice(0, 20), at: Number(p.at) || 0, key: String(p.key || '') };
      }
    }
    l.planCheckedAt = {};
    for (const [k, t] of Object.entries(raw.planCheckedAt && typeof raw.planCheckedAt === 'object' ? raw.planCheckedAt : {})) {
      if (Number(t) > 0 && Number(t) <= now) l.planCheckedAt[k] = Number(t);
    }
    if (raw.diary && typeof raw.diary === 'object' && raw.diary.gist) l.diary = { date: String(raw.diary.date || ''), gist: String(raw.diary.gist).slice(0, 40), at: Number(raw.diary.at) || 0 };
    l.threads = (Array.isArray(raw.threads) ? raw.threads : []).filter((t) => t && t.title).slice(0, 5).map((t) => ({ title: String(t.title).slice(0, 20), next: String(t.next || '').slice(0, 40) }));
    l.threadsAt = Number(raw.threadsAt) || 0;
    l.dayPlay = (Array.isArray(raw.dayPlay) ? raw.dayPlay : []).filter((x) => x && x.what && now - Number(x.at) < 86400000).slice(-120);
    return l;
  }
  function moodEngineCfgV2() {
    const c = cfg.socialV2?.moodEngine ?? {};
    const n = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled === true,
      minIntervalMinutes: Math.max(0, n(c.minIntervalMinutes, 10)),
      selfSetWinsMinutes: Math.max(0, n(c.selfSetWinsMinutes, 30)),
      halfLifeMinutes: Math.max(1, n(c.halfLifeMinutes, 120)),
      baseline: String(c.baseline ?? '平平常常，有点懒洋洋').slice(0, 30),
      coupleTalk: c.coupleTalk !== false,
      coupleBubbles: c.coupleBubbles !== false,
      couplePlay: c.couplePlay !== false,
      timeoutMs: Math.max(5000, n(c.timeoutMs, 90000)),
    };
  }
  function lifeCfgV2() {
    const c = cfg.socialV2?.life ?? {};
    const n = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled === true,
      threads: c.threads !== false,
      interest: c.interest !== false,
      plan: c.plan !== false,
      planProgress: c.planProgress !== false,
      planProgressMinutes: Math.max(0, n(c.planProgressMinutes, 10)),
      diary: c.diary !== false,
      refreshMinutes: Math.max(1, n(c.refreshMinutes, 10)),
      timeoutMs: Math.max(5000, n(c.timeoutMs, 300000)),
    };
  }
  function initiateCfgV2() {
    return initiateCfg(cfg.socialV2?.initiate ?? {});
  }
  function extrasUrlV2(pathname) {
    const ltm = cfg.socialV2?.longTermMemory ?? {};
    return String(ltm.url ?? 'http://extras:8940/recall').replace(/\/recall$/, pathname);
  }
  // 人格一句话：extras 体会心情、定计划、写日记、想念头、核对说的话时用。以前 extras 自己写死一句
  // “活泼、爱玩、嘴有点贫、偶尔闹小脾气的女孩子”，和人格卡（爱玩爱闹、偶尔装小大人的小孩）对不上（2026-10-24）。
  // 现在取人格卡开头引用块的第一行，`socialV2.life.persona` 可以直接写一句盖掉。
  let personaCache = { card: null, brief: '' };
  function personaBriefV2() {
    const set = cfg.socialV2?.life?.persona;
    if (typeof set === 'string' && set.trim()) return set.trim().slice(0, 80);
    let card = '';
    try { card = String(app.currentRoleHintV2() || ''); } catch {}
    if (card === personaCache.card) return personaCache.brief;
    const line = (/^>\s*(\S.*)$/m.exec(card)?.[1] || '').trim();
    const brief = mdToPlain(line).replace(/^(?:她的)?(?:语气|性格)?是/, '').replace(/^一个/, '').replace(/[。．.\s]+$/, '').slice(0, 80);
    personaCache = { card, brief };
    return brief;
  }
  // 给 extras 的“想一想”接口（/mood、/life、/self、/proactive）都带上她叫什么、什么性格
  function withSelfV2(pathname, body) {
    if (!/^\/(?:mood|life|self|proactive)\//.test(pathname) || !body || typeof body !== 'object') return body;
    const bot = String(app.selfDisplayName || '').trim() || '鱼妹';
    const persona = personaBriefV2();
    return { bot, ...(persona ? { persona } : {}), ...body };
  }
  async function extrasPostV2(pathname, body, timeoutMs) {
    const res = await fetch(extrasUrlV2(pathname), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withSelfV2(pathname, body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }
  // 她的一天从起床算到睡觉：起床时间之前（凌晨被叫醒）还算前一天
  function lifeDayV2(now = Date.now()) {
    const n = nightCfgOkV2();
    const wake = n ? clockMinutes(n.to) : NaN;
    const d = new Date(now);
    if (Number.isFinite(wake) && d.getHours() * 60 + d.getMinutes() < wake) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function chatLinesV2(st, since, limit = 30) {
    return (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && Number(m.time) >= since && String(m.plain ?? m.text ?? '').trim())
      .slice(-limit)
      .map((m) => `${m.isSelf ? '我' : `${String(m.sender || '某人').slice(0, 16)}${m.isOwner ? '（主人）' : ''}`}：${String(m.plain ?? m.text).replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  // 现在的心情（淡没了就是平常）；给 extras 想事情用
  // withWhy=false：只要那个词，不带原因（原因可能是私聊里的事，给大群想事情时不带）
  function moodTextNowV2(now = Date.now(), withWhy = true) {
    const me = moodEngineCfgV2();
    const m = socialV2.mood;
    if (!m?.text) return me.baseline;
    if (m.source === 'auto' && moodPhase(m, now, me.halfLifeMinutes) === 'gone') return me.baseline;
    if (m.source !== 'auto' && now - Number(m.at) >= MOOD_STALE_MS) return me.baseline;
    return m.why && withWhy ? `${m.text}（${m.why}）` : m.text;
  }

  // 心情：一轮结束后体会一下。她自己 30 分钟内用 qq_set_mood 定过的不动；同一个会话 10 分钟最多一次；同时只想一个。
  const moodInFlight = new Set();
  async function appraiseMoodV2(key, { place, lines = [], play = [] }) {
    const me = moodEngineCfgV2();
    if (!me.enabled || moodInFlight.size) return null;
    const life = socialV2.life;
    const now = Date.now();
    if (now - Number(life.moodAppraisedAt[key] || 0) < me.minIntervalMinutes * 60000) return null;
    const cur = socialV2.mood;
    if (cur?.text && cur.source !== 'auto' && now - Number(cur.at) < me.selfSetWinsMinutes * 60000) {
      log(`[selfState] ${key} 心情是她自己刚定的（${cur.text}），这次不体会`);
      return null;
    }
    if (!lines.length && !play.length) return null;
    life.moodAppraisedAt[key] = now;
    moodInFlight.add(key);
    try {
      const fresh = cur?.text && (cur.source === 'auto' ? moodPhase(cur, now, me.halfLifeMinutes) !== 'gone' : now - Number(cur.at) < MOOD_STALE_MS);
      const prev = fresh ? { text: cur.text, why: cur.why || '', minutes: Math.round((now - Number(cur.at)) / 60000) } : null;
      const data = await extrasPostV2('/mood/appraise', { place, lines, play, prev, baseline: me.baseline }, me.timeoutMs);
      // 想的这会儿她自己定了心情：听她的
      if (socialV2.mood && socialV2.mood.source !== 'auto' && Number(socialV2.mood.at) > now) return null;
      const text = String(data.mood ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
      const why = String(data.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!text || SENSITIVE_RE.test(text) || SENSITIVE_RE.test(why)) return null;
      const valence = Math.max(-2, Math.min(2, Math.round(Number(data.valence) || 0)));
      const arousal = Math.max(-2, Math.min(2, Math.round(Number(data.arousal) || 0)));
      if (prev && !data.changed && text === prev.text) {
        // 没什么变化：接着淡，不重新计时
        log(`[selfState] ${key} 心情没变（${text}）`);
        saveSocialV2State();
        return socialV2.mood;
      }
      socialV2.mood = { text, why, at: Date.now(), key, source: 'auto', valence, arousal };
      life.moodLog = [...life.moodLog.filter((x) => Date.now() - Number(x.at) < 86400000), { at: Date.now(), text, key }].slice(-40);
      saveSocialV2State();
      log(`[selfState] ${key} 心情（自己体会的）：${text}${why ? `（${why}）` : ''} v=${valence} a=${arousal}`);
      return socialV2.mood;
    } catch (error) {
      log(`[selfState] ${key} 体会心情失败：${error?.message ?? error}`);
      return null;
    } finally {
      moodInFlight.delete(key);
    }
  }
  // 聊天这一轮：从上次体会（最多 30 分钟前）以来的话；这轮她自己没开口（只是看了一眼）就不体会
  function appraiseChatMoodV2(key, st) {
    const since = Math.max(Number(socialV2.life.moodAppraisedAt[key] || 0), Date.now() - 30 * 60000);
    const recent = (Array.isArray(st?.recentMessages) ? st.recentMessages : []).filter((m) => m && Number(m.time) >= since);
    if (!recent.some((m) => m.isSelf && !m.byPlay)) return null;
    return appraiseMoodV2(key, { place: convLabelV2(key, st), lines: chatLinesV2(st, since, 30) });
  }

  // 自由时间玩完：手上没弄完的事交给 extras 整理（新开 / 接着 / 弄完了）
  async function updateThreadsV2(items, say) {
    const lc = lifeCfgV2();
    if (!lc.enabled || !lc.threads) return null;
    try {
      const data = await extrasPostV2('/life/threads/update', { items, say, startedAt: socialV2.playStartedAt || 0 }, lc.timeoutMs);
      socialV2.life.threads = (Array.isArray(data.threads) ? data.threads : []).slice(0, 5).map((t) => ({ title: String(t.title || '').slice(0, 20), next: String(t.next || '').slice(0, 40) })).filter((t) => t.title);
      socialV2.life.threadsAt = Date.now();
      saveSocialV2State();
      log(`[生活] 手上的事：${socialV2.life.threads.map((t) => `${t.title}（${t.next}）`).join('；') || '没有'}`);
      return socialV2.life.threads;
    } catch (error) {
      log(`[生活] 整理手上的事失败：${error?.message ?? error}`);
      return null;
    }
  }
  // “今天想”里哪件真做了：聊天里她开过口的一轮结束后（同一会话 planProgressMinutes 一次）、自由时间玩完后，
  // 交给 extras 看一眼（要有实在的证据，光说“这就去”不算）。以前早上定了就一整天不变：2026-10-24 08:45 她在小群问到了
  // 爸爸几点睡，“问问爸爸昨晚到底几点睡”还一直挂着；“接着画会掉饼干的小家伙”一直挂着，她就一直说“这就去画”
  const planProgressInFlight = new Set(); // key
  async function planProgressV2(key, { place, lines = [], play = null } = {}, now = Date.now()) {
    const lc = lifeCfgV2();
    const L = socialV2.life;
    if (!lc.enabled || !lc.plan || !lc.planProgress || planProgressInFlight.has(key)) return null;
    const plan = L.plan;
    if (!plan || plan.date !== lifeDayV2(now)) return null;
    const open = plan.items.map((text, i) => ({ i, text })).filter((x) => plan.progress?.[x.i]?.status !== 'done');
    if (!open.length) return null;
    const since = Number(plan.at) || sleepStateV2(now).wokeAt || now - 18 * 3600000;
    const todayPlay = play ?? [...(L.dayPlay || []), ...(socialV2.playLog || [])].filter((x) => Number(x.at) >= since)
      .sort((a, b) => Number(a.at) - Number(b.at)).map((x) => `${whenV2(x.at)} ${x.what}`)
      .filter((x, i, a) => a.indexOf(x) === i).slice(-40);
    if (!lines.length && !todayPlay.length) return null;
    planProgressInFlight.add(key);
    L.planCheckedAt[key] = now;
    try {
      const data = await extrasPostV2('/life/plan/progress', { items: open, place, lines, play: todayPlay }, lc.timeoutMs);
      if (L.plan !== plan) return null; // 等的时候换了一天
      const changed = [];
      for (const p of Array.isArray(data.progress) ? data.progress : []) {
        const i = Number(p?.i);
        if (!open.some((x) => x.i === i) || (p.status !== 'done' && p.status !== 'some')) continue;
        const prev = plan.progress[i];
        if (prev?.status === p.status && p.status === 'some') continue; // 已经记过“弄了一点”，留着第一次的说法
        plan.progress[i] = { status: p.status, how: String(p.how || '').slice(0, 20), at: Date.now(), key };
        changed.push(`${plan.items[i]}→${p.status === 'done' ? '做了' : '弄了一点'}${p.how ? `（${p.how}）` : ''}`);
      }
      saveSocialV2State();
      if (changed.length) log(`[生活] ${key} 今天想的有进展：${changed.join('；')}`);
      return plan.progress;
    } catch (error) {
      log(`[生活] ${key} 看今天想的做没做失败：${error?.message ?? error}`);
      return null;
    } finally {
      planProgressInFlight.delete(key);
    }
  }
  function planChatProgressV2(key, st) {
    const lc = lifeCfgV2();
    const now = Date.now();
    const last = Number(socialV2.life.planCheckedAt[key] || 0);
    if (now - last < lc.planProgressMinutes * 60000) return null;
    const since = Math.max(last, now - 30 * 60000);
    const recent = (Array.isArray(st?.recentMessages) ? st.recentMessages : []).filter((m) => m && Number(m.time) >= since);
    if (!recent.some((m) => m.isSelf && !m.byPlay)) return null;
    return planProgressV2(key, { place: convLabelV2(key, st), lines: chatLinesV2(st, since, 30) }, now);
  }
  // 给日记、主动找人用的“今天想”：做了的带上怎么做的
  function planTextV2(plan) {
    return plan.items.map((t, i) => {
      const p = plan.progress?.[i];
      if (!p) return t;
      return `${t}（${p.status === 'done' ? '做了' : '弄了一点'}${p.how ? `：${p.how}` : ''}）`;
    });
  }
  // 手上的事 extras 那边一周没碰会自己淡掉；隔一会儿同步一次（也让 extras 重启、手动改过的能看到）
  let lifeViewInFlight = null;
  function refreshLifeViewV2(force = false) {
    const lc = lifeCfgV2();
    if (!lc.enabled || lifeViewInFlight) return lifeViewInFlight;
    if (!force && Date.now() - Number(socialV2.life.threadsAt || 0) < lc.refreshMinutes * 60000) return null;
    lifeViewInFlight = (async () => {
      try {
        const res = await fetch(extrasUrlV2('/life'), { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data?.ok) return;
        socialV2.life.threads = (Array.isArray(data.threads) ? data.threads : []).slice(0, 5).map((t) => ({ title: String(t.title || '').slice(0, 20), next: String(t.next || '').slice(0, 40) })).filter((t) => t.title);
        socialV2.life.threadsAt = Date.now();
        const d = data.diary;
        if (d?.gist && d.date && (!socialV2.life.diary || String(d.date) > socialV2.life.diary.date)) {
          socialV2.life.diary = { date: String(d.date), gist: String(d.gist).slice(0, 40), at: Number(d.at) * 1000 || Date.now() };
        }
      } catch {
        socialV2.life.threadsAt = Date.now(); // extras 没起来：过一个周期再试
      } finally {
        lifeViewInFlight = null;
      }
    })();
    return lifeViewInFlight;
  }

  // 自由时间里记见闻时打的 interest：调用时先记下参数，结果没报错（见闻太长会被退回）才算到当时在玩的那一类上
  const memoryNoteArgsV2 = new Map(); // callId -> args
  function noteMemoryNoteCallV2(key, toolName, callId, args) {
    if (key !== PLAY_KEY || !/memory_note$/.test(String(toolName || '')) || !callId) return;
    let a = args;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    if (!a || typeof a !== 'object') return;
    memoryNoteArgsV2.set(callId, a);
    if (memoryNoteArgsV2.size > 50) memoryNoteArgsV2.delete(memoryNoteArgsV2.keys().next().value);
  }
  function noteMemoryNoteResultV2(key, toolName, callId, isError) {
    if (key !== PLAY_KEY || !callId || !memoryNoteArgsV2.has(callId)) return;
    const a = memoryNoteArgsV2.get(callId);
    memoryNoteArgsV2.delete(callId);
    const lc = lifeCfgV2();
    if (!lc.enabled || !lc.interest || isError || String(a.subject) !== 'self' || a.interest == null) return;
    const kind = socialV2.conversations.get(PLAY_KEY)?.freeTime?.lastKind;
    if (!kind) return;
    updateInterest(socialV2.life.interest, kind, a.interest, Date.now());
    saveSocialV2State();
    const e = socialV2.life.interest[kind];
    log(`[生活] 兴趣：${kind} 记了 ${a.interest}，平均 ${e.ema}（${e.n} 条）`);
  }

  // 一轮结束：心情、手上的事、主动找人的结果
  function innerLifeTurnEndedV2(key, ended) {
    try {
      const st = socialV2.conversations.get(key);
      if (!st) return;
      const me = moodEngineCfgV2();
      if (key === PLAY_KEY) {
        // 自由时间整段玩完才算（中途被 steer、还有补发的唤醒都不算）
        if (pendingWakeKeys.has(key) || !FREE_TIME_REASONS.has(st.lastWakeReason)) return;
        const say = mdToPlain(String(ended?.text || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
        const since = Number(socialV2.playStartedAt) || Date.now() - 3 * 3600000;
        const items = (socialV2.playLog || []).filter((x) => Number(x.at) >= since).map((x) => x.what);
        if (!items.length && !say) return;
        void (async () => {
          await updateThreadsV2(items.slice(-30), say);
          await planProgressV2(PLAY_KEY, { place: '电脑上自己玩的时候', lines: say ? [`我（玩完心里想的）：${say}`] : [] });
          await appraiseMoodV2(PLAY_KEY, { place: '电脑上自己玩的时候', lines: say ? [`我（玩完心里想的）：${say}`] : [], play: items.slice(-15) });
        })().catch(() => {});
        return;
      }
      if (st.initiateNow && !pendingWakeKeys.has(key)) {
        const rec = socialV2.life.initiates.find((x) => x.key === key && Number(x.at) === Number(st.initiateNow));
        if (rec && !rec.sent) {
          rec.declined = true;
          log(`[主动找人] ${key}：她看了看，没开口（${rec.thought}）`);
        }
        st.initiateNow = 0;
        st.initiateThought = null;
        saveSocialV2State();
      }
      if (me.enabled) void appraiseChatMoodV2(key, st)?.catch?.(() => {});
      void planChatProgressV2(key, st)?.catch?.(() => {});
    } catch (error) {
      log(`[生活] 回合结束处理出错：${error?.message ?? error}`);
    }
  }
  // 早上起床后想想今天想干嘛；睡觉时写日记。每分钟看一次，一天各一次，失败 30 分钟后再试
  // 分工（2026-10-24 定）：计划和日记的原件在 extras /data/life.json（同一天再问拿回原来那份）；
  // socialV2.life.plan 是 bridge 的副本，唤醒提示同步要用，做没做（progress）只记在这里。
  let lifeTickBusy = false;
  async function lifeTickV2(now = Date.now()) {
    const lc = lifeCfgV2();
    if (!lc.enabled || lifeTickBusy || app.currentMode !== 'reserved2' || socialV2.paused) return;
    const L = socialV2.life;
    const day = lifeDayV2(now);
    lifeTickBusy = true;
    try {
      if (lc.plan && sleepStateV2(now).kind === 'awake' && L.planDate !== day && now - Number(L.planTriedAt || 0) >= 30 * 60000) {
        L.planTriedAt = now;
        const list = freeTimeActivities(cfg);
        try {
          const data = await extrasPostV2('/life/plan', { date: day, likes: likedKinds(list, L.interest).join('、'), mood: moodTextNowV2(now) }, lc.timeoutMs);
          const items = (Array.isArray(data.plan?.items) ? data.plan.items : []).map((x) => String(x).slice(0, 20)).filter(Boolean).slice(0, 3);
          L.planDate = day;
          L.plan = items.length ? { date: day, items, at: Number(data.plan?.at) > 0 ? Math.min(now, Number(data.plan.at) * 1000) : now, progress: {} } : null;
          saveSocialV2State();
          log(`[生活] 今天想：${items.join('、') || '（没想出来）'}${data.existing ? '（之前想过的）' : ''}`);
        } catch (error) {
          log(`[生活] 想今天干嘛失败：${error?.message ?? error}`);
        }
      }
      const asleep = isNightSleepV2() && !nightOwnerAwakeUntil.size;
      if (lc.diary && asleep && L.diaryDate !== day && now - Number(L.diaryTriedAt || 0) >= 30 * 60000) {
        L.diaryTriedAt = now;
        const since = now - 18 * 3600000;
        const chats = [];
        for (const [k, s] of socialV2.conversations) {
          if (k === PLAY_KEY || !isSessionAllowedInCurrentMode(k)) continue;
          const lines = chatLinesV2(s, since, 25);
          if (lines.some((x) => x.startsWith('我：'))) chats.push({ label: convLabelV2(k, s), lines });
        }
        const body = {
          date: day,
          moods: L.moodLog.filter((x) => Number(x.at) >= since).map((x) => `${whenV2(x.at)} ${x.text}`),
          play: L.dayPlay.filter((x) => Number(x.at) >= since).map((x) => `${whenV2(x.at)} ${x.what}`),
          chats: chats.slice(0, 8),
          plan: L.plan?.date === day ? planTextV2(L.plan).join('、') : '',
        };
        try {
          const data = await extrasPostV2('/life/diary', body, lc.timeoutMs);
          L.diaryDate = day;
          if (data.diary?.gist) L.diary = { date: day, gist: String(data.diary.gist).slice(0, 40), at: Date.now() };
          saveSocialV2State();
          log(`[生活] 日记（${day}）：${String(data.diary?.text || '').replace(/\s+/g, ' ').slice(0, 200)}${data.existing ? '（之前写过的）' : ''}`);
        } catch (error) {
          log(`[生活] 写日记失败：${error?.message ?? error}`);
        }
      }
    } finally {
      lifeTickBusy = false;
    }
  }
  // 【你现在】里的“今天想…”“昨天…”
  function lifeLinesV2(key, sleep, now) {
    const lc = lifeCfgV2();
    if (!lc.enabled || sleep.kind !== 'awake' || crossSessionSummaryOnlyV2(key)) return [];
    const L = socialV2.life;
    const out = [];
    const day = lifeDayV2(now);
    // 聊天这边做不了电脑上的事：2026-10-24 早上“今天想：接着画会掉饼干的小家伙”，她在小群一小时里说了四回“我这就去画”，
    // 一回也没去（聊天这边说完还在聊，自由时间又没轮到）
    if (lc.plan && L.plan?.date === day && L.plan.items.length) {
      const pr = L.plan.progress || {};
      const open = L.plan.items.map((t, i) => (pr[i]?.status === 'some' ? `${t}（弄了一点${pr[i].how ? `：${pr[i].how}` : ''}）` : pr[i]?.status === 'done' ? '' : t)).filter(Boolean);
      const done = L.plan.items.map((t, i) => (pr[i]?.status === 'done' ? `${t}（${whenV2(pr[i].at)}${pr[i].how ? ` ${pr[i].how}` : ''}）` : '')).filter(Boolean);
      if (open.length) out.push(`- 今天想：${open.join('、')}（随便想想的，不用非做完${key === PLAY_KEY ? '' : '；电脑上的事要等自由时间，现在就想去就用 qq_go_play 交给去玩的你，别光说“这就去”'}）`);
      if (done.length) out.push(`- 今天想的${open.length ? '已经做了' : '都做了'}：${done.join('、')}${open.length ? '' : '，接下来随便'}`);
    }
    if (lc.diary && L.diary?.gist && L.diary.date < day && now - Number(L.diary.at) < 36 * 3600000) out.push(`- 昨天：${L.diary.gist}`);
    return out;
  }

  // 主动找人：闲着时每 intervalMinutes 想一次；extras 给念头打分，过 threshold 的才叫醒她去那个会话说
  let initiateThinking = false;
  async function initiateTickV2(now = Date.now()) {
    const c = initiateCfgV2();
    if (!c.enabled || initiateThinking || app.currentMode !== 'reserved2' || socialV2.paused) return null;
    const L = socialV2.life;
    const nextAt = () => now + minutesRangeV2(c.intervalMinutes, [30, 60]) * 60000;
    if (!L.initiateNextAt) { L.initiateNextAt = nextAt(); saveSocialV2State(); return null; }
    if (now < L.initiateNextAt) return null;
    L.initiateNextAt = nextAt();
    saveSocialV2State();
    if (isNightSleepV2() || !inClockWindow(c.from, c.to, new Date(now))) return null;
    const targets = [];
    const skipped = [];
    for (const k of c.targets) {
      if (!/^(private|group):\d+$/.test(k)) continue;
      // socialV2.replyOnlyGroups：这些群只在有人找她时说话，写在 targets 里也不找
      if (replyOnlyGroupV2(k)) { skipped.push(`${k} 只在有人找时说话`); continue; }
      // 家里以外的群：要在 byKey 里单独写了规矩（一般是更少）才找，不然不找（大群看不到私聊，也不该常去打扰）
      const outside = isOutsideGroupKeyV2(k);
      if (outside && !c.byKey[k]) { skipped.push(`${k} 不是家里的群`); continue; }
      const ck = initiateCfgFor(c, k);
      const st = socialV2.conversations.get(k);
      if (!st || !isSessionAllowedInCurrentMode(k)) { skipped.push(`${k} 没聊过`); continue; }
      if (isConversationBusyV2(k, st)) { skipped.push(`${k} 正在聊`); continue; }
      const last = (Array.isArray(st.recentMessages) ? st.recentMessages : []).reduce((t, m) => Math.max(t, Number(m?.time) || 0), 0);
      const silence = last ? (now - last) / 60000 : 24 * 60;
      if (silence < ck.minSilenceMinutes) { skipped.push(`${k} ${Math.round(silence)} 分钟前刚聊过`); continue; }
      const why = initiateBlockReason(L.initiates, k, now, ck);
      if (why) { skipped.push(`${k} ${why}`); continue; }
      targets.push({ key: k, label: convLabelV2(k, st), silenceMinutes: Math.round(silence), lastLines: chatLinesV2(st, 0, 10),
        ...(outside ? { outside: true, note: '普通群，不是家里人：只想跟群里最近聊的、大家都能接的事，别带私聊和家里群的事' } : {}) });
    }
    if (!targets.length) {
      if (skipped.length) log(`[主动找人] 这次不找：${skipped.join('；')}`);
      return null;
    }
    initiateThinking = true;
    try {
      const day = lifeDayV2(now);
      // 家里以外的群单独想：不给“今天想”和心情的原因（大群看不到这些）
      const thoughts = [];
      for (const outside of [false, true]) {
        const group = targets.filter((t) => !!t.outside === outside);
        if (!group.length) continue;
        const data = await extrasPostV2('/proactive/think', {
          targets: group.map(({ outside: _o, ...t }) => t),
          mood: moodTextNowV2(now, !outside),
          plan: !outside && L.plan?.date === day ? planTextV2(L.plan) : [],
          now: whenV2(now),
        }, lifeCfgV2().timeoutMs);
        thoughts.push(...(Array.isArray(data.thoughts) ? data.thoughts : []).filter((t) => group.some((g) => g.key === String(t?.key))));
      }
      const thresholdOf = (k) => initiateCfgFor(c, k).threshold;
      log(`[主动找人] 想了想：${thoughts.map((t) => `${t.key} ${t.score}/${thresholdOf(String(t.key))} ${t.kind}「${t.thought}」`).join('；') || '没想到什么'}${skipped.length ? `（没考虑：${skipped.join('；')}）` : ''}`);
      const best = bestThought(thoughts, thresholdOf, targets.map((t) => t.key));
      if (!best) return null;
      const st = socialV2.conversations.get(best.key);
      if (!st || isConversationBusyV2(best.key, st) || isNightSleepV2()) {
        log(`[主动找人] ${best.key} 想完的时候不方便了，算了`);
        return null;
      }
      const at = Date.now();
      L.initiates = [...L.initiates, { key: best.key, at, thought: String(best.thought).slice(0, 60), kind: best.kind, score: best.score, sent: false }].slice(-50);
      st.initiateThought = { thought: String(best.thought).slice(0, 60), kind: best.kind, at };
      saveSocialV2State();
      log(`[主动找人] 想去 ${best.key} 说：${best.thought}（${best.score}）`);
      await sendWakePromptV2(best.key, 'initiate');
      return best;
    } catch (error) {
      log(`[主动找人] 想的时候出错：${error?.message ?? error}`);
      return null;
    } finally {
      initiateThinking = false;
    }
  }

  return {
    exports: {
      appraiseChatMoodV2,
      appraiseMoodV2,
      chatLinesV2,
      extrasPostV2,
      personaBriefV2,
      withSelfV2,
      initiateCfgV2,
      initiateTickV2,
      innerLifeTurnEndedV2,
      lifeCfgV2,
      lifeDayV2,
      lifeLinesV2,
      lifeTickV2,
      loadLifeV2,
      moodEngineCfgV2,
      moodTextNowV2,
      noteMemoryNoteCallV2,
      noteMemoryNoteResultV2,
      refreshLifeViewV2,
      updateThreadsV2,
    },
    link() {
      ({
        FREE_TIME_REASONS, MOOD_STALE_MS, convLabelV2, crossSessionSummaryOnlyV2, emptyLifeV2,
        whenV2, isConversationBusyV2, isNightSleepV2, isOutsideGroupKeyV2, minutesRangeV2,
        nightCfgOkV2, nightOwnerAwakeUntil, replyOnlyGroupV2, saveSocialV2State, sendWakePromptV2,
        sleepStateV2, socialV2
      } = app);
    },
    start() {
    app.scheduler.every('life-view', 60 * 1000, refreshLifeViewV2);
    app.scheduler.every('life', 60 * 1000, lifeTickV2);
    app.scheduler.every('initiate', 60 * 1000, initiateTickV2);
    },
  };
}
