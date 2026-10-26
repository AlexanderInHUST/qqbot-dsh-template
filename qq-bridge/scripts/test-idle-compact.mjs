// qqbot_agent：闲时压缩——byKey 单独定门槛；同一会话两次至少隔 minIntervalMinutes；RPC 不受默认 30 秒超时限制。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(idleCompact, run) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
    wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, idleCompact,
  } } });
  h.setMode('reserved2');
  const runs = [];
  h.api.callUnary = async (method, params, signal, policy) => {
    runs.push({ method, params, signal, policy });
    return { result: { ok: true, value: { result: { kind: 'success', text: 'ok' } } } };
  };
  const setTokens = (key, n) => {
    const sid = `sid-${key}`;
    h.state.sessions = { ...(h.state.sessions ?? {}), [key]: sid };
    h.sessionContextTokens.set(sid, n);
  };
  try { await run({ h, runs, setTokens }); } finally { await h.close(); }
}

test('byKey 单独定门槛：技术群 15 万才压，别的会话 10 万', () => fixture({ byKey: { 'group:789': { minContextTokens: 150000 } } }, async ({ h, runs, setTokens }) => {
  assert.equal(h.idleCompactCfgV2('group:789').minContextTokens, 150000);
  assert.equal(h.idleCompactCfgV2('group:456').minContextTokens, 100000);
  assert.equal(h.idleCompactCfgV2('group:789').idleMs, 120000, '没写的项用全局的');
  setTokens('group:789', 120000);
  await h.runIdleCompactV2('group:789');
  assert.equal(runs.length, 0, '不到 15 万');
  setTokens('group:456', 120000);
  await h.runIdleCompactV2('group:456');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].method, 'commands/execute');
  assert.equal(runs[0].params.line, '/compact');
  assert.equal(runs[0].policy, 'none', '不用默认的 30 秒超时');
  assert.ok(runs[0].signal instanceof AbortSignal, '按 maxRunMs 自己掐');
}));

test('同一会话两次至少隔 minIntervalMinutes（默认 60）；排的时候推到那时', () => fixture({}, async ({ h, runs, setTokens }) => {
  setTokens('group:456', 120000);
  await h.runIdleCompactV2('group:456');
  assert.equal(runs.length, 1);
  assert.ok(h.idleCompactLastAt.get('group:456') > 0);
  setTokens('group:456', 130000);
  await h.runIdleCompactV2('group:456');
  assert.equal(runs.length, 1, '刚压过不再压');
  // 排计时器：推到上次后 60 分钟
  h.scheduleIdleCompactV2('group:456');
  const timer = h.idleCompactTimers.get('group:456');
  assert.ok(timer);
  assert.ok(timer._idleTimeout > 50 * 60000, `推迟了：${timer._idleTimeout}`);
  // 别的会话不受影响
  setTokens('group:789', 120000);
  h.scheduleIdleCompactV2('group:789');
  assert.equal(h.idleCompactTimers.get('group:789')._idleTimeout, 120000);
  // 过了一小时可以再压
  h.idleCompactLastAt.set('group:456', Date.now() - 61 * 60000);
  await h.runIdleCompactV2('group:456');
  assert.equal(runs.length, 2);
}));

test('minIntervalMinutes: 0 关掉间隔；压缩失败不算压过', () => fixture({ minIntervalMinutes: 0 }, async ({ h, runs, setTokens }) => {
  setTokens('group:456', 120000);
  await h.runIdleCompactV2('group:456');
  setTokens('group:456', 120000);
  await h.runIdleCompactV2('group:456');
  assert.equal(runs.length, 2);
  h.cfg.socialV2.idleCompact = {};
  h.idleCompactLastAt.clear();
  h.api.callUnary = async () => ({ result: { ok: true, value: { result: { kind: 'error', text: 'boom' } } } });
  setTokens('group:456', 120000);
  await h.runIdleCompactV2('group:456');
  assert.equal(h.idleCompactLastAt.has('group:456'), false);
}));
