// qqbot_agent：她说的自己的事前后对得上（2026-10-23 的几件事）：
// - 玩了 5 回只看得到最后一回，说“就晚上玩了一阵”：【你现在】里写今天的每一回（playSessions，旧数据从 freeTimeHistory 补）；
// - “他一睡我就告诉你”：qq_remind_me 的 waitFor/waitWords 等那个人说话；没安排时发送结果里提醒一句；
// - 前一句“我吃完也去躺一下”、后一句“还没吃呢”：发完话交给 extras /self/check，抽出她说的自己的事记进 selfClaims，
//   对不上的插一句【说岔了】（她不在就下次唤醒时带上）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const clock = (minutesFromNow) => {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// 醒着，差不多一整天前起的床
const awakeAllDay = () => ({ enabled: true, from: clock(1), to: clock(2) });
const promptText = (p) => p.content.map((c) => String(c?.text ?? '')).join('\n');
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const H = 3600000;

function extrasFetch(routes, seen) {
  return async (url, init = {}) => {
    const m = /^http:\/\/extras:8940(\/[^?]*)/.exec(String(url));
    if (m && routes[m[1]]) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      seen.push({ path: m[1], body });
      const data = await routes[m[1]](body);
      return { ok: true, status: 200, json: async () => data };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
}

async function fixture(socialV2, routes, run) {
  const seen = [];
  const h = await bridgeHarness({
    config: { ownerQQ: '42', extraOwnerQQ: ['43'], ownerTitles: { 42: '爸爸', 43: '妈妈' }, homeGroups: ['456'],
      allow: { private: ['42', '43'], groups: ['456', '789'] }, socialV2: {
        wake: { preSleepWaitEnabled: false, batchWindowMs: 300 }, proactive: { enabled: false }, sticker: { enabled: false },
        wait: { minMs: 100 }, nightSleep: awakeAllDay(), longTermMemory: { enabled: false }, ...socialV2,
      } },
    globals: { fetch: extrasFetch(routes, seen) },
  });
  h.setMode('reserved2');
  for (const k of ['group:456', 'group:789', 'private:42', 'private:43']) h.getSocialV2State(k).bootstrapSent = true;
  const steers = () => h.calls.prompts.filter((p) => p.mode === 'steer').map(promptText);
  const wakes = () => h.calls.prompts.filter((p) => p.mode !== 'steer').map(promptText);
  const busy = async (key) => {
    await h.sendWakePromptV2(key, 'atMention');
    h.v2TurnStartAt.set(h.state.sessions[key], Date.now());
  };
  const idle = (key) => {
    h.pendingWakeKeys.delete(key);
    const sid = h.state.sessions?.[key];
    if (sid) h.v2TurnStartAt.delete(sid);
    const s = h.getSocialV2State(key);
    if (s.pendingWakeTimer) { clearTimeout(s.pendingWakeTimer); s.pendingWakeTimer = null; }
  };
  try { await run({ h, seen, steers, wakes, busy, idle }); } finally { await h.close(); }
}
const say = (h, key, sender, text, userId, isOwner = false, id = Math.floor(Math.random() * 1e6)) =>
  h.appendSocialV2Message(key, sender, text, text, false, isOwner, id, [], userId);
const selfNow = (h, key) => h.selfNowPartsV2(key).lines.join('\n');

// ── A：今天玩了几回 ──────────────────────────────────────────────────────────

test('【你现在】写出今天的每一回，跨了上午下午晚上就提醒别说成只玩了一阵', () => fixture({}, {}, async ({ h }) => {
  const now = Date.now();
  const spans = [[20, 19.7], [15, 14.6], [10, 9.7], [5, 4.6], [1, 0.65]];
  for (const [a, b] of spans) {
    h.notePlaySessionV2('start', now - a * H, 'proactiveCheck');
    h.notePlaySessionV2('end', now - b * H);
  }
  assert.equal(h.socialV2.playSessions.length, 5);
  const text = selfNow(h, 'private:43');
  const line = text.split('\n').find((l) => l.startsWith('- 今天上电脑玩了'));
  assert.ok(line, text);
  assert.match(line, /玩了 5 回/);
  assert.equal(line.match(/\d{4}-\d\d-\d\d \d\d:\d\d~\d{4}-\d\d-\d\d \d\d:\d\d/g).length, 5);
  assert.match(line, /加起来大概 1\d\d 分钟/);
  assert.match(line, /都玩过，别说成只玩了一阵/);
  // 正在玩的那回
  h.notePlaySessionV2('start', now - 10 * 60000);
  assert.match(selfNow(h, 'private:43'), /玩了 6 回：.*\d{4}-\d\d-\d\d \d\d:\d\d 起到现在/);
}));

test('上一回没记到结束（重启）：开始下一回时按最后一条 playLog 补上', () => fixture({}, {}, async ({ h }) => {
  const now = Date.now();
  h.notePlaySessionV2('start', now - 3 * H);
  h.socialV2.playLog = [{ at: now - 2.5 * H, what: '看了个视频' }];
  h.notePlaySessionV2('start', now - H);
  assert.equal(h.socialV2.playSessions[0].end, now - 2.5 * H);
  assert.equal(h.socialV2.playSessions[1].end, 0);
}));

test('旧数据没有 playSessions：从 freeTimeHistory + playLog/dayPlay 补出来', () => fixture({}, {}, async ({ h }) => {
  const now = Date.now();
  h.socialV2.freeTimeHistory = [
    { at: now - 6 * H, key: 'play:main', kinds: ['bili'] },
    { at: now - 3 * H, key: 'play:main', kinds: ['game'] },
    { at: now - 2 * H, key: 'private:42', kinds: ['news'] },
    { at: now - 40 * H, key: 'play:main', kinds: ['news'] },
  ];
  h.socialV2.life.dayPlay = [{ at: now - 5.8 * H, what: 'a' }, { at: now - 5.6 * H, what: 'b' }];
  h.socialV2.playLog = [{ at: now - 2.7 * H, what: 'c' }];
  h.socialV2.playStartedAt = now - 3 * H;
  h.socialV2.playEndedAt = now - 2.5 * H;
  const list = h.backfillPlaySessionsV2(now);
  assert.deepEqual(list.map((x) => [x.start, x.end]), [[now - 6 * H, now - 5.6 * H], [now - 3 * H, now - 2.5 * H]]);
}));

// ── B1：等人说话的提醒 ──────────────────────────────────────────────────────

test('waitFor=爸爸 + waitWords：爸爸说“还没睡”“睡了吗”不算，说“我去睡了”就叫她回来，提示里有原话', () => fixture({}, {}, async ({ h, wakes }) => {
  const r = h.remindMeV2('group:456', { note: '告诉妈妈爸爸几点睡的', waitFor: '爸爸', waitWords: '睡了,晚安,去睡' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.hint, /现在是真的了/);
  const rem = h.socialV2.reminders[0];
  assert.deepEqual(JSON.parse(JSON.stringify(rem.wait)), { who: '爸爸', userId: '42', words: ['睡了', '晚安', '去睡'], in: 'any' });
  assert.ok(Math.abs(rem.due - (Date.now() + 180 * 60000)) < 2000, '没填时间：最晚等 3 小时');
  say(h, 'group:456', '阿红', '他睡了吗', '43', true);
  say(h, 'private:42', '阿明', '我还没睡了，周五多玩会', '42', true);
  say(h, 'private:42', '阿明', '你睡了吗', '42', true);
  assert.equal(rem.triggered, undefined);
  say(h, 'private:42', '阿明', '好了我去睡了', '42', true);
  assert.equal(rem.triggered.key, 'private:42');
  await sleepMs(120);
  const p = wakes().at(-1);
  assert.match(p, /【到点了】[\s\S]*等 爸爸说“睡了\/晚安\/去睡”，现在等到了：\d{4}-\d\d-\d\d \d\d:\d\d 阿明在别处说了“好了我去睡了”[\s\S]*告诉妈妈爸爸几点睡的/);
}));

test('等到的话是在私聊里说的：家里以外的群里不带原话；没等到的写“没等到，别编”', () => fixture({}, {}, async ({ h }) => {
  h.remindMeV2('group:789', { note: '告诉大家他睡了', waitFor: '42', waitWords: '晚安' });
  const rem = h.socialV2.reminders[0];
  say(h, 'private:42', '阿明', '晚安宝宝', '42', true);
  assert.ok(rem.triggered);
  const t = h.reminderFiredTextV2(rem, 'group:789');
  assert.match(t, /在别处说了（那边的原话不在这里说）/);
  assert.doesNotMatch(t, /宝宝/);
  const r2 = { ...rem, triggered: undefined };
  assert.match(h.reminderFiredTextV2(r2, 'group:789'), /一直等到现在也没等到[\s\S]*别编成已经等到了/);
}));

test('waitFor 校验：不能等自己，waitIn 要在白名单；名字从最近消息里认；关掉开关就只能定时间', () => fixture({}, {}, async ({ h }) => {
  h.setSelfIdentity('鱼妹', '999');
  say(h, 'group:456', '阿杰同学', '我先吃饭', '777');
  let r = h.remindMeV2('group:456', { note: 'x', waitFor: '阿杰', waitWords: '吃完' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.socialV2.reminders.at(-1).wait.userId, '777');
  r = h.remindMeV2('group:456', { note: 'x', waitFor: '42', waitIn: 'group:111' });
  assert.equal(r.ok, false);
  r = h.remindMeV2('private:42', { note: 'x', waitFor: '阿明' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.socialV2.reminders.at(-1).wait.in, 'private:42', '私聊里默认只看这里');
  h.cfg.socialV2.remindWait = { enabled: false };
  r = h.remindMeV2('group:456', { note: 'x', waitFor: '42' });
  assert.equal(r.ok, false);
}));

// ── B2：“他一睡我就告诉你”“我正盯着呢” ─────────────────────────────────────

test('识别做不到的条件承诺和“盯着”，不误伤别的说法', () => fixture({}, {}, async ({ h }) => {
  for (const t of ['好，他一睡我就告诉你', '我正盯着呢', '我盯着的', '我帮你看着他', '等爸爸睡了我就跟你说', '等他下班了再叫你'])
    assert.equal(h.condPromiseSaidV2(t), true, t);
  for (const t of ['我刚才看着他们打游戏', '你盯着点锅', '一睡就是一下午', '我看着都饿了吗', '你们看着办', '我在看视频'])
    assert.equal(h.condPromiseSaidV2(t), false, t);
}));

test('发送结果里提醒一句（每轮一次）；这一轮记了等人说话的提醒就不提', () => fixture({}, {}, async ({ h, busy }) => {
  await busy('group:456');
  const hint = h.promiseHintV2('group:456', ['好，他一睡我就告诉你']);
  assert.match(hint, /waitFor=那个人/);
  assert.equal(h.promiseHintV2('group:456', ['我正盯着呢']), null, '每轮一次');
  await busy('group:789');
  h.remindMeV2('group:789', { note: '告诉大家', waitFor: '42', waitWords: '睡了' });
  assert.equal(h.promiseHintV2('group:789', ['他一睡我就告诉你们']), null);
}));
test('“我这就去画”：认出来，提示她用 qq_go_play；说过去、劝别人的不算；这一轮托过了就不提', () => fixture({}, {}, async ({ h, busy }) => {
  for (const t of ['好耶，那我先去画画啦～', '嘿嘿，那我这就去画啦', '我这就去画会掉饼干的小家伙，画好就给你们看', '那我乖乖去画画咯', '画好了先给你们看', '我先去玩会儿'])
    assert.equal(h.goDoSaidV2(t), true, t);
  for (const t of ['我昨天去玩了一下', '你们去玩吧', '他去画画了', '上午去玩过 2048', '画得好可爱', '我画的那只海豹', '你画好了给我看看'])
    assert.equal(h.goDoSaidV2(t), false, t);
  await busy('group:456');
  const hint = h.promiseHintV2('group:456', ['嘿嘿，那我这就去画啦']);
  assert.match(hint, /qq_go_play/);
  assert.match(hint, /别说“这就去”/);
  assert.equal(h.promiseHintV2('group:456', ['我先去画画啦']), null, '每轮一次');
  await busy('group:789');
  h.getSocialV2State('play:main').playRequests = [{ from: 'group:789', at: Date.now(), note: '画海豹' }];
  assert.equal(h.promiseHintV2('group:789', ['我这就去画']), null, '托过了');
  h.cfg.socialV2.promiseHint = { goDo: false };
  await busy('private:42');
  assert.equal(h.promiseHintV2('private:42', ['我这就去画']), null, 'goDo:false 关掉');
}));
test('等自己不行', () => fixture({}, {}, async ({ h }) => {
  h.setSelfIdentity('鱼妹', '19811729');
  assert.equal(h.remindMeV2('group:456', { note: 'x', waitFor: '19811729' }).ok, false);
}));

// ── C：发完话自己核对一遍 ────────────────────────────────────────────────────

const SC = { selfCheck: { enabled: true, debounceMs: 500 } };

test('默认关着：发完话不去 extras 查', () => fixture({}, { '/self/check': () => ({ ok: true }) }, async ({ h, seen }) => {
  h.recordSentMessagesV2('group:456', ['还没吃呢，我刚玩起来就忘了']);
  await sleepMs(700);
  assert.equal(seen.length, 0);
  assert.equal(h.selfCheckCfgV2().enabled, false);
}));

test('粗筛：只查说自己状态、做过什么、答应什么的', () => fixture(SC, {}, async ({ h }) => {
  for (const t of ['还没吃呢，我刚玩起来就忘了', '那就好，我吃完也去躺一下下', '他一睡我就告诉你', '我今天看了个鲸鱼娘的视频', '也不是一整天啦，就晚上玩了一阵'])
    assert.equal(h.selfTalkWorthCheckingV2(t), true, t);
  for (const t of ['哈哈哈哈', '你也太惨了吧', '[表情包:不想干]', '草', '你才累，上了一整天班'])
    assert.equal(h.selfTalkWorthCheckingV2(t), false, t);
}));

test('合并一批去查：带上【你现在】、这里的聊天、别处的事、之前说过的；抽出的事记下来，每个窗口都看得到', () => {
  const routes = { '/self/check': (b) => ({ ok: true, claims: b.said.some((s) => s.includes('还没吃')) ? ['还没吃午饭'] : ['跟爸爸说了晚安'], conflicts: [], promises: [] }) };
  return fixture(SC, routes, async ({ h, seen }) => {
    say(h, 'group:456', '阿红', '宝宝你终于吃了吗', '43', true);
    h.recordSentMessagesV2('group:456', ['哈哈']);
    h.recordSentMessagesV2('group:456', ['还没吃呢，我刚玩起来就忘了']);
    await sleepMs(700);
    assert.equal(seen.length, 1, '一批只查一次');
    const b = seen[0].body;
    assert.deepEqual([...b.said], ['还没吃呢，我刚玩起来就忘了'], '粗筛过的才送');
    assert.ok(b.context.some((l) => l.includes('宝宝你终于吃了吗')), JSON.stringify(b.context));
    assert.ok(b.facts.some((l) => l.startsWith('- 睡觉：醒着')));
    assert.equal(b.place.length > 0, true);
    assert.deepEqual([...h.socialV2.selfClaims.map((x) => x.text)], ['还没吃午饭']);
    // 别的窗口（家里的群 / 私聊）看得到，标“（这里）”的只有自己那处
    assert.match(selfNow(h, 'group:456'), /今天你说过的自己的事[\s\S]*（这里） 还没吃午饭/);
    assert.match(selfNow(h, 'private:43'), /今天你说过的自己的事[^\n]*）：\d{4}-\d\d-\d\d \d\d:\d\d 还没吃午饭/);
    // 私聊里说的带称呼的，家里以外的群看不到
    h.recordSentMessagesV2('private:42', ['我也去睡啦，晚安']);
    await sleepMs(700);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].body.claims.length, 1, '之前说过的一起带上');
    assert.match(selfNow(h, 'group:456'), /跟爸爸说了晚安/);
    assert.doesNotMatch(selfNow(h, 'group:789'), /跟爸爸说了晚安/);
    assert.match(selfNow(h, 'group:789'), /还没吃午饭/);
    // 同一句 3 小时内不重记
    assert.equal(h.addSelfClaimsV2('group:456', ['还没吃午饭']), 0);
  });
});

test('对不上：正在聊就插一句【说岔了】；10 分钟内同一处不再插', () => {
  const routes = { '/self/check': () => ({ ok: true, claims: ['还没吃午饭'], conflicts: [{ said: '还没吃呢', truth: '你十秒前刚说了自己吃完了' }], promises: [] }) };
  return fixture(SC, routes, async ({ h, busy, steers }) => {
    await busy('group:456');
    const out = await h.runSelfCheckV2('group:456', ['还没吃呢，我刚玩起来就忘了']);
    assert.equal(out.steered, true, JSON.stringify(out));
    const t = steers().at(-1);
    assert.match(t, /【说岔了】group:456（令牌 [0-9a-f]+）你刚才说的跟真实情况对不上：\n- 你说“还没吃呢”，可实际上你十秒前刚说了自己吃完了/);
    assert.match(t, /开玩笑[\s\S]*就不用管/);
    const again = await h.runSelfCheckV2('group:456', ['还没吃呢']);
    assert.equal(again.steered, undefined);
    assert.equal(steers().length, 1);
  });
});

test('她已经走了：下次在这里被叫醒时提示里带上，送到了就清掉；过了 pendingMinutes 就算了', () => {
  const routes = { '/self/check': () => ({ ok: true, claims: [], conflicts: [], promises: [{ said: '他一睡我就告诉你', why: '你看不到爸爸什么时候睡' }] }) };
  return fixture(SC, routes, async ({ h, wakes, idle }) => {
    const out = await h.runSelfCheckV2('group:456', ['好，他一睡我就告诉你']);
    assert.equal(out.pending, true, JSON.stringify(out));
    await h.sendWakePromptV2('group:456', 'atMention');
    const p = wakes().at(-1);
    assert.match(p, /【说岔了】\d{4}-\d\d-\d\d \d\d:\d\d 你在这里你刚才说的跟真实情况对不上：\n- 你答应了“他一睡我就告诉你”，可你看不到爸爸什么时候睡/);
    assert.match(p, /waitFor\/waitWords/);
    assert.equal(h.getSocialV2State('group:456').selfCheckPending, null);
    idle('group:456');
    await h.sendWakePromptV2('group:456', 'atMention');
    assert.doesNotMatch(wakes().at(-1), /【说岔了】/);
    const st = h.getSocialV2State('group:456');
    st.selfCheckPending = { at: Date.now() - 31 * 60000, text: 'x' };
    assert.equal(h.selfCheckPromptLineV2('group:456'), '');
  });
});

test('答应的事这一轮已经记了等人说话的提醒：不算做不到', () => {
  const routes = { '/self/check': () => ({ ok: true, claims: [], conflicts: [], promises: [{ said: '他一睡我就告诉你', why: '看不到' }] }) };
  return fixture(SC, routes, async ({ h }) => {
    h.remindMeV2('group:456', { note: '告诉妈妈', waitFor: '爸爸', waitWords: '睡了' });
    const out = await h.runSelfCheckV2('group:456', ['好，他一睡我就告诉你']);
    assert.equal(out.problems.length, 0);
  });
});

test('全局一小时最多插 perHour 次；correct:false 只记不插；extras 出错不影响', () => {
  let fail = false;
  const routes = { '/self/check': () => (fail ? { ok: false, error: 'boom' } : { ok: true, claims: [], conflicts: [{ said: '就晚上玩了一阵', truth: '你今天玩了 5 回' }], promises: [] }) };
  return fixture({ selfCheck: { enabled: true, perHour: 1, minIntervalMinutes: 0 } }, routes, async ({ h, steers }) => {
    assert.equal((await h.runSelfCheckV2('group:456', ['我今天就晚上玩了一阵'])).pending, true);
    assert.equal((await h.runSelfCheckV2('private:42', ['我今天就晚上玩了一阵'])).pending, undefined, '这一小时够了');
    h.cfg.socialV2.selfCheck = { enabled: true, correct: false };
    const out = await h.runSelfCheckV2('private:43', ['我今天就晚上玩了一阵']);
    assert.equal(out.problems.length, 1);
    assert.equal(out.pending, undefined);
    fail = true;
    assert.equal(await h.runSelfCheckV2('private:43', ['我今天就晚上玩了一阵']), null);
    assert.equal(steers().length, 0);
  });
});

test('自由时间那边说的不查；ledger:false 不记也不显示', () => {
  const routes = { '/self/check': () => ({ ok: true, claims: ['吃过午饭了'], conflicts: [], promises: [] }) };
  return fixture({ selfCheck: { enabled: true, debounceMs: 500, ledger: false } }, routes, async ({ h, seen }) => {
    h.queueSelfCheckV2('play:main', ['我今天看了好多视频']);
    await sleepMs(700);
    assert.equal(seen.length, 0);
    await h.runSelfCheckV2('group:456', ['我吃过午饭了']);
    assert.equal(seen.length, 1);
    assert.equal((h.socialV2.selfClaims || []).length, 0);
    assert.equal(h.selfClaimsLineV2('group:456', h.sleepStateV2()), '');
  });
});
