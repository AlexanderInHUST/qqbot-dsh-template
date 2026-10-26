// 鱼妹的会话压缩时，用中文、用她自己的口吻记笔记。
//
// dsh-compaction-basic 的压缩指令是给写代码的助手准备的英文模板（Primary Request / Files and Code /
// Pending Jobs …，还要求“保留精确的标识符、数值”），压缩完她的会话里就只剩一份英文工程摘要，
// 里面还抄着会话令牌、messageId、seq 和工具名。压缩后她说话越来越像客服、像在汇报，也会把这些编号说出来。
//
// 这个补丁只改 qq-chat-v2 / qq-play 两个 preset 的会话（看被压缩那段的系统提示认出来），
// 别的会话（黑话学习等）照旧：
// - 压缩指令换成中文、第一人称的“自己记的笔记”，分几块：我是谁在哪、最近在聊什么、大家、答应了还没做的、
//   我做过看过的、要记住的规矩；不抄令牌、messageId、seq、工具名，合并旧笔记；
// - 笔记前面的说明换成中文；
// - 笔记里 32~48 位十六进制的串（会话令牌）一律换成“（令牌）”，每次唤醒提示里都有新的令牌，不需要记。
// 另外（对所有会话）：配了单独的压缩模型时，它失败了就换回这次聊天用的模型再压一次。
//
// 用法：node patch-dsh-compaction-qq.mjs <dsh-compaction-basic/lib/index.js 的路径>
// 锚点对不上（DSH 升级后）就失败退出，免得悄悄不生效。
import fs from 'node:fs'

const file = process.argv[2]
let src = fs.readFileSync(file, 'utf8')

function replaceOnce(anchor, replacement) {
  const parts = src.split(anchor)
  if (parts.length !== 2) {
    console.error(`patch-dsh-compaction-qq: 锚点出现 ${parts.length - 1} 次（应为 1）：${anchor.slice(0, 80)}；DSH 升级后请重新核对 ${file}`)
    process.exit(1)
  }
  src = parts.join(replacement)
}

const helpers = `
// ── qqbot_agent：鱼妹的会话用中文笔记压缩（见 control/patch-dsh-compaction-qq.mjs） ──
const QQ_COMPACTION_MARKERS = ["【二代仿真模式", "现在是你自己的自由时间"];
function qqCompactionStyle(messages) {
	const head = Array.isArray(messages) ? messages[0] : void 0;
	if (head === void 0 || head === null) return false;
	let text;
	try { text = typeof head.content === "string" ? head.content : JSON.stringify(head.content ?? head); } catch { return false; }
	return QQ_COMPACTION_MARKERS.some((marker) => text.includes(marker));
}
const QQ_COMPACTION_INSTRUCTION = [
	"先停一下，不用回任何人。上面这一大段聊天要收起来了，用你自己的口吻给自己记一份笔记，之后接着聊的时候只看得到这份笔记和后面的新消息。",
	"",
	"用中文、第一人称（“我”）记，像日记或者备忘，按下面几块写，每块几条短句，没有的写“（没有）”：",
	"",
	"【我是谁、在哪】我在哪个群或者和谁私聊，这里平时什么气氛。",
	"【最近在聊什么】最近几件事和话题，谁说了什么、我怎么接的、聊到哪了；最后那段写细一点。",
	"【大家】这段里出现的人：怎么称呼、是什么样的人、和我什么关系、有什么事要记得（QQ 号可以写在名字后面括号里）。",
	"【我答应过还没做完的】答应了谁什么、说了待会儿要干什么、托了自由时间的我去看什么。",
	"【我做过、看过的】我发过的图、看过的视频和网页、玩过的游戏、搜过的东西，记住是什么样子就好。",
	"【要记住的规矩】主人和大家明确交代过的事、被纠正过的说法和称呼，照原话的意思记。",
	"",
	"规矩：",
	"- 只写笔记本身，不要调用任何工具，不要提“压缩”“总结”“笔记”这件事。",
	"- 不抄会话令牌、messageId、seq、水位、工具名和参数这类编号和术语；它们每次唤醒都会重新给。",
	"- 不写“用户”“助手”“AI”“模型”“系统提示”；我就是我，别人就写名字。",
	"- 前面要是已经有一份 " + SUMMARY_OPEN_TAG + " 包着的旧笔记，把还有用的并进来、过时的删掉，合成一份，不要整段照抄。",
	"- 事情是什么时候的，写上几月几号几点（比如“10月24日 15:20 左右”），不写“今天”“昨天”“刚才”“待会儿”：这份笔记要用好几天，过了一天这些说法就不对了。消息和唤醒提示里都标着日期和时间；旧笔记里没写日期的，能推出是哪天就补上，推不出来就写“之前”。",
	"- 不用 Markdown 标题和加粗，每块用上面的【】开头，下面每条一行，用“- ”开头。"
].join("\\n");
const QQ_CHECKPOINT_PREAMBLE = "（这是之前一段聊天的笔记，是你自己记的。里面的事都发生过，接着往下聊就好，不用提起这份笔记。）";
const QQ_TOKEN_RE = /\\b[0-9a-f]{32,48}\\b/gi;
function qqRedactSummary(summary) {
	return summary.map((block) => block && typeof block.text === "string" ? { ...block, text: block.text.replace(QQ_TOKEN_RE, "（令牌）") } : block);
}
`

// 1. 辅助函数放在 CHECKPOINT_PREAMBLE 后面（要用到 SUMMARY_OPEN_TAG）
replaceOnce(
  'const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint',
  helpers.trimStart() + 'const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint',
)
// 2. 压缩指令
replaceOnce(
  '\t\t\ttext: COMPACTION_INSTRUCTION\n',
  '\t\t\ttext: qqCompactionStyle(input.messages) ? QQ_COMPACTION_INSTRUCTION : COMPACTION_INSTRUCTION\n',
)
// 3. 摘要里的令牌
replaceOnce(
  '\tconst summary = summaryText(rawOutput);\n',
  '\tconst summary = qqCompactionStyle(input.messages) ? qqRedactSummary(summaryText(rawOutput)) : summaryText(rawOutput);\n',
)
// 4. 外面那层说明
replaceOnce(
  'function frameSummary(summary) {\n\treturn [\n\t\t{\n\t\t\ttype: "text",\n\t\t\ttext: `${CHECKPOINT_PREAMBLE}\\n\\n${SUMMARY_OPEN_TAG}`\n',
  'function frameSummary(summary, input) {\n\treturn [\n\t\t{\n\t\t\ttype: "text",\n\t\t\ttext: `${qqCompactionStyle(input?.messages) ? QQ_CHECKPOINT_PREAMBLE : CHECKPOINT_PREAMBLE}\\n\\n${SUMMARY_OPEN_TAG}`\n',
)
replaceOnce(
  '\t\tcontent: frameSummary(summaryResult.summary),\n',
  '\t\tcontent: frameSummary(summaryResult.summary, prepared.input),\n',
)

// 5. 配了单独的压缩模型（summarizationProvider/Model，现在是 aiohub 的 Claude）时，它调不通（额度、网络、
//    中转站拒收某段历史…）就换回这次聊天用的模型再压一次，免得压缩一直失败、上下文越堆越大。
replaceOnce(
  'async function summarizeWithLlm(ctx, config, input, agent, signal) {\n\tconst latest',
  `async function summarizeWithLlm(ctx, config, input, agent, signal) {
	try {
		// 图还是太大（pi-ai 另有 20MB 的总字节上限）就按它说的张数再多省掉几张旧图重试
		let qqImageDrop = 0;
		for (let attempt = 0; ; attempt++) {
			try {
				return await qqSummarizeOnce(ctx, { ...config, qqImageDrop }, input, agent, signal);
			} catch (error) {
				const more = Number(error?.failure?.offloadImages) || 0;
				if (!config.summarizationProvider || error?.code !== "IMAGE_OFFLOAD_REQUIRED" || more <= 0 || attempt >= 3 || signal?.aborted) throw error;
				qqImageDrop += more;
			}
		}
	} catch (error) {
		if (!config.summarizationProvider || signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		ctx.logger.warn(\`compaction with \${config.summarizationProvider}/\${config.summarizationModel} failed: \${message.slice(0, 300)}; retrying with the routed model\`);
		// ctx.logger 不进容器日志，再打一份到 stderr，docker compose logs dsh 才看得到
		console.warn(\`[compaction-qq] \${config.summarizationProvider}/\${config.summarizationModel} 压缩失败，换回聊天的模型再压：\${message.slice(0, 500)}\`);
		return await qqSummarizeOnce(ctx, { ...config, summarizationProvider: "", summarizationModel: "" }, input, agent, signal);
	}
}
async function qqSummarizeOnce(ctx, config, input, agent, signal) {
	const latest`,
)

// 6. 单独的压缩模型走 pi-ai，一次请求最多 DSH_PI_AI_MAX_REQUEST_IMAGES 张图（现在 28），超了直接报
//    IMAGE_OFFLOAD_REQUIRED；聊天请求有 image-offload 插件兜着，压缩这一下没有。play:main 一段里常有八九十张截图，
//    2026-10-24 它每次都是 Claude 失败、悄悄换回 DeepSeek 压的。所以给单独的压缩模型发之前只留最后几张图，
//    前面的换成一句“[图片]”（笔记只要记住看了什么，旧截图的文字说明都还在）。用聊天的模型压时照旧。
replaceOnce(
  '\tconst messages = [...input.messages, deepFreeze({\n',
  '\tconst messages = [...(configured === void 0 ? input.messages : qqLimitImages(input.messages, config.qqImageDrop)), deepFreeze({\n',
)
replaceOnce(
  'const QQ_CHECKPOINT_PREAMBLE = ',
  `function qqLimitImages(messages, extraDrop = 0) {
	const cap = Number(process.env.DSH_COMPACTION_MAX_IMAGES) > 0 ? Number(process.env.DSH_COMPACTION_MAX_IMAGES) : Number(process.env.DSH_PI_AI_MAX_REQUEST_IMAGES) > 4 ? Number(process.env.DSH_PI_AI_MAX_REQUEST_IMAGES) - 4 : 20;
	let total = 0;
	for (const m of messages) if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "image") total++;
	let drop = Math.max(0, total - cap) + (Number(extraDrop) || 0);
	if (drop <= 0) return messages;
	return messages.map((m) => {
		if (drop <= 0 || !Array.isArray(m?.content) || !m.content.some((b) => b?.type === "image")) return m;
		const content = m.content.map((b) => {
			if (drop <= 0 || b?.type !== "image") return b;
			drop--;
			return { type: "text", text: "[图片]" };
		});
		return { ...m, content };
	});
}
const QQ_CHECKPOINT_PREAMBLE = `,
)

fs.writeFileSync(file, src)
console.log('patched', file)
