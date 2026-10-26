// qqbot_agent：唤醒时向 extras /recall 取长期记忆，要带上最近在聊的内容（query），extras 按它挑相关记忆。
import assert from 'node:assert/strict';
import http from 'node:http';
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

await test('唤醒取长期记忆时带上群号、说话的人和最近聊天内容', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 500 } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(77777, 1, '你们看台风新闻了吗，香港那边挂八号风球'), h.cfg);
    for (let i = 0; i < 60 && !h.calls.prompts.length; i += 1) await sleep(50);
    assert.equal(h.calls.prompts.length, 1);
    const req = h.calls.http.find((c) => c.url.endsWith('/recall'));
    assert.ok(req, '要请求 /recall');
    assert.deepEqual(req.body.subjects, ['group:456', 'qq:77777']);
    assert.ok(req.body.query.includes('八号风球'), 'query 要包含最近的聊天内容');
    assert.ok(req.body.query.length <= 1500);
  } finally { await h.close(); }
});

await test('每来一条消息通知 extras 记一笔（只带会话和发言人，不带内容）', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 500 } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(77777, 1, '第一句'), h.cfg);
    await h.handleIncoming('group', '456', msg(88888, 2, '第二句'), h.cfg);
    await sleep(20);
    const notes = h.calls.http.filter((c) => c.url === 'http://extras:8940/digest/notify');
    assert.deepEqual(notes.map((c) => c.body), [{ key: 'group:456', userId: '77777' }, { key: 'group:456', userId: '88888' }]);
  } finally { await h.close(); }
});

await test('关掉 digestNotify 就不通知', async () => {
  const h = await bridgeHarness({ config: { socialV2: { longTermMemory: { digestNotify: false } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(77777, 1, '第一句'), h.cfg);
    await sleep(20);
    assert.equal(h.calls.http.filter((c) => c.url.endsWith('/digest/notify')).length, 0);
  } finally { await h.close(); }
});

// 人物卡（2026-10-23）：extras /recall 收到 people（刚说话的人）返回 cards，bridge 渲染成【对人的了解】。
function recallFetch(calls, cards) {
  return async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/recall')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, cards, entries: [
        { id: 'r1', subject: 'rules', text: '不发链接', updated: '2026-10-22' },
        { id: 'f1', subject: 'qq:77777', text: '养了一只柯基', updated: '2026-10-22' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
  };
}
const CARDS = [
  { subject: 'qq:77777', aliases: ['阿杰', '阿杰睡不醒'], mine: '说话冲但人不坏', card: '相处：爱抬杠，别较真\n了解：养柯基', updated: '2026-10-22' },
  { subject: 'qq:900000001', aliases: ['阿明'], mine: '', card: '相处：爱逗我', updated: '2026-10-21' },
];
const groupState = () => ({ recentMessages: [
  { userId: '900000001', sender: '阿明', plain: '阿杰你家柯基呢' }, { userId: '77777', sender: '阿杰', plain: '在睡觉' }], unread: [] });

await test('人物卡开着：/recall 带 key 和 people，渲染【对人的了解】，大群里主人不叫爸爸', async () => {
  const calls = [];
  const h = await bridgeHarness({
    config: { ownerQQ: 900000001, allow: { private: ['900000001'], groups: ['456'] }, ownerTitles: { 900000001: '爸爸' }, homeGroups: ['999'], socialV2: { longTermMemory: { personCards: true } } },
    globals: { fetch: recallFetch(calls, CARDS) },
  });
  try {
    const text = await h.longTermMemoryBlockV2('group:456', groupState());
    const req = calls.find((c) => c.url.endsWith('/recall'));
    assert.equal(req.body.key, 'group:456');
    assert.deepEqual(Array.from(req.body.people), ['qq:77777', 'qq:900000001']);
    assert.ok(text.indexOf('【对人的了解】') >= 0 && text.indexOf('【对人的了解】') < text.indexOf('【长期记忆】'), text);
    assert.ok(text.includes('- 阿杰 / 阿杰睡不醒（qq:77777）（2026-10-22）\n  我觉得：说话冲但人不坏\n  相处：爱抬杠，别较真\n  了解：养柯基'), text);
    assert.ok(text.includes('阿明（qq:900000001），主人（这个群里叫他的名字，不叫爸爸'), text);
    // person_note、“讲过了”这些用法写在系统提示里（test-qq-preset-contract 管），不在每次唤醒里重复
    assert.ok(text.includes('养了一只柯基'));
  } finally { await h.close(); }
});

await test('人物卡在私聊里：主人带称呼；people 是私聊对象', async () => {
  const calls = [];
  const h = await bridgeHarness({
    config: { ownerQQ: 900000001, allow: { private: ['900000001'], groups: ['456'] }, ownerTitles: { 900000001: '爸爸' }, homeGroups: ['999'], socialV2: { longTermMemory: { personCards: true } } },
    globals: { fetch: recallFetch(calls, [CARDS[1]]) },
  });
  try {
    const text = await h.longTermMemoryBlockV2('private:900000001', { recentMessages: [], unread: [] });
    assert.deepEqual(Array.from(calls[0].body.people), ['qq:900000001']);
    assert.ok(text.includes('阿明（qq:900000001），主人（你的爸爸）'), text);
  } finally { await h.close(); }
});

await test('人物卡关着（默认）：不发 people、不渲染卡，memberImpression 照旧', async () => {
  const calls = [];
  const h = await bridgeHarness({ globals: { fetch: recallFetch(calls, CARDS) } });
  try {
    const text = await h.longTermMemoryBlockV2('group:456', groupState());
    assert.equal(calls[0].body.people, undefined);
    assert.equal(calls[0].body.key, 'group:456');
    assert.ok(!text.includes('【对人的了解】'));
    const st = h.getSocialV2State('group:456');
    h.appendMemoryV2(st, 'memberImpression', '爱发猫图', { target: '阿杰' });
    assert.ok(h.formatMemoryV2(st).includes('【对群友的印象】'));
  } finally { await h.close(); }
});

await test('人物卡开着：【对群友的印象】不显示，qq_memory_append memberImpression 被引到 person_note', async () => {
  const h = await bridgeHarness({ config: { socialV2: { longTermMemory: { personCards: true } } } });
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    h.appendMemoryV2(st, 'memberImpression', '爱发猫图', { target: '阿杰' });
    assert.ok(!h.formatMemoryV2(st).includes('【对群友的印象】'));
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/memory-append', method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
      }, (r) => { let raw = ''; r.on('data', (c) => { raw += c; }); r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(raw) })); });
      req.on('error', reject);
      req.end(JSON.stringify({ key, category: 'memberImpression', content: '爱发猫图', extra: { target: '阿杰' } }));
    });
    await new Promise((resolve) => server.close(resolve));
    assert.equal(res.status, 400);
    assert.ok(res.data.error.includes('person_note'), res.data.error);
  } finally { await h.close(); }
});

// 讲过的见闻（2026-10-23）：她发出去的话交给 extras /memory/told；/recall 给回来的 told 渲染成“这里讲过了 / 别处讲过了”
await test('她说的话报给 /memory/told（自由时间会话不报，reportTold:false 不报）', async () => {
  const calls = [];
  const h = await bridgeHarness({ globals: { fetch: recallFetch(calls, []) } });
  try {
    h.recordSentMessagesV2('group:456', ['不过正好有个好玩的！', '日本一家幼儿园童鞋老丢']);
    h.recordSentMessagesV2('play:main', ['自言自语']);
    h.recordSentMessagesV2('group:456', ['群里分享一下'], { byPlay: true });
    await sleep(20);
    const told = calls.filter((c) => c.url === 'http://extras:8940/memory/told').map((c) => c.body);
    assert.deepEqual(told, [{ key: 'group:456', text: '不过正好有个好玩的！\n日本一家幼儿园童鞋老丢' }, { key: 'group:456', text: '群里分享一下' }]);
  } finally { await h.close(); }
  const calls2 = [];
  const h2 = await bridgeHarness({ config: { socialV2: { longTermMemory: { reportTold: false } } }, globals: { fetch: recallFetch(calls2, []) } });
  try {
    h2.recordSentMessagesV2('group:456', ['你好']);
    await sleep(20);
    assert.equal(calls2.filter((c) => c.url.endsWith('/memory/told')).length, 0);
  } finally { await h2.close(); }
});

await test('讲过的见闻标出来，别处讲过的不说是哪', async () => {
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith('/recall') ? { ok: true, entries: [
    { id: 'w1', subject: 'self', kind: 'log', text: '黄鼠狼偷童鞋', updated: '2026-10-22', told: ['group:456', 'private:900000001'] },
    { id: 'w2', subject: 'self', kind: 'log', text: '大王酸浆鱿', updated: '2026-10-22', told: ['private:900000001'] },
    { id: 'w3', subject: 'self', kind: 'log', text: '刺毛鼠脱皮', updated: '2026-10-22' }] } : { ok: true }) });
  const h = await bridgeHarness({ globals: { fetch } });
  try {
    const text = await h.longTermMemoryBlockV2('group:456', groupState());
    assert.ok(text.includes('- [w1 2026-10-22 见闻，这里讲过了] 黄鼠狼偷童鞋'), text);
    assert.ok(text.includes('- [w2 2026-10-22 见闻，别处讲过了] 大王酸浆鱿'), text);
    assert.ok(text.includes('- [w3 2026-10-22 见闻] 刺毛鼠脱皮'), text);
    assert.ok(!text.includes('900000001'), '大群里不该看到在哪个私聊讲过');
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
