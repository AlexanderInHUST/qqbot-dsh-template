// qqbot_agent：群里少插嘴（2026-10-24 主人：“突然插出来说话有点尬，特别是大群里大家约着打游戏”；技术群和大群都不要主动说话）。
// · 接话（talkBack）：所有群里只发图/表情、引用别人的、约游戏喊人上号的不算；家里以外的群她说完以后插进来 3 个别人、
//   或者这个人已经在跟别人你来我往就不叫（outside.direct 回到第一版：只认她直接在跟谁说）；
// · socialV2.wake.otherBots：别的机器人带到她名字不算叫她，也不按接话叫，@/引用她照叫；
// · socialV2.replyOnlyGroups：门控不叫、主动找人不找、自由时间不往里分享（有人托的照发）；@/叫名字/接话照旧。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
let nextId = 1;
const msg = (userId, segs) => ({
  self_id: 999, user_id: userId, message_id: nextId++, message: segs,
  raw_message: segs.map((s) => s.data?.text ?? '').join(''), sender: { nickname: `u${userId}`, card: `u${userId}` },
});
const text = (t) => ({ type: 'text', data: { text: t } });
const face = { type: 'face', data: { id: '178' } };
const BOT = 4018;

async function fixture(run, socialV2 = {}, globals = {}) {
  const h = await bridgeHarness({ config: {
    homeGroups: ['456'], allow: { private: ['123'], groups: ['456', '789'] }, ownerTitles: { 123: '爸爸' },
    socialV2: {
      wake: { batchWindowMs: 1000, otherBots: [String(BOT)] },
      proactive: { enabled: false }, sticker: { enabled: false },
      replyGate: { enabled: true, quietMs: 300, talkValue: { group: 0, home: 0 } },
      ...socialV2,
    },
  }, globals });
  h.setMode('reserved2');
  h.setSelfIdentity('鱼妹', '999');
  const group = (id) => {
    const st = h.getSocialV2State(`group:${id}`);
    st.bootstrapSent = true;
    st.wakeConfig.triggers = { atMention: true, nameMention: true, poke: true, question: true, keywords: ['猫'], probability: 1 };
    return st;
  };
  const take = (st) => {
    const r = st.pendingWakeReason || null;
    if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
    st.pendingWakeReason = null;
    return r;
  };
  const seen = (st) => { st.unread = []; st.lastReadThroughSeq = st.lastUnreadSeq; if (st.gateTimer) { clearTimeout(st.gateTimer); st.gateTimer = null; } };
  const say = (id, userId, segs) => h.handleIncoming('group', id, msg(userId, segs), h.cfg);
  try { await run({ h, group, take, seen, say }); } finally { await h.close(); }
}

await test('普通群：约游戏、喊人上号的不算；她说完以后别人自己你来我往、插进来 3 个人就不叫', () => fixture(async ({ h, group, take, seen, say }) => {
  const key = 'group:789';
  const st = group('789');
  await say('789', 888, [text('下午谁打瓦')]);
  await say('789', 777, [text('鱼妹你玩不玩')]);
  assert.equal(take(st), 'nameMention');
  seen(st);
  h.recordSentMessagesV2(key, ['我不会玩诶']);
  await say('789', 888, [text('来来来 上号')]);
  assert.equal(take(st), null, '喊人上号');
  await say('789', 777, [text('那你看我们打')]);
  assert.equal(take(st), 'talkBack', '777 在回她');
  await say('789', 888, [text('好啊好啊')]);
  assert.equal(take(st), null, '888 说过、777 接了、888 又说：是在跟 777 聊');
  // 她开口前看过的最近 3 位都算（第一版只认直接对象）
  seen(st);
  h.recordSentMessagesV2(key, ['那我看着']);
  await say('789', 555, [text('我也来')]);
  assert.equal(take(st), null, '555 她之前没看到');
  await say('789', 666, [text('我也')]);
  await say('789', 888, [text('鱼鱼看着也行')]);
  assert.equal(take(st), 'talkBack', '888 也在她看过的人里，插进来 2 个人还不算多');
  await say('789', 444, [text('哈哈')]);
  await say('789', 777, [text('嗯嗯')]);
  assert.equal(take(st), null, '她说完以后插进来 3 个别人');
  // 窗口照旧 5 分钟
  seen(st);
  h.recordSentMessagesV2(key, ['那我看着']);
  st.recentMessages.at(-1).time = Date.now() - 4 * 60000;
  await say('789', 777, [text('好')]);
  assert.equal(take(st), 'talkBack', '4 分钟还算');
  st.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - 6 * 60000;
  await say('789', 777, [text('好的')]);
  assert.equal(take(st), null, '超过 5 分钟');
  // 自定义词表；[] 关掉
  h.cfg.socialV2.replyGate.talkBack = { gameWords: [] };
  seen(st);
  h.recordSentMessagesV2(key, ['你们打吧']);
  await say('789', 777, [text('来来来 上号')]);
  assert.equal(take(st), 'talkBack');
}));

await test('普通群 outside.direct：只认她直接在跟谁说，3 分钟，插进来 2 个人就不叫', () => fixture(async ({ h, group, take, seen, say }) => {
  const key = 'group:789';
  const st = group('789');
  h.cfg.socialV2.replyGate.talkBack = { outside: { direct: true } };
  await say('789', 888, [text('下午谁打瓦')]);
  await say('789', 777, [text('鱼妹你玩不玩')]);
  assert.equal(take(st), 'nameMention');
  seen(st);
  h.recordSentMessagesV2(key, ['我不会玩诶']);
  await say('789', 888, [text('那算了')]);
  assert.equal(take(st), null, '888 不是她在跟着说的人');
  await say('789', 777, [text('那你看我们打')]);
  assert.equal(take(st), 'talkBack', '777 叫她来的、她在回 777');
  await say('789', 555, [text('我也来')]);
  await say('789', 777, [text('好多人')]);
  assert.equal(take(st), null, '她说完以后插进来 2 个人');
  seen(st);
  h.recordSentMessagesV2(key, ['那我看着']);
  st.recentMessages.at(-1).time = Date.now() - 4 * 60000;
  await say('789', 555, [text('好')]);
  assert.equal(take(st), null, 'direct 超过 3 分钟');
  seen(st);
  h.recordSentMessagesV2(key, ['你打哪个位置'], { toUserIds: ['555'] });
  await say('789', 777, [text('我打辅助')]);
  assert.equal(take(st), null, '她引用的是 555');
  await say('789', 555, [text('我打野')]);
  assert.equal(take(st), 'talkBack');
}));

await test('所有群：只发表情、引用别人的不算接话；家里的群还是 5 分钟、最近 3 个人', () => fixture(async ({ h, group, take, seen, say }) => {
  const key = 'group:456';
  const st = group('456');
  await say('456', 888, [text('今天好热')]);
  await say('456', 777, [text('是啊')]);
  seen(st);
  h.recordSentMessagesV2(key, ['热到化了']);
  await say('456', 888, [face]);
  assert.equal(take(st), null, '只发表情');
  await say('456', 888, [{ type: 'reply', data: { id: '424242' } }, text('你说得对')]);
  assert.equal(take(st), null, '引用的不是她');
  st.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - 4 * 60000;
  await say('456', 888, [text('真的化了')]);
  assert.equal(take(st), 'talkBack', '家里的群 4 分钟还算，888 也算');
  // 关掉 skipMedia：表情也算
  h.cfg.socialV2.replyGate.talkBack = { skipMedia: false };
  await say('456', 777, [face]);
  assert.equal(take(st), 'talkBack');
}));

await test('别的机器人：带到她名字不叫、不按接话叫；@她照叫', () => fixture(async ({ h, group, take, seen, say }) => {
  const key = 'group:789';
  const st = group('789');
  await say('789', BOT, [text('鱼妹说得对')]);
  assert.equal(take(st), null, '机器人叫名字不算');
  await say('789', BOT, [{ type: 'at', data: { qq: '999' } }, text('鱼妹你好')]);
  assert.equal(take(st), 'atMention');
  seen(st);
  h.recordSentMessagesV2(key, ['你好呀']);
  await say('789', BOT, [text('今天天气不错')]);
  assert.equal(take(st), null, '机器人不按接话叫');
}));

await test('只在有人找时说话的群：门控不叫、talk=0；叫名字和接话照旧；提示里写明', () => fixture(async ({ h, group, take, seen, say }) => {
  const key = 'group:789';
  const st = group('789');
  assert.equal(h.talkValueOfV2(key), 0);
  assert.equal(h.talkValueOfV2('group:456'), 1);
  await say('789', 777, [text('有人养猫吗？')]);
  assert.equal(take(st), null);
  assert.ok(!st.gateTimer, '门控都没排');
  assert.equal(h.evaluateReplyGateV2(key), null);
  await say('789', 777, [text('鱼妹呢')]);
  assert.equal(take(st), 'nameMention');
  seen(st);
  h.recordSentMessagesV2(key, ['我在']);
  await say('789', 777, [text('你养猫吗')]);
  assert.equal(take(st), 'talkBack');
  const p = h.buildWakePromptV2(key, 'talkBack');
  assert.match(p, /只在有人找你的时候说话/);
  assert.match(p, /约游戏/);
  assert.doesNotMatch(h.buildWakePromptV2('group:456', 'replyGate'), /只在有人找你的时候说话/, '家里的群不写');
}, {
  replyOnlyGroups: ['group:789'],
  replyGate: { enabled: true, quietMs: 300, talkValue: { group: 1, home: 1 } },
}));

await test('只在有人找时说话的群：自由时间不往里分享（有人托的照发，限频关了也拦）', () => fixture(async ({ h }) => {
  h.getSocialV2State('group:789');
  assert.match(h.playShareGateV2('group:789', false) ?? '', /只在有人找你的时候说话/);
  assert.equal(h.playShareGateV2('group:456', false), null, '家里的群照旧');
  h.cfg.socialV2.playShare = { enabled: false };
  assert.match(h.playShareGateV2('group:789', false) ?? '', /只在有人找你的时候说话/);
  const play = h.getSocialV2State('play:main');
  play.playRequests = [{ from: 'group:789', at: Date.now(), what: '看个视频' }];
  assert.equal(h.playShareGateV2('group:789', false), null, '有人托的');
}, { replyOnlyGroups: ['group:789'] }));

await test('只在有人找时说话的群：写在 initiate.targets、byKey 里也不找', () => {
  const asked = [];
  const fetch = async (url, init = {}) => {
    if (String(url).includes('/proactive/think')) asked.push(JSON.parse(init.body).targets.map((t) => t.key));
    return { ok: true, status: 200, json: async () => ({ ok: true, thoughts: [] }) };
  };
  return fixture(async ({ h }) => {
    for (const k of ['group:456', 'group:789']) {
      const st = h.getSocialV2State(k);
      h.appendSocialV2Message(k, '某人', '好无聊', '好无聊', false, false, 1, [], '77');
      st.recentMessages.at(-1).time = Date.now() - 5 * 3600000;
    }
    h.socialV2.life.initiateNextAt = Date.now() - 1000;
    await h.initiateTickV2();
    assert.deepEqual(asked, [['group:456']]);
  }, {
    replyOnlyGroups: ['group:789'],
    nightSleep: { enabled: false },
    initiate: { enabled: true, targets: ['group:456', 'group:789'], from: '00:00', to: '00:00', minSilenceMinutes: 60,
      byKey: { 'group:789': { threshold: 3 } } },
    life: { enabled: true },
  }, { fetch });
});

await test('她问了人：被问的人 15 分钟内回话还算接话；没在问、别人、过了 15 分钟都不算', () => fixture(async ({ h, group, take, seen, say }) => {
  const key = 'group:789';
  const st = group('789');
  const age = (minutes) => { st.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - minutes * 60000; };
  await say('789', 888, [text('今天好困')]);
  await say('789', 777, [text('鱼妹早')]);
  assert.equal(take(st), 'nameMention');
  seen(st);
  h.recordSentMessagesV2(key, ['早呀', '你昨晚几点睡的']);
  age(10);
  await say('789', 888, [text('我也困')]);
  assert.equal(take(st), null, '888 不是她直接在跟着说的人，过了 5 分钟就不算');
  await say('789', 777, [text('我给你说了呀')]);
  assert.equal(take(st), 'talkBack', '她问的是 777，10 分钟还算');
  // 没在问：过了 5 分钟照旧不算
  seen(st);
  h.recordSentMessagesV2(key, ['好吧我忘了']);
  age(10);
  await say('789', 777, [text('你忘了')]);
  assert.equal(take(st), null, '她最后那段话不是在问');
  // 过了 15 分钟
  seen(st);
  h.recordSentMessagesV2(key, ['那你几点起的']);
  age(16);
  await say('789', 777, [text('八点')]);
  assert.equal(take(st), null, '超过 15 分钟');
  // questionMinutes 可改
  h.cfg.socialV2.replyGate.talkBack = { questionMinutes: 30 };
  seen(st);
  h.recordSentMessagesV2(key, ['那你几点起的']);
  age(16);
  await say('789', 777, [text('八点半')]);
  assert.equal(take(st), 'talkBack', 'questionMinutes 30');
}));

await test('byKey 单独设时间窗：windowMinutes 负数不限，别的群照旧 5 分钟', () => fixture(async ({ h, group, take, seen, say }) => {
  const home = group('456');
  await say('456', 888, [text('今天好热')]);
  await say('456', 777, [text('是啊')]);
  seen(home);
  h.recordSentMessagesV2('group:456', ['热到化了']);
  home.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - 3 * 3600000;
  await say('456', 888, [text('真的化了')]);
  assert.equal(take(home), 'talkBack', '小群 3 小时后还算');
  await say('456', 555, [text('我刚来')]);
  assert.equal(take(home), null, '555 她之前没看到');
  const other = group('789');
  await say('789', 777, [text('鱼妹在吗')]);
  assert.equal(take(other), 'nameMention');
  seen(other);
  h.recordSentMessagesV2('group:789', ['在的']);
  other.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - 6 * 60000;
  await say('789', 777, [text('好')]);
  assert.equal(take(other), null, '别的群超过 5 分钟');
}, { replyGate: { enabled: true, quietMs: 300, talkValue: { group: 0, home: 0 }, talkBack: { byKey: { 'group:456': { windowMinutes: -1 } } } } }));

await test('小群默认都是跟她说的（wake.addressedGroups）：每条都叫，@/引用别人、开头叫着别人、别的机器人不算；别的群照旧', () => fixture(async ({ h, group, take, say }) => {
  const st = group('456');
  await say('456', 888, [text('今天好热')]);
  assert.equal(take(st), 'addressed');
  assert.ok(h.waitAddressedV2(st, 0), '等待工具提前返回');
  await say('456', 777, [face]);
  assert.equal(take(st), 'addressed', '发个表情也算');
  await say('456', 777, [{ type: 'at', data: { qq: 'all' } }, text('开会了')]);
  assert.equal(take(st), 'addressed', '@全体成员也算');
  await say('456', 777, [{ type: 'at', data: { qq: '888' } }, text('你吃了没')]);
  assert.equal(take(st), null, '@ 别人');
  await say('456', 777, [{ type: 'reply', data: { id: '424242' } }, text('对')]);
  assert.equal(take(st), null, '引用别人');
  await say('456', 777, [text('u888 你下班没')]);
  assert.equal(take(st), null, '开头叫着别人');
  await say('456', 777, [text('鱼妹 u888 下班没')]);
  assert.equal(take(st), 'nameMention', '叫了她就是叫她');
  await say('456', BOT, [text('今天天气不错')]);
  assert.equal(take(st), null, '别的机器人');
  const p = h.buildWakePromptV2('group:456', 'addressed');
  assert.match(p, /【家里的小群】/);
  assert.match(p, /默认是在跟你说/);
  const other = group('789');
  await say('789', 888, [text('今天好热')]);
  assert.equal(take(other), null, '别的群照旧');
  assert.doesNotMatch(h.buildWakePromptV2('group:789', 'replyGate'), /【家里的小群】/);
}, { wake: { batchWindowMs: 1000, otherBots: [String(BOT)], addressedGroups: ['group:456'] } }));

await test('她直接在跟着说的人：只发表情也算接话；别人把她叫来她没接，这个人另外说话还叫', () => fixture(async ({ h, group, take, seen, say }) => {
  // 2026-10-26 大群：她刚回了阿明（777），888 插了个“？”把她叫来，她没接；阿明接着发的表情和“可爱”都没叫到她
  const key = 'group:789';
  const st = group('789');
  const sticker = { type: 'image', data: { file: 's.gif', sub_type: 1, summary: '[动画表情]' } };
  const photo = { type: 'image', data: { file: 'p.jpg', sub_type: 0, summary: '' } };
  await say('789', 888, [text('今天好闲')]);
  await say('789', 777, [text('鱼妹现在心情如何')]);
  assert.equal(take(st), 'nameMention');
  seen(st);
  h.recordSentMessagesV2(key, ['心情挺好呀']);
  st.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - 2000;
  await say('789', 888, [sticker]);
  assert.equal(take(st), null, '888 只是她看过的人，不是她在跟着说的人，只发表情不算');
  await say('789', 777, [photo]);
  assert.equal(take(st), null, '只发照片截图照旧不算');
  await say('789', 777, [sticker]);
  assert.equal(take(st), 'talkBack', '她在跟着说的人回了个表情包');
  seen(st);
  h.recordSentMessagesV2(key, ['嘿嘿']);
  st.recentMessages.filter((m) => m.isSelf).at(-1).time = Date.now() - 2000;
  await say('789', 888, [text('？')]);
  assert.equal(take(st), 'talkBack', '888 是她开口前看过的人');
  // 叫来了，她只看到“？”，没接
  st.lastWakeReason = 'talkBack';
  st.wakeConfig.lastWakeAt = Date.now();
  seen(st);
  h.gateTurnEndedV2(key);
  assert.deepEqual([...st.talkBackDeclined.ids], ['888']);
  await say('789', 777, [text('可爱')]);
  assert.equal(take(st), 'talkBack', '777 另外说话还叫');
  await say('789', 888, [text('搞那么甜干什么')]);
  assert.equal(take(st), null, '888 的她不接了');
  // 777 那句叫来了她也没接：两个人都不再叫
  st.lastWakeReason = 'talkBack';
  st.wakeConfig.lastWakeAt = Date.now();
  seen(st);
  h.gateTurnEndedV2(key);
  assert.deepEqual([...st.talkBackDeclined.ids].sort(), ['777', '888']);
  await say('789', 777, [text('喂')]);
  assert.equal(take(st), null, '777 的也不接了');
  // 她又说了：重新算；旧状态里的 talkBackDeclinedFor 当所有人都不接
  h.recordSentMessagesV2(key, ['在的在的']);
  await say('789', 777, [text('好')]);
  assert.equal(take(st), 'talkBack');
  st.talkBackDeclinedFor = st.recentMessages.filter((m) => m.isSelf).at(-1).time;
  await say('789', 777, [text('嗯')]);
  assert.equal(take(st), null, '旧字段');
}));

if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
