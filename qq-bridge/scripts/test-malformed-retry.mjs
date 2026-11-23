// qqbot_agent：工具参数 JSON 写坏（MALFORMED_RESPONSE）时自动让她接着做，连续失败超过上限才通知主人。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const malformed = { kind: 'error', error: { message: 'DeepSeek Messages stream: tool input is invalid JSON', code: 'MALFORMED_RESPONSE' } };
const promptText = (p) => p.content.map((c) => String(c?.text ?? '')).join('\n');

await test('JSON 出错自动重试，超过上限才放行通知，正常回合清零', async () => {
  const h = await bridgeHarness({ config: { socialV2: { malformedRetry: { max: 2 } } } });
  try {
    const key = 'group:456';
    h.getSocialV2State(key);
    const before = h.calls.prompts.length;
    assert.equal(h.retryMalformedTurnV2(key, malformed), true);
    assert.equal(h.retryMalformedTurnV2(key, malformed), true);
    assert.equal(h.retryMalformedTurnV2(key, malformed), false, '第 3 次不再重试，交给原来的通知');
    for (let i = 0; i < 40 && h.calls.prompts.length < before + 2; i += 1) await sleep(25);
    assert.equal(h.calls.prompts.length, before + 2);
    assert.ok(promptText(h.calls.prompts.at(-1)).includes('接着刚才的事继续'));
    assert.equal(h.retryMalformedTurnV2(key, malformed), true, '放行后计数清零，下次又能重试');
    assert.equal(h.retryMalformedTurnV2(key, { kind: 'completed' }), false);
    assert.equal(h.retryMalformedTurnV2(key, malformed), true, '正常结束的回合把计数清零');
    assert.equal(h.retryMalformedTurnV2(key, malformed), true);
    assert.equal(h.retryMalformedTurnV2(key, malformed), false);
  } finally { await h.close(); }
});

await test('其他错误、关掉开关都不重试', async () => {
  const h = await bridgeHarness({ config: { socialV2: { malformedRetry: { enabled: false } } } });
  try {
    h.getSocialV2State('group:456');
    assert.equal(h.retryMalformedTurnV2('group:456', malformed), false);
    h.cfg.socialV2.malformedRetry.enabled = true;
    assert.equal(h.retryMalformedTurnV2('group:456', { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } }), false);
    assert.equal(h.retryMalformedTurnV2('group:456', malformed), true);
  } finally { await h.close(); }
});

const refusal = { kind: 'error', error: { message: 'DeepSeek Messages stream: unsupported stop reason refusal', code: 'MALFORMED_RESPONSE' } };
function seedRefusedTurn(h, key, t0) {
  const st = h.getSocialV2State(key);
  const msg = (seq, time, text) => ({ seq, time, text, plain: text, tail: text, media: [{ kind: 'image' }], hasMedia: true, forwardIds: [], hasForward: false, isSelf: false });
  st.unread = [msg(1, t0 - 60_000, '这个表情是什么'), msg(2, t0 - 1000, '@鱼妹'), msg(3, t0 + 5000, '后来说的')];
  st.recentMessages = [msg(0, t0 - 120_000, '更早的'), ...st.unread.map((m) => ({ ...m }))];
  st.lastUnreadSeq = 3;
  return st;
}

await test('被内容审核掐断：那几条换成被过滤了、这一轮剪掉、再叫她一次，还不行才记成看过', async () => {
  const h = await bridgeHarness({ config: { socialV2: { malformedRetry: { max: 2 } } } });
  try {
    const key = 'group:456';
    const sid = await h.ensureSession(key);
    const t0 = Date.now();
    const st = seedRefusedTurn(h, key, t0);
    assert.equal(h.retryMalformedTurnV2(key, refusal), false, '拒答不按 JSON 写坏重试');
    assert.equal(h.isRefusalTurnErrorV2(refusal.error), true);
    assert.equal(await h.handleRefusedTurnV2(key, malformed, t0, null), false, '别的错误不管');
    assert.equal(await h.handleRefusedTurnV2(key, { kind: 'completed' }, t0, null), false);
    // 上一轮结束在 100，这一轮 101 开始，只有 attempt 没出东西
    h.trackTurnEvent(sid, { type: 'turn/end', seq: 100, data: { turn: 1, reason: { kind: 'completed' } } });
    h.trackTurnEvent(sid, { type: 'agent/inbox/spliced', seq: 101, data: {} });
    h.trackTurnEvent(sid, { type: 'turn/start', seq: 102, data: { turn: 2 } });
    h.trackTurnEvent(sid, { type: 'assistant/attempt', seq: 103, data: { turn: 2 } });
    const cut = h.turnCuts.get(sid);
    assert.deepEqual(JSON.parse(JSON.stringify(cut)), { base: 100, output: false });
    h.pendingWakeKeys.add(key);
    st.lastWakeReason = 'atSelf';
    const before = h.calls.prompts.length;
    assert.equal(await h.handleRefusedTurnV2(key, refusal, t0, cut), 'retry');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.forks.at(-1))), { sessionId: sid, atSeq: 100 });
    const child = h.state.sessions[key];
    assert.equal(child, 'fixture-fork-1', '换成 fork 出来的会话');
    assert.equal(h.reverse.get(child), key);
    assert.equal(h.reverse.has(sid), false);
    assert.equal(h.idleSeqs.get(child), 100);
    const now = h.getSocialV2State(key);
    for (const list of [now.unread, now.recentMessages]) {
      for (const m of list) {
        if (m.seq === 1 || m.seq === 2) {
          assert.equal(m.text, '[这条消息被过滤了，看不到原话]');
          assert.equal(m.hasMedia, false);
          assert.equal(m.filtered, true);
        } else assert.ok(!m.filtered, `seq ${m.seq} 不动`);
      }
    }
    assert.equal(now.unread.length, 3, '重试前不记成看过');
    for (let i = 0; i < 40 && h.calls.prompts.length <= before; i += 1) await sleep(25);
    const p = h.calls.prompts.at(-1);
    assert.equal(p.sessionId, child, '重试投到新会话');
    const text = promptText(p);
    assert.ok(text.includes('【系统】有 2 条消息的原话看不到了'), text.slice(0, 300));
    assert.ok(text.includes('[这条消息被过滤了，看不到原话]'), '快照里是过滤后的');
    assert.ok(!text.includes('这个表情是什么'), '原话不再给她');
    // 重试那一轮又被掐（做了事，不剪）：记成看过，算收了尾
    h.pendingWakeKeys.add(key);
    assert.equal(await h.handleRefusedTurnV2(key, refusal, t0, { base: 100, output: true }), 'gave-up');
    assert.equal(h.calls.forks.length, 1, '做过事的一轮不剪');
    assert.deepEqual(h.getSocialV2State(key).unread.map((m) => m.seq), [3], '这一轮之后到的留着');
    assert.ok(h.markReadCalledKeys.has(key));
    // 计数清零：下次又能重试一次
    h.getSocialV2State(key).unread.push({ seq: 4, time: t0, text: 'x', plain: 'x', tail: 'x', media: [], forwardIds: [] });
    assert.equal(await h.handleRefusedTurnV2(key, refusal, t0 + 1, null), 'retry');
  } finally { await h.close(); }
});

await test('不是叫醒她的一轮被掐：过滤、记成看过，不重试', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'group:456';
    await h.ensureSession(key);
    const t0 = Date.now();
    seedRefusedTurn(h, key, t0);
    h.pendingWakeKeys.delete(key);
    const before = h.calls.prompts.length;
    assert.equal(await h.handleRefusedTurnV2(key, refusal, t0, null), 'dropped');
    assert.deepEqual(h.getSocialV2State(key).unread.map((m) => m.seq), [3]);
    await sleep(100);
    assert.equal(h.calls.prompts.length, before);
  } finally { await h.close(); }
});

await test('切点：快照补上、回合里的事件不算、调过工具算做了事', async () => {
  const h = await bridgeHarness();
  try {
    const sid = 'sess-x';
    h.trackTurnEvent(sid, { type: 'turn/start', seq: 10, data: { turn: 1 } });
    assert.equal(h.turnCuts.get(sid).base, undefined, '不知道上一轮在哪就不剪');
    h.trackTurnEvent(sid, { type: 'step/start', seq: 11, data: { turn: 1 } });
    h.trackTurnEvent(sid, { type: 'tool/call', seq: 12, data: { turn: 1, name: 'x' } });
    assert.equal(h.turnCuts.get(sid).output, true);
    assert.equal(h.idleSeqs.has(sid), false, '回合里的事件不当切点');
    h.trackTurnEvent(sid, { type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'completed' } } });
    h.trackTurnEvent(sid, { type: 'compaction/end', seq: 14, data: {} });
    h.trackTurnEvent(sid, { type: 'agent/inbox/spliced', seq: 15, data: {} });
    h.trackTurnEvent(sid, { type: 'turn/start', seq: 16, data: { turn: 2 } });
    assert.deepEqual(JSON.parse(JSON.stringify(h.turnCuts.get(sid))), { base: 14, output: false });
  } finally { await h.close(); }
});

await test('defang 把 🇹🇼 换掉，别的旗子不动', async () => {
  const { defang } = await import('../src/qq-model-view.js');
  assert.equal(defang('这个表情是什么🇹🇼 🇨🇳【x】'), '这个表情是什么[旗子表情] 🇨🇳〖x〗');
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
