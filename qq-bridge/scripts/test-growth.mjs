// qqbot_agent：她慢慢长大（src/app/growth.js + extras/selfprofile.py）。人格卡里 grow 标记包着的部分换成成长档案里的，
// 没有档案时照原文；档案还没导入时把人格卡送去导入；画画、做视频的风格跟着年龄（配置里写了以配置为准）；生日那天【你现在】写一句。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { applyGrowRegions, selectRoleText, stripRoleComments } from '../src/role-card.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const msg = (userId, id, t) => ({
  self_id: 999, user_id: userId, message_id: id, message: [{ type: 'text', data: { text: t } }],
  raw_message: t, sender: { nickname: `u${userId}`, card: `u${userId}` }
});

const CARD = [
  '# 测试鱼',
  '',
  '<!-- grow:intro -->',
  '> 语气是一个爱玩的小孩。',
  '<!-- /grow:intro -->',
  '',
  '## 一、我是谁',
  '我是测试鱼，<!-- grow:age -->你就是个小孩子。<!-- /grow:age -->大家都认识我。',
  '',
  '## 二、喜好',
  '<!-- grow:likes -->',
  '- 喜欢：糖、猫。',
  '<!-- /grow:likes -->',
  '- 别的规矩。',
  '',
  '## 七、示例',
  '<!-- grow:examples --><!-- /grow:examples -->',
  '- 示例一',
].join('\n');

await test('applyGrowRegions：没有档案就去掉标记照原文，行内的不粘行', () => {
  const out = stripRoleComments(applyGrowRegions(CARD, null));
  assert.ok(!out.includes('grow:'), out);
  assert.ok(out.includes('> 语气是一个爱玩的小孩。\n'), out);
  assert.ok(out.includes('我是测试鱼，你就是个小孩子。大家都认识我。'), out);
  assert.ok(out.includes('- 喜欢：糖、猫。\n- 别的规矩。'), out);
});

await test('applyGrowRegions：有档案换成档案里的，档案里没有的那处照原文', () => {
  const out = stripRoleComments(applyGrowRegions(CARD, {
    intro: '> 语气是一个爱看书的小孩。', age: '你今年 8 岁。', examples: '> 下面的示例是你7岁时的说法。',
  }));
  assert.ok(out.includes('> 语气是一个爱看书的小孩。') && !out.includes('爱玩'), out);
  assert.ok(out.includes('我是测试鱼，你今年 8 岁。大家都认识我。'), out);
  assert.ok(out.includes('- 喜欢：糖、猫。'), out);
  assert.ok(out.includes('## 七、示例\n> 下面的示例是你7岁时的说法。'), out);
});

await test('真的人格卡：去掉标记后和不带标记的写法一样（每一处都配对）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', '..', 'roles', '鱼妹.md');
  if (!fs.existsSync(file)) return; // 镜像里没有 roles/
  const raw = fs.readFileSync(file, 'utf8');
  const names = [...raw.matchAll(/<!--\s*grow:(\w+)\s*-->/g)].map((m) => m[1]);
  assert.ok(names.length >= 9, names.join(','));
  for (const n of names) assert.ok(raw.includes(`<!-- /grow:${n} -->`), n);
  const out = selectRoleText(applyGrowRegions(raw, null), 'v2');
  assert.ok(!out.includes('grow:') && !out.includes('<!--'), out.slice(0, 300));
  assert.ok(out.includes('你就是个小孩子，性格也像小孩子。'), '行内的年龄那句还在原位');
});

async function fixture(run, { profile = null, socialV2 = {} } = {}) {
  const calls = [];
  let db = profile;
  const card = () => (db ? { ok: true, ...db } : { ok: true, empty: true, enabled: true });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.push({ url: u, body });
    if (u.endsWith('/self/card')) return { ok: true, status: 200, json: async () => card() };
    if (u.endsWith('/self/profile/seed')) {
      db = { age: 7, birthday: false, born: '2026-11-04', regions: { age: '你今年 7 岁。' }, drawStyle: '', videoStyle: '' };
      return { ok: true, status: 200, json: async () => ({ ok: true, seeded: 3, born: '2026-11-04' }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  };
  const h = await bridgeHarness({
    globals: { fetch },
    config: { allow: { groups: ['456'] }, socialV2: { nightSleep: { enabled: false }, proactive: { enabled: false }, ...socialV2, growth: { enabled: true, ...(socialV2.growth ?? {}) } } },
    files: { 'roles/测试鱼.md': CARD, 'state/current-role.json': JSON.stringify({ role: '测试鱼', mode: 'active' }) },
  });
  try {
    h.setMode('reserved2');
    await run(h, calls);
  } finally { await h.close(); }
}

await test('bridge：档案还没有就把人格卡原文送去导入，之后人格卡文件用档案里的', () => fixture(async (h, calls) => {
  await h.refreshGrowthV2();
  const seed = calls.find((c) => c.url.endsWith('/self/profile/seed'));
  assert.ok(seed && seed.body.card.includes('<!-- grow:likes -->'), JSON.stringify(calls.map((c) => c.url)));
  await h.handleIncoming('group', '456', msg(321, 1, '在吗'), h.cfg);
  await h.buildWakePromptV2('group:456', { reason: 'mention' });
  const written = fs.readFileSync(path.join(h.temp, 'state/role-card-v2.md'), 'utf8');
  assert.ok(written.includes('我是测试鱼，你今年 7 岁。大家都认识我。'), written);
  assert.ok(!written.includes('grow:'), written);
  await h.refreshGrowthV2();
  assert.equal(calls.filter((c) => c.url.endsWith('/self/profile/seed')).length, 1, '只导入一次');
}));

await test('bridge：画画、做视频的风格跟着年龄，配置里写了以配置为准；生日那天【你现在】写一句', () => fixture(async (h) => {
  await h.refreshGrowthV2();
  assert.ok(h.drawCfgV2().style.startsWith('age-8 drawing style\n') && h.drawCfgV2().style.includes('written by the child in Chinese'), h.drawCfgV2().style);
  assert.equal(h.videoCfgV2().style, '八岁的视频风格');
  h.cfg.socialV2.draw = { style: 'from config' };
  h.cfg.socialV2.video = { style: '配置的' };
  assert.equal(h.drawCfgV2().style, 'from config');
  assert.equal(h.videoCfgV2().style, '配置的');
  const now = h.selfNowPartsV2('group:456').lines.join('\n');
  assert.ok(now.includes('今天是你的生日，你满 8 岁了。'), now);
  assert.equal(h.birthdayLineV2({ birthday: false, age: 8 }), '');
}, { profile: { age: 8, birthday: true, born: '2026-11-04', regions: { age: '你今年 8 岁。' }, drawStyle: 'age-8 drawing style', videoStyle: '八岁的视频风格' } }));

await test('bridge：没有档案时画画还是蜡笔画、视频不加风格；growth.enabled=false 照原文', () => fixture(async (h) => {
  await h.refreshGrowthV2();
  assert.ok(/crayon/i.test(h.drawCfgV2().style));
  assert.equal(h.videoCfgV2().style, '');
  assert.equal(h.growthV2(), null);
  assert.ok(h.roleHintForMode('v2').includes('你就是个小孩子。'));
}, { socialV2: { growth: { enabled: false } }, profile: { age: 9, birthday: false, born: '2026-11-04', regions: { age: '你今年 9 岁。' }, drawStyle: 'x', videoStyle: 'y' } }));

await test('bridge：喜欢、兴趣变了【你现在】写一句她自己的感觉，没有就不写', () => fixture(async (h) => {
  await h.refreshGrowthV2();
  const now = h.selfNowPartsV2('group:456').lines.join('\n');
  assert.ok(now.includes('- 你最近发现自己有点变了：你发现自己最近迷上了数独；你发现：没那么爱堆雪人了。这是你自己心里的感觉'), now);
  assert.ok(!/档案|长大|岁/.test(h.growthNoticeLineV2()), h.growthNoticeLineV2());
  assert.equal(h.growthNoticeLineV2({ notices: [] }), '');
  assert.equal(h.growthNoticeLineV2(null), '');
}, { profile: { age: 8, birthday: false, born: '2026-11-04', regions: { age: '你今年 8 岁。' }, drawStyle: '', videoStyle: '',
  notices: [{ text: '你发现自己最近迷上了数独。', date: '2026-11-10' }, { text: '你发现：没那么爱堆雪人了', date: '2026-11-09' }] } }));

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('test-growth: all passed');
