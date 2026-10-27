// qqbot_agent：回话的时机（socialV2.replyTiming，src/app/reply-timing.js + src/v2-wait.js）。
// 按对方连发的节奏和最后那句的样子定“说完了没”；合并唤醒、一轮里的等待都等到这个时间；
// 发前看一眼：她要发的时候跟她有关的人又说了话，先退回给她看。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { adaptiveQuietMs, messageShape, replyTimingCfg, typingRhythmMs, REPLY_TIMING_DEFAULTS } from '../src/v2-wait.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = { homeGroups: ['456'], allow: { private: ['123', '124', '125'], groups: ['456', '789'] }, ownerTitles: { 123: '爸爸' } };
// 测试里把时间都缩小
const RT = {
  enabled: true, baseMs: 300, minMs: 100, maxMs: 3000, rhythmMinMs: 300, rhythmMaxMs: 1500,
  fragmentExtraMs: 600, unfinishedExtraMs: 800, photoExtraMs: 700, questionMs: 150, hotExtraMs: 300,
  maxDelayMs: 2500, holdQuietMaxMs: 1500,
};

async function fixture(run, { rt = {}, gate = {} } = {}) {
  const h = await bridgeHarness({ config: { ...BASE, socialV2: {
    wake: { batchWindowMs: 1000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100, addressedQuietMs: 200 },
    send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
    proactive: { enabled: false }, sticker: { enabled: false },
    replyGate: { enabled: false, ...gate },
    replyTiming: { ...RT, ...rt },
  } } });
  h.setMode('reserved2');
  h.setSelfIdentity('鱼妹', '999');
  const conv = (key) => {
    const st = h.getSocialV2State(key);
    st.bootstrapSent = true;
    return st;
  };
  let n = 0;
  const say = (key, userId, t, { quote = false, media = [], messageId } = {}) => {
    const id = messageId ?? `m${++n}`;
    h.appendSocialV2Message(key, `u${userId}`, t, t, quote, String(userId) === '123', id, media, String(userId), []);
    return id;
  };
  // 她看过了（就像这些消息已经在唤醒或等待结果里给过她）
  const seen = (st) => h.noteModelMessagesV2(st, [...st.unread, ...st.recentMessages]);
  let server = null;
  const call = async (route, key, token, body) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `${route}?key=${encodeURIComponent(key)}`, method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Fixture request timed out')));
      req.end(JSON.stringify({ key, ...body }));
    });
  };
  // 等计划好的唤醒真发出去，返回从现在起过了多久
  const fired = async (st, limitMs = 5000) => {
    const start = Date.now();
    while (st.pendingWakeTimer && Date.now() - start < limitMs) await sleep(20);
    assert.equal(st.pendingWakeTimer, null, '唤醒一直没发出去');
    return Date.now() - start;
  };
  try { await run({ h, conv, say, seen, call, fired }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 纯函数 ──
await test('replyTimingCfg：写了 enabled:true 才开；数字不合法用默认', () => {
  assert.equal(replyTimingCfg().enabled, false);
  assert.equal(replyTimingCfg({ enabled: 'yes' }).enabled, false);
  const c = replyTimingCfg({ enabled: true, baseMs: -1, questionMs: 'x', maxMs: 10, holdBeforeSend: false });
  assert.equal(c.enabled, true);
  assert.equal(c.baseMs, REPLY_TIMING_DEFAULTS.baseMs);
  assert.equal(c.questionMs, REPLY_TIMING_DEFAULTS.questionMs);
  assert.equal(c.maxMs, c.minMs, 'maxMs 不小于 minMs');
  assert.equal(c.holdBeforeSend, false);
});
await test('messageShape / adaptiveQuietMs：碎片、话说一半、只 @、只发图多等；问她的话 2 秒；表情包和短回话不算碎片', () => {
  const c = replyTimingCfg({ enabled: true });
  const q = (t, extra = {}) => adaptiveQuietMs({ msg: { plain: t, media: extra.media }, toHer: extra.toHer ?? true, hot: extra.hot }, c).ms;
  assert.equal(q('在吗？'), 2000);
  assert.equal(q('现在几点'), 2000, '没问号的问句也算');
  assert.equal(q('吃了吗'), 2000, '几个字的问句不算碎片');
  assert.equal(q('在吗？', { toHer: false }), 3000, '不是问她的不缩短');
  assert.equal(q('我跟你说'), 8000, '“我跟你说”是话说一半');
  assert.equal(q('这个'), 6000);
  assert.equal(q('然后'), 8000);
  assert.equal(q('今天去了趟超市，'), 8000);
  assert.equal(q('@鱼妹'), 8000);
  assert.equal(q('[图片]', { media: [{ kind: 'image' }] }), 7000);
  for (const t of ['好的', '哈哈哈', '草', '[表情包:不想干]']) assert.equal(q(t, { media: t.startsWith('[') ? [{ kind: 'sticker' }] : [] }), 3000, t);
  assert.equal(q('今天天气真好。'), 3000);
  assert.equal(q('今天天气真好。', { hot: true }), 4000, '大群热闹多等一点');
  assert.equal(q('在吗？', { hot: true }), 2000, '问她的不加');
  assert.deepEqual(plain(messageShape({ plain: '@鱼妹 [图片]', media: [{ kind: 'image' }] })).photoOnly, true);
  assert.equal(messageShape({ plain: '[表情包]', media: [{ kind: 'sticker' }] }).photoOnly, false);
});

await test('typingRhythmMs：同一人相邻两条的间隔中位数（× rhythmFactor），夹在 3~8 秒；中间有别人插话、隔太久的不算；样本不够返回 0', () => {
  const c = replyTimingCfg({ enabled: true });
  const m = (userId, time, isSelf = false) => ({ userId, time, isSelf });
  const recent = [m('7', 0), m('7', 4000), m('7', 9000), m('8', 10000), m('7', 12000), m('7', 18000)];
  // 间隔 4000、5000、6000（9000→12000 中间有 8 插话不算）→ 中位数 5000
  assert.equal(typingRhythmMs(recent, '7', c), 5000);
  assert.equal(typingRhythmMs(recent, '7', { ...c, rhythmFactor: 1.3 }), 6500);
  assert.equal(typingRhythmMs(recent.slice(0, 3), '7', c), 0, '两个间隔不够');
  assert.equal(typingRhythmMs([m('7', 0), m('7', 100000), m('7', 200000), m('7', 300000)], '7', c), 0, '隔太久不算连发');
  assert.equal(typingRhythmMs([m('7', 0), m('7', 500), m('7', 1000), m('7', 1500)], '7', c), 3000, '快的夹到 3 秒');
  assert.equal(typingRhythmMs([m('7', 0), m('7', 20000), m('7', 40000), m('7', 60000)], '7', c), 8000, '慢的夹到 8 秒');
  assert.equal(typingRhythmMs([m('7', 0), m('7', 4000, true), m('7', 8000), m('7', 12000)], '7', c), 0, '她自己的不算');
});

// ── 在桥里 ──
await test('quietNeededV2：按最后一条和这个人的节奏算；没开就是 null', () => fixture(async ({ h, conv, say }) => {
  const st = conv('private:123');
  say('private:123', 123, '在吗？');
  assert.equal(h.quietNeededV2('private:123', st).ms, 150);
  say('private:123', 123, '这个');
  assert.equal(h.quietNeededV2('private:123', st).ms, 900);
  // 他平时一句话分几条、隔 1 秒左右发
  const g = conv('group:456');
  for (let i = 0; i < 5; i += 1) say('group:456', 777, `第${i}句话说完了。`);
  g.recentMessages.forEach((m, i) => { m.time = Date.now() - 5000 + i * 1000; });
  const r = h.quietNeededV2('group:456', g);
  assert.equal(r.ms, 300, '说完了的不超过 baseMs');
  say('group:456', 777, '然后');
  g.recentMessages.forEach((m, i) => { m.time = Date.now() - 6000 + i * 1000; });
  const r2 = h.quietNeededV2('group:456', g);
  assert.equal(r2.ms, 1000 + 800, JSON.stringify(r2));
  assert.match(r2.why, /节奏1s、话说一半/);
  h.cfg.socialV2.replyTiming.enabled = false;
  assert.equal(h.quietNeededV2('group:456', g), null);
  assert.equal(h.quietLeftV2('group:456', g), null);
}));

await test('合并唤醒：等对方说完再叫；没说完又补了一句就再等；一直在说最多拖 maxDelayMs；定时的照旧', () => fixture(async ({ h, conv, say, fired }) => {
  // 问她的话：很快叫
  let st = conv('private:123');
  say('private:123', 123, '在吗？');
  h.scheduleWakeV2('private:123', 'private');
  let t = await fired(st);
  assert.ok(t < 700, `问她等了 ${t}ms`);
  // 碎片：等 baseMs + fragmentExtraMs
  st = conv('private:124');
  say('private:124', 124, '这个');
  h.scheduleWakeV2('private:124', 'private');
  t = await fired(st);
  assert.ok(t >= 800 && t < 1400, `碎片等了 ${t}ms`);
  // 碎片后 600ms 又来一句“然后”：从那句起再等 300+800
  st = conv('private:125');
  say('private:125', 125, '这个');
  h.scheduleWakeV2('private:125', 'private');
  await sleep(600);
  say('private:125', 125, '然后');
  t = await fired(st);
  assert.ok(t >= 900 && t < 1700, `补了一句后等了 ${t}ms（从补那句算）`);
  // 一直在说：从第一条算最多 maxDelayMs（2.5 秒）
  st = conv('group:789');
  say('group:789', 777, '鱼妹我跟你说');
  const start = Date.now();
  h.scheduleWakeV2('group:789', 'nameMention');
  let talking = true;
  void (async () => { while (talking) { await sleep(400); if (talking) say('group:789', 777, '然后'); } })();
  await fired(st, 6000);
  talking = false;
  t = Date.now() - start;
  assert.ok(t >= 2300 && t < 3300, `一直在说等了 ${t}ms`);
}));

await test('合并唤醒：群里只等叫她的人说完，旁人接着聊不拖（2026-10-27 19:57 大群）', () => fixture(async ({ h, conv, say, fired }) => {
  const st = conv('group:789');
  say('group:789', 777, '鱼妹在吗？');
  st.wakeBy = { userId: '777', at: Date.now() };
  h.scheduleWakeV2('group:789', 'nameMention');
  let talking = true;
  void (async () => { while (talking) { await sleep(150); if (talking) say('group:789', 888, '然后'); } })();
  const t = await fired(st, 6000);
  talking = false;
  assert.ok(t < 900, `旁人在说也等了 ${t}ms`);
  // 叫她的人自己还在说：照旧等他
  const g = conv('group:456');
  say('group:456', 777, '鱼妹我跟你说');
  g.wakeBy = { userId: '777', at: Date.now() };
  h.scheduleWakeV2('group:456', 'nameMention');
  const t2 = await fired(g);
  assert.ok(t2 >= 900, `话说一半只等了 ${t2}ms`);
}));

await test('合并唤醒：没开 replyTiming 照旧按 batchWindowMs', () => fixture(async ({ h, conv, say, fired }) => {
  const st = conv('private:123');
  say('private:123', 123, '在吗？');
  h.scheduleWakeV2('private:123', 'private');
  const t = await fired(st);
  assert.ok(t >= 900 && t < 1500, `等了 ${t}ms`);
}, { rt: { enabled: false } }));

await test('一轮里的等待：按对方说完没定安静多久，结果里的 quietMs 是实际用的', () => fixture(async ({ h, conv, say, seen, call }) => {
  const st = conv('private:123');
  say('private:123', 123, '在吗？');
  seen(st);
  const wait = (body = {}) => call('/api/socialV2/wait', 'private:123', st.agentToken, { timeoutMs: 8000, ...body });
  let start = Date.now();
  let pending = wait();
  await sleep(150);
  say('private:123', 123, '这个');
  let r = await pending;
  let t = Date.now() - start;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.arrived, true);
  assert.equal(r.data.quietMs, 900, JSON.stringify(r.data));
  assert.ok(t >= 150 + 850 && t < 2000, `碎片等了 ${t}ms`);
  // 问她的：很快返回
  start = Date.now();
  pending = wait();
  await sleep(150);
  say('private:123', 123, '你吃饭了吗？');
  r = await pending;
  t = Date.now() - start;
  assert.equal(r.data.arrived, true);
  assert.ok(t < 900, `问她等了 ${t}ms`);
  // 她自己填的 quietMs 只会让它等得更久
  start = Date.now();
  pending = wait({ quietMs: 1200 });
  await sleep(150);
  say('private:123', 123, '吃了吗？');
  r = await pending;
  assert.equal(r.data.quietMs, 1200);
  assert.ok(Date.now() - start >= 1300);
}));
// ── 发前看一眼 ──
const selfSent = (st) => plain(st.recentMessages.filter((m) => m.isSelf).map((m) => m.text ?? m.plain));

await test('发前看一眼（私聊）：她要发的时候对方又说了话 → 先不发，退回新消息和草稿；再调就发；一轮最多拦 2 次', () => fixture(async ({ h, conv, say, seen, call }) => {
  const st = conv('private:123');
  st.wakeConfig.lastWakeAt = Date.now();
  say('private:123', 123, '今天好累啊。');
  seen(st);
  const send = (messages) => call('/api/socialV2/send-message', 'private:123', st.agentToken, { messages });
  // 没有新消息：照发
  let r = await send(['辛苦啦']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.held, undefined);
  assert.deepEqual(selfSent(st), ['辛苦啦']);
  // 她想好以后对方又说了一句
  say('private:123', 123, '不过晚上吃了火锅。');
  r = await send(['早点睡吧', '别熬夜']);
  assert.equal(r.data.held, true, JSON.stringify(r.data));
  assert.equal(r.data.sent, 0);
  assert.deepEqual(plain(r.data.notSent), ['早点睡吧', '别熬夜']);
  assert.equal(r.data.newMessages.length, 1);
  assert.match(JSON.stringify(r.data.newMessages), /火锅/);
  assert.match(r.data.hint, /对方又说了话.*照发.*别发/);
  assert.deepEqual(selfSent(st), ['辛苦啦'], '没发出去');
  assert.ok(r.data.readThroughSeq >= st.lastUnreadSeq, '退回给她的算看过了');
  // 看完再调：发
  r = await send(['火锅！好羡慕']);
  assert.equal(r.data.held, undefined, JSON.stringify(r.data));
  assert.deepEqual(selfSent(st), ['辛苦啦', '火锅！好羡慕']);
  // 第二次拦
  say('private:123', 123, '辣锅。');
  r = await send(['我也想吃']);
  assert.equal(r.data.held, true);
  // 第三次：这一轮拦够 2 次了，照发
  say('private:123', 123, '下次带你。');
  r = await send(['好耶']);
  assert.equal(r.data.held, undefined, JSON.stringify(r.data));
  assert.deepEqual(selfSent(st).at(-1), '好耶');
  // 新的一轮重新算
  st.wakeConfig.lastWakeAt = Date.now() + 1;
  say('private:123', 123, '记住了啊。');
  r = await send(['嗯嗯']);
  assert.equal(r.data.held, true);
}));

await test('发前看一眼：对方还在打字（说了一半）就等他说完再一起退回', () => fixture(async ({ h, conv, say, seen, call }) => {
  const st = conv('private:123');
  st.wakeConfig.lastWakeAt = Date.now();
  say('private:123', 123, '在吗？');
  seen(st);
  say('private:123', 123, '这个');
  const start = Date.now();
  const pending = call('/api/socialV2/send-message', 'private:123', st.agentToken, { messages: ['在呀'] });
  await sleep(400);
  say('private:123', 123, '我今天被老板夸了。');
  const r = await pending;
  assert.equal(r.data.held, true, JSON.stringify(r.data));
  assert.equal(r.data.newMessages.length, 2, '说完的那句也一起给她');
  assert.ok(Date.now() - start >= 400);
}));

await test('发前看一眼（群）：只看跟她有关的人——不相干的人说话不拦；把她叫来的人、叫她名字的拦；她引用的人拦', () => fixture(async ({ h, conv, say, seen, call }) => {
  const st = conv('group:456');
  st.wakeConfig.lastWakeAt = Date.now();
  say('group:456', 888, '别的事');
  say('group:456', 777, '鱼妹你看过那部电影没。', { messageId: '5001' });
  st.wakeBy = { userId: '777', at: Date.now() };
  seen(st);
  const send = (messages) => call('/api/socialV2/send-message', 'group:456', st.agentToken, { messages });
  say('group:456', 999001, '我在聊游戏呢。');
  let r = await send(['看过！']);
  assert.equal(r.data.held, undefined, `不相干的不拦：${JSON.stringify(r.data)}`);
  say('group:456', 777, '就是那部讲太空的。');
  r = await send(['挺好看的']);
  assert.equal(r.data.held, true, '把她叫来的人又说了');
  r = await send(['挺好看的']);
  assert.equal(r.data.held, undefined);
  // relevantUnseenV2 直接看
  st.wakeBy = null;
  say('group:456', 999002, '鱼妹也来玩呀。');
  assert.equal(h.relevantUnseenV2('group:456', st).length, 1, '叫她名字的算');
  seen(st);
  say('group:456', 999002, '我补充一下。');
  say('group:456', 999003, '路过。');
  assert.equal(h.relevantUnseenV2('group:456', st).length, 1, '她开口前最后看到的人（路过的不算）');
  seen(st);
  say('group:456', 999004, '换个话题。');
  assert.equal(h.relevantUnseenV2('group:456', st, { atUserId: '999002' }).length, 0);
  say('group:456', 999002, '快点。');
  assert.equal(h.relevantUnseenV2('group:456', st, { atUserId: '999002' }).length, 1, '她 @ 的人');
  seen(st);
  say('group:456', 777, '你说呢。');
  assert.equal(h.relevantUnseenV2('group:456', st).length, 0, '777 不再是最后说话的人');
  assert.equal(h.relevantUnseenV2('group:456', st, { replyToMessageId: '5001' }).length, 1, '她引用的那条的人');
}));

await test('发前看一眼：自由时间那边发进聊天的不拦；没开 replyTiming 或关了 holdBeforeSend 不拦', () => fixture(async ({ h, conv, say, seen, call }) => {
  const st = conv('private:123');
  st.wakeConfig.lastWakeAt = Date.now();
  say('private:123', 123, '在吗？');
  seen(st);
  say('private:123', 123, '人呢。');
  assert.equal(await h.preSendHoldV2('private:123', { drafts: ['x'], byPlay: true }), null);
  assert.equal(await h.preSendHoldV2('play:main', { drafts: ['x'] }), null);
  const play = conv('play:main');
  const r = await call('/api/socialV2/send-message', 'private:123', play.agentToken, { messages: ['看到个好玩的'] });
  assert.notEqual(r.data.held, true, JSON.stringify(r.data));
  h.cfg.socialV2.replyTiming.holdBeforeSend = false;
  assert.equal(await h.preSendHoldV2('private:123', { drafts: ['x'] }), null);
  h.cfg.socialV2.replyTiming = { enabled: false };
  assert.equal(await h.preSendHoldV2('private:123', { drafts: ['x'] }), null);
  h.cfg.socialV2.replyTiming = { ...RT };
  assert.ok(await h.preSendHoldV2('private:123', { drafts: ['x'] }));
}));

await test('qq_reply（/api/send/private）也拦', () => fixture(async ({ conv, say, seen, call }) => {
  const st = conv('private:123');
  st.wakeConfig.lastWakeAt = Date.now();
  say('private:123', 123, '在吗？');
  seen(st);
  say('private:123', 123, '算了没事了。');
  const r = await call('/api/send/private', 'private:123', st.agentToken, { userId: '123', message: '在的', token: st.agentToken });
  assert.equal(r.data.held, true, JSON.stringify(r.data));
  assert.deepEqual(plain(r.data.notSent), ['在的']);
}));

if (failures) { console.error(`${failures} 个失败`); process.exit(1); }
console.log('test-reply-timing: all passed');
