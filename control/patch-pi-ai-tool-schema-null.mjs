// Strip `{type: "null"}` out of `anyOf` in tool schemas sent through pi-ai's Anthropic adapter.
//
// aiohub serves gemini-4-argon over the Anthropic Messages API and converts tools to Gemini
// functionDeclarations. Gemini rejects the whole request when a property is
// `anyOf: [{...}, {type: "null"}]` ("schema didn't specify the schema type field"); checked
// 2026-10-22. Python MCP servers emit that for every `X | None` parameter (extras' memory_note,
// tg_browse) and Playwright MCP does it in browser_emulate_media. Other unions
// (number|string, string|array) and `type: [..., "null"]` are accepted.
// Dropping the null branch only loses "may be null" on optional parameters, which the model never
// needs to send, so this is applied to every model on this adapter (Claude included).
//
// Usage: node patch-pi-ai-tool-schema-null.mjs <path to pi-ai/dist/api/anthropic-messages.js>
// Fails if the anchor is gone (e.g. after a DSH upgrade) so the build stops instead of silently
// shipping a model that errors on every request.
import fs from 'node:fs'

const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')
const anchor = '            properties: schema.properties ?? {},\n'
const replacement = '            // qqbot_agent: see control/patch-pi-ai-tool-schema-null.mjs\n' +
  '            properties: qqbotDropNullUnions(schema.properties ?? {}),\n'
const helper = `
// qqbot_agent: see control/patch-pi-ai-tool-schema-null.mjs
function qqbotDropNullUnions(properties) {
    const fix = (s) => {
        if (!s || typeof s !== "object" || Array.isArray(s))
            return s;
        let out = { ...s };
        if (Array.isArray(out.anyOf)) {
            const rest = out.anyOf.filter((v) => !(v && v.type === "null"));
            if (rest.length !== out.anyOf.length && rest.length > 0) {
                delete out.anyOf;
                if (out.default === null)
                    delete out.default;
                out = rest.length === 1 ? { ...rest[0], ...out } : { ...out, anyOf: rest };
            }
        }
        for (const key of ["anyOf", "oneOf", "allOf"])
            if (Array.isArray(out[key]))
                out[key] = out[key].map(fix);
        if (out.properties && typeof out.properties === "object")
            out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, fix(v)]));
        if (out.items)
            out.items = fix(out.items);
        if (out.additionalProperties && typeof out.additionalProperties === "object")
            out.additionalProperties = fix(out.additionalProperties);
        return out;
    };
    return Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, fix(v)]));
}
`
if (src.split(anchor).length !== 2) {
  console.error(`patch-pi-ai-tool-schema-null: anchor not found in ${file}; re-check after the DSH upgrade`)
  process.exit(1)
}
fs.writeFileSync(file, src.replace(anchor, replacement) + helper)
console.log('patched', file)
