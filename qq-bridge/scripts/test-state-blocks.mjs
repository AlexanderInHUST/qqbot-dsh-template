// qqbot_agent：二代状态按领域分块存盘（src/state-blocks.js，2026-11-08 架构调整第 5 步）：
// 从旧的整份 social-v2.json 迁过来、只写变了的块、坏了用上一版、窗口清掉改名留着、版本新于代码另存一份、旧代码跑过又升回来重新迁。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createBlockWriter, readSocialV2State } from '../src/state-blocks.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-blocks-'));
  return { dir, legacy: path.join(dir, 'social-v2.json'), blocks: path.join(dir, 'social-v2') };
};
const readRec = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sample = () => ({
  paused: false, mood: { text: '开心', why: '画好了', at: 1, key: 'group:456', source: 'self' }, proactiveNextAt: 5,
  drawLog: [{ id: 'd1', at: 1, key: 'group:456', prompt: '狗' }], reminders: [], aliveAt: 9,
  conversations: { 'group:456': { lastUnreadSeq: 3, recentMessages: [{ text: 'hi' }] }, 'play:main': { lastUnreadSeq: 0 } },
});

test('桥接：从旧的整份迁到分块，旧文件改名；重启读回来一样', async () => {
  const legacy = {
    mood: { text: '有点困', why: '', at: Date.now() - 60000, key: 'group:456', source: 'self' },
    drawLog: [{ id: 'd1', at: Date.now() - 1000, key: 'group:456', from: 'group:456', prompt: '一只狗', ok: true }],
    tellNotes: [{ id: 't1', to: 'group:456', at: Date.now() - 500, note: '晚点再玩', from: 'private:42' }],
    conversations: { 'group:456': { lastUnreadSeq: 7, lastReadThroughSeq: 7, recentMessages: [{ seq: 7, text: '在吗' }] } },
  };
  let h = await bridgeHarness({ config: { allow: { groups: ['456'] } }, files: { 'state/social-v2.json': legacy } });
  const stateDir = path.join(h.temp, 'state');
  try {
    assert.equal(fs.existsSync(path.join(stateDir, 'social-v2.json')), false, '旧文件改名了');
    assert.ok(fs.existsSync(path.join(stateDir, 'social-v2.json.pre-blocks')));
    for (const name of ['self', 'play', 'jobs', 'reminders', 'runtime']) {
      const rec = readRec(path.join(stateDir, 'social-v2', `${name}.json`));
      assert.equal(rec.block, name);
      assert.equal(rec.version, 1);
    }
    assert.equal(readRec(path.join(stateDir, 'social-v2', 'self.json')).data.mood.text, '有点困');
    assert.equal(readRec(path.join(stateDir, 'social-v2', 'jobs.json')).data.notes[0].kind, 'tell', '旧的 tellNotes 并进 notes');
    const conv = readRec(path.join(stateDir, 'social-v2', 'conversations', 'group-456.json'));
    assert.equal(conv.key, 'group:456');
    assert.equal(conv.data.lastUnreadSeq, 7);
    assert.equal(h.getSocialV2State('group:456').recentMessages[0].text, '在吗');
    // 把分块原样带到下一次启动：从分块读
    var carried = {};
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else carried[path.relative(h.temp, f)] = fs.readFileSync(f, 'utf8'); } };
    walk(path.join(stateDir, 'social-v2'));
  } finally { await h.close(); }
  h = await bridgeHarness({ config: { allow: { groups: ['456'] } }, files: carried });
  try {
    assert.equal(h.socialV2.mood.text, '有点困');
    assert.equal(h.socialV2.drawLog[0].prompt, '一只狗');
    assert.equal(h.getSocialV2State('group:456').lastUnreadSeq, 7);
  } finally { await h.close(); }
});

test('桥接：存盘只写变了的块', async () => {
  const h = await bridgeHarness({ files: { 'state/social-v2.json': { conversations: {} } } });
  try {
    const dir = path.join(h.temp, 'state', 'social-v2');
    h.getSocialV2State('group:456');
    h.flushSocialV2State();
    const stamp = (name) => fs.statSync(path.join(dir, name)).mtimeMs;
    const before = { self: stamp('self.json'), jobs: stamp('jobs.json'), conv: stamp('conversations/group-456.json') };
    await sleep(30);
    h.socialV2.mood = { text: '开心', why: '', at: Date.now(), key: 'group:456', source: 'self' };
    h.flushSocialV2State();
    assert.notEqual(stamp('self.json'), before.self, '心情那块写了');
    assert.equal(stamp('jobs.json'), before.jobs, '画画那块没动');
    assert.equal(stamp('conversations/group-456.json'), before.conv, '窗口没动');
    assert.ok(fs.existsSync(path.join(dir, 'self.prev.json')), '旧的留了一版');
  } finally { await h.close(); }
});

test('坏了的块用上一版；上一版也没有就从空的开始，坏文件留着', () => {
  const t = tmpState();
  const w = createBlockWriter(t.legacy);
  w.write(sample());
  w.write({ ...sample(), mood: { ...sample().mood, text: '难过' } });
  fs.writeFileSync(path.join(t.blocks, 'self.json'), '{"block":"self","vers'); // 写到一半
  let r = readSocialV2State(t.legacy);
  assert.equal(r.source, 'blocks');
  assert.equal(r.raw.mood.text, '开心', '退回上一版');
  assert.match(r.notes.join('\n'), /self 读不出来，用了上一版/);
  assert.equal(r.raw.drawLog[0].id, 'd1', '别的块不受影响');
  fs.writeFileSync(path.join(t.blocks, 'jobs.json'), 'not json');
  fs.rmSync(path.join(t.blocks, 'jobs.prev.json'), { force: true });
  r = readSocialV2State(t.legacy);
  assert.equal(r.raw.drawLog, undefined);
  assert.ok(fs.readdirSync(t.blocks).some((n) => /^jobs\.bad-\d+\.json$/.test(n)), '坏文件改名留着');
  // 块名对不上也算坏
  fs.writeFileSync(path.join(t.blocks, 'conversations', 'group-456.json'), JSON.stringify({ block: 'conversation', key: 'group:999', version: 1, data: {} }));
  r = readSocialV2State(t.legacy);
  assert.equal(r.raw.conversations['group:456'], undefined);
  assert.equal(r.raw.conversations['play:main'].lastUnreadSeq, 0);
});

test('写到一半停电：只剩 .prev.json 就用它', () => {
  const t = tmpState();
  const w = createBlockWriter(t.legacy);
  w.write(sample());
  w.write({ ...sample(), proactiveNextAt: 6 });
  fs.rmSync(path.join(t.blocks, 'play.json'));
  const r = readSocialV2State(t.legacy);
  assert.equal(r.raw.proactiveNextAt, 5);
});

test('窗口没了改名成 .removed.json，不再读回来', () => {
  const t = tmpState();
  const w = createBlockWriter(t.legacy);
  w.write(sample());
  const s = sample();
  delete s.conversations['group:456'];
  const written = w.write(s);
  assert.ok(written.includes('-group-456.json'));
  assert.ok(fs.existsSync(path.join(t.blocks, 'conversations', 'group-456.removed.json')));
  assert.equal(readSocialV2State(t.legacy).raw.conversations['group:456'], undefined);
});

test('版本比代码新：另存一份 .v2.json 再照着读', () => {
  const t = tmpState();
  createBlockWriter(t.legacy).write(sample());
  const file = path.join(t.blocks, 'reminders.json');
  fs.writeFileSync(file, JSON.stringify({ block: 'reminders', version: 2, savedAt: 1, data: { reminders: [{ key: 'group:456', note: 'x', due: 1 }] } }));
  const r = readSocialV2State(t.legacy);
  assert.equal(r.raw.reminders.length, 1);
  assert.ok(fs.existsSync(path.join(t.blocks, 'reminders.v2.json')));
  assert.match(r.notes.join('\n'), /第 2 版（代码只认到第 1 版）/);
});

test('旧代码又写了整份 social-v2.json（回滚过）：比分块新就从它重新迁', async () => {
  const t = tmpState();
  createBlockWriter(t.legacy).write(sample());
  assert.equal(readSocialV2State(t.legacy).source, 'blocks');
  await sleep(20);
  fs.writeFileSync(t.legacy, JSON.stringify({ ...sample(), proactiveNextAt: 77 }));
  const r = readSocialV2State(t.legacy);
  assert.equal(r.source, 'legacy');
  assert.equal(r.raw.proactiveNextAt, 77);
});
