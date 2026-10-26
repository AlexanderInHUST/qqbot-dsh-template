// qqbot_agent：人格卡放进系统提示（qq-persona-card 插件 + bridge 写 state/role-card-v2.md），
// 人格卡里的 HTML 注释不给她看，主人标记不写“管理员（主人 QQ …）”。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createRoleCardReader, apply, DEFAULT_FALLBACK } from '../plugins/qq-agent-presets/qq-persona-card.mjs';
import { stripRoleComments, selectRoleText } from '../src/role-card.js';

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
  '<!-- 给维护的人看的：config.json 里的 ownerTitles -->',
  '',
  '## 一、我是谁',
  '我是测试鱼，喜欢吃小鱼干。',
].join('\n');

await test('插件：读文件、文件变了重新读、没文件或空文件填 fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-card-'));
  try {
    const file = path.join(dir, 'card.md');
    const read = createRoleCardReader(file);
    assert.equal(read(), DEFAULT_FALLBACK);
    fs.writeFileSync(file, '  我是测试鱼\n');
    assert.equal(read(), '我是测试鱼');
    fs.writeFileSync(file, '我是另一条鱼，名字更长');
    assert.equal(read(), '我是另一条鱼，名字更长');
    fs.writeFileSync(file, '');
    assert.equal(read(), DEFAULT_FALLBACK);
    fs.rmSync(file);
    assert.equal(read(), DEFAULT_FALLBACK);

    // apply 注册 qq_role_card 变量
    const vars = new Map();
    const ctx = {
      effect: (fn) => fn(),
      systemPrompt: { variable: (name, provider) => { vars.set(name, provider); return () => {}; } },
    };
    fs.writeFileSync(file, '卡片内容');
    apply(ctx, { file });
    assert.equal(vars.get('qq_role_card')(), '卡片内容');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('人格卡里的 HTML 注释不进提示', async () => {
  assert.equal(stripRoleComments('a\n<!-- x\ny -->\nb'), 'a\nb');
  const selected = selectRoleText(CARD, 'v2');
  const text = typeof selected === 'string' ? selected : (selected?.text ?? '');
  assert.ok(text.includes('小鱼干'), text);
  assert.ok(!text.includes('config.json') && !text.includes('<!--'), text);
});

await test('bridge：二代唤醒时把人格卡写进 state/role-card-v2.md，唤醒提示里不再叫她去 qq_get_prompt 看角色', async () => {
  const h = await bridgeHarness({
    config: { allow: { groups: ['456'] } },
    files: { 'roles/测试鱼.md': CARD, 'state/current-role.json': JSON.stringify({ role: '测试鱼', mode: 'active' }) },
  });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(321, 1, '在吗'), h.cfg);
    const prompt = await h.buildWakePromptV2('group:456', { reason: 'mention' });
    const file = path.join(h.temp, 'state/role-card-v2.md');
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.includes('小鱼干') && !written.includes('config.json'), written);
    assert.ok(!String(prompt).includes('【当前角色】'), '人格卡在系统提示里时不再写【当前角色】那行');
  } finally { await h.close(); }
});

await test('bridge：systemPromptCard.enabled=false 回到旧做法（文件写空，唤醒里有【当前角色】）', async () => {
  const h = await bridgeHarness({
    config: { allow: { groups: ['456'] }, socialV2: { systemPromptCard: { enabled: false } } },
    files: { 'roles/测试鱼.md': CARD, 'state/current-role.json': JSON.stringify({ role: '测试鱼', mode: 'active' }) },
  });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', msg(321, 1, '在吗'), h.cfg);
    const prompt = await h.buildWakePromptV2('group:456', { reason: 'mention' });
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/role-card-v2.md'), 'utf8'), '');
    assert.ok(String(prompt).includes('【当前角色】测试鱼'), String(prompt).slice(0, 400));
  } finally { await h.close(); }
});

await test('bridge：发给 extras 的心情/生活/自洽请求带上人格卡开头那句和她的名字', async () => {
  const card = ['# 角色卡：测试鱼', '', '> 语气是一个**爱睡觉**、慢吞吞的小孩。', '', '## 一、我是谁', '我是测试鱼。'].join('\n');
  const h = await bridgeHarness({
    config: { allow: { groups: ['456'] } },
    files: { 'roles/测试鱼.md': card, 'state/current-role.json': JSON.stringify({ role: '测试鱼', mode: 'active' }) },
  });
  try {
    h.setMode('reserved2');
    assert.ok(h.currentRoleHintV2().includes('> 语气是'), '二代人格卡留着引用行');
    assert.equal(h.personaBriefV2(), '爱睡觉、慢吞吞的小孩');
    const body = h.withSelfV2('/life/plan', { date: '2026-10-24' });
    assert.equal(body.persona, '爱睡觉、慢吞吞的小孩');
    assert.equal(body.date, '2026-10-24');
    assert.ok(body.bot, '带名字');
    assert.deepEqual(h.withSelfV2('/memory/told', { key: 'k', text: 't' }), { key: 'k', text: 't' }, '别的接口不带');
    h.cfg.socialV2.life = { ...(h.cfg.socialV2.life || {}), persona: '  配置里写的人设  ' };
    assert.equal(h.withSelfV2('/self/check', {}).persona, '配置里写的人设', 'life.persona 优先');
  } finally { await h.close(); }
});

await test('主人标记：不写管理员和 QQ 号', async () => {
  const label = async (config) => {
    const h = await bridgeHarness({ config: { ownerQQ: '123', allow: { groups: ['456'] }, ...config } });
    try {
      h.setMode('reserved2');
      await h.handleIncoming('group', '456', msg(123, 1, '说话'), h.cfg);
      const st = h.getSocialV2State('group:456');
      return [...(st.unread || []), ...(st.recentMessages || [])].filter((m) => m.isOwner).at(-1)?.ownerLabel ?? '';
    } finally { await h.close(); }
  };
  const plain = await label({});
  assert.ok(plain.startsWith('主人') && !plain.includes('管理员') && !plain.includes('123'), plain);
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
