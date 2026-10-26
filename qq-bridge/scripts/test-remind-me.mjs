// qqbot_agent：她答应了“待会儿/晚上/明天”再做的事（qq_remind_me）。到点叫这个聊天回来：
// 正在聊就插一句【到点了】，不在聊就用 reminder 唤醒；夜里睡着不叫（主人叫醒的窗口除外），醒了再叫。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:456';
async function fixture(run, extra = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456'] }, socialV2: {
    wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, ...extra,
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true;
  let server = null;
  const call = async (route, body, key = KEY, token = h.getSocialV2State(key).agentToken) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `${route}?key=${encodeURIComponent(key)}`, method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ key, ...body }));
    });
  };
  const remind = (body, key, token) => call('/api/socialV2/remind', body, key, token);
  const promptsText = () => h.calls.prompts.filter((p) => p.mode !== 'steer').map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));
  const steers = () => h.calls.prompts.filter((p) => p.mode === 'steer');
  // 模拟这一轮聊完了：不忙
  const idle = (key = KEY) => {
    h.pendingWakeKeys.delete(key);
    const sid = h.state.sessions?.[key];
    if (sid) h.v2TurnStartAt.delete(sid);
    const s = h.getSocialV2State(key);
    if (s.pendingWakeTimer) { clearTimeout(s.pendingWakeTimer); s.pendingWakeTimer = null; }
  };
  try { await run({ h, st, remind, call, promptsText, steers, idle }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('接口：自由时间那边不能用；note 必填；at / minutes 校验；没填时间就是列出来', () => fixture(async ({ h, remind }) => {
  const play = h.getSocialV2State('play:main');
  let r = await remind({ note: 'x', minutes: 5 }, 'play:main', play.agentToken);
  assert.equal(r.status, 400, JSON.stringify(r.data));
  r = await remind({ note: 'x', minutes: 5 }, KEY, 'bad-token');
  assert.equal(r.status, 403);
  r = await remind({ minutes: 5 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /note/);
  r = await remind({ note: '给大家看截图', at: '25:00' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /HH:MM/);
  r = await remind({ note: '给大家看截图', minutes: 0 });
  assert.equal(r.status, 400);
  r = await remind({ note: '给大家看截图', minutes: 3000 });
  assert.equal(r.status, 400);
  r = await remind({});
  assert.equal(r.status, 200);
  assert.equal(r.data.reminders.length, 0);
  assert.match(r.data.hint, /没有记着的事/);
  // 关掉工具
  h.cfg.socialV2.tools = { remindMe: false };
  r = await remind({ note: 'x', minutes: 5 });
  assert.equal(r.status, 403);
}));

await test('接口：记下、列出、按 id 取消、全部取消；每处最多 5 件', () => fixture(async ({ h, remind }) => {
  let r = await remind({ note: '十分钟后给阿明看 2048 截图', minutes: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.id);
  assert.match(r.data.hint, /不用说你记了提醒/);
  const rem = h.socialV2.reminders.find((x) => x.id === r.data.id);
  assert.ok(Math.abs(rem.due - (Date.now() + 10 * 60000)) < 2000);
  r = await remind({ note: '晚上接着答题', at: '20:30' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.when, /20:30/);
  const second = r.data.id;
  r = await remind({ note: '全角冒号也认', at: '7：05' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.when, /07:05/);
  r = await remind({});
  assert.equal(r.data.reminders.length, 3);
  r = await remind({ cancel: second });
  assert.equal(r.status, 200);
  assert.equal(r.data.cancelled, 1);
  r = await remind({ cancel: 'nope' });
  assert.equal(r.status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await remind({ note: `事 ${i}`, minutes: 30 + i })).status, 200);
  r = await remind({ note: '第六件', minutes: 60 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /记着 5 件/);
  // 别的会话不受影响
  const pv = h.getSocialV2State('private:42');
  assert.equal((await remind({ note: '私聊的事', minutes: 5 }, 'private:42', pv.agentToken)).status, 200);
  r = await remind({ cancel: 'all' });
  assert.equal(r.data.cancelled, 5);
  assert.equal(h.socialV2.reminders.length, 1);
  assert.equal(h.socialV2.reminders[0].key, 'private:42');
}));

await test('家里以外的群：不让记到点去说晚安的提醒，到点的提示写明只想说一声就别说；家里的群照旧', () => fixture(async ({ h, remind }) => {
  h.cfg.homeGroups = ['111'];
  let r = await remind({ note: '在大群跟大家说一声晚安，然后 qq_go_to_sleep 睡觉', at: '23:29' });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /家里的小群/);
  assert.equal((await remind({ note: '跟大家说我去睡觉了', minutes: 20 })).status, 400);
  r = await remind({ note: '给 777 发那张截图', minutes: 10 });
  assert.equal(r.status, 200, '别的事照记');
  assert.match(h.buildWakePromptV2(KEY, 'reminder'), /只是想跟大家说一声（晚安、我走了）就别说/);
  h.cfg.homeGroups = ['456'];
  r = await remind({ note: '跟大家说晚安', at: '23:29' });
  assert.equal(r.status, 200, '家里的群可以');
  assert.doesNotMatch(h.buildWakePromptV2(KEY, 'reminder'), /只是想跟大家说一声/);
}));

await test('睡觉时间里到点：提示她要等起床才叫', () => fixture(async ({ h, remind }) => {
  h.cfg.socialV2.nightSleep = { enabled: true, from: '00:01', to: '00:00' };
  const r = await remind({ note: '明早叫大家起床', minutes: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.hint, /那时候你在睡觉/);
}));
await test('到点：不在聊就用 reminder 唤醒，提示里有【到点了】和那件事；投递后删掉；还没到点的写在【你记着的事】', () => fixture(async ({ h, remind, promptsText }) => {
  await remind({ note: '给大家看 2048 截图', minutes: 10 });
  const later = (await remind({ note: '晚点问阿红吃了没', minutes: 120 })).data.id;
  const now = Date.now();
  await h.reminderTickV2(now + 5 * 60000);
  assert.equal(promptsText().length, 0, '还没到点');
  await h.reminderTickV2(now + 11 * 60000);
  const texts = promptsText();
  assert.equal(texts.length, 1, '叫了一次');
  const p = texts[0];
  assert.match(p, /【到点了】[\s\S]*给大家看 2048 截图/);
  assert.match(p, /【你记着的事】[\s\S]*晚点问阿红吃了没/);
  assert.ok(p.includes(later), '带上 id 方便取消');
  assert.match(p, /你之前在这里说好要做的事到时间了/);
  assert.equal(h.getSocialV2State(KEY).lastWakeReason, 'reminder');
  assert.deepEqual(JSON.parse(JSON.stringify(h.socialV2.reminders.map((r) => r.note))), ['晚点问阿红吃了没'], '投递后到点的那条删掉');
  assert.equal(h.dueRemindersV2(KEY).length, 0);
}));

await test('到点：正在聊就插一句【到点了】，不另外唤醒', () => fixture(async ({ h, remind, promptsText, steers }) => {
  await remind({ note: '给大家看截图', minutes: 10 });
  await h.sendWakePromptV2(KEY, 'atMention');
  const sid = h.state.sessions[KEY];
  assert.ok(sid);
  h.v2TurnStartAt.set(sid, Date.now());
  const wakes = promptsText().length;
  await h.reminderTickV2(Date.now() + 11 * 60000);
  assert.equal(steers().length, 1);
  const t = steers()[0].content[0].text;
  assert.match(t, /【到点了】group:456[\s\S]*给大家看截图/);
  assert.ok(t.includes(h.getSocialV2State(KEY).agentToken));
  assert.equal(promptsText().length, wakes, '没另外唤醒');
  assert.equal(h.socialV2.reminders.length, 0);
}));

await test('到点时正忙（还没开始回合）：等闲下来再叫；别的唤醒提示里顺带给了也算', () => fixture(async ({ h, remind, promptsText, idle }) => {
  await remind({ note: '给大家看截图', minutes: 10 });
  const st = h.getSocialV2State(KEY);
  st.pendingWakeTimer = setTimeout(() => {}, 60000);
  const t0 = Date.now() + 11 * 60000;
  await h.reminderTickV2(t0);
  assert.equal(promptsText().length, 0, '忙着不叫');
  assert.equal(h.dueRemindersV2(KEY).length, 1, '记成到点了');
  idle();
  // 别的原因先叫醒了她：提示里带上【到点了】，投递后删掉
  await h.sendWakePromptV2(KEY, 'atMention');
  assert.match(promptsText().at(-1), /【到点了】[\s\S]*给大家看截图/);
  assert.equal(h.socialV2.reminders.length, 0);
  idle();
  await h.reminderTickV2(t0 + 60000);
  assert.equal(promptsText().length, 1, '已经给过了，不再叫');
}));

await test('夜里睡着不叫，主人叫醒的窗口照叫；醒了再叫，提示里写“那时候你在睡觉”', () => fixture(async ({ h, remind, promptsText, idle }) => {
  await remind({ note: '给大家看截图', minutes: 10 });
  const pv = h.getSocialV2State('private:42');
  pv.bootstrapSent = true;
  await remind({ note: '跟爸爸说晚安', minutes: 10 }, 'private:42', pv.agentToken);
  h.cfg.socialV2.nightSleep = { enabled: true, from: '00:01', to: '00:00' };
  h.nightOwnerAwakeUntil.set('private:42', Date.now() + 20 * 60000);
  const t0 = Date.now() + 11 * 60000;
  await h.reminderTickV2(t0);
  assert.equal(promptsText().length, 1, '只叫了主人叫醒的那个');
  assert.match(promptsText()[0], /跟爸爸说晚安/);
  assert.equal(h.socialV2.reminders.filter((r) => r.key === KEY && !r.firedAt).length, 1, '群里那件还没触发');
  // 早上醒了（到点后 40 分钟）
  h.cfg.socialV2.nightSleep = { enabled: false };
  idle('private:42');
  await h.reminderTickV2(t0 + 40 * 60000);
  assert.equal(promptsText().length, 2);
  assert.match(promptsText()[1], /给大家看截图/);
  assert.match(promptsText()[1], /那时候你在睡觉/);
}));

await test('到点后 12 小时还没叫到就算了；会话不在白名单了也删；叫 5 次都没送到也删', () => fixture(async ({ h, remind, idle }) => {
  await remind({ note: '很久以前的事', minutes: 10 });
  await h.reminderTickV2(Date.now() + 13 * 3600000);
  assert.equal(h.socialV2.reminders.length, 0);
  h.socialV2.reminders.push({ id: 'rx', key: 'group:999', note: '别的群', at: Date.now(), due: Date.now() - 1000 });
  await h.reminderTickV2();
  assert.equal(h.socialV2.reminders.length, 0, '不在白名单');
  await remind({ note: '送不到的', minutes: 10 });
  // DSH 一直不接：每次都没送到
  let t = Date.now() + 11 * 60000;
  const origSessionPrompt = h.api.sessions.prompt;
  h.api.sessions.prompt = async () => { throw new Error('dsh down'); };
  try {
    for (let i = 0; i < 6; i++) { idle(); await h.reminderTickV2(t); t += 61000; }
  } finally { h.api.sessions.prompt = origSessionPrompt; }
  assert.equal(h.socialV2.reminders.length, 0, '5 次以后算了');
}));

await test('存盘：重启后读回；没到点的只写在【你记着的事】', () => fixture(async ({ h, remind }) => {
  await remind({ note: '晚上接着答题', minutes: 60 });
  h.flushSocialV2State();
  const saved = JSON.parse(JSON.stringify(h.socialV2.reminders));
  h.socialV2.reminders = [];
  h.loadSocialV2State();
  assert.deepEqual(JSON.parse(JSON.stringify(h.socialV2.reminders)), saved);
  assert.equal(h.reminderPromptLineV2(KEY).includes('【到点了】'), false);
  assert.match(h.reminderPromptLineV2(KEY), /【你记着的事】[\s\S]*晚上接着答题/);
}));

await test('说了“吃完再回来接着拍”却没安排：发送结果里提示一句，每轮一次；记了提醒或托了去玩的就不提', () => fixture(async ({ h, remind, call }) => {
  const send = (messages) => call('/api/socialV2/send-message', { messages });
  let r = await send(['好呀']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.hint, undefined, '普通的话不提');
  r = await send(['玩到一半该去吃饭了', '我吃完再回来接着拍']);
  assert.match(r.data.hint ?? '', /吃完再回来接着拍[\s\S]*qq_remind_me[\s\S]*qq_go_play/);
  r = await send(['待会儿给你们看']);
  assert.equal(r.data.hint, undefined, '这一轮提过了');
  // 新的一轮：先记了提醒，再说就不提
  const sid = h.state.sessions?.[KEY] ?? 'sid-fixture';
  h.state.sessions = { ...(h.state.sessions ?? {}), [KEY]: sid };
  h.v2TurnStartAt.set(sid, Date.now() - 1000);
  await remind({ note: '吃完饭接着拍', minutes: 30 });
  r = await send(['我吃完再回来接着拍']);
  assert.equal(r.data.hint, undefined, '已经记了');
  // 再新一轮：托给了去玩的自己也不提
  h.v2TurnStartAt.set(sid, Date.now() + 5);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.getSocialV2State('play:main').playRequests = [{ from: KEY, note: '玩拍蛙蛙', at: Date.now(), done: false }];
  r = await send(['我待会儿发截图']);
  assert.equal(r.data.hint, undefined, '托了去玩的');
  // 关掉
  h.v2TurnStartAt.set(sid, Date.now() + 20);
  await new Promise((resolve) => setTimeout(resolve, 25));
  h.cfg.socialV2.promiseHint = { enabled: false };
  r = await send(['我待会儿发截图']);
  assert.equal(r.data.hint, undefined);
  // 不该当成答应的话
  assert.equal(h.promiseHintV2(KEY, ['昨天玩了一会儿合成西瓜', '下午看了个视频']), null);
  h.cfg.socialV2.promiseHint = {};
  h.v2TurnStartAt.set(sid, Date.now() + 30);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(h.promiseHintV2(KEY, ['昨天玩了一会儿合成西瓜', '歇一会儿就起来噢', '你待会记得吃饭', '你们吃完再说吧']), null, '劝别人的、随口的不算');
  assert.match(h.promiseHintV2(KEY, ['等我一会儿发给你']) ?? '', /qq_remind_me/);
}));

await test('聊天这边一轮里点聊天浏览器点到 afterCalls 下：插一句让她交给去玩的自己，每轮一次；play 那边不管', () => fixture(async ({ h, steers }) => {
  h.cfg.socialV2.chatBrowserHandoff = { afterCalls: 5 };
  const sid = 'sid-chat';
  for (let i = 0; i < 4; i++) await h.noteChatBrowserCallV2(KEY, sid, 'mcp__sandbox-browser-chat__browser_press_key');
  await h.noteChatBrowserCallV2(KEY, sid, 'mcp__snowluma__qq_send_message');
  assert.equal(steers().length, 0, '还没到');
  await h.noteChatBrowserCallV2(KEY, sid, 'mcp__sandbox-browser-chat__browser_take_screenshot');
  assert.equal(steers().length, 1);
  const t = steers()[0].content[0].text;
  assert.match(t, /【交给去玩的你】group:456[\s\S]*qq_go_play[\s\S]*minutes/);
  assert.ok(t.includes(h.getSocialV2State(KEY).agentToken));
  for (let i = 0; i < 10; i++) await h.noteChatBrowserCallV2(KEY, sid, 'mcp__sandbox-browser-chat__browser_click');
  assert.equal(steers().length, 1, '这一轮只提一次');
  h.chatBrowserCallCount.delete(sid); // 新的一轮
  for (let i = 0; i < 5; i++) await h.noteChatBrowserCallV2(KEY, sid, 'mcp__sandbox-browser-chat__browser_click');
  assert.equal(steers().length, 2);
  for (let i = 0; i < 20; i++) await h.noteChatBrowserCallV2('play:main', 'sid-play', 'mcp__sandbox-browser-chat__browser_click');
  assert.equal(steers().length, 2, 'play 不管');
  h.chatBrowserCallCount.delete(sid);
  h.cfg.socialV2.chatBrowserHandoff = { enabled: false };
  for (let i = 0; i < 20; i++) await h.noteChatBrowserCallV2(KEY, sid, 'mcp__sandbox-browser-chat__browser_click');
  assert.equal(steers().length, 2, '关掉了');
}));

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
