// qqbot_agent: qq_wait_for_messages returns early when someone addresses her, and caps how long
// a busy group can stretch the quiet window. Real bridge handlers, fixture peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture(run, wait = {}, wake = {}, key = 'group:456') {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { ...wake },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100, ...wait },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/wait?key=${encodeURIComponent(key)}`, method: 'POST',
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
  const append = (text, quoteSelf = false) => h.appendSocialV2Message(key, 'fixture-person', text, text, quoteSelf, false,
    `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  try {
    append('before the wake');
    await h.sendWakePromptV2(key, key.startsWith('private:') ? 'private' : 'atMention');
    await run({ st, request, append });
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// 群里的普通等待走回复门控（test-reply-gate 管）；下面两条“安静多久才返回”的老规矩现在只在私聊用。
// Keeps the group talking every `every` ms until `until` ms have passed.
async function chatter(append, every, until, text = 'someone else talking') {
  const end = Date.now() + until;
  while (Date.now() < end) { await sleep(every); append(text); }
}

test('a quote of her ends the wait after addressedQuietMs, not the full quiet window', () => fixture(async ({ request, append }) => {
  const started = Date.now();
  const pending = request({ timeoutMs: 3000, quietMs: 3000 });
  await sleep(150);
  append('replying to you', true);
  const result = await pending;
  const took = Date.now() - started;
  assert.equal(result.status, 200);
  assert.equal(result.data.arrived, true);
  assert.ok(took < 1200, `addressed wait took ${took}ms`);
  assert.match(result.data.earlyReturn, /叫你/);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.newMessages.at(-1).plain, 'replying to you');
}, { addressedQuietMs: 300 }));

test('an @ of her (atSelf flag) also ends the wait early', () => fixture(async ({ st, request, append }) => {
  const started = Date.now();
  const pending = request({ timeoutMs: 3000, quietMs: 3000 });
  await sleep(150);
  append('@她的群名片 hello');
  st.recentMessages.at(-1).atSelf = true;
  const result = await pending;
  assert.ok(Date.now() - started < 1200, `@ wait took ${Date.now() - started}ms`);
  assert.match(result.data.earlyReturn, /叫你/);
}, { addressedQuietMs: 300 }));

test('a nickname alias (socialV2.wake.selfAliases) counts as calling her', () => fixture(async ({ request, append }) => {
  const started = Date.now();
  const pending = request({ timeoutMs: 3000, quietMs: 3000 });
  await sleep(150);
  append('小鱼你在吗');
  const result = await pending;
  assert.ok(Date.now() - started < 1200, `alias wait took ${Date.now() - started}ms`);
  assert.match(result.data.earlyReturn, /叫你/);
}, { addressedQuietMs: 300 }, { selfAliases: ['小鱼'] }));

test('private: chatter keeps waiting, then maxExtendAfterNewMs cuts it off', () => fixture(async ({ request, append }) => {
  const started = Date.now();
  const pending = request({ timeoutMs: 3000, quietMs: 3000 });
  const talk = chatter(append, 150, 2500);
  const result = await pending;
  const took = Date.now() - started;
  await talk;
  assert.ok(took >= 700 && took < 1500, `capped wait took ${took}ms`);
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, false);
  assert.match(result.data.earlyReturn, /一直有人说话/);
  assert.equal(result.data.timeout, false);
}, { addressedQuietMs: 300, maxExtendAfterNewMs: 700 }, {}, 'private:123'));

test('private: with both options off, wait for quiet after the last message', () => fixture(async ({ request, append }) => {
  const started = Date.now();
  const pending = request({ timeoutMs: 3000, quietMs: 500 });
  await sleep(100);
  append('replying to you', true);
  const talk = chatter(append, 150, 900);
  const result = await pending;
  await talk;
  assert.ok(Date.now() - started >= 1400, `uncapped wait returned after ${Date.now() - started}ms`);
  assert.equal(result.data.quiet, true);
  assert.equal('earlyReturn' in result.data, false);
}, {}, {}, 'private:123'));

test('reply waits also end early when she is addressed', () => fixture(async ({ request, append }) => {
  append('quoted her', true);
  const started = Date.now();
  const result = await request({ purpose: 'reply', timeoutMs: 3000, quietMs: 2500 });
  assert.ok(Date.now() - started < 1000, `reply wait took ${Date.now() - started}ms`);
  assert.equal(result.data.quiet, false);
  assert.equal(result.data.timeout, false);
  assert.match(result.data.earlyReturn, /叫你/);
}, { addressedQuietMs: 300 }));
