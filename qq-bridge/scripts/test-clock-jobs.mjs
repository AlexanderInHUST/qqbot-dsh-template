// qqbot_agent：到点做一次的事都在定时（src/scheduler.js）里，测试拨钟就能让它们到点（2026-11-08，架构调整第 4 步）：
// 潜水到期、限频重试、闲时压缩、换备用模型后的探测、自由时间检查。钟钉在下午两点，不会跨天。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceClock, pinClock } from './lib/test-clock.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

pinClock('14:00');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const promptText = (p) => p.content.map((c) => String(c?.text ?? '')).join('\n');
const MIN = 60000;

async function fixture(run, socialV2 = {}, globals = {}) {
  const h = await bridgeHarness({ globals, config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456'] }, socialV2: {
    wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, ...socialV2,
  } } });
  try { await run(h); } finally { await h.close(); }
}

test('测试钟：bridge 里的 Date 跟着拨', () => fixture(async (h) => {
  const d = new Date();
  assert.equal(d.getHours(), 14);
  const before = Date.now();
  advanceClock(90 * MIN);
  assert.ok(Date.now() - before >= 90 * MIN);
  assert.equal(new Date().getHours(), 15);
  // vm 里也一样（她看到的时间从这里算）
  assert.equal(h.whenV2(Date.now()).slice(-5), '15:30');
}));

test('潜水到期：拨过 sleepUntil 再 tick，叫醒她一次；没到不叫；再设一次换成新的时间', () => fixture(async (h) => {
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  st.wakeConfig.infinite = false;
  st.wakeConfig.sleepUntil = new Date(Date.now() + 40 * MIN).toISOString();
  h.setupSleepTimerV2(key);
  assert.ok(h.scheduler.has(`sleep:${key}`));
  advanceClock(20 * MIN);
  h.scheduler.tick();
  await sleep(30);
  assert.equal(h.calls.prompts.length, 0, '还没到');
  // 改成 60 分钟后：旧的 40 分钟不再叫
  st.wakeConfig.sleepUntil = new Date(Date.now() + 40 * MIN).toISOString();
  h.setupSleepTimerV2(key);
  advanceClock(25 * MIN);
  h.scheduler.tick();
  await sleep(30);
  assert.equal(h.calls.prompts.length, 0, '旧的时间作废了');
  advanceClock(16 * MIN);
  h.scheduler.tick();
  for (let i = 0; i < 40 && !h.calls.prompts.length; i += 1) await sleep(25);
  assert.equal(h.calls.prompts.length, 1);
  assert.match(promptText(h.calls.prompts[0]), /你设的潜水时间到了/);
  assert.equal(h.scheduler.has(`sleep:${key}`), false, '跑完就摘掉了');
  // 超过 2^31 毫秒（约 25 天）的也照样等着，不会马上到点
  st.wakeConfig.sleepUntil = new Date(Date.now() + 30 * 24 * 60 * MIN).toISOString();
  h.setupSleepTimerV2(key);
  h.scheduler.tick();
  assert.ok(h.scheduler.has(`sleep:${key}`));
  h.clearSocialV2Timers(key);
  assert.equal(h.scheduler.has(`sleep:${key}`), false, '清会话定时器时一起摘');
}));

test('限频重试：窗口腾出来以后补这一枪', () => fixture(async (h) => {
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  st.wakeTimes.push(Date.now());
  await h.sendWakePromptV2(key, 'timeout');
  assert.equal(h.calls.prompts.length, 0);
  assert.ok(h.scheduler.has(`rate-retry:${key}`));
  advanceClock(2 * MIN);
  h.scheduler.tick();
  for (let i = 0; i < 40 && !h.calls.prompts.length; i += 1) await sleep(25);
  assert.equal(h.calls.prompts.length, 1, '补发了');
}, { wake: { preSleepWaitEnabled: false, maxWakePerMinute: 1 } }));

test('闲时压缩：安静够了才压；她又聊起来就重新排', () => fixture(async (h) => {
  const key = 'group:456';
  const runs = [];
  h.api.callUnary = async (method, params) => { runs.push({ method, params }); return { result: { ok: true, value: { result: { kind: 'success', text: 'ok' } } } }; };
  h.state.sessions = { ...(h.state.sessions ?? {}), [key]: 'sid-456' };
  h.sessionContextTokens.set('sid-456', 120000);
  h.scheduleIdleCompactV2(key);
  advanceClock(1 * MIN);
  h.scheduler.tick();
  h.scheduleIdleCompactV2(key); // 一分钟后又一轮结束：从这时重新算两分钟
  advanceClock(1.5 * MIN);
  h.scheduler.tick();
  await sleep(30);
  assert.equal(runs.length, 0, '离上一轮还不到两分钟');
  advanceClock(1 * MIN);
  h.scheduler.tick();
  for (let i = 0; i < 40 && !runs.length; i += 1) await sleep(25);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].params.line, '/compact');
}));

test('换备用模型以后：到 minMinutes 才探测，不通就 probeMinutes 后再看，通了换回来', async () => {
  let up = false;
  const probes = [];
  const fetch = async (url) => { probes.push(String(url)); if (!up) throw new Error('connect ETIMEDOUT'); return { status: 401 }; };
  await fixture(async (h) => {
    h.api.sessions.selectModel = async (p) => ({ result: { ok: true, value: { selected: p } } });
    h.getSocialV2State('group:456');
    const timeout = { kind: 'error', error: { message: 'stream idle timeout', code: 'TIMEOUT' } };
    assert.equal(h.fallbackTurnV2('group:456', timeout), true);
    advanceClock(9 * MIN);
    h.scheduler.tick();
    await sleep(30);
    assert.equal(probes.length, 0, '十分钟内不看');
    advanceClock(1.5 * MIN);
    h.scheduler.tick();
    for (let i = 0; i < 40 && !probes.length; i += 1) await sleep(25);
    assert.equal(probes.length, 1);
    await sleep(30);
    assert.ok(h.modelFallbackActiveV2(), '不通留在备用上');
    up = true;
    advanceClock(5.5 * MIN);
    h.scheduler.tick();
    for (let i = 0; i < 40 && h.modelFallbackActiveV2(); i += 1) await sleep(25);
    assert.equal(probes.length, 2);
    assert.equal(h.modelFallbackActiveV2(), null, '通了换回来');
  }, { modelFallback: { minMinutes: 10, probeMinutes: 5 } }, { fetch });
});

test('自由时间检查：一个全局的 free-time-check，到了 proactiveNextAt 才检查；关掉模式就摘', () => fixture(async (h) => {
  h.scheduleProactiveCheckV2('group:456');
  h.scheduleProactiveCheckV2('private:42');
  const jobs = h.scheduler.status().filter((j) => j.name === 'free-time-check');
  assert.equal(jobs.length, 1, '几个会话共用一个');
  const next = h.socialV2.proactiveNextAt;
  assert.ok(next > Date.now());
  advanceClock(next - Date.now() - MIN);
  h.scheduler.tick();
  assert.equal(h.socialV2.proactiveNextAt, next, '没到不检查');
  advanceClock(2 * MIN);
  h.scheduler.tick();
  assert.ok(h.socialV2.proactiveNextAt > next, '检查过了，排了下一次');
  h.clearAllSocialV2Timers();
  assert.equal(h.scheduler.has('free-time-check'), false);
}, { proactive: { enabled: true, checkIntervalMinMs: 30 * MIN, checkIntervalMaxMs: 60 * MIN, probability: 0 } }));
