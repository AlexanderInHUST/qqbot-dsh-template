// qqbot_agent：分条发送中途一条发失败（2026-10-27 15:45 小群“网络连接异常”）：
// 以前失败那条后面的照发，返回的错误只写“失败 1/2 条”，她以为都没发出去又整段重发，
// 群里同一句出现两次、顺序还倒了。现在失败后面的不发，错误里写清哪几条已经发出去了。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 第 failAt 次 send_group_msg 返回失败，其余成功
function onebotFetch(failAt, sends) {
  return async (url, init = {}) => {
    let json = { status: 'ok', retcode: 0, data: { message_id: 9000 + sends.length } };
    if (String(url).endsWith('/send_group_msg')) {
      const body = JSON.parse(init.body ?? '{}');
      sends.push(body);
      if (sends.length === failAt) json = { status: 'failed', retcode: 1200, message: 'send group message failed: 网络连接异常!' };
    }
    return { ok: true, status: 200, json: async () => json };
  };
}

async function fixture(failAt, run) {
  const sends = [];
  const h = await bridgeHarness({ globals: { fetch: onebotFetch(failAt, sends) }, config: { socialV2: {
    wake: { preSleepWaitEnabled: false },
    send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${path}?key=${encodeURIComponent(key)}`, method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(JSON.stringify({ key, ...body }));
  });
  try {
    h.appendSocialV2Message(key, 'fixture-person', '在吗', '在吗', false, false, 'fixture-1', [], '789', []);
    await h.sendWakePromptV2(key, 'question');
    await run({ st, call, sends });
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const selfTexts = (st) => JSON.parse(JSON.stringify(st.recentMessages.filter((m) => m.isSelf).map((m) => m.text)));

test('中间一条发失败：后面的不再发，错误里写清哪条已经发出去了', () => fixture(2, async ({ st, call, sends }) => {
  const r = await call('/api/socialV2/send-message', { messages: ['真没想到诶', '那你那时候玩什么呀', '我猜是扫雷'] });
  assert.equal(r.status, 500);
  assert.equal(sends.length, 2, '失败那条后面的不该再发');
  assert.match(r.data.error, /^QQ 发送失败：OneBot send_group_msg 失败/);
  assert.match(r.data.error, /已经发出去 1 条：「真没想到诶」，别再发/);
  assert.match(r.data.error, /没发出去的 2 条：「那你那时候玩什么呀」「我猜是扫雷」/);
  assert.deepEqual(selfTexts(st), ['真没想到诶']);
}));

test('第一条就发失败：一条都不发，告诉她都没发出去', () => fixture(1, async ({ st, call, sends }) => {
  const r = await call('/api/socialV2/send-message', { messages: ['真没想到诶', '那你那时候玩什么呀'] });
  assert.equal(r.status, 500);
  assert.equal(sends.length, 1);
  assert.match(r.data.error, /这 2 条都没发出去/);
  assert.deepEqual(selfTexts(st), []);
}));

test('都发成功照旧', () => fixture(0, async ({ st, call, sends }) => {
  const r = await call('/api/socialV2/send-message', { messages: ['真没想到诶', '那你那时候玩什么呀'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(sends.length, 2);
  assert.deepEqual(selfTexts(st), ['真没想到诶', '那你那时候玩什么呀']);
}));
