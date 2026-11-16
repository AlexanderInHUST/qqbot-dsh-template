// qqbot_agent：她不在的那一段（桌面开关把她整个关了）、陪人打游戏打太久自己停下（src/app/away.js）。
// 2026-10-29：主人打游戏前用“鱼妹开关”把 WSL、Docker、她全关掉。回来以后她要知道自己刚才不在、为什么（照实说），
// 不在时别人发的消息从 OneBot 历史补进来；有人一直叫她玩游戏，玩满半小时自己停下歇会儿。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { pinClock } from './lib/test-clock.mjs';

// 不在的时间段按钟点写，钉在下午两点，免得 0 点前后跨天
pinClock('14:00');

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const PRIV = 'private:42';
const HOME = 'group:456';
const BIG = 'group:789';
const PLAY = 'play:main';
const MIN = 60000;
async function fixture(run, { files = {}, fetch = null, socialV2 = {} } = {}) {
  const h = await bridgeHarness({ files, ...(fetch ? { globals: { fetch } } : {}), config: {
    ownerQQ: '42', ownerTitles: { 42: '爸爸' }, homeGroups: ['456'], allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
      wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, nightSleep: { enabled: false },
      ...socialV2,
    } } });
  for (const k of [PRIV, HOME, BIG, PLAY]) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  let server = null;
  const call = async (route, key, body) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    const token = h.getSocialV2State(key).agentToken;
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
      req.setTimeout(8000, () => req.destroy(new Error('Fixture request timed out')));
      req.end(JSON.stringify({ key, ...body }));
    });
  };
  const say = (key, userId, text, isOwner) => {
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, `user-${userId}`, text, text, false, isOwner, `fixture-${key}-${st.lastUnreadSeq + 1}`, [], userId, []);
  };
  try { await run({ h, call, say }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
const offFor = (minutes, marker = true) => ({
  'state/social-v2.json': { version: 1, aliveAt: Date.now() - minutes * MIN, conversations: {} },
  ...(marker ? { 'state/away-reason.json': { why: 'game', at: Date.now() - minutes * MIN } } : {}),
});

await test('关了 40 分钟打游戏：照实说是爸爸要打游戏，大群里不叫爸爸，每个聊天只写一次【你刚回来】', () => fixture(async ({ h }) => {
  const a = h.socialV2.away;
  assert.ok(a, '要记下不在过');
  assert.equal(a.why, 'game');
  assert.ok(Math.abs(a.to - a.from - 40 * MIN) < 5000);
  const home = h.buildWakePromptV2(HOME, 'atMention');
  assert.match(home, /- 刚才：\d{4}-\d\d-\d\d \d\d:\d\d~\d\d:\d\d 你不在，爸爸要用电脑打游戏，把你关了一会儿/);
  assert.match(home, /【你刚回来】/);
  const big = h.buildWakePromptV2(BIG, 'atMention');
  assert.match(big, /家里要用电脑打游戏，把你关了一会儿/);
  assert.doesNotMatch(big, /爸爸/);
  assert.match(h.buildWakePromptV2(PLAY, 'proactiveCheck'), /爸爸要用电脑打游戏，把你连同这台电脑一起关了/);
  assert.doesNotMatch(h.buildWakePromptV2(PLAY, 'proactiveCheck'), /【你刚回来】/);
  // 投递了就记下，下次只剩【你现在】里那一行
  h.buildWakePromptV2(HOME, 'atMention');
  h.markAwayShownV2(HOME);
  const again = h.buildWakePromptV2(HOME, 'atMention');
  assert.doesNotMatch(again, /【你刚回来】/);
  assert.match(again, /- 刚才：.*你不在/);
  assert.match(h.buildWakePromptV2(PRIV, 'privateMessage'), /【你刚回来】/, '别的聊天还没写过');
  assert.equal(h.socialV2.away.why, 'game');
  assert.equal(h.readJsonSafe(`${h.temp}/state/away-reason.json`, null), null, '标记读过就删');
}, { files: offFor(40) }));

await test('没有开关留的标记：说电脑出了点状况，不编理由；不到 10 分钟不算不在', async () => {
  await fixture(async ({ h }) => {
    assert.equal(h.socialV2.away.why, 'unknown');
    assert.match(h.buildWakePromptV2(HOME, 'atMention'), /电脑那边出了点状况，你断开了一会儿（具体怎么回事你也不知道，别编理由）/);
  }, { files: offFor(30, false) });
  await fixture(async ({ h }) => {
    assert.equal(h.socialV2.away, null);
    assert.doesNotMatch(h.buildWakePromptV2(HOME, 'atMention'), /你不在|你刚回来/);
  }, { files: offFor(5) });
  // 很久以前留的标记（这次关掉之前）不算
  await fixture(async ({ h }) => {
    assert.equal(h.socialV2.away.why, 'unknown');
  }, { files: { ...offFor(20, false), 'state/away-reason.json': { why: 'game', at: Date.now() - 5 * 3600 * 1000 } } });
});

await test('补收不在时的消息：按原来的时间进来，她自己的、已经收过的不重复', async () => {
  const now = Math.floor(Date.now() / 1000);
  const hist = [
    { message_id: 1, message_seq: 1, time: now - 50 * 60, user_id: 77, sender: { nickname: 'a', card: 'a' }, message: [{ type: 'text', data: { text: '关之前的' } }], raw_message: '关之前的' },
    { message_id: 2, message_seq: 2, time: now - 20 * 60, user_id: 77, sender: { nickname: 'a', card: 'a' }, message: [{ type: 'text', data: { text: '鱼妹你在吗' } }], raw_message: '鱼妹你在吗' },
    { message_id: 3, message_seq: 3, time: now - 15 * 60, user_id: 999, sender: { nickname: '鱼妹' }, message: [{ type: 'text', data: { text: '我自己说的' } }], raw_message: '我自己说的' },
    { message_id: 4, message_seq: 4, time: now - 10 * 60, user_id: 78, sender: { nickname: 'b', card: 'b' }, message: [{ type: 'text', data: { text: '她好像不在' } }], raw_message: '她好像不在' },
  ];
  const asked = [];
  const fetch = async (url, init = {}) => {
    const action = String(url).split('/').pop();
    const body = JSON.parse(init.body ?? '{}');
    if (/_msg_history$/.test(action)) {
      asked.push([action, body]);
      const list = action === 'get_group_msg_history' && body.group_id === 456 && body.message_id == null ? hist : [];
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { messages: list } }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  await fixture(async ({ h }) => {
    h.setSelfIdentity('鱼妹', '999');
    const counts = await h.backfillAwayV2();
    assert.deepEqual(JSON.parse(JSON.stringify(counts)), { [HOME]: 2 });
    const got = h.getSocialV2State(HOME).recentMessages.filter((m) => !m.isSelf);
    assert.deepEqual([...got.map((m) => m.text.slice(-5))], ['鱼妹你在吗', '她好像不在']);
    assert.equal(got[0].time, (now - 20 * 60) * 1000, '记成原来的时间');
    assert.ok(asked.some(([a, b]) => a === 'get_friend_msg_history' && b.user_id === 42));
    assert.ok(asked.some(([a, b]) => a === 'get_group_msg_history' && b.group_id === 789));
    assert.equal(await h.backfillAwayV2(), null, '只补一次');
  }, { files: offFor(40), fetch });
});

await test('托她玩游戏玩满半小时：插话让她停下，一小时内再托玩游戏被拦，主人在家里又让玩就放行', () => fixture(async ({ h, call, say }) => {
  const play = h.getSocialV2State(PLAY);
  const t0 = Date.now() - 40 * MIN;
  play.lastWakeReason = 'goPlay';
  play.playRequests = [{ from: HOME, note: '去玩扫雷', at: t0, done: false }];
  play.freeTime = { startedAt: t0, reason: 'goPlay', minUntil: t0 + 30 * MIN, asked: [{ from: HOME, note: '去玩扫雷' }], items: [], seenUrls: [], currentPage: 'minesweeper.online/game/1', plays: {} };
  h.markConversationBusyV2?.(PLAY);
  for (let t = t0; t <= t0 + 25 * MIN; t += MIN) h.noteAwayGameV2(PLAY, 'mcp__sandbox-browser__browser_click', '', t);
  assert.equal(h.socialV2.gameRest, null, '25 分钟还不停');
  h.noteAwayGameV2(PLAY, 'mcp__sandbox-browser-chat__browser_click', '', t0 + 32 * MIN);
  assert.equal(h.socialV2.gameRest, null, '聊天的浏览器不算');
  for (let t = t0 + 26 * MIN; t <= t0 + 31 * MIN; t += MIN) h.noteAwayGameV2(PLAY, 'mcp__sandbox-browser__browser_click', '', t);
  const r = h.socialV2.gameRest;
  assert.ok(r, '满 30 分钟要停');
  assert.equal(play.freeTime.minUntil, 0);
  assert.equal(play.playRequests[0].done, true);
  assert.match(h.buildWakePromptV2(HOME, 'atMention'), /- 打游戏：.*刚陪人打了半小时游戏，眼睛有点累/);
  // 歇着的时候托她玩游戏被拦，托她看别的不拦
  const now = Date.now();
  r.at = now - MIN; r.until = now + 59 * MIN;
  const blocked = await call('/api/socialV2/go-play', BIG, { note: '再来一局扫雷' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /陪着打了半小时游戏了?，眼睛有点累/);
  const other = await call('/api/socialV2/go-play', BIG, { note: '去看看今天的新闻' });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  // 大群里主人说了也不放行；家里的群里主人又让玩就放行
  say(BIG, '42', '再玩一局嘛', true);
  assert.equal((await call('/api/socialV2/go-play', BIG, { note: '再玩一局扫雷' })).status, 403);
  say(HOME, '42', '没事再玩会儿', true);
  const ok = await call('/api/socialV2/go-play', HOME, { note: '再玩一局扫雷' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(h.socialV2.gameRest, null);
}));

await test('自己逛网页、没人托她玩游戏：不算陪人打游戏', () => fixture(async ({ h }) => {
  const play = h.getSocialV2State(PLAY);
  const t0 = Date.now() - 50 * MIN;
  play.lastWakeReason = 'proactiveCheck';
  play.freeTime = { startedAt: t0, reason: 'proactiveCheck', minUntil: 0, asked: [], items: [], seenUrls: [], currentPage: 'poki.com/zh/g/x', lastKind: 'game', plays: {} };
  for (let t = t0; t <= t0 + 45 * MIN; t += MIN) h.noteAwayGameV2(PLAY, 'mcp__sandbox-browser__browser_click', '', t);
  assert.equal(h.socialV2.gameRest, null);
}));

if (failures) { console.error(`${failures} 个测试失败`); process.exit(1); }
