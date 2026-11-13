// qqbot_agent：做视频（qq_make_video，src/app/video.js），和画画分开。
// 2026-11-03：aiohub 的 grok 视频接口，建任务、轮询、下载 mp4，bridge 自己按 QQ 视频发出去，再告诉她。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]);
const PRIV = 'private:42';
const HOME = 'group:456';
const BIG = 'group:789';
const PLAY = 'play:main';
const VIDEO_URL = 'https://fixture.invalid/v1/videos';
const CDN = 'https://cdn.fixture.invalid/x.mp4';

// task(body) 返回建任务的 { status, json }；poll(n) 返回第 n 次查的 json
async function fixture(run, { socialV2 = {}, create = null, poll = null, env = { AIOHUB_API_KEY: 'fixture-key' }, files = {}, routes = {}, globals = {} } = {}) {
  const creates = [];
  const sent = [];
  let polls = 0;
  let msgId = 8000;
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    if (u === VIDEO_URL) {
      creates.push({ ...body, auth: init.headers?.authorization });
      const r = create ? await create(body) : { status: 200, json: { id: `task_${creates.length}`, status: 'queued' } };
      return { ok: r.status < 300, status: r.status, json: async () => r.json };
    }
    if (u.startsWith(`${VIDEO_URL}/`)) {
      polls++;
      const json = poll ? await poll(polls, u) : (polls % 2 ? { status: 'in_progress' } : { status: 'completed', metadata: { url: CDN } });
      return { ok: true, status: 200, json: async () => json };
    }
    if (routes[u]) return { ok: true, status: 200, json: async () => routes[u](body) };
    if (u === CDN) return { ok: true, status: 200, arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.length) };
    const action = u.split('/').pop();
    sent.push({ action, body, at: Date.now() });
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: ++msgId } }) };
  };
  const proc = { pid: process.pid, platform: process.platform, kill: process.kill, env, exit: (code) => { throw new Error('unexpected exit ' + code); } };
  const h = await bridgeHarness({ files, globals: { fetch, process: proc, ...globals }, config: {
    ownerQQ: '42', homeGroups: ['456'], allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
      wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, nightSleep: { enabled: false },
      replyOnlyGroups: [BIG],
      send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
      ...socialV2,
      video: { url: VIDEO_URL, minIntervalMs: 0, pollMs: 20, ...(socialV2.video ?? {}) },
    } } });
  h.setMode('reserved2');
  for (const k of [PRIV, HOME, BIG, PLAY]) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  let server = null;
  const video = async (key, body, tokenOf = key) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    const token = h.getSocialV2State(tokenOf).agentToken;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/video', method: 'POST',
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
  const entryOf = (id) => (h.socialV2.videoLog || []).find((e) => e.id === id);
  const settle = async (id) => {
    for (let i = 0; i < 400; i++) {
      const e = entryOf(id);
      if (e && e.ok !== null && e.ok !== undefined && !h.videoPromptLineV2(e.from).includes('还在做')) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return e;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${id} 一直没做完`);
  };
  const busy = (key) => {
    const sid = h.state.sessions[key];
    h.trackTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    h.v2TurnStartAt.set(sid, Date.now() - 1000);
  };
  const steersTo = (key) => h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode === 'steer')
    .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));
  const wakeText = async (key) => {
    for (let i = 0; i < 80; i++) {
      const hit = h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode !== 'steer')
        .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n')).find((t) => /【做视频】/.test(t));
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${key} 没被叫醒`);
  };
  try { await run({ h, video, settle, busy, steersTo, wakeText, creates, sent, entryOf }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('私聊里做：马上返回，做好了按视频发出去、配的话另发一条，记成 [视频:…]', () => fixture(async ({ h, video, settle, creates, sent }) => {
  const r = await video(PRIV, { prompt: '一只海豹在雪地里打滚', caption: '给你做的！' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.queued, true);
  assert.match(r.data.hint, /做好了会自己发到这里/);
  assert.doesNotMatch(r.data.hint, /今天还能做/, '默认不限');
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.equal(e.model, 'grok-imagine-video-1.5');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].auth, 'Bearer fixture-key');
  assert.equal(creates[0].seconds, '8');
  assert.equal(creates[0].size, '1280x720');
  assert.equal(creates[0].prompt, '一只海豹在雪地里打滚');
  const out = sent.filter((s) => s.action === 'send_private_msg');
  assert.equal(out.length, 2);
  assert.equal(out[0].body.message[0].type, 'video');
  assert.equal(Buffer.from(out[0].body.message[0].data.file.replace(/^base64:\/\//, ''), 'base64').equals(MP4), true);
  assert.deepEqual(out[1].body.message, [{ type: 'text', data: { text: '给你做的！' } }]);
  const mine = h.getSocialV2State(PRIV).recentMessages.filter((m) => m.isSelf);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, '[视频:一只海豹在雪地里打滚] 给你做的！');
  assert.equal(mine[0].messageId, e.messageId);
  const line = h.videoPromptLineV2(PRIV);
  assert.match(line, /【做视频】/);
  assert.match(line, /做好了，已经发到这里了/);
  assert.equal(h.calls.prompts.length, 0, '做好了不叫醒');
  h.markVideoShownV2(PRIV);
  assert.equal(h.videoPromptLineV2(PRIV), '');
  // 和画画分开记
  assert.equal((h.socialV2.drawLog || []).length, 0);
}));

await test('seconds 可以填 1~15，别的拒', () => fixture(async ({ video, settle, creates }) => {
  let r = await video(PRIV, { prompt: '下雨', seconds: 16 });
  assert.equal(r.status, 400);
  r = await video(PRIV, { prompt: '下雨', seconds: 0 });
  assert.equal(r.status, 400);
  r = await video(PRIV, { prompt: '下雨', seconds: 4 });
  assert.equal(r.status, 200);
  await settle(r.data.id);
  assert.equal(creates[0].seconds, '4');
}));

await test('大群（只回找她的群）也能做', () => fixture(async ({ video, settle, sent }) => {
  const r = await video(BIG, { prompt: '一只猫' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.equal(sent.filter((s) => s.action === 'send_group_msg' && s.body.group_id === 789 && s.body.message[0].type === 'video').length, 1);
}));

await test('两段开做至少隔 minIntervalMs（重启前开做的也算），做的过程可以重叠', () => fixture(async ({ h, video, settle, creates }) => {
  const r1 = await video(PRIV, { prompt: '一朵花' });
  const r2 = await video(HOME, { prompt: '两朵花' });
  const e1 = await settle(r1.data.id);
  const e2 = await settle(r2.data.id);
  assert.ok(e1.startedAt - h.socialV2.videoLog.find((x) => x.id === 'vprev').startedAt >= 300, '离重启前那段也隔够');
  assert.ok(e2.startedAt - e1.startedAt >= 300, `隔了 ${e2.startedAt - e1.startedAt}ms`);
  assert.equal(creates.length, 2);
}, { socialV2: { video: { minIntervalMs: 300 } }, files: { 'state/social-v2.json': {
  videoLog: [{ id: 'vprev', at: Date.now(), startedAt: Date.now(), key: HOME, from: HOME, prompt: '一只狗', ok: true }],
} } }));

await test('审核拒了 / 任务失败：没做成；不在聊叫她一次，在聊插一句【视频没做成】', () => fixture(async ({ h, video, settle, busy, steersTo, wakeText, sent }) => {
  const r = await video(PRIV, { prompt: '怪兽' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, false);
  assert.equal(e.refused, true);
  assert.equal(sent.filter((x) => /^send_/.test(x.action)).length, 0);
  const wake = await wakeText(PRIV);
  assert.match(wake, /没做成：这个内容做不了/);
  assert.doesNotMatch(wake.slice(wake.indexOf('【做视频】')), /grok|模型/);
  h.markVideoShownV2(PRIV);
  busy(PRIV);
  const r2 = await video(PRIV, { prompt: '再来个怪兽' });
  await settle(r2.data.id);
  const steers = steersTo(PRIV);
  assert.equal(steers.length, 1);
  assert.match(steers[0], /^【视频没做成】private:42/);
}, { poll: () => ({ status: 'failed', error: { message: 'content moderation rejected' } }) }));

await test('正在聊的时候做好了：插一句【视频做好了】', () => fixture(async ({ h, video, settle, busy, steersTo }) => {
  busy(HOME);
  const r = await video(HOME, { prompt: '小鱼骑车' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, true);
  const steers = steersTo(HOME);
  assert.equal(steers.length, 1);
  assert.match(steers[0], /^【视频做好了】group:456/);
  assert.equal(h.videoPromptLineV2(HOME), '');
}));

await test('排队上限、同一段不重复、空的、拿别的窗口令牌的、工具关了、没 key 都拒', async () => {
  await fixture(async ({ video }) => {
    assert.equal((await video(PRIV, { prompt: '' })).status, 400);
    assert.equal((await video(HOME, { prompt: '花' }, PRIV)).status, 403);
    assert.equal((await video(PRIV, { prompt: '花' })).status, 200);
    assert.equal((await video(PRIV, { prompt: '花' })).status, 409);
    assert.equal((await video(PRIV, { prompt: '草' })).status, 200);
    assert.equal((await video(PRIV, { prompt: '树' })).status, 429, 'maxPending 2');
  }, { socialV2: { video: { maxPending: 2 } }, poll: () => ({ status: 'in_progress' }) });
  await fixture(async ({ video }) => { assert.equal((await video(PRIV, { prompt: '花' })).status, 403); }, { socialV2: { tools: { video: false } } });
  await fixture(async ({ video }) => { assert.equal((await video(PRIV, { prompt: '花' })).status, 503); }, { env: {} });
});

await test('自由时间做给聊天：发到小群，记成 play 发的', () => fixture(async ({ h, video, settle, sent }) => {
  const r = await video(HOME, { prompt: '我刚玩的太空游戏' }, PLAY);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = await settle(r.data.id);
  assert.equal(e.ok, true);
  assert.equal(e.from, PLAY);
  assert.equal(sent.filter((s) => s.action === 'send_group_msg').length, 1);
  const mine = h.getSocialV2State(HOME).recentMessages.filter((m) => m.isSelf);
  assert.equal(mine[0].byPlay, true);
  assert.match(h.videoPromptLineV2(PLAY), /发到.*了/);
}));

await test('重启前没做完的：算没做成，记着告诉她', () => fixture(async ({ h }) => {
  const e = h.socialV2.videoLog.find((x) => x.id === 'vleft');
  assert.equal(e.ok, false);
  assert.match(h.videoPromptLineV2(PRIV), /没做成：做到一半被打断了/);
}, { files: { 'state/social-v2.json': {
  videoLog: [{ id: 'vleft', at: Date.now() - 60000, key: PRIV, from: PRIV, prompt: '一只兔子', ok: null }],
} } }));

await test('people：视频里的人照着头像和人物卡补上样子', () => fixture(async ({ video, settle, creates }) => {
  const r = await video(HOME, { prompt: '斯斯在弹吉他', people: ['55555'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.match(creates[0].prompt, /^斯斯在弹吉他\n\n画面里的人.*\n- 斯斯：平时：在练吉他；样子照着头像：戴耳机的小熊$/s);
  assert.equal((await video(PRIV, { prompt: '花', people: 'abc' })).status, 400);
}, {
  routes: {
    'http://extras:8940/people/cast': () => ({ ok: true, people: [{ subject: 'qq:55555', aliases: ['斯斯'], mine: '', card: '在做：在练吉他' }] }),
    'http://extras:8940/describe-avatar': () => ({ ok: true, text: '戴耳机的小熊' }),
  },
  globals: { safeFetchBuffer: async () => ({ buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') }) },
}));

if (failures) {
  console.error(`\n${failures} 个失败`);
  process.exit(1);
}
console.log('\n全部通过');
