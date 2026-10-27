// qqbot_agent：别人引用她自己发的图，写清是哪张（她记的 [截图:…] / [沙雕图:…] / [表情包:…]），过了 10 分钟的写上发的时间。
// 2026-10-27 20:02 小群：妈妈引用了 15:44 那张 XP 截图，QQ 只给“[图片]”，她当成私聊里发给爸爸的月亮画。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
let nextId = 100;
const msg = (userId, segs) => ({
  self_id: 999, user_id: userId, group_id: 789, message_id: nextId++, message: segs,
  raw_message: '', sender: { nickname: `u${userId}`, card: `u${userId}` },
});
const text = (t) => ({ type: 'text', data: { text: t } });
const reply = (id) => ({ type: 'reply', data: { id: String(id) } });
const photo = { type: 'image', data: { file: 'p.jpg', sub_type: 0, summary: '' } };

await test('引用她发的截图：用她记的那条，旧的写上发的时间；引用别人的图照旧', async () => {
  const h = await bridgeHarness({ config: {
    homeGroups: ['456'], allow: { private: ['123'], groups: ['456', '789'] }, ownerTitles: { 123: '爸爸' },
    socialV2: { proactive: { enabled: false }, sticker: { enabled: false }, replyGate: { enabled: false } },
  } });
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('鱼妹', '999');
    // QQ 那边：5555、5556 是她发的图，7777 是 777 发的图，8888 是她发的字
    const owners = { 5555: 999, 5556: 999, 7777: 777, 8888: 999 };
    h.bot.getMessage = async (id) => ({
      group_id: 789, sender: { user_id: owners[id], card: owners[id] === 999 ? '鱼妹' : `u${owners[id]}` },
      message: id === 8888 ? [text('今天画了条鱼')] : [photo],
    });
    const st = h.getSocialV2State('group:789');
    st.bootstrapSent = true;
    const mine = (messageId, t, ago) => st.recentMessages.push({ messageId, sender: '我', text: t, plain: t, isSelf: true, time: Date.now() - ago });
    mine('5555', '[截图:Windows XP Online – Free Windows XP Simulator]', 4 * 3600000);
    mine('5556', '[截图:自己画的画]', 60000);
    mine('8888', '今天画了条鱼', 3600000);
    const last = () => st.recentMessages.at(-1).text;

    await h.handleIncoming('group', 789, msg(123, [reply(5555), text('宝宝也太厉害了吧')]), h.cfg);
    assert.match(last(), /^\[引用 鱼妹 \d{4}-\d\d-\d\d \d\d:\d\d 发的：\[截图:Windows XP Online – Free Windows XP Simulator\]\]宝宝也太厉害了吧$/);
    assert.equal(st.recentMessages.at(-1).quoteTargetIsSelf, true);
    await h.handleIncoming('group', 789, msg(123, [reply(5556), text('画得好')]), h.cfg);
    assert.equal(last(), '[引用 鱼妹：[截图:自己画的画]]画得好', '刚发的不写时间');
    await h.handleIncoming('group', 789, msg(123, [reply(8888), text('哪条')]), h.cfg);
    assert.match(last(), /^\[引用 鱼妹 .+ 发的：今天画了条鱼\]哪条$/, '字照旧用 QQ 给的');
    await h.handleIncoming('group', 789, msg(123, [reply(7777), text('这张呢')]), h.cfg);
    assert.equal(last(), '[引用 u777：[图片]]这张呢', '别人的图不动');
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
