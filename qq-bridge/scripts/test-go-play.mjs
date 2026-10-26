// qqbot_agent：聊天会话用 qq_go_play 托“去玩的自己”办事。主人刚在那个会话说过话的，play 那边标【主人托的】
// （只有这种才会用 B 站账号点赞、关注之类）；别人托的不标。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', socialV2: {
    wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const goPlay = (note, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/go-play?key=${encodeURIComponent(key)}`, method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ key, note, ...extra }));
  });
  const say = (userId, text, isOwner) => h.appendSocialV2Message(key, `user-${userId}`, text, text, false, isOwner,
    `fixture-${st.lastUnreadSeq + 1}`, [], userId, []);
  try { await run({ h, goPlay, say }); } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const playText = (h) => h.calls.prompts.filter((p) => String(p.sessionId ?? '').length).map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n')).join('\n');

test('主人刚说过话：托过去的事标【主人托的】', () => fixture(async ({ h, goPlay, say }) => {
  say('42', '鱼妹 帮我给这个视频点个赞', true);
  const r = await goPlay('阿明要我给 BV1xx 点赞');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const req = h.getSocialV2State('play:main').playRequests.at(-1);
  assert.equal(req.ownerAsked, true);
  assert.match(playText(h), /【有人托你】[\s\S]*【主人托的】：阿明要我给 BV1xx 点赞/);
  assert.equal(req.done, true, '投递成功后才标成已办');
}));

test('只有群友说过话：不标', () => fixture(async ({ h, goPlay, say }) => {
  say('7', '鱼妹 帮我点个赞', false);
  const r = await goPlay('群友要我点赞');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(h.getSocialV2State('play:main').playRequests.at(-1).ownerAsked, false);
  assert.doesNotMatch(playText(h), /【主人托的】/);
}));

// ── 说好多玩一会儿（minutes）──
test('minutes 夹在 [3, 60]，不填/0/乱写 = 办完就走', () => fixture(async ({ h }) => {
  assert.equal(h.goPlayMinutesV2(undefined), 0);
  assert.equal(h.goPlayMinutesV2(0), 0);
  assert.equal(h.goPlayMinutesV2('abc'), 0);
  assert.equal(h.goPlayMinutesV2(1), 3);
  assert.equal(h.goPlayMinutesV2(20), 20);
  assert.equal(h.goPlayMinutesV2(500), 60);
}));

test('托的时候填了 minutes：唤醒 play 后按说好的时间劝、上限往后推，提示里写“说好多玩一会儿”', () => fixture(async ({ h, goPlay, say }) => {
  say('7', '鱼妹 接着玩那个小游戏 玩到通关给我们看', false);
  const before = Date.now();
  const r = await goPlay('群友要我接着玩 2048，玩到好玩的地方截图', { minutes: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.hint, /多玩一会儿/);
  const play = h.getSocialV2State('play:main');
  assert.equal(play.playRequests.at(-1).minutes, 20);
  assert.equal(play.lastWakeReason, 'goPlay');
  const ft = play.freeTime;
  assert.ok(ft.minUntil >= before + 20 * 60000 - 1000 && ft.minUntil <= Date.now() + 20 * 60000, '劝到说好的时间');
  assert.ok(Math.abs(ft.curfewAt - (ft.minUntil + 15 * 60000)) < 1000, '收尾提醒在说好的时间后 15 分钟');
  assert.ok(h.freeTimeCurfewAtV2(ft) >= ft.curfewAt);
  assert.equal(ft.asked.at(-1).from, 'group:456');
  const text = playText(h);
  assert.match(text, /【去玩】/);
  assert.match(text, /说好了要多玩一会儿/);
  assert.match(text, /（说好多玩一会儿）/);
  // 还没到时间她想走：劝她接着玩托的那个
  assert.match(h.freeTimeNudgeTextV2(play), /说好了要多玩一会儿的：群友要我接着玩 2048/);
  // 到了时间插【可以歇了】，里面让她回托她的那个群说一声
  ft.minUntil = Date.now() - 1;
  await h.freeTimeCurfewV2();
  const steer = h.calls.prompts.filter((p) => p.mode === 'steer').at(-1);
  assert.ok(steer, '插了一句');
  const offer = steer.content[0].text;
  assert.match(offer, /【可以歇了】/);
  assert.match(offer, /group:456/);
}));

test('没填 minutes：照旧办完就走，不劝', () => fixture(async ({ h, goPlay }) => {
  const r = await goPlay('看一眼 BV1xx');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const play = h.getSocialV2State('play:main');
  assert.equal(play.freeTime.minUntil, 0);
  assert.equal(play.freeTime.asked, undefined);
  assert.doesNotMatch(playText(h), /说好了要多玩一会儿/);
}));

test('那边正在玩的时候托过去（steer）：在当前这次自由时间上延长', () => fixture(async ({ h, goPlay }) => {
  await h.sendWakePromptV2('play:main', 'proactiveCheck');
  const play = h.getSocialV2State('play:main');
  assert.ok(h.isConversationBusyV2('play:main', play), '正在玩');
  play.freeTime.minUntil = Date.now() + 60000;
  play.freeTime.restOfferSent = true;
  const r = await goPlay('接着玩那个游戏给大家看', { minutes: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const steer = h.calls.prompts.filter((p) => p.mode === 'steer').at(-1);
  assert.match(steer.content[0].text, /【有人托你】[\s\S]*说好了要多玩一会儿/);
  assert.equal(play.playRequests.at(-1).done, true);
  assert.ok(play.freeTime.minUntil > Date.now() + 29 * 60000, '延长了');
  assert.equal(play.freeTime.restOfferSent, false, '到时候再说一次可以歇了');
  assert.match(h.freeTimeNudgeTextV2(play), /说好了要多玩一会儿/);
}));
