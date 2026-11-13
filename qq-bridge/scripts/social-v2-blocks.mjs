#!/usr/bin/env node
// 看 / 拼二代状态的分块（src/state-blocks.js）。在 bridge 容器里跑：
//   node scripts/social-v2-blocks.mjs status              每块的版本、大小、上次存盘时间
//   node scripts/social-v2-blocks.mjs assemble [输出文件]  拼回以前的整份 social-v2.json（回滚到旧代码前用；不填就写 state/social-v2.json）
// 状态目录默认 /opt/qq-bridge/state，换地方用 STATE_DIR=…
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_BLOCKS, blocksDirOf, readSocialV2State } from '../src/state-blocks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state');
const LEGACY = path.join(STATE_DIR, 'social-v2.json');
const [cmd, out] = process.argv.slice(2);

if (cmd === 'status') {
  const dir = blocksDirOf(LEGACY);
  const show = (file) => {
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const kb = (fs.statSync(file).size / 1024).toFixed(1);
      console.log(`${path.relative(STATE_DIR, file).padEnd(44)} v${rec.version}  ${kb.padStart(7)} KB  ${new Date(rec.savedAt).toISOString()}`);
    } catch (error) { console.log(`${path.relative(STATE_DIR, file).padEnd(44)} 读不出来：${error?.message ?? error}`); }
  };
  for (const name of Object.keys(STATE_BLOCKS)) show(path.join(dir, `${name}.json`));
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'conversations')); } catch {}
  for (const n of names.sort()) if (/^(group|private|play)-[0-9A-Za-z_]+\.json$/.test(n)) show(path.join(dir, 'conversations', n));
  if (fs.existsSync(LEGACY)) console.log(`还有旧的整份 ${LEGACY}（下次启动会从它迁）`);
} else if (cmd === 'assemble') {
  const { raw, source, notes } = readSocialV2State(LEGACY);
  for (const n of notes) console.error(n);
  if (!raw) { console.error(`没有可拼的状态（${source}）`); process.exit(1); }
  const target = out || LEGACY;
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  console.log(`拼好了：${target}（来自 ${source}，${Object.keys(raw.conversations || {}).length} 个窗口）`);
} else {
  console.error('用法：node scripts/social-v2-blocks.mjs status | assemble [输出文件]');
  process.exit(2);
}
