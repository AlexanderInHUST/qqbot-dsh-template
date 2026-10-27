// 答应了待会儿再做的事：提醒、等人说话、承诺提示、交给去玩的自己
// 2026-10-24 从 bridge.js 的 main() 里拆出来，代码原样搬过来的；用到的别处的东西都从 app 拿（见 bridge.js 里“装配拆出去的模块”）。
import { truncateText } from '../md-to-plain.js';
import { nextClockTime } from '../proactive-schedule.js';
import { defang } from '../qq-model-view.js';
import { SENSITIVE_RE } from '../sensitive.js';

export function createReminders(app) {
  const {
    PLAY_KEY, api, cfg, isOwnerId, isSessionAllowedInCurrentMode, log, playEnabledV2, v2TurnStartAt
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let REMINDERS_MAX, crossSessionCountOnlyV2, getSocialV2State, whenV2, isConversationBusyV2,
    asleepAtV2, isNightSleepV2, isOutsideGroupKeyV2, ownerAwakeV2, wakeAfterV2, saveSocialV2State, sendWakePromptV2, socialV2,
    v2ToolEnabled;

  // ── qqbot_agent：她答应了“待会儿/晚上/明天”再做的事（qq_remind_me） ───────────────────────────────
  // 以前她说“过会儿再截图给你们看”“明天接着答”，过了这一轮就没人叫她，答应的事从来没兑现过。
  // 现在记成提醒，到点 reminderTickV2 叫这个聊天回来：正在聊就插一句【到点了】，不在聊就用 reminder 唤醒；
  // 夜里睡着不叫（主人把她叫醒的那个窗口除外），醒了再叫。状态在 socialV2.reminders，存盘。
  const clockOfV2 = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const REMINDER_PER_KEY = 5;
  const REMINDER_MAX_MINUTES = 2880;
  const REMINDER_STALE_MS = 12 * 3600 * 1000; // 到点后 12 小时还没叫到（一直睡着/会话被移出白名单）就算了
  let reminderSeq = 0;
  // 2026-10-25 23:01 她在大群被误叫醒，看到“23:30 睡觉”就记了个 23:29 的提醒“在大群跟大家说一声晚安”，到点真去说了。
  // 主人：晚安只在小群说，大群除非正在聊，不然没必要突然插一句。家里以外的群不让记这种提醒。
  // 只拦定时间的（等人说话的“他睡了告诉大家”照记）。
  const BEDTIME_NOTE_RE = /晚安|(说|讲|打招呼).{0,8}(去睡|睡觉|要睡)/;
  // 最近一次拼进各会话唤醒提示的到点提醒 id，投递成功后标成已看到（见 deliverPromptNow），和 playPromptRequests 一个道理
  const reminderPromptIds = new Map();
  function remindersOfV2(key) {
    return (Array.isArray(socialV2.reminders) ? socialV2.reminders : []).filter((r) => r.key === key);
  }
  // 只写日期和几点，不写“明天”：工具结果留在会话历史里，过了一天“明天”就不对了
  function reminderWhenTextV2(t) {
    return whenV2(t);
  }
  function reminderListV2(key, now = Date.now()) {
    return remindersOfV2(key).filter((r) => !r.firedAt).sort((a, b) => a.due - b.due).map((r) => ({ id: r.id, when: r.wait ? `等${r.wait.who}${r.wait.words.length ? `说“${r.wait.words.join('/')}”` : '说话'}，最晚 ${reminderWhenTextV2(r.due, now)}` : reminderWhenTextV2(r.due, now), note: r.note }));
  }
  // ── 等人说话的提醒（2026-10-23 晚：妈妈让她“爸爸睡了告诉我”，她说“他一睡我就告诉你”，可她根本没法知道，后来是爸爸自己说的）
  const REMINDER_WAIT_DEFAULT_MINUTES = 180;
  const REMINDER_WAIT_NEG_RE = /(没|不|别|还没|没有|不想|不要|不能)$/;
  // waitFor：QQ 号、群名片/昵称、或“爸爸/妈妈/主人”这类称呼；waitIn：会话 key，"any" = 哪里都算（不填：私聊里只看这里，群里哪里都算）
  function reminderWaitV2(key, waitFor, wordsRaw, inRaw) {
    let userId = '';
    let who = waitFor;
    if (/^\d{5,12}$/.test(waitFor) || (/^\d+$/.test(waitFor) && isOwnerId(cfg, waitFor))) userId = waitFor;
    else if (/^(主人|爸爸|老爸|爸)$/.test(waitFor) && cfg.ownerQQ) userId = String(cfg.ownerQQ);
    else {
      const byTitle = Object.entries(cfg.ownerTitles || {}).find(([, t]) => String(t) === waitFor);
      if (byTitle) userId = String(byTitle[0]);
    }
    // 名字：在最近的消息里找这个人（群名片、昵称包含它的）
    if (!userId) {
      for (const [, s] of socialV2.conversations) {
        const m = [...(s.recentMessages || [])].reverse().find((x) => !x.isSelf && x.userId && String(x.sender || '').includes(waitFor));
        if (m) { userId = String(m.userId); break; }
      }
    }
    if (userId && userId === String(app.selfUserId)) return { ok: false, error: '不能等你自己说话' };
    if (userId) {
      const seen = [...socialV2.conversations.values()].flatMap((s) => s.recentMessages || []).reverse().find((x) => String(x.userId) === userId && x.sender && x.sender !== '私聊');
      if (seen && /^\d+$/.test(who)) who = truncateText(String(seen.sender), 16);
    }
    const words = (Array.isArray(wordsRaw) ? wordsRaw : String(wordsRaw ?? '').split(/[,，、;；|/\s]+/))
      .map((w) => String(w).trim().slice(0, 12)).filter(Boolean).slice(0, 8);
    let where = String(inRaw ?? '').trim();
    if (!where) where = key.startsWith('private:') ? key : 'any';
    if (where !== 'any' && (!/^(private|group):\d+$/.test(where) || !isSessionAllowedInCurrentMode(where))) return { ok: false, error: 'waitIn 要填白名单里的会话 key，或者 "any"' };
    return { ok: true, wait: { who, userId, words, in: where } };
  }
  function reminderWaitMatchV2(r, key, msg) {
    const w = r.wait;
    if (!w || r.firedAt || r.triggered) return false;
    if (w.in !== 'any' && w.in !== key) return false;
    if (key === PLAY_KEY || msg.isSelf) return false;
    const sameUser = w.userId ? String(msg.userId ?? '') === w.userId : String(msg.sender || '').includes(w.who);
    if (!sameUser) return false;
    if (!w.words.length) return true;
    const text = String(msg.plain ?? msg.text ?? '');
    return w.words.some((word) => {
      for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
        const before = text.slice(Math.max(0, i - 3), i);
        const after = text.slice(i + word.length, i + word.length + 2);
        // “还没睡”“睡了吗”不算
        if (!REMINDER_WAIT_NEG_RE.test(before) && !/^(吗|没|么|嘛|\?|？)/.test(after)) return true;
      }
      return false;
    });
  }
  // 有人说话了：等着这句话的提醒马上到点（reminderTickV2 去叫她）
  function noteReminderWaitV2(key, msg) {
    const list = (socialV2.reminders || []).filter((r) => r.wait && reminderWaitMatchV2(r, key, msg));
    if (!list.length) return;
    const now = Date.now();
    for (const r of list) {
      r.triggered = { key, at: now, text: truncateText(String(msg.plain ?? msg.text ?? ''), 60), sender: truncateText(String(msg.sender || ''), 16) };
      r.due = now;
      log(`[提醒] ${r.key} 等的话来了：${r.triggered.sender} 在 ${key} 说“${r.triggered.text}”`);
    }
    saveSocialV2State();
    setTimeout(() => { void reminderTickV2().catch((error) => log(`[提醒] 出错：${error?.message ?? error}`)); }, 50);
  }
  // 到点（或等到了）时给她看的那句
  function reminderFiredTextV2(r, key) {
    if (!r.wait) return `你 ${whenV2(r.at)} 在这里说好的事到时间了：${defang(r.note)}`;
    const w = r.wait;
    if (r.triggered) {
      const there = r.triggered.key === key ? '在这里' : '在别处';
      const quote = r.triggered.key === key || !crossSessionCountOnlyV2(key, r.triggered.key) ? `“${defang(r.triggered.text)}”` : '（那边的原话不在这里说）';
      return `你 ${whenV2(r.at)} 在这里说好等 ${defang(w.who)}${w.words.length ? `说“${defang(w.words.join('/'))}”` : '说话'}，现在等到了：${whenV2(r.triggered.at)} ${defang(r.triggered.sender || w.who)}${there}说了${quote}。该做的事：${defang(r.note)}`;
    }
    return `你 ${whenV2(r.at)} 在这里说好等 ${defang(w.who)}${w.words.length ? `说“${defang(w.words.join('/'))}”` : '说话'}，可一直等到现在也没等到。原来要做的：${defang(r.note)}。没等到就照实说，别编成已经等到了。`;
  }
  function remindMeV2(key, body, now = Date.now()) {
    if (!Array.isArray(socialV2.reminders)) socialV2.reminders = [];
    const cancel = String(body?.cancel ?? '').trim();
    if (cancel) {
      const before = socialV2.reminders.length;
      socialV2.reminders = socialV2.reminders.filter((r) => r.key !== key || (cancel !== 'all' && r.id !== cancel));
      const n = before - socialV2.reminders.length;
      saveSocialV2State();
      if (n) log(`[提醒] ${key} 取消了 ${n} 条`);
      return n
        ? { ok: true, cancelled: n, reminders: reminderListV2(key, now), hint: '取消了。' }
        : { ok: false, error: `没找到 id 是 ${cancel} 的提醒`, reminders: reminderListV2(key, now) };
    }
    const note = truncateText(String(body?.note ?? '').replace(/\s+/g, ' ').trim(), 100);
    const hasMinutes = body?.minutes !== undefined && body?.minutes !== null && body?.minutes !== '';
    const atText = String(body?.at ?? '').trim();
    // 等某个人说某句话（“他一睡我就告诉你”）：waitFor 填人，waitWords 填要等的话，时间是最晚等到什么时候（不填等 3 小时）
    const waitFor = String(body?.waitFor ?? '').trim().slice(0, 30);
    let wait = null;
    if (waitFor) {
      if (cfg.socialV2?.remindWait?.enabled === false) return { ok: false, error: '现在不能等人说话再叫你，只能定时间' };
      const w = reminderWaitV2(key, waitFor, body?.waitWords, body?.waitIn);
      if (!w.ok) return w;
      wait = w.wait;
    }
    if (!hasMinutes && !atText && !wait) {
      const list = reminderListV2(key, now);
      return { ok: true, reminders: list, hint: list.length ? '这些是这里记着、还没到点的。' : '这里没有记着的事。要记就填 note 和 minutes（或 at）。' };
    }
    if (!note) return { ok: false, error: 'note 不能为空：写清楚到点要做什么' };
    if (SENSITIVE_RE.test(note)) return { ok: false, error: '内容含敏感信息', status: 403 };
    if (!wait && isOutsideGroupKeyV2(key) && BEDTIME_NOTE_RE.test(note)) {
      return { ok: false, error: '睡前说晚安在家里的小群说就行；这里只有正跟人聊着才顺口说一声，不用记着到点专门来说' };
    }
    let due;
    if (wait && !hasMinutes && !atText) {
      due = now + REMINDER_WAIT_DEFAULT_MINUTES * 60000;
    } else if (atText) {
      const m = /^([01]?\d|2[0-3])[:：]([0-5]\d)$/.exec(atText);
      if (!m) return { ok: false, error: 'at 要写成 24 小时制的 HH:MM，比如 "20:30"' };
      due = nextClockTime(`${m[1].padStart(2, '0')}:${m[2]}`, now);
    } else {
      const minutes = Math.round(Number(body.minutes));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > REMINDER_MAX_MINUTES) return { ok: false, error: `minutes 要在 1~${REMINDER_MAX_MINUTES} 之间（最多两天）` };
      due = now + minutes * 60000;
    }
    const pending = remindersOfV2(key).filter((r) => !r.firedAt);
    if (pending.length >= REMINDER_PER_KEY) return { ok: false, error: `这里已经记着 ${pending.length} 件事了，先做完或者取消几件`, reminders: reminderListV2(key, now) };
    if (socialV2.reminders.length >= REMINDERS_MAX) return { ok: false, error: '记着的事太多了，先做完几件' };
    const id = `r${(now % 1e8).toString(36)}${(reminderSeq++).toString(36)}`;
    socialV2.reminders.push({ id, key, note, at: now, due, ...(wait ? { wait } : {}) });
    saveSocialV2State();
    const asleep = asleepAtV2(due);
    if (wait) {
      log(`[提醒] ${key} 记了一件事，等 ${wait.who}${wait.words.length ? ` 说“${wait.words.join('/')}”` : ' 说话'}（${wait.in === 'any' ? '哪里都算' : wait.in}），最晚 ${reminderWhenTextV2(due, now)}：${note}`);
      return {
        ok: true, id, waitingFor: wait.who, words: wait.words, until: reminderWhenTextV2(due, now), reminders: reminderListV2(key, now),
        hint: `记下了：${wait.who}${wait.words.length ? `说了“${wait.words.join('”或“')}”这类话` : '一说话'}${wait.in === 'any' ? '（在哪个窗口说都算）' : ''}，这里就会叫你回来；到 ${reminderWhenTextV2(due, now)} 还没等到也会叫你一次。${wait.userId ? '' : `没认出 ${wait.who} 是谁，只能按名字对，最好填 QQ 号。`}跟大家说“他睡了我告诉你”这类话现在是真的了，不用提你记了提醒。`,
      };
    }
    log(`[提醒] ${key} 记了一件事，${reminderWhenTextV2(due, now)} 叫她：${note}`);
    return {
      ok: true, id, when: reminderWhenTextV2(due, now), reminders: reminderListV2(key, now),
      hint: `记下了，${reminderWhenTextV2(due, now)} 这里会叫你回来做这件事。${asleep ? `那时候你在睡觉，要等早上 ${clockOfV2(wakeAfterV2(due))} 左右起床才叫你，说的时候别说成半夜。` : ''}跟大家说一声“待会儿”就行，不用说你记了提醒。`,
    };
  }
  // 到点了、还没给她看过的提醒（拼进这个会话的唤醒提示）
  function dueRemindersV2(key) {
    return remindersOfV2(key).filter((r) => r.firedAt && !r.shownAt);
  }
  function reminderPromptLineV2(key, now = Date.now()) {
    const due = dueRemindersV2(key);
    const later = remindersOfV2(key).filter((r) => !r.firedAt).sort((a, b) => a.due - b.due);
    reminderPromptIds.set(key, due.map((r) => r.id));
    let text = '';
    if (due.length) {
      text += `【到点了】你之前在这里说好要做的事，现在到时间了：\n${due.map((r) => (r.wait ? `- ${reminderFiredTextV2(r, key)}${r.due < Number(r.firedAt) - 10 * 60000 ? `（那时候你在睡觉，现在才叫你）` : ''}` : `- ${whenV2(r.at)} 你记下的${r.due < Number(r.firedAt) - 10 * 60000 ? `（本来是 ${whenV2(r.due)}，那时候你在睡觉）` : ''}：${defang(r.note)}`)).join('\n')}\n\n`;
    }
    if (later.length) {
      text += `【你记着的事】${later.map((r) => `${r.wait ? `等${defang(r.wait.who)}${r.wait.words.length ? `说“${defang(r.wait.words.join('/'))}”` : '说话'}（最晚 ${reminderWhenTextV2(r.due, now)}）` : reminderWhenTextV2(r.due, now)} ${defang(r.note)}（id ${r.id}）`).join('；')}。做了或者不用做了就 qq_remind_me(cancel=id)。\n\n`;
    }
    return text;
  }
  // 唤醒提示投递成功：拼进去的到点提醒算她看到了，删掉
  function markRemindersShownV2(key) {
    const ids = reminderPromptIds.get(key);
    reminderPromptIds.delete(key);
    if (!ids?.length) return;
    const set = new Set(ids);
    socialV2.reminders = (socialV2.reminders || []).filter((r) => !(r.key === key && set.has(r.id)));
    saveSocialV2State();
  }
  function turnRunningV2(key) {
    const sid = app.state.sessions?.[key];
    return !!sid && Number(v2TurnStartAt.get(sid)) > 0 && isConversationBusyV2(key, getSocialV2State(key));
  }
  // qqbot_agent：她在聊天里说了“吃完再回来接着拍”“待会儿发给你们看”这种要回头做的事，
  // 却没用 qq_remind_me / qq_go_play 安排上（2026-10-23 技术群两次说吃完再来，都没记，没人叫她就再没回去）：
  // 发送结果里提醒她一句，每轮最多一次。只是提示，不拦。socialV2.promiseHint.enabled:false 关掉。
  const PROMISE_RE = /(待会|等会|等下|等一下再|过会|过一会|一会儿(再|就)?(给|发|回来|来找|来看|来弄|再来|截图)|晚点|晚些|回头(再|给|发|看)|稍后|吃完(饭)?(再|就|回来)|睡醒(了)?(再|就)|明天(再|接着|继续|给)|改天|下次(再|接着)|回来(再|接着|继续)|(接着|继续)(玩|拍|看|答|弄|写|画|做|试))/;
  // 是她自己答应待会儿做的，不是劝别人（10-23 15:08 她跟人说“歇一会儿就起来噢”也被当成答应了事）：
  // 前面几个字里有“你/您”、没有“我”的，是在说对方
  function promiseSaidV2(text) {
    const m = PROMISE_RE.exec(text);
    if (!m) return false;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    return !(/[你您]/.test(before) && !/我/.test(before));
  }
  // “他一睡我就告诉你”“等爸爸下班了我叫你”：要等别人做了什么才兑现的。她只在被叫醒时看得到消息，自己根本不会知道
  // （2026-10-23 22:46 小群，妈妈让她爸爸睡了说一声，她答应完就没下文，23:15 被叫来才又问“你还不睡呀”）
  const COND_PROMISE_RE = /(?:[他她]|爸爸|妈妈|[^\s，,。！？!?]{1,4})一(?:睡|走|下线|回来|上线|醒|到家|下班|说话|出现|有空)[^，,。！？!?]{0,8}?就(?:告诉|跟你说|和你说|叫|喊|通知|汇报|提醒|说一声)|等(?:[他她]|爸爸|妈妈|[^\s，,。！？!?]{1,4}?)(?:睡|走|回来|下班|到家|醒|上线|下线)(?:了|着)?[^，,。！？!?]{0,4}?(?:就|再)?(?:告诉|跟你说|和你说|叫|喊|通知|汇报|提醒|说一声)/;
  // “我正盯着呢”“我帮你看着他”：她没在盯着，也盯不了
  const WATCH_CLAIM_RE = /我(?:帮你|替你|给你)?(?![^，,。！？!?]{0,2}刚才)[^，,。！？!?你]{0,2}(?:盯着|看着|守着)(?:呢|的|[他她](?!们)|爸爸|妈妈|[，,。！？!?]|$)/;
  function condPromiseSaidV2(text) {
    return COND_PROMISE_RE.test(text) || WATCH_CLAIM_RE.test(text);
  }
  // “我这就去画”“我先去玩会儿”“画好就给你们看”：说要走开去电脑上做，可聊天这边说完她还在这里聊，不会真去
  // （2026-10-24 小群 08:46~09:52 说了四回“去画画”，没调 qq_go_play，一回也没画）
  const GO_DO_RE = /去(?:画|玩)(?![^，,。！？!?]{0,3}(?:了|过|的))|(?:画|玩|做|拍)(?:好|完)(?:了)?[^，,。！？!?]{0,3}?(?:就|再|先)?(?:给|发|拿)(?:你们|你|大家)?看/;
  function goDoSaidV2(text) {
    const m = GO_DO_RE.exec(text);
    if (!m) return false;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    return !(/[你您他她们]/.test(before) && !/我/.test(before));
  }
  function promiseHintV2(key, messages, now = Date.now()) {
    if (key === PLAY_KEY || cfg.socialV2?.promiseHint?.enabled === false) return null;
    if (!v2ToolEnabled('remindMe')) return null;
    const texts = messages.map((m) => String(m ?? ''));
    const cond = cfg.socialV2?.promiseHint?.conditional === false || cfg.socialV2?.remindWait?.enabled === false ? null : texts.find(condPromiseSaidV2);
    const goDo = cfg.socialV2?.promiseHint?.goDo === false || !v2ToolEnabled('goPlay') || !playEnabledV2() ? null : texts.find(goDoSaidV2);
    const hit = cond || goDo || texts.find(promiseSaidV2);
    if (!hit) return null;
    const sid = app.state.sessions?.[key];
    const st = getSocialV2State(key);
    const turnStart0 = Number(sid ? v2TurnStartAt.get(sid) : 0) || 0;
    // turn/start 丢了（重连后补发的回合）：按最近一次唤醒算“这一轮”，查安排就看最近 10 分钟
    const turnMark = turnStart0 || Number(st.wakeConfig?.lastWakeAt) || 1;
    const turnStart = turnStart0 || now - 10 * 60000;
    if (cond) {
      if (Number(st.condPromiseHintTurn) === turnMark) return null;
      if (remindersOfV2(key).some((r) => r.wait && Number(r.at) >= turnStart)) return null;
      st.condPromiseHintTurn = turnMark;
      log(`[提醒] ${key} 答应了要等别人做了什么再说，没安排，提示了一句：${truncateText(cond, 40)}`);
      return `你刚说了“${truncateText(cond, 30)}”。可你只在被叫醒的时候才看得到消息，不会自己知道对方什么时候睡了、走了、回来了，也没法一直盯着谁。要兑现就用 qq_remind_me(key, token, note, waitFor=那个人（QQ 号或名字）, waitWords=要等的话（比如“晚安,睡了,去睡”）, minutes=最晚等多久)，他在哪个窗口说了这类话，这里就会叫你回来；不打算这样，就顺口改成实话（“我看到了再跟你说”“我也说不准他睡没睡”），别装作在盯着。`;
    }
    if (Number(st.promiseHintTurn) === turnMark) return null;
    // 这一轮已经安排过了（记了提醒，或者托给了去玩的自己）就不提
    if (remindersOfV2(key).some((r) => Number(r.at) >= turnStart)) return null;
    const reqs = getSocialV2State(PLAY_KEY).playRequests;
    if ((Array.isArray(reqs) ? reqs : []).some((r) => r?.from === key && Number(r.at) >= turnStart)) return null;
    st.promiseHintTurn = turnMark;
    if (goDo) {
      log(`[提醒] ${key} 说了要去电脑上做的事但没托给去玩的自己，提示了一句：${truncateText(goDo, 40)}`);
      return `你刚说了“${truncateText(goDo, 30)}”。可你说完还在这个聊天窗口里，不会真的走开去做，过一会儿又会说一遍。要真去，就用 qq_go_play(key, token, note=要做什么（比如画什么、画好把截图发回这里）, minutes) 交给去玩的你，那边做好会发回来；不打算现在去，就别说“这就去”，接着聊。`;
    }
    log(`[提醒] ${key} 说了要回头做的事但没安排，提示了一句：${truncateText(hit, 40)}`);
    return `你刚说了“${truncateText(hit, 30)}”。过了这一轮你不会自己记得：要回这里做的，用 qq_remind_me(key, token, note, minutes 或 at) 定个时间，到点会叫你；要在电脑上接着玩、接着看的，用 qq_go_play(key, token, note, minutes) 交给去玩的你。只是随口一说就不用管。`;
  }
  // qqbot_agent：聊天这边拿聊天浏览器陪人玩游戏（2026-10-23 技术群让她玩拍蛙蛙，她在聊天窗口里点了三十多下，
  // 两次各玩三分钟就放弃了，只在最后发了一张图）。一轮里点到 afterCalls 下，插一句让她交给自由时间的自己：
  // 那边会玩够时间、有按坐标点的浏览器、中途把截图发回来。每轮最多一次。socialV2.chatBrowserHandoff.enabled:false 关掉。
  const CHAT_BROWSER_PREFIX = 'mcp__sandbox-browser-chat__';
  const chatBrowserCallCount = new Map(); // sessionId -> 这一轮调了几次聊天浏览器（-1 = 这轮已经提过）
  async function noteChatBrowserCallV2(key, sessionId, toolName) {
    if (key === PLAY_KEY || !String(toolName).startsWith(CHAT_BROWSER_PREFIX)) return;
    const c = cfg.socialV2?.chatBrowserHandoff ?? {};
    if (c.enabled === false || !v2ToolEnabled('goPlay') || !playEnabledV2()) return;
    const prev = chatBrowserCallCount.get(sessionId) ?? 0;
    if (prev < 0) return;
    const n = prev + 1;
    const after = Math.max(4, Number(c.afterCalls) || 12);
    if (n < after) { chatBrowserCallCount.set(sessionId, n); return; }
    chatBrowserCallCount.set(sessionId, -1);
    if (isNightSleepV2() && !ownerAwakeV2(key)) return;
    const st = getSocialV2State(key);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text: `【交给去玩的你】${key}（令牌 ${st.agentToken}）你在聊天这边点浏览器点了好一阵了。查个东西快弄完了就接着弄完；要是在陪人玩游戏、看长东西，就别在这边玩：用 qq_go_play(key, token, note, minutes) 交给自由时间的你，那边玩得久，浏览器能按截图坐标点、拖，会中途把截图发回这里。note 写清楚玩什么（网址）、谁让你玩的；说好玩多久就填 minutes（大概 10~20）。这边跟大家说一声就行，然后接着聊。` }] });
      if (accepted?.result?.ok) log(`[goPlay] ${key} 在聊天浏览器里点了 ${n} 下，插了一句让她交给去玩的自己`);
    } catch (error) {
      log(`[goPlay] ${key} 插话失败：${error?.message ?? error}`);
    }
  }
  let reminderTicking = false;
  async function reminderTickV2(now = Date.now()) {
    if (reminderTicking || app.currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false) return;
    if (!Array.isArray(socialV2.reminders) || !socialV2.reminders.length) return;
    reminderTicking = true;
    try {
      let changed = false;
      const night = isNightSleepV2();
      for (const r of [...socialV2.reminders]) {
        if (r.due > now) continue;
        const key = r.key;
        if (now - r.due > REMINDER_STALE_MS || !isSessionAllowedInCurrentMode(key)) {
          socialV2.reminders = socialV2.reminders.filter((x) => x !== r);
          changed = true;
          log(`[提醒] ${key} 的“${r.note}”过了太久没叫到，算了`);
          continue;
        }
        if (night && !ownerAwakeV2(key)) continue; // 睡着呢，醒了再叫
        const st = getSocialV2State(key);
        if (!r.firedAt) {
          r.firedAt = now;
          changed = true;
          log(`[提醒] ${r.wait ? (r.triggered ? '等到了' : '没等到') : '到点了'} ${key}：${r.note}`);
          if (turnRunningV2(key)) {
            // 正在这里聊：直接插一句进去
            try {
              const accepted = await api.sessions.prompt({ sessionId: app.state.sessions[key], mode: 'steer', content: [{ type: 'text', text: `【到点了】${key}（令牌 ${st.agentToken}）${reminderFiredTextV2(r, key)}\n手上这句聊完就去做；已经做过了、或者大家早不提了，就算了。` }] });
              if (accepted?.result?.ok) {
                r.shownAt = now;
                socialV2.reminders = socialV2.reminders.filter((x) => x !== r);
                log(`[提醒] ${key} 正在聊，插了一句【到点了】`);
                continue;
              }
            } catch (error) {
              log(`[提醒] ${key} 插话失败，等这轮聊完再叫：${error?.message ?? error}`);
            }
          }
        }
        // 到点了还没给她看过：不忙就叫醒（忙的话等下一次 tick，或者马上要投递的唤醒提示里会带上）
        if (!r.shownAt && !isConversationBusyV2(key, st) && now - (Number(r.triedAt) || 0) >= 60000) {
          r.triedAt = now;
          r.tries = (Number(r.tries) || 0) + 1;
          changed = true;
          if (r.tries > 5) {
            socialV2.reminders = socialV2.reminders.filter((x) => x !== r);
            log(`[提醒] ${key} 叫了 5 次都没叫到，算了：${r.note}`);
            continue;
          }
          await sendWakePromptV2(key, 'reminder');
        }
      }
      if (changed) saveSocialV2State();
    } finally {
      reminderTicking = false;
    }
  }

  return {
    exports: {
      chatBrowserCallCount,
      condPromiseSaidV2,
      dueRemindersV2,
      goDoSaidV2,
      markRemindersShownV2,
      noteChatBrowserCallV2,
      noteReminderWaitV2,
      promiseHintV2,
      remindMeV2,
      reminderFiredTextV2,
      reminderPromptLineV2,
      reminderTickV2,
      reminderWaitV2,
      reminderWhenTextV2,
      remindersOfV2,
      turnRunningV2,
    },
    link() {
      ({
        REMINDERS_MAX, crossSessionCountOnlyV2, getSocialV2State, whenV2, isConversationBusyV2,
        asleepAtV2, isNightSleepV2, isOutsideGroupKeyV2, ownerAwakeV2, wakeAfterV2, saveSocialV2State, sendWakePromptV2, socialV2,
        v2ToolEnabled
      } = app);
    },
    start() {
    app.scheduler.every('reminders', 15 * 1000, reminderTickV2);
    },
  };
}
