// DSH 的 session.v4.jsonl.zstd 是一串追加写的 zstd 帧，逐帧解开拼起来（要 Node 22.15+ 的 zlib.zstdDecompressSync）
const zlib = require('zlib');
const fs = require('fs');
const [, , src, dst] = process.argv;
const buf = fs.readFileSync(src);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) starts.push(i);
const out = [];
let bad = 0;
for (let k = 0; k < starts.length; k++) {
  try { out.push(zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length))); } catch { bad++; }
}
fs.writeFileSync(dst, Buffer.concat(out));
if (bad) console.error(`${src}: ${bad} 个帧解不开（多半是帧内容里恰好出现了魔数，已跳过）`);
