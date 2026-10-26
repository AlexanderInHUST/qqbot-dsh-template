// qqbot_agent：自由时间玩什么。
//
// 以前她几乎只刷 B 站和沙雕图。现在桥接每次自由时间从“活动菜单”里按权重抽几样当作“这次冒出来的念头”
// 写进唤醒提示，最近玩得多的那几样权重减半（按最近几次自由时间的记录），所以每次的念头都不太一样。
// 念头只是建议，她想去哪还是她自己定。
//
// cfg.socialV2.proactive.activities 可以整个替换默认菜单：
//   [{ id, name, hint, deep?, weight?, hosts?: ['example.com'], tools?: ['tg_look'] }, ...]
// hosts / tools 用来把她实际看过的东西归到某个活动上（记进历史，下次少推一点）。
// deep 是这一样怎么往深里玩：她以前每样只碰一下就想走，劝她接着玩时优先说这个，而不是让她换下一样。

export const DEFAULT_ACTIVITIES = [
  { id: 'bili', name: '刷 B 站', weight: 1, hosts: ['bilibili.com'], tools: ['bili_watch'],
    hint: '从首页推荐刷起 https://www.bilibili.com/ ，每个视频用 bili_watch 看',
    deep: '看完往下翻翻评论区，喜欢这个 UP 主就点进主页再看几个，或者顺着右边推荐一直点下去' },
  { id: 'tg', name: '翻沙雕图', weight: 1, tools: ['tg_browse', 'tg_look', 'qq_send_meme'],
    hint: 'tg_browse 翻 Telegram 沙雕图频道，tg_look 一张张看',
    deep: '用 before 参数一页页往前翻，翻到很久以前的老图，或者换一个频道翻' },
  { id: 'news', name: '看新闻', weight: 1, hosts: ['hk01.com', 'bbc.com', 'nhk.or.jp', 'web.nhk'],
    hint: '香港01 https://www.hk01.com/ 或 BBC 中文 https://www.bbc.com/zhongwen/simp ，挑奇奇怪怪的社会新闻、动物新闻点进去读完',
    deep: '一篇读完看看文末的相关新闻，再点一篇；或者换个栏目从头逛' },
  { id: 'hot', name: '看今天大家在聊啥', weight: 1, hosts: ['tophub.today'],
    hint: '今日热榜 https://tophub.today/ 一页汇总了微博、知乎、B 站、抖音、豆瓣等的热榜，点进你好奇的条目（知乎、微博本站要登录，打不开就换一条）',
    deep: '点进一条看完正文和评论，再回榜单换一条，换几个平台的榜看看' },
  { id: 'game', name: '玩网页小游戏', weight: 1.2,
    // 不给她指定玩哪个：只给几个打得开的游戏站，进去自己挑（2026-10-22 起；以前点名 2048、lichess，她就只玩这几样）。
    hosts: ['poki.com', 'crazygames.com', '4399.com', '7k7k.com', 'itch.io', 'coolmathgames.com', 'miniclip.com', 'neal.fun',
      '2048.io', 'gabrielecirulli.github.io', 'play2048.co', 'lichess.org', 'sudoku.com', 'nytimes.com'],
    hint: '去游戏站自己挑一个想玩的：Poki https://poki.com/zh 、CrazyGames https://www.crazygames.com/ 、4399 https://www.4399.com/ 、7k7k https://www.7k7k.com/ 、itch.io https://itch.io/games/platform-web ；键盘玩用 browser_press_key，要点要拖就按截图上的位置用 browser_mouse_click_xy / browser_mouse_drag_xy',
    deep: '一局玩到输为止，输了再来一局，想办法打破自己刚才的分数；玩腻了就回游戏站换一个' },
  { id: 'wiki', name: '百科漫游', weight: 1, hosts: ['moegirl.org.cn', 'wikipedia.org'],
    hint: '从一个最近看到或聊到的词开始，打开萌娘百科 https://zh.moegirl.org.cn/ 或维基百科 https://zh.wikipedia.org/ 的词条',
    deep: '词条里看到好奇的链接就点下去，一路漂下去，看看最后漂到哪' },
  { id: 'acg', name: '看番和二次元', weight: 1, hosts: ['bgm.tv', 'bangumi.tv', 'acfun.cn'],
    hint: 'Bangumi https://bgm.tv/ 的每日放送和排行、点进番剧看简介和吐槽；或者 AcFun https://www.acfun.cn/',
    deep: '一部番看完简介、角色和大家的吐槽，再点进相似的番接着看' },
  { id: 'forum', name: '逛论坛看热闹', weight: 1, hosts: ['douban.com', 'hupu.com', 'v2ex.com'],
    hint: '豆瓣小组讨论精选 https://www.douban.com/group/explore 、虎扑步行街 https://bbs.hupu.com/ 、V2EX 最热 https://www.v2ex.com/?tab=hot ，点进帖子看楼里怎么说',
    deep: '一个帖子看到楼底，再回列表点下一个，列表看完就翻下一页' },
  { id: 'space', name: '看星星', weight: 0.8, hosts: ['nasa.gov'],
    hint: 'NASA 每日天文图 https://science.nasa.gov/apod/ ，看今天的图和说明',
    deep: '一天一天往前翻，每张图都读读说明' },
  { id: 'cook', name: '看菜谱', weight: 0.7, hosts: ['xiachufang.com'],
    hint: '下厨房 https://www.xiachufang.com/ 看蛋糕、甜点和奇怪的家常菜怎么做',
    deep: '一个菜谱看完所有步骤图和大家晒的成品，再顺着相关菜谱点下去' },
  { id: 'science', name: '看科普和新奇玩意', weight: 0.8, hosts: ['guokr.com', 'sspai.com', 'ithome.com', 'xkcd.com'],
    hint: '果壳 https://www.guokr.com/ 的怪科普、少数派 https://sspai.com/ 、IT之家 https://www.ithome.com/ 、xkcd 漫画 https://xkcd.com/',
    deep: '一篇读完看看评论和文末推荐，再点一篇；xkcd 可以按 Prev 一张张往前看' },
  { id: 'curious', name: '查一个一直好奇的东西', weight: 0.8, tools: ['web_search', 'web_fetch'],
    hint: '想想最近群里聊过、你没搞懂的东西（一个梗、一个名词、一个游戏、一首歌），用 web_search 查明白',
    deep: '查明白了就打开搜到的网页读一读，顺着又冒出来的问题接着查' },
]

export function activities(cfg) {
  const list = cfg?.socialV2?.proactive?.activities
  if (!Array.isArray(list) || !list.length) return DEFAULT_ACTIVITIES
  return list.filter((a) => a && a.id && a.name && a.hint)
}

function hostMatches(hostname, host) {
  const h = String(hostname || '').toLowerCase()
  const want = String(host).toLowerCase()
  return h === want || h.endsWith(`.${want}`)
}

// 她刚做的事归到哪个活动（id）上；归不上返回 ''
export function activityOf(list, { host = '', tool = '' } = {}) {
  for (const a of list) {
    if (tool && Array.isArray(a.tools) && a.tools.some((t) => tool.endsWith(`__${t}`) || tool === t)) return a.id
    if (host && Array.isArray(a.hosts) && a.hosts.some((h) => hostMatches(host, h))) return a.id
  }
  return host ? 'other' : ''
}

// 最近几次自由时间里每个活动出现了几次（history: [{ at, kinds: { id: 次数 } }]，越新越靠后）
export function recentUse(history, recent = 6) {
  const out = {}
  for (const h of (Array.isArray(history) ? history : []).slice(-recent)) {
    for (const [id, n] of Object.entries(h?.kinds || {})) if (n > 0) out[id] = (out[id] || 0) + 1
  }
  return out
}

// 按权重不放回地抽 n 个活动；最近每玩过一次（按自由时间次数算）权重减半
// mult：额外的权重系数 { 活动id: 系数 }（她更喜欢的、合她心情的，见 inner-life.js 的 activityMultipliers）
export function pickActivities(list, history, n = 3, rand = Math.random, mult = {}) {
  const used = recentUse(history)
  const pool = list.map((a) => ({ a, w: Math.max(0, Number(a.weight ?? 1)) * 0.5 ** (used[a.id] || 0) * Math.max(0, Number(mult[a.id] ?? 1)) }))
  const out = []
  while (out.length < n) {
    const total = pool.reduce((s, p) => s + p.w, 0)
    if (total <= 0) break
    let r = rand() * total
    const i = pool.findIndex((p) => (r -= p.w) < 0)
    const [p] = pool.splice(i < 0 ? pool.length - 1 : i, 1)
    out.push(p.a)
  }
  return out
}

export function ideasText(picked) {
  if (!picked.length) return ''
  return `这次脑子里冒出来的几个念头（只是念头，挑一个、换着来、或者都不理自己找乐子都行）：\n${picked.map((a) => `· ${a.name}：${a.hint}${a.deep ? `；${a.deep}` : ''}`).join('\n')}`
}

// 一直在玩同一样（≥4 样里有 3/4 以上是同一个活动）时，劝她换换口味用的一句话；否则返回 ''
export function varietyHint(list, kinds, picked) {
  const entries = Object.entries(kinds || {}).filter(([id]) => id && id !== 'other')
  const total = entries.reduce((s, [, n]) => s + n, 0)
  if (total < 4) return ''
  const [topId, topN] = entries.sort((a, b) => b[1] - a[1])[0]
  if (topN / total < 0.75) return ''
  const top = list.find((a) => a.id === topId)
  const other = (picked || []).find((a) => a.id !== topId) || list.find((a) => a.id !== topId)
  if (!top || !other) return ''
  return `一直在${top.name}，要不换换口味：${other.name}（${other.hint}）。`
}
