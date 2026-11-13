// 要等一会儿的活（画画、做视频，以后的语音）和“给别的窗口留话”（2026-11-08 从 draw.js / video.js / tell-myself.js 里拆出来）。
// 以前画画、做视频各写了一遍排队、间隔、重启后算没做成、做完发出去记成她的话、告诉发起的窗口，
// 留话也是 drawNotes / videoNotes / tellNotes 三份。现在：
//   执行器：defineJobKindV2(kind, spec) 声明一种活怎么做、怎么说，submitJobV2 交给它排队（间隔按记录里的 startedAt 算，重启后也算），
//     做好了经 sendSegmentsV2（→ 出口关卡）发出去、记成她的话、告诉发起的窗口；没做成要不要叫醒她看 spec.wakeOnFail；
//   留话：socialV2.notes [{ kind, id, to, at, ...}]，正跑着一轮就插话（tellWindowV2），不在就留着、下次唤醒写进提示，
//     发出去以后 markNotesShownV2 删掉。
// 校验（能不能画、内容、限额）还在各自的模块里，这里只管排队和投递。日志用各自的标签（[画画]、[做视频]、[捎话]）。
import { localDay } from '../proactive-schedule.js';

const JOB_NOTES_MAX = 60;

export function createJobs(app) {
  const { PLAY_KEY, api, appendActivity, isSessionAllowedInCurrentMode, log, shouldBlockSilentReply } = app;
  let afterSentV2, castTextV2, convLabelV2, extrasPostV2, getSocialV2State, notePlayLogV2, ownVideoOfV2, recordOwnImageV2,
    saveSocialV2State, sendSegmentsV2, sendWakePromptV2, socialV2, turnRunningV2;

  // ── 留话 ─────────────────────────────────────────────────
  // kind -> { keepMs(): number, perTarget }
  const noteKinds = new Map();
  function defineNoteKindV2(kind, { keepMs, perTarget = 5 } = {}) {
    noteKinds.set(kind, { keepMs: typeof keepMs === 'function' ? keepMs : () => Number(keepMs) || 6 * 3600 * 1000, perTarget });
  }
  const keepOf = (kind) => noteKinds.get(kind)?.keepMs() ?? 6 * 3600 * 1000;
  const liveNote = (n, now) => now - Number(n.at) < keepOf(n.kind);
  function notesOfV2(key, kind, now = Date.now()) {
    return (Array.isArray(socialV2.notes) ? socialV2.notes : []).filter((n) => n.to === key && n.kind === kind && liveNote(n, now));
  }
  function leaveNoteV2(kind, to, fields, now = Date.now()) {
    const perTarget = noteKinds.get(kind)?.perTarget ?? 5;
    let notes = (Array.isArray(socialV2.notes) ? socialV2.notes : []).filter((n) => liveNote(n, now));
    const mine = notes.filter((n) => n.to === to && n.kind === kind);
    if (mine.length >= perTarget) {
      const drop = new Set(mine.slice(0, mine.length - perTarget + 1));
      notes = notes.filter((n) => !drop.has(n));
    }
    const note = { kind, to, at: now, ...fields };
    notes.push(note);
    socialV2.notes = notes.slice(-JOB_NOTES_MAX);
    saveSocialV2State();
    return note;
  }
  // 拼进唤醒提示时记下给了哪几条；这次唤醒发出去了（bridge.js 的投递）再删
  const shownNotes = new Map(); // `${key}\n${kind}` -> ids
  function noteNotesShownV2(key, kind, ids) {
    shownNotes.set(`${key}\n${kind}`, ids);
  }
  function markNotesShownV2(key, kinds = null) {
    const drop = new Set();
    for (const kind of kinds ?? [...noteKinds.keys()]) {
      const ids = shownNotes.get(`${key}\n${kind}`);
      shownNotes.delete(`${key}\n${kind}`);
      for (const id of ids ?? []) drop.add(`${kind}\n${id}`);
    }
    if (!drop.size) return;
    socialV2.notes = (socialV2.notes || []).filter((n) => !(n.to === key && drop.has(`${n.kind}\n${n.id}`)));
    saveSocialV2State();
  }

  // 正跑着一轮就插一句（steer），插上了返回 true
  async function tellWindowV2(to, text, tag = '') {
    const sessionId = app.state.sessions?.[to];
    if (!sessionId || !turnRunningV2(to)) return false;
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
      if (accepted?.result?.ok) return true;
    } catch (error) {
      log(`${tag} ${to} 插话失败，记着等下次：${error?.message ?? error}`);
    }
    return false;
  }

  // ── 执行器 ───────────────────────────────────────────────
  // spec：
  //   tag 日志标签；logField socialV2 里记录的字段（drawLog / videoLog，留 300 条）；idPrefix；unit（张 / 段）；verb（画 / 做）
  //   cfg() → { minIntervalMs }；overlap：false 一个做完再做下一个，true 只是开做排队、开了各做各的
  //   produce(entry, castText) → { model, parts: [{ segments, opts?, optional? }], text, file?, media? }
  //     parts[0] 发不出去算没做成，optional 的发不出去只记日志
  //   label(entry)；playWhat(entry) 写进 playLog 的“做了什么”
  //   resultText(entry, viewer)、pendingText(entry, viewer)、section、failedFooter：唤醒提示
  //   steerTitle(ok)、steerTail(entry, to)：插话
  //   blockedError、sendFailedPrefix、restartError：error 里的话（各模块的 failReason 按它认）
  //   wakeReason、wakeOnFail：没做成又不在聊时叫她一次
  const kinds = new Map(); // kind -> { spec, chain, pending: Map, casts: Map, seq }
  function defineJobKindV2(kind, spec) {
    kinds.set(kind, { spec, chain: Promise.resolve(), pending: new Map(), casts: new Map(), seq: 0 });
    defineNoteKindV2(kind, { keepMs: 6 * 3600 * 1000, perTarget: 5 });
  }
  const jobLog = (spec) => {
    if (!Array.isArray(socialV2[spec.logField])) socialV2[spec.logField] = [];
    return socialV2[spec.logField];
  };
  function pendingJobsV2(kind) {
    return [...(kinds.get(kind)?.pending.values() ?? [])];
  }
  // 今天做了几个（没做成的不算）
  function todayJobsV2(kind, now = Date.now()) {
    const k = kinds.get(kind);
    if (!k) return 0;
    const day = localDay(now);
    return jobLog(k.spec).filter((x) => x.ok !== false && localDay(Number(x.at)) === day).length;
  }

  // 记一条、排上队，返回 { entry, ahead }（ahead：前面还有几个）
  function submitJobV2(kind, fields, now = Date.now()) {
    const k = kinds.get(kind);
    if (!k) throw new Error(`没有这种活：${kind}`);
    const { spec } = k;
    const entry = { id: `${spec.idPrefix}${(now % 1e8).toString(36)}${(k.seq++).toString(36)}`, at: now, ...fields, ok: null };
    const list = jobLog(spec);
    list.push(entry);
    if (list.length > 300) list.splice(0, list.length - 300);
    saveSocialV2State();
    const ahead = k.pending.size;
    k.pending.set(entry.id, entry);
    // 画里的人（头像描述、人物卡）趁排队的时候先查好
    if (entry.people?.length) k.casts.set(entry.id, castTextV2(entry.key, entry.people).catch(() => ({ text: '', names: [] })));
    const fail = (error) => log(`${spec.tag} 出错了：${error?.message ?? error}`);
    if (spec.overlap) {
      const started = k.chain.then(() => waitStartV2(k, entry));
      k.chain = started.catch(() => {});
      started.then(() => runJobV2(kind, entry)).catch(fail);
    } else {
      k.chain = k.chain.then(async () => {
        await waitStartV2(k, entry);
        await runJobV2(kind, entry);
      }).catch(fail);
    }
    return { entry, ahead };
  }

  // 上一个开做（记录里的 startedAt，重启后也算）不到 minIntervalMs 就先等着
  async function waitStartV2(k, entry) {
    const { spec } = k;
    const gap = Number(spec.cfg().minIntervalMs) || 0;
    const lastStart = Math.max(0, ...jobLog(spec).filter((x) => x !== entry).map((x) => Number(x.startedAt) || 0));
    const readyAt = lastStart + gap;
    if (readyAt > Date.now()) log(`${spec.tag} 离上一${spec.unit}开${spec.verb}不到 ${Math.round(gap / 1000)} 秒，等 ${Math.ceil((readyAt - Date.now()) / 1000)} 秒再${spec.verb}`);
    // 计时器可能早醒一两毫秒，等到真的够了
    while (readyAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, readyAt - Date.now()));
    entry.startedAt = Date.now();
    saveSocialV2State();
  }

  async function runJobV2(kind, entry) {
    const k = kinds.get(kind);
    const { spec } = k;
    const { key, from } = entry;
    const byPlay = from === PLAY_KEY;
    try {
      const cast = k.casts.has(entry.id) ? await k.casts.get(entry.id) : { text: '', names: [] };
      k.casts.delete(entry.id);
      if (cast.names?.length) entry.cast = cast.names;
      const product = await spec.produce(entry, cast.text || '');
      entry.model = product.model;
      if (socialV2.paused || !isSessionAllowedInCurrentMode(key) || shouldBlockSilentReply(key)) throw new Error(spec.blockedError);
      let sent = null;
      for (const [i, part] of product.parts.entries()) {
        try {
          const r = await sendSegmentsV2(key, part.segments, part.opts);
          if (i === 0) sent = r;
        } catch (error) {
          if (i === 0) throw new Error(`${spec.sendFailedPrefix}（${error?.message ?? error}）`);
          log(`${spec.tag} 第 ${i + 1} 条没发出去：${error?.message ?? error}`);
        }
      }
      const now = Date.now();
      const { file } = product;
      const st = recordOwnImageV2(key, { messageId: sent?.messageId, text: product.text, file, byPlay, now });
      const mine = st.recentMessages[st.recentMessages.length - 1];
      if (mine && product.media) mine.media = product.media;
      st.lastActionAt = now;
      if (!byPlay) {
        st.lastAiReplyAt = now;
        st.wakeConfig.noActionCount = 0;
      }
      Object.assign(entry, { ok: true, doneAt: now, ...(file ? { file } : {}), ...(product.record || {}), ...(sent?.messageId ? { messageId: String(sent.messageId) } : {}) });
      saveSocialV2State();
      void reportArtworkV2(kind, entry);
      afterSentV2(key);
      const where = convLabelV2(key, socialV2.conversations.get(key));
      notePlayLogV2({ at: now, what: `${byPlay ? '' : '在聊天里'}${spec.playWhat(entry)}（发到了${where}）` });
      log(`${spec.tag} 发到 ${key} 了（${entry.model}${spec.logFile && file ? `，存成 ${file}` : ''}）`);
      appendActivity(`${key} ${spec.tag} ${spec.verb}好发出去了：${spec.label(entry)}`);
    } catch (error) {
      Object.assign(entry, { ok: false, doneAt: Date.now(), error: String(error?.message ?? error).slice(0, 200), ...(error?.refused ? { refused: true } : {}) });
      saveSocialV2State();
      log(`${spec.tag} 没${spec.verb}成（${key}）：${entry.error}`);
      appendActivity(`${key} ${spec.tag} 没${spec.verb}成：${spec.label(entry)}`);
    } finally {
      k.pending.delete(entry.id);
      k.casts.delete(entry.id);
    }
    await notifyJobV2(kind, entry);
  }

  // 做好的画和视频记进 extras 的作品集（POST /artworks，一直留着；drawLog / videoLog 只留 300 条）：
  // 成长记录挑“第一次画…”时看它，以后翻她小时候的画也靠它。没记上不要紧，下次重启 start() 会补
  async function reportArtworkV2(kind, entry) {
    if (!entry?.ok || !entry.file || typeof extrasPostV2 !== 'function') return false;
    try {
      await extrasPostV2('/artworks', {
        kind, id: entry.id, file: entry.file, ...(entry.mp4 ? { mp4: entry.mp4 } : {}), prompt: entry.prompt || '',
        caption: entry.caption || '', key: entry.key, from: entry.from, at: Number(entry.doneAt || entry.at) || Date.now(),
        ...(entry.cast?.length ? { people: entry.cast } : {}), ...(entry.messageId ? { messageId: entry.messageId } : {}),
      }, 10000);
      if (!entry.artworkSaved) {
        entry.artworkSaved = true;
        saveSocialV2State();
      }
      return true;
    } catch (error) {
      log(`[作品集] ${entry.id} 没记上，下次重启再补：${error?.message ?? error}`);
      return false;
    }
  }

  // 告诉发起的窗口：正聊着插一句，不在就留话；没做成又不在聊，按 spec 叫她一次（做好了的已经发出去了，大家会接着说，不专门叫）
  async function notifyJobV2(kind, entry) {
    const { spec } = kinds.get(kind);
    const to = entry.from;
    const st = getSocialV2State(to);
    const text = `【${spec.steerTitle(entry.ok)}】${to}（令牌 ${st.agentToken}）${spec.resultText(entry, to)}。${spec.steerTail(entry, to)}`;
    if (await tellWindowV2(to, text, spec.tag)) {
      log(`${spec.tag} 告诉 ${to} 了（插话）`);
      return 'steered';
    }
    leaveNoteV2(kind, to, { id: entry.id });
    if (!entry.ok && spec.wakeOnFail && spec.wakeReason && to !== PLAY_KEY) {
      void sendWakePromptV2(to, spec.wakeReason).catch((error) => log(`${spec.tag} 叫醒 ${to} 失败：${error?.message ?? error}`));
      return 'woken';
    }
    return 'stored';
  }

  // 拼进唤醒提示：做完了的（交代一次）和还在做的（每次都写，被问“好了吗”心里有数）
  function jobPromptLineV2(kind, key, now = Date.now()) {
    const k = kinds.get(kind);
    if (!k) return '';
    const { spec } = k;
    const notes = notesOfV2(key, kind, now);
    noteNotesShownV2(key, kind, notes.map((n) => n.id));
    const byId = new Map(jobLog(spec).map((x) => [x.id, x]));
    const lines = notes.map((n) => byId.get(n.id)).filter(Boolean).map((e) => `- ${spec.resultText(e, key)}`);
    for (const e of k.pending.values()) if (e.from === key) lines.push(`- ${spec.pendingText(e, key)}`);
    if (!lines.length) return '';
    const failed = notes.some((n) => byId.get(n.id)?.ok === false);
    return `【${spec.section}】\n${lines.join('\n')}\n${failed ? `${spec.failedFooter}\n` : ''}\n`;
  }
  function jobsPromptLineV2(key, now = Date.now()) {
    return [...kinds.keys()].map((kind) => jobPromptLineV2(kind, key, now)).join('');
  }
  // 补发唤醒时看：这种活的留话这一轮里是不是已经给她看过了
  function jobKindOfWakeReasonV2(reason) {
    for (const [kind, k] of kinds) if (k.spec.wakeReason === reason) return kind;
    return null;
  }

  return {
    exports: {
      defineJobKindV2, defineNoteKindV2, jobKindOfWakeReasonV2, jobPromptLineV2, jobsPromptLineV2, leaveNoteV2,
      markNotesShownV2, noteNotesShownV2, notesOfV2, pendingJobsV2, reportArtworkV2, submitJobV2, tellWindowV2, todayJobsV2,
    },
    link() {
      ({
        afterSentV2, castTextV2, convLabelV2, extrasPostV2, getSocialV2State, notePlayLogV2, ownVideoOfV2, recordOwnImageV2,
        saveSocialV2State, sendSegmentsV2, sendWakePromptV2, socialV2, turnRunningV2
      } = app);
    },
    start() {
      // 上次没做完就重启了：算没做成，留话告诉她一声
      const now = Date.now();
      for (const [kind, { spec }] of kinds) {
        let n = 0;
        for (const e of jobLog(spec)) {
          if (e.ok !== null && e.ok !== undefined) continue;
          Object.assign(e, { ok: false, doneAt: now, error: spec.restartError });
          if (now - Number(e.at) < keepOf(kind)) leaveNoteV2(kind, e.from, { id: e.id }, now);
          n++;
        }
        if (n) {
          saveSocialV2State();
          log(`${spec.tag} 重启前有 ${n} ${spec.unit}没${spec.verb}完，算没${spec.verb}成`);
        }
      }
      // 作品集：做好了还没记进 extras 的补上（第一次上线时把 drawLog / videoLog 里的都补进去），一个一个来、不急
      const unsaved = [...kinds.keys()].flatMap((kind) => jobLog(kinds.get(kind).spec).filter((e) => e.ok && e.file && !e.artworkSaved).map((e) => [kind, e]));
      if (unsaved.length) {
        app.scheduler.after('artworks-backfill', 30 * 1000, async () => {
          let n = 0;
          for (const [kind, e] of unsaved) {
            if (kind === 'video' && !e.mp4) e.mp4 = ownVideoOfV2?.(e.file) || undefined;
            if (await reportArtworkV2(kind, e)) n++;
          }
          log(`[作品集] 补记了 ${n}/${unsaved.length} 件`);
        });
      }
    },
  };
}
