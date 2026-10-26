// qqbot_agent：别人发的表情包是在用图说话。以前一律写成 [图片]，提示词又让她“描述、吐槽”，
// 她每次都在评价画面（“粉色帽子抱着奶瓶”）。现在标成 [表情包]，看图结果附上对方发之前的几句、
// 问她对方想说什么；收藏里也有这张就带上她记的用法。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage, isStickerMedia, stickerSummaryText } from '../src/qq-model-view.js';
import { buildStickerContext, buildStickerStrategyHint, findSticker } from '../src/sticker-lib.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
const MD5 = '0123456789ABCDEF0123456789ABCDEF';
const STICKERS = [
  { id: 'st-1', resId: 'st-1', md5: MD5, url: 'https://public.invalid/st1.gif', desc: '黄狗得意笑', usage: '得逞了、坏笑', tags: ['得意'] },
  { id: 'st-2', resId: 'st-2', md5: 'FEDCBA9876543210FEDCBA9876543210', url: 'https://public.invalid/st2.gif', desc: '猫猫躺平' },
];
const KEY = 'group:456';

async function fixture(run, extra = {}) {
  const h = await bridgeHarness({
    config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456'] }, socialV2: {
      wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, ...extra,
    } },
    files: { 'state/stickers.json': STICKERS },
    globals: { safeFetchBuffer: async () => ({ buffer: GIF, mimeType: 'image/gif' }) },
  });
  h.setMode('reserved2');
  let server = null;
  const getImages = async (messageId, key = KEY) => {
    if (!server) {
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(messageId)}`, method: 'GET',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': h.getSocialV2State(key).agentToken },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end();
    });
  };
  try { await run({ h, getImages }); }
  finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const say = (h, sender, text, id, media = [], userId = '7') => h.appendSocialV2Message(KEY, sender, text, text, false, false, id, media, userId);

await test('识别表情包：sub_type 1、emoji_id、带名字的 summary 都算；普通图片、闪照不算', () => {
  assert.equal(isStickerMedia({ kind: 'image', subType: '1', summary: '[动画表情]' }), true);
  assert.equal(isStickerMedia({ kind: 'image', subType: '0', emojiId: 'abc' }), true);
  assert.equal(isStickerMedia({ kind: 'image', subType: '0', summary: '[不想干]' }), true);
  assert.equal(isStickerMedia({ kind: 'sticker' }), true);
  assert.equal(isStickerMedia({ kind: 'image', subType: '0', summary: '[图片]' }), false);
  assert.equal(isStickerMedia({ kind: 'image', subType: '0', summary: '' }), false);
  assert.equal(isStickerMedia({ kind: 'image', summary: '[闪照]' }), false);
  assert.equal(isStickerMedia({ kind: 'face', faceId: '178' }), false);
  assert.equal(stickerSummaryText('[动画表情]'), '');
  assert.equal(stickerSummaryText('[不想干]'), '不想干');
});

await test('segmentsToText：表情包写成 [表情包] / [表情包:名字]，市场表情后面那段“[名字]”文字不重复；照片还是 [图片]', () => fixture(async ({ h }) => {
  assert.equal(await h.segmentsToText([{ type: 'image', data: { file: `${MD5}.jpg`, sub_type: 1, summary: '[动画表情]' } }]), '[表情包]');
  assert.equal(await h.segmentsToText([
    { type: 'image', data: { file: 'x.gif', sub_type: 0, emoji_id: 'abc', summary: '[不想干]' } },
    { type: 'text', data: { text: '[不想干]' } },
  ]), '[表情包:不想干]');
  assert.equal(await h.segmentsToText([
    { type: 'image', data: { file: `${MD5}.jpg`, sub_type: 1, summary: '[动画表情]' } },
    { type: 'text', data: { text: '那好吧你喜欢就好' } },
  ]), '[表情包]那好吧你喜欢就好');
  assert.equal(await h.segmentsToText([{ type: 'image', data: { file: 'photo.jpg', sub_type: 0, summary: '' } }, { type: 'text', data: { text: '看我拍的' } }]), '[图片]看我拍的');
  assert.equal(await h.segmentsToText([{ type: 'mface', data: { summary: '[给你糖吃]' } }]), '[表情包:给你糖吃]');
  // 只跳紧跟在表情包后面、和名字一样的那段
  assert.equal(await h.segmentsToText([
    { type: 'image', data: { file: 'x.gif', emoji_id: 'abc', summary: '[不想干]' } },
    { type: 'text', data: { text: '真的' } },
    { type: 'text', data: { text: '[不想干]' } },
  ]), '[表情包:不想干]真的[不想干]');
}));

await test('收到的表情包和她收藏的是同一张（文件名 md5）：记 inYourStickers 带用法；给模型看的是 kind sticker', () => fixture(async ({ h }) => {
  say(h, '群友A', '[表情包]', 'm-1', [{ kind: 'image', file: `${MD5.toLowerCase()}.jpg`, url: 'https://public.invalid/a.gif', subType: '1', summary: '[动画表情]' }]);
  say(h, '群友A', '[图片]', 'm-2', [{ kind: 'image', file: `${MD5}.jpg`, url: 'https://public.invalid/p.jpg', subType: '0' }]);
  const [stk, photo] = h.getSocialV2State(KEY).recentMessages.slice(-2);
  assert.equal(stk.media[0].kind, 'image', '存的还是 image，收藏/下载照旧');
  assert.equal(stk.media[0].inYourStickers, '黄狗得意笑（你记的用法：得逞了、坏笑）');
  assert.equal(photo.media[0].inYourStickers, undefined, '照片不认');
  const view = compactModelMessage(JSON.parse(JSON.stringify(stk)));
  assert.equal(view.media[0].kind, 'sticker');
  assert.equal(view.media[0].subType, undefined);
  assert.equal(view.media[0].summary, undefined, '通用的 [动画表情] 不给');
  assert.equal(view.media[0].file, undefined);
  const named = compactModelMessage({ seq: 3, media: [{ kind: 'image', emojiId: 'abc', subType: '0', summary: '[不想干]' }] });
  assert.equal(named.media[0].kind, 'sticker');
  assert.equal(named.media[0].summary, '不想干');
  assert.equal(named.media[0].emojiId, undefined);
}));

await test('看表情包：结果里有 hint，带对方发之前的几句、自己说的话、她收藏里记的用法，叫她接意思别评价画面', () => fixture(async ({ h, getImages }) => {
  say(h, '群友B', '今天又加班', 'm-0', [], '8');
  h.recordSentMessagesV2(KEY, ['那你今晚别想打游戏了']);
  say(h, '群友A', '[表情包]那好吧你喜欢就好', 'm-1', [{ kind: 'image', file: `${MD5}.jpg`, url: 'https://public.invalid/a.gif', subType: '1', summary: '[动画表情]' }]);
  const r = await getImages('m-1');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.images[0].kind, 'sticker');
  assert.equal(r.data.images[0].inYourStickers, '黄狗得意笑（你记的用法：得逞了、坏笑）');
  const hint = r.data.hint;
  assert.match(hint, /是群友A在用图说话/);
  assert.match(hint, /你也收藏了这张：黄狗得意笑（你记的用法：得逞了、坏笑）/);
  assert.match(hint, /群友A发的时候还说了：那好吧你喜欢就好/);
  assert.match(hint, /群友A发之前：\n- 群友B：今天又加班\n- 你：那你今晚别想打游戏了/);
  assert.match(hint, /别讲图上画了什么/);
}));

await test('同一个人紧接着说的话也带上（别人插话就停）；私聊里叫“对方”不叫“私聊”', async () => {
  await fixture(async ({ h, getImages }) => {
    h.recordSentMessagesV2(KEY, ['下次给你画个会掉饼干的版本']);
    say(h, '群友A', '[表情包]', 'm-1', [{ kind: 'image', file: 'x.gif', url: 'https://public.invalid/a.gif', subType: '1' }]);
    say(h, '群友A', '好啊', 'm-2');
    say(h, '群友B', '我也要', 'm-3', [], '8');
    say(h, '群友A', '不给你', 'm-4');
    const r = await getImages('m-1');
    assert.match(r.data.hint, /群友A紧接着又说：好啊（这张图多半就是在给这句话配语气）/);
    assert.doesNotMatch(r.data.hint, /不给你/, '群友B插话以后的不算');
    assert.match(r.data.hint, /看不出来就当是在笑、在附和/);
  });
  const h = await bridgeHarness({ config: { ownerQQ: '42', allow: { private: ['42'], groups: ['456'] }, socialV2: { wake: { preSleepWaitEnabled: false }, proactive: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    const PK = 'private:42';
    h.recordSentMessagesV2(PK, ['嘿嘿，我练了好久才画圆的']);
    h.appendSocialV2Message(PK, '私聊', '[表情包]', '[表情包]', false, false, 'p-1', [{ kind: 'image', file: 'y.gif', url: 'https://public.invalid/y.gif', subType: '1' }], '42');
    h.appendSocialV2Message(PK, '私聊', '好啊', '好啊', false, false, 'p-2', [], '42');
    const hint = h.stickerIntentHintV2(PK, 'p-1', [{ kind: 'sticker' }]);
    assert.match(hint, /是对方在用图说话/);
    assert.match(hint, /对方紧接着又说：好啊/);
    assert.match(hint, /对方发之前：\n- 你：嘿嘿/);
    assert.doesNotMatch(hint, /私聊/);
  } finally { await h.close(); }
});

await test('没有前文就说有一会儿没人说话；只看 contextWindowMinutes 内的',() => fixture(async ({ h, getImages }) => {
  say(h, '群友B', '很早以前的话', 'm-0', [], '8');
  h.getSocialV2State(KEY).recentMessages.at(-1).time = Date.now() - 20 * 60000;
  say(h, '群友A', '[表情包:不想干]', 'm-1', [{ kind: 'image', file: 'abc.gif', url: 'https://public.invalid/b.gif', emojiId: 'abc', subType: '0', summary: '[不想干]' }]);
  const r = await getImages('m-1');
  assert.equal(r.data.images[0].stickerName, '不想干');
  assert.match(r.data.hint, /群友A发之前这里有一会儿没人说话了/);
  assert.doesNotMatch(r.data.hint, /很早以前/);
  assert.doesNotMatch(r.data.hint, /发的时候还说了/, '只有表情包没别的字');
  assert.doesNotMatch(r.data.hint, /你也收藏了/);
}));

await test('照片没有 hint；关掉 stickerIntent 也没有', () => fixture(async ({ h, getImages }) => {
  say(h, '群友A', '[图片]看我拍的', 'm-1', [{ kind: 'image', file: 'photo.jpg', url: 'https://public.invalid/p.jpg', subType: '0' }]);
  let r = await getImages('m-1');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.images[0].kind, 'image');
  assert.equal(r.data.hint, undefined);
  say(h, '群友A', '[表情包]', 'm-2', [{ kind: 'image', file: 'x.gif', url: 'https://public.invalid/a.gif', subType: '1' }]);
  h.cfg.socialV2.stickerIntent = { enabled: false };
  r = await getImages('m-2');
  assert.equal(r.data.images[0].kind, 'sticker');
  assert.equal(r.data.hint, undefined);
}));

await test('【可用表情包】先写用法；按“备注 —— 用法”整行传也找得到', () => {
  const ctx = buildStickerContext(STICKERS);
  assert.match(ctx, /- 黄狗得意笑 —— 得逞了、坏笑 \[得意\]/);
  assert.match(ctx, /- 猫猫躺平\n|- 猫猫躺平$/m);
  assert.equal(findSticker(STICKERS, '黄狗得意笑 —— 得逞了、坏笑 [得意]')?.id, 'st-1');
  assert.equal(findSticker(STICKERS, '黄狗得意笑')?.id, 'st-1');
  assert.equal(findSticker(STICKERS, '黄狗得意笑（用过3次）')?.id, 'st-1');
  assert.equal(findSticker(STICKERS, '没有这张 —— 随便'), null);
  assert.match(buildStickerStrategyHint(), /别人发表情包：那是 ta 在用图说话/);
});

await test('收藏时带 usage：记到本地库，下次别人发同一张就认得', () => fixture(async ({ h }) => {
  say(h, '群友A', '[表情包]', 'm-1', [{ kind: 'image', file: 'AAAA0000BBBB1111CCCC2222DDDD3333.jpg', url: 'https://public.invalid/c.gif', subType: '1' }]);
  const requests = [];
  h.bot.request = async (action, params) => {
    requests.push(action);
    if (action === 'add_custom_face') return { status: 'ok', retcode: 0, data: { emoji_id: 'st-new' } };
    if (action === 'modify_custom_face') return { status: 'ok', retcode: 0, data: {} };
    return { status: 'ok', retcode: 0, data: [...STICKERS, { emoji_id: 'st-new', md5: 'AAAA0000BBBB1111CCCC2222DDDD3333', url: 'https://public.invalid/c.gif', desc: '翻白眼' }] };
  };
  let server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/collect-sticker', method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': h.getSocialV2State(KEY).agentToken, 'content-type': 'application/json' },
      }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) })); });
      req.on('error', reject);
      req.end(JSON.stringify({ key: KEY, messageId: 'm-1', remark: '翻白眼', usage: '无语、懒得理你' }));
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(requests.includes('add_custom_face'));
    assert.equal(r.data.sticker?.usage, '无语、懒得理你');
    assert.equal(h.ownStickerTextV2({ file: 'aaaa0000bbbb1111cccc2222dddd3333.jpg' }), '翻白眼（你记的用法：无语、懒得理你）');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
