// 她不在的那一段（整个关掉了）、陪人打游戏打太久自己停下
// 2026-10-29：主人打游戏前要用桌面上的“鱼妹开关”把 WSL、Docker、她全关掉，玩好再拉起来。
// 以前 bridge 一重启她就当什么都没发生：关掉那几个小时里有人叫她，她回来不知道自己不在过，
// 那些消息也收不到（SnowLuma 不补推离线消息）。现在：
//   - bridge 每分钟记一次 aliveAt，启动时跟上次比，隔了 away.minMinutes（默认 10）分钟以上就算她不在过；
//     为什么不在照实说：开关停容器前写 state/away-reason.json（爸爸要用电脑打游戏），没有就是“电脑出了点状况”，不编别的理由；
//     前后都在睡觉时间就不提（她本来就睡着）。
//   - 【你现在】里写着几点到几点不在、为什么（回来后 showHours 小时内）；每个聊天回来后第一次被叫醒写一次【你刚回来】。
//   - QQ 连上后用 OneBot 历史把不在时各个白名单会话的消息补进来（按原来的时间，走正常的收消息流程，
//     叫她的照样叫醒；过了 30 分钟的会被快照折成条数，见 staleUnreadPrefixV2）。
// 陪人打游戏（gameLimit）：有人托她去玩游戏（qq_go_play），在电脑上一直玩，加起来满 minutes（默认 30）分钟，
// 插一句【玩了半小时游戏了】让她收尾，restMinutes（默认 60）分钟内托她玩游戏的 qq_go_play 拒（主人在私聊或家里的群又让玩就放行）。
import fs from 'node:fs';
import path from 'node:path';
import { isHomeChat } from '../privacy-policy.js';

export function createAway(app) {
  const {
    PLAY_KEY, STATE_DIR, api, cfg, isSessionAllowedInCurrentMode, log, readJsonSafe
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let FREE_TIME_REASONS, asleepAtV2, convLabelV2, getSocialV2State, isConversationBusyV2, isOutsideGroupKeyV2,
    saveSocialV2State, socialV2, whenV2;

  const MARKER_FILE = path.join(STATE_DIR, 'away-reason.json');
  const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
  function awayCfgV2() {
    const c = cfg.socialV2?.away ?? {};
    return {
      enabled: c.enabled !== false,
      minMs: Math.max(1, num(c.minMinutes, 10)) * 60000,
      showMs: Math.max(0.5, num(c.showHours, 3)) * 3600000,
      backfill: c.backfill !== false,
      backfillMax: Math.min(300, Math.max(1, num(c.backfillMax, 80))), // 每个会话最多补几条（最新的）
    };
  }
  function gameCfgV2() {
    const c = cfg.socialV2?.gameLimit ?? {};
    return {
      enabled: c.enabled !== false,
      limitMs: Math.max(5, num(c.minutes, 30)) * 60000,
      restMs: Math.max(10, num(c.restMinutes, 60)) * 60000,
    };
  }
  function ownerTitleV2() {
    return String(cfg.ownerTitles?.[String(cfg.ownerQQ ?? '')] || '主人');
  }
  function clockV2(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ── 不在 ─────────────────────────────────────────────
  // 不在的这一段给 key 看的说法；'' = 不用提
  function awayWhyTextV2(key, a) {
    if (a.why === 'game') {
      if (key === PLAY_KEY) return `${ownerTitleV2()}要用电脑打游戏，把你连同这台电脑一起关了一会儿`;
      return isOutsideGroupKeyV2(key)
        ? '家里要用电脑打游戏，把你关了一会儿'
        : `${ownerTitleV2()}要用电脑打游戏，把你关了一会儿（你自己的电脑也跟着关了）`;
    }
    if (a.why === 'unknown') return '电脑那边出了点状况，你断开了一会儿（具体怎么回事你也不知道，别编理由）';
    return '';
  }
  function awayNowV2(now = Date.now()) {
    const a = socialV2.away;
    if (!a || a.why === 'sleep' || !(now - Number(a.to) < awayCfgV2().showMs)) return null;
    return a;
  }
  function awayRangeV2(a) {
    return `${whenV2(a.from)}~${new Date(a.from).toDateString() === new Date(a.to).toDateString() ? clockV2(a.to) : whenV2(a.to)}`;
  }
  // 【你现在】里的一行
  function awayLineV2(key, now = Date.now()) {
    const a = awayNowV2(now);
    if (!a) return '';
    const why = awayWhyTextV2(key, a);
    return why ? `- 刚才：${awayRangeV2(a)} 你不在，${why}；这段时间的消息是回来以后才看到的。` : '';
  }
  // 回来后每个聊天第一次被叫醒时写一次（投递成功后 markAwayShownV2 记下）
  const awayPromptKeys = new Set();
  function awayPromptLineV2(key, now = Date.now()) {
    awayPromptKeys.delete(key);
    const a = awayNowV2(now);
    if (!a || key === PLAY_KEY || (a.shown || []).includes(key)) return '';
    const why = awayWhyTextV2(key, a);
    if (!why) return '';
    awayPromptKeys.add(key);
    return `【你刚回来】你 ${awayRangeV2(a)} 不在：${why}。这期间这里的消息你现在才看到。像刚回来的人那样看一眼：有人找过你就自然地说一声刚才不在、为什么（照实说，别编别的理由），过时的话题就算了，不用挨个回；没人找你就不用专门说。\n\n`;
  }
  function markAwayShownV2(key) {
    if (!awayPromptKeys.has(key)) return;
    awayPromptKeys.delete(key);
    const a = socialV2.away;
    if (!a) return;
    a.shown = [...new Set([...(a.shown || []), key])].slice(-30);
    saveSocialV2State();
  }

  // 启动时：跟上次活着的时间比，看是不是不在过
  function detectAwayV2(now = Date.now()) {
    const prev = Number(socialV2.aliveAt) || 0;
    const marker = readJsonSafe(MARKER_FILE, null);
    if (marker) { try { fs.unlinkSync(MARKER_FILE); } catch {} }
    socialV2.aliveAt = now;
    const c = awayCfgV2();
    if (!c.enabled || !prev || now - prev < c.minMs) { saveSocialV2State(); return null; }
    let why = marker?.why === 'game' && Number(marker.at) >= prev - 30 * 60000 ? 'game' : 'unknown';
    if (asleepAtV2(prev) && asleepAtV2(now)) why = 'sleep'; // 关着的时候她本来就在睡
    socialV2.away = { from: prev, to: now, why, shown: [] };
    saveSocialV2State();
    log(`[不在] ${whenV2(prev)}~${whenV2(now)} 不在（${Math.round((now - prev) / 60000)} 分钟，${why === 'game' ? '主人打游戏关的' : why === 'sleep' ? '在睡觉时间里' : '原因不知道'}）`);
    return socialV2.away;
  }

  // ── 补收不在时的消息（OneBot 历史） ──────────────────────
  async function onebotV2(action, params) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
    return body.data;
  }
  // since（毫秒）以后的消息，从早到晚。按最早那条的 message_id 往前翻页（和 extras/digest.py 的 fetch 一样，SnowLuma 不认 message_seq）
  async function historySinceV2(kind, id, since) {
    const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const field = kind === 'group' ? 'group_id' : 'user_id';
    const seen = new Set();
    const out = [];
    let anchor = null;
    for (let page = 0; page < 5; page++) {
      const data = await onebotV2(action, { [field]: Number(id), count: 100, ...(anchor !== null ? { message_id: anchor } : {}) });
      const fresh = (Array.isArray(data?.messages) ? data.messages : []).filter((m) => m && m.message_id != null && !seen.has(String(m.message_id)));
      for (const m of fresh) seen.add(String(m.message_id));
      out.push(...fresh);
      if (!fresh.length) break;
      const oldest = fresh.reduce((a, b) => (order(b, a) < 0 ? b : a));
      if (Number(oldest.time) * 1000 <= since) break;
      anchor = oldest.message_id;
    }
    return out.filter((m) => Number(m.time) * 1000 > since).sort(order);
  }
  function order(a, b) {
    return (Number(a.time) - Number(b.time)) || (Number(a.message_seq) - Number(b.message_seq));
  }
  function knownMessageV2(st, messageId) {
    const id = String(messageId);
    return (st.recentMessages || []).some((m) => m?.messageId === id) || (st.unread || []).some((m) => m?.messageId === id);
  }
  let backfillPending = false;
  let backfillRunning = false;
  async function backfillAwayV2() {
    const a = socialV2.away;
    if (!backfillPending || backfillRunning || !a) return null;
    const self = String(app.selfUserId || '');
    if (!self || app.currentMode !== 'reserved2' || typeof app.handleIncomingV2 !== 'function') return null;
    backfillRunning = true;
    backfillPending = false;
    // QQ 要等主人在登录页点“登录”才连上，这之前她也收不到消息：不在的这一段算到连上为止
    if (Date.now() > Number(a.to)) a.to = Date.now();
    const c = awayCfgV2();
    const since = Number(a.from) - 60000;
    const convs = [
      ...(cfg.allow?.private || []).map((id) => ['private', String(id)]),
      ...(cfg.allow?.groups || []).map((id) => ['group', String(id)]),
    ].filter(([kind, id]) => isSessionAllowedInCurrentMode(`${kind}:${id}`));
    const counts = {};
    try {
      for (const [kind, id] of convs) {
        const key = `${kind}:${id}`;
        try {
          const list = (await historySinceV2(kind, id, since))
            .filter((m) => String(m.user_id ?? m.sender?.user_id ?? '') !== self)
            .slice(-c.backfillMax);
          let n = 0;
          for (const m of list) {
            const st = getSocialV2State(key);
            if (knownMessageV2(st, m.message_id)) continue;
            const event = { ...m, self_id: self, ...(kind === 'group' ? { group_id: Number(id) } : { user_id: m.user_id ?? Number(id) }) };
            try {
              await app.handleIncomingV2(kind, kind === 'group' ? event.group_id : event.user_id, event, cfg);
            } catch (error) {
              log(`[不在] 补收 ${key} 的一条消息出错：${error?.message ?? error}`);
              continue;
            }
            // 记成原来的时间（收消息流程按现在记的）：快照会把过了很久的折成条数，【你现在】【别处的事】也按真时间算
            const msg = (getSocialV2State(key).recentMessages || []).find((x) => x?.messageId === String(m.message_id));
            if (msg && Number(m.time) > 0) { msg.time = Number(m.time) * 1000; n++; }
          }
          if (n) counts[key] = n;
        } catch (error) {
          log(`[不在] 拉 ${key} 不在时的消息失败：${error?.message ?? error}`);
        }
      }
      saveSocialV2State();
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      log(`[不在] 补收了不在时的消息 ${total} 条${total ? `：${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('，')}` : ''}`);
      return counts;
    } finally {
      backfillRunning = false;
    }
  }
  // QQ 连上后补收：要等 bridge 知道自己的 QQ 号（getLoginInfo 是异步的）、DSH 也起来了
  async function backfillWhenReadyV2() {
    for (let i = 0; i < 150 && backfillPending; i++) {
      if (app.selfUserId && app.dshReady) { await backfillAwayV2(); return; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // ── 陪人打游戏打太久 ─────────────────────────────────────
  const GAME_WORDS = /扫雷|俄罗斯方块|tetris|2048|游戏|玩一局|再来一局|一盘|开一把|消消乐|纸牌|弹球|合成大西瓜|数独|下棋|象棋|五子棋|围棋|跳棋|chess|game/i;
  const GAME_HOST_RE = /game|minesweeper|tetris|2048|sudoku|solitaire|chess/i;
  function gameRestV2(now = Date.now()) {
    const r = socialV2.gameRest;
    if (!r) return null;
    if (!(Number(r.until) > now)) { socialV2.gameRest = null; saveSocialV2State(); return null; }
    return r;
  }
  // 这次自由时间是不是有人托她玩游戏：托的话里说了玩游戏，或者正开着游戏站
  function askedGameV2(st, ft, now) {
    const notes = [
      ...(Array.isArray(ft.asked) ? ft.asked.map((x) => x?.note) : []),
      ...(Array.isArray(st.playRequests) ? st.playRequests.filter((r) => r && now - Number(r.at) < 2 * 3600000).map((r) => r.note) : []),
    ];
    const asked = st.lastWakeReason === 'goPlay' || (Array.isArray(ft.asked) && ft.asked.length > 0);
    if (!asked) return false;
    const host = String(ft.currentPage || '').split('/')[0];
    return ft.lastKind === 'game' || GAME_HOST_RE.test(host) || notes.some((n) => GAME_WORDS.test(String(n || '')));
  }
  // play:main 每调一次浏览器、桌面工具记一次（bridge.js 在工具结果那里调）
  function noteAwayGameV2(key, toolName, _resultText, now = Date.now()) {
    if (key !== PLAY_KEY) return;
    const c = gameCfgV2();
    if (!c.enabled || !/^mcp__sandbox-(browser|desktop)__/.test(String(toolName || ''))) return;
    const st = socialV2.conversations.get(PLAY_KEY);
    const ft = st?.freeTime;
    if (!ft || !FREE_TIME_REASONS.has(st.lastWakeReason) || !askedGameV2(st, ft, now)) return;
    const g = socialV2.gamePlay && now - Number(socialV2.gamePlay.lastAt) < 20 * 60000 ? socialV2.gamePlay : { ms: 0, lastAt: now, since: now };
    g.ms = Number(g.ms || 0) + Math.min(Math.max(0, now - Number(g.lastAt)), 3 * 60000);
    g.lastAt = now;
    socialV2.gamePlay = g;
    if (g.ms < c.limitMs || gameRestV2(now)) return;
    socialV2.gamePlay = null;
    const until = now + c.restMs;
    socialV2.gameRest = { at: now, until };
    const from = [...new Set([
      ...(Array.isArray(ft.asked) ? ft.asked.map((x) => x?.from) : []),
      ...(Array.isArray(st.playRequests) ? st.playRequests.filter((r) => r && now - Number(r.at) < 2 * 3600000).map((r) => r.from) : []),
    ].filter((k) => k && k !== PLAY_KEY))];
    for (const r of Array.isArray(st.playRequests) ? st.playRequests : []) if (r && !r.done) r.done = true;
    ft.minUntil = 0; // 不再劝她接着玩
    ft.asked = [];
    ft.curfewSent = true; // 也不再插【可以歇了】【玩了好久了】
    ft.restOfferSent = true;
    saveSocialV2State();
    log(`[打游戏] 陪着打了 ${Math.round(g.ms / 60000)} 分钟游戏，让她停下，${whenV2(until)} 前不托她玩游戏${from.length ? `（托她的：${from.join('、')}）` : ''}`);
    void steerGameStopV2(st, from, until).catch(() => {});
  }
  async function steerGameStopV2(st, from, until) {
    const sessionId = app.state.sessions?.[PLAY_KEY];
    if (!sessionId || !isConversationBusyV2(PLAY_KEY, st)) return;
    const markRead = 'qq_mark_read()';
    const tell = from.length
      ? `给托你玩的${from.map((k) => `${convLabelV2(k, socialV2.conversations.get(k))}（${k}）`).join('、')}说一声玩了好久、眼睛累了先歇会儿，晚点再陪他们玩；`
      : '';
    const text = `【玩了半小时游戏了】陪着打游戏已经半小时了，眼睛有点累，这把玩完就停下歇会儿，${whenV2(until)} 前先不玩游戏了。${tell}然后关掉多余的标签页，调用 ${markRead}。`;
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
      log(`[打游戏] 让电脑那边停下（${accepted?.result?.ok ? '已插话' : '插话没被接受'}）`);
    } catch (error) {
      log(`[打游戏] 让电脑那边停下失败：${error?.message ?? error}`);
    }
  }
  // 【你现在】里的一行
  function gameRestLineV2(key, now = Date.now()) {
    const r = gameRestV2(now);
    if (!r) return '';
    return key === PLAY_KEY
      ? `- 电脑：${whenV2(r.at)} 陪人打了半小时游戏，眼睛有点累，${whenV2(r.until)} 前别玩游戏了。`
      : `- 打游戏：${whenV2(r.at)} 刚陪人打了半小时游戏，眼睛有点累，${whenV2(r.until)} 前先不玩游戏；有人再叫你玩就说玩了好久了，晚点再陪。`;
  }
  // qq_go_play 被拦的理由；null = 可以去。只拦玩游戏的；主人在私聊或家里的群、歇下以后又让她玩就放行
  function gameRestBlocksV2(key, note, now = Date.now()) {
    const r = gameRestV2(now);
    if (!r || !GAME_WORDS.test(String(note || ''))) return null;
    const home = isHomeChat(cfg, key);
    const recent = socialV2.conversations.get(key)?.recentMessages;
    const ownerAgain = home && (Array.isArray(recent) ? recent : []).some((m) => m && !m.isSelf && m.isOwner
      && Number(m.time) > Number(r.at) && now - Number(m.time) < 5 * 60000);
    if (ownerAgain) {
      socialV2.gameRest = null;
      saveSocialV2State();
      log(`[打游戏] 主人在 ${key} 又让她玩，不拦了`);
      return null;
    }
    return `你 ${whenV2(r.at)} 刚陪着打了半小时游戏，眼睛有点累，${whenV2(r.until)} 前先歇会儿，晚点再玩；跟这边说一声就好`;
  }

  return {
    exports: {
      awayLineV2,
      awayPromptLineV2,
      backfillAwayV2,
      detectAwayV2,
      gameRestBlocksV2,
      gameRestLineV2,
      markAwayShownV2,
      noteAwayGameV2,
    },
    link() {
      ({
        FREE_TIME_REASONS, asleepAtV2, convLabelV2, getSocialV2State, isConversationBusyV2, isOutsideGroupKeyV2,
        saveSocialV2State, socialV2, whenV2
      } = app);
    },
    start() {
      // v2-state 的 start() 已经读过存盘的状态（appModules 里它排在前面），这里拿到的 aliveAt 是上次的
      const a = detectAwayV2();
      backfillPending = !!a && awayCfgV2().backfill;
      app.scheduler.every('alive', 60 * 1000, () => {
        socialV2.aliveAt = Date.now();
        saveSocialV2State();
      });
      if (typeof app.bot?.on === 'function') {
        app.bot.on('open', () => { if (backfillPending) void backfillWhenReadyV2().catch((error) => log(`[不在] 补收失败：${error?.message ?? error}`)); });
      }
    },
  };
}
