// QQ 里没有 / 管理命令了（2026-11-08）：群友打 / 开头的话、说“换角色”，桥接不替她回话，照常给她看；主人的 /reset 也不重置会话。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const msg = (userId, id, t) => ({
  self_id: 999, user_id: userId, message_id: id, message: [{ type: 'text', data: { text: t } }],
  raw_message: t, sender: { nickname: `u${userId}`, card: `u${userId}` }
});

await test('/ 开头的话和“换角色”：桥接不回话，消息照常给她', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 300 }, nightSleep: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(777, 1, '/签到'), h.cfg);
    await h.handleIncoming('group', '456', msg(778, 2, '这关要换角色才能过'), h.cfg);
    await h.handleIncoming('group', '456', msg(123, 3, '/reset'), h.cfg);
    for (let i = 0; i < 60 && !h.calls.prompts.length; i += 1) await sleep(50);
    assert.deepEqual(h.calls.sent, [], '桥接不能替她发“管理命令仅管理员可用”之类的话');
    assert.equal(h.calls.archived.length, 0, '主人的 /reset 不再重置会话');
    assert.ok(h.calls.prompts.length >= 1, '消息要叫醒她');
    const delivered = h.calls.prompts.map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n')).join('\n');
    assert.ok(delivered.includes('/签到'), '/ 开头的话要给她看');
  } finally { await h.close(); }
});

// 桥接刚启动、DSH 还没就绪时模式还不是 reserved2，消息走的是这条老路（2026-10-26 重启时大群里进过一条）
await test('DSH 重启中：消息排队，不替她回“系统服务重启中”', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 100 }, nightSleep: { enabled: false } } } });
  try {
    h.setReady(false);
    await h.handleIncoming('group', '456', msg(777, 11, '在吗'), h.cfg);
    assert.deepEqual(h.calls.sent, [], '重启中不能往群里、私聊里发系统提示');
    assert.ok((h.queued.get('group:456') || []).length >= 1, '消息要排着，恢复后补给她');
  } finally { await h.close(); }
});

process.exit(failures ? 1 : 0);
