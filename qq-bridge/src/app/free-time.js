// 自由时间（play:main）：玩多久、劝说、看过的页面和视频、往聊天里分享的限频
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { activities as freeTimeActivities, activityOf, ideasText, pickActivities, varietyHint } from '../free-time.js';
import { activityMultipliers } from '../inner-life.js';

export function createFreeTime(app) {
  const {
    PLAY_KEY, api, cfg, log
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let PLAY_SESSIONS_KEEP_MS, PLAY_SESSIONS_MAX, convLabelV2, whenV2, isConversationBusyV2,
    isNightSleepV2, lifeCfgV2, moodEngineCfgV2, playHoldV2, replyOnlyGroupV2, saveSocialV2State, socialV2;

  // qqbot_agent：自由时间（主动机会唤醒）。只要这段时间里没人来找、她也没发言，就算还在“自己玩”。
  const FREE_TIME_REASONS = new Set(['proactiveCheck', 'goPlay']);
  function freeTimeQuietV2(st) {
    const ft = st?.freeTime;
    if (!ft || !FREE_TIME_REASONS.has(st.lastWakeReason)) return false;
    if ((st.lastIncomingAt || 0) > ft.startedAt) return false;
    if ((st.lastAiReplyAt || 0) > ft.startedAt) return false;
    return true;
  }

  // qqbot_agent：每次自由时间随机定一个“这次至少玩多久”，默认 40~90 分钟（socialV2.proactive.sessionMinutes: [最少, 最多]）。
  // 时间由 bridge 掐，不告诉她：没到时间想走就劝她接着玩（不说还差多久）。以前按“看几样”（4~8 样）算，
  // 她一样东西不到一分钟，七八分钟就收尾了。到了这个时间 bridge 插一句【可以歇了】，什么时候走才由她定；
  // 玩满 maxSessionMinutes（默认 180）或到了睡觉时间会再提醒她收尾。
  function minutesRangeV2(value, fallback) {
    const range = Array.isArray(value) ? value : fallback;
    const lo = Math.max(0, Number(range[0]) || 0);
    const hi = Math.max(lo, Number(range[1]) || lo);
    return lo + Math.random() * (hi - lo);
  }
  function freeTimeMaxMsV2() {
    return Math.max(1, Number(cfg.socialV2?.proactive?.maxSessionMinutes) || 180) * 60000;
  }
  function freeTimeMinUntilV2(now) {
    const minutes = minutesRangeV2(cfg.socialV2?.proactive?.sessionMinutes, [40, 90]);
    return now + Math.min(minutes * 60000, freeTimeMaxMsV2());
  }

  // qqbot_agent：每次自由时间的起止。以前【你现在】只有最近一次的起止，10-23 她玩了 5 回，晚上主人问“你去玩了一整天一样”，
  // 她只看得到 20:38~20:59 那回，就说“就晚上玩了一阵”。
  function notePlaySessionV2(kind, at, reason = '') {
    if (!Array.isArray(socialV2.playSessions)) socialV2.playSessions = [];
    const list = socialV2.playSessions;
    const last = list.at(-1);
    if (kind === 'start') {
      if (last && !last.end) last.end = Math.max(last.start, Number(socialV2.playLog?.at(-1)?.at) || last.start); // 上一回没记到结束（重启）
      list.push({ start: at, end: 0, reason });
    } else if (last && !last.end) {
      last.end = at;
    }
    socialV2.playSessions = list.filter((x) => at - Number(x.end || x.start) < PLAY_SESSIONS_KEEP_MS).slice(-PLAY_SESSIONS_MAX);
  }
  function backfillPlaySessionsV2(now = Date.now()) {
    const starts = (socialV2.freeTimeHistory || []).filter((h) => h.key === PLAY_KEY && now - Number(h.at) < PLAY_SESSIONS_KEEP_MS).map((h) => Number(h.at)).sort((a, b) => a - b);
    const items = [...(socialV2.life?.dayPlay || []), ...(socialV2.playLog || [])].map((x) => Number(x.at)).filter(Number.isFinite);
    return starts.map((start, i) => {
      const next = starts[i + 1] ?? Infinity;
      const inside = items.filter((t) => t >= start && t < next);
      const ongoing = i === starts.length - 1 && socialV2.playStartedAt === start && !socialV2.playEndedAt;
      const end = ongoing ? 0 : (socialV2.playStartedAt === start && socialV2.playEndedAt >= start ? socialV2.playEndedAt : Math.max(start, ...inside));
      return { start, end, reason: '' };
    });
  }
  // 起床以后的几回（还在玩的那回 end 是 0）
  function todayPlaySessionsV2(sleep, now = Date.now()) {
    if (sleep.kind !== 'awake' || !sleep.wokeAt) return [];
    return (socialV2.playSessions || []).filter((x) => Number(x.start) >= sleep.wokeAt && Number(x.start) <= now);
  }
  function playSessionsTextV2(list) {
    return list.map((x) => (x.end ? `${whenV2(x.start)}~${whenV2(x.end)}` : `${whenV2(x.start)} 起到现在`)).join('、');
  }

  // qqbot_agent：开始一次自由时间：定好这次大概玩几样，抽几个“念头”，在全局历史里记一条（玩了什么边玩边记）。
  function startFreeTimeV2(key, now, reason = 'proactiveCheck') {
    const list = freeTimeActivities(cfg);
    // qqbot_agent：她喜欢的那类、合心情的那类权重高一点（life.interest / moodEngine.couplePlay）
    const me = moodEngineCfgV2();
    const lc = lifeCfgV2();
    const mult = activityMultipliers(list, { interest: socialV2.life.interest, mood: socialV2.mood, now: Date.now(), halfLifeMin: me.halfLifeMinutes, useInterest: lc.enabled && lc.interest, useMood: me.enabled && me.couplePlay });
    const ideas = pickActivities(list, socialV2.freeTimeHistory, 3, Math.random, mult);
    if (Object.keys(mult).length) log(`[生活] 自由时间念头权重：${Object.entries(mult).map(([k, v]) => `${k}×${v}`).join(' ')}`);
    const entry = { at: now, key, kinds: {} };
    socialV2.freeTimeHistory.push(entry);
    if (socialV2.freeTimeHistory.length > 20) socialV2.freeTimeHistory = socialV2.freeTimeHistory.slice(-20);
    socialV2.playStartedAt = now;
    socialV2.playEndedAt = 0;
    notePlaySessionV2('start', now, reason);
    log(`[freeTime] ${key} 这次的念头：${ideas.map((x) => x.name).join(' / ') || '（无）'}`);
    // 有人托她去办的事（goPlay）办完就行，不劝她多玩；托的时候说好了要多玩一会儿（minutes）的，按说好的时间劝
    const ft = { startedAt: now, reason, minUntil: reason === 'proactiveCheck' ? freeTimeMinUntilV2(now) : 0, seen: 0, items: [], seenUrls: [], nudges: 0, ideas: ideas.map((x) => x.id), kinds: entry.kinds, currentPage: '', plays: {} };
    if (reason === 'goPlay') {
      const play = socialV2.conversations.get(PLAY_KEY);
      for (const r of pendingPlayRequestsV2(play, now)) if (r.minutes) extendFreeTimeV2(ft, r, now);
    }
    return ft;
  }

  // qqbot_agent：qq_go_play 的 minutes（“接着玩”“多玩玩”时她填的大概几分钟），夹在 [3, 60]；没填或 0 = 办完就走
  function goPlayMinutesV2(value) {
    const n = Math.round(Number(value) || 0);
    return n > 0 ? Math.min(60, Math.max(3, n)) : 0;
  }
  function pendingPlayRequestsV2(play, now = Date.now()) {
    return (Array.isArray(play?.playRequests) ? play.playRequests : []).filter((r) => r && !r.done && now - Number(r.at) < 6 * 3600 * 1000);
  }
  // 按托的时候说好的时间延长这次自由时间：没到时间想走就劝（freeTimeTooShortV2），到了插【可以歇了】；
  // 玩满上限的【玩了好久了】也往后推，免得刚说好多玩一会儿就被叫停
  function extendFreeTimeV2(ft, request, now = Date.now()) {
    const until = now + request.minutes * 60000;
    if (until > (Number(ft.minUntil) || 0)) {
      ft.minUntil = until;
      ft.restOfferSent = false;
    }
    ft.curfewAt = Math.max(Number(ft.curfewAt) || 0, until + 15 * 60000);
    ft.asked = [...(Array.isArray(ft.asked) ? ft.asked : []), { from: request.from, note: request.note }].slice(-3);
  }
  // 那边正在玩的时候托过去（steer）：在当前这次自由时间上延长；当前是“办完就走”的也一样
  function extendFreeTimeForRequestV2(playSt, request) {
    if (!playSt?.freeTime || !FREE_TIME_REASONS.has(playSt.lastWakeReason)) return;
    extendFreeTimeV2(playSt.freeTime, request);
    log(`[freeTime] 托的时候说好多玩 ${request.minutes} 分钟，这次自由时间往后延`);
  }
  function freeTimeCurfewAtV2(ft) {
    return Math.max(Number(ft.startedAt) + freeTimeMaxMsV2(), Number(ft.curfewAt) || 0);
  }

  // 自由时间里每“真的看了一样东西”记一次：看完一个视频（bili_watch）、看一批沙雕图（tg_look）、
  // 在 B 站以外点进一个新的内容页（例如一篇新闻、一个词条）、查一次东西（web_search / web_fetch），
  // 或者在同一个网页上连着操作了 8 下（玩小游戏：按键、点击都不换页）。首页、空白页、重复的页面不算。
  const FREE_TIME_PLAY_STEPS = 8;

  // 读过的文章、帖子（2026-10-23）：以前只记视频，网页一篇都不记。10-22 浏览器挂了她改用 web_fetch，
  // 会话一两分钟压缩一次，每压一次就回果壳首页再点开同样几篇，一篇读了六遍。现在自由时间点开的内容页
  // （和 web_fetch 抓的）记进 socialV2.readPages，存 socialV2.proactive.readPages 天（默认 14，0 关）；
  // 再打开上次自由时间、或半小时前就读过的，往这一轮里插一句【看过了】（每页一次），这页也不算新看的一样。
  // 小游戏、热榜、天文图的页面每天在变或本来就是反复玩的，不管；栏目列表页（index、list…）也不管。
  const READ_PAGES_MAX = 200;
  const READ_PAGE_FRESH_MS = 30 * 60 * 1000;
  const READ_PAGE_SKIP_KINDS = new Set(['game', 'hot', 'space']);
  function readPagesDaysV2() {
    const d = Number(cfg.socialV2?.proactive?.readPages ?? 14);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }
  // 能算“一篇”的页面才返回 key（host + path + query），首页、语言首页、列表页、B 站、游戏站返回 ''
  function readPageKeyV2(u) {
    if (!u || !/^https?:$/.test(u.protocol)) return '';
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length || (segs.length === 1 && /^[a-z]{2}([-_][a-z]{2,4})?$/i.test(segs[0]) && !u.search)) return '';
    if (/^(index|list|default|home|latest|new|hot|top)\d*(\.\w+)?$/i.test(segs[segs.length - 1])) return '';
    if (/(^|\.)bilibili\.com$/.test(u.hostname)) return '';
    if (READ_PAGE_SKIP_KINDS.has(activityOf(freeTimeActivities(cfg), { host: u.hostname }))) return '';
    return `${u.hostname}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  }
  // 返回 true：这页以前读过（已经提醒过她），不算新看的一样
  function noteReadPageV2(key, st, page, title) {
    const days = readPagesDaysV2();
    if (!days || !page) return false;
    const ft = st.freeTime;
    const now = Date.now();
    const list = (socialV2.readPages || []).filter((p) => Number(p.at) >= now - days * 86400000);
    const prior = list.find((p) => p.page === page);
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    let again = false;
    if (!prior) list.push({ page, title: clean, at: now });
    else {
      if (clean && !prior.title) prior.title = clean;
      if (Number(prior.at) < Number(ft.startedAt) || now - Number(prior.at) > READ_PAGE_FRESH_MS) {
        again = true;
        ft.readWarned = Array.isArray(ft.readWarned) ? ft.readWarned : [];
        if (!ft.readWarned.includes(page)) {
          ft.readWarned.push(page);
          void steerReadBeforeV2(key, prior);
        }
      }
    }
    socialV2.readPages = list.slice(-READ_PAGES_MAX);
    return again;
  }
  async function steerReadBeforeV2(key, prior) {
    const sessionId = app.state.sessions?.[key];
    if (!sessionId) return;
    const what = prior.title ? `《${prior.title}》` : '这一页';
    const text = `【看过了】${what}你 ${whenV2(prior.at)} 就看过了，不用再看、再记一遍，也别再当新鲜事跟人讲；换一篇没看过的吧。`;
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
      log(`[freeTime] ${key} 又打开了看过的 ${prior.page}，提醒她看过了（${accepted?.result?.ok ? '已插话' : '插话没被接受'}）`);
    } catch (error) {
      log(`[freeTime] 提醒“看过了”失败：${error?.message ?? error}`);
    }
  }
  function webFetchPageV2(resultText) {
    let r = null;
    try { r = JSON.parse(String(resultText || '')); } catch { return null; }
    if (!r || typeof r.url !== 'string' || Number(r.statusCode) !== 200) return null;
    let u = null;
    try { u = new URL(r.url); } catch { return null; }
    const raw = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(String(r.body || ''))?.[1] ?? '';
    const title = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");
    return { page: readPageKeyV2(u), title };
  }
  function readPagesLineV2() {
    if (!readPagesDaysV2()) return '';
    const list = (socialV2.readPages || []).slice(-15).reverse().map((p) => (p.title ? `《${p.title}》` : p.page.slice(0, 60)));
    return list.length ? `最近看过的文章、帖子（再刷到就跳过）：${list.join('、')}\n` : '';
  }

  function noteFreeTimeViewV2(key, toolName, resultText) {
    if (String(toolName || '').endsWith('__bili_watch')) noteWatchedVideoV2(resultText);
    const st = socialV2.conversations.get(key);
    const ft = st?.freeTime;
    if (!ft || !FREE_TIME_REASONS.has(st.lastWakeReason)) return;
    const name = String(toolName || '');
    const list = freeTimeActivities(cfg);
    let item = '';
    let kind = '';
    let fetchedTitle = '';
    if (name.endsWith('__bili_watch')) { item = 'bili'; kind = activityOf(list, { tool: name }); }
    else if (name.endsWith('__tg_look')) {
      // 连着看的一批沙雕图（30 秒内）只算一样，免得她拿便宜的图凑数
      const now = Date.now();
      const batch = ft.lastTgAt && now - ft.lastTgAt < 30 * 1000;
      ft.lastTgAt = now;
      if (batch) { saveSocialV2State(); return; }
      item = 'tg';
      kind = activityOf(list, { tool: name });
    }
    else if (/__web_(search|fetch)$/.test(name)) {
      if (name.endsWith('__web_fetch')) {
        const fetched = webFetchPageV2(resultText);
        if (fetched?.page && noteReadPageV2(key, st, fetched.page, fetched.title)) { saveSocialV2State(); return; }
        fetchedTitle = String(fetched?.title || '').trim().slice(0, 60);
      }
      item = 'search';
      kind = activityOf(list, { tool: name });
    }
    else if (/__browser_(navigate|navigate_back|click|press_key|type)$/.test(name)) {
      const m = /Page URL:\s*(\S+)/.exec(String(resultText || ''));
      let u = null;
      if (m) { try { u = new URL(m[1]); } catch { u = null; } }
      if (u && !/^https?:$/.test(u.protocol)) return;
      const page = u ? `${u.hostname}${u.pathname.replace(/\/+$/, '')}${u.search}` : '';
      const changed = page && page !== ft.currentPage;
      const isNew = changed && !(ft.seenUrls || []).includes(page);
      if (page) ft.currentPage = page;
      // 标题给【你现在】里“今天在电脑上”用（网址的查询串里可能有 token，不往外写）
      const pageTitle = String(/- Page Title:\s*(.+)/.exec(String(resultText || ''))?.[1] || '').trim().slice(0, 60);
      if (changed) ft.currentTitle = pageTitle;
      else if (pageTitle) ft.currentTitle = pageTitle;
      const host = page ? u.hostname : ft.currentPage.split('/')[0];
      if (!host || /(^|\.)bilibili\.com$/.test(host)) return; // B 站的视频由 bili_watch 计数
      if (changed && noteReadPageV2(key, st, readPageKeyV2(u), pageTitle)) {
        saveSocialV2State();
        return;
      }
      if (isNew) {
        const segs = u.pathname.split('/').filter(Boolean);
        // 网站首页、语言首页（/zh、/en-us）不算一样东西
        if (!segs.length || (segs.length === 1 && /^[a-z]{2}([-_][a-z]{2,4})?$/i.test(segs[0]) && !u.search)) return;
        ft.seenUrls = Array.isArray(ft.seenUrls) ? ft.seenUrls : [];
        ft.seenUrls.push(page);
        item = 'page';
      } else {
        // 没换页的操作：在玩这个页面（小游戏、地图、翻图）
        if (/__navigate(_back)?$/.test(name)) return;
        const at = ft.currentPage;
        if (!at) return;
        ft.plays = ft.plays && typeof ft.plays === 'object' ? ft.plays : {};
        ft.plays[at] = (ft.plays[at] || 0) + 1;
        if (ft.plays[at] % FREE_TIME_PLAY_STEPS !== 0) return;
        item = 'play';
      }
      kind = activityOf(list, { host });
    }
    if (!item) return;
    ft.seen = (ft.seen || 0) + 1;
    ft.items = Array.isArray(ft.items) ? ft.items : [];
    ft.items.push({ at: Date.now(), what: freeTimeItemTextV2(item, name, resultText, ft.currentPage, item === 'search' ? fetchedTitle : ft.currentTitle) });
    if (ft.items.length > 30) ft.items = ft.items.slice(-30);
    notePlayLogV2(ft.items[ft.items.length - 1]);
    if (kind && ft.kinds) ft.kinds[kind] = (ft.kinds[kind] || 0) + 1;
    if (kind) ft.lastKind = kind;
    saveSocialV2State();
    log(`[freeTime] ${key} 看了第 ${ft.seen} 样（${item}${kind ? `·${kind}` : ''}），玩了 ${Math.round((Date.now() - ft.startedAt) / 60000)}/${Math.round(((Number(ft.minUntil) || ft.startedAt) - ft.startedAt) / 60000)} 分钟`);
  }

  // 自由时间玩过的东西，跨轮次存盘（st.freeTime 每轮重开、重启就没了），给【你现在】和【别处的事】用
  // 留一整个白天：【你现在】里列“今天在电脑上”（以前只留 6 小时、只写最后一样，被问今天干了啥她只好拿别处讲过的旧事凑）
  const PLAY_LOG_MAX = 150;
  const PLAY_LOG_KEEP_MS = 20 * 3600 * 1000;
  const PLAY_LAST_ITEM_MS = 6 * 3600 * 1000;
  function notePlayLogV2(item) {
    if (!item?.what) return;
    const since = Date.now() - PLAY_LOG_KEEP_MS;
    socialV2.playLog = [...(socialV2.playLog || []).filter((x) => Number(x.at) >= since), { at: item.at, what: item.what }].slice(-PLAY_LOG_MAX);
    // 日记要整整 24 小时的
    if (lifeCfgV2().enabled && lifeCfgV2().diary) {
      const day = Date.now() - 86400000;
      socialV2.life.dayPlay = [...socialV2.life.dayPlay.filter((x) => Number(x.at) >= day), { at: item.at, what: item.what }].slice(-120);
    }
  }

  // 记下看过的视频（不管是不是自由时间），只留最近 socialV2.proactive.watchedVideos 个（默认 20）
  // 分工（2026-10-24 定）：“看没看过”以 extras /data/bili-watched.json 为准（500 个，bili_watch 自己拦重看）；
  // 这里只是给唤醒提示列一行“最近看过的”用的小缓存，唤醒提示是同步拼的，不去问 extras。
  function noteWatchedVideoV2(resultText) {
    const text = String(resultText || '');
    const bvid = /"bvid"\s*:\s*"(BV[0-9A-Za-z]{10})"/.exec(text)?.[1];
    if (!bvid) return;
    let title = '';
    const m = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (m) { try { title = String(JSON.parse(m[1])); } catch { title = ''; } }
    const keep = Math.max(0, Math.floor(Number(cfg.socialV2?.proactive?.watchedVideos ?? 20)));
    const list = (socialV2.watchedVideos || []).filter((v) => v.bvid !== bvid);
    list.push({ bvid, title: title.slice(0, 80), at: Date.now() });
    socialV2.watchedVideos = keep ? list.slice(-keep) : [];
    saveSocialV2State();
  }

  function watchedVideosLineV2() {
    const list = (socialV2.watchedVideos || []).slice().reverse();
    if (!list.length) return '';
    return `最近看过的视频（推荐里再刷到就跳过，别重看）：${list.map((v) => `${v.title ? `《${v.title}》` : ''}${v.bvid}`).join('、')}\n`;
  }

  // 给别的会话看的一句“刚才玩了什么”（【别处的事】）
  function freeTimeItemTextV2(item, toolName, resultText, page, title = '') {
    const text = String(resultText || '');
    if (item === 'bili') {
      const m = /(?:"title"\s*:\s*"|标题[:：]\s*)([^"\n]{1,60})/.exec(text);
      // 带上 BV 号：聊天那边被要链接时手里有（10-23 技术群“链接我没存”，随手发了别的视频，被说“你怎么骗我们”）
      const bvid = /"bvid"\s*:\s*"(BV[0-9A-Za-z]{10})"/.exec(text)?.[1];
      return `看了 B 站视频${m ? `《${m[1].trim()}》` : ''}${bvid ? `（${bvid}）` : ''}`;
    }
    if (item === 'tg') return '翻了 Telegram 上的沙雕图';
    if (item === 'search') return title ? `上网查东西，读了《${title}》` : '上网查了点东西';
    // 不带查询串：里面可能有 token（下厨房的人机验证页就带着）
    const host = String(page || '').split('/')[0];
    const where = String(page || '').split('?')[0].slice(0, 80);
    if (item === 'play') return title ? `在 ${host} 玩《${title}》` : `在 ${where} 玩了一阵`;
    return title ? `看了《${title}》（${host}）` : `看了 ${where}`;
  }

  // 没玩到这次定的时间就劝她接着玩，返回还差几分钟（只给 bridge 自己用，不告诉她）。
  // 睡觉时间不劝；连劝 3 次她都没再看任何东西（只是反复想走）就放她走；总共最多劝 FREE_TIME_MAX_NUDGES 次。
  const FREE_TIME_MAX_NUDGES = 40;
  function freeTimeTooShortV2(st) {
    if (!freeTimeQuietV2(st)) return 0;
    const ft = st.freeTime;
    const now = Date.now();
    const minUntil = Number(ft.minUntil) || 0;
    if (!minUntil || now >= minUntil || isNightSleepV2()) return 0;
    ft.stalls = ft.seen === ft.nudgeSeen ? (ft.stalls || 0) + 1 : 0;
    ft.nudgeSeen = ft.seen;
    if (ft.stalls >= 3 || (ft.nudges || 0) >= FREE_TIME_MAX_NUDGES) {
      saveSocialV2State();
      log(`[freeTime] 劝了也不玩了，放她走（${ft.stalls >= 3 ? '连着几次没再看东西' : '劝的次数到上限'}）`);
      return 0;
    }
    ft.nudges = (ft.nudges || 0) + 1;
    saveSocialV2State();
    return Math.ceil((minUntil - now) / 60000);
  }

  // 往正在玩的那一轮里插一句：到了这次定的时间说一声【可以歇了】（走不走她定）；玩满上限或到了睡觉时间让她收尾。
  // 两种各提醒一次。她不用自己琢磨什么时候该走：以前她每看完一样就想收尾，每样都只碰一下。
  async function freeTimeCurfewV2() {
    if (app.currentMode !== 'reserved2' || socialV2.paused) return;
    const st = socialV2.conversations.get(PLAY_KEY);
    const ft = st?.freeTime;
    if (!ft || ft.curfewSent || !FREE_TIME_REASONS.has(st.lastWakeReason) || !isConversationBusyV2(PLAY_KEY, st)) return;
    const now = Date.now();
    const night = isNightSleepV2();
    const curfew = night || now >= freeTimeCurfewAtV2(ft);
    const offer = !curfew && !ft.restOfferSent && Number(ft.minUntil) > 0 && now >= Number(ft.minUntil);
    if (!curfew && !offer) return;
    const sessionId = app.state.sessions?.[PLAY_KEY];
    if (!sessionId) return;
    if (curfew) ft.curfewSent = true;
    else ft.restOfferSent = true;
    saveSocialV2State();
    const markRead = `mcp__snowluma__qq_mark_read(key="${PLAY_KEY}", token=${st.agentToken})`;
    const text = night
      ? `【该睡觉了】已经到睡觉时间啦。手上这个看完就收尾：关掉多余的标签页，调用 ${markRead}，明天再玩。`
      : curfew
        ? `【玩了好久了】这次已经玩了很久，歇一会儿吧。手上这个看完就收尾：关掉多余的标签页，调用 ${markRead}，过一阵还会再有自由时间。`
        : `【可以歇了】玩了挺久了，想歇就把手上这个看完，关掉多余的标签页，调用 ${markRead}；还想玩就接着玩，玩到不想玩了再走。${askedFromLineV2(ft)}`;
    const what = night ? '到睡觉时间，提醒她收尾' : curfew ? '玩满上限，提醒她收尾' : '到了这次定的时间，告诉她可以歇了';
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
      log(`[freeTime] ${what}（${accepted?.result?.ok ? '已插话' : '插话没被接受'}）`);
    } catch (error) {
      log(`[freeTime] ${what}失败：${error?.message ?? error}`);
    }
  }

  function freeTimeIdeasLineV2(st) {
    const list = freeTimeActivities(cfg);
    const ideas = (st?.freeTime?.ideas || []).map((id) => list.find((x) => x.id === id)).filter(Boolean);
    const text = ideasText(ideas);
    const watched = watchedVideosLineV2() + readPagesLineV2();
    return text || watched ? `\n${text ? `${text}\n` : ''}${watched}` : '';
  }

  // 托她多玩一会儿的那几处：走之前回去说一声
  function askedFromLineV2(ft) {
    const keys = [...new Set((Array.isArray(ft?.asked) ? ft.asked : []).map((a) => a.from))];
    return keys.length ? `走之前给托你的${keys.map((k) => `${convLabelV2(k, socialV2.conversations.get(k))}（${k}）`).join('、')}说一声玩得怎么样，想给他们看就截张图。` : '';
  }

  function freeTimeNudgeTextV2(st) {
    // 不告诉她具体差几样：给了数字她就会挑最省事的东西凑数
    const ft = st?.freeTime || {};
    // 托的时候说好了要多玩一会儿：劝她接着玩那个，不劝她换口味
    if (Array.isArray(ft.asked) && ft.asked.length) {
      const a = ft.asked[ft.asked.length - 1];
      return `还早呢，说好了要多玩一会儿的：${a.note}。接着玩这个，别急着走；玩到好玩的地方截张图发回 ${a.from}（qq_send_screenshot），什么时候可以歇了会有人告诉你。`;
    }
    const list = freeTimeActivities(cfg);
    const ideas = (ft.ideas || []).map((id) => list.find((x) => x.id === id)).filter(Boolean);
    const change = varietyHint(list, ft.kinds, ideas);
    if (change) return `还早呢，没玩一会儿。${change}自由时间不是任务，没有要做完的事，也不用凑数，就是闲着。标签页开多了就顺手关掉几个。`;
    // 先劝她把刚才那样往深里玩（deep），玩腻了才换：以前只给“去玩下一样”，她每样都只碰一下
    const current = list.find((x) => x.id === ft.lastKind);
    const deeper = current?.deep ? `刚才${current.name}还能接着玩下去：${current.deep}` : '喜欢刚才那个就接着看下去';
    const untried = ideas.filter((x) => !(ft.kinds || {})[x.id]);
    const idea = untried.length ? untried[(ft.nudges || 0) % untried.length] : null;
    return `还早呢，没玩一会儿。自由时间不是任务，没有要做完的事，也不用凑数，就是闲着，记完一笔也不代表要走。接着玩吧：${deeper}${idea ? `；玩腻了再去${idea.name}（${idea.hint}）` : '；玩腻了再换个网站逛逛'}。什么时候可以歇了会有人告诉你，不用自己惦记。标签页开多了就顺手关掉几个。`;
  }
  // qqbot_agent：自由时间那边往聊天里分享（用 play 令牌发的话、截图、表情、沙雕图）的频率由 bridge 管。
  // 以前只靠提示词“一小时一两次”，2026-10-22 一天给爸爸私聊分享了 6 回，有两回隔了两分钟。
  // 一回分享 = 同一个会话 burstMinutes 内连着发的几条（说一句 + 截图算一回）。限制（socialV2.playShare）：
  //   每个会话两回之间至少 minIntervalMinutes，每个会话每天 perConversationPerDay 回，全部会话每天 globalPerDay 回，
  //   一次自由时间最多 perSession 回。有人从这个会话托她去看的（6 小时内的 playRequests）不算，办完照样能发回去。
  // 返回拒绝的理由；null 表示可以发。record=true 时放行就记一回（发失败了 burstMinutes 内重试算同一回，不会被拦）；
  // 沙雕图先只查（extras 还可能拒），真发出去了再 playShareGateV2(key, true) 记上。
  function playShareCfgV2() {
    const c = cfg.socialV2?.playShare ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled !== false,
      burstMs: Math.max(1, num(c.burstMinutes, 10)) * 60000,
      minIntervalMs: Math.max(0, num(c.minIntervalMinutes, 180)) * 60000,
      perConversationPerDay: Math.max(0, num(c.perConversationPerDay, 2)),
      globalPerDay: Math.max(0, num(c.globalPerDay, 4)),
      perSession: Math.max(0, num(c.perSession, 1)),
      byKey: c.byKey && typeof c.byKey === 'object' && !Array.isArray(c.byKey) ? c.byKey : {},
    };
  }
  // byKey 里给某一处单独写的 minIntervalMinutes / perConversationPerDay（比如不熟的群更少）
  function playShareCfgForV2(key) {
    const c = playShareCfgV2();
    const o = c.byKey[key];
    if (!o || typeof o !== 'object') return c;
    const num = (v) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      ...c,
      ...(num(o.minIntervalMinutes) !== null ? { minIntervalMs: Math.max(0, num(o.minIntervalMinutes)) * 60000 } : {}),
      ...(num(o.perConversationPerDay) !== null ? { perConversationPerDay: Math.max(0, num(o.perConversationPerDay)) } : {}),
    };
  }
  function playShareGateV2(key, record = true) {
    const c = playShareCfgForV2(key);
    const now = Date.now();
    const play = socialV2.conversations.get(PLAY_KEY);
    const asked = (Array.isArray(play?.playRequests) ? play.playRequests : []).some((r) => r.from === key && now - Number(r.at) < 6 * 3600 * 1000);
    const denied = (why, tail = '别人收到太多会烦。') => `这会儿先不发了：${why}。${tail}把它用 memory_note 记下来，以后聊天时自然提起就好；不要换个工具重试，接着玩。`;
    // 答应了先不玩（qq_tell_myself 的 stopPlay）：电脑那边不往聊天里发，聊天那边的她会自己跟大家说
    if (playHoldV2()) {
      log(`[reserved2] 自由时间分享被拦 ${key}：答应了先不玩`);
      return denied('你答应了先不玩了，聊天那边的你会跟大家说', '');
    }
    // socialV2.replyOnlyGroups：这些群只在有人找她时说话，自由时间里不往这里分享（有人托的照发，限频关了也拦）
    if (!asked && replyOnlyGroupV2(key)) {
      log(`[reserved2] 自由时间分享被拦 ${key}：只在有人找时说话`);
      return denied('这个群里你只在有人找你的时候说话', '');
    }
    if (!c.enabled) return null;
    if (!Array.isArray(socialV2.playShares)) socialV2.playShares = [];
    const shares = socialV2.playShares.filter((s) => s && now - Number(s.at) < 48 * 3600 * 1000);
    socialV2.playShares = shares;
    const mine = shares.filter((s) => s.key === key);
    const last = mine.at(-1);
    // 同一回里接着发（比如说完一句再发截图）
    if (last && now - Number(last.lastAt || last.at) < c.burstMs) { if (record) last.lastAt = now; return null; }
    if (!asked) {
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      const todayShares = shares.filter((s) => Number(s.at) >= today.getTime() && !s.asked);
      const sessionStart = Number(play?.freeTime?.startedAt) || 0;
      let why = '';
      if (last && c.minIntervalMs > 0 && now - Number(last.at) < c.minIntervalMs) why = `你 ${Math.round((now - Number(last.at)) / 60000)} 分钟前刚给这里分享过`;
      else if (todayShares.filter((s) => s.key === key).length >= c.perConversationPerDay) why = '今天已经给这里分享过好几回了';
      else if (todayShares.length >= c.globalPerDay) why = '今天已经分享得够多了';
      else if (sessionStart && shares.filter((s) => Number(s.at) >= sessionStart && !s.asked).length >= c.perSession) why = '这次玩的时候已经分享过了';
      if (why) {
        log(`[reserved2] 自由时间分享被拦 ${key}：${why}`);
        return denied(why);
      }
    }
    if (!record) return null;
    shares.push({ key, at: now, lastAt: now, ...(asked ? { asked: true } : {}) });
    log(`[reserved2] 自由时间分享 ${key}${asked ? '（有人托的）' : ''}`);
    saveSocialV2State();
    return null;
  }

  return {
    exports: {
      FREE_TIME_REASONS,
      PLAY_LAST_ITEM_MS,
      PLAY_LOG_MAX,
      READ_PAGES_MAX,
      backfillPlaySessionsV2,
      extendFreeTimeForRequestV2,
      extendFreeTimeV2,
      freeTimeCurfewAtV2,
      freeTimeCurfewV2,
      freeTimeIdeasLineV2,
      freeTimeNudgeTextV2,
      freeTimeTooShortV2,
      goPlayMinutesV2,
      minutesRangeV2,
      noteFreeTimeViewV2,
      notePlayLogV2,
      notePlaySessionV2,
      playSessionsTextV2,
      playShareGateV2,
      startFreeTimeV2,
      todayPlaySessionsV2,
    },
    link() {
      ({
        PLAY_SESSIONS_KEEP_MS, PLAY_SESSIONS_MAX, convLabelV2, whenV2, isConversationBusyV2,
        isNightSleepV2, lifeCfgV2, moodEngineCfgV2, playHoldV2, replyOnlyGroupV2, saveSocialV2State, socialV2
      } = app);
    },
    start() {
    app.scheduler.every('free-time-curfew', 60 * 1000, freeTimeCurfewV2);
    },
  };
}
