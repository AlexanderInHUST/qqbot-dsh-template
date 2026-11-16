// 收消息的连接卡住了就自己重连、太久没好私聊告诉主人（src/rx-watch.js，2026-11-15）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { markAlarmSent, newRxWatchState, rxWatchConfig, rxWatchStep } from '../src/rx-watch.js';
import { readBridgeSource } from './lib/bridge-source.mjs';

const MIN = 60_000;
const cfg = rxWatchConfig({});
const T0 = Date.parse('2026-11-15T09:06:25+08:00');

/** 每 30 秒走一步，返回 [从 T0 起第几分钟, 结果] 里有动作的那些。 */
function run(state, health, fromMin, toMin, onStep) {
  const acts = [];
  for (let t = T0 + fromMin * MIN; t <= T0 + toMin * MIN; t += 30_000) {
    const r = rxWatchStep(state, health, t, cfg);
    if (r.reconnect || r.alarm) acts.push([(t - T0) / MIN, r]);
    onStep?.(r, t);
  }
  return acts;
}

test('11-15 那样断了以后连不回来：3 分钟重连，之后翻倍，10 分钟私聊主人一次', () => {
  const state = newRxWatchState();
  const health = { connected: false, downSince: T0, lastPacketAt: T0 - 20_000, openedAt: T0 - 3600_000 };
  const acts = run(state, health, 0, 30, (r) => { if (r.alarm === 'stall') markAlarmSent(state); });
  const reconnects = acts.filter(([, r]) => r.reconnect).map(([m]) => m);
  assert.deepEqual(reconnects, [3, 4, 6, 10, 18, 28]);
  const alarms = acts.filter(([, r]) => r.alarm).map(([m, r]) => [m, r.alarm]);
  assert.deepEqual(alarms, [[10, 'stall']]);
  assert.equal(state.stalledSince, T0);
});

test('连上了但还没来事件包不算好；来了包才告诉主人好了，然后状态清空', () => {
  const state = newRxWatchState();
  const health = { connected: false, downSince: T0, lastPacketAt: T0 - 20_000, openedAt: 0 };
  run(state, health, 0, 12, (r) => { if (r.alarm === 'stall') markAlarmSent(state); });
  assert.equal(state.alarmed, true);
  Object.assign(health, { connected: true, openedAt: T0 + 12.2 * MIN });
  const pending = rxWatchStep(state, health, T0 + 12.5 * MIN, cfg);
  assert.equal(pending.alarm, null);
  assert.equal(state.stalledSince, T0, '还没好，从哪儿卡住的要留着');
  health.lastPacketAt = T0 + 12.6 * MIN;
  const ok = rxWatchStep(state, health, T0 + 13 * MIN, cfg);
  assert.equal(ok.alarm, 'recovered');
  assert.equal(ok.stalledSince, T0);
  assert.deepEqual(state, newRxWatchState());
});

test('没告诉过主人就好了的，不说“好了”', () => {
  const state = newRxWatchState();
  const health = { connected: false, downSince: T0, lastPacketAt: 0, openedAt: 0 };
  run(state, health, 0, 5);
  Object.assign(health, { connected: true, openedAt: T0 + 5 * MIN, lastPacketAt: T0 + 5.1 * MIN });
  const r = rxWatchStep(state, health, T0 + 5.5 * MIN, cfg);
  assert.equal(r.alarm, null);
  assert.equal(state.stalledSince, 0);
});

test('连着但一个事件包都没有（心跳也没了）也算卡住', () => {
  const state = newRxWatchState();
  const health = { connected: true, openedAt: T0 - 3600_000, lastPacketAt: T0 };
  const acts = run(state, health, 0, 3);
  assert.deepEqual(acts.map(([m, r]) => [m, r.reconnect]), [[3, true]]);
});

test('心跳一直在来：什么都不做', () => {
  const state = newRxWatchState();
  const health = { connected: true, openedAt: T0 - 3600_000, lastPacketAt: T0 };
  const acts = run(state, health, 0, 60, (_r, t) => { health.lastPacketAt = t; });
  assert.deepEqual(acts, []);
});

test('私聊没发出去（QQ 也掉了）10 分钟后再试；alarmAfterMs 0 不告警', () => {
  const state = newRxWatchState();
  const health = { connected: false, downSince: T0, lastPacketAt: 0, openedAt: 0 };
  const alarms = run(state, health, 0, 35).filter(([, r]) => r.alarm).map(([m]) => m);
  assert.deepEqual(alarms, [10, 20, 30]);
  const quiet = rxWatchConfig({ alarmAfterMs: 0, reconnectAfterMs: 5 * MIN });
  const s2 = newRxWatchState();
  for (let t = T0; t <= T0 + 60 * MIN; t += 30_000) assert.equal(rxWatchStep(s2, health, t, quiet).alarm, null);
  assert.equal(rxWatchConfig({ reconnectAfterMs: 1000 }).reconnectAfterMs, MIN, '最少 1 分钟');
});

test('bridge 每 30 秒查一次；告警只能私聊 ownerQQ、走 HTTP 消息段', () => {
  const src = readBridgeSource(fileURLToPath(new URL('..', import.meta.url)));
  assert.match(src, /scheduler\.every\('snowluma-rx', 30_000, checkReceiveLink/);
  assert.match(src, /origin === 'alarm' && \(!cfg\.ownerQQ \|\| key !== `private:\$\{cfg\.ownerQQ\}`\)/);
  assert.match(src, /qqOut\(key, \[\{ type: 'text', data: \{ text \} \}\], \{ origin: 'alarm' \}\)/);
  assert.match(src, /if \(snowlumaHealth\.connected\) snowlumaHealth\.downSince = Date\.now\(\)/);
});
