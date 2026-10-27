// qqbot_agent：群里攒了很久的未读，唤醒快照不再从最早的给起（2026-10-23 大群：
// 14:48 被叫醒，快照里是 12:50~13:19 的 12 条，她去接了 13:27 的“俺妹”）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const MIN = 60000;

async function fixture(run, { key = 'group:456', context = {} } = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: false, selfAliases: ['鱼妹'] },
    context: { wakeMessageLimit: 12, wakeRecentLimit: 4, ...context },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const get = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`, method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify({ key, ...body }) : undefined);
  });
  // minutesAgo：把这条消息的时间改到多久以前
  const append = (text, minutesAgo = 0, extra = {}) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false,
      `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
    const seq = st.lastUnreadSeq;
    for (const m of [...st.unread, ...st.recentMessages]) {
      if (m.seq === seq) Object.assign(m, { time: Date.now() - minutesAgo * MIN }, extra);
    }
    return seq;
  };
  try { await run({ h, st, append, get, key }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const seqs = (list) => Array.from(list, (m) => m.seq);
const promptText = (h, before) => h.calls.prompts.slice(before).map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n')).join('\n');

test('开头过时的未读只报条数，最后几句当 recent，messages 是现在在聊的', () => fixture(async ({ h, st, append, get }) => {
  for (let i = 0; i < 20; i++) append(`老话${i}`, 118 - i);   // seq 1..20，两小时前到一个半小时前
  for (let i = 0; i < 5; i++) append(`新话${i}`, 5 - i);       // seq 21..25
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.deepEqual(seqs(snap.messages), [21, 22, 23, 24, 25]);
  assert.deepEqual(seqs(snap.recent), [17, 18, 19, 20]);
  assert.equal(snap.olderSkipped.count, 16);
  assert.match(snap.olderSkipped.from, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(snap.readThroughSeq, 25);
  assert.equal(snap.partial, false);
  assert.match(snap.recent[0].ago, /分钟前|小时前/);
  assert.equal(snap.messages[0].ago, undefined);

  const before = h.calls.prompts.length;
  await h.sendWakePromptV2('group:456', 'replyGate');
  assert.match(promptText(h, before), /olderSkipped 是 [0-9: -]+~[0-9: -]+ 攒下的 [0-9]+ 条旧未读.*别回头接/);
  // 放进 recent 的那 4 句也是旧未读：写明当时没接上、别补回
  assert.equal(snap.staleRecent.count, 4);
  assert.ok(!JSON.stringify(snap).includes('staleRecent'), '不进 JSON');
  assert.match(promptText(h, before), /recent 里 [0-9: -]+~[0-9: -]+ 那 4 句也是当时没接上的旧消息.*别再追问/);
  // 投递后游标能越过跳过的那段，mark_read 25 就清空
  const marked = await get('/api/socialV2/mark-read', { throughSeq: 25 });
  assert.equal(marked.status, 200, JSON.stringify(marked.data));
  assert.equal(marked.data.markedCount, 25);
  assert.equal(st.unread.length, 0);
}));

test('有人叫她的那条不跳，从那里开始给', () => fixture(async ({ h, append }) => {
  append('老话', 90);
  append('老话2', 80);
  append('鱼妹 你在吗', 70);
  append('老话3', 60);
  append('新话', 1);
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.deepEqual(seqs(snap.messages), [3, 4, 5]);
  assert.deepEqual(seqs(snap.recent), [1, 2]);
  assert.equal(snap.olderSkipped, undefined);
  assert.equal(snap.readThroughSeq, 5);
  assert.equal(snap.staleRecent.count, 2, '没跳过的，放进 recent 的旧未读照样提一句');
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2('group:456', 'nameMention');
  const p = promptText(h, before);
  assert.match(p, /recent 里 [0-9: -]+~[0-9: -]+ 那 2 句是当时没接上的旧消息/);
  assert.doesNotMatch(p, /olderSkipped 是/);
}));

test('recent 里都是看过的旧消息：不写旧未读那句', () => fixture(async ({ h, st, append }) => {
  append('老话', 90);
  append('老话2', 80);
  st.unread = [];
  st.lastReadThroughSeq = st.lastUnreadSeq;
  append('新话', 1);
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.deepEqual(seqs(snap.recent), [1, 2]);
  assert.equal(snap.staleRecent, undefined);
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2('group:456', 'replyGate');
  assert.doesNotMatch(promptText(h, before), /当时没接上/);
}));

test('@ 她的（atSelf）也不跳', () => fixture(async ({ h, append }) => {
  append('老话', 90);
  append('[CQ:at] 看看', 80, { atSelf: true });
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.deepEqual(seqs(snap.messages), [2]);
}));

test('私聊不跳', () => fixture(async ({ h, append }) => {
  append('早上的话', 120);
  append('现在的话', 1);
  const snap = h.buildWakeSnapshotV2('private:123');
  assert.deepEqual(seqs(snap.messages), [1, 2]);
  assert.equal(snap.olderSkipped, undefined);
}, { key: 'private:123' }));

test('staleUnreadMinutes 0 回到旧行为', () => fixture(async ({ h, append }) => {
  append('老话', 120);
  append('新话', 1);
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.deepEqual(seqs(snap.messages), [1, 2]);
}, { context: { staleUnreadMinutes: 0 } }));

test('qq_get_unread_messages 结果里旧消息带 ago', () => fixture(async ({ append, get }) => {
  append('老话', 45);
  append('新话', 1);
  const r = await get('/api/socialV2/unread?afterSeq=0');
  assert.equal(r.status, 200);
  assert.equal(r.data.messages[0].ago, '45 分钟前');
  assert.equal(r.data.messages[1].ago, undefined);
}));

// 2026-10-27 11:32 大群：30 条未读，跳过旧的 14 条后剩 16 条，快照从早的给 12 条，叫她来的“@鱼妹 在不在”在后面 4 条里没放进来
test('群里放不下：留最新的和叫她的，中间的只报条数（middleSkipped），游标照样走到最后', () => fixture(async ({ h, st, append, get }) => {
  for (let i = 0; i < 14; i++) append(`老话${i}`, 50 - i);    // seq 1..14，过了 30 分钟
  for (let i = 0; i < 15; i++) append(`新话${i}`, 25 - i);    // seq 15..29
  append('[CQ:at] 在不在', 0, { atSelf: true });               // seq 30
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.equal(snap.messages.at(-1).seq, 30, '叫她的那条一定在');
  assert.deepEqual(seqs(snap.messages), [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  assert.equal(snap.middleSkipped.count, 4);
  assert.equal(snap.readThroughSeq, 30);
  assert.equal(snap.partial, false);
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2('group:456', 'atMention');
  const p = promptText(h, before);
  assert.match(p, /middleSkipped 是 [0-9: ~-]+ 中间那 4 条.*qq_get_recent_messages/);
  assert.doesNotMatch(p, /接着读/);
  const marked = await get('/api/socialV2/mark-read', { throughSeq: 30 });
  assert.equal(marked.status, 200, JSON.stringify(marked.data));
  assert.equal(st.unread.length, 0);
}));

test('群里放不下：中间叫她的那条也留着', () => fixture(async ({ h, append }) => {
  for (let i = 0; i < 20; i++) append(i === 3 ? '鱼妹 你看这个' : `话${i}`, 20 - i); // seq 1..20，seq 4 叫她
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.equal(snap.messages.length, 12);
  assert.equal(snap.messages[0].seq, 4);
  assert.deepEqual(seqs(snap.messages).slice(1), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(snap.middleSkipped.count, 8);
  assert.equal(snap.readThroughSeq, 20);
}));

test('群里放得下就跟原来一样，没有 middleSkipped', () => fixture(async ({ h, append }) => {
  for (let i = 0; i < 5; i++) append(`话${i}`, 5 - i);
  const snap = h.buildWakeSnapshotV2('group:456');
  assert.deepEqual(seqs(snap.messages), [1, 2, 3, 4, 5]);
  assert.equal(snap.middleSkipped, undefined);
}));

test('私聊放不下：还是从早的给，partial 让她接着读', () => fixture(async ({ h, append }) => {
  for (let i = 0; i < 16; i++) append(`话${i}`, 16 - i);
  const snap = h.buildWakeSnapshotV2('private:123');
  assert.deepEqual(seqs(snap.messages), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(snap.middleSkipped, undefined);
  assert.equal(snap.partial, true);
  assert.equal(snap.readThroughSeq, 12);
}, { key: 'private:123' }));
