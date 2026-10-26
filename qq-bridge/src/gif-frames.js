// qqbot_agent：动图转宫格。DeepSeek 收到 image/gif 只看得到第一帧（2026-10-22 实测），
// 所以把动图均匀抽几帧拼成一张 PNG 宫格再给模型，并在文字里说明顺序。需要镜像里有 ffmpeg/ffprobe。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(String(stdout));
  });
});

/** 均匀挑 n 个帧序号（含首尾）。 */
export function pickFrameIndices(total, n) {
  const count = Math.max(0, Math.min(Math.floor(total) || 0, Math.floor(n) || 0));
  if (count <= 0) return [];
  if (count === 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (total - 1) / (count - 1))))];
}

/** 宫格的列数和行数：3 帧以内排一行，再多每行 3 张。 */
export function sheetLayout(n) {
  const cols = n <= 3 ? Math.max(1, n) : 3;
  return { cols, rows: Math.ceil(n / cols) };
}

/**
 * 动图 → { buffer(PNG), frames(原帧数), picked(抽了几帧), cols, rows }；静态图或出错返回 null（调用方按原图处理）。
 * 只处理 GIF 和带动画的 WebP；opts.maxFrames 默认 6，opts.frameWidth 默认 320。
 */
export async function animatedSheet(buffer, mimeType, opts = {}) {
  if (!buffer?.length || !['image/gif', 'image/webp'].includes(mimeType)) return null;
  if (mimeType === 'image/webp' && !buffer.includes(Buffer.from('ANIM'))) return null;
  const maxFrames = Math.max(2, Math.min(12, Number(opts.maxFrames) || 6));
  const frameWidth = Math.max(80, Math.min(640, Number(opts.frameWidth) || 320));
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-'));
  const input = path.join(dir, mimeType === 'image/gif' ? 'in.gif' : 'in.webp');
  const output = path.join(dir, 'sheet.png');
  try {
    fs.writeFileSync(input, buffer);
    const probed = await run(opts.ffprobe || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', input], timeoutMs);
    const frames = parseInt(probed.trim(), 10);
    if (!Number.isFinite(frames) || frames < 2) return null;
    const picked = pickFrameIndices(frames, maxFrames);
    const { cols, rows } = sheetLayout(picked.length);
    const select = picked.map((i) => `eq(n\\,${i})`).join('+');
    await run(opts.ffmpeg || 'ffmpeg', ['-v', 'error', '-y', '-i', input,
      '-vf', `select='${select}',scale='min(${frameWidth},iw)':-2,tile=${cols}x${rows}:padding=6:margin=0:color=white`,
      '-fps_mode', 'passthrough', '-frames:v', '1', output], timeoutMs);
    const sheet = fs.readFileSync(output);
    if (!sheet.length) return null;
    return { buffer: sheet, frames, picked: picked.length, cols, rows };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 给模型看的说明文字。 */
export function sheetNote(sheet) {
  return `（动图，共 ${sheet.frames} 帧；按播放顺序均匀抽了 ${sheet.picked} 帧拼成 ${sheet.cols}×${sheet.rows} 宫格，从左到右、从上到下看就是它的动作）`;
}
