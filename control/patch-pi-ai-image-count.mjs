// Give DSH's pi-ai adapter an image-count budget.
//
// dsh-llm's shared image budget already understands `maxImages` (dsh-llm-deepseek passes it), but
// dsh-llm-pi-ai 0.2.0-rc.2 only passes `maxBytes`. Our relay rejects any request carrying more than
// 32 images ("The service could not complete the request"), so an image-heavy session gets stuck.
// With this patch, DSH_PI_AI_MAX_REQUEST_IMAGES makes pi-ai raise IMAGE_OFFLOAD_REQUIRED, and the
// shipped dsh-compaction-image-offload plugin swaps the oldest images for text placeholders.
//
// Usage: node patch-pi-ai-image-count.mjs <path to dsh-llm-pi-ai/lib/index.js>
// Fails if the anchor is gone (e.g. after a DSH upgrade) so the build stops instead of silently
// shipping without the limit.
import fs from 'node:fs'

const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')
const anchor = [
  '\t\tconst offloadImages = requiredImageOffload(split.messages, {',
  '\t\t\trepresentation: "base64",',
  '\t\t\tmaxBytes: maxRequestImageBytes',
  '\t\t}, ',
].join('\n')
const replacement = [
  '\t\tconst offloadImages = requiredImageOffload(split.messages, {',
  '\t\t\trepresentation: "base64",',
  '\t\t\tmaxBytes: maxRequestImageBytes,',
  '\t\t\t// qqbot_agent: image-count budget from the environment (see control/patch-pi-ai-image-count.mjs)',
  '\t\t\tmaxImages: Number(process.env.DSH_PI_AI_MAX_REQUEST_IMAGES) > 0 ? Number(process.env.DSH_PI_AI_MAX_REQUEST_IMAGES) : void 0,',
  '\t\t\tcountQuantum: Number(process.env.DSH_PI_AI_IMAGE_OFFLOAD_QUANTUM) > 0 ? Number(process.env.DSH_PI_AI_IMAGE_OFFLOAD_QUANTUM) : 1',
  '\t\t}, ',
].join('\n')
if (src.split(anchor).length !== 2) {
  console.error(`patch-pi-ai-image-count: anchor not found in ${file}; re-check after the DSH upgrade`)
  process.exit(1)
}
fs.writeFileSync(file, src.replace(anchor, replacement))
console.log('patched', file)
