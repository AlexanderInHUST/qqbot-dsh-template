// qqbot_agent：夜里固定睡觉——睡觉时间里别人怎么叫都不醒，只有主人亲自叫才醒。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const msg = (userId, id, segs) => ({
  self_id: 999, user_id: userId, message_id: id, message: segs,
  raw_message: segs.map((s) => s.data?.text ?? '').join(''), sender: { nickname: `u${userId}`, card: `u${userId}` }
});
const text = (t) => ({ type: 'text', data: { text: t } });
const atSelf = { type: 'at', data: { qq: '999' } };

await test('睡觉时间：群友 @ 不醒，主人 @ 才醒，且提示她是被主人叫醒的', async () => {
  // 00:01~00:00 几乎覆盖全天，测试任何时刻跑都处在睡觉时间
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 1000 }, nightSleep: { enabled: true, from: '00:01', to: '00:00' } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(777, 1, [text('大家好')]), h.cfg);
    await h.handleIncoming('group', '456', msg(777, 2, [atSelf, text('醒醒，在吗？')]), h.cfg);
    await sleep(1600);
    assert.equal(h.calls.prompts.length, 0, '群友的消息（含首次 bootstrap 和 @）都不能叫醒她');
    await h.handleIncoming('group', '456', msg(123, 3, [text('今天天气不错')]), h.cfg);
    await sleep(1600);
    assert.equal(h.calls.prompts.length, 0, '主人随便聊天、没叫她，也不醒');
    await h.handleIncoming('group', '456', msg(123, 4, [atSelf, text('起来一下')]), h.cfg);
    for (let i = 0; i < 60 && !h.calls.prompts.length; i += 1) await sleep(50);
    assert.equal(h.calls.prompts.length, 1, '主人 @ 她必须叫醒');
    const delivered = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(delivered.includes('【现在是你的睡觉时间】'), '唤醒提示要告诉她是主人把她叫醒的');
  } finally { await h.close(); }
});

await test('extraOwnerQQ 里的人也算主人：睡觉时能叫醒她', async () => {
  const h = await bridgeHarness({ config: { extraOwnerQQ: ['888'], socialV2: { wake: { batchWindowMs: 1000 }, nightSleep: { enabled: true, from: '00:01', to: '00:00' } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(777, 1, [text('大家好')]), h.cfg);
    await h.handleIncoming('group', '456', msg(888, 2, [atSelf, text('起来')]), h.cfg);
    for (let i = 0; i < 60 && !h.calls.prompts.length; i += 1) await sleep(50);
    assert.equal(h.calls.prompts.length, 1, '第二个主人 @ 她也要叫醒');
  } finally { await h.close(); }
});

await test('没配 nightSleep 时行为不变', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 1000 } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(777, 1, [text('大家好')]), h.cfg);
    for (let i = 0; i < 60 && !h.calls.prompts.length; i += 1) await sleep(50);
    assert.equal(h.calls.prompts.length, 1, '首条消息照常 bootstrap');
    const delivered = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(!delivered.includes('睡觉时间'));
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
