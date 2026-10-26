// qqbot_agent：捎话给别的窗口的自己（qq_tell_myself）、答应了先不玩（playHold）。
// 2026-10-26 16:04：主人在私聊让她别玩了，她答应了，可大群和电脑那边各是各的会话，接着玩。
// 现在只能从私聊、家里的小群捎（大群、play 都不行），要主人刚在那里说过话；stopPlay 让电脑那边收尾、一段时间不去玩。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const PRIV = 'private:42';
const HOME = 'group:456';
const BIG = 'group:789';
const PLAY = 'play:main';
async function fixture(run, socialV2 = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: '42', homeGroups: ['456'], allow: { private: ['42'], groups: ['456', '789'] }, socialV2: {
    wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, nightSleep: { enabled: false }, ...socialV2,
  } } });
  h.setMode('reserved2');
  for (const k of [PRIV, HOME, BIG, PLAY]) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  let server = null;
  const call = async (route, key, body) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    const token = h.getSocialV2State(key).agentToken;
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
      req.end(JSON.stringify({ key, ...body }));
    });
  };
  const tell = (key, body) => call('/api/socialV2/tell-myself', key, body);
  const say = (key, userId, text, isOwner) => {
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, `user-${userId}`, text, text, false, isOwner, `fixture-${key}-${st.lastUnreadSeq + 1}`, [], userId, []);
  };
  // 那边正在跑一轮
  const busy = (key) => {
    const sid = h.state.sessions[key];
    h.trackTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    h.v2TurnStartAt.set(sid, Date.now() - 1000);
  };
  const steersTo = (key) => h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode === 'steer')
    .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));
  try { await run({ h, call, tell, say, busy, steersTo }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('只能从私聊和家里的群捎：大群、play 都拒', () => fixture(async ({ h, tell, say }) => {
  say(BIG, '42', '鱼妹 别玩了', true);
  let r = await tell(BIG, { to: PRIV, note: '先不玩了' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /只能在私聊和家里的小群里用/);
  r = await tell(PLAY, { to: HOME, note: '先不玩了' });
  assert.equal(r.status, 403);
  assert.equal(h.tellSourceOkV2(PRIV), true);
  assert.equal(h.tellSourceOkV2(HOME), true);
  assert.equal(h.tellSourceOkV2(BIG), false);
  assert.equal(h.tellSourceOkV2(PLAY), false);
  assert.equal((h.socialV2.tellNotes ?? []).length, 0);
  assert.equal(h.socialV2.playHold ?? null, null);
}));

await test('要主人刚在这里说过话；群友说的不算', () => fixture(async ({ tell, say }) => {
  say(HOME, '7', '鱼妹 去大群跟大家说一声', false);
  let r = await tell(HOME, { to: BIG, note: '跟大家说一声晚点再玩' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /主人/);
  say(HOME, '42', '鱼妹 去大群跟大家说一声', true);
  r = await tell(HOME, { to: BIG, note: '跟大家说一声晚点再玩' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}));

await test('参数：note、to 要对；自己、没待过的、不在白名单的不行', () => fixture(async ({ tell, say }) => {
  say(PRIV, '42', '别玩了', true);
  assert.equal((await tell(PRIV, { to: BIG })).status, 400, '没 note 也没 stopPlay');
  assert.equal((await tell(PRIV, { note: '先不玩了' })).status, 400, '没 to 也没 stopPlay');
  assert.equal((await tell(PRIV, { to: PRIV, note: '先不玩了' })).status, 400, '捎给自己');
  assert.equal((await tell(PRIV, { to: 'group:999', note: '先不玩了' })).status, 400, '不在白名单');
  assert.equal((await tell(PRIV, { to: 'group:abc', note: '先不玩了' })).status, 400);
}));

await test('那边正聊着：插一句【捎给自己的话】；大群里看不到是在私聊答应的', () => fixture(async ({ h, tell, say, busy, steersTo }) => {
  say(PRIV, '42', '别在大群玩了', true);
  busy(BIG);
  const r = await tell(PRIV, { to: BIG, note: '先不玩了，跟大家说一声晚点再玩' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.delivered[BIG], 'steered');
  const [text] = steersTo(BIG);
  assert.match(text, /^【捎给自己的话】group:789（令牌 [0-9a-f]+）你 \d{4}-\d\d-\d\d \d\d:\d\d 在别处答应了：先不玩了，跟大家说一声晚点再玩/);
  assert.match(text, /别提是谁让的/);
  assert.doesNotMatch(text, /私聊/);
  assert.equal((h.socialV2.tellNotes ?? []).length, 0, '插上了就不另外记');
  assert.match(r.data.hint, /正聊着，已经插了一句/);
}));

await test('那边不在聊：记着，下次唤醒提示里写一次，投递后删掉；不专门叫醒', () => fixture(async ({ h, tell, say, steersTo }) => {
  say(PRIV, '42', '跟小群说一声', true);
  const before = h.calls.prompts.length;
  const r = await tell(PRIV, { to: HOME, note: '跟大家说今晚不玩了' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.delivered[HOME], 'stored');
  assert.equal(h.calls.prompts.length, before, '不叫醒');
  assert.equal(steersTo(HOME).length, 0);
  const line = h.tellPromptLineV2(HOME);
  assert.match(line, /^【捎给自己的话】[\s\S]*在.*私聊.*：跟大家说今晚不玩了/);
  assert.match(h.buildWakePromptV2(HOME, 'reminder'), /【捎给自己的话】/);
  h.markTellShownV2(HOME);
  assert.equal(h.tellPromptLineV2(HOME), '');
  assert.equal(h.socialV2.tellNotes.length, 0);
}));

await test('to=all：除了这里和电脑那边的都捎；大群那份写“别处”', () => fixture(async ({ h, tell, say }) => {
  say(HOME, '42', '大家都别玩了', true);
  const r = await tell(HOME, { to: 'all', note: '今晚都不玩游戏了' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data.delivered).sort(), [BIG, PRIV].sort());
  assert.match(h.tellPromptLineV2(BIG), /在别处：今晚都不玩游戏了/);
  assert.doesNotMatch(h.tellPromptLineV2(PRIV), /别处/);
  assert.equal(h.tellPromptLineV2(PLAY), '');
}));

await test('每处最多留 3 条，过了 keepHours 就不给了', () => fixture(async ({ h, tell, say }) => {
  say(PRIV, '42', '捎话', true);
  for (let i = 1; i <= 5; i++) await tell(PRIV, { to: HOME, note: `第${i}条` });
  const notes = h.tellNotesOfV2(HOME);
  assert.deepEqual(JSON.parse(JSON.stringify(notes.map((n) => n.note))), ['第3条', '第4条', '第5条']);
  assert.equal(h.tellNotesOfV2(HOME, Date.now() + 7 * 3600 * 1000).length, 0);
}));

await test('stopPlay：电脑那边正玩着就插【先不玩了】、不再劝接着玩；之后自由时间、托去玩、分享都拦', () => fixture(async ({ h, tell, say, busy, steersTo, call }) => {
  const play = h.getSocialV2State(PLAY);
  play.freeTime = { startedAt: Date.now() - 600000, minUntil: Date.now() + 600000, asked: [{ from: BIG, at: Date.now() }], curfewSent: false, restOfferSent: false };
  play.playRequests = [{ from: BIG, note: '陪我们玩', at: Date.now(), done: false }];
  busy(PLAY);
  say(PRIV, '42', '别玩了，去休息', true);
  const r = await tell(PRIV, { stopPlay: true, minutes: 90 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stopPlay.play, 'steered');
  assert.match(steersTo(PLAY)[0], /^【先不玩了】[\s\S]*手上的马上停下[\s\S]*qq_mark_read\(key="play:main"/);
  assert.equal(play.freeTime.minUntil, 0);
  assert.equal(play.freeTime.asked.length, 0);
  assert.equal(play.freeTime.curfewSent, true);
  assert.equal(play.playRequests[0].done, true);
  const hold = h.socialV2.playHold;
  assert.ok(hold && hold.from === PRIV && Math.abs(hold.until - (Date.now() + 90 * 60000)) < 5000, JSON.stringify(hold));

  // 自由时间检查跳过
  h.trackTurnEvent(h.state.sessions[PLAY], { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  h.v2TurnStartAt.delete(h.state.sessions[PLAY]);
  h.socialV2.proactiveNextAt = 0;
  const n = h.calls.prompts.length;
  h.runGlobalProactiveCheckV2();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.calls.prompts.length, n, '答应了先不玩：不去玩');
  assert.ok(h.socialV2.proactiveNextAt > Date.now(), '下次检查照排');

  // 大群里有人托她去玩：拒
  say(BIG, '7', '鱼妹 去玩 2048', false);
  let g = await call('/api/socialV2/go-play', BIG, { note: '群友要我玩 2048' });
  assert.equal(g.status, 403);
  assert.match(g.data.error, /答应了先不玩/);
  assert.doesNotMatch(g.data.error, /私聊|主人|爸爸/);
  // 大群里主人说话也不算（只认私聊和家里的群）
  say(BIG, '42', '鱼妹 去玩吧', true);
  g = await call('/api/socialV2/go-play', BIG, { note: '去玩' });
  assert.equal(g.status, 403);
  // play 不往聊天里分享
  assert.match(String(h.playShareGateV2(HOME, false) ?? ''), /答应了先不玩/);

  // 【你现在】里写着
  assert.match(h.selfNowBlockV2(BIG, h.getSocialV2State(BIG)), /答应了先不玩[\s\S]*别去电脑上玩/);
  assert.match(h.selfNowBlockV2(PLAY, play), /答应了先不玩[\s\S]*手上的停下收尾/);
  assert.match(r.data.hint, /有人托你去玩也会被拦下/);
}));

await test('stopPlay：电脑那边没在玩是 idle；主人在私聊或家里的群又让去玩就放行', () => fixture(async ({ h, tell, say, call }) => {
  say(HOME, '42', '先别玩了', true);
  const r = await tell(HOME, { stopPlay: true, to: BIG, note: '跟大家说一声晚点再玩' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stopPlay.play, 'idle');
  assert.equal(r.data.delivered[BIG], 'stored', 'stopPlay 和捎话可以一起');
  // 说好之前主人的话不算“又让去玩”
  let g = await call('/api/socialV2/go-play', HOME, { note: '去玩' });
  assert.equal(g.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 5));
  say(PRIV, '42', '好啦去玩吧', true);
  g = await call('/api/socialV2/go-play', PRIV, { note: '爸爸让我去玩了' });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(h.socialV2.playHold, null);
  assert.equal(h.playHoldLineV2(BIG), '');
}));

await test('stopPlay 到点自己解除；minutes 夹在 [10, 360]；不会把更长的缩短', () => fixture(async ({ h, tell, say }) => {
  say(PRIV, '42', '别玩了', true);
  await tell(PRIV, { stopPlay: true, minutes: 1 });
  assert.ok(Math.abs(h.socialV2.playHold.until - (Date.now() + 10 * 60000)) < 5000);
  await tell(PRIV, { stopPlay: true, minutes: 9999 });
  const long = h.socialV2.playHold.until;
  assert.ok(Math.abs(long - (Date.now() + 360 * 60000)) < 5000);
  await tell(PRIV, { stopPlay: true });
  assert.equal(h.socialV2.playHold.until, long, '不缩短');
  assert.equal(h.playHoldV2(long + 1), null);
  assert.equal(h.socialV2.playHold, null);
}));

await test('存盘：捎话和说好先不玩重启后读回，过期的不读', () => fixture(async ({ h, tell, say }) => {
  say(PRIV, '42', '别玩了', true);
  await tell(PRIV, { stopPlay: true, to: HOME, note: '跟大家说晚点再玩' });
  h.flushSocialV2State();
  const hold = JSON.parse(JSON.stringify(h.socialV2.playHold));
  const notes = JSON.parse(JSON.stringify(h.socialV2.tellNotes));
  h.socialV2.playHold = null;
  h.socialV2.tellNotes = [];
  h.loadSocialV2State();
  assert.deepEqual(JSON.parse(JSON.stringify(h.socialV2.playHold)), hold);
  assert.deepEqual(JSON.parse(JSON.stringify(h.socialV2.tellNotes)), notes);
  h.socialV2.playHold = { ...hold, until: Date.now() - 1000 };
  h.flushSocialV2State();
  h.socialV2.playHold = null;
  h.loadSocialV2State();
  assert.equal(h.socialV2.playHold, null);
}));

await test('工具开关：tellMyself:false 就拒', () => fixture(async ({ tell, say }) => {
  say(PRIV, '42', '别玩了', true);
  const r = await tell(PRIV, { stopPlay: true });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /qq_tell_myself/);
}, { tools: { tellMyself: false } }));

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
