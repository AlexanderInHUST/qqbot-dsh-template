// qqbot_agent：动图抽帧拼宫格（模型只看得到 GIF 第一帧）。没装 ffmpeg 时只测纯函数。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { animatedSheet, pickFrameIndices, sheetLayout, sheetNote } from '../src/gif-frames.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

await test('均匀抽帧：含首尾、不重复、不超过总帧数', () => {
  assert.deepEqual(pickFrameIndices(60, 6), [0, 12, 24, 35, 47, 59]);
  assert.deepEqual(pickFrameIndices(3, 6), [0, 1, 2]);
  assert.deepEqual(pickFrameIndices(1, 6), [0]);
  assert.deepEqual(pickFrameIndices(0, 6), []);
  assert.deepEqual(sheetLayout(6), { cols: 3, rows: 2 });
  assert.deepEqual(sheetLayout(2), { cols: 2, rows: 1 });
  assert.ok(sheetNote({ frames: 60, picked: 6, cols: 3, rows: 2 }).includes('动图'));
});

await test('静态图和非动图格式原样返回 null', async () => {
  assert.equal(await animatedSheet(Buffer.from('not an image'), 'image/jpeg'), null);
  assert.equal(await animatedSheet(Buffer.from('RIFF....WEBPVP8 '), 'image/webp'), null, '没有 ANIM 块的 webp 是静态图');
  assert.equal(await animatedSheet(Buffer.alloc(0), 'image/gif'), null);
});

await test(hasFfmpeg ? '真动图：拼成一张 PNG 宫格' : '真动图（跳过：没有 ffmpeg）', async () => {
  if (!hasFfmpeg) return;
  const gif = '/tmp/test-gif-frames.gif';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', gif]);
  const sheet = await animatedSheet(fs.readFileSync(gif), 'image/gif');
  fs.rmSync(gif, { force: true });
  assert.ok(sheet, '应该生成宫格');
  assert.equal(sheet.frames, 20);
  assert.equal(sheet.picked, 6);
  assert.equal(sheet.buffer.subarray(1, 4).toString(), 'PNG');
  // 一帧的 GIF 不算动图
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=80x60', '-frames:v', '1', gif]);
  assert.equal(await animatedSheet(fs.readFileSync(gif), 'image/gif'), null);
  fs.rmSync(gif, { force: true });
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
