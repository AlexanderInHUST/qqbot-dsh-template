// Repair tool-call arguments where DeepSeek left a string value unquoted.
//
// 2026-11-23 23:10 in group 1100000003 she was asked what she was playing and wrote
// `{"messages": 在玩2048呀，一直在合数字方块}` nine times in a row (also once on 10-29). DSH's
// DeepSeek adapter rejects that as MALFORMED_RESPONSE "tool input is invalid JSON", the bridge's
// "write complete JSON" retry didn't help because the JSON wasn't truncated, and she went quiet
// for three minutes while the owner got three error DMs.
//
// At content_block_stop, if the tool-call JSON doesn't parse, walk the top-level object and quote
// any value that isn't valid JSON (up to the next `, "name":` or the closing brace). The repaired
// text is only used if it parses to a plain object; otherwise the original goes through and fails
// as before. block-end's block is what dsh-llm keeps, so the session records the repaired call.
// Logs only the tool name and the repaired keys (arguments carry the session token).
//
// Usage: node patch-dsh-tool-json-bare-string.mjs <path to dsh-llm-deepseek/lib/index.js>
// Fails if the anchor is gone (e.g. after a DSH upgrade) so the build stops.
import fs from 'node:fs'

const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')
const anchor = 'if (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;'
const replacement = '// qqbot_agent: see control/patch-dsh-tool-json-bare-string.mjs\n' +
  '\t\t\t\tif (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = qqbotRepairToolJson(block.json, block.content.name);'
const helper = `
// qqbot_agent: see control/patch-dsh-tool-json-bare-string.mjs
function qqbotRepairToolJson(text, name) {
	try {
		JSON.parse(text);
		return text;
	} catch {}
	const s = text.trim();
	if (!s.startsWith("{") || !s.endsWith("}")) return text;
	const keyRe = /\\s*("(?:[^"\\\\]|\\\\.)*")\\s*:\\s*/y;
	const nextKeyRe = /,\\s*"[A-Za-z_][A-Za-z0-9_]*"\\s*:/g;
	const parts = [];
	const fixed = [];
	let pos = 1;
	while (pos < s.length - 1) {
		keyRe.lastIndex = pos;
		const km = keyRe.exec(s);
		if (!km) return text;
		const keyText = km[1];
		const start = keyRe.lastIndex;
		const ends = [];
		nextKeyRe.lastIndex = start;
		for (let m; (m = nextKeyRe.exec(s)) !== null;) ends.push(m.index);
		ends.push(s.length - 1);
		let end = -1;
		for (const e of ends) {
			try {
				JSON.parse(s.slice(start, e));
				end = e;
				break;
			} catch {}
		}
		let value;
		if (end >= 0) value = s.slice(start, end).trim();
		else {
			end = ends[0];
			const bare = s.slice(start, end).trim();
			if (!bare) return text;
			value = JSON.stringify(bare);
			try { fixed.push(JSON.parse(keyText)); } catch { return text; }
		}
		parts.push(keyText + ": " + value);
		pos = end + 1;
	}
	if (!fixed.length) return text;
	const out = "{" + parts.join(", ") + "}";
	try {
		const parsed = JSON.parse(out);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
	} catch {
		return text;
	}
	console.warn("[qqbot] repaired tool-call JSON for " + String(name) + ": quoted bare value of " + fixed.join(", "));
	return out;
}
`
if (src.split(anchor).length !== 2) {
  console.error(`patch-dsh-tool-json-bare-string: anchor not found in ${file}; re-check after the DSH upgrade`)
  process.exit(1)
}
fs.writeFileSync(file, src.replace(anchor, replacement) + helper)
console.log('patched', file)
