// qqbot_agent：两处让大群里一句话“延后很久才回、顺序乱掉”的问题（2026-10-22）：
//   1. 繁忙期间暂存的 @ 唤醒，回合末只要 unread 里有任何更新的消息就会补发，哪怕那条 @ 早就在等待里回过了；
//   2. 自由时间那边的她（play 令牌）发进群里的话，聊天会话的等待和快照都看不到；
//      沙雕图以前是 extras 直接调 OneBot 发的，现在也由 bridge 发（qq_send_meme）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture(run, { wakeFirst = true, globals = {} } = {}) {
  const h = await bridgeHarness({ globals, config: { socialV2: {
    wake: { preSleepWaitEnabled: false },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const play = h.getSocialV2State('play:main');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = (path, token, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${path}?key=${encodeURIComponent(key)}`, method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(JSON.stringify({ key, ...body }));
  });
  const append = (text) => h.appendSocialV2Message(key, 'fixture-person', text, text, false, false,
    `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  try {
    append('before the wake');
    if (wakeFirst) await h.sendWakePromptV2(key, 'question');
    await run({ h, st, play, call, append });
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('已经在等待里展示过的 @ 不再补发，哪怕后面又来了新消息', () => fixture(async ({ h, st, call, append }) => {
  append('鱼妹 你看完没');
  const atSeq = st.lastUnreadSeq;
  st.pendingWakeReasons = [{ reason: 'atMention', seq: atSeq }];
  const waited = await call('/api/socialV2/wait', st.agentToken, { timeoutMs: 1000, quietMs: 100 });
  assert.equal(waited.status, 200);
  await call('/api/socialV2/mark-read', st.agentToken, { throughSeq: waited.data.readThroughSeq });
  append('闹麻了'); // 回合末又来一条无关的新消息
  assert.equal(h.replayPendingWakeReasonsV2('group:456')?.action, 'skipped');
}));

test('触发它的那条消息还没给她看过，照样补发', () => fixture(async ({ h, st, append }) => {
  append('鱼妹 在吗');
  st.pendingWakeReasons = [{ reason: 'atMention', seq: st.lastUnreadSeq }];
  assert.equal(h.replayPendingWakeReasonsV2('group:456')?.action, 'replayed');
}));

test('play 发进群里的话出现在聊天会话的等待结果里，只给一次', () => fixture(async ({ st, play, call }) => {
  const started = Date.now();
  const pending = call('/api/socialV2/wait', st.agentToken, { timeoutMs: 5000, quietMs: 100 });
  await sleep(200);
  const sent = await call('/api/socialV2/send-message', play.agentToken, { messages: ['看完回来了', 'boss 真不少'] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const result = await pending;
  assert.ok(Date.now() - started < 4000, `等了 ${Date.now() - started}ms`);
  assert.deepEqual(result.data.yourPlaySelfSent.map((m) => m.text), ['看完回来了', 'boss 真不少']);
  assert.match(result.data.yourPlaySelfSentHint, /别再讲一遍/);
  assert.match(result.data.earlyReturn, /自由时间那边的你/);
  assert.equal(result.data.timeout, false);
  assert.ok(st.recentMessages.filter((m) => m.byPlay).every((m) => m.sender.includes('自由时间')));
  const again = await call('/api/socialV2/wait', st.agentToken, { timeoutMs: 300, quietMs: 100 });
  assert.equal('yourPlaySelfSent' in again.data, false);
}));

test('聊天会话自己发的话不算 play 发的', () => fixture(async ({ st, call }) => {
  const sent = await call('/api/socialV2/send-message', st.agentToken, { messages: ['我自己说的'] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(st.recentMessages.at(-1).byPlay, undefined);
  assert.equal(st.recentMessages.at(-1).sender, '我');
  const waited = await call('/api/socialV2/wait', st.agentToken, { timeoutMs: 300, quietMs: 100 });
  assert.equal('yourPlaySelfSent' in waited.data, false);
}));

test('唤醒快照带上 play 刚发的话，投递后标成已给过', () => fixture(async ({ h, st, play, call, append }) => {
  const sent = await call('/api/socialV2/send-message', play.agentToken, { messages: ['十月二十九号上线'] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  append('鱼妹 啥时候出');
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2('group:456', 'question');
  const text = h.calls.prompts.slice(before).map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n')).join('\n');
  assert.match(text, /"yourPlaySelfSent":\[\{"text":"十月二十九号上线"/);
  assert.match(text, /自由时间那边的你刚刚发到这里的/);
  assert.equal(st.recentMessages.find((m) => m.byPlay).shownToChat, true);
}, { wakeFirst: false }));

// 假的 extras（/relay/prepare、/relay/cancel）+ 假的 OneBot
function memeFetch(prepare, seen) {
  return async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    seen.push({ url: String(url), body });
    const json = String(url).endsWith('/relay/prepare') ? prepare(body)
      : String(url).endsWith('/relay/cancel') ? { ok: true }
        : { status: 'ok', retcode: 0, data: { message_id: 9002 } };
    return { ok: true, status: 200, json: async () => json };
  };
}

test('play 搬的沙雕图由 bridge 发，聊天会话看得到', () => {
  const seen = [];
  const fetch = memeFetch((b) => ({ ok: true, id: 'r1', post: b.post, images: [{ data: 'AAAA', format: 'jpeg' }], text: `${b.caption}（t.me/woshadiao）` }), seen);
  return fixture(async ({ st, play, call }) => {
    const sent = await call('/api/socialV2/send-meme', play.agentToken, { post: 'woshadiao/100', caption: '绷不住了' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(seen[0].url, 'http://extras:8940/relay/prepare');
    assert.deepEqual(seen[0].body, { post: 'woshadiao/100', key: 'group:456', caption: '绷不住了' });
    const onebot = seen.find((c) => c.url.endsWith('/send_group_msg'));
    assert.equal(onebot.body.group_id, 456);
    assert.equal(onebot.body.message[0].data.file, 'base64://AAAA');
    assert.equal(onebot.body.message.at(-1).data.text, '绷不住了（t.me/woshadiao）');
    const entry = st.recentMessages.at(-1);
    assert.equal(entry.byPlay, true);
    assert.match(entry.text, /\[沙雕图:woshadiao\/100\] 绷不住了/);
    const waited = await call('/api/socialV2/wait', st.agentToken, { timeoutMs: 3000, quietMs: 100 });
    assert.match(waited.data.yourPlaySelfSent[0].text, /沙雕图/);
  }, { wakeFirst: false, globals: { fetch } });
});

test('extras 拒绝时原样告诉她，不发 QQ', () => {
  const seen = [];
  const fetch = memeFetch(() => ({ ok: false, error: '这条之前在这个会话里发过了' }), seen);
  return fixture(async ({ st, call }) => {
    const r = await call('/api/socialV2/send-meme', st.agentToken, { post: 'woshadiao/100' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, '这条之前在这个会话里发过了');
    assert.equal(seen.some((c) => c.url.includes('send_group_msg')), false);
  }, { globals: { fetch } });
});

test('别的会话的令牌不能搬图', () => {
  const seen = [];
  const fetch = memeFetch(() => ({ ok: true, id: 'r', images: [{ data: 'AAAA' }] }), seen);
  return fixture(async ({ call }) => {
    const r = await call('/api/socialV2/send-meme', 'not-a-token', { post: 'woshadiao/100' });
    assert.equal(r.status, 403);
    assert.equal(seen.some((c) => c.url.includes('/relay/') || c.url.includes('send_group_msg')), false);
  }, { globals: { fetch } });
});

test('QQ 发送失败时把名额还给 extras', () => {
  const seen = [];
  const ok = memeFetch(() => ({ ok: true, id: 'r9', post: 'woshadiao/7', images: [{ data: 'AAAA' }], text: '' }), seen);
  const fetch = async (url, init) => (String(url).endsWith('/send_group_msg')
    ? (seen.push({ url: String(url) }), { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200, message: 'fixture down' }) })
    : ok(url, init));
  return fixture(async ({ st, call }) => {
    const before = st.recentMessages.length;
    const r = await call('/api/socialV2/send-meme', st.agentToken, { post: 'woshadiao/7' });
    assert.notEqual(r.status, 200);
    const cancel = seen.find((c) => c.url.endsWith('/relay/cancel'));
    assert.deepEqual(cancel?.body, { id: 'r9' });
    assert.equal(st.recentMessages.length, before);
  }, { globals: { fetch } });
});
