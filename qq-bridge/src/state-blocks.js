// qqbot_agent：二代状态按领域分块存盘（2026-11-08，架构调整第 5 步）。
// 以前整份写在 state/social-v2.json（五百多 KB），群里来一条消息就把心情、日记、画画记录、所有会话全重写一遍；
// 哪块写坏了整份读不出来，迁移字段也只能整份一起动。现在：
//   state/social-v2/self.json        她自己：心情、生活、睡觉、头像、说过的自己的事、不在、答应了先不玩、打游戏歇着
//   state/social-v2/play.json        自由时间：玩过的、读过的、分享、下次检查时间（看过的视频以 extras 为准，2026-11-09 起不存）
//   state/social-v2/jobs.json        要等一会儿的活：画画、做视频的记录、留话、别人头像的描述
//   state/social-v2/reminders.json   提醒
//   state/social-v2/runtime.json     暂停、回复门控窗口、最后活着的时间
//   state/social-v2/conversations/<group-123|private-42|play-main>.json   每个窗口一份
// 每份是 { block, version, savedAt, data }（窗口的还带 key）。存盘时只写内容变了的块；
// 写之前把旧的改名成 <名字>.prev.json，读到坏的（半截、不是 JSON、块名对不上）就用 .prev.json，
// 窗口没了改名成 .removed.json（不删）。版本号比代码认得的新（回滚了代码），先另存一份 .v<N>.json 再照着读。
// 没有分块、或者旧的 social-v2.json 比分块新（回滚到旧代码跑过一阵又升回来），就从 social-v2.json 迁过来，
// 迁完把它改名成 social-v2.json.pre-blocks。要回到旧代码：node scripts/social-v2-blocks.mjs assemble 拼回一份。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_BLOCKS = {
  self: { version: 1, fields: ['mood', 'life', 'sleptAt', 'sleptKey', 'upLateAt', 'selfAvatar', 'selfClaims', 'away', 'playHold', 'gameRest'] },
  play: { version: 1, fields: ['freeTimeHistory', 'readPages', 'playShares', 'playLog', 'playStartedAt', 'playEndedAt', 'lastPlaySay', 'playSessions', 'proactiveNextAt'] },
  jobs: { version: 1, fields: ['drawLog', 'videoLog', 'notes', 'avatarDescs'] },
  reminders: { version: 1, fields: ['reminders'] },
  runtime: { version: 1, fields: ['paused', 'replyGates', 'aliveAt'] },
};
export const CONVERSATION_VERSION = 1;

// 版本升级：MIGRATIONS[块名][旧版本] = (data) => 下一版的 data。现在都是第 1 版，没有要升的。
// 窗口的块名是 'conversation'。
export const MIGRATIONS = { self: {}, play: {}, jobs: {}, reminders: {}, runtime: {}, conversation: {} };

export const blocksDirOf = (legacyFile) => path.join(path.dirname(legacyFile), 'social-v2');
const conversationsDirOf = (dir) => path.join(dir, 'conversations');

export function conversationFileName(key) {
  const name = String(key).replace(/:/g, '-');
  if (!/^(group|private|play)-[0-9A-Za-z_]+$/.test(name)) return null;
  return `${name}.json`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    // 旧的留一版：坏了能退回去。改名不复制，大的窗口块也不多花时间。
    try { fs.renameSync(file, prevOf(file)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

const prevOf = (file) => file.replace(/\.json$/, '.prev.json');

function readRecord(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    return error?.code === 'ENOENT' ? undefined : null; // undefined = 没有；null = 坏了
  }
}

function validRecord(rec, block, key) {
  return !!rec && typeof rec === 'object' && rec.block === block && Number.isSafeInteger(rec.version) && rec.version >= 1
    && rec.data && typeof rec.data === 'object' && (key === undefined || rec.key === key);
}

// 读一块：坏了用 .prev.json；版本新于代码的先另存；旧的按 MIGRATIONS 升上来
function loadRecord(file, block, current, notes, key) {
  let rec = readRecord(file);
  const label = key ? `窗口 ${key}` : block;
  if (rec !== undefined && !validRecord(rec, block, key)) {
    const prev = readRecord(prevOf(file));
    if (validRecord(prev, block, key)) {
      notes.push(`${label} 读不出来，用了上一版`);
      rec = prev;
    } else {
      notes.push(`${label} 读不出来，也没有能用的上一版，这块从空的开始`);
      try { fs.renameSync(file, file.replace(/\.json$/, `.bad-${Date.now()}.json`)); } catch {}
      return null;
    }
  } else if (rec === undefined) {
    // 写到一半（旧的改了名、新的还没改过来）停了电：只剩 .prev.json
    const prev = readRecord(prevOf(file));
    if (!validRecord(prev, block, key)) return null;
    notes.push(`${label} 只有上一版，用上一版`);
    rec = prev;
  }
  let { version, data } = rec;
  if (version > current) {
    const keep = file.replace(/\.json$/, `.v${version}.json`);
    if (!fs.existsSync(keep)) { try { fs.copyFileSync(file, keep); } catch {} }
    notes.push(`${label} 是第 ${version} 版（代码只认到第 ${current} 版），另存了 ${path.basename(keep)}，照着读`);
    return data;
  }
  while (version < current) {
    const up = MIGRATIONS[block]?.[version];
    if (typeof up !== 'function') { notes.push(`${label} 第 ${version} 版没有升级的办法，照着读`); break; }
    data = up(data);
    version += 1;
    notes.push(`${label} 升到第 ${version} 版`);
  }
  return data;
}

const hasBlocks = (dir) => Object.keys(STATE_BLOCKS).some((name) => fs.existsSync(path.join(dir, `${name}.json`)) || fs.existsSync(path.join(dir, `${name}.prev.json`)));

function newestMtime(dir) {
  let newest = 0;
  const scan = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      if (!/\.json$/.test(n) || /\.(removed|prev)\.json$|\.bad-\d+\.json$|\.v\d+\.json$/.test(n)) continue;
      try { newest = Math.max(newest, fs.statSync(path.join(d, n)).mtimeMs); } catch {}
    }
  };
  scan(dir);
  scan(conversationsDirOf(dir));
  return newest;
}

// 读出来拼成以前 social-v2.json 的样子（v2-state.js 的校验照旧用），外加从哪读的
export function readSocialV2State(legacyFile) {
  const dir = blocksDirOf(legacyFile);
  const notes = [];
  const legacyExists = fs.existsSync(legacyFile);
  let legacyMtime = 0;
  try { legacyMtime = fs.statSync(legacyFile).mtimeMs; } catch {}
  if (legacyExists && (!hasBlocks(dir) || legacyMtime > newestMtime(dir))) {
    const raw = readRecord(legacyFile);
    if (raw && typeof raw === 'object') {
      return { raw, source: 'legacy', notes: [hasBlocks(dir) ? 'social-v2.json 比分块新（旧代码跑过），从它重新迁' : '从 social-v2.json 迁到分块'] };
    }
    if (!hasBlocks(dir)) return { raw: null, source: 'legacy', notes: ['social-v2.json 读不出来'] };
  }
  if (!hasBlocks(dir)) return { raw: null, source: 'none', notes };
  const raw = { conversations: {} };
  for (const [name, spec] of Object.entries(STATE_BLOCKS)) {
    const data = loadRecord(path.join(dir, `${name}.json`), name, spec.version, notes);
    if (!data) continue;
    for (const field of spec.fields) if (field in data) raw[field] = data[field];
  }
  const cdir = conversationsDirOf(dir);
  let names = [];
  try { names = fs.readdirSync(cdir); } catch {}
  const bases = new Set();
  for (const n of names) {
    const m = n.match(/^((?:group|private|play)-[0-9A-Za-z_]+)(?:\.prev)?\.json$/);
    if (m) bases.add(m[1]);
  }
  for (const base of bases) {
    const key = base.replace('-', ':');
    const data = loadRecord(path.join(cdir, `${base}.json`), 'conversation', CONVERSATION_VERSION, notes, key);
    if (data) raw.conversations[key] = data;
  }
  return { raw, source: 'blocks', notes };
}

// 文件指纹：加载期间别的进程写过（误开了第二个桥接）就不回写
export function socialV2Stamp(legacyFile) {
  const dir = blocksDirOf(legacyFile);
  const parts = [];
  const add = (f) => { try { const s = fs.statSync(f); parts.push(`${path.basename(f)}:${s.size}:${s.mtimeMs}`); } catch {} };
  add(legacyFile);
  for (const name of Object.keys(STATE_BLOCKS)) add(path.join(dir, `${name}.json`));
  let names = [];
  try { names = fs.readdirSync(conversationsDirOf(dir)); } catch {}
  for (const n of names.sort()) if (/^(group|private|play)-[0-9A-Za-z_]+\.json$/.test(n)) add(path.join(conversationsDirOf(dir), n));
  return parts.length ? parts.join('|') : null;
}

// 写盘的那一侧：记着每块上次写的内容，只写变了的
export function createBlockWriter(legacyFile) {
  const dir = blocksDirOf(legacyFile);
  const cdir = conversationsDirOf(dir);
  const lastWritten = new Map(); // 文件 -> 上次写的 data 的 JSON
  const writeIfChanged = (file, rec) => {
    const body = JSON.stringify(rec.data);
    if (lastWritten.get(file) === body && fs.existsSync(file)) return false;
    writeAtomic(file, JSON.stringify({ ...rec, savedAt: Date.now() }, null, 2) + '\n');
    lastWritten.set(file, body);
    return true;
  };
  // state 是拼好的旧样子（flushSocialV2State 里组的那个对象）；返回写了哪些
  function write(state) {
    const written = [];
    for (const [name, spec] of Object.entries(STATE_BLOCKS)) {
      const data = {};
      for (const field of spec.fields) if (state[field] !== undefined) data[field] = state[field];
      if (writeIfChanged(path.join(dir, `${name}.json`), { block: name, version: spec.version, data })) written.push(name);
    }
    const keep = new Set();
    for (const [key, data] of Object.entries(state.conversations || {})) {
      const fname = conversationFileName(key);
      if (!fname) continue;
      keep.add(fname);
      if (writeIfChanged(path.join(cdir, fname), { block: 'conversation', key, version: CONVERSATION_VERSION, data })) written.push(key);
    }
    // 窗口没了（控制台清了这个会话）：改名留着，不删
    let names = [];
    try { names = fs.readdirSync(cdir); } catch {}
    for (const n of names) {
      if (!/^(group|private|play)-[0-9A-Za-z_]+\.json$/.test(n) || keep.has(n)) continue;
      const file = path.join(cdir, n);
      try { fs.renameSync(file, file.replace(/\.json$/, '.removed.json')); } catch {}
      try { fs.unlinkSync(prevOf(file)); } catch {}
      lastWritten.delete(file);
      written.push(`-${n}`);
    }
    return written;
  }
  // 从 social-v2.json 迁完、分块都写好了，把旧文件改名，免得以后当成新的
  function retireLegacy() {
    if (!fs.existsSync(legacyFile)) return null;
    const to = `${legacyFile}.pre-blocks`;
    fs.renameSync(legacyFile, to);
    return to;
  }
  return { write, retireLegacy, dir };
}
