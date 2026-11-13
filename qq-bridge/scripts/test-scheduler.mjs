// src/scheduler.js：到点才跑、async 没做完不叠、出错按名字记且同样的错不刷屏、同名替换、firstDelayMs 0 马上跑；
// at / after 到点跑一次就没了、同名改时间、fn 里能再登记下一次、远的时间不会提前跑
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

// 一次性的
let f = 0;
s.at('f', t + 3000, () => { f += 1; });
assert.equal(s.dueAt('f'), t + 3000);
t += 2999; s.tick();
assert.equal(f, 0);
t += 1; s.tick();
assert.equal(f, 1);
assert.ok(!s.has('f'), '跑完就没了');
t += 10000; s.tick();
assert.equal(f, 1);
assert.equal(s.dueAt('f'), 0);
// 同名改时间
let g = 0;
s.after('g', 1000, () => { g += 1; });
s.after('g', 5000, () => { g += 10; });
t += 1000; s.tick();
assert.equal(g, 0, '改成了 5 秒后');
t += 4000; s.tick();
assert.equal(g, 10);
// fn 里用同一个名字排下一次（续期）
let h = 0;
const again = () => { h += 1; if (h < 3) s.after('h', 1000, again); };
s.after('h', 1000, again);
for (let i = 0; i < 5; i++) { t += 1000; s.tick(); }
assert.equal(h, 3);
// 24 天以外的也照样等（setTimeout 会当成 1 毫秒）
let far = 0;
s.at('far', t + 30 * 86400000, () => { far += 1; });
t += 1000; s.tick();
assert.equal(far, 0);
t += 30 * 86400000; s.tick();
assert.equal(far, 1);
// 出错也照样摘掉，状态里标 once
s.after('boom', 0, () => { throw new Error('一次性坏了'); });
assert.equal(s.status().find((j) => j.name === 'boom').once, true);
s.tick();
assert.ok(!s.has('boom'));
assert.ok(logs.some((m) => m.includes('[定时] boom 出错：一次性坏了')));
assert.throws(() => s.at('bad', NaN, () => {}));

assert.throws(() => s.every('bad', 0, () => {}));
s.stop();
console.log('test-scheduler OK');
