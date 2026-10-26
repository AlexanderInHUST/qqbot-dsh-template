// 截图默认截她正用着的标签页（src/browser-tabs.js）
import assert from 'node:assert/strict';
import { browserOfTool, notePageFromResult, pickScreenshotTab } from '../src/browser-tabs.js';

assert.equal(browserOfTool('mcp__sandbox-browser__browser_navigate'), 'play');
assert.equal(browserOfTool('mcp__sandbox-browser-chat__browser_click'), 'chat');
assert.equal(browserOfTool('mcp__extras__bili_watch'), null);

// 2026-10-23 11:23：她新开 about:blank 画小游戏，旁边开着 tophub、下厨房、Poki
const newTab = `### Result
- 0: [今日热榜官网](https://tophub.today/)
- 1: [下厨房](https://www.xiachufang.com/category/51761/)
- 2: [Bubble Storm - 免费在线玩! | Poki (宝玩)](https://poki.com/zh/g/bubble-storm)
- 3: (current) [](about:blank)
### Ran Playwright code
\`\`\`js
await page.goto('about:blank');
\`\`\``;
let last = notePageFromResult(null, newTab, 1);
assert.deepEqual(last, { index: 3, title: '', url: 'about:blank', at: 1 });

// 截图、evaluate 的结果里没有标签列表：不变
last = notePageFromResult(last, '### Result\n- [Screenshot of viewport](../../tmp/pw-out/x.png)', 2);
assert.equal(last.index, 3);
assert.equal(last.at, 1);

// 只有 Page URL（在当前页里跳转）：沿用序号
const nav = notePageFromResult({ index: 2, title: 'a', url: 'https://a.com/', at: 1 }, '### Page\n- Page URL: https://b.com/x\n- Page Title: B 站\n', 5);
assert.deepEqual(nav, { index: 2, title: 'B 站', url: 'https://b.com/x', at: 5 });
assert.equal(notePageFromResult(null, '- Page URL: https://c.com/').index, null);

const tabs = [
  { index: 0, title: '今日热榜官网', url: 'https://tophub.today/' },
  { index: 1, title: '下厨房', url: 'https://www.xiachufang.com/category/51761/' },
  { index: 2, title: 'Poki', url: 'https://poki.com/zh/g/bubble-storm' },
  { index: 3, title: '', url: 'about:blank' }
];
// 以前截的是 Poki，现在截她的 about:blank
assert.equal(pickScreenshotTab(tabs, last).index, 3);
// 没记录时按老规矩
assert.equal(pickScreenshotTab(tabs, null).index, 2);
// 序号变了（前面的页关掉了），按网址找
assert.equal(pickScreenshotTab(tabs, { index: 5, url: 'https://tophub.today/' }).index, 0);
// 她那页已经关了：老规矩
assert.equal(pickScreenshotTab(tabs, { index: 4, url: 'https://gone.example/' }).index, 2);
// 同一网址开了两页：序号对上的优先，否则最后一个
const dup = [...tabs, { index: 4, title: '', url: 'about:blank' }];
assert.equal(pickScreenshotTab(dup, { index: 3, url: 'about:blank' }).index, 3);
assert.equal(pickScreenshotTab(dup, { index: 9, url: 'about:blank' }).index, 4);
// 只有空白页
assert.equal(pickScreenshotTab([{ index: 0, title: '', url: 'about:blank' }], null).index, 0);
assert.equal(pickScreenshotTab([], last), null);

console.log('test-browser-tabs: ok');
