// qqbot_agent：画画（qq_draw，src/app/draw.js）。
// 2026-10-28：以前画画是聊天浏览器里 canvas 拼几何图形再截图；现在用 aiohub 的图像模型画小孩的蜡笔画。
// 工具马上返回，画好了 bridge 自己发、存进 state/images、记进 recentMessages（qq_get_message_images 能再看），
// 再告诉她（正在聊就插话，不在就记着下次唤醒时说；没画成还叫她一次）。主模型不行就换备用模型，审核拒了不换。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage } from '../src/qq-model-view.js';

let failures = 0;
// 没画成又不在聊时叫她的那次唤醒的文字
async function wakeText(h, key) {
  for (let i = 0; i < 80; i++) {
    const texts = h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode !== 'steer')
      .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));
    const hit = texts.find((t) => /【画画】/.test(t));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${key} 没被叫醒`);
}
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PRIV = 'private:42';
const HOME = 'group:456';
const BIG = 'group:789';
const PLAY = 'play:main';
const DRAW_URL = 'https://fixture.invalid/v1/images/generations';

// image(model, body) 返回 { status, json } 或抛错；默认画成
// routes：别的地址（extras 的 /people/cast、/describe-avatar）按地址给假回复；globals 可以换掉 safeFetchBuffer 之类
async function fixture(run, { socialV2 = {}, image = null, env = { AIOHUB_API_KEY: 'fixture-key' }, files = {}, routes = {}, globals = {}, config = {} } = {}) {
  const imageCalls = [];
  const sent = [];
  let msgId = 7000;
  const fetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    if (String(url) === DRAW_URL) {
      imageCalls.push({ model: body.model, prompt: body.prompt, auth: init.headers?.authorization });
      const r = image ? await image(body.model, body) : { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
    }
    if (routes[String(url)]) return { ok: true, status: 200, json: async () => routes[String(url)](body) };
    const action = String(url).split('/').pop();
    sent.push({ action, body });
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: ++msgId } }) };
  };
  const proc = { pid: process.pid, platform: process.platform, kill: process.kill, env, exit: (code) => { throw new Error('unexpected exit ' + code); } };
  const h = await bridgeHarness({ files, globals: { fetch, process: proc, ...globals }, config: {
    ...config, ownerQQ: '42', homeGroups: ['456'], allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
      wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, nightSleep: { enabled: false },
      replyOnlyGroups: [BIG],
      send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
      ...socialV2,
      draw: { url: DRAW_URL, minIntervalMs: 0, ...(socialV2.draw ?? {}) },
    } } });
  for (const k of [PRIV, HOME, BIG, PLAY]) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  let server = null;
  const request = async (method, route, key, body, tokenOf = key) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    const token = h.getSocialV2State(tokenOf).agentToken;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('Fixture request timed out')));
      req.end(method === 'POST' ? JSON.stringify({ key, ...body }) : undefined);
    });
  };
  const draw = (key, body, tokenOf = key) => request('POST', '/api/socialV2/draw', key, body, tokenOf);
  const images = (key, messageId) => request('GET', `/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(messageId)}`, key);
  const entryOf = (id) => (h.socialV2.drawLog || []).find((e) => e.id === id);
  // 等这张画完（画好、发出去、告诉她都做完）
  const settle = async (id) => {
    for (let i = 0; i < 400; i++) {
      const e = entryOf(id);
      if (e && e.ok !== null && e.ok !== undefined && !h.drawPromptLineV2(e.from).includes('还在画')) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return e;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${id} 一直没画完`);
  };
  const busy = (key) => {
    const sid = h.state.sessions[key];
    h.trackTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    h.v2TurnStartAt.set(sid, Date.now() - 1000);
  };
  const steersTo = (key) => h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode === 'steer')
    .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));
  const imageDir = path.join(h.temp, 'state', 'images');
  try { await run({ h, draw, images, settle, busy, steersTo, imageCalls, sent, imageDir, entryOf }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
await test('私聊里画：马上返回，画好了发出去、存下来、记进 recentMessages，qq_get_message_images 能再看', () => fixture(async ({ h, draw, images, settle, imageCalls, sent, imageDir }) => {
  const r = await draw(PRIV, { prompt: '一只戴红帽子的海豹在雪地里堆雪人', caption: '给你画的！' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.queued, true);
  assert.match(r.data.hint, /画好了会自己发到这里/);
  assert.match(r.data.hint, /今天还能画 99 张/);
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.equal(e.model, 'gpt-image-2.5-flare-2026-09-08');
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0].auth, 'Bearer fixture-key');
  assert.match(imageCalls[0].prompt, /8-year-old girl/, '带上小孩画的风格');
  assert.match(imageCalls[0].prompt, /戴红帽子的海豹/, '她的描述接在后面');
  const out = sent.filter((s) => s.action === 'send_private_msg');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.message[0].type, 'image');
  assert.match(out[0].body.message[0].data.file, /^base64:\/\//);
  assert.deepEqual(out[0].body.message[1], { type: 'text', text: '给你画的！' });
  // 存下来了，权限 600
  assert.ok(e.file && /^draw-\d{8}-\d{6}-[0-9a-f]{6}\.png$/.test(e.file), e.file);
  const stat = fs.statSync(path.join(imageDir, e.file));
  assert.equal(stat.mode & 0o777, 0o600);
  // 她自己那条消息
  const mine = h.getSocialV2State(PRIV).recentMessages.filter((m) => m.isSelf);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /^\[画:一只戴红帽子的海豹在雪地里堆雪人\] 给你画的！$/);
  assert.equal(mine[0].messageId, e.messageId);
  assert.deepEqual(JSON.parse(JSON.stringify(mine[0].media)), [{ kind: 'image', local: e.file }]);
  // 给模型看的消息里不带文件名
  assert.equal(compactModelMessage(JSON.parse(JSON.stringify(mine[0]))).media[0].local, undefined);
  // 按 messageId 再看
  const look = await images(PRIV, e.messageId);
  assert.equal(look.status, 200, JSON.stringify(look.data));
  assert.equal(look.data.images.length, 1);
  assert.equal(Buffer.from(look.data.images[0].data, 'base64').equals(PNG), true);
  // 不在聊：记着，下次唤醒时交代一次（画好了不专门叫她）
  const line = h.drawPromptLineV2(PRIV);
  assert.match(line, /【画画】/);
  assert.match(line, /画好了，已经发到这里了/);
  assert.match(line, new RegExp(`qq_get_message_images\\(messageId="${e.messageId}"\\)`));
  assert.equal(h.calls.prompts.length, 0, '画好了不叫醒');
  h.markDrawShownV2(PRIV);
  assert.equal(h.drawPromptLineV2(PRIV), '');
}));

await test('画好了记进 extras 的作品集（/artworks），记上了标 artworkSaved；没记上的不标，下次重启补', async () => {
  const got = [];
  await fixture(async ({ draw, settle }) => {
    const r = await draw(HOME, { prompt: '一条小鱼在吹泡泡', caption: '送你们' });
    const e = await settle(r.data.id);
    for (let i = 0; i < 40 && !e.artworkSaved; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(e.artworkSaved, true);
    assert.equal(got.length, 1);
    assert.equal(got[0].kind, 'draw');
    assert.equal(got[0].file, e.file);
    assert.equal(got[0].prompt, '一条小鱼在吹泡泡');
    assert.equal(got[0].caption, '送你们');
    assert.equal(got[0].key, HOME);
    assert.equal(got[0].messageId, e.messageId);
  }, { routes: { 'http://extras:8940/artworks': (body) => { got.push(body); return { ok: true }; } } });
  await fixture(async ({ draw, settle }) => {
    const r = await draw(HOME, { prompt: '一条小鱼在吹泡泡' });
    const e = await settle(r.data.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(e.ok, true);
    assert.equal(e.artworkSaved, undefined);
  }, { routes: { 'http://extras:8940/artworks': () => ({ ok: false, error: 'down' }) } });
});

await test('还在画的时候唤醒提示里写着“还在画”，排在后面的带 ahead', () => fixture(async ({ h, draw, settle }) => {
  const r = await draw(HOME, { prompt: '小鱼和妈妈去公园' });
  assert.equal(r.status, 200);
  const r2 = await draw(HOME, { prompt: '小鱼和爸爸去公园' });
  assert.equal(r2.data.ahead, 1);
  assert.match(r2.data.hint, /前面还有 1 张在画/);
  const line = h.drawPromptLineV2(HOME);
  assert.match(line, /“小鱼和妈妈去公园”还在画，画好了会自己发到这里/);
  assert.match(line, /“小鱼和爸爸去公园”还在画/);
  await settle(r.data.id);
  await settle(r2.data.id);
  assert.doesNotMatch(h.drawPromptLineV2(HOME), /还在画/);
}, { image: async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } }; } }));

await test('主模型不行（429、超时、没了）就换备用模型', () => fixture(async ({ draw, settle, imageCalls }) => {
  const r = await draw(PRIV, { prompt: '一个笑脸太阳' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.equal(e.model, 'gpt-image-2');
  assert.deepEqual(imageCalls.map((c) => c.model), ['gpt-image-2.5-flare-2026-09-08', 'gpt-image-2']);
}, { image: async (model) => (model === 'gpt-image-2' ? { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } : { status: 429, json: { error: { message: 'rate limited' } } }) }));

await test('超时也换', () => fixture(async ({ draw, settle, imageCalls }) => {
  const r = await draw(PRIV, { prompt: '一只企鹅' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.deepEqual(imageCalls.map((c) => c.model), ['gpt-image-2.5-flare-2026-09-08', 'gpt-image-2']);
}, { image: async (model) => {
  if (model === 'gpt-image-2') return { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } };
  throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
} }));

await test('审核拒了不换模型；没画成：在聊插话，不在就记着并叫她一次', () => fixture(async ({ h, draw, settle, imageCalls, sent, busy, steersTo }) => {
  const r = await draw(PRIV, { prompt: '画个怪兽' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, false);
  assert.equal(e.refused, true);
  assert.equal(imageCalls.length, 1, '审核拒了不换');
  assert.equal(sent.filter((x) => /^send_/.test(x.action)).length, 0);
  // 不在聊：叫她一次，唤醒提示里有【画画】（交代过了就不再记）
  const wake = await wakeText(h, PRIV);
  assert.match(wake, /【画画】/);
  assert.match(wake, /没画成：这个内容画不了/);
  assert.match(wake, /跟他们照实说一声/);
  assert.doesNotMatch(wake.slice(wake.indexOf('【画画】')), /gpt|image|模型/);
  assert.equal(h.drawPromptLineV2(PRIV), '');
  h.markDrawShownV2(PRIV);
  // 正在聊：插一句【没画成】
  busy(PRIV);
  const r2 = await draw(PRIV, { prompt: '再画个怪兽' });
  await settle(r2.data.id);
  const steers = steersTo(PRIV);
  assert.equal(steers.length, 1);
  assert.match(steers[0], /^【没画成】private:42（令牌 [0-9a-f]+）/);
  assert.match(steers[0], /别说画好了/);
  assert.equal(h.drawPromptLineV2(PRIV), '', '插过话了就不再记');
}, { image: async () => ({ status: 400, json: { error: { message: 'Your request was rejected by the safety system' } } }) }));

await test('两个模型都不行：没画成，不算今天的张数', () => fixture(async ({ h, draw, settle, imageCalls }) => {
  const r = await draw(HOME, { prompt: '一棵树' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, false);
  assert.equal(imageCalls.length, 2);
  assert.match(await wakeText(h, HOME), /画笔出了点毛病/);
  const r2 = await draw(HOME, { prompt: '两棵树' });
  assert.match(r2.data.hint, /今天还能画 99 张/, '没画成的不算');
  await settle(r2.data.id);
}, { image: async () => ({ status: 503, json: { error: { message: 'model not found' } } }) }));

await test('正在聊的时候画好了：插一句【画好了】', () => fixture(async ({ h, draw, settle, busy, steersTo }) => {
  busy(HOME);
  const r = await draw(HOME, { prompt: '小鱼骑自行车' });
  const e = await settle(r.data.id);
  assert.equal(e.ok, true);
  const steers = steersTo(HOME);
  assert.equal(steers.length, 1);
  assert.match(steers[0], /^【画好了】group:456/);
  assert.match(steers[0], /qq_get_message_images/);
  assert.equal(h.drawPromptLineV2(HOME), '');
}));

await test('大群（只回找她的群）也能画', () => fixture(async ({ draw, settle, sent }) => {
  const r = await draw(BIG, { prompt: '一只猫' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = await settle(r.data.id);
  assert.equal(e.ok, true, e.error);
  assert.equal(sent.filter((s) => s.action === 'send_group_msg' && s.body.group_id === 789).length, 1);
}));

await test('一天最多 dailyLimit 张；排队有上限；同一张不重复排；空的、太长的、拿别的窗口令牌的都拒', () => fixture(async ({ h, draw, settle }) => {
  let r = await draw(PRIV, { prompt: '' });
  assert.equal(r.status, 400);
  r = await draw(PRIV, { prompt: '画'.repeat(301) });
  assert.equal(r.status, 400);
  r = await draw(HOME, { prompt: '一朵花' }, PRIV);
  assert.equal(r.status, 403, '拿私聊的令牌往小群画');
  r = await draw(PRIV, { prompt: '一朵花' });
  assert.equal(r.status, 200);
  const dup = await draw(PRIV, { prompt: '一朵花' });
  assert.equal(dup.status, 409);
  const r2 = await draw(PRIV, { prompt: '两朵花' });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.ahead, 1);
  const full = await draw(PRIV, { prompt: '三朵花' });
  assert.equal(full.status, 429, 'maxPending 2');
  await settle(r.data.id);
  await settle(r2.data.id);
  // 今天画了 2 张，dailyLimit 2
  const over = await draw(PRIV, { prompt: '四朵花' });
  assert.equal(over.status, 429);
  assert.match(over.data.error, /今天已经画了 2 张/);
  // 昨天的不算
  for (const e of h.socialV2.drawLog) e.at -= 86400000;
  const again = await draw(PRIV, { prompt: '五朵花' });
  assert.equal(again.status, 200);
  await settle(again.data.id);
}, { socialV2: { draw: { dailyLimit: 2, maxPending: 2 } }, image: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } }; } }));

await test('两张开画至少隔 minIntervalMs（重启前开画的也算）；排队默认最多 2 张', () => fixture(async ({ h, draw, settle, imageCalls }) => {
  const starts = [];
  const r = await draw(PRIV, { prompt: '一朵花' });
  const r2 = await draw(PRIV, { prompt: '两朵花' });
  assert.equal(r2.status, 200);
  const full = await draw(PRIV, { prompt: '三朵花' });
  assert.equal(full.status, 429, '默认最多排 2 张');
  const e1 = await settle(r.data.id);
  const e2 = await settle(r2.data.id);
  assert.ok(e1.startedAt - h.socialV2.drawLog.find((x) => x.id === 'dprev').startedAt >= 400, '离重启前那张也隔够');
  assert.ok(e2.startedAt - e1.startedAt >= 400, `隔了 ${e2.startedAt - e1.startedAt}ms`);
  assert.equal(imageCalls.length, 2);
  void starts;
}, { socialV2: { draw: { minIntervalMs: 400, maxPending: undefined } }, files: { 'state/social-v2.json': {
  drawLog: [{ id: 'dprev', at: Date.now(), startedAt: Date.now(), key: HOME, from: HOME, prompt: '一只狗', ok: true }],
} } }));

await test('没配 key 就画不了', () => fixture(async ({ draw }) => {
  const r = await draw(PRIV, { prompt: '一朵花' });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /画不了/);
}, { env: {} }));

await test('工具关了就 403', () => fixture(async ({ draw }) => {
  const r = await draw(PRIV, { prompt: '一朵花' });
  assert.equal(r.status, 403);
}, { socialV2: { tools: { draw: false } } }));

await test('自由时间画给聊天：发到小群，记成 play 发的，告诉 play 那边', () => fixture(async ({ h, draw, settle, sent }) => {
  const r = await draw(HOME, { prompt: '我刚玩的太空游戏' }, PLAY);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = await settle(r.data.id);
  assert.equal(e.ok, true);
  assert.equal(e.from, PLAY);
  assert.equal(sent.filter((s) => s.action === 'send_group_msg').length, 1);
  const mine = h.getSocialV2State(HOME).recentMessages.filter((m) => m.isSelf);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].byPlay, true);
  assert.match(h.drawPromptLineV2(PLAY), /发到.*了/);
  assert.equal(h.drawPromptLineV2(HOME), '');
}));

await test('这一轮调了 qq_draw，“等我画一下”“画好给你们看”不再提示托给去玩的自己', () => fixture(async ({ h, draw, settle, busy }) => {
  busy(HOME);
  const r = await draw(HOME, { prompt: '一只海豹' });
  await settle(r.data.id);
  assert.equal(h.promiseHintV2(HOME, ['我这就去画，画好给你们看']), null);
}, { socialV2: { proactive: { enabled: true } } }));

await test('重启前没画完的：算没画成，记着告诉她；记着的话重启后还在', () => fixture(async ({ h }) => {
  const e = h.socialV2.drawLog.find((x) => x.id === 'dleft');
  assert.ok(e);
  assert.equal(e.ok, false);
  assert.match(h.drawPromptLineV2(PRIV), /没画成：画到一半被打断了/);
  assert.match(h.drawPromptLineV2(HOME), /“一只狗”画好了/, '上次存下的 drawNotes 读回来了');
}, { files: { 'state/social-v2.json': {
  drawLog: [
    { id: 'dleft', at: Date.now() - 60000, key: PRIV, from: PRIV, prompt: '一只兔子', ok: null },
    { id: 'ddone', at: Date.now() - 60000, key: HOME, from: HOME, prompt: '一只狗', ok: true, messageId: '55' },
  ],
  drawNotes: [{ id: 'ddone', to: HOME, at: Date.now() - 30000 }],
} } }));

await test('截图、画都能存能读；读不到别的路径；过期的截图清掉，画和视频一直留着', () => fixture(async ({ h, imageDir }) => {
  const a = h.saveOwnImageV2('shot', PNG);
  assert.match(a, /^shot-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.equal(h.readOwnImageV2(a).equals(PNG), true);
  assert.equal(h.readOwnImageV2('../config.json'), null);
  assert.equal(h.readOwnImageV2('shot-20261028-000000-abcdef.png'), null, '没有的文件');
  assert.equal(h.saveOwnImageV2('shot', Buffer.from('not an image at all')), null);
  // 截图的消息带上 local 以后，按 messageId 也能读（和画一样走 media.local）
  const old = h.saveOwnImageV2('shot', PNG);
  const oldDraw = h.saveOwnImageV2('draw', PNG);
  const oldVideo = h.saveOwnImageV2('video', PNG);
  const t = (Date.now() - 400 * 86400000) / 1000;
  for (const f of [old, oldDraw, oldVideo]) fs.utimesSync(path.join(imageDir, f), t, t);
  assert.equal(h.cleanOwnImagesV2(), 1);
  assert.equal(fs.existsSync(path.join(imageDir, old)), false);
  assert.equal(fs.existsSync(path.join(imageDir, a)), true);
  assert.equal(fs.existsSync(path.join(imageDir, oldDraw)), true, '画不清');
  assert.equal(fs.existsSync(path.join(imageDir, oldVideo)), true, '视频帧图不清');
}));

await test('画群里的人：people 填 QQ 号，照着头像和这个群能看的人物卡补上样子；大群里主人不写爸爸；头像描述缓存', async () => {
  const castCalls = [];
  const avatarCalls = [];
  const fetched = [];
  const routes = {
    'http://extras:8940/people/cast': (body) => {
      castCalls.push(body);
      return { ok: true, people: [
        { subject: 'qq:10042', aliases: ['阿明'], mine: '', card: '了解：爱打 CS\n相处：老逗我', owner: true },
        { subject: 'qq:55555', aliases: ['斯斯'], mine: '说话冲但人不坏', card: '在做：在练吉他', owner: false },
      ] };
    },
    'http://extras:8940/describe-avatar': (body) => { avatarCalls.push(body); return { ok: true, text: body.data === Buffer.from(PNG).toString('base64') ? '一只橘猫戴墨镜' : '?' }; },
  };
  const globals = { safeFetchBuffer: async (url) => { fetched.push(url); return { buffer: PNG }; } };
  await fixture(async ({ h, draw, settle, imageCalls }) => {
    h.getSocialV2State(BIG).recentMessages.push({ seq: 1, userId: '55555', sender: '斯斯今天不睡', text: '画画我们', at: Date.now() });
    let r = await draw(BIG, { prompt: '阿明和斯斯在网吧打游戏', people: ['10042', 'qq:55555'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const e = await settle(r.data.id);
    assert.equal(e.ok, true, e.error);
    assert.deepEqual([...e.people], ['10042', '55555']);
    assert.deepEqual([...e.cast], ['阿明', '斯斯今天不睡'], '有群名片用群名片');
    assert.deepEqual(castCalls[0], { subjects: ['qq:10042', 'qq:55555'], key: BIG }, '只要这个群能看的那份卡');
    const prompt = imageCalls[0].prompt;
    assert.match(prompt, /阿明和斯斯在网吧打游戏\n\n画面里的人/);
    assert.match(prompt, /- 阿明：平时：爱打 CS；样子照着头像：一只橘猫戴墨镜/);
    assert.doesNotMatch(prompt, /爸爸|老逗我/, '大群不写爸爸；相处那栏不进画');
    assert.match(prompt, /- 斯斯今天不睡：平时：说话冲但人不坏；在练吉他/);
    assert.match(prompt, /不丑化/);
    assert.equal(avatarCalls.length, 2);
    assert.equal(avatarCalls[0].who, 'other');
    assert.equal(h.socialV2.avatarDescs['10042'].desc, '一只橘猫戴墨镜');
    // 再画：头像描述用缓存的，不再看
    r = await draw(HOME, { prompt: '阿明在家里', people: ['10042'] });
    await settle(r.data.id);
    assert.equal(avatarCalls.length, 2);
    assert.equal(fetched.length, 2);
    assert.match(imageCalls[1].prompt, /- 阿明：是我爸爸；/, '家里的群照叫爸爸');
    // 填的不是 QQ 号、太多：拒
    assert.equal((await draw(PRIV, { prompt: '花', people: ['阿明'] })).status, 400);
    assert.equal((await draw(PRIV, { prompt: '花', people: ['11111', '22222', '33333', '44444', '55555'] })).status, 400);
  }, { routes, globals, config: { extraOwnerQQ: ['10042'], ownerTitles: { 10042: '爸爸' } } });
});

if (failures) {
  console.error(`\n${failures} 个失败`);
  process.exit(1);
}
console.log('\n全部通过');
