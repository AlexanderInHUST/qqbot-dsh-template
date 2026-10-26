// npm test：跑 scripts/ 下所有 test-*.mjs（只用假数据，不碰真 QQ / DSH / config.json）。
//   node scripts/run-tests.mjs            本机跑（WSL / Linux）
//   node scripts/run-tests.mjs --dsh      在 dsh 容器里跑，多跑要 DSH 安装目录的那几个
//   node scripts/run-tests.mjs test-foo   只跑名字里带 test-foo 的
// 下面三类不在默认里跑，各写了原因。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const inDsh = args.includes('--dsh');
const filters = args.filter((a) => !a.startsWith('--'));

// 要连着正在跑的 bridge / DSH / QQ，或者读真的 config.json
const LIVE = new Set([
  'test-console', 'test-console-ui', 'test-dsh-auth', 'test-dsh-session-retire', 'test-dsh-v2-wait',
  'test-forward', 'test-mcp-exec', 'test-onebot-connection', 'test-stickers', 'test-v2-wait',
  'test-vision-media', 'test-setup-dsh-idempotent',
]);
// 上游的 Windows 启动器（start.bat、chcp），这里用不上
const WINDOWS = new Set(['test-console-encoding', 'test-audit-setup-guards']);
// 要装好的 DSH（/usr/local/lib/node_modules/@deepseek-ai/dsh），--dsh 时才跑
const NEEDS_DSH = new Set(['test-preset-local-tools']);
// 把别的测试串起来跑的老入口，和这里重复
const AGGREGATE = new Set(['test-audit']);

const all = fs.readdirSync(path.join(root, 'scripts'))
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .map((f) => f.replace(/\.mjs$/, ''))
  .sort();
const skipped = [];
const picked = all.filter((name) => {
  if (filters.length && !filters.some((f) => name.includes(f))) return false;
  const why = LIVE.has(name) ? 'live' : WINDOWS.has(name) ? 'windows'
    : AGGREGATE.has(name) ? 'aggregate' : (NEEDS_DSH.has(name) && !inDsh) ? 'needs-dsh' : '';
  if (why && !filters.length) { skipped.push(`${name}(${why})`); return false; }
  return true;
});

const env = { ...process.env };
if (inDsh && !env.DSH_INSTALL_MODULES) env.DSH_INSTALL_MODULES = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join('scripts', `${name}.mjs`)], { cwd: root, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ name, code: signal ? signal : code, out, ms: Date.now() - started });
    });
  });
}

// 按时钟算作息的测试互不影响，可以并行；每个都在自己的临时目录里
const limit = Math.max(1, Math.min(8, os.cpus().length - 1));
const queue = [...picked];
const results = [];
await Promise.all(Array.from({ length: limit }, async () => {
  while (queue.length) {
    const r = await run(queue.shift());
    results.push(r);
    process.stdout.write(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name} (${(r.ms / 1000).toFixed(1)}s)\n`);
  }
}));

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  console.log(`\n===== ${r.name} 退出 ${r.code}，最后 40 行 =====`);
  console.log(r.out.split('\n').slice(-40).join('\n'));
}
if (skipped.length) console.log(`\n没跑：${skipped.join(' ')}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
