// qqbot_agent：官方 DeepSeek 超时、连不上时换成备用模型（src/app/model-fallback.js），通了再换回来。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const bgRefresh = (u) => /^http:\/\/extras:8940\/(bili\/watched|life\?)/.test(String(u)); // 启动时拉看过的视频、今天的计划（第 7 步）
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = { kind: 'error', error: { message: 'DeepSeek Messages stream idle timeout', code: 'TIMEOUT' } };
const promptText = (p) => p.content.map((c) => String(c?.text ?? '')).join('\n');

async function fixture(run, { modelFallback = {}, probe = async () => ({ status: 401 }) } = {}) {
  const probes = [];
  const fetch = async (url) => { if (!bgRefresh(url)) probes.push(String(url)); return probe(String(url)); };
  const h = await bridgeHarness({ globals: { fetch }, config: {
    dsh: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    socialV2: { modelFallback: { minMinutes: 0, probeMinutes: 0, ...modelFallback } },
  } });
  const selected = [];
  h.api.sessions.selectModel = async (p) => { selected.push(p); return { result: { ok: true, value: { selected: p } } }; };
  h.setMode('reserved2');
  try { await run({ h, selected, probes }); } finally { await h.close(); }
}

await test('超时：换成 aiohub 的 DeepSeek、让她接着做一次；备用也出错就照常报错；官方通了换回来', () => fixture(async ({ h, selected, probes }) => {
  const key = 'group:456';
  h.getSocialV2State(key);
  await h.ensureChatModel('sid-1');
  assert.equal(selected.at(-1).provider, 'deepseek-official');
  const before = h.calls.prompts.length;
  assert.equal(h.fallbackTurnV2(key, timeout), true);
  for (let i = 0; i < 40 && h.calls.prompts.length < before + 1; i += 1) await sleep(25);
  assert.match(promptText(h.calls.prompts.at(-1)), /接着刚才的事继续做/);
  assert.doesNotMatch(promptText(h.calls.prompts.at(-1)), /aiohub|deepseek|模型/i);
  await h.ensureChatModel('sid-1');
  assert.deepEqual({ ...selected.at(-1) }, { sessionId: 'sid-1', provider: 'aiohub', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' });
  assert.equal(h.fallbackTurnV2(key, timeout), false, '接着做的那轮也出错：不再试');
  // 探测：官方回 401 也算通，换回来
  for (let i = 0; i < 80 && h.modelFallbackActiveV2(); i += 1) { h.scheduler.tick(); await sleep(25); } // 探测登记在定时里
  assert.equal(h.modelFallbackActiveV2(), null);
  assert.equal(probes[0], 'https://api.deepseek.com/models');
  await h.ensureChatModel('sid-1');
  assert.equal(selected.at(-1).provider, 'deepseek-official');
}, { modelFallback: { minMinutes: 0.01 } }));

await test('连不上的报错文字也算；别的错误、关掉、主模型不是官方的都不换', () => fixture(async ({ h }) => {
  const key = 'private:42';
  h.getSocialV2State(key);
  assert.equal(h.fallbackTurnV2(key, { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } }), false);
  assert.equal(h.fallbackTurnV2(key, { kind: 'error', error: { message: 'tool input is invalid JSON', code: 'MALFORMED_RESPONSE' } }), false);
  assert.equal(h.fallbackTurnV2(key, { kind: 'completed' }), false);
  assert.equal(h.modelFallbackActiveV2(), null);
  h.cfg.socialV2.modelFallback.enabled = false;
  assert.equal(h.fallbackTurnV2(key, timeout), false);
  h.cfg.socialV2.modelFallback.enabled = true;
  h.cfg.dsh.provider = 'aiohub';
  assert.equal(h.fallbackTurnV2(key, timeout), false);
  h.cfg.dsh.provider = 'deepseek-official';
  assert.equal(h.fallbackTurnV2(key, { kind: 'error', error: { message: 'fetch failed: ECONNRESET' } }), true);
  assert.ok(h.modelFallbackActiveV2());
}, { modelFallback: { minMinutes: 60 } }));

await test('官方还不通：留在备用上，过会儿再看', () => fixture(async ({ h, probes }) => {
  h.getSocialV2State('group:456');
  assert.equal(h.fallbackTurnV2('group:456', timeout), true);
  for (let i = 0; i < 80 && probes.length < 1; i += 1) { h.scheduler.tick(); await sleep(25); } // 探测登记在定时里
  await sleep(50);
  assert.ok(probes.length >= 1);
  assert.ok(h.modelFallbackActiveV2(), '探测失败不换回');
}, { probe: async () => { throw new Error('connect ETIMEDOUT'); } }));

await test('官方排队只发心跳：一步迟迟不出字就停掉这一轮，按连不上换备用；工具在跑不算；STREAM_CLOSED 也算', () => fixture(async ({ h }) => {
  const key = 'group:456';
  h.getSocialV2State(key);
  const stopped = [];
  h.api.stopSessionWork = async (sid) => { stopped.push(sid); };
  h.noteModelEventV2('sid-1', key, 'turn/start');
  h.noteModelEventV2('sid-1', key, 'step/start');
  h.noteModelEventV2('sid-1', key, 'assistant/chunk');
  h.noteModelEventV2('sid-1', key, 'tool/call'); // 工具在跑
  h.noteModelEventV2('sid-2', 'private:42', 'step/start');
  h.noteModelEventV2('sid-2', 'private:42', 'assistant/message');
  await sleep(80);
  h.checkStallsV2();
  assert.deepEqual(stopped, []);
  h.noteModelEventV2('sid-1', key, 'step/start');
  await sleep(80);
  h.checkStallsV2();
  h.checkStallsV2();
  for (let i = 0; i < 20 && !stopped.length; i += 1) await sleep(10);
  assert.deepEqual(stopped, ['sid-1'], '只停一次');
  assert.equal(h.modelFallbackActiveV2(), null, '停掉时还没换，等这一轮结束');
  assert.equal(h.fallbackTurnV2(key, { kind: 'aborted' }), true);
  assert.ok(h.modelFallbackActiveV2());
  assert.equal(h.fallbackTurnV2('private:42', { kind: 'aborted' }), false, '别的原因停掉的不算');
  assert.equal(h.isOutageErrorV2({ code: 'STREAM_CLOSED', message: 'DeepSeek Messages stream ended before message_stop' }), true);
}, { modelFallback: { stallSeconds: 0.05, minMinutes: 60 } }));

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
