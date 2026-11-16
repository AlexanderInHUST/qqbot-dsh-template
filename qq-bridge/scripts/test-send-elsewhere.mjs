// qqbot_agent：替这里去别的窗口说句话（qq_send_elsewhere）。
// 2026-10-27：爸爸在私聊让她跟妈妈说晚安，她拿私聊的令牌往小群发，被“agent token 无效”挡回来，
// 回头说“我喊啦，她没应我”。现在主人刚在私聊或家里的小群说过话，就能直接发到私聊和家里的小群；
// 那边的会话在 yourPlaySelfSent 里看到一次。大群、play 都不行；拿别的窗口的令牌发，错误里写清该用哪个工具。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const PRIV = 'private:42';
const MOM = 'private:43';
const HOME = 'group:456';
const BIG = 'group:789';
const PLAY = 'play:main';
async function fixture(run, { socialV2 = {}, fetch = null } = {}) {
  const h = await bridgeHarness({ ...(fetch ? { globals: { fetch } } : {}), config: {
    ownerQQ: '42', extraOwnerQQ: ['43'], homeGroups: ['456'], allow: { private: ['42', '43'], groups: ['456', '789'] }, socialV2: {
      wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, nightSleep: { enabled: false },
      send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
      ...socialV2,
    } } });
  for (const k of [PRIV, MOM, HOME, BIG, PLAY]) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  let server = null;
  // tokenOf：用哪个窗口的令牌（默认就是 key 自己的）
  const call = async (route, key, body, tokenOf = key) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    const token = h.getSocialV2State(tokenOf).agentToken;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `${route}?key=${encodeURIComponent(key)}`, method: 'POST',
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
  };
  const elsewhere = (key, body) => call('/api/socialV2/send-elsewhere', key, body);
  const say = (key, userId, text, isOwner) => {
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, `user-${userId}`, text, text, false, isOwner, `fixture-${key}-${st.lastUnreadSeq + 1}`, [], userId, []);
  };
  const sends = (action) => h.calls.http.filter((c) => c.url.endsWith(`/${action}`)).map((c) => JSON.stringify(c.body));
  try { await run({ h, call, elsewhere, say, sends }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('爸爸在私聊让她跟妈妈说晚安：发进家里的小群，小群那边看到一次', () => fixture(async ({ h, elsewhere, say, sends }) => {
  say(PRIV, '42', '去小群跟妈妈说晚安', true);
  const r = await elsewhere(PRIV, { to: HOME, messages: ['妈妈晚安～', '我去睡啦'], atUserId: '43' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.sent, 2);
  assert.match(r.data.hint, /已经在 group:456 说了/);
  const out = sends('send_group_msg');
  assert.equal(out.length, 2);
  assert.match(out[0], /妈妈晚安/);
  assert.match(out[0], /43/, '第一条 @ 妈妈');
  const mine = h.getSocialV2State(HOME).recentMessages.filter((m) => m.isSelf);
  assert.deepEqual(JSON.parse(JSON.stringify(mine.map((m) => m.text))), ['妈妈晚安～', '我去睡啦']);
  assert.ok(mine.every((m) => m.byPlay && m.relayFrom === PRIV), '记成别处发来的，不算小群那边自己开口');
  assert.match(mine[0].sender, /^我（在和.*的私聊那边发过来的）$/);
  // 小群那边下次看消息时看到一次，带 from
  const unseen = h.unseenPlaySentV2(h.getSocialV2State(HOME));
  assert.equal(unseen.length, 2);
  const view = h.playSentViewV2(unseen);
  assert.match(view[0].from, /私聊/);
  assert.match(h.PLAY_SENT_HINT, /带 from 的是你在 from 那个窗口里发过来的/);
  // 私聊这边自己没多出“我说的话”
  assert.equal(h.getSocialV2State(PRIV).recentMessages.filter((m) => m.isSelf).length, 0);
}));

await test('从小群发到妈妈的私聊；私聊不能 @', () => fixture(async ({ elsewhere, say, sends }) => {
  say(HOME, '42', '鱼妹 私聊跟妈妈说一声我们到了', true);
  let r = await elsewhere(HOME, { to: MOM, messages: '妈妈，我们到啦', atUserId: '43' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /私聊不需要 @/);
  r = await elsewhere(HOME, { to: MOM, messages: '妈妈，我们到啦' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = sends('send_private_msg');
  assert.equal(out.length, 1);
  assert.match(out[0], /我们到啦/);
}));

await test('要主人刚在这里说过话；群友说的、太久以前说的都不算', () => fixture(async ({ h, elsewhere, say, sends }) => {
  say(HOME, '7', '鱼妹 去私聊跟你爸说一声', false);
  let r = await elsewhere(HOME, { to: PRIV, messages: '爸爸～' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /只有主人刚在这里/);
  say(PRIV, '42', '跟妈妈说晚安', true);
  h.getSocialV2State(PRIV).recentMessages.at(-1).time = Date.now() - 10 * 60000;
  r = await elsewhere(PRIV, { to: HOME, messages: '晚安' });
  assert.equal(r.status, 403);
  assert.equal(sends('send_group_msg').length + sends('send_private_msg').length, 0);
}));

await test('大群、play 不能发；也不能发到大群、play、这里自己', () => fixture(async ({ elsewhere, say, sends }) => {
  say(BIG, '42', '鱼妹 去小群说一声', true);
  let r = await elsewhere(BIG, { to: HOME, messages: '我在大群呢' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /只能在私聊和家里的小群里用/);
  r = await elsewhere(PLAY, { to: HOME, messages: '我玩完了' });
  assert.equal(r.status, 403);
  say(PRIV, '42', '去大群跟大家说一声', true);
  r = await elsewhere(PRIV, { to: BIG, messages: '我先下啦' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /qq_tell_myself/);
  r = await elsewhere(PRIV, { to: PLAY, messages: '别玩了' });
  assert.equal(r.status, 400);
  r = await elsewhere(PRIV, { to: PRIV, messages: '好' });
  assert.equal(r.status, 400);
  r = await elsewhere(PRIV, { to: 'group:999', messages: '你好' });
  assert.equal(r.status, 403, '不在白名单的群');
  r = await elsewhere(PRIV, { to: HOME, messages: [] });
  assert.equal(r.status, 400);
  assert.equal(sends('send_group_msg').length + sends('send_private_msg').length, 0);
}));

await test('一小时内次数有上限（sendElsewhere.maxPerHour）', () => fixture(async ({ elsewhere, say }) => {
  say(PRIV, '42', '跟妈妈说晚安', true);
  let r = await elsewhere(PRIV, { to: HOME, messages: '晚安' });
  assert.equal(r.status, 200);
  r = await elsewhere(PRIV, { to: MOM, messages: '晚安' });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /照实说/);
}, { socialV2: { sendElsewhere: { maxPerHour: 1 } } }));

await test('拿私聊的令牌往小群发：错误里写清用 qq_send_elsewhere，别说已经发了', () => fixture(async ({ call, say, sends }) => {
  say(PRIV, '42', '去小群跟妈妈说晚安', true);
  let r = await call('/api/socialV2/send-message', HOME, { messages: '妈妈晚安' }, PRIV);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /别的聊天窗口的令牌/);
  assert.match(r.data.error, /qq_send_elsewhere/);
  assert.match(r.data.error, /别说已经办了/);
  r = await call('/api/socialV2/send-burst', HOME, { messages: ['妈妈晚安'] }, PRIV);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /qq_send_elsewhere/);
  // 随便填的令牌还是原来那句
  r = await call('/api/socialV2/send-message', 'group:999', { messages: '你好' }, 'group:999');
  assert.equal(r.status, 403);
  assert.equal(sends('send_group_msg').length, 0);
}));

await test('发失败：错误里写清没发出去、照实说', () => fixture(async ({ h, elsewhere, say }) => {
  say(PRIV, '42', '跟妈妈说晚安', true);
  const r = await elsewhere(PRIV, { to: HOME, messages: '妈妈晚安' });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /QQ 发送失败/);
  assert.match(r.data.error, /照实说没发出去/);
  assert.equal(h.getSocialV2State(HOME).recentMessages.filter((m) => m.isSelf).length, 0);
}, { fetch: async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith('/send_group_msg')
  ? { status: 'failed', retcode: 1200, message: 'send group message failed: 网络连接异常!' }
  : { status: 'ok', retcode: 0, data: { message_id: 9001 } }) }) }));

await test('noReachOut：爸爸私聊她照回，但她不主动去找——不替别处发过去、自由时间不分享（托的照发）、不主动找人、系统提示发在小群', () => {
  const asked = [];
  const fetch = async (url) => {
    if (/extras:8940\/proactive/.test(String(url))) asked.push(String(url));
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  return fixture(async ({ h, elsewhere, say, sends }) => {
    say(HOME, '43', '鱼妹 私聊跟爸爸说一声我们到了', true);
    const r = await elsewhere(HOME, { to: PRIV, messages: '爸爸我们到啦' });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /不主动去找.*家里的小群/);
    assert.equal(sends('send_private_msg').length, 0);
    assert.equal(h.ownerNoticeKey(), HOME, '系统提示发在小群');
    assert.match(String(h.playShareGateV2(PRIV, false) ?? ''), /不主动来找/);
    h.getSocialV2State(PLAY).playRequests = [{ from: PRIV, at: Date.now(), note: '帮我看看' }];
    assert.equal(h.playShareGateV2(PRIV, false), null, '他托的照发');
    h.socialV2.life.initiateNextAt = Date.now() - 1000;
    await h.initiateTickV2();
    assert.equal(asked.length, 0, '不主动找');
    // 他私聊来找她：照常叫醒
    say(PRIV, '42', '在吗', true);
    assert.ok(h.isSessionAllowed(PRIV));
  }, { fetch, socialV2: { noReachOut: [PRIV], initiate: { enabled: true, targets: [PRIV], from: '00:00', to: '00:00', minSilenceMinutes: 0 },
    life: { enabled: true }, playShare: { enabled: true } } });
});

if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
