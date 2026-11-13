// 要等一会儿的活和留话（2026-11-08，src/app/jobs.js）：排队、做好了发出去记成她的话、告诉发起的窗口；
// tellNotes / drawNotes / videoNotes 并成 socialV2.notes。画画、做视频、捎话各自的细节在 test-draw / test-video / test-tell-myself。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { readSocialV2State } from '../src/state-blocks.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const PRIV = 'private:42';
const HOME = 'group:456';
const PLAY = 'play:main';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function harness(files = {}) {
  const h = await bridgeHarness({ files, config: {
    sendDelayMs: 0, ownerQQ: '42', homeGroups: ['456'], allow: { private: ['42'], groups: ['456'] },
    socialV2: {
      nightSleep: { enabled: false }, proactive: { enabled: false }, sticker: { enabled: false }, wake: { preSleepWaitEnabled: false },
      send: { burstIntervalMinMs: 10, burstIntervalMaxMs: 10, maxGapMs: 10, longGapProbability: 0, maxSendPerHour: 0, maxSendPerMinute: 0 },
    },
  } });
  h.setMode('reserved2');
  for (const k of [PRIV, HOME, PLAY]) {
    h.getSocialV2State(k).bootstrapSent = true;
    h.state.sessions = { ...(h.state.sessions ?? {}), [k]: `sid-${k}` };
  }
  return h;
}
const busy = (h, key) => {
  const sid = h.state.sessions[key];
  h.trackTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
  h.v2TurnStartAt.set(sid, Date.now() - 1000);
};
const steersTo = (h, key) => h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode === 'steer')
  .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));

const wakesTo = (h, key) => h.calls.prompts.filter((p) => p.sessionId === h.state.sessions[key] && p.mode !== 'steer')
  .map((p) => p.content.map((c) => String(c?.text ?? '')).join('\n'));

// 一种假的活：produce 里可以等、可以失败
function defineFake(h, { gapMs = 0, overlap = false, produce } = {}) {
  const started = [];
  h.defineJobKindV2('fake', {
    tag: '[假活]', logField: 'fakeLog', idPrefix: 'f', unit: '个', verb: '做', overlap,
    cfg: () => ({ minIntervalMs: gapMs }),
    produce: async (entry, cast) => {
      started.push({ id: entry.id, at: Date.now() });
      if (produce) await produce(entry, cast);
      return { model: 'm', parts: [{ segments: [{ type: 'text', data: { text: `做好的${entry.prompt}` } }] }], text: `[假:${entry.prompt}]` };
    },
    label: (e) => e.prompt,
    playWhat: (e) => `做了${e.prompt}`,
    resultText: (e) => `“${e.prompt}”${e.ok ? '做好了' : `没做成：${e.error}`}`,
    pendingText: (e) => `“${e.prompt}”还在做`,
    section: '假活',
    failedFooter: '没做成的照实说。',
    steerTitle: (ok) => (ok ? '假活好了' : '假活没成'),
    steerTail: () => '',
    blockedError: '不能发', sendFailedPrefix: '没发出去', restartError: '做到一半 bridge 重启了',
    wakeReason: 'fake', wakeOnFail: true,
  });
  return started;
}
async function settle(h, id) {
  for (let i = 0; i < 200; i++) {
    const e = (h.socialV2.fakeLog || []).find((x) => x.id === id);
    if (e && e.ok !== null && !h.pendingJobsV2('fake').some((x) => x.id === id)) { await sleep(30); return e; }
    await sleep(15);
  }
  throw new Error(`${id} 一直没做完`);
}

await test('做好了：发出去、记成她的话；不在聊就留话，唤醒提示写一次，投递后删掉', async () => {
  const h = await harness();
  try {
    defineFake(h);
    const { entry, ahead } = h.submitJobV2('fake', { key: HOME, from: HOME, prompt: '一只猫' });
    assert.equal(ahead, 0);
    assert.match(h.jobsPromptLineV2(HOME), /【假活】\n- “一只猫”还在做/);
    const e = await settle(h, entry.id);
    assert.equal(e.ok, true);
    const mine = h.getSocialV2State(HOME).recentMessages.at(-1);
    assert.equal(mine.isSelf, true);
    assert.equal(mine.text, '[假:一只猫]');
    assert.equal(steersTo(h, HOME).length, 0);
    assert.deepEqual(Array.from(h.socialV2.notes, (n) => [n.kind, n.id, n.to]), [['fake', entry.id, HOME]]);
    const line = h.jobsPromptLineV2(HOME);
    assert.match(line, /“一只猫”做好了/);
    assert.doesNotMatch(line, /还在做|照实说/);
    h.markNotesShownV2(HOME);
    assert.equal(h.jobsPromptLineV2(HOME), '');
    assert.equal(h.socialV2.notes.length, 0);
  } finally { await h.close(); }
});

await test('正聊着就插话，不留话；没做成又不在聊，叫她一次', async () => {
  const h = await harness();
  try {
    let fail = false;
    defineFake(h, { produce: async () => { if (fail) throw new Error('坏了'); } });
    busy(h, PRIV);
    const a = h.submitJobV2('fake', { key: PRIV, from: PRIV, prompt: '花' }).entry;
    await settle(h, a.id);
    const steers = steersTo(h, PRIV);
    assert.equal(steers.length, 1);
    assert.match(steers[0], /^【假活好了】private:42（令牌 [0-9a-f]+）“花”做好了。/);
    assert.equal(h.notesOfV2(PRIV, 'fake').length, 0);
    fail = true;
    const b = h.submitJobV2('fake', { key: HOME, from: HOME, prompt: '树' }).entry;
    const e = await settle(h, b.id);
    assert.equal(e.ok, false);
    // 叫醒她的那次唤醒里写着没做成，投递后留话删掉
    for (let i = 0; i < 100 && !wakesTo(h, HOME).length; i++) await sleep(15);
    const wakes = wakesTo(h, HOME);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0], /【假活】\n- “树”没做成：坏了\n没做成的照实说。/);
    assert.equal(h.notesOfV2(HOME, 'fake').length, 0);
  } finally { await h.close(); }
});

await test('不 overlap 的一个做完再做下一个，开做至少隔 minIntervalMs', async () => {
  const h = await harness();
  try {
    let release;
    const started = defineFake(h, { gapMs: 120, produce: (e) => (e.prompt === 'a' ? new Promise((r) => { release = r; }) : null) });
    const a = h.submitJobV2('fake', { key: HOME, from: HOME, prompt: 'a' }).entry;
    const b = h.submitJobV2('fake', { key: HOME, from: HOME, prompt: 'b' });
    assert.equal(b.ahead, 1);
    await sleep(250);
    assert.equal(started.length, 1, '第一个没做完，第二个不开始');
    release();
    await settle(h, a.id);
    await settle(h, b.entry.id);
    assert.equal(started.length, 2);
    assert.ok(started[1].at - started[0].at >= 120);
  } finally { await h.close(); }
});

await test('overlap 的开了就各做各的', async () => {
  const h = await harness();
  try {
    let release;
    const started = defineFake(h, { overlap: true, gapMs: 30, produce: (e) => (e.prompt === 'a' ? new Promise((r) => { release = r; }) : null) });
    const a = h.submitJobV2('fake', { key: HOME, from: HOME, prompt: 'a' }).entry;
    const b = h.submitJobV2('fake', { key: HOME, from: HOME, prompt: 'b' }).entry;
    await settle(h, b.id);
    assert.equal(started.length, 2);
    release();
    await settle(h, a.id);
  } finally { await h.close(); }
});

await test('留话每处有上限；捎话、画画、做视频的留话共用一份，各按各的 kind 删', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 7; i++) h.leaveNoteV2('draw', HOME, { id: `d${i}` });
    assert.deepEqual(Array.from(h.notesOfV2(HOME, 'draw'), (n) => n.id), ['d2', 'd3', 'd4', 'd5', 'd6'], '画画每处 5 条');
    for (let i = 0; i < 5; i++) h.leaveNoteV2('tell', HOME, { id: `t${i}`, from: PRIV, note: `n${i}` });
    assert.equal(h.notesOfV2(HOME, 'tell').length, 3, '捎话每处 3 条');
    h.leaveNoteV2('video', PRIV, { id: 'v1' });
    h.tellPromptLineV2(HOME);
    h.markNotesShownV2(HOME, ['tell']);
    assert.equal(h.notesOfV2(HOME, 'tell').length, 0);
    assert.equal(h.notesOfV2(HOME, 'draw').length, 5, '只删给她看过的那种');
    assert.equal(h.notesOfV2(PRIV, 'video').length, 1, '别处的不动');
  } finally { await h.close(); }
});

await test('旧的 tellNotes / drawNotes / videoNotes 读进来并成 notes，存盘只写 notes', async () => {
  const now = Date.now();
  const h = await harness({ 'state/social-v2.json': {
    tellNotes: [{ id: 't1', from: PRIV, to: HOME, note: '晚点再玩', at: now - 60000 }],
    drawNotes: [{ id: 'dx', to: HOME, at: now - 30000 }],
    videoNotes: [{ id: 'vx', to: PLAY, at: now - 20000 }],
    drawLog: [{ id: 'dx', at: now - 90000, key: HOME, from: HOME, prompt: '一只狗', ok: true }],
    videoLog: [{ id: 'vx', at: now - 90000, key: HOME, from: PLAY, prompt: '下雪', ok: true }],
  } });
  try {
    assert.deepEqual(Array.from(h.socialV2.notes, (n) => n.kind), ['tell', 'draw', 'video']);
    assert.match(h.tellPromptLineV2(HOME), /晚点再玩/);
    assert.match(h.jobsPromptLineV2(HOME), /【画画】[\s\S]*“一只狗”画好了/);
    assert.match(h.jobsPromptLineV2(PLAY), /【做视频】[\s\S]*“下雪”做好了/);
    h.flushSocialV2State();
    const saved = readSocialV2State(path.join(h.temp, 'state', 'social-v2.json')).raw;
    assert.equal(saved.tellNotes, undefined);
    assert.equal(saved.drawNotes, undefined);
    assert.equal(saved.notes.length, 3);
  } finally { await h.close(); }
});

process.exit(failures ? 1 : 0);
