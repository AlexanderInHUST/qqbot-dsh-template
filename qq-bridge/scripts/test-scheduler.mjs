// src/scheduler.js：到点才跑、async 没做完不叠、出错按名字记且同样的错不刷屏、同名替换、firstDelayMs 0 马上跑
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';

let t = 1_000_000;
const logs = [];
const s = createScheduler({ log: (m) => logs.push(m), now: () => t, heartbeatMs: 3_600_000 });

let a = 0;
s.every('a', 5000, () => { a += 1; });
s.tick();
assert.equal(a, 0, '没到点不跑');
t += 5000; s.tick();
assert.equal(a, 1);
t += 4999; s.tick();
assert.equal(a, 1);
t += 1; s.tick();
assert.equal(a, 2);

// async 还没做完：跳过，不叠
let release;
let b = 0;
s.every('b', 1000, () => { b += 1; return new Promise((r) => { release = r; }); });
t += 1000; s.tick();
t += 1000; s.tick();
t += 1000; s.tick();
assert.equal(b, 1, '上一次没完不再起');
assert.equal(s.status().find((j) => j.name === 'b').skipped, 2);
release();
await new Promise((r) => setImmediate(r));
t += 1000; s.tick();
assert.equal(b, 2);
release();

// 出错：记名字；同样的错 10 分钟内只记一次；同步和异步的错都接住
s.every('c', 1000, () => { throw new Error('坏了'); });
s.every('d', 1000, async () => { throw new Error('异步坏了'); });
for (let i = 0; i < 5; i++) { t += 1000; s.tick(); }
await new Promise((r) => setImmediate(r));
assert.equal(logs.filter((m) => m.includes('[定时] c 出错：坏了')).length, 1);
assert.equal(logs.filter((m) => m.includes('[定时] d 出错：异步坏了')).length, 1);
assert.equal(s.status().find((j) => j.name === 'c').errors, 5);
t += 10 * 60 * 1000; s.tick();
assert.equal(logs.filter((m) => m.includes('[定时] c 出错')).length, 2, '过了 10 分钟再记一次');

// 同名替换，firstDelayMs 0 马上跑
let e1 = 0, e2 = 0;
s.every('e', 1000, () => { e1 += 1; });
s.every('e', 1000, () => { e2 += 1; }, { firstDelayMs: 0 });
assert.equal(e2, 1);
t += 1000; s.tick();
assert.equal(e1, 0);
assert.equal(e2, 2);
assert.equal(s.status().filter((j) => j.name === 'e').length, 1);
assert.ok(s.has('e'));
s.cancel('e');
assert.ok(!s.has('e'));

assert.throws(() => s.every('bad', 0, () => {}));
s.stop();
console.log('test-scheduler OK');
