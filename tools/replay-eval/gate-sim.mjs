// 用真实聊天记录粗略模拟回复门控（src/reply-gate.js）会叫她几次、她会占多少比例。
//   node tools/replay-eval/gate-sim.mjs /tmp/replay-eval/history.json <qq-bridge 源码目录> [talkValue 覆盖，如 group:800000002=0.1]
// history.json 由 fetch-history.py 生成。模拟很粗：
//   · 别人的消息按真实时间进来，她自己的真实发言丢掉，换成模拟的；
//   · 3 秒没人说话算一批；@/引用/叫名字是强制唤醒，她按 0.91 的概率回；
//   · 其他批次过门控，放行后她按估计的概率回（这就是那个概率的含义）；
//   · 回的话 bubbles 条，8 秒后发出；回完就走，不守着（第二步要的就是这个）。
// 真实情况里别人的话有一部分是在接她的话，她说得少了别人也会少，所以模拟出来的占比会偏低一点。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [histFile, srcDir, ...overrides] = process.argv.slice(2);
const gateMod = await import(pathToFileURL(path.join(srcDir, 'src/reply-gate.js')).href);
const { DynamicReplyGate, talkValueFor } = gateMod;
const hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
const homeGroups = ['1100000001'];
const names = ['鱼妹', '小鱼', '🐟姐'];
const gateCfg = { talkValue: { private: 1, home: 0.8, group: 0.15, byKey: {} } };
for (const o of overrides) {
  const [k, v] = o.split('=');
  if (k === 'home' || k === 'group') gateCfg.talkValue[k] = Number(v);
  else gateCfg.talkValue.byKey[k] = Number(v);
}
const bubbles = Number(process.env.BUBBLES || 1.4);
const seedRand = (() => { let s = Number(process.env.SEED || 7); return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); })();

for (const [key, rows] of Object.entries(hist.conversations)) {
  if (!key.startsWith('group:') || !rows.length) continue;
  const home = homeGroups.includes(key.slice(6));
  const freq = talkValueFor(key, gateCfg, { home });
  const others = rows.filter((r) => !r.isSelf).map((r, i) => ({ ...r, id: `${r.time}-${i}`, time: r.time * 1000 }));
  const realSelf = rows.length - others.length;
  const gate = new DynamicReplyGate();
  const recent = [];
  let pending = [];
  let selfMsgs = 0;
  let forcedWakes = 0;
  let gateWakes = 0;
  let replies = 0;
  let busyUntil = 0;
  const flush = (now) => {
    if (!pending.length) return;
    if (now < busyUntil) return; // 她正在回，下一批再说
    const forced = pending.some((m) => m.atSelf || m.quoteSelf || names.some((n) => String(m.plain || m.text).includes(n)));
    let replyP;
    if (forced) { gate.recordForcedBatch(pending, now); forcedWakes += 1; replyP = 0.91; }
    else {
      const d = gate.evaluateBatch(pending.map((m) => ({ ...m, text: m.text })), recent, freq, now);
      if (!d.trigger) return; // 留着，下一批一起算
      gateWakes += 1;
      replyP = d.probability;
    }
    pending = [];
    if (seedRand() < replyP) {
      const n = Math.max(1, Math.round(bubbles + (seedRand() - 0.5)));
      const at = now + 8000;
      for (let i = 0; i < n; i++) recent.push({ time: at + i * 1500, isSelf: true });
      selfMsgs += n;
      replies += 1;
      gate.recordReply(at);
      busyUntil = at + n * 1500;
    } else busyUntil = now + 6000;
  };
  for (let i = 0; i < others.length; i++) {
    const m = others[i];
    recent.push({ time: m.time, isSelf: false });
    pending.push(m);
    const next = others[i + 1];
    const quietUntil = m.time + 3000;
    if (!next || next.time >= quietUntil) flush(quietUntil);
  }
  const hours = (others.at(-1).time - others[0].time) / 3600000;
  const share = selfMsgs / (selfMsgs + others.length);
  const realShare = realSelf / rows.length;
  console.log(`${key}${home ? '（家里）' : ''} talk=${freq} ${hours.toFixed(1)} 小时 别人 ${others.length} 条`);
  console.log(`  真实：她 ${realSelf} 条，占 ${(realShare * 100).toFixed(0)}%`);
  console.log(`  模拟：强制唤醒 ${forcedWakes}、门控放行 ${gateWakes}、回了 ${replies} 次 ${selfMsgs} 条，占 ${(share * 100).toFixed(0)}%，每小时回 ${(replies / hours).toFixed(1)} 次`);
}
