// 她最近老用的说法（2026-11-15，主人：“有些话似乎反复说？句式有点雷同？”）。
// 11-11~11-15 她的话里“跟它较劲 / 死磕”“通了第一个喊你”“截图给你看”“跟最好成绩一样快”越来越多，
// 小群里一开口总是“爸爸！”。模型自己看不出自己在重复（每次唤醒只看到这一处最近的几十条），
// 所以 bridge 数一数她这几天在各处说过的话，把用了好几回的说法告诉她（src/app/phrasing.js）。
// 这里只有纯函数：数短语、看开头。

// 断句：标点、空白都断开；[截图:…] [表情包:…] 这些媒体标记、@某人、网址先去掉
const MEDIA_RE = /\[[^\]]{0,200}\]/g;
const URL_RE = /https?:\/\/\S+/g;
const AT_RE = /@\S+/g;
const SPLIT_RE = /[\s，,。.！!？?～~、；;：:…—\-－（）()【】「」『』“”"'‘’《》<>/|·*#]+/u;

export function segmentsOf(text) {
  return String(text ?? '')
    .replace(MEDIA_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(AT_RE, ' ')
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

function gramsOf(text, minLen, maxLen) {
  const out = new Set();
  for (const seg of segmentsOf(text)) {
    for (let n = minLen; n <= Math.min(maxLen, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) out.add(seg.slice(i, i + n));
    }
  }
  return out;
}

/**
 * 她用了好几回的说法。
 * groups：她说过的话，一组是一段（连着发的几条），同一段里重复的只算一回，免得一段话里反复提一个关卡名就算“老说”。
 *   每组是字符串数组，或 { lines, tag }。tag 写“哪处|哪天”：只在同一处、同一天说的（“八个箱子”）多半是那会儿在聊的事，
 *   至少 minSpread 个不同的 tag 才算口头禅（没给 tag 的每组算一个）；同一处同一天说了 sameCount 回以上的也算
 *   （11-15 小群一天说了 5 回“跟最好成绩一样快”）。
 * exclude：别人说过的话（字符串数组）。别人也说过的多半是在聊的话题（游戏名、关卡名），不算她的口头禅。
 * stopWords：含这些词的不算（叫爸爸妈妈是称呼，不是句式）。
 * 返回 [{ text, count }]，次数多的在前，最多 maxShow 条；被更长的、次数不少于它的说法包住的不单列。
 */
export function repeatedPhrases(groups, {
  minLen = 4, maxLen = 12, minCount = 3, minSpread = 2, sameCount = 4, maxShow = 5, exclude = [], stopWords = ['爸爸', '妈妈'],
} = {}) {
  const cnt = new Map();
  const tags = new Map();
  groups.forEach((g, i) => {
    const lines = Array.isArray(g) ? g : Array.isArray(g?.lines) ? g.lines : [g];
    const tag = g && !Array.isArray(g) && g.tag ? String(g.tag) : `#${i}`;
    const seen = new Set();
    for (const line of lines) {
      if (/^\s*\[/.test(String(line ?? ''))) continue; // 整条是图、表情、画
      for (const x of gramsOf(line, minLen, maxLen)) seen.add(x);
    }
    for (const x of seen) {
      cnt.set(x, (cnt.get(x) || 0) + 1);
      if (!tags.has(x)) tags.set(x, new Set());
      tags.get(x).add(tag);
    }
  });
  const others = exclude.map((t) => segmentsOf(t).join(' ')).join('\n');
  const plain = (g) => !/[0-9A-Za-z]/.test(g) // 带数字、字母的是关卡、分数、型号
    && new Set(g).size > 2 // 哈哈哈哈、嘿嘿嘿嘿
    && !stopWords.some((w) => g.includes(w))
    && !others.includes(g);
  const kept = new Map();
  for (const [g, c] of cnt) {
    if (c < minCount) continue;
    if ((tags.get(g)?.size || 0) < minSpread && c < sameCount) continue;
    if (plain(g)) kept.set(g, c);
  }
  // 包住它的长说法少几回也用长的（“最好成绩一”4 回 / “最好成绩一样快”3 回，多的那回是“一模一样”），别给她看半截话
  const longer = (g, c) => {
    let best = null;
    for (const [h, d] of cnt) {
      if (h === g || !h.includes(g) || d < minCount || d * 4 < c * 3 || !plain(h)) continue;
      if (!best || h.length > best[0].length || (h.length === best[0].length && d > best[1])) best = [h, d];
    }
    return best;
  };
  const grown = new Map();
  for (const [g, c] of kept) {
    const [h, d] = longer(g, c) ?? [g, c];
    grown.set(h, Math.max(grown.get(h) || 0, d));
  }
  // 被包住的短的、次数不比它多的不单列
  const maximal = [...grown].filter(([g, c]) => ![...grown].some(([h, d]) => h !== g && h.includes(g) && d >= c));
  maximal.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  // 次数一样、互相重叠的（“跟它较劲” / “它较劲呀”）只留一条
  const out = [];
  for (const [g, c] of maximal) {
    if (out.some((x) => overlaps(x.text, g))) continue;
    out.push({ text: g, count: c });
    if (out.length >= maxShow) break;
  }
  return out;
}

function overlaps(a, b) {
  const k = 3;
  for (let i = 0; i + k <= b.length; i++) if (a.includes(b.slice(i, i + k))) return true;
  return false;
}

// 一段话的开头：第一条里第一个叹号、波浪号、逗号前面那几个字（最多 5 个字），“爸爸！”“诶——”“哈哈哈”这种
export function openerOf(firstLine) {
  const s = String(firstLine ?? '').replace(MEDIA_RE, '').trim();
  const m = s.match(/^(.{1,5}?)[！!～~，,—]/u);
  return m ? m[1].trim() : '';
}

/**
 * 最近几段话是不是总一个开头。bursts：按时间排好的几段话（每段是字符串数组），只看最后 last 段。
 * 返回 { text, count } 或 null。
 */
export function repeatedOpener(bursts, { last = 5, minCount = 3 } = {}) {
  const tail = bursts.filter((b) => Array.isArray(b) && b.length).slice(-last);
  const cnt = new Map();
  for (const b of tail) {
    const first = b.find((l) => !/^\s*\[/.test(String(l ?? '')));
    const o = openerOf(first);
    if (o) cnt.set(o, (cnt.get(o) || 0) + 1);
  }
  let best = null;
  for (const [text, count] of cnt) if (count >= minCount && (!best || count > best.count)) best = { text, count };
  return best;
}

/** 她这次发的话里用到了哪几个老说法 */
export function phrasesUsed(lines, phrases) {
  const text = (Array.isArray(lines) ? lines : [lines]).map((l) => segmentsOf(l).join(' ')).join('\n');
  return phrases.filter((p) => text.includes(p.text));
}
