// qqbot_agent：QQ 原生工具（2026-11-08，架构调整第 3 步）。能力表 src/qq-capabilities.js 的参数 schema 只用 DSH 认的关键字、
// checkArgs 替 DSH 查参数；插件 qq-native-tools.mjs 把会话 id 放进 x-agent-session，桥接控制台换成那个会话的令牌。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { CAPABILITIES, NATIVE_TOOL_NAMES, capabilitiesFor, capabilityEnabled, checkArgs, nativeToolNamesFor, parametersOf } from '../src/qq-capabilities.js';
import { nativeToolDefs } from '../plugins/qq-agent-presets/qq-native-tools.mjs';

const ALLOWED_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
function walkSchema(schema, where) {
  for (const k of Object.keys(schema)) assert.ok(ALLOWED_KEYS.has(k), `${where} 用了 DSH 不认的 ${k}`);
  if (schema.oneOf) {
    assert.ok(schema.oneOf.length >= 2, `${where} 的 oneOf 至少两项`);
    assert.equal(schema.type, undefined, `${where} 的 oneOf 旁边不能有 type`);
    schema.oneOf.forEach((s, i) => walkSchema(s, `${where}.oneOf[${i}]`));
  }
  if (schema.properties) for (const [k, s] of Object.entries(schema.properties)) walkSchema(s, `${where}.${k}`);
  if (schema.required) for (const k of schema.required) assert.ok(Object.hasOwn(schema.properties ?? {}, k), `${where} required 里的 ${k} 不在 properties`);
  if (schema.items) walkSchema(schema.items, `${where}[]`);
  if (schema.additionalProperties !== undefined) assert.equal(typeof schema.additionalProperties, 'boolean');
}
const cap = (name, side = 'play') => CAPABILITIES.find((c) => c.name === name && c.sides.includes(side));
const chat = (name) => cap(name, 'chat');

test('参数 schema 只用 DSH 认的关键字，没有 key、token', () => {
  for (const c of CAPABILITIES) {
    const p = parametersOf(c);
    walkSchema(p, c.name);
    assert.equal(p.additionalProperties, false);
    assert.equal('key' in p.properties || 'token' in p.properties, false, c.name);
    assert.equal(typeof c.description({}), 'string');
  }
  for (const side of ['play', 'chat']) {
    const names = nativeToolNamesFor(side);
    assert.equal(new Set(names).size, names.length, `${side} 里没有重名的`);
    for (const n of names) assert.ok(NATIVE_TOOL_NAMES.includes(n));
  }
  assert.equal(new Set(NATIVE_TOOL_NAMES).size, NATIVE_TOOL_NAMES.length, '守卫的名单不重复');
  assert.deepEqual([...NATIVE_TOOL_NAMES].sort(), [...new Set([...nativeToolNamesFor('play'), ...nativeToolNamesFor('chat')])].sort());
  assert.equal(nativeToolNamesFor('play').length, 7);
  // 返回图片的留在 MCP
  for (const n of ['qq_get_message_images', 'qq_get_forward_msg', 'qq_get_sticker_image', 'qq_get_self_image']) assert.ok(!NATIVE_TOOL_NAMES.includes(n), n);
  assert.equal(capabilityEnabled(cap('qq_draw'), { socialV2: { tools: { draw: false } } }), false);
  assert.equal(capabilityEnabled(cap('qq_draw'), {}), true);
  // 表情包、语音还看各自的总开关
  assert.equal(capabilityEnabled(chat('qq_send_sticker'), { socialV2: { sticker: { enabled: false } } }), false);
  assert.equal(capabilityEnabled(chat('qq_list_voices'), { socialV2: { voice: { enabled: false } } }), false);
  assert.equal(capabilityEnabled(chat('qq_send_sticker'), {}), true);
  // 等对方说完开着时 quietMs 的说明换成“一般不用填”
  assert.match(parametersOf(chat('qq_wait_for_messages'), { socialV2: { replyTiming: { enabled: true } } }).properties.quietMs.description, /一般不用填/);
  assert.match(parametersOf(chat('qq_wait_for_messages'), {}).properties.quietMs.description, /建议 3000~5000/);
});

test('checkArgs 替 DSH 查参数', () => {
  assert.match(checkArgs(cap('qq_send_message'), { key: 'play:main', token: 'x', to: 'group:1', messages: 'hi' }), /不用填 key，发到哪个聊天写在 to 里/);
  assert.match(checkArgs(cap('qq_mark_read'), { token: 'x' }), /qq_mark_read 不用填 token$/);
  assert.match(checkArgs(cap('qq_mark_read'), { throughSeq: 3 }), /没有参数 throughSeq/);
  assert.match(checkArgs(cap('qq_send_message'), { messages: 'hi' }), /缺参数 to/);
  assert.match(checkArgs(cap('qq_send_message'), { to: '1100000001', messages: 'hi' }), /group:群号/);
  assert.match(checkArgs(cap('qq_send_message'), { to: 'group:1', messages: [] }), /空数组/);
  assert.match(checkArgs(cap('qq_send_message'), { to: 'group:1', messages: [1] }), /messages 的类型不对/);
  assert.equal(checkArgs(cap('qq_send_message'), { to: 'group:1', messages: ['a', 'b'], replyToMessageId: '12', atUserId: 42 }), null);
  assert.match(checkArgs(cap('qq_make_video'), { to: 'group:1', prompt: 'x', seconds: 20 }), /1~15/);
  assert.match(checkArgs(cap('qq_make_video'), { to: 'group:1', prompt: 'x', seconds: 2.5 }), /seconds 的类型不对/);
  assert.match(checkArgs(cap('qq_draw'), { to: 'group:1', prompt: 'x', people: ['1', '2', '3', '4', '5'] }), /最多 4 个/);
  assert.match(checkArgs(cap('qq_send_screenshot'), { to: 'private:2', tabIndex: -1 }), /负数/);
  assert.equal(checkArgs(cap('qq_set_mood'), { mood: '美滋滋', why: null }), null);
  assert.match(checkArgs(cap('qq_set_mood'), []), /对象/);
  // 聊天那边：没有 to，key 不提 to
  assert.match(checkArgs(chat('qq_send_message'), { key: 'group:1', messages: 'hi' }), /qq_send_message 不用填 key$/);
  assert.equal(checkArgs(chat('qq_send_message'), { messages: 'hi', replyToMessageId: -12 }), null);
  assert.match(checkArgs(chat('qq_mark_read'), { throughSeq: -1 }), /不能是负数/);
  assert.equal(checkArgs(chat('qq_mark_read'), { throughSeq: 3 }), null);
  assert.equal(checkArgs(chat('qq_tell_myself'), { stopPlay: true }), null, 'qq_tell_myself 的 to 可以不填、可以是 all');
  assert.equal(checkArgs(chat('qq_tell_myself'), { to: 'all', note: 'x' }), null);
  assert.match(checkArgs(chat('qq_send_elsewhere'), { to: 'play:main', messages: 'x' }), /group:群号/);
  assert.match(checkArgs(chat('qq_set_wake_config'), { config: { triggers: { speakerIds: Array.from({ length: 21 }, (_, i) => i) } } }), /最多 20/);
  assert.match(checkArgs(chat('qq_set_wake_config'), { config: 'diving' }), /config 的类型不对/);
});

test('发消息：写成 JSON 字符串的数组照样拆开，发到 to', () => {
  const req = cap('qq_send_message').call({ to: 'group:456', messages: '["a","b"]' }, { key: 'play:main' });
  assert.equal(req.path, '/api/socialV2/send-message');
  assert.equal(req.body.key, 'group:456');
  assert.deepEqual(Array.from(req.body.messages), ['a', 'b']);
  assert.equal(req.body.atUserId, null);
  assert.deepEqual(cap('qq_mark_read').call({}, { key: 'play:main' }).body, { key: 'play:main' });
  // 聊天那边 key 就是调用它的会话；qq_reply 走 send-message（MCP 版的 /api/send/reply 只认参数里的 token）
  const reply = chat('qq_reply').call({ replyToMessageId: 7, message: '对' }, { key: 'private:9' });
  assert.equal(reply.path, '/api/socialV2/send-message');
  assert.deepEqual(reply.body, { key: 'private:9', messages: '对', replyToMessageId: 7, atUserId: null });
  const unread = chat('qq_get_unread_messages').call({ afterSeq: 0 }, { key: 'group:1' });
  assert.equal(unread.method, 'GET');
  assert.equal(unread.path, '/api/socialV2/unread?key=group%3A1&limit=30&afterSeq=0');
  const wait = chat('qq_wait_for_messages').call({ timeoutMs: 600000 }, { key: 'private:9' });
  assert.equal(wait.longPoll, true);
  assert.equal(wait.timeoutMs, 630000, '比 fetch 的 300 秒长，插件用 node:http');
});

async function fixture(run, side = 'play') {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: false },
    send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
    proactive: { enabled: false }, sticker: { enabled: false }, nightSleep: { enabled: false },
  } } });
  for (const k of ['group:456', 'play:main']) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const logs = [];
  const defs = nativeToolDefs({ side, cfg: {}, base: `http://127.0.0.1:${server.address().port}`,
    consoleToken: () => 'fixture-console-token', log: (s) => logs.push(s) });
  const tool = (name) => defs.find((d) => d.name === name);
  const exec = (sessionId) => ({ agent: { id: sessionId }, signal: new AbortController().signal });
  try { await run({ h, defs, tool, exec, logs }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('插件按会话 id 找到窗口，心情、发消息走那个会话的令牌', () => fixture(async ({ h, defs, tool, exec, logs }) => {
  assert.deepEqual(defs.map((d) => d.name), nativeToolNamesFor('play'));
  const r = await tool('qq_set_mood').execute({ mood: '美滋滋', why: '这关过了' }, exec('sid-play:main'));
  assert.match(r.text, /记下了/);
  assert.equal(h.socialV2.mood.key, 'play:main');
  assert.match(logs[0], /会话 sid-play:main 是 play:main/);
  const sent = await tool('qq_send_message').execute({ to: 'group:456', messages: ['看完回来了'] }, exec('sid-play:main'));
  assert.match(sent.text, /ok/);
  const entry = h.getSocialV2State('group:456').recentMessages.at(-1);
  assert.equal(entry.byPlay, true, 'play 发进群里的记成自由时间那边发的');
  assert.equal(entry.text, '看完回来了');
  assert.equal(logs.length, 1, '第一次调用只记一回');
}));

test('不认识的会话、参数错了都直接失败', () => fixture(async ({ tool, exec }) => {
  await assert.rejects(tool('qq_set_mood').execute({ mood: '困' }, exec('sid-gone')), /没记上：这个会话现在不能用 QQ 工具/);
  await assert.rejects(tool('qq_send_message').execute({ key: 'play:main', token: 'x', to: 'group:456', messages: 'hi' }, exec('sid-play:main')), /^Error: 发送失败：qq_send_message 不用填 key/);
  await assert.rejects(tool('qq_mark_read').execute({}, { agent: {} }), /不知道是哪个会话/);
}));

test('聊天那边：只管自己这个聊天，照旧填的 key、token 拿掉，key 填了别处就说清楚', () => fixture(async ({ h, defs, tool, exec }) => {
  assert.deepEqual(defs.map((d) => d.name), nativeToolNamesFor('chat'));
  const sent = await tool('qq_send_message').execute({ messages: ['在的'] }, exec('sid-group:456'));
  assert.match(sent.text, /ok/);
  const entry = h.getSocialV2State('group:456').recentMessages.at(-1);
  assert.equal(entry.text, '在的');
  assert.notEqual(entry.byPlay, true, '聊天自己说的不算自由时间发的');
  await h.handleIncoming('group', '456', { self_id: 999, user_id: 777, message_id: 5001, message: [{ type: 'text', data: { text: '是吧' } }],
    raw_message: '是吧', sender: { nickname: 'u777', card: 'u777' } }, h.cfg);
  const again = await tool('qq_reply').execute({ key: 'group:456', token: 'stale', replyToMessageId: h.getSocialV2State('group:456').recentMessages.find((m) => m.messageId === '5001').seq, message: '对' }, exec('sid-group:456'));
  assert.match(again.text, /ok/, '压缩前的习惯：照填 key、token 也能用');
  await assert.rejects(tool('qq_send_message').execute({ key: 'group:789', messages: 'hi' }, exec('sid-group:456')), /只管这个聊天（group:456）.*qq_send_elsewhere.*qq_tell_myself/);
  const unread = await tool('qq_get_unread_messages').execute({}, exec('sid-group:456'));
  assert.match(unread.text, /readThroughSeq/);
  const started = Date.now();
  const waited = await tool('qq_wait_for_messages').execute({ timeoutMs: 1000 }, exec('sid-group:456'));
  assert.match(waited.text, /readThroughSeq/);
  assert.ok(Date.now() - started >= 900, '真的等了');
  const read = await tool('qq_mark_read').execute({}, exec('sid-group:456'));
  assert.match(read.text, /ok/);
  // 停了这一轮，等待也跟着停
  const ac = new AbortController();
  const pending = tool('qq_wait_for_messages').execute({ timeoutMs: 20000 }, { agent: { id: 'sid-group:456' }, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(pending, /等待失败：/);
}, 'chat'));

test('守卫放行原生 QQ 工具', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../plugins/qq-agent-presets/qq-tool-restrict.mjs', import.meta.url), 'utf8'));
  assert.match(src, /\.\.\.NATIVE_TOOL_NAMES/);
});
