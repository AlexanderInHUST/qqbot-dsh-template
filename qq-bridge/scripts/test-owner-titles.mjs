// qqbot_agent：ownerTitlesGroups——只在指定的群（和私聊）里给主人标“你的爸爸”，别的群里标记提醒她别这么叫。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const msg = (userId, id, t) => ({
  self_id: 999, user_id: userId, message_id: id, message: [{ type: 'text', data: { text: t } }],
  raw_message: t, sender: { nickname: `u${userId}`, card: `u${userId}` }
});
const lastLabel = (h, key) => {
  const st = h.getSocialV2State(key);
  return [...(st.unread || []), ...(st.recentMessages || [])].filter((m) => m.isOwner).at(-1)?.ownerLabel;
};

await test('配了 ownerTitlesGroups：名单里的群和私聊带称呼，别的群提醒别叫', async () => {
  const h = await bridgeHarness({ config: {
    ownerTitles: { 123: '爸爸' }, ownerTitlesGroups: ['456'],
    allow: { private: ['123'], groups: ['456', '789'] }
  } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(123, 1, '小群里说话'), h.cfg);
    assert.ok(lastLabel(h, 'group:456').includes('你的爸爸'));
    await h.handleIncoming('group', '789', msg(123, 2, '大群里说话'), h.cfg);
    const big = lastLabel(h, 'group:789');
    assert.ok(!big.includes('你的爸爸') && big.includes('不叫爸爸'), big);
    await h.handleIncoming('private', '123', msg(123, 3, '私聊'), h.cfg);
    assert.ok(lastLabel(h, 'private:123').includes('你的爸爸'));
  } finally { await h.close(); }
});

await test('没配 ownerTitlesGroups 时所有群都带称呼（原行为）', async () => {
  const h = await bridgeHarness({ config: { ownerTitles: { 123: '爸爸' } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(123, 1, '说话'), h.cfg);
    assert.ok(lastLabel(h, 'group:456').includes('你的爸爸'));
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
