// 看门狗（2026-11-08，src/app/watchdog.js）：工具一直没结果、一轮一直没动静就取消这一轮并告诉主人。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MS = 1 / 60000; // 配置按分钟写，测试里用毫秒
const cancels = (h) => h.calls.cancelled.filter((c) => c?.method === 'session/cancel');

async function harness(watchdog) {
  const h = await bridgeHarness({ config: { sendDelayMs: 0, socialV2: { nightSleep: { enabled: false }, watchdog } } });
  h.setMode('reserved2');
  h.state.sessions['play:main'] = 's-play';
  return h;
}

await test('工具一直没结果：先记日志，再取消这一轮、告诉主人', async () => {
  const h = await harness({ toolWarnMinutes: 20 * MS, toolStopMinutes: 80 * MS, longTurnMinutes: 0 });
  try {
    h.noteTurnEventV2('s-play', 'play:main', { type: 'turn/start' });
    h.noteTurnEventV2('s-play', 'play:main', { type: 'tool/call', data: { callId: 'c1', name: 'extras__bili_watch' } });
    await sleep(40);
    await h.checkTurnsV2();
    assert.equal(cancels(h).length, 0);
    assert.equal(h.watchdogSnapshotV2().recent.at(-1).action, 'tool-slow');
    await sleep(60);
    await h.checkTurnsV2();
    assert.equal(cancels(h).length, 1);
    assert.equal(cancels(h)[0].params.sessionId, 's-play');
    await h.sendChain;
    assert.equal(h.calls.sent.length, 1, '告诉主人一声');
    assert.match(String(h.calls.sent[0].text), /bili_watch/);
    await h.checkTurnsV2();
    assert.equal(cancels(h).length, 1, '取消过的不马上再取消');
  } finally { await h.close(); }
});

await test('工具有结果了、这一轮结束了就不管', async () => {
  const h = await harness({ toolStopMinutes: 30 * MS, quietStopMinutes: 0, longTurnMinutes: 0 });
  try {
    h.noteTurnEventV2('s-play', 'play:main', { type: 'turn/start' });
    h.noteTurnEventV2('s-play', 'play:main', { type: 'tool/call', data: { callId: 'c1', name: 'x' } });
    h.noteTurnEventV2('s-play', 'play:main', { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } });
    await sleep(50);
    await h.checkTurnsV2();
    h.noteTurnEventV2('s-play', 'play:main', { type: 'turn/end' });
    await h.checkTurnsV2();
    assert.equal(cancels(h).length, 0);
    assert.equal(h.watchdogSnapshotV2().turns.length, 0);
  } finally { await h.close(); }
});

await test('没工具在跑、一直没动静：取消', async () => {
  const h = await harness({ quietWarnMinutes: 0, quietStopMinutes: 30 * MS, longTurnMinutes: 0 });
  try {
    h.noteTurnEventV2('s-play', 'play:main', { type: 'turn/start' });
    await sleep(50);
    await h.checkTurnsV2();
    assert.equal(cancels(h).length, 1);
  } finally { await h.close(); }
});

await test('会话换掉了、session/title 这类事件不算一轮', async () => {
  const h = await harness({ quietStopMinutes: 10 * MS, longTurnMinutes: 0 });
  try {
    h.noteTurnEventV2('s-old', 'play:main', { type: 'turn/start' });
    h.noteTurnEventV2('s-play', 'play:main', { type: 'session/title' });
    await sleep(30);
    await h.checkTurnsV2();
    assert.equal(cancels(h).length, 0);
    assert.equal(h.watchdogSnapshotV2().turns.length, 0);
  } finally { await h.close(); }
});

process.exit(failures ? 1 : 0);
