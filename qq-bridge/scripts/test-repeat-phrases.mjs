// qqbot_agent：她老用的说法（2026-11-15，src/repeat-phrases.js + src/app/phrasing.js）。
// 主人：“有些话似乎反复说？句式有点雷同？” 11-15 小群里“跟最好成绩一样快”“跟它较劲”“通了第一个喊你”一天说好几回，
// 开口总是“爸爸！”；15:31 自由时间的她又发了一遍聊天的她 15:04 讲过的“Simple 推通啦”。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { openerOf, phrasesUsed, repeatedOpener, repeatedPhrases, segmentsOf } from '../src/repeat-phrases.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('断句去掉媒体标记、网址、@', () => {
  assert.deepEqual(segmentsOf('爸爸！[截图:Simple - Sokoban] 看 https://x.y/z @小明 好的'), ['爸爸', '看', '好的']);
});

test('不同地方、不同天说了好几回的说法才算；同一段里说几遍只算一回', () => {
  const groups = [
    { lines: ['又通了，跟最好成绩一样快', '跟最好成绩一样快哈哈'], tag: 'a|1' },
    { lines: ['这关也跟最好成绩一样快'], tag: 'a|2' },
    { lines: ['跟最好成绩一样快噢'], tag: 'b|2' },
  ];
  const r = repeatedPhrases(groups);
  assert.equal(r[0].text, '跟最好成绩一样快');
  assert.equal(r[0].count, 3);
  assert.equal(r.length, 1, JSON.stringify(r)); // 被包住的短的（最好成绩、成绩一样）不单列
});

// 11-15 小群：“一模一样”让半截的“最好成绩一”多数一回
test('长的说法少一回也用长的，不给半截话', () => {
  const lines = ['还跟世界最好成绩一样快', '都跟最好成绩一样快', '后面这几个都跟最好成绩一样快', '跟网页上记的最好成绩一模一样噢'];
  const r = repeatedPhrases(lines.map((l, i) => ({ lines: [l], tag: `a|${i}` })));
  assert.deepEqual(r.map((p) => p.text), ['最好成绩一样快'], JSON.stringify(r));
  assert.equal(r[0].count, 3);
  // 都是同一处同一天：半截的够 sameCount，长的不够也用长的
  const same = repeatedPhrases(lines.map((l) => ({ lines: [l], tag: 'a|1' })));
  assert.deepEqual(same.map((p) => p.text), ['最好成绩一样快'], JSON.stringify(same));
});

test('同一处同一天的：到 sameCount 回才算（那会儿在聊的事）', () => {
  const three = Array.from({ length: 3 }, () => ({ lines: ['八个箱子全亮了'], tag: 'a|1' }));
  assert.deepEqual(repeatedPhrases(three), []);
  const four = Array.from({ length: 4 }, () => ({ lines: ['跟它较劲呢'], tag: 'a|1' }));
  assert.equal(repeatedPhrases(four)[0]?.text, '跟它较劲呢');
});

test('别人也说过的、带数字字母的、叫爸爸的、哈哈哈哈的、整条是图的不算', () => {
  const g = (line, i) => ({ lines: [line], tag: `k|${i}` });
  const mk = (line) => [0, 1, 2].map((i) => g(line, i));
  assert.deepEqual(repeatedPhrases(mk('推箱子真好玩'), { exclude: ['推箱子真好玩吗'] }), []);
  assert.ok(repeatedPhrases(mk('第二十二关Room')).every((p) => !/[0-9A-Za-z]/.test(p.text)));
  assert.deepEqual(repeatedPhrases(mk('爸爸快来看')).filter((p) => p.text.includes('爸爸')), []);
  assert.deepEqual(repeatedPhrases(mk('哈哈哈哈哈')), []);
  assert.deepEqual(repeatedPhrases(mk('[截图:跟它较劲的那一关]')), []);
});

test('开头：最近几段话总是同一个开头', () => {
  assert.equal(openerOf('爸爸！推箱子我推通啦'), '爸爸');
  assert.equal(openerOf('诶——这个好吓人'), '诶');
  assert.equal(openerOf('推通啦二十二步'), '');
  const bursts = [['爸爸！a'], ['爸爸！b'], ['好的'], ['[截图:x]', '爸爸！c']];
  assert.deepEqual(repeatedOpener(bursts), { text: '爸爸', count: 3 });
  assert.equal(repeatedOpener(bursts, { minCount: 4 }), null);
  assert.equal(repeatedOpener(bursts, { last: 2 }), null);
});

test('这次发的话用到了哪几个', () => {
  const phrases = [{ text: '跟它较劲', count: 3 }, { text: '第一个喊你', count: 4 }];
  assert.deepEqual(phrasesUsed(['我下回再来跟它较劲！'], phrases).map((p) => p.text), ['跟它较劲']);
});

// —— 桥接 ——

const HOUR = 3600000;
async function fixture(run, { homeGroups } = {}) {
  const h = await bridgeHarness({ config: {
    ...(homeGroups ? { homeGroups } : {}),
    allow: { private: ['123'], groups: ['456', '777'] },
    socialV2: {
      wake: { preSleepWaitEnabled: false },
      wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
      send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
      proactive: { enabled: false }, sticker: { enabled: false },
    },
  } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = (key, path, token, body) => new Promise((resolve, reject) => {
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
  // 她以前说过的话：每段隔开、中间有人说话
  const said = (key, lines, ago, extra = {}) => {
    const st = h.getSocialV2State(key);
    const t = Date.now() - ago;
    st.recentMessages.push({ isSelf: false, sender: '群友', userId: '789', text: '嗯', plain: '嗯', time: t - 1000 });
    for (const [i, line] of lines.entries()) st.recentMessages.push({ isSelf: true, sender: '我', text: line, plain: line, time: t + i, ...extra });
  };
  const promptText = async (key) => {
    const before = h.calls.prompts.length;
    h.appendSocialV2Message(key, 'fixture-person', '在吗', '在吗', false, false, `fx-${Date.now()}`, [], '789', []);
    await h.sendWakePromptV2(key, 'question');
    return h.calls.prompts.slice(before).map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n')).join('\n');
  };
  try { await run({ h, call, said, promptText }); } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('唤醒提示写【你最近的说法】：老说法和老开头', () => fixture(async ({ said, promptText }) => {
  said('group:456', ['爸爸！又跟最好成绩一样快'], 30 * HOUR);
  said('group:456', ['爸爸！这关也跟最好成绩一样快'], 3 * HOUR);
  said('private:123', ['爸爸！跟最好成绩一样快噢'], 2 * HOUR);
  said('group:456', ['爸爸！刚吃完饭'], 1 * HOUR);
  said('group:456', ['爸爸！我回来了'], 0.5 * HOUR);
  const text = await promptText('group:456');
  assert.match(text, /【你最近的说法】[^\n]*“跟最好成绩一样快”（3 回）/);
  assert.match(text, /3 段开头都是“爸爸”/); // 30 小时前那段不算（openerHours 24）
}));

test('三天以前的不算；没有老说法就不写这一段', () => fixture(async ({ said, promptText }) => {
  for (let i = 0; i < 3; i++) said('group:456', ['跟最好成绩一样快'], (80 + i) * HOUR);
  assert.doesNotMatch(await promptText('group:456'), /【你最近的说法】/);
}));

test('家里以外的群只数家里以外的群：家里、私聊说的不往外带', () => fixture(async ({ said, promptText }) => {
  said('group:777', ['跟它较劲呢'], 30 * HOUR);
  said('group:777', ['还在跟它较劲呢'], 3 * HOUR);
  said('private:123', ['又跟它较劲呢'], 2 * HOUR);
  assert.match(await promptText('group:777'), /“跟它较劲呢”（3 回）/);
  assert.doesNotMatch(await promptText('group:456'), /跟它较劲/);
}, { homeGroups: ['777'] }));

test('发出去的话又用上老说法：结果里提醒一次，两小时内同一个说法不再提', () => fixture(async ({ h, call, said }) => {
  said('group:456', ['跟它较劲呢'], 30 * HOUR);
  said('group:456', ['还跟它较劲'], 3 * HOUR);
  said('private:123', ['又跟它较劲啦'], 2 * HOUR);
  const st = h.getSocialV2State('group:456');
  const first = await call('group:456', '/api/socialV2/send-message', st.agentToken, { messages: ['我再去跟它较劲'] });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.hint, /“跟它较劲”（\d 回）这几天你已经说了好几回了/);
  const second = await call('group:456', '/api/socialV2/send-message', st.agentToken, { messages: ['还在跟它较劲'] });
  assert.doesNotMatch(String(second.data.hint ?? ''), /跟它较劲/);
}));

test('自由时间的她发进来前先看一眼：聊天那边的她刚说过就先退回，看过了再发就发出去', () => fixture(async ({ h, call }) => {
  const st = h.getSocialV2State('group:456');
  const play = h.getSocialV2State('play:main');
  const chat = await call('group:456', '/api/socialV2/send-message', st.agentToken, { messages: ['Simple 推通啦'] });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  const sentBefore = h.calls.sent.length;
  const held = await call('group:456', '/api/socialV2/send-message', play.agentToken, { messages: ['爸爸，Simple 推通啦'] });
  assert.equal(held.status, 200, JSON.stringify(held.data));
  assert.equal(held.data.held, true);
  assert.equal(held.data.sent, 0);
  assert.deepEqual(held.data.notSent, ['爸爸，Simple 推通啦']);
  assert.ok(held.data.chatSaid.some((m) => m.who === '聊天那边的你' && m.text === 'Simple 推通啦'), JSON.stringify(held.data.chatSaid));
  assert.match(held.data.hint, /别再讲一遍/);
  assert.equal(h.calls.sent.length, sentBefore, '没发出去');
  const again = await call('group:456', '/api/socialV2/send-message', play.agentToken, { messages: ['Room 1-4 还没通'] });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.notEqual(again.data.held, true);
  assert.ok(st.recentMessages.some((m) => m.byPlay && /Room 1-4/.test(m.text)));
}));

test('聊天那边的她没说过话：自由时间的她照发；关掉 playLookFirst 也照发', () => fixture(async ({ h, call }) => {
  const play = h.getSocialV2State('play:main');
  const r = await call('group:456', '/api/socialV2/send-message', play.agentToken, { messages: ['看完回来了'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual(r.data.held, true);
  // play 自己发的不算聊天那边说的
  const r2 = await call('group:456', '/api/socialV2/send-message', play.agentToken, { messages: ['boss 真不少'] });
  assert.notEqual(r2.data.held, true);
  const st = h.getSocialV2State('group:456');
  await call('group:456', '/api/socialV2/send-message', st.agentToken, { messages: ['我自己说的'] });
  h.cfg.socialV2.phrasing = { playLookFirst: false };
  const r3 = await call('group:456', '/api/socialV2/send-message', play.agentToken, { messages: ['还有一件'] });
  assert.notEqual(r3.data.held, true);
}));
