// GitHub issue 回归：把上游 issue 里**已确认可复现**的缺陷钉死，防止回退。
//
// 覆盖：
//   #22 控制台切模式被 5 秒轮询改回去 —— DSH 0.2.0-rc.2 的 settings/update 只写 user 层，
//       同进程内 describe().value 不更新；读取必须 user 优先、value 回退。
//   #11/#19/#23/#26 回合结束信号丢了 → 会话永久 busy —— 回合判忙改为「起始时间 + 15 分钟租约」，
//       无起始时间的残留 collector 不再判忙；collector 保留，迟到回复照常 flush。
//   #29 被 @ 了不理人 —— 机器人昵称/QQ 号必须写进唤醒 prompt（否则 agent 把 @自己 当 @别人）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:1001';
const SID = 'session-1';

await test('#11/#19 回合判忙：无起始时间的残留 collector 不再永久 busy', async () => {
  const h = await bridgeHarness();
  try {
    h.state.sessions[KEY] = SID;
    const st = h.getSocialV2State(KEY);
    const collector = { push() { return true; }, size() { return 1; } };

    assert.equal(h.isConversationBusyV2(KEY, st), false, '空状态不忙');

    h.collectors.set(SID, collector);
    assert.equal(h.isConversationBusyV2(KEY, st), false, '只有 collector、没有起始时间 → 不判忙（旧版这里永久忙）');

    h.v2TurnStartAt.set(SID, Date.now());
    assert.equal(h.isConversationBusyV2(KEY, st), true, '回合刚开始必须判忙');

    h.v2TurnStartAt.set(SID, Date.now() - (h.TURN_BUSY_LEASE_MS + 60_000));
    assert.equal(h.isConversationBusyV2(KEY, st), false, '超过租约必须解除忙碌');
    assert.equal(h.collectors.has(SID), true, '租约过期不能丢掉 collector（迟到回复仍要 flush）');

    h.v2TurnStartAt.delete(SID);
    h.collectors.delete(SID);
    h.v2TurnStartAt.set(SID, Date.now());
    assert.equal(h.isConversationBusyV2(KEY, st), true, '只有起始时间（collector 还没建）也算回合在进行');

    h.promptQueues.set(KEY, { running: true, queue: [] });
    assert.equal(h.isConversationBusyV2(KEY, st), true, 'prompt 在途仍算忙');
  } finally { await h.close(); }
});

await test('#29 唤醒 prompt 必须写明机器人自己的昵称与 QQ 号', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('樰', '10001');
    const line = h.selfIdentityTextV2();
    assert.match(line, /【你的身份】/);
    assert.match(line, /樰/);
    assert.match(line, /10001/);
    assert.match(line, /@樰/, '必须明确「@昵称」指的是自己');

    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【你的身份】/, '每次唤醒都要带身份（它是 agent 唯一能对上号的地方）');
    assert.match(prompt, /@樰/);
    assert.match(prompt, /10001/);

    // 收尾提醒是同一轮里补的一句，身份已经在这一轮的唤醒提示里了
    const reminder = h.buildWakeReminderPromptV2(KEY);
    assert.ok(reminder.includes(KEY) && reminder.includes('qq_mark_read'), reminder);

    h.setSelfIdentity('', '');
    assert.equal(h.selfIdentityTextV2(), '', '身份未知时不注入空行（不能写「你的昵称是（）」）');
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'timeout'), /【你的身份】/);
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
