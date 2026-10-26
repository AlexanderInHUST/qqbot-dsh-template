// qqbot_agent：按天存的日志 state/logs/bridge-YYYY-MM-DD.log，每行带 MM-DD，旧的按天删
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 放一个 40 天前的，启动写第一行时要被删掉；昨天的留着
const old = new Date(Date.now() - 40 * 86400000);
const oldName = `bridge-${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}.log`;
const y = new Date(Date.now() - 86400000);
const yName = `bridge-${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}.log`;
const bridge = await bridgeHarness({ files: { [`state/logs/${oldName}`]: 'x\n', [`state/logs/${yName}`]: 'y\n' } });
try {
  bridge.log('测试一行', { a: 1 });
  bridge.log('第二行');
  const dir = path.join(bridge.temp, 'state', 'logs');
  const file = path.join(dir, `bridge-${day}.log`);
  assert.ok(fs.existsSync(file), '当天的日志文件要有');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > 0, '启动时写过日志');
  for (const line of lines) assert.match(line, /^\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[bridge\] /, line);
  assert.ok(!fs.existsSync(path.join(dir, oldName)), '30 天前的日志删掉');
  assert.ok(fs.existsSync(path.join(dir, yName)), '昨天的留着');
  console.log('PASS daily log');
} finally {
  await bridge.close();
}
