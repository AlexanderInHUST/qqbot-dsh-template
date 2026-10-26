// qqbot_agent：自由时间玩什么——活动菜单抽“念头”、按最近玩过的降权、归类和计数、劝她换换口味。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ACTIVITIES, activityOf, pickActivities, recentUse, varietyHint, ideasText } from '../src/free-time.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

await test('归类：工具和网站都能归到活动上，子域名也算，认不出的网站算 other', () => {
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { tool: 'mcp__qqbot-extras__bili_watch' }), 'bili');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { tool: 'mcp__qqbot-extras__tg_look' }), 'tg');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { tool: 'mcp__web-search-safe__web_search' }), 'curious');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { host: 'www.hk01.com' }), 'news');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { host: 'zh.moegirl.org.cn' }), 'wiki');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { host: 'play2048.co' }), 'game');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { host: 'gabrielecirulli.github.io' }), 'game');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { host: 'notbilibili.com' }), 'other');
  assert.equal(activityOf(DEFAULT_ACTIVITIES, { host: 'example.org' }), 'other');
});

await test('抽念头：不重复，最近玩得多的少出现', () => {
  const picked = pickActivities(DEFAULT_ACTIVITIES, [], 3, Math.random);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((a) => a.id)).size, 3);
  // 最近 6 次自由时间都在刷 B 站：B 站权重变成 1/64，抽 2000 次几乎不该排第一
  const history = Array.from({ length: 6 }, (_, i) => ({ at: i, kinds: { bili: 5 } }));
  assert.equal(recentUse(history).bili, 6);
  let biliFirst = 0;
  for (let i = 0; i < 2000; i += 1) if (pickActivities(DEFAULT_ACTIVITIES, history, 1)[0].id === 'bili') biliFirst += 1;
  assert.ok(biliFirst < 20, `B 站被抽中 ${biliFirst} 次`);
  // 没历史时平均每样都有机会
  const counts = {};
  for (let i = 0; i < 3000; i += 1) for (const a of pickActivities(DEFAULT_ACTIVITIES, [], 3)) counts[a.id] = (counts[a.id] || 0) + 1;
  for (const a of DEFAULT_ACTIVITIES) assert.ok(counts[a.id] > 200, `${a.id} 只出现 ${counts[a.id]} 次`);
});

await test('抽念头：rand 固定时结果可复现；菜单为空或权重全 0 不死循环', () => {
  const a = pickActivities(DEFAULT_ACTIVITIES, [], 3, seq(0.1, 0.5, 0.9)).map((x) => x.id);
  const b = pickActivities(DEFAULT_ACTIVITIES, [], 3, seq(0.1, 0.5, 0.9)).map((x) => x.id);
  assert.deepEqual(a, b);
  assert.deepEqual(pickActivities([], [], 3), []);
  assert.deepEqual(pickActivities([{ id: 'x', name: 'x', hint: 'x', weight: 0 }], [], 3), []);
  assert.equal(ideasText([]), '');
  const game = DEFAULT_ACTIVITIES.find((x) => x.id === 'game');
  assert.ok(ideasText([game]).includes(game.deep), '念头里带上怎么往深里玩');
  assert.ok(DEFAULT_ACTIVITIES.every((x) => x.deep && !/\d/.test(x.deep)), '每样都有 deep，里面不带数字');
});

await test('换口味：同一样占了 3/4 以上才劝，劝的是别的活动', () => {
  const ideas = DEFAULT_ACTIVITIES.filter((a) => ['bili', 'game'].includes(a.id));
  assert.equal(varietyHint(DEFAULT_ACTIVITIES, { bili: 3 }, ideas), '', '看得还少不劝');
  assert.equal(varietyHint(DEFAULT_ACTIVITIES, { bili: 2, news: 2 }, ideas), '', '已经在换着玩不劝');
  const hint = varietyHint(DEFAULT_ACTIVITIES, { bili: 4, news: 1 }, ideas);
  assert.ok(hint.includes('刷 B 站') && hint.includes('玩网页小游戏'), hint);
});

await test('桥接：自由时间唤醒带上念头，计数游戏/新页面/搜索，劝说里换口味', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { sessionMinutes: [60, 60] } } } });
  try {
    h.setMode('reserved2');
    // 自由时间在单独的 play:main 会话里过，聊天会话不再收到 proactiveCheck
    h.getSocialV2State('private:123').bootstrapSent = true;
    await h.sendWakePromptV2('private:123', 'proactiveCheck');
    assert.equal(h.calls.prompts.length, 0, '聊天会话不在这里玩');
    const key = 'play:main';
    const st = h.getSocialV2State(key);
    await h.sendWakePromptV2(key, 'proactiveCheck');
    assert.equal(h.calls.prompts.length, 1);
    const text = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(text.includes('这次脑子里冒出来的几个念头'), '唤醒提示要有念头');
    assert.ok(text.includes('【自由时间】play:main'), '唤醒写明是自由时间、用自己的 key');
    // 怎么收尾、什么时候歇这些规矩在 qq-play 的系统提示里，不在每次的唤醒提示里重复
    assert.ok(!text.includes('【可以歇了】'), '规矩不在唤醒提示里重复');
    const playPreset = fs.readFileSync(new URL('../dsh/agent-presets/qq-play/agent.cordis.yml', import.meta.url), 'utf8');
    assert.ok(playPreset.includes('qq_mark_read(key="play:main"') && playPreset.includes('【可以歇了】'), '系统提示里讲了收尾和【可以歇了】');
    const ft = st.freeTime;
    assert.equal(ft.ideas.length, 3);
    assert.equal(h.socialV2.freeTimeHistory.at(-1).key, key, '全局历史里记一条');

    const B = 'mcp__sandbox-browser__';
    h.noteFreeTimeViewV2(key, `${B}browser_navigate`, '### Page\n- Page URL: https://play2048.co/\n');
    assert.equal(ft.seen, 0, '网站首页不算');
    for (let i = 0; i < 16; i += 1) h.noteFreeTimeViewV2(key, `${B}browser_press_key`, '### Ran Playwright code');
    assert.equal(ft.seen, 2, '同一页面操作 8 下算玩了一样');
    assert.equal(ft.kinds.game, 2);
    h.noteFreeTimeViewV2(key, `${B}browser_navigate`, '- Page URL: https://www.hk01.com/zh');
    assert.equal(ft.seen, 2, '语言首页不算');
    h.noteFreeTimeViewV2(key, `${B}browser_click`, '- Page URL: https://www.hk01.com/article/123?utm=1');
    h.noteFreeTimeViewV2(key, `${B}browser_navigate`, '- Page URL: https://zh.moegirl.org.cn/%E5%88%9D%E9%9F%B3');
    h.noteFreeTimeViewV2(key, `${B}browser_navigate`, '- Page URL: https://www.bilibili.com/video/BV1');
    h.noteFreeTimeViewV2(key, 'mcp__web-search-safe__web_search', '...');
    assert.equal(ft.seen, 5);
    assert.deepEqual({ ...ft.kinds }, { game: 2, news: 1, wiki: 1, curious: 1 });
    assert.deepEqual({ ...h.socialV2.freeTimeHistory.at(-1).kinds }, { game: 2, news: 1, wiki: 1, curious: 1 }, '历史和这次的计数是同一份');

    assert.ok(h.freeTimeTooShortV2(st) > 55, '才玩了一会儿，要劝');
    const nudge = h.freeTimeNudgeTextV2(st);
    assert.ok(nudge.includes('还早呢') && nudge.includes('标签页') && !/\d/.test(nudge.replace(/https?:\S+/g, '').replace(/2048|V2EX/g, '')), `劝说里不能有数字：${nudge}`);
    const curious = DEFAULT_ACTIVITIES.find((x) => x.id === 'curious');
    assert.equal(ft.lastKind, 'curious');
    assert.ok(nudge.includes(curious.deep) && nudge.includes('记完一笔也不代表要走'), `先劝她把刚才那样玩深：${nudge}`);
    ft.kinds.game = 9;
    assert.ok(h.freeTimeNudgeTextV2(st).includes('一直在玩网页小游戏'), '一直玩同一样就劝换口味');

    const watch = (bvid, title) => h.noteFreeTimeViewV2(key, 'mcp__qqbot-extras__bili_watch', JSON.stringify({ bvid, title, owner: 'x' }));
    watch('BV1ibpq6tE18', '8个顶级AI挑战RPG史上最恶意BOSS');
    watch('BV1aaaaaaaaa', '会开门的狗 "原声"');
    watch('BV1ibpq6tE18', '8个顶级AI挑战RPG史上最恶意BOSS');
    assert.deepEqual([...h.socialV2.watchedVideos.map((v) => v.bvid)], ['BV1aaaaaaaaa', 'BV1ibpq6tE18'], '同一个视频只记一次，挪到最新');
    const again = h.buildWakePromptV2(key, 'proactiveCheck');
    assert.ok(again.includes('最近看过的视频') && again.includes('《8个顶级AI挑战RPG史上最恶意BOSS》BV1ibpq6tE18') && again.includes('《会开门的狗 "原声"》'), again);
    for (let i = 0; i < 25; i += 1) watch(`BV1${String(i).padStart(9, '0')}`, `视频${i}`);
    assert.equal(h.socialV2.watchedVideos.length, 20, '只留最近 20 个');
  } finally { await h.close(); }
});

await test('桥接：按时间劝她多玩；到点、睡觉时间、劝了不动、被托去办事都放她走', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { sessionMinutes: [60, 60], maxSessionMinutes: 180 } } } });
  try {
    h.setMode('reserved2');
    const key = 'play:main';
    const st = h.getSocialV2State(key);
    await h.sendWakePromptV2(key, 'proactiveCheck');
    const ft = st.freeTime;
    assert.ok(Math.abs(ft.minUntil - ft.startedAt - 60 * 60000) < 1000, '这次至少玩一小时');
    const B = 'mcp__sandbox-browser__';
    let n = 0;
    const view = () => h.noteFreeTimeViewV2(key, `${B}browser_navigate`, `- Page URL: https://www.hk01.com/article/${++n}`);
    // 每次劝之前都看了新东西：一直劝，不会被“劝了不动”放走
    for (let i = 0; i < 10; i += 1) { view(); assert.ok(h.freeTimeTooShortV2(st) > 0, `第 ${i + 1} 次`); }
    assert.ok(!('freeTimeItemsLeft' in st), '不往她那边漏数字');
    // 连着劝了 3 次她都没再看东西：放她走
    assert.ok(h.freeTimeTooShortV2(st) > 0);
    assert.ok(h.freeTimeTooShortV2(st) > 0);
    assert.equal(h.freeTimeTooShortV2(st), 0, '劝了不动就算了');
    view();
    assert.ok(h.freeTimeTooShortV2(st) > 0, '又玩起来了就重新算');
    // 到了这次定的时间就不劝
    ft.minUntil = Date.now() - 1;
    assert.equal(h.freeTimeTooShortV2(st), 0);
    ft.minUntil = Date.now() + 30 * 60000;
    view();
    assert.ok(h.freeTimeTooShortV2(st) > 0);
    // 睡觉时间不劝
    h.cfg.socialV2.nightSleep = { enabled: true, from: '00:01', to: '00:00' };
    view();
    assert.equal(h.freeTimeTooShortV2(st), 0, '睡觉时间不劝');
    h.cfg.socialV2.nightSleep = { enabled: false };
    // 提醒里带劝说
    view();
    const reminder = h.buildWakeReminderPromptV2(key, true);
    assert.ok(reminder.includes('还早呢') && reminder.includes(st.agentToken), reminder);
    assert.ok(h.buildWakeReminderPromptV2(key).includes('qq_mark_read'));
  } finally { await h.close(); }
});

await test('桥接：读过的文章记下来，以后再打开插一句【看过了】、不算新看的；列表页、游戏、热榜不管', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { sessionMinutes: [60, 60] } } } });
  try {
    h.setMode('reserved2');
    const key = 'play:main';
    const st = h.getSocialV2State(key);
    await h.sendWakePromptV2(key, 'proactiveCheck');
    const ft = st.freeTime;
    const steers = () => h.calls.prompts.filter((p) => p.mode === 'steer');
    const B = 'mcp__sandbox-browser__';
    const nav = (url, title) => h.noteFreeTimeViewV2(key, `${B}browser_navigate`, `### Page\n- Page URL: ${url}\n${title ? `- Page Title: ${title}\n` : ''}`);
    const fetchPage = (url, title) => h.noteFreeTimeViewV2(key, 'mcp__web-search-safe__web_fetch',
      JSON.stringify({ url, statusCode: 200, truncated: true, body: `<html><head><title>${title}</title></head>` }, null, 2));

    nav('https://www.guokr.com/article/470505/', '黄鼠狼偷童鞋 - 果壳');
    nav('https://www.guokr.com/', '果壳');
    nav('https://www.guokr.com/article/470505', '黄鼠狼偷童鞋 - 果壳');
    assert.equal(ft.seen, 1);
    assert.equal(steers().length, 0, '这次刚看的，回来翻翻不打扰');
    assert.deepEqual(JSON.parse(JSON.stringify(h.socialV2.readPages.map((p) => [p.page, p.title]))), [['www.guokr.com/article/470505', '黄鼠狼偷童鞋 - 果壳']]);

    // 上次自由时间读过的：插一句，不算一样，同一篇只说一次
    h.socialV2.readPages[0].at = ft.startedAt - 3 * 3600 * 1000;
    nav('https://www.guokr.com/', '果壳');
    nav('https://www.guokr.com/article/470505', '黄鼠狼偷童鞋 - 果壳');
    assert.equal(ft.seen, 1, '看过的不算新看的一样');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(steers().length, 1);
    const text = steers()[0].content[0].text;
    assert.ok(text.startsWith('【看过了】《黄鼠狼偷童鞋 - 果壳》你') && text.includes('换一篇没看过的'), text);
    nav('https://www.guokr.com/', '果壳');
    nav('https://www.guokr.com/article/470505', '黄鼠狼偷童鞋 - 果壳');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(steers().length, 1, '同一篇只提醒一次');

    // web_fetch 抓的也记（标题从 <title> 里取），再抓一遍一样提醒
    fetchPage('https://www.ptt.cc/bbs/joke/M.1729.A.1.html', '[笑話] 冷笑話 &amp; 熱笑話 - 看板 joke');
    assert.equal(ft.seen, 2, '第一次抓算查了一样');
    assert.equal(h.socialV2.readPages.at(-1).title, '[笑話] 冷笑話 & 熱笑話 - 看板 joke');
    h.socialV2.readPages.at(-1).at = Date.now() - 40 * 60000;
    fetchPage('https://www.ptt.cc/bbs/joke/M.1729.A.1.html', '[笑話] 冷笑話 & 熱笑話 - 看板 joke');
    assert.equal(ft.seen, 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(steers().length, 2, '半小时前读过的也提醒');

    // 栏目列表页、小游戏、热榜不记
    const before = h.socialV2.readPages.length;
    nav('https://www.ptt.cc/bbs/joke/index.html', '看板 joke');
    nav('https://poki.com/zh/g/subway-surfers', 'Subway Surfers');
    nav('https://tophub.today/n/KqndgxeLl9', '微博热搜');
    assert.equal(h.socialV2.readPages.length, before);

    const wake = h.buildWakePromptV2(key, 'proactiveCheck');
    assert.ok(wake.includes('最近看过的文章、帖子（再刷到就跳过）：《[笑話] 冷笑話 & 熱笑話 - 看板 joke》、《黄鼠狼偷童鞋 - 果壳》'), wake);

    // readPages: 0 关掉
    h.cfg.socialV2.proactive.readPages = 0;
    nav('https://www.guokr.com/article/1', '另一篇');
    assert.equal(h.socialV2.readPages.length, before);
    assert.ok(!h.buildWakePromptV2(key, 'proactiveCheck').includes('最近看过的文章'));
  } finally { await h.close(); }
});

await test('桥接：被托去办的事办完就行，不劝她多玩', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { sessionMinutes: [60, 60] } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('play:main');
    await h.sendWakePromptV2('play:main', 'goPlay');
    assert.equal(st.freeTime.minUntil, 0);
    assert.equal(h.freeTimeTooShortV2(st), 0);
  } finally { await h.close(); }
});

await test('桥接：到了定的时间说一声可以歇了；玩满上限或到了睡觉时间让她收尾；各插一次', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { sessionMinutes: [60, 60], maxSessionMinutes: 180 } } } });
  try {
    h.setMode('reserved2');
    const key = 'play:main';
    const st = h.getSocialV2State(key);
    await h.sendWakePromptV2(key, 'proactiveCheck');
    assert.ok(h.isConversationBusyV2(key, st), '刚唤醒，正在玩');
    const steers = () => h.calls.prompts.filter((p) => p.mode === 'steer');
    await h.freeTimeCurfewV2();
    assert.equal(steers().length, 0, '没玩多久，不打扰');
    // 到了这次定的时间：告诉她可以歇了（走不走她定），只说一次
    st.freeTime.minUntil = Date.now() - 1;
    await h.freeTimeCurfewV2();
    assert.equal(steers().length, 1);
    const offer = steers()[0].content[0].text;
    assert.ok(offer.includes('【可以歇了】') && offer.includes('还想玩就接着玩') && offer.includes(st.agentToken), offer);
    await h.freeTimeCurfewV2();
    assert.equal(steers().length, 1, '可以歇了只说一次');
    st.freeTime.startedAt = Date.now() - 181 * 60000;
    await h.freeTimeCurfewV2();
    assert.equal(steers().length, 2);
    const text = steers()[1].content[0].text;
    assert.ok(text.includes('【玩了好久了】') && text.includes('qq_mark_read(key="play:main"') && text.includes(st.agentToken), text);
    await h.freeTimeCurfewV2();
    assert.equal(steers().length, 2, '只提醒一次');
    // 换成刚开始玩、到了睡觉时间
    st.freeTime.startedAt = Date.now();
    st.freeTime.curfewSent = false;
    h.cfg.socialV2.nightSleep = { enabled: true, from: '00:01', to: '00:00' };
    await h.freeTimeCurfewV2();
    assert.equal(steers().length, 3);
    assert.ok(steers()[2].content[0].text.includes('【该睡觉了】'));
  } finally { await h.close(); }
});

await test('桥接：别的会话最近的事带进唤醒，大群只看到私聊的条数；托自由时间去玩', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456', '789'] }, ownerTitles: { 123: '爸爸' }, socialV2: { crossSession: { summaryOnlyKeys: ['group:789'] } } } });
  try {
    h.setMode('reserved2');
    const now = Date.now();
    const msg = (sender, text, isSelf = false) => ({ sender, text, plain: text, isSelf, time: now - 60000 });
    h.getSocialV2State('private:123').recentMessages.push(msg('私聊', '晚上一起看番吗'), msg('我', '好呀', true));
    h.getSocialV2State('group:456').recentMessages.push(msg('小明', '鱼妹来打牌'));
    h.getSocialV2State('group:789');
    const toSmall = h.crossSessionBlockV2('group:456');
    assert.ok(toSmall.includes('【别处的事】') && toSmall.includes('和爸爸（QQ 123）的私聊') && toSmall.includes('爸爸：晚上一起看番吗') && toSmall.includes('你：好呀'), toSmall);
    assert.ok(!toSmall.includes('鱼妹来打牌'), '不重复自己这边的聊天');
    const toBig = h.crossSessionBlockV2('group:789');
    assert.ok(toBig.includes('鱼妹来打牌'), '群聊内容照常带');
    assert.ok(!toBig.includes('晚上一起看番吗') && !toBig.includes('爸爸') && toBig.includes('聊过 2 条'), `大群看不到私聊内容：${toBig}`);
    assert.ok(h.crossSessionBlockV2('private:123').includes('小明：鱼妹来打牌'), '私聊里看得到群里有人找她');

    const play = h.getSocialV2State('play:main');
    play.playRequests = [{ from: 'group:456', note: '看看 BV1xx 好笑就截图发回来', at: now, done: false }];
    const prompt = h.buildWakePromptV2('play:main', 'goPlay');
    assert.ok(prompt.includes('【有人托你】') && prompt.includes('BV1xx') && prompt.includes('group:456'), prompt);
    // 拼提示不算交代过：投递前还会再拼一次，那份里也得有（投递成功才标 done，见 test-go-play.mjs）
    assert.equal(play.playRequests[0].done, false);
    assert.ok(h.buildWakePromptV2('play:main', 'goPlay').includes('【有人托你】'));
    assert.ok(h.crossSessionBlockV2('group:456').includes('你从这里托自由时间的自己去：看看 BV1xx'), '聊天那边记得自己托过什么');
  } finally { await h.close(); }
});

await test('桥接：配了 homeGroups 时，普通群只看到私聊、家里群、别的群聊过几条；心情原因也不带过去', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456', '789', '999'] }, homeGroups: ['456'], ownerTitles: { 123: '爸爸' } } });
  try {
    h.setMode('reserved2');
    const now = Date.now();
    const msg = (sender, text, isSelf = false) => ({ sender, text, plain: text, isSelf, time: now - 60000 });
    h.getSocialV2State('private:123').recentMessages.push(msg('私聊', '晚上一起看番吗'));
    h.getSocialV2State('group:456').recentMessages.push(msg('阿明', '鱼妹来打牌'), msg('我', '好的爸爸', true));
    h.getSocialV2State('group:999').recentMessages.push(msg('路人', '有人玩原神吗'));
    h.getSocialV2State('group:789');
    const toOut = h.crossSessionBlockV2('group:789');
    for (const bad of ['晚上一起看番吗', '鱼妹来打牌', '好的爸爸', '有人玩原神吗', '爸爸']) assert.ok(!toOut.includes(bad), `普通群里不该有“${bad}”：${toOut}`);
    assert.ok(toOut.includes('群 456：最近') && toOut.includes('群 999：最近') && toOut.includes('私聊：最近') && toOut.includes('这里是普通群'), toOut);
    // 家里的群照常看得到私聊和别的群
    const toHome = h.crossSessionBlockV2('group:456');
    assert.ok(toHome.includes('爸爸：晚上一起看番吗') && toHome.includes('路人：有人玩原神吗'), toHome);
    assert.ok(h.crossSessionBlockV2('private:123').includes('你：好的爸爸'));

    h.socialV2.mood = { text: '开心', why: '爸爸陪我打牌', key: 'group:456', at: now - 60000, source: 'self' };
    const outNow = h.selfNowPartsV2('group:789').lines.join('\n');
    assert.ok(outNow.includes('心情：开心') && !outNow.includes('打牌'), outNow);
    assert.ok(h.selfNowPartsV2('private:123').lines.join('\n').includes('爸爸陪我打牌'), '私聊里看得到家里群的心情原因');
    h.socialV2.mood = { text: '开心', why: '小游戏通关了', key: 'play:main', at: now - 60000, source: 'self' };
    assert.ok(h.selfNowPartsV2('group:789').lines.join('\n').includes('小游戏通关了'), '玩的时候定的心情哪里都能说');
  } finally { await h.close(); }
});

await test('桥接：下次自由时间检查的时间存盘，重启后接着用；离谱的值不认', async () => {
  const next = Date.now() + 30 * 60 * 1000;
  let h = await bridgeHarness({ files: { 'state/social-v2.json': { proactiveNextAt: next, conversations: {} } } });
  try {
    assert.equal(h.socialV2.proactiveNextAt, next, '重启后读回存的时间');
    h.socialV2.proactiveNextAt = next + 1000;
    h.flushSocialV2State();
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.equal(saved.proactiveNextAt, next + 1000, '存盘时带上');
  } finally { await h.close(); }
  h = await bridgeHarness({ files: { 'state/social-v2.json': { proactiveNextAt: Date.now() + 48 * 3600 * 1000, conversations: {} } } });
  try {
    assert.equal(h.socialV2.proactiveNextAt, 0, '超过 12 小时以后的值按没存过处理');
  } finally { await h.close(); }
});

await test('桥接：状态攒一下再写，一秒内改多少次只写一回；flush 马上写', async () => {
  const h = await bridgeHarness({ files: { 'state/social-v2.json': { conversations: {} } } });
  try {
    const file = path.join(h.temp, 'state/social-v2.json');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    h.flushSocialV2State();
    const before = fs.statSync(file).mtimeMs;
    for (let i = 1; i <= 5; i++) { h.socialV2.proactiveNextAt = Date.now() + i * 60000; h.saveSocialV2State(); }
    assert.equal(fs.statSync(file).mtimeMs, before, '还没写');
    assert.notEqual(read().proactiveNextAt, h.socialV2.proactiveNextAt);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(read().proactiveNextAt, h.socialV2.proactiveNextAt, '一秒后写了最新的');
    h.socialV2.proactiveNextAt += 1;
    h.saveSocialV2State();
    h.flushSocialV2State();
    assert.equal(read().proactiveNextAt, h.socialV2.proactiveNextAt, 'flush 马上写');
    h.cfg.socialV2 = { ...(h.cfg.socialV2 || {}), stateSaveDelayMs: 0 };
    h.socialV2.proactiveNextAt += 1;
    h.saveSocialV2State();
    assert.equal(read().proactiveNextAt, h.socialV2.proactiveNextAt, 'stateSaveDelayMs 0 马上写');
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
