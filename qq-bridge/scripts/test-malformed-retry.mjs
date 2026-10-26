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
    h.setMode('reserved2');
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

await test('其他错误、关掉开关、非 reserved2 模式都不重试', async () => {
  const h = await bridgeHarness({ config: { socialV2: { malformedRetry: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.getSocialV2State('group:456');
    assert.equal(h.retryMalformedTurnV2('group:456', malformed), false);
    h.cfg.socialV2.malformedRetry.enabled = true;
    assert.equal(h.retryMalformedTurnV2('group:456', { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } }), false);
    assert.equal(h.retryMalformedTurnV2('group:456', malformed), true);
    h.setMode('social');
    assert.equal(h.retryMalformedTurnV2('group:456', malformed), false);
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
