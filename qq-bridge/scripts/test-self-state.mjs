// qqbot_agent：【你现在】——几个聊天窗口和自由时间看到同一份状态（睡没睡、电脑上在玩什么、心情、身体感受）；
// 她用 qq_set_mood 定心情，用 qq_go_to_sleep 说去睡，所有地方一起睡（别的窗口和自由时间被插话收尾）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 相对现在的钟点 "HH:MM"
const clock = (minutesFromNow) => {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const promptText = (p) => p.content.map((c) => String(c?.text ?? '')).join('\n');

async function fixture(nightSleep, run, extra = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
    wake: { preSleepWaitEnabled: false, batchWindowMs: 300 }, proactive: { enabled: false, sessionMinutes: [60, 60] }, sticker: { enabled: false },
    wait: { minMs: 100 }, nightSleep, ...extra,
  } } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const post = (path, key, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': h.getSocialV2State(key).agentToken, 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ key, ...body }));
  });
  try { await run({ h, post }); } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const daytime = () => ({ enabled: true, from: clock(300), to: clock(-300) });
const nearBed = () => ({ enabled: true, from: clock(30), to: clock(-600) });

test('唤醒提示里有【你现在】：醒着、没在玩、还没写心情；不再单独给【作息】', () => fixture(daytime(), async ({ h }) => {
  const text = h.buildWakePromptV2('group:456', 'atMention');
  assert.match(text, /【你现在】[\s\S]*- 睡觉：醒着。/);
  assert.match(text, /- 心情：还没写/);
  assert.ok(!text.includes('【作息】'), text);
  const play = h.buildWakePromptV2('play:main', 'proactiveCheck');
  assert.match(play, /【你现在】/);
}));

test('qq_set_mood：别的窗口和自由时间都看到；私聊里定的原因大群看不到', () => fixture(daytime(), async ({ h, post }) => {
  h.cfg.socialV2.crossSession = { summaryOnlyKeys: ['group:789'] };
  const r = await post('/api/socialV2/mood', 'private:42', { mood: '开心', why: '爸爸夸我画得好' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 别处定的写上几点、在哪定的，自己这里定的不写
  assert.match(h.buildWakePromptV2('group:456', 'atMention'), /- 心情：开心（\d{4}-\d\d-\d\d \d\d:\d\d 在和[^\n]*私聊里：爸爸夸我画得好）/);
  assert.match(h.buildWakePromptV2('play:main', 'proactiveCheck'), /- 心情：开心（\d{4}-\d\d-\d\d \d\d:\d\d 在和[^\n]*私聊里：爸爸夸我画得好）/);
  assert.match(h.buildWakePromptV2('private:42', 'private'), /- 心情：开心（爸爸夸我画得好）/);
  const big = h.buildWakePromptV2('group:789', 'atMention');
  assert.match(big, /- 心情：开心，/);
  assert.ok(!big.includes('爸爸夸我'), '私聊里的原因不带到大群');
  const tooLong = await post('/api/socialV2/mood', 'group:456', { mood: '开'.repeat(30) });
  assert.equal(tooLong.status, 400);
  // 存进状态文件，重启后还在
  h.flushSocialV2State();
  h.socialV2.mood = null;
  h.loadSocialV2State();
  assert.equal(h.socialV2.mood?.text, '开心');
}));

test('【你现在】列出今天在电脑上玩过的（起床以后、去重、日记那份也算），别人问今天干了啥照这个说', () => fixture(daytime(), async ({ h }) => {
  const ago = (min) => Date.now() - min * 60000;
  h.socialV2.life.dayPlay = [{ at: ago(400), what: '看了《昨晚的东西》（a.com）' }, { at: ago(240), what: '看了 B 站视频《深海鱿鱼》' }];
  h.socialV2.playLog = [{ at: ago(240), what: '看了 B 站视频《深海鱿鱼》' }, { at: ago(100), what: '在 poki.com 玩《Subway Surfers》' }, { at: ago(60), what: '看了 B 站视频《深海鱿鱼》' }];
  const text = h.buildWakePromptV2('private:42', 'private');
  const line = /- 今天在电脑上[^\n]*/.exec(text)?.[0] || '';
  assert.ok(line.includes('这里没有的不是今天的事'), text);
  assert.ok(line.includes('看了 B 站视频《深海鱿鱼》') && line.includes('在 poki.com 玩《Subway Surfers》'), line);
  assert.ok(line.indexOf('深海鱿鱼') < line.indexOf('Subway'), '按时间排');
  assert.equal(line.split('深海鱿鱼').length, 2, '重复的只写一次');
  assert.ok(!line.includes('昨晚的东西'), '起床以前的不算今天');
  h.socialV2.life.dayPlay = [];
  h.socialV2.playLog = Array.from({ length: 20 }, (_, i) => ({ at: ago(200 - i), what: `看了《第${i}篇》（b.com）` }));
  const many = /- 今天在电脑上[^\n]*/.exec(h.buildWakePromptV2('group:456', 'atMention'))?.[0] || '';
  assert.ok(many.includes('更早还有 6 样') && many.includes('第19篇') && !many.includes('《第5篇》'), many);
  assert.ok(!many.includes('bilibili.com/video'), '没看视频不提链接');
  h.socialV2.playLog = [];
  assert.ok(!h.buildWakePromptV2('group:456', 'atMention').includes('今天在电脑上'));
}));

test('看过的 B 站视频带 BV 号，聊天那边要链接时手里有', () => fixture(daytime(), async ({ h }) => {
  await h.sendWakePromptV2('play:main', 'proactiveCheck');
  h.noteFreeTimeViewV2('play:main', 'mcp__qqbot-extras__bili_watch', JSON.stringify({ bvid: 'BV1ibpq6tE18', title: '会开门的狗', owner: 'x' }));
  assert.equal(h.socialV2.playLog.at(-1).what, '看了 B 站视频《会开门的狗》（BV1ibpq6tE18）');
  const line = /- 今天在电脑上[^\n]*/.exec(h.buildWakePromptV2('private:42', 'private'))?.[0] || '';
  assert.ok(line.includes('（BV1ibpq6tE18）') && line.includes('https://www.bilibili.com/video/'), line);
  assert.ok(h.crossSessionBlockV2('private:42').includes('BV1ibpq6tE18'), '【别处的事】里也带');
}));

test('自由时间记下的条目用网页标题，不带网址的查询串', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { sessionMinutes: [60, 60] } } } });
  try {
    h.setMode('reserved2');
    await h.sendWakePromptV2('play:main', 'proactiveCheck');
    const B = 'mcp__sandbox-browser__';
    h.noteFreeTimeViewV2('play:main', `${B}browser_navigate`, '- Page URL: https://www.guokr.com/article/1/\n- Page Title: 黄鼠狼偷童鞋 - 果壳\n');
    h.noteFreeTimeViewV2('play:main', `${B}browser_navigate`, '- Page URL: https://www.xiachufang.com/auth/humancheck?xcf_token=abc123\n');
    const whats = h.socialV2.playLog.map((x) => x.what);
    assert.deepEqual([...whats], ['看了《黄鼠狼偷童鞋 - 果壳》（www.guokr.com）', '看了 www.xiachufang.com/auth/humancheck']);
  } finally { await h.close(); }
});

test('qq_go_to_sleep：白天拒绝；快到睡觉时间可以，之后唤醒都挡掉，主人私聊照样叫醒', () => fixture(daytime(), async ({ h, post }) => {
  const day = await post('/api/socialV2/go-to-sleep', 'group:456', {});
  assert.equal(day.status, 403);
  assert.match(day.data.error, /还不到睡觉的时候/);
  assert.equal(h.isNightSleepV2(), false);
  h.cfg.socialV2.nightSleep = nearBed();
  const ok = await post('/api/socialV2/go-to-sleep', 'group:456', { note: '跟大家说了晚安' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(h.isNightSleepV2(), true, '说了去睡就算睡了');
  assert.equal(h.nightSleepBlocksV2('group:789', 'atMention'), true, '别的群 @ 她也不醒');
  assert.equal(h.nightSleepBlocksV2('play:main', 'proactiveCheck'), true, '也不去玩');
  assert.match(h.buildWakePromptV2('group:789', 'admin'), /- 睡觉：\d{4}-\d\d-\d\d \d\d:\d\d 在[^\n]*说了去睡，已经睡着了/);
  // 状态文件里记着，重启后还算睡着
  h.flushSocialV2State();
  h.socialV2.sleptAt = 0;
  h.loadSocialV2State();
  assert.equal(h.isNightSleepV2(), true);
  const before = h.calls.prompts.length;
  h.getSocialV2State('private:42').bootstrapSent = true; // 线上的会话都早就 bootstrap 过了
  await h.handleIncoming('private', '42', { self_id: 999, user_id: 42, message_id: 5, message: [{ type: 'text', data: { text: '还没睡吧' } }],
    raw_message: '还没睡吧', sender: { nickname: 'owner' } }, h.cfg);
  for (let i = 0; i < 80 && h.calls.prompts.length === before; i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(h.calls.prompts.length > before, '主人私聊叫醒她');
  assert.match(promptText(h.calls.prompts.at(-1)), /是主人在这里把你叫醒的/);
}));

test('qq_go_to_sleep：正在进行的别的窗口和自由时间被插话收尾', () => fixture(nearBed(), async ({ h, post }) => {
  await h.sendWakePromptV2('play:main', 'proactiveCheck');
  await h.sendWakePromptV2('group:789', 'atMention');
  assert.ok(h.isConversationBusyV2('play:main', h.getSocialV2State('play:main')));
  const r = await post('/api/socialV2/go-to-sleep', 'group:456', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 40 && h.calls.prompts.filter((p) => p.mode === 'steer').length < 2; i += 1) await new Promise((res) => setTimeout(res, 25));
  const steers = h.calls.prompts.filter((p) => p.mode === 'steer').map(promptText);
  assert.equal(steers.length, 2, JSON.stringify(steers));
  const playSteer = steers.find((t) => t.includes('qq_mark_read(key="play:main"'));
  assert.ok(playSteer?.includes('【你要去睡了】'), steers.join('\n---\n'));
  assert.ok(steers.some((t) => !t.includes('play:main') && t.includes('【你要去睡了】') && t.includes('qq_mark_read')));
  assert.equal(h.getSocialV2State('play:main').freeTime.curfewSent, true, '不再插【该睡觉了】');
  await h.freeTimeCurfewV2();
  assert.equal(h.calls.prompts.filter((p) => p.mode === 'steer').length, 2);
}));

test('到点睡觉：主人刚在聊的窗口先陪着，别的正在进行的窗口插话收尾', () => fixture(daytime(), async ({ h }) => {
  h.nightStartTickV2(); // 记下“醒着”
  const say = (key, userId, isOwner) => h.appendSocialV2Message(key, `user-${userId}`, '在吗', '在吗', false, isOwner,
    `fixture-${Math.random()}`, [], userId, []);
  say('group:456', '42', true);
  say('group:789', '7', false);
  await h.sendWakePromptV2('group:456', 'atMention');
  await h.sendWakePromptV2('group:789', 'atMention');
  h.cfg.socialV2.nightSleep = { enabled: true, from: clock(-5), to: clock(300) };
  h.nightStartTickV2();
  for (let i = 0; i < 40 && !h.calls.prompts.some((p) => p.mode === 'steer'); i += 1) await new Promise((res) => setTimeout(res, 25));
  const steers = h.calls.prompts.filter((p) => p.mode === 'steer');
  assert.equal(steers.length, 1, '只催没有主人的那个窗口');
  assert.ok(promptText(steers[0]).includes('【该睡觉了】'));
  assert.equal(h.nightSleepBlocksV2('group:456', 'anyMessage'), false, '主人在聊的窗口还醒着');
  assert.equal(h.nightSleepBlocksV2('group:789', 'atMention'), true);
}));

test('等待：状态变了在结果里给 yourStatusNow；别处说了去睡，等待提前返回', () => fixture(nearBed(), async ({ h, post }) => {
  h.buildWakePromptV2('group:789', 'atMention'); // 给过一次【你现在】
  const quiet = await post('/api/socialV2/wait', 'group:789', { timeoutMs: 200 });
  assert.equal(quiet.status, 200);
  assert.equal(quiet.data.yourStatusNow, undefined, '没变不给');
  await post('/api/socialV2/mood', 'group:456', { mood: '有点闷', why: '没人理我' });
  const changed = await post('/api/socialV2/wait', 'group:789', { timeoutMs: 200 });
  assert.match(changed.data.yourStatusNow, /- 心情：有点闷（(\d{4}-\d\d-\d\d \d\d:\d\d 在群 456 里：)?没人理我）/);
  const waiting = post('/api/socialV2/wait', 'group:789', { timeoutMs: 20000 });
  await new Promise((res) => setTimeout(res, 400));
  const t0 = Date.now();
  await post('/api/socialV2/go-to-sleep', 'group:456', {});
  const r = await waiting;
  assert.ok(Date.now() - t0 < 3000, '不用等到超时');
  assert.equal(r.data.earlyReturn, '你那边的作息变了，见 yourStatusNow');
  assert.match(r.data.yourStatusNow, /已经睡着了/);
  assert.equal(r.data.timeout, false);
}));

test('身体感受：玩久了眼睛酸；被主人夜里叫醒困得睁不开', () => fixture(daytime(), async ({ h }) => {
  await h.sendWakePromptV2('play:main', 'proactiveCheck');
  h.socialV2.playStartedAt = Date.now() - 50 * 60000;
  assert.match(h.buildWakePromptV2('group:456', 'atMention'), /- 身体：[^\n]*眼睛有点酸/);
  h.cfg.socialV2.nightSleep = { enabled: true, from: '00:01', to: '00:00' };
  h.nightOwnerAwakeUntil.set('private:42', Date.now() + 600000);
  const text = h.buildWakePromptV2('private:42', 'private');
  assert.match(text, /- 睡觉：本来已经睡了，是主人在这里把你叫醒的/);
  assert.match(text, /困得眼睛都睁不开/);
  assert.ok(text.includes('【现在是你的睡觉时间】'), '被叫醒的那段还在');
}));

test('【你现在】总在，旧的【作息】行不再出现（selfNow.enabled 开关已删）', () => fixture(daytime(), async ({ h }) => {
  h.cfg.socialV2.selfNow = { enabled: false };
  const text = h.buildWakePromptV2('group:456', 'atMention');
  assert.ok(text.includes('【你现在】') && !text.includes('【作息】'));
}));
