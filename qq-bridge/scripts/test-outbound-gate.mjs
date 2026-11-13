// 出口关卡（2026-11-08）：往 QQ 发的东西都从 qqOut 出去，二代模式下桥接替她说的话（legacy）一律拦下，
// 系统提示只能去主人通知的地方，白名单外、带会话令牌的都发不出去。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const config = { sendDelayMs: 0, socialV2: { nightSleep: { enabled: false } } };
const sentHttp = (h) => h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url));

await test('二代模式：legacy 发不出去，记进拦下的', async () => {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    await h.sendToQQ('group:456', '⏰ 等待回答超时，已取消该请求');
    assert.deepEqual(h.calls.sent, []);
    const snap = h.outboundSnapshot();
    assert.equal(snap.blocked, 1);
    assert.equal(snap.recent.at(-1).origin, 'legacy');
    assert.match(snap.recent.at(-1).blocked, /不替她说话/);
  } finally { await h.close(); }
});

await test('老模式：legacy 照发', async () => {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('chat');
    await h.sendToQQ('group:456', '你好');
    assert.equal(h.calls.sent.length, 1);
    assert.equal(h.outboundSnapshot().recent.at(-1).ok, true);
  } finally { await h.close(); }
});

await test('系统提示只去主人通知的地方', async () => {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    await h.notifyOwnerOnly('group:456', '⚠️ agent 处理出错：x');
    await h.sendChain;
    assert.equal(h.calls.sent.length, 1);
    assert.equal(h.calls.sent[0].kind, 'private');
    assert.equal(String(h.calls.sent[0].id), '123');
    await h.sendToQQ('group:456', '⚠️ 冒充系统提示', 'notice');
    assert.equal(h.calls.sent.length, 1, '发到别处的 notice 要拦下');
    assert.match(h.outboundSnapshot().recent.at(-1).blocked, /系统提示只能发到 private:123/);
  } finally { await h.close(); }
});

await test('她的话：走 HTTP，白名单外和带令牌的拦下', async () => {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    await h.onebotSend('group', '456', '在呢', null, null);
    assert.equal(sentHttp(h).length, 1);
    assert.equal(h.outboundSnapshot().recent.at(-1).origin, 'her');
    await assert.rejects(h.qqOut('group:789', [{ type: 'text', data: { text: 'hi' } }], { origin: 'her' }), /白名单/);
    const tok = 'ab'.repeat(20);
    h.rememberAgentToken('group:456', tok);
    await assert.rejects(h.qqOut('group:456', [{ type: 'text', data: { text: `令牌 ${tok}` } }], { origin: 'her' }), /会话令牌/);
    await assert.rejects(h.qqOut('group:456', 'x', { origin: 'whoever' }), /不认识的来路/);
    assert.equal(sentHttp(h).length, 1, '拦下的都没发出去');
    assert.equal(h.outboundSnapshot().blocked, 3);
  } finally { await h.close(); }
});

await test('表情、图走同一个关卡', async () => {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    await h.sendImageBufferV2('group:456', Buffer.from('png'));
    assert.equal(sentHttp(h).length, 1);
    const last = h.outboundSnapshot().recent.at(-1);
    assert.equal(last.origin, 'her');
    assert.equal(last.kinds, 'image');
  } finally { await h.close(); }
});

process.exit(failures ? 1 : 0);
