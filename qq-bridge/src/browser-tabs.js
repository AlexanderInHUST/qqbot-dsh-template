// qqbot_agent：记住她在沙箱浏览器里正用着哪个标签页，截图时默认截那一页。
// playwright-mcp 的工具结果里有“### Open tabs”（她那边的当前页标着 (current)）和“- Page URL: …”。
// 截图用的是 bridge 临时连上的客户端，它自己的“当前页”和她的不是一回事，所以只能从她的工具结果里记。

const PLAY_PREFIX = 'mcp__sandbox-browser__';
const CHAT_PREFIX = 'mcp__sandbox-browser-chat__';

// 工具名属于哪个浏览器：'play'（8931）/ 'chat'（8933）/ null
export function browserOfTool(toolName) {
  const name = String(toolName || '');
  if (name.startsWith(CHAT_PREFIX)) return 'chat';
  if (name.startsWith(PLAY_PREFIX)) return 'play';
  return null;
}

// 从一次工具结果里读出她的当前页；读不出就返回 prev（不变）。
// 只有 Page URL 没有标签列表时（navigate 是在当前页里跳转），沿用上次记的序号。
export function notePageFromResult(prev, text, now = Date.now()) {
  const s = String(text || '');
  const cur = /^- (\d+): \(current\) \[(.*?)\]\((.*?)\)\s*$/m.exec(s);
  if (cur) return { index: Number(cur[1]), title: cur[2], url: cur[3], at: now };
  const page = /Page URL:\s*(\S+)/.exec(s);
  if (page) {
    const title = /Page Title:[ \t]*(.*)$/m.exec(s)?.[1]?.trim() ?? '';
    const index = prev && Number.isInteger(prev.index) ? prev.index : null;
    return { index, title, url: page[1], at: now };
  }
  return prev ?? null;
}

// 没指定标签页时截哪一页：先找她最后用的那页（序号和网址都对上；对不上就按网址找最后一个），
// 找不到再用老规矩：最后一个不是 about:blank 的网页，都没有就截最后一页（画画用的 about:blank）。
export function pickScreenshotTab(tabs, last) {
  if (!Array.isArray(tabs) || !tabs.length) return null;
  if (last && last.url) {
    const exact = tabs.find((t) => t.index === last.index && t.url === last.url);
    if (exact) return exact;
    const sameUrl = tabs.filter((t) => t.url === last.url);
    if (sameUrl.length) return sameUrl[sameUrl.length - 1];
  }
  const open = tabs.filter((t) => t.url && t.url !== 'about:blank');
  return open[open.length - 1] ?? tabs[tabs.length - 1];
}
