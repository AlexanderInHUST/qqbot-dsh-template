// qqbot_agent：群聊回复门控（socialV2.replyGate，src/reply-gate.js）和像人打字那样发（socialV2.send.human）。
// 门控开着：@/引用/叫名字照旧直接叫醒；别的消息收齐一批后过门控；不再有沉睡前等待和回复检查；
// 一轮里的普通等待最多 groupWaitMaxMs，有人找她或门控觉得该回才提前返回。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { DynamicReplyGate, estimateReplyProbability, likelihoodFeatures, staticThreshold, talkValueFor } from '../src/reply-gate.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
// vm 里的数组原型和这边不同，strict deepEqual 会说不相等
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;
const msg = (userId, segs) => ({
  self_id: 999, user_id: userId, message_id: nextId++, message: segs,
  raw_message: segs.map((s) => s.data?.text ?? '').join(''), sender: { nickname: `u${userId}`, card: `u${userId}` },
});
const text = (t) => ({ type: 'text', data: { text: t } });
const atSelf = { type: 'at', data: { qq: '999' } };

const BASE = { homeGroups: ['456'], allow: { private: ['123'], groups: ['456', '789'] }, ownerTitles: { 123: '爸爸' } };

async function fixture(run, { gate = {}, send = {}, wake = {}, wait = {} } = {}) {
  const h = await bridgeHarness({ config: { ...BASE, socialV2: {
    wake: { batchWindowMs: 1000, ...wake },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100, addressedQuietMs: 200, ...wait },
    send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0, ...send },
    proactive: { enabled: false }, sticker: { enabled: false },
    replyGate: { enabled: true, quietMs: 300, groupWaitMaxMs: 5000, talkValue: { group: 1, home: 1 }, ...gate },
  } } });
  h.setMode('reserved2');
  h.setSelfIdentity('鱼妹', '999');
  const group = (id) => {
    const st = h.getSocialV2State(`group:${id}`);
    st.bootstrapSent = true;
    st.wakeConfig.triggers = { atMention: true, nameMention: true, poke: true, question: true, keywords: ['猫'], probability: 1 };
    return st;
  };
  const take = (st) => {
    const r = st.pendingWakeReason || null;
    if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
    st.pendingWakeReason = null;
    return r;
  };
  const say = (id, userId, segs) => h.handleIncoming('group', id, msg(userId, segs), h.cfg);
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
  try { await run({ h, group, take, say, call }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 纯函数 ──
await test('reply-gate.js：逻辑回归、静态阈值表、talkValue', () => {
  assert.equal(staticThreshold(0), 1);
  assert.equal(staticThreshold(1), 0);
  assert.ok(Math.abs(staticThreshold(0.5) - 0.336) < 1e-9);
  assert.ok(Math.abs(staticThreshold(0.25) - 0.456) < 1e-9, '表中间线性插值');
  const now = Date.now();
  const plain = estimateReplyProbability(likelihoodFeatures([{ text: '今天吃啥' }], [], now));
  const kw = estimateReplyProbability(likelihoodFeatures([{ text: '我家猫', mentionsSelf: true }], [], now));
  const atOther = estimateReplyProbability(likelihoodFeatures([{ text: '@张三 你来' }], [], now));
  const img = estimateReplyProbability(likelihoodFeatures([{ text: '[图片]' }], [], now));
  const afterSelf = estimateReplyProbability(likelihoodFeatures([{ text: '是吗' }], [{ time: now - 5000, isSelf: true }], now));
  assert.ok(kw > plain && plain > atOther && plain > img, `${kw} ${plain} ${atOther} ${img}`);
  assert.ok(afterSelf > plain, '她刚说过话，接着的消息更可能是对她说的');
  assert.equal(talkValueFor('private:1', {}), 1);
  assert.equal(talkValueFor('group:1', {}, { home: true }), 0.8);
  assert.equal(talkValueFor('group:1', {}), 0.15);
  assert.equal(talkValueFor('group:1', { talkValue: { byKey: { 'group:1': 0.3 } } }), 0.3);
  const night = new Date(); night.setHours(23, 0, 0, 0);
  assert.equal(talkValueFor('group:1', { talkValue: { group: 0.2 }, talkSchedule: [{ from: '22:00', to: '02:00', factor: 0.5 }] }, { now: night }), 0.1, '跨午夜的时段');
});

await test('DynamicReplyGate：强制唤醒占掉额度后主动的就收紧；回复超过目标再收紧；同一批只记一次；存取', () => {
  const now = Date.now();
  const g = new DynamicReplyGate();
  const batch = (i) => [{ id: `m${i}`, text: `闲聊 ${i}` }];
  // talk=0.5，只有主动预计：保留一半，评分不到 20 个查静态表
  let d = g.evaluateBatch(batch(0), [], 0.5, now);
  assert.equal(d.keep, 0.5);
  assert.ok(Math.abs(d.threshold - 0.336) < 1e-9);
  // 同一批再评一次不重复计预计数
  const before = g.proactive.length;
  g.evaluateBatch(batch(0), [], 0.5, now + 100);
  assert.equal(g.proactive.length, before);
  // 强制唤醒很多：目标 = 0.5 × (主动 + 强制)，强制已经超过目标 → 保留 0 → 阈值 1
  for (let i = 0; i < 6; i++) g.recordForcedBatch([{ id: `f${i}`, text: '@她' }], now + 1000 + i);
  g.recordForcedBatch([{ id: 'f0', text: '@她' }], now + 2000);
  assert.equal(g.forced.length, 6, '同一批强制唤醒只记一次');
  d = g.evaluateBatch(batch(1), [], 0.5, now + 3000);
  assert.equal(d.keep, 0);
  assert.equal(d.trigger, false);
  // 不设门控（talk=1）总是放行
  assert.equal(new DynamicReplyGate().evaluateBatch(batch(2), [], 1, now).trigger, true);
  // 回复数超过目标：反馈把保留比例压下去
  const g2 = new DynamicReplyGate();
  for (let i = 0; i < 10; i++) g2.evaluateBatch(batch(100 + i), [], 0.5, now + i * 41000);
  const loose = g2.evaluateBatch(batch(200), [], 0.5, now + 11 * 41000).keep;
  for (let i = 0; i < 10; i++) g2.recordReply(now + 11 * 41000);
  const tight = g2.evaluateBatch(batch(201), [], 0.5, now + 12 * 41000).keep;
  assert.ok(tight < loose, `${tight} < ${loose}`);
  // 存取 + 超过一小时的丢掉
  const back = DynamicReplyGate.fromJSON(JSON.parse(JSON.stringify(g2)), now + 12 * 41000);
  assert.equal(back.replies.length, 10);
  assert.equal(DynamicReplyGate.fromJSON(JSON.parse(JSON.stringify(g2)), now + 3 * 3600000).proactive.length, 0);
});
// ── bridge ──
await test('不用配置：群都过门控、私聊不过；唤醒提示里没有沉睡前等待', async () => {
  const h = await bridgeHarness({ config: { ...BASE, socialV2: { wake: { batchWindowMs: 1000 } } } });
  try {
    h.setMode('reserved2');
    assert.equal(h.replyGateOnV2('group:456'), true);
    assert.equal(h.replyGateOnV2('group:789'), true);
    assert.equal(h.replyGateOnV2('private:123'), false);
    assert.equal(h.humanSendCfgV2().enabled, false);
    assert.equal(h.bubbleCapV2('group:789'), 0);
    const p = h.buildWakePromptV2('group:456', 'replyGate');
    assert.ok(!p.includes('沉睡前') && !p.includes('【当前唤醒】'), p);
  } finally { await h.close(); }
});

await test('开着：@/叫名字直接叫醒并记成强制；概率/关键词不直接叫，收齐一批后过门控', () => fixture(async ({ h, group, take, say }) => {
  const st = group('456');
  assert.equal(h.replyGateOnV2('group:456'), true);
  assert.equal(h.replyGateOnV2('private:123'), false, '私聊不过门控');
  await say('456', 777, [atSelf, text('出来')]);
  assert.equal(take(st), 'atMention');
  assert.equal(h.replyGateOfV2('group:456').forced.length, 1);
  assert.equal(st.gateIdleCount, 0);
  st.unread = []; st.lastReadThroughSeq = st.lastUnreadSeq;
  await say('456', 778, [text('小鱼你看这个')]);
  assert.equal(take(st), null, '外号没配的时候不算叫她');
  if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; }
  st.unread = []; st.lastReadThroughSeq = st.lastUnreadSeq;
  await say('456', 778, [text('鱼妹你看这个')]);
  assert.equal(take(st), 'nameMention');
  st.unread = []; st.lastReadThroughSeq = st.lastUnreadSeq;
  await say('456', 777, [text('我家猫又跑了')]);
  assert.equal(take(st), null, '关键词不直接叫');
  assert.ok(st.gateTimer, '排了门控检查');
  await say('456', 779, [text('哈哈哈')]);
  await sleep(750); // quietMs 最小 500
  assert.equal(take(st), 'replyGate', 'talk=1：一批收齐就放行');
  assert.ok(h.replyGateOfV2('group:456').proactive.length >= 1);
}));

await test('开着：talk=0 的群门控不放行；她把软条件全关了也不评估；睡觉时间不评估', () => fixture(async ({ h, group, take, say }) => {
  const st = group('789');
  await say('789', 777, [text('今天中午吃啥')]);
  await sleep(750); // quietMs 最小 500
  assert.equal(take(st), null, 'talk=0');
  st.wakeConfig.triggers = { atMention: true, nameMention: true, poke: true };
  st.lastIncomingAt = Date.now() - 10000;
  assert.equal(h.evaluateReplyGateV2('group:789'), null, '软条件全关不评估');
  st.wakeConfig.triggers.probability = 0.03;
  h.cfg.socialV2.nightSleep = { enabled: true, from: '00:01', to: '00:00' };
  assert.equal(h.evaluateReplyGateV2('group:789'), null, '睡觉时间不评估');
  h.cfg.socialV2.nightSleep = { enabled: false };
  const d = h.evaluateReplyGateV2('group:789');
  assert.ok(d && d.trigger === false && d.threshold === 1, JSON.stringify(d));
}, { gate: { talkValue: { group: 0, home: 1 } } }));

await test('开着：门控叫来没说话连着两次就退避；新消息攒够 bypassPending 条不退避；说了话清零', () => fixture(async ({ h, group, take, say }) => {
  const st = group('456');
  await say('456', 777, [text('闲聊一句')]);
  if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; }
  const idleTurn = () => {
    st.lastWakeReason = 'replyGate';
    st.wakeConfig.lastWakeAt = Date.now();
    st.lastAiReplyAt = Date.now() - 60000;
    h.gateTurnEndedV2('group:456');
    if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; }
  };
  idleTurn();
  assert.equal(st.gateIdleCount, 1);
  assert.equal(st.gateIdleUntil, 0, '第一次不退避');
  idleTurn();
  assert.ok(st.gateIdleUntil - Date.now() > 50000 && st.gateIdleUntil - Date.now() <= 60000, '第二次退避 baseMs');
  idleTurn();
  assert.ok(st.gateIdleUntil - Date.now() > 110000, '再一次翻倍');
  st.lastIncomingAt = Date.now() - 10000;
  assert.equal(h.evaluateReplyGateV2('group:456'), null, '退避中不评估');
  assert.equal(take(st), null);
  if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; }
  for (let i = 0; i < 3; i++) h.appendSocialV2Message('group:456', 'u7', `又一句 ${i}`, `又一句 ${i}`, false, false, `x${i}`, [], '777', []);
  st.lastIncomingAt = Date.now() - 10000;
  const d = h.evaluateReplyGateV2('group:456');
  assert.ok(d?.trigger, '攒够 4 条不退避');
  assert.equal(take(st), 'replyGate');
  // 她真说了话：退避清零
  st.gateIdleCount = 3; st.gateIdleUntil = Date.now() + 100000;
  const replies = h.replyGateOfV2('group:456').replies.length;
  h.gateRecordReplyV2('group:456', st);
  h.gateRecordReplyV2('group:456', st);
  assert.equal(st.gateIdleCount, 0);
  assert.equal(st.gateIdleUntil, 0);
  assert.equal(h.replyGateOfV2('group:456').replies.length, replies + 1, '15 秒内连着几次算一次回复');
}, { gate: { idleBackoff: { baseMs: 60000, capMs: 600000, startCount: 2, bypassPending: 4 } } }));

await test('开着：她刚接了谁的话，那个人接着说直接叫醒（talkBack），额度用完也叫；每句都叫，她不接了才停', () => fixture(async ({ h, group, take, say }) => {
  const key = 'group:789';
  const st = group('789');
  const seen = () => { st.unread = []; st.lastReadThroughSeq = st.lastUnreadSeq; if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; } };
  await say('789', 777, [text('鱼妹昨晚玩啥了')]);
  assert.equal(take(st), 'nameMention');
  seen();
  h.recordSentMessagesV2(key, ['写了个小游戏']);
  await say('789', 888, [text('哈哈')]);
  assert.equal(take(st), null, '不是跟她聊的人');
  await say('789', 777, [text('说点大伙不知道的')]);
  assert.equal(take(st), 'talkBack');
  assert.equal(st.recentMessages.at(-1).talkBack, true, '标上了，她在等待里也会提前返回');
  assert.match(h.buildWakePromptV2(key, 'talkBack'), /你刚才接了话的人又说话了/);
  // 她还没回，那人又补一句：照样叫（以前每次发言只叫一次，第二句就丢了）
  await say('789', 777, [text('快乐教育是吧')]);
  assert.equal(take(st), 'talkBack');
  // 被接话叫来，她没开口就走了：这段话不再叫
  st.lastWakeReason = 'talkBack';
  st.wakeConfig.lastWakeAt = Date.now();
  h.gateTurnEndedV2(key);
  seen();
  await say('789', 777, [text('喂')]);
  assert.equal(take(st), null, '她不接了，不再叫');
  seen();
  // 她又说了：再算一次；@ 别人的不算
  h.recordSentMessagesV2(key, ['那给你讲个别的']);
  await say('789', 777, [{ type: 'at', data: { qq: '888' } }, text('你听')]);
  assert.equal(take(st), null, '@ 别人');
  await say('789', 777, [text('好啊')]);
  assert.equal(take(st), 'talkBack');
  seen();
  // 她发言前没看到的人不算跟她聊的
  await say('789', 555, [text('我也来')]);
  h.recordSentMessagesV2(key, ['嗯嗯']);
  await say('789', 555, [text('来了')]);
  assert.equal(take(st), null, '555 那句她没看过');
  // 过了 windowMinutes 不算
  seen();
  h.recordSentMessagesV2(key, ['还有一个']);
  st.recentMessages.at(-1).time = Date.now() - 6 * 60000;
  await say('789', 777, [text('什么')]);
  assert.equal(take(st), null, '超过 5 分钟');
  // 关掉
  seen();
  h.recordSentMessagesV2(key, ['再来']);
  h.cfg.socialV2.replyGate.talkBack = { enabled: false };
  await say('789', 777, [text('嗯')]);
  assert.equal(take(st), null, '关掉了');
}, { gate: { talkValue: { group: 0, home: 1 } } }));

await test('门控唤醒有自己的说明；群和私聊的唤醒提示都没有沉睡前等待（【回完以后】在系统提示里）', () => fixture(async ({ h, group }) => {
  group('456');
  const p = h.buildWakePromptV2('group:456', 'replyGate');
  assert.ok(p.includes('没人叫你，是这几句你可能想接'), p);
  assert.ok(!p.includes('沉睡前') && !p.includes('bridge'), p);
  const pv = h.buildWakePromptV2('private:123', 'private');
  assert.ok(pv.includes('对方给你发了消息') && !pv.includes('沉睡前'), pv);
  // 自由时间照旧
  assert.ok(h.buildWakePromptV2('play:main', 'proactiveCheck').includes('【自由时间】'));
}));

await test('开着：一轮里的等待最多 groupWaitMaxMs；有人叫她提前返回；门控觉得该回也提前返回', () => fixture(async ({ h, group, call }) => {
  const st = group('456');
  const append = (t, quote = false) => h.appendSocialV2Message('group:456', 'u7', t, t, quote, false, `w${st.lastUnreadSeq + 1}`, [], '777', []);
  const wait = (body) => call('/api/socialV2/wait', 'group:456', st.agentToken, body);
  // 没人说话：timeoutMs 传 60 秒也只等 groupWaitMaxMs（5 秒，最小就是 5 秒）
  let started = Date.now();
  let r = await wait({ timeoutMs: 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Date.now() - started < 6500, `等了 ${Date.now() - started}ms`);
  assert.equal(r.data.arrived, false);
  assert.match(r.data.hint, /qq_mark_read 走开/);
  assert.equal('preSleepWaitRemainingMs' in r.data, false);
  // 有人引用她
  started = Date.now();
  let pending = wait({ timeoutMs: 60000 });
  await sleep(150);
  append('回你的', true);
  r = await pending;
  assert.equal(r.data.earlyReturn ? true : false, true, JSON.stringify(r.data));
  assert.match(r.data.earlyReturn, /叫你/);
  assert.ok(Date.now() - started < 2000);
  // 别人闲聊：talk=1 门控放行
  started = Date.now();
  pending = wait({ timeoutMs: 60000 });
  await sleep(150);
  append('大家觉得呢');
  r = await pending;
  assert.ok(Date.now() - started < 2500, `等了 ${Date.now() - started}ms`);
  assert.equal(r.data.arrived, true);
  assert.ok(r.data.earlyReturn, JSON.stringify(r.data));
  // talk=0：一直等到上限，消息一起给她，提示别每条都接
  h.cfg.socialV2.replyGate.talkValue.home = 0;
  pending = wait({ timeoutMs: 60000 });
  await sleep(150);
  append('另一个话题');
  r = await pending;
  assert.equal(r.data.arrived, true);
  assert.ok(!r.data.earlyReturn, JSON.stringify(r.data));
  assert.match(r.data.hint, /不用每条都接/);
  // purpose=reply 不受上限影响（照旧按静默返回）
  r = await wait({ purpose: 'reply', quietMs: 300, timeoutMs: 3000 });
  assert.equal(r.status, 200);
}, { gate: { groupWaitMaxMs: 5000 } }));
// ── 像人打字那样发 ──
await test('打字间隔按下一条的字数算、夹在 [minMs, maxMs]；她传的 gapMs 不管用；关着时照旧', () => fixture(async ({ h }) => {
  const sendCfg = h.cfg.socialV2.send;
  const gaps = h.computeGapsV2(['第一条', '短', '这是一条比较长的消息，大概二十来个字吧，差不多'], 'fixed', 10, undefined, sendCfg);
  assert.equal(gaps.length, 2);
  assert.ok(gaps[0] >= 400 && gaps[0] <= 1000, `短的 ${gaps[0]}`);
  assert.ok(gaps[1] > gaps[0] && gaps[1] <= 4000, `长的 ${gaps[1]}`);
  for (let i = 0; i < 50; i++) {
    const [g] = h.computeGapsV2(['a', '很'.repeat(200)], 'auto', undefined, undefined, sendCfg);
    assert.ok(g <= 4000 && g >= 400);
  }
  h.cfg.socialV2.send.human.enabled = false;
  assert.ok(h.computeGapsV2(['a', 'b'], 'fixed', 10, undefined, sendCfg)[0] < 400, '关着时还是原来的短间隔');
}, { send: { human: { enabled: true } } }));

await test('条数上限按场景：私聊/家里的群 4、别的群 2，多的并进最后一条', () => fixture(async ({ h }) => {
  assert.equal(h.bubbleCapV2('private:123'), 4);
  assert.equal(h.bubbleCapV2('group:456'), 4);
  assert.equal(h.bubbleCapV2('group:789'), 2);
  assert.deepEqual(plain(h.mergeBubblesV2(['a', 'b', 'c'], 2)), ['a', 'b，c']);
  assert.deepEqual(plain(h.mergeBubblesV2(['哈哈', '真的吗？', '我不信'], 2)), ['哈哈', '真的吗？我不信'], '已经有标点就不补逗号');
  assert.deepEqual(plain(h.mergeBubblesV2(['a', 'b'], 2)), ['a', 'b']);
  assert.deepEqual(plain(h.mergeBubblesV2(['a', 'b', 'c'], 0)), ['a', 'b', 'c'], '0 = 不限');
}, { send: { human: { enabled: true } } }));

await test('发送接口：别的群合并成 2 条并提示；两条之间对方插话后面的不发、退回 notSent', () => fixture(async ({ h, group, call }) => {
  const big = group('789');
  let r = await call('/api/socialV2/send-message', 'group:789', big.agentToken, { messages: ['一', '二', '三'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, 2);
  assert.equal(r.data.failed, 0);
  assert.match(r.data.hint, /最多 2 条/);
  assert.deepEqual(plain(big.recentMessages.filter((m) => m.isSelf).map((m) => m.text ?? m.plain)), ['一', '二，三']);
  // 私聊：第一条发出去以后对方马上说了话
  const pv = h.getSocialV2State('private:123');
  const pending = call('/api/socialV2/send-message', 'private:123', pv.agentToken, { messages: ['我跟你说', '今天看到个好玩的', '是只猫'] });
  await sleep(250);
  h.appendSocialV2Message('private:123', '阿明', '等下我先说', '等下我先说', false, true, 'p1', [], '123', []);
  r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, 1);
  assert.equal(r.data.interrupted, true);
  assert.deepEqual(plain(r.data.notSent), ['今天看到个好玩的', '是只猫']);
  assert.equal(r.data.failed, 0);
  assert.match(r.data.hint, /插了句话/);
  // 群里别人闲聊不算打断，有人 @/引用/叫她才算
  const home = group('456');
  const p2 = call('/api/socialV2/send-message', 'group:456', home.agentToken, { messages: ['好耶', '我也想去'] });
  await sleep(250);
  h.appendSocialV2Message('group:456', 'u7', '别人在聊别的', '别人在聊别的', false, false, 'g1', [], '777', []);
  r = await p2;
  assert.equal(r.data.sent, 2, JSON.stringify(r.data));
  const p3 = call('/api/socialV2/send-message', 'group:456', home.agentToken, { messages: ['好耶', '我也想去'] });
  await sleep(250);
  h.appendSocialV2Message('group:456', 'u7', '鱼妹你别去', '鱼妹你别去', false, false, 'g2', [], '777', []);
  r = await p3;
  assert.equal(r.data.sent, 1, JSON.stringify(r.data));
  assert.deepEqual(plain(r.data.notSent), ['我也想去']);
}, { send: { human: { enabled: true, minMs: 700, maxMs: 700 } } }));

await test('拍一拍：拍的是她才叫醒；同一个人 3 分钟内连着拍只叫一次，换个人照叫，主人不限', () => fixture(async ({ h, group, take }) => {
  const st = group('789');
  const poke = (sender, target = 999) => h.handlePokeNotice({ sub_type: 'poke', self_id: 999, group_id: 789, sender_id: sender, user_id: sender, target_id: target });
  await poke(555, 777);
  assert.equal(take(st), null, '拍别人不叫她');
  await poke(555);
  assert.equal(take(st), 'poke');
  for (let i = 0; i < 5; i += 1) { await poke(555); assert.equal(take(st), null, `连拍第 ${i + 2} 下不再叫`); }
  await poke(556);
  assert.equal(take(st), 'poke', '换个人照叫');
  h.cfg.ownerQQ = '123';
  await poke(123); assert.equal(take(st), 'poke');
  await poke(123); assert.equal(take(st), 'poke', '主人不限');
  h.cfg.socialV2.poke = { cooldownMs: 0 };
  await poke(555); assert.equal(take(st), 'poke', 'cooldownMs 0 不限');
}));

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
