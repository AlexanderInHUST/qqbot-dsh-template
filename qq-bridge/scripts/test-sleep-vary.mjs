// qqbot_agent：每晚睡觉、起床的时间有点浮动（socialV2.nightSleep.vary，src/proactive-schedule.js 的 nightPlan）：
// 早睡晚睡、周末晚睡晚起、熬夜了第二天起得晚、醒了先赖会儿床（能看手机回消息，不上电脑玩、不主动找人）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { nightPlan, sleepVaryCfg, localDay, shiftDay } from '../src/proactive-schedule.js';

const clock = (minutesFromNow) => {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const hm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const NIGHT = { enabled: true, from: '23:30', to: '08:00' };
const VARY = { enabled: true };

// ── 纯函数 ──
test('nightPlan：没开 vary 返回 null；同一晚算几次都一样；30 晚里有早有晚，都在范围里', () => {
  assert.equal(nightPlan(NIGHT, '2026-10-20'), null);
  assert.equal(nightPlan({ ...NIGHT, vary: { enabled: 'yes' } }, '2026-10-20'), null);
  assert.equal(nightPlan({ ...NIGHT, enabled: false, vary: VARY }, '2026-10-20'), null);
  const cfg = { ...NIGHT, vary: VARY };
  assert.deepEqual(nightPlan(cfg, '2026-10-20'), nightPlan(cfg, '2026-10-20'));
  const beds = new Set();
  const wakes = new Set();
  let lazy = 0;
  let day = '2026-10-05';
  for (let i = 0; i < 30; i += 1, day = shiftDay(day, 1)) {
    const p = nightPlan(cfg, day);
    assert.equal(localDay(p.baseBedAt), day);
    assert.equal(hm(p.baseBedAt), '23:30');
    assert.equal(hm(p.baseWakeAt), '08:00');
    assert.equal(localDay(p.baseWakeAt), shiftDay(day, 1));
    const extraBed = p.weekend ? 30 : 0;
    const extraWake = p.weekend ? 40 : 0;
    assert.ok(p.bedOffset >= -40 + extraBed && p.bedOffset <= 40 + extraBed, `${day} 睡觉挪了 ${p.bedOffset}`);
    assert.ok(p.wakeOffset >= -20 + extraWake && p.wakeOffset <= 30 + extraWake, `${day} 起床挪了 ${p.wakeOffset}`);
    assert.equal(p.bedAt, p.baseBedAt + p.bedOffset * 60000);
    assert.equal(p.wakeAt, p.baseWakeAt + p.wakeOffset * 60000);
    assert.ok(p.lazyMin === 0 || (p.lazyMin >= 5 && p.lazyMin <= 30));
    assert.equal(p.lazyUntil, p.wakeAt + p.lazyMin * 60000);
    beds.add(p.bedOffset);
    wakes.add(p.wakeOffset);
    if (p.lazyMin) lazy += 1;
  }
  assert.ok(beds.size >= 10 && wakes.size >= 10, `睡觉时间要有变化：${[...beds]} / ${[...wakes]}`);
  assert.ok(lazy >= 4 && lazy <= 22, `赖床 ${lazy}/30 晚`);
});

test('nightPlan：周五周六晚上算周末；熬夜超过 20 分钟第二天多睡一半、最多 60 分钟', () => {
  const cfg = { ...NIGHT, vary: { enabled: true, bedMinutes: [0, 0], wakeMinutes: [0, 0] } };
  assert.equal(nightPlan(cfg, '2026-10-23').weekend, true, '周五晚上');
  assert.equal(nightPlan(cfg, '2026-10-24').weekend, true, '周六晚上');
  assert.equal(nightPlan(cfg, '2026-10-25').weekend, false, '周日晚上第二天要上班');
  assert.equal(hm(nightPlan(cfg, '2026-10-23').bedAt), '00:00');
  assert.equal(hm(nightPlan(cfg, '2026-10-23').wakeAt), '08:40');
  assert.equal(hm(nightPlan(cfg, '2026-10-22').bedAt), '23:30');
  const min = 60000;
  assert.equal(nightPlan(cfg, '2026-10-22', { late: 15 * min }).sleepInMin, 0, '晚一点不算熬夜');
  assert.equal(nightPlan(cfg, '2026-10-22', { late: 80 * min }).sleepInMin, 30);
  assert.equal(hm(nightPlan(cfg, '2026-10-22', { late: 80 * min }).wakeAt), '08:30');
  assert.equal(nightPlan(cfg, '2026-10-22', { late: 300 * min }).sleepInMin, 60, '最多多睡 60 分钟');
});

test('nightPlan：睡觉时间在中午前的算第二天凌晨；挪完不够 4 小时就不挪；sleepVaryCfg 不合法的用默认', () => {
  const p = nightPlan({ enabled: true, from: '00:30', to: '08:00', vary: { enabled: true, bedMinutes: [0, 0], wakeMinutes: [0, 0] } }, '2026-10-21');
  assert.equal(localDay(p.bedAt), '2026-10-22');
  assert.equal(hm(p.bedAt), '00:30');
  const short = nightPlan({ enabled: true, from: '23:30', to: '03:00', vary: { enabled: true, bedMinutes: [60, 60], wakeMinutes: [-60, -60] } }, '2026-10-21');
  assert.equal(short.bedOffset, 0);
  assert.equal(short.wakeOffset, 0);
  const c = sleepVaryCfg({ vary: { enabled: true, bedMinutes: [30, -10], wakeMinutes: 'x', lazyProbability: 5 } });
  assert.deepEqual(c.bedMinutes, [-10, 30]);
  assert.deepEqual(c.wakeMinutes, [-20, 30]);
  assert.equal(c.lazyProbability, 1);
});

// ── 在桥里 ──（范围设成固定值，测试里不靠运气）
const FIXED = { enabled: true, bedMinutes: [0, 0], wakeMinutes: [0, 0], weekendNights: [], lazyProbability: 0 };
async function fixture(nightSleep, run) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456'] }, socialV2: {
    wake: { preSleepWaitEnabled: false, batchWindowMs: 300 }, proactive: { enabled: false }, sticker: { enabled: false },
    wait: { minMs: 100 }, nightSleep,
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

test('今晚早睡：按挪过的时间睡；【你现在】写“今晚 HH:MM 左右睡（今天想早点睡）”；qq_go_to_sleep 按挪过的时间放行', () => fixture(
  { enabled: true, from: clock(150), to: clock(-600), vary: { ...FIXED, bedMinutes: [-60, -60] } }, async ({ h, post }) => {
    assert.equal(h.isNightSleepV2(), false);
    const s = h.sleepStateV2();
    assert.equal(s.kind, 'awake');
    assert.equal(s.bedClock, clock(90));
    assert.match(h.buildWakePromptV2('group:456', 'atMention'), new RegExp(`今晚 ${clock(90)} 左右睡（今天想早点睡）`));
    // 平常 150 分钟后才睡，不能提前 120 分钟以上说去睡；今晚早睡，90 分钟后睡，能说
    const r = await post('/api/socialV2/go-to-sleep', 'private:42', { note: '困了' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    assert.equal(r.data.sleepUntil, clock(-600 + 1440 - 1440));
    assert.equal(h.isNightSleepV2(), true);
  }));

test('还早的时候说去睡：拒绝里写今晚打算几点睡', () => fixture(
  { enabled: true, from: clock(300), to: clock(-600), vary: { ...FIXED, bedMinutes: [-60, -60] } }, async ({ post }) => {
    const r = await post('/api/socialV2/go-to-sleep', 'private:42', {});
    assert.equal(r.data.ok, false);
    assert.match(r.data.error, new RegExp(`今晚打算 ${clock(240)} 左右睡`));
  }));

test('熬夜：陪主人聊过了睡觉时间，起床时间往后挪；存盘重启后还在', () => fixture(
  { enabled: true, from: clock(-60), to: clock(300), vary: { ...FIXED, lateGraceMinutes: 20 } }, async ({ h }) => {
    assert.equal(h.isNightSleepV2(), true);
    assert.equal(h.sleepStateV2().wakeClock, clock(300));
    h.noteOwnerNightWakeV2('private:42'); // 睡觉时间过了 60 分钟还在陪主人聊 → (60-20)×0.5 = 多睡 20 分钟
    assert.equal(h.sleepStateV2().kind, 'woken');
    assert.equal(h.sleepStateV2().wakeClock, clock(320));
    assert.equal(h.wakeAfterV2(Date.now()), h.sleepStateV2().wakeAt);
    h.flushSocialV2State();
    const at = h.socialV2.upLateAt;
    h.socialV2.upLateAt = 0;
    h.loadSocialV2State();
    assert.equal(h.socialV2.upLateAt, at);
    // 提醒到点时还在睡：说等起床（挪过的时间）才叫
    assert.equal(h.asleepAtV2(Date.now() + 60 * 60000), true);
    assert.equal(h.asleepAtV2(Date.now() + 330 * 60000), false);
  }));

test('赖床：醒了先赖着——能回消息，【你现在】写还赖在床上，不上电脑玩；赖完了就是平常的刚起床', () => fixture(
  { enabled: true, from: clock(600), to: clock(-10), vary: { ...FIXED, lazyProbability: 1, lazyMinutes: [30, 30] } }, async ({ h }) => {
    assert.equal(h.isNightSleepV2(), false);
    assert.equal(h.lazyInBedV2(), true);
    assert.equal(h.nightSleepBlocksV2('private:42', 'private'), false, '能看手机回消息');
    const text = h.buildWakePromptV2('private:42', 'private');
    assert.match(text, /醒的，还赖在床上看手机，没起床/);
    assert.match(text, /醒了还赖在床上，不想起/);
    h.cfg.socialV2.nightSleep.vary.lazyMinutes = [5, 5];
    assert.equal(h.lazyInBedV2(), false);
    assert.match(h.buildWakePromptV2('private:42', 'private'), /起的床/);
  }));

test('没开 vary：跟原来一样按固定时间', () => fixture(
  { enabled: true, from: clock(150), to: clock(-600) }, async ({ h, post }) => {
    assert.equal(h.lazyInBedV2(), false);
    assert.equal(h.sleepDayV2(), null);
    assert.equal(h.sleepStateV2().bedClock, clock(150));
    const r = await post('/api/socialV2/go-to-sleep', 'private:42', {});
    assert.equal(r.data.ok, false);
    assert.match(r.data.error, /每天 .* 睡、.* 起/);
  }));
