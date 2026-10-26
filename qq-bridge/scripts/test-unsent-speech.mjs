// qqbot_agent：她把要说的话直接写成了文字（没调 qq_send_message）。文字不会发到 QQ，对方什么也没收到。
// 2026-10-26 08:59 大群：主人问她“看得懂谁的锅吗”，她写了一段回答就结束了，提醒收尾时又 mark_read 走了。
// 现在收尾（mark_read / set_wake_config）的结果、没收尾的【提醒】里都告诉她那段没发出去。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:456';
async function fixture(run) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456'] }, socialV2: {
    wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true;
  const sid = 'sid-unsent';
  h.state.sessions = { ...(h.state.sessions ?? {}), [KEY]: sid };
  let server = null;
  const call = async (route, body) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `${route}?key=${encodeURIComponent(KEY)}`, method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ key: KEY, ...body }));
    });
  };
  let turn = 0;
  // 开一轮，写一段字（还没结束）
  const write = (text) => {
    if (turn) h.trackTurnEvent(sid, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    turn += 1;
    h.trackTurnEvent(sid, { type: 'turn/start', data: { turn } });
    h.v2TurnStartAt.set(sid, Date.now() - 1000);
    h.sendToolSucceededSessions.delete(sid);
    h.trackTurnEvent(sid, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
  };
  try { await run({ h, st, sid, call, write }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('挑出像说给人听的话；她给自己写的旁白不算', () => fixture(async ({ h }) => {
  assert.match(h.unsentSpeechV2('看得懂呀，小A翻的那三把队友死太多了，锅真不在你身上\n\n不过你推塔伤害是0诶'), /^看得懂呀，小A翻的那三把/);
  assert.equal(h.unsentSpeechV2('诶……才不起呢，我都睡了 张三你也快去睡啦，很晚了噢'), '诶……才不起呢，我都睡了 张三你也快去睡啦，很晚了噢');
  assert.equal(h.unsentSpeechV2('（迷迷糊糊翻个身）……嗯，睡啦'), '……嗯，睡啦', '去掉括号里的动作');
  for (const t of [
    '', '  ', '（看完接着刷自己的）', '……',
    '他们聊的是 Dota 里的“小鱼”斯拉克，不是在叫我，所以我没插话。',
    '他们聊的现在是“小鱼人”，我还是没插话。',
    '还在聊小鱼人打牛头，我看完了，就当没听见，继续沉回去。',
    '这几条是他们俩在聊，不接。',
    '先 qq_mark_read 收尾。',
  ]) assert.equal(h.unsentSpeechV2(t), null, t);
  assert.ok(h.unsentSpeechV2('啊'.repeat(200)).length <= 61, '截短');
}));

await test('mark_read / set_wake_config：这一轮写了话却什么也没发，结果里带 hint；发过了、play、旁白都不带', () => fixture(async ({ h, st, sid, call, write }) => {
  write('看得懂呀，锅真不在你身上');
  let r = await call('/api/socialV2/mark-read', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.hint ?? '', /「看得懂呀，锅真不在你身上」[\s\S]*没用 qq_send_message 发出去/);
  r = await call('/api/socialV2/wake-config', { config: { mode: 'diving', infinite: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.hint ?? '', /没用 qq_send_message 发出去/);
  // 发过（发送工具的结果回来了）
  write('看得懂呀');
  h.sendToolSucceededSessions.add(sid);
  r = await call('/api/socialV2/mark-read', {});
  assert.equal(r.data.hint, undefined);
  // 发过（结果还没回来，但 lastAiReplyAt 在这一轮里）
  write('看得懂呀');
  st.lastAiReplyAt = Date.now();
  r = await call('/api/socialV2/mark-read', {});
  assert.equal(r.data.hint, undefined);
  st.lastAiReplyAt = 0;
  // 旁白
  write('不是在叫我，没插话');
  r = await call('/api/socialV2/mark-read', {});
  assert.equal(r.data.hint, undefined);
  // 没写字
  write('');
  r = await call('/api/socialV2/mark-read', {});
  assert.equal(r.data.hint, undefined);
  assert.equal(h.unsentTurnSpeechV2('play:main'), null, 'play 的字本来就不发');
}));

await test('没收尾的【提醒】：带了没发出去的话就写明，没有就是原来那句', () => fixture(async ({ h }) => {
  const withText = h.buildWakeReminderPromptV2(KEY, false, '看得懂呀');
  assert.match(withText, /^【提醒】group:456/);
  assert.match(withText, /「看得懂呀」[\s\S]*没用 qq_send_message 发出去[\s\S]*qq_mark_read 收尾/);
  assert.match(h.buildWakeReminderPromptV2(KEY, false), /这一轮还没收尾/);
  assert.doesNotMatch(h.buildWakeReminderPromptV2('play:main', false, '看得懂呀'), /没发出去/);
}));

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
