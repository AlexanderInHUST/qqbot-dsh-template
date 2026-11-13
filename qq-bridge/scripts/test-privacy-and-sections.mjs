// qqbot_agent：家里 / 外面的分寸（src/privacy-policy.js）和唤醒提示的分段登记（src/app/wake-prompt.js 的 WAKE_SECTIONS），
// 2026-11-09 架构调整第 6 步。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pinClock } from './lib/test-clock.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  crossSessionView, homeGroupKeys, isHomeChat, isOutsideGroup, ownerTitleHere, placeOf,
} from '../src/privacy-policy.js';

pinClock('14:00');
const HOME = '1100000001', BIG = '800000002';
const cfg = { homeGroups: [HOME], ownerTitles: { 900000001: '爸爸' } };

test('地方分四种；没配 homeGroups 时所有群都算家里的', () => {
  assert.equal(placeOf(cfg, `group:${HOME}`), 'home');
  assert.equal(placeOf(cfg, `group:${BIG}`), 'outside');
  assert.equal(placeOf(cfg, 'private:1600000002'), 'private');
  assert.equal(placeOf(cfg, 'play:main'), 'play');
  assert.equal(placeOf({}, `group:${BIG}`), 'home');
  assert.equal(isOutsideGroup(cfg, `group:${BIG}`), true);
  assert.equal(isOutsideGroup(cfg, 'private:1'), false);
  assert.equal(isHomeChat(cfg, 'private:1'), true);
  assert.equal(isHomeChat(cfg, `group:${HOME}`), true);
  assert.equal(isHomeChat(cfg, `group:${BIG}`), false);
  assert.equal(isHomeChat(cfg, 'play:main'), false);
  assert.deepEqual(homeGroupKeys(cfg), [`group:${HOME}`]);
});

test('称呼：私聊和家里叫爸爸，大群不叫；ownerTitlesGroups 优先', () => {
  assert.equal(ownerTitleHere(cfg, 'private:900000001', 900000001), '爸爸');
  assert.equal(ownerTitleHere(cfg, `group:${HOME}`, '900000001'), '爸爸');
  assert.equal(ownerTitleHere(cfg, `group:${BIG}`, '900000001'), '');
  assert.equal(ownerTitleHere(cfg, `group:${HOME}`, '42'), '', '没称呼的人');
  assert.equal(ownerTitleHere({ ...cfg, ownerTitlesGroups: [BIG] }, `group:${BIG}`, '900000001'), '爸爸');
});

test('别处的事：大群看哪儿都只给条数；summaryOnly 的会话看私聊只给条数', () => {
  assert.equal(crossSessionView(cfg, `group:${BIG}`, `group:${HOME}`), 'count');
  assert.equal(crossSessionView(cfg, `group:${BIG}`, 'private:1'), 'count');
  assert.equal(crossSessionView(cfg, `group:${BIG}`, 'play:main'), 'full', '自由时间玩了什么照给');
  assert.equal(crossSessionView(cfg, `group:${HOME}`, 'private:1'), 'full');
  assert.equal(crossSessionView(cfg, `group:${HOME}`, `group:${BIG}`), 'full');
  assert.equal(crossSessionView({}, `group:${BIG}`, 'private:1', [`group:${BIG}`]), 'count');
  assert.equal(crossSessionView({}, `group:${BIG}`, 'group:9', [`group:${BIG}`]), 'full');
});

test('唤醒提示按登记的顺序拼；别的模块能加一段；整份带上长期记忆、别处的事和快照', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] } } });
  try {
    const names = h.wakeSectionNamesV2().map((s) => s.name);
    for (const [a, b] of [['role', 'identity'], ['token', 'self-now'], ['this-group', 'stickers'], ['jobs', 'wake'],
      ['wake', 'long-term-memory'], ['long-term-memory', 'elsewhere'], ['elsewhere', 'snapshot']]) {
      assert.ok(names.indexOf(a) < names.indexOf(b), `${a} 在 ${b} 前面`);
    }
    assert.throws(() => h.registerWakeSectionV2({ name: 'wake', order: 1, build: () => '' }), /重名/);
    h.registerWakeSectionV2({ name: 'test-extra', order: 125, build: ({ key }) => `【测试段】${key}\n\n` });
    h.registerWakeSectionV2({ name: 'test-tail', order: 905, stage: 'tail', build: async () => '\n\n【测试尾段】' });
    const head = h.buildWakePromptV2('group:456', 'atMention');
    assert.ok(head.indexOf('【测试段】group:456') >= 0 && head.indexOf('【测试段】') < head.indexOf('【唤醒】'), head);
    assert.doesNotMatch(head, /测试尾段/, '前半段不拼尾段');
    assert.doesNotMatch(h.buildWakePromptV2('play:main', 'proactiveCheck'), /测试段/, '只给聊天窗口');
    const { text, snapshot } = await h.composeWakePromptV2('group:456', 'atMention');
    assert.ok(text.startsWith(head));
    assert.ok(text.indexOf('【测试尾段】') > text.indexOf('【唤醒】') && text.indexOf('【测试尾段】') < text.indexOf('【本次消息快照】'), text);
    assert.ok(snapshot && Array.isArray(snapshot.messages));
    const play = await h.composeWakePromptV2('play:main', 'proactiveCheck');
    assert.equal(play.snapshot, null);
    assert.match(play.text, /【自由时间】play:main/);
  } finally { await h.close(); }
});
