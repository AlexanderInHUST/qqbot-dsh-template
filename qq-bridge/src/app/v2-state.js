// 二代会话状态：每个会话的状态、唤醒配置默认值、读写 state/social-v2.json
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sanitizeForwardId } from '../forward.js';
import { DynamicReplyGate } from '../reply-gate.js';

export function createV2State(app) {
  const {
    PLAY_KEY, SOCIAL_V2_FILE, atomicWriteJson, canonicalV2Key, cfg, log, readJsonSafe,
    rememberAgentToken, sendToQQ
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let PLAY_LOG_MAX, READ_PAGES_MAX, backfillPlaySessionsV2, loadLifeV2, scheduleProactiveCheckV2,
    setupSleepTimerV2;

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
    freeTimeHistory: [], // qqbot_agent：最近几次自由时间各玩了什么 [{ at, key, kinds: { 活动id: 样数 } }]
    watchedVideos: [], // qqbot_agent：最近用 bili_watch 看过的视频 [{ bvid, title, at }]，自由时间提示里列出来免得重看
    readPages: [], // qqbot_agent：自由时间读过的文章、帖子 [{ page, title, at }]，再打开就提醒她看过了
    selfAvatar: null, // qqbot_agent：她自己的 QQ 头像 { hash, desc, at }，desc 写进每次唤醒的身份行
    proactiveNextAt: 0, // qqbot_agent：下次自由时间检查的时间，存盘，免得每次重启都重新等 1~2 小时
    playShares: [], // qqbot_agent：自由时间往聊天里分享的记录 [{ key, at, lastAt, asked? }]，见 playShareGateV2
    // qqbot_agent：她“现在怎么样”的全局状态（所有会话共用一份，见 selfNowBlockV2）
    mood: null, // 心情 { text, why, at, key, source: 'self'（她用 qq_set_mood 定的）| 'auto'（moodEngine 体会的，带 valence/arousal） }
    // qqbot_agent：她自己的生活（见 src/inner-life.js、extras/life.py）
    life: emptyLifeV2(),
    sleptAt: 0, // 她用 qq_go_to_sleep 说了要去睡的时间（提前睡，或夜里被叫醒后接着睡），睡到下一个起床时间
    sleptKey: '', // 在哪个会话说的
    upLateAt: 0, // 夜里陪主人聊到的最后时间（nightSleep.vary：熬夜了第二天起得晚）
    playLog: [], // 自由时间玩过的东西（跨轮次，存盘）[{ at, what }]，最近几小时
    playStartedAt: 0, // 最近一次自由时间开始 / 结束的时间
    playEndedAt: 0,
    lastPlaySay: null, // 最近一次玩完心里想的 { at, text }
    replyGates: Object.create(null), // qqbot_agent：群聊回复门控的一小时窗口 key -> DynamicReplyGate，见 replyGateOfV2
    reminders: [], // qqbot_agent：她用 qq_remind_me 记的“待会儿要做的事” [{ id, key, note, at, due, firedAt?, shownAt? }]，见 reminderTickV2
    playSessions: [], // qqbot_agent：每次自由时间的起止 [{ start, end, reason }]，最近 36 小时，【你现在】里列“今天上电脑玩了几回”
    selfClaims: [], // qqbot_agent：她在各处说过的自己的事 [{ at, key, text }]（selfCheck 从她发的话里抽的），见 selfClaimsLineV2
    tellNotes: [], // qqbot_agent：别的窗口捎来、还没给那边看过的话 [{ id, from, to, note, at }]，见 tell-myself.js
    playHold: null, // qqbot_agent：答应了先不玩 { from, at, until, note? }，到 until 前不去自由时间，见 playHoldV2
  };
  const REMINDERS_MAX = 60;
  const PLAY_SESSIONS_MAX = 30;
  const PLAY_SESSIONS_KEEP_MS = 36 * 3600 * 1000;
  const SELF_CLAIMS_MAX = 60;
  const SELF_CLAIMS_KEEP_MS = 36 * 3600 * 1000;
  let selfAvatarImage = null; // 最近一次拉到的头像字节 { buffer, mimeType }（只在内存里）

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”
  }

  // qqbot_agent：系统提示（出错、已停止、回复被拦截、消息未被接受……）只私聊发给 ownerQQ，
  // 不发到群里或别人的私聊；不是主人自己的会话时注明是哪个会话。同一条 10 分钟内只发一次，免得刷屏。
  const ownerNoticeSentAt = new Map();
  async function notifyOwnerOnly(key, text) {
    const owner = cfg.ownerQQ;
    if (!owner) { log(`[notice] 没有设置 ownerQQ，丢弃系统提示 (${key})：${text}`); return; }
    const ownerKey = `private:${owner}`;
    const body = key === ownerKey ? text : `${text}\n（来自会话 ${key}）`;
    const last = ownerNoticeSentAt.get(body) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    ownerNoticeSentAt.set(body, Date.now());
    try { await sendToQQ(ownerKey, body); } catch (error) { log(`[notice] 发给 ownerQQ 失败：${error?.message ?? error}`); }
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: key === PLAY_KEY,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      socialV2.freeTimeHistory = Array.isArray(raw?.freeTimeHistory) ? raw.freeTimeHistory.filter((h) => h && typeof h.kinds === 'object').slice(-20) : [];
      socialV2.watchedVideos = Array.isArray(raw?.watchedVideos) ? raw.watchedVideos.filter((v) => v && /^BV[0-9A-Za-z]{10}$/.test(String(v.bvid))).slice(-50) : [];
      socialV2.readPages = Array.isArray(raw?.readPages) ? raw.readPages.filter((p) => p && typeof p.page === 'string' && Number.isFinite(Number(p.at))).slice(-READ_PAGES_MAX) : [];
      socialV2.selfAvatar = raw?.selfAvatar && typeof raw.selfAvatar.hash === 'string' ? raw.selfAvatar : null;
      socialV2.playShares = Array.isArray(raw?.playShares) ? raw.playShares.filter((x) => x && typeof x.key === 'string' && Number.isFinite(Number(x.at))).slice(-100) : [];
      socialV2.mood = raw?.mood && typeof raw.mood.text === 'string' && Number.isFinite(Number(raw.mood.at)) ? { text: raw.mood.text.slice(0, 20), why: String(raw.mood.why || '').slice(0, 60), at: Number(raw.mood.at), key: String(raw.mood.key || ''), source: raw.mood.source === 'auto' ? 'auto' : 'self', ...(raw.mood.source === 'auto' ? { valence: Number(raw.mood.valence) || 0, arousal: Number(raw.mood.arousal) || 0 } : {}) } : null;
      socialV2.life = loadLifeV2(raw?.life);
      socialV2.reminders = Array.isArray(raw?.reminders) ? raw.reminders.filter((r) => r && typeof r.key === 'string' && typeof r.note === 'string' && Number.isFinite(Number(r.due))).slice(-REMINDERS_MAX) : [];
      socialV2.sleptAt = Number(raw?.sleptAt) > 0 && Number(raw.sleptAt) <= Date.now() ? Number(raw.sleptAt) : 0;
      socialV2.sleptKey = String(raw?.sleptKey || '');
      socialV2.upLateAt = Number(raw?.upLateAt) > 0 && Number(raw.upLateAt) <= Date.now() ? Number(raw.upLateAt) : 0;
      socialV2.playLog = Array.isArray(raw?.playLog) ? raw.playLog.filter((x) => x && typeof x.what === 'string' && Number.isFinite(Number(x.at))).slice(-PLAY_LOG_MAX) : [];
      socialV2.playStartedAt = Number(raw?.playStartedAt) || 0;
      socialV2.playEndedAt = Number(raw?.playEndedAt) || 0;
      socialV2.playSessions = Array.isArray(raw?.playSessions)
        ? raw.playSessions.filter((x) => x && Number(x.start) > 0).map((x) => ({ start: Number(x.start), end: Number(x.end) || 0, reason: String(x.reason || '') })).slice(-PLAY_SESSIONS_MAX)
        : backfillPlaySessionsV2(); // 升级前没记：从 freeTimeHistory 和 playLog 推一份
      socialV2.selfClaims = Array.isArray(raw?.selfClaims) ? raw.selfClaims.filter((x) => x && typeof x.text === 'string' && Number(x.at) > 0).slice(-SELF_CLAIMS_MAX) : [];
      socialV2.tellNotes = Array.isArray(raw?.tellNotes) ? raw.tellNotes.filter((x) => x && typeof x.to === 'string' && typeof x.note === 'string' && Number(x.at) > 0).slice(-30) : [];
      socialV2.playHold = raw?.playHold && Number(raw.playHold.until) > Date.now() ? { from: String(raw.playHold.from || ''), at: Number(raw.playHold.at) || 0, until: Number(raw.playHold.until), ...(raw.playHold.note ? { note: String(raw.playHold.note).slice(0, 150) } : {}) } : null;
      socialV2.lastPlaySay = raw?.lastPlaySay && typeof raw.lastPlaySay.text === 'string' ? { at: Number(raw.lastPlaySay.at) || 0, text: raw.lastPlaySay.text.slice(0, 300) } : null;
      socialV2.replyGates = Object.create(null);
      for (const [k, g] of Object.entries(raw?.replyGates && typeof raw.replyGates === 'object' ? raw.replyGates : {})) {
        if (/^group:\d+$/.test(k)) socialV2.replyGates[k] = DynamicReplyGate.fromJSON(g);
      }
      // 离谱的值（比如改过系统时间）不认，按没存过处理
      const savedNextAt = Number(raw?.proactiveNextAt);
      socialV2.proactiveNextAt = Number.isFinite(savedNextAt) && savedNextAt > 0 && savedNextAt < Date.now() + 12 * 3600 * 1000 ? savedNextAt : 0;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key) && key !== PLAY_KEY) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          flushSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // 2026-10-24：以前每收一条消息、每改一个计数都同步写一遍整个文件（三百多 KB、八十多处调用），
  // 现在先记“脏了”，`socialV2.stateSaveDelayMs`（默认 1000，0 回到马上写）后写一次；这段时间里再改不推迟。
  // 退出、重启前、要马上读回文件的地方调 flushSocialV2State()。
  let saveTimer = null;
  function saveSocialV2State() {
    const raw = Number(cfg.socialV2?.stateSaveDelayMs);
    const delay = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60000) : 1000;
    if (delay === 0) { flushSocialV2State(); return; }
    if (saveTimer) return;
    saveTimer = setTimeout(flushSocialV2State, delay);
    saveTimer?.unref?.();
  }

  function flushSocialV2State() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      const obj = { paused: socialV2.paused, freeTimeHistory: socialV2.freeTimeHistory.slice(-20), watchedVideos: socialV2.watchedVideos, readPages: (socialV2.readPages || []).slice(-READ_PAGES_MAX), selfAvatar: socialV2.selfAvatar, proactiveNextAt: socialV2.proactiveNextAt, playShares: (socialV2.playShares || []).slice(-100), mood: socialV2.mood, sleptAt: socialV2.sleptAt || 0, sleptKey: socialV2.sleptKey || '', upLateAt: socialV2.upLateAt || 0, playLog: (socialV2.playLog || []).slice(-PLAY_LOG_MAX), playStartedAt: socialV2.playStartedAt || 0, playEndedAt: socialV2.playEndedAt || 0, lastPlaySay: socialV2.lastPlaySay, replyGates: socialV2.replyGates, life: socialV2.life, reminders: (socialV2.reminders || []).slice(-REMINDERS_MAX), playSessions: (socialV2.playSessions || []).slice(-PLAY_SESSIONS_MAX), selfClaims: (socialV2.selfClaims || []).slice(-SELF_CLAIMS_MAX), tellNotes: (socialV2.tellNotes || []).slice(-30), playHold: socialV2.playHold || null, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }function emptyLifeV2() {
    return { moodAppraisedAt: {}, moodLog: [], interest: {}, initiates: [], initiateNextAt: 0, planDate: '', planTriedAt: 0, plan: null, planCheckedAt: {}, diaryDate: '', diaryTriedAt: 0, diary: null, threads: [], threadsAt: 0, dayPlay: [] };
  }

  return {
    exports: {
      PLAY_SESSIONS_KEEP_MS,
      PLAY_SESSIONS_MAX,
      REMINDERS_MAX,
      SELF_CLAIMS_KEEP_MS,
      SELF_CLAIMS_MAX,
      computeWakeSafetyV2,
      defaultWakeConfigV2,
      emptyLifeV2,
      ensureWakeableV2,
      getSocialV2State,
      isSleepingConfigV2,
      loadSocialV2State,
      messageMediaStore,
      normalizeSpeakerIdsV2,
      notifyOwnerOnly,
      pickWakeTriggersV2,
      refreshAllDefaultWakeConfigsV2,
      saveSocialV2State,
      flushSocialV2State,
      seenForwardIds,
      get selfAvatarImage() { return selfAvatarImage; },
      set selfAvatarImage(value) { selfAvatarImage = value; },
      socialV2,
    },
    link() {
      ({
        PLAY_LOG_MAX, READ_PAGES_MAX, backfillPlaySessionsV2, loadLifeV2, scheduleProactiveCheckV2,
        setupSleepTimerV2
      } = app);
    },
    start() {
    loadSocialV2State();
    },
  };
}
