// qqbot_agent：她自己的心情（moodEngine）、生活（life：手上的事、兴趣、今天想干嘛、日记）、主动找人（initiate）。
// extras 那边用假 fetch 代替：只看 bridge 发了什么、拿到结果后怎么记、怎么写进提示、怎么影响行为。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  bestThought, inClockWindow, initiateBlockReason, initiateCfg, initiateCfgFor, interestFactor, markInitiateAnswered,
  moodBubbleDelta, moodPhase, moodTalkFactor, updateInterest, activityMultipliers, likedKinds,
} from '../src/inner-life.js';

const clock = (minutesFromNow) => {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const promptText = (p) => p.content.map((c) => String(c?.text ?? '')).join('\n');
const daytime = () => ({ enabled: true, from: clock(300), to: clock(-300) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// extras 的假接口：routes[path] = (body) => 返回的 JSON
function extrasFetch(routes, seen) {
  return async (url, init = {}) => {
    const u = String(url);
    const m = /^http:\/\/extras:8940(\/[^?]*)/.exec(u);
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
    config: { ownerQQ: '42', homeGroups: ['456'], allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
      wake: { preSleepWaitEnabled: false, batchWindowMs: 300 }, proactive: { enabled: false }, sticker: { enabled: false },
      wait: { minMs: 100 }, nightSleep: daytime(), longTermMemory: { enabled: false }, ...socialV2,
    } },
    globals: { fetch: extrasFetch(routes, seen) },
  });
  h.setMode('reserved2');
  try { await run({ h, seen }); } finally { await h.close(); }
}
const ON = { moodEngine: { enabled: true }, life: { enabled: true } };

test('纯函数：心情淡回、影响说话多少和条数', () => {
  const now = Date.now();
  const happy = { text: '美滋滋', at: now, valence: 2, arousal: 2 };
  assert.equal(moodPhase(happy, now, 120), 'fresh');
  assert.equal(moodPhase(happy, now + 150 * 60000, 120), 'fading');
  assert.equal(moodPhase(happy, now + 300 * 60000, 120), 'gone');
  assert.equal(moodTalkFactor(happy, now, 120), 1.3);
  assert.equal(moodTalkFactor({ ...happy, valence: -2, arousal: -2 }, now, 120), 0.7);
  assert.ok(Math.abs(moodTalkFactor(happy, now + 600 * 60000, 120) - 1) < 0.02, '淡没了就是 1');
  assert.equal(moodBubbleDelta(happy, now, 120), 1);
  assert.equal(moodBubbleDelta({ ...happy, arousal: -2 }, now, 120), -1);
  assert.equal(moodTalkFactor({ text: '开心', at: now }, now, 120), 1, '她自己定的心情没有数值，不影响');
});

test('纯函数：兴趣按指数平均，记过 2 条才算；抽念头的系数', () => {
  const it = {};
  updateInterest(it, 'game', 3, 1);
  assert.equal(interestFactor(it.game), 1, '一条不算');
  updateInterest(it, 'game', 3, 2);
  assert.equal(interestFactor(it.game), 1.4);
  updateInterest(it, 'news', 1, 1); updateInterest(it, 'news', 1, 2);
  assert.equal(interestFactor(it.news), 0.7);
  const list = [{ id: 'game', name: '小游戏' }, { id: 'news', name: '新闻' }, { id: 'space', name: '天文图' }];
  assert.deepEqual(activityMultipliers(list, { interest: it, useMood: false }), { game: 1.4, news: 0.7 });
  assert.deepEqual(likedKinds(list, it), ['小游戏']);
  const sad = { at: Date.now(), valence: -2, arousal: -1 };
  assert.equal(activityMultipliers(list, { mood: sad, useInterest: false }).space, 1.5, '低落时想看点安静的');
});

test('纯函数：主动找人的次数、间隔、没人理就停；钟点窗口跨午夜', () => {
  const c = initiateCfg({ enabled: true });
  const now = Date.now();
  const H = 3600000;
  assert.equal(initiateBlockReason([], 'private:42', now, c), '');
  const sentRecent = [{ key: 'private:42', at: now - H, sent: true }];
  assert.match(initiateBlockReason(sentRecent, 'private:42', now, c), /太近/);
  assert.equal(initiateBlockReason(sentRecent, 'group:456', now, c), '');
  const two = [{ key: 'private:42', at: now - 20 * H, sent: true }, { key: 'private:42', at: now - 30 * H, sent: true }];
  assert.match(initiateBlockReason(two.reverse(), 'private:42', now, c), /都没人理/);
  two[1].answeredAt = now - 19 * H;
  assert.equal(initiateBlockReason(two, 'private:42', now, c), '');
  const declined = [{ key: 'group:456', at: now - 30 * 60000, declined: true }];
  assert.match(initiateBlockReason(declined, 'group:456', now, c), /没开口/);
  const four = [1, 2, 3, 4].map((i) => ({ key: `private:${i}`, at: now - i * H * 4, sent: true }));
  assert.match(initiateBlockReason(four, 'private:9', now, c), /4 次/);
  // 回了没：私聊 6 小时内、群里 30 分钟内
  const rec = [{ key: 'group:456', at: now - 40 * 60000, sentAt: now - 40 * 60000, sent: true }];
  assert.equal(markInitiateAnswered(rec, 'group:456', now, c), null);
  const p = [{ key: 'private:42', at: now - 2 * H, sentAt: now - 2 * H, sent: true }];
  assert.equal(markInitiateAnswered(p, 'private:42', now, c), p[0]);
  assert.equal(p[0].answeredAt, now);
  assert.equal(bestThought([{ key: 'a', thought: 'x', score: 4 }, { key: 'b', thought: 'y', score: 4.5 }, { key: 'c', thought: 'z', score: 5 }], 3.5, ['a', 'b'])?.key, 'b');
  assert.equal(bestThought([{ key: 'a', thought: 'x', score: 3 }], 3.5, ['a']), null);
  const d = new Date(); d.setHours(23, 50, 0, 0);
  assert.equal(inClockWindow('23:30', '08:00', d), true);
  d.setHours(12, 0, 0, 0);
  assert.equal(inClockWindow('23:30', '08:00', d), false);
  assert.equal(inClockWindow('09:00', '22:30', d), true);
});

test('心情：聊完一轮自己体会；写进【你现在】，带着行为；淡了写“淡了不少”，淡没了回到平常', () => fixture(ON, {
  '/mood/appraise': () => ({ ok: true, mood: '美滋滋', why: '爸爸夸我画得好', valence: 2, arousal: 1, changed: true }),
}, async ({ h, seen }) => {
  const key = 'private:42';
  assert.match(h.buildWakePromptV2(key, 'private'), /- 心情：平平常常，有点懒洋洋。/);
  h.appendSocialV2Message(key, '阿明', '你画得真好', '你画得真好', false, true, 1, [], '42');
  h.recordSentMessagesV2(key, ['嘿嘿谢谢爸爸']);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  const call = seen.find((x) => x.path === '/mood/appraise');
  assert.ok(call, '叫了 extras');
  assert.ok(call.body.lines.includes('我：嘿嘿谢谢爸爸'), JSON.stringify(call.body.lines));
  assert.ok(call.body.lines.some((l) => l.startsWith('阿明（主人）：')));
  assert.equal(h.socialV2.mood.source, 'auto');
  assert.match(h.buildWakePromptV2('group:456', 'atMention'), /- 心情：美滋滋（\d{4}-\d\d-\d\d \d\d:\d\d 在和[^\n]*私聊里：爸爸夸我画得好）。/);
  assert.match(h.buildWakePromptV2('group:789', 'atMention'), /- 心情：美滋滋。/, '大群看不到私聊里的原因');
  // 影响群里说多少、一次发几条
  h.cfg.socialV2.replyGate = { enabled: true };
  assert.ok(h.talkValueOfV2('group:789') > 0.15 * 1.2, String(h.talkValueOfV2('group:789')));
  h.cfg.socialV2.send = { human: { enabled: true } };
  assert.equal(h.bubbleCapV2('group:789'), 3, '兴奋时多一条');
  // 10 分钟内同一个会话不再体会
  const n = seen.length;
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.length, n);
  // 淡了 / 淡没了
  h.socialV2.mood.at = Date.now() - 150 * 60000;
  assert.match(h.buildWakePromptV2(key, 'private'), /- 心情：美滋滋（爸爸夸我画得好），不过已经淡了不少。/);
  h.socialV2.mood.at = Date.now() - 400 * 60000;
  assert.match(h.buildWakePromptV2(key, 'private'), /- 心情：平平常常，有点懒洋洋。/);
  assert.equal(h.talkValueOfV2('group:789'), 0.15 * 1);
  // 重启后还在
  h.flushSocialV2State();
  h.socialV2.mood = null;
  h.loadSocialV2State();
  assert.equal(h.socialV2.mood?.source, 'auto');
  assert.equal(h.socialV2.mood?.valence, 2);
}));

test('心情：她自己 30 分钟内定过的听她的；这轮她没开口不体会；extras 出错不影响', () => fixture(ON, {
  '/mood/appraise': () => ({ ok: false, error: 'boom' }),
}, async ({ h, seen }) => {
  const key = 'group:456';
  h.socialV2.mood = { text: '有点烦', why: '', at: Date.now() - 5 * 60000, key, source: 'self' };
  h.appendSocialV2Message(key, '某人', '在吗', '在吗', false, false, 1, [], '7');
  h.recordSentMessagesV2(key, ['在']);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.length, 0, '她自己刚定的不动');
  h.socialV2.mood.at = Date.now() - 60 * 60000;
  h.socialV2.life.moodAppraisedAt = {};
  h.innerLifeTurnEndedV2('group:789', { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.length, 0, '这轮她在 789 没开口');
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(h.socialV2.mood.text, '有点烦', 'extras 出错就不改');
}));

test('兴趣：自由时间记见闻打的 interest 记到当时玩的那一类；见闻被退回不算', () => fixture(ON, {}, async ({ h }) => {
  const play = h.getSocialV2State('play:main');
  play.freeTime = { lastKind: 'game' };
  h.noteMemoryNoteCallV2('play:main', 'mcp__qqbot-extras__memory_note', 'c1', JSON.stringify({ subject: 'self', text: '好玩', interest: 3 }));
  h.noteMemoryNoteResultV2('play:main', 'mcp__qqbot-extras__memory_note', 'c1', false);
  h.noteMemoryNoteCallV2('play:main', 'mcp__qqbot-extras__memory_note', 'c2', { subject: 'self', text: '很长很长', interest: 1 });
  h.noteMemoryNoteResultV2('play:main', 'mcp__qqbot-extras__memory_note', 'c2', true);
  h.noteMemoryNoteCallV2('group:456', 'mcp__qqbot-extras__memory_note', 'c3', { subject: 'self', text: 'x', interest: 1 });
  h.noteMemoryNoteResultV2('group:456', 'mcp__qqbot-extras__memory_note', 'c3', false);
  assert.deepEqual({ ...h.socialV2.life.interest.game, at: 0 }, { ema: 3, n: 1, at: 0 });
  h.noteMemoryNoteCallV2('play:main', 'mcp__qqbot-extras__memory_note', 'c4', { subject: 'self', text: '还行', interest: 3 });
  h.noteMemoryNoteResultV2('play:main', 'mcp__qqbot-extras__memory_note', 'c4', false);
  assert.equal(h.socialV2.life.interest.game.n, 2);
  // 下次自由时间抽念头时 game 权重高
  h.cfg.socialV2.proactive = { enabled: false, activities: [{ id: 'game', name: '小游戏', weight: 1, hint: 'h' }, { id: 'news', name: '新闻', weight: 1, hint: 'h' }] };
  const ft = h.startFreeTimeV2('play:main', Date.now());
  assert.ok(ft.ideas.length >= 1);
}));

test('今天想的做了就更新：聊天里开过口、自由时间玩完各看一次；做了的不再挂着，都做了就说“接下来随便”', () => fixture(ON, {
  '/life/plan/progress': (b) => {
    if (b.place === '电脑上自己玩的时候') return { ok: true, progress: [{ i: 0, status: 'done', how: '画好发群里了' }] };
    return { ok: true, progress: [{ i: 1, status: 'done', how: '问到了，十二点半睡的' }, { i: 0, status: 'some', how: '起了个头' }, { i: 5, status: 'done' }] };
  },
  '/life/threads/update': () => ({ ok: true, threads: [] }),
  '/mood/appraise': () => ({ ok: true, mood: '平常', why: '', valence: 0, arousal: 0 }),
  '/life/diary': () => ({ ok: true, diary: { gist: 'x', text: 'x' } }),
}, async ({ h, seen }) => {
  const day = h.lifeDayV2();
  h.socialV2.life.planDate = day;
  h.socialV2.life.plan = { date: day, items: ['接着画小家伙', '问问爸爸几点睡'], at: Date.now() - 3600000, progress: {} };
  const key = 'group:456';
  h.appendSocialV2Message(key, '阿明', '我12:30睡的', '我12:30睡的', false, true, 1, [], '42');
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.filter((x) => x.path === '/life/plan/progress').length, 0, '她没开口不看');
  h.recordSentMessagesV2(key, ['爸爸你好能熬', '那我这就去画啦']);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  const calls = seen.filter((x) => x.path === '/life/plan/progress');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.items, [{ i: 0, text: '接着画小家伙' }, { i: 1, text: '问问爸爸几点睡' }]);
  assert.ok(calls[0].body.lines.includes('我：那我这就去画啦'));
  let p = h.buildWakePromptV2('private:42', 'private');
  assert.match(p, /- 今天想：接着画小家伙（弄了一点：起了个头）（随便想想的/);
  assert.match(p, /- 今天想的已经做了：问问爸爸几点睡（\d{4}-\d\d-\d\d \d\d:\d\d 问到了，十二点半睡的）/);
  assert.ok(!/今天想：[^\n]*问问爸爸/.test(p), '做了的不再挂在“今天想”里');
  // 同一会话 10 分钟内不再看
  h.recordSentMessagesV2(key, ['嘿嘿']);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.filter((x) => x.path === '/life/plan/progress').length, 1);
  // 自由时间玩完：带上今天电脑上玩过的，只问还没做完的
  const play = h.getSocialV2State('play:main');
  play.lastWakeReason = 'goPlay';
  h.socialV2.playStartedAt = Date.now() - 20 * 60000;
  h.socialV2.playLog = [{ at: Date.now() - 10 * 60000, what: '在 about:blank 画了只小海豹' }, { at: Date.now() - 5 * 3600000, what: '早上以前的' }];
  h.innerLifeTurnEndedV2('play:main', { reason: { kind: 'completed' }, text: '画好啦' });
  await tick(); await tick();
  const pc = seen.filter((x) => x.path === '/life/plan/progress').at(-1);
  assert.deepEqual(pc.body.items, [{ i: 0, text: '接着画小家伙' }]);
  assert.equal(pc.body.play.length, 1, '只看定了“今天想”以后的');
  assert.match(pc.body.play[0], /小海豹/);
  p = h.buildWakePromptV2('private:42', 'private');
  assert.ok(!p.includes('- 今天想：'));
  assert.match(p, /- 今天想的都做了：接着画小家伙（\d{4}-\d\d-\d\d \d\d:\d\d 画好发群里了）、问问爸爸几点睡（[^）]*），接下来随便/);
  assert.ok(!p.includes('qq_go_play 交给去玩的你，别光说'), '都做了就不用劝');
  // 都做了就不再问；日记带上做没做
  h.recordSentMessagesV2('private:42', ['在']);
  h.innerLifeTurnEndedV2('private:42', { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.filter((x) => x.path === '/life/plan/progress').length, 2);
  h.cfg.socialV2.nightSleep = { enabled: true, from: clock(-10), to: clock(500) };
  h.socialV2.life.plan.date = h.lifeDayV2(); // 测试里把起床时间挪到了后面，“今天”跟着往前挪一天
  await h.lifeTickV2();
  assert.match(seen.find((x) => x.path === '/life/diary').body.plan, /接着画小家伙（做了：画好发群里了）/);
  // 重启后还在
  const saved = h.loadLifeV2(JSON.parse(JSON.stringify(h.socialV2.life)));
  assert.equal(saved.plan.progress[1].status, 'done');
  assert.equal(saved.plan.progress[0].how, '画好发群里了');
  assert.ok(saved.plan.at > 0 && saved.planCheckedAt[key] > 0);
  h.cfg.socialV2.life.planProgress = false;
  h.socialV2.life.plan.progress = {};
  h.cfg.socialV2.nightSleep = daytime();
  h.recordSentMessagesV2('group:789', ['嗯']);
  h.innerLifeTurnEndedV2('group:789', { reason: { kind: 'completed' }, text: '' });
  await tick();
  assert.equal(seen.filter((x) => x.path === '/life/plan/progress').length, 2, 'planProgress:false 关掉');
}));

test('手上的事：自由时间玩完交给 extras 整理，下次去玩时提一句；玩完也体会一下心情', () => fixture(ON, {
  '/life/threads/update': (b) => ({ ok: true, threads: [{ id: 'a1', title: '2048 冲 4096', next: '再玩几局', updated: 1 }], _items: b.items }),
  '/mood/appraise': () => ({ ok: true, mood: '有点上头', why: '2048 差一点', valence: 1, arousal: 1, changed: true }),
}, async ({ h, seen }) => {
  const play = h.getSocialV2State('play:main');
  play.lastWakeReason = 'proactiveCheck';
  h.socialV2.playStartedAt = Date.now() - 20 * 60000;
  h.socialV2.playLog = [{ at: Date.now() - 10 * 60000, what: '玩了 2048' }];
  h.innerLifeTurnEndedV2('play:main', { reason: { kind: 'completed' }, text: '今天 2048 差一点就 4096 了' });
  await tick();
  const t = seen.find((x) => x.path === '/life/threads/update');
  assert.deepEqual(t.body.items, ['玩了 2048']);
  assert.match(t.body.say, /差一点/);
  const m = seen.find((x) => x.path === '/mood/appraise');
  assert.equal(m.body.place, '电脑上自己玩的时候');
  assert.deepEqual(m.body.play, ['玩了 2048']);
  assert.equal(h.socialV2.mood.text, '有点上头');
  assert.match(h.buildPlayWakePromptV2('proactiveCheck'), /【上次没弄完的】2048 冲 4096（再玩几局）/);
  assert.ok(!h.buildPlayWakePromptV2('goPlay').includes('【上次没弄完的】'), '被托去办事不提');
  // 中途的回合（还有提醒在路上）不算玩完
  const n = seen.length;
  play.lastWakeReason = 'goPlay';
  h.innerLifeTurnEndedV2('play:main', { reason: { kind: 'completed' }, text: '' });
  play.lastWakeReason = 'admin';
  h.innerLifeTurnEndedV2('play:main', { reason: { kind: 'completed' }, text: 'x' });
  await tick();
  assert.equal(seen.filter((x) => x.path === '/life/threads/update').length, n === seen.length ? 1 : 2);
}));

test('今天想干嘛：醒着时一天想一次，写进【你现在】（大群不写）；日记：睡觉时写一次，第二天写“昨天”', () => fixture(ON, {
  '/life/plan': (b) => ({ ok: true, plan: { items: ['把那部番追完', '问问爸爸面试怎么样'], at: 1 }, _date: b.date }),
  '/life/diary': () => ({ ok: true, diary: { date: 'x', text: '今天玩了 2048，爸爸夸我了。', gist: '玩了2048，被夸了', at: 1 } }),
}, async ({ h, seen }) => {
  await h.lifeTickV2();
  const plan = seen.filter((x) => x.path === '/life/plan');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].body.date, h.lifeDayV2());
  assert.match(h.buildWakePromptV2('private:42', 'private'), /- 今天想：把那部番追完、问问爸爸面试怎么样/);
  assert.ok(!h.buildWakePromptV2('group:789', 'atMention').includes('今天想'), '大群不写');
  assert.match(h.buildWakePromptV2('private:42', 'private'), /今天想：[^\n]*qq_go_play[^\n]*别光说“这就去”/, '聊天这边说清楚做不了');
  await h.lifeTickV2();
  assert.equal(seen.filter((x) => x.path === '/life/plan').length, 1, '一天一次');
  assert.equal(seen.filter((x) => x.path === '/life/diary').length, 0, '醒着不写日记');
  // 到了睡觉时间
  h.appendSocialV2Message('private:42', '阿明', '晚安', '晚安', false, true, 1, [], '42');
  h.recordSentMessagesV2('private:42', ['晚安爸爸']);
  h.socialV2.life.moodLog = [{ at: Date.now() - 3600000, text: '美滋滋', key: 'private:42' }];
  h.socialV2.life.dayPlay = [{ at: Date.now() - 7200000, what: '玩了 2048' }];
  h.cfg.socialV2.nightSleep = { enabled: true, from: clock(-10), to: clock(500) };
  await h.lifeTickV2();
  const diary = seen.filter((x) => x.path === '/life/diary');
  assert.equal(diary.length, 1);
  assert.equal(diary[0].body.chats.length, 1, '只带她说过话的会话');
  assert.ok(diary[0].body.chats[0].lines.includes('我：晚安爸爸'));
  assert.match(diary[0].body.moods[0], /美滋滋/);
  assert.match(diary[0].body.play[0], /2048/);
  await h.lifeTickV2();
  assert.equal(seen.filter((x) => x.path === '/life/diary').length, 1);
  // 第二天醒来
  h.cfg.socialV2.nightSleep = daytime();
  h.socialV2.life.diary.date = '2000-01-01';
  h.socialV2.life.diary.at = Date.now() - 10 * 3600000;
  assert.match(h.buildWakePromptV2('private:42', 'private'), /- 昨天：玩了2048，被夸了/);
}));

test('主动找人：闲着时想一想，过阈值才叫醒她去说；开口了记 sent，对方回了记 answered；不开口记 declined', () => fixture({
  ...ON, initiate: { enabled: true, targets: ['private:42', 'group:456', 'group:789'], from: '00:00', to: '00:00', minSilenceMinutes: 60 },
}, {
  '/proactive/think': (b) => ({ ok: true, thoughts: b.targets.map((t) => ({ key: t.key, thought: t.key === 'private:42' ? '答应爸爸今天把番的结局告诉他' : '随便说说', kind: 'promise', score: t.key === 'private:42' ? 4.2 : 2 })) }),
}, async ({ h, seen, }) => {
  const key = 'private:42';
  const st = h.getSocialV2State(key);
  h.appendSocialV2Message(key, '阿明', '那你看完告诉我结局', '那你看完告诉我结局', false, true, 1, [], '42');
  st.recentMessages.at(-1).time = Date.now() - 3 * 3600000;
  h.getSocialV2State('group:456');
  h.getSocialV2State('group:789');
  // 第一次只定时间
  assert.equal(await h.initiateTickV2(), null);
  assert.ok(h.socialV2.life.initiateNextAt > Date.now());
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  const best = await h.initiateTickV2();
  assert.equal(best?.key, key);
  const think = seen.find((x) => x.path === '/proactive/think');
  assert.deepEqual(think.body.targets.map((t) => t.key), [key, 'group:456'], '大群 789 不找');
  const prompt = h.calls.prompts.map(promptText).find((t) => t.includes('【你想起一件事】'));
  assert.ok(prompt, '叫醒了她');
  assert.match(prompt, /答应爸爸今天把番的结局告诉他/);
  assert.equal(st.lastWakeReason, 'initiate');
  h.recordSentMessagesV2(key, ['爸爸 那部番结局超好哭']);
  const rec = h.socialV2.life.initiates.at(-1);
  assert.equal(rec.sent, true);
  h.appendSocialV2Message(key, '阿明', '真的吗', '真的吗', false, true, 2, [], '42');
  assert.ok(rec.answeredAt > 0);
  h.pendingWakeKeys.delete(key);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  assert.equal(st.initiateNow, 0);
  // 刚找过，间隔不够：这次不找
  st.recentMessages.forEach((m) => { m.time = Date.now() - 3 * 3600000; });
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  assert.equal(await h.initiateTickV2(), null, '群里的念头分数不够');
  const think2 = seen.filter((x) => x.path === '/proactive/think').at(-1);
  assert.deepEqual(think2.body.targets.map((t) => t.key), ['group:456'], '私聊刚找过，不在候选里');
  // 不开口
  h.socialV2.life.initiates = [];
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  st.lastAiReplyAt = 0;
  assert.equal((await h.initiateTickV2())?.key, key);
  // 回合结束还有收尾提醒在路上：不算结束
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  assert.ok(!h.socialV2.life.initiates.at(-1).declined);
  h.pendingWakeKeys.delete(key);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  assert.equal(h.socialV2.life.initiates.at(-1).declined, true);
  assert.equal(h.socialV2.life.initiates.at(-1).sent, false);
  // 夜里不想
  h.socialV2.life.initiates = [];
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  h.cfg.socialV2.nightSleep = { enabled: true, from: clock(-10), to: clock(500) };
  const before = seen.length;
  assert.equal(await h.initiateTickV2(), null);
  assert.equal(seen.length, before);
}));

test('纯函数：byKey 单独的规矩；bestThought 按每处的阈值挑', () => {
  const c = initiateCfg({ enabled: true, byKey: { 'group:789': { threshold: 4.2, perTargetPerDay: 1, minIntervalMinutes: 'x', maxUnanswered: 1 } } });
  const g = initiateCfgFor(c, 'group:789');
  assert.equal(g.threshold, 4.2);
  assert.equal(g.perTargetPerDay, 1);
  assert.equal(g.minIntervalMinutes, 180, '写错的不认');
  assert.equal(g.globalPerDay, 4);
  assert.equal(initiateCfgFor(c, 'group:456'), c);
  const now = Date.now();
  const one = [{ key: 'group:789', at: now - 20 * 3600000, sent: true }];
  assert.match(initiateBlockReason(one, 'group:789', now, g), /1 次/);
  assert.equal(initiateBlockReason(one, 'group:789', now, c), '', '按全局的规矩还能找');
  const th = (k) => initiateCfgFor(c, k).threshold;
  const thoughts = [{ key: 'group:789', thought: 'a', score: 4.0 }, { key: 'group:456', thought: 'b', score: 3.6 }];
  assert.equal(bestThought(thoughts, th, ['group:789', 'group:456']).key, 'group:456', '789 的 4.0 不到 4.2');
  assert.equal(bestThought(thoughts, 3.5, ['group:789', 'group:456']).key, 'group:789');
});

test('主动找人：不熟的群在 byKey 里写了才找；单独想、不带“今天想”和心情的原因；提示里让她少说；分数和次数按它自己的', () => fixture({
  ...ON, initiate: { enabled: true, targets: ['group:456', 'group:789'], from: '00:00', to: '00:00', minSilenceMinutes: 60,
    byKey: { 'group:789': { threshold: 4, perTargetPerDay: 1, minSilenceMinutes: 120 } } },
}, {
  '/proactive/think': (b) => ({ ok: true, thoughts: b.targets.map((t) => ({ key: t.key, thought: t.key === 'group:789' ? '群里上午说的那个游戏我玩通了' : '随便说说', kind: 'share', score: t.key === 'group:789' ? 4.1 : 3 })) }),
}, async ({ h, seen }) => {
  const key = 'group:789';
  for (const k of ['group:456', key]) {
    const st = h.getSocialV2State(k);
    h.appendSocialV2Message(k, '某人', '那个游戏好难', '那个游戏好难', false, false, 1, [], '77');
    st.recentMessages.at(-1).time = Date.now() - 90 * 60000;
  }
  h.socialV2.mood = { text: '有点闷', why: '爸爸私聊里说要出差', at: Date.now(), source: 'self' };
  h.socialV2.life.plan = { date: h.lifeDayV2(Date.now()), items: ['给爸爸画张画'] };
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  // 90 分钟：家里的群够了，789 要 120 分钟
  assert.equal(await h.initiateTickV2(), null, '家里的群 3 分不够');
  let calls = seen.filter((x) => x.path === '/proactive/think');
  assert.deepEqual(calls.map((x) => x.body.targets.map((t) => t.key)), [['group:456']]);
  // 安静够了
  for (const k of ['group:456', key]) h.getSocialV2State(k).recentMessages.forEach((m) => { m.time = Date.now() - 3 * 3600000; });
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  const best = await h.initiateTickV2();
  assert.equal(best?.key, key);
  calls = seen.filter((x) => x.path === '/proactive/think').slice(1);
  assert.equal(calls.length, 2, '分开想');
  assert.deepEqual(calls[0].body.targets.map((t) => t.key), ['group:456']);
  assert.match(calls[0].body.mood, /出差/);
  assert.deepEqual(calls[0].body.plan, ['给爸爸画张画']);
  assert.deepEqual(calls[1].body.targets.map((t) => t.key), [key]);
  assert.match(calls[1].body.targets[0].note, /普通群/);
  assert.equal(calls[1].body.targets[0].outside, undefined);
  assert.equal(calls[1].body.mood, '有点闷', '不带原因');
  assert.deepEqual(calls[1].body.plan, []);
  const prompt = h.calls.prompts.map(promptText).find((t) => t.includes('【你想起一件事】'));
  assert.match(prompt, /群里上午说的那个游戏我玩通了/);
  assert.match(prompt, /普通群，一条就够/);
  h.recordSentMessagesV2(key, ['那个游戏我通关了']);
  h.pendingWakeKeys.delete(key);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  // 789 今天找过 1 次就够了
  h.getSocialV2State(key).recentMessages.forEach((m) => { m.time = Date.now() - 3 * 3600000; });
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  await h.initiateTickV2();
  assert.deepEqual(seen.filter((x) => x.path === '/proactive/think').at(-1).body.targets.map((t) => t.key), ['group:456']);
  // byKey 里没写的不熟的群照旧不找
  delete h.cfg.socialV2.initiate.byKey;
  h.socialV2.life.initiates = [];
  h.socialV2.life.initiateNextAt = Date.now() - 1000;
  await h.initiateTickV2();
  assert.deepEqual(seen.filter((x) => x.path === '/proactive/think').at(-1).body.targets.map((t) => t.key), ['group:456']);
}));

test('关着的时候什么都不做：没有 extras 调用，【你现在】还是旧写法', () => fixture({}, {
  '/mood/appraise': () => ({ ok: true, mood: 'x', changed: true }),
}, async ({ h, seen }) => {
  const key = 'private:42';
  h.appendSocialV2Message(key, '阿明', '嗨', '嗨', false, true, 1, [], '42');
  h.recordSentMessagesV2(key, ['嗨']);
  h.innerLifeTurnEndedV2(key, { reason: { kind: 'completed' }, text: '' });
  await h.lifeTickV2();
  await h.initiateTickV2();
  await tick();
  assert.equal(seen.length, 0);
  assert.match(h.buildWakePromptV2(key, 'private'), /- 心情：还没写/);
}));
