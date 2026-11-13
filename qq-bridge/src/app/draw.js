// 画画（qq_draw）、她自己发出去的图留几天（画、截图）
// 2026-10-28：以前画画是在聊天浏览器的 about:blank 里用 canvas 拼几何图形再截图，画出来是几个圆和方块。
// 现在用 aiohub 的图像模型画（先 gpt-image-2.5-flare，没了、限流、超时就换 gpt-image-2），
// 风格是八岁小孩的蜡笔画（她的人设是小孩，以后跟着年龄变，见 src/app/growth.js）。一张要一两分钟到五分钟，所以工具马上返回，
// 画好了 bridge 自己发到聊天里，再告诉她（正聊着就插一句【画好了】，不在就叫她一次）。
// 画和截图都存进 state/images，她自己那条消息带上 media，qq_get_message_images 能再看。
// 画和视频（帧图、mp4）一直留着（2026-11-10：她小时候画的，以后要能翻出来看；10-28~11-03 的 26 张已经被清掉过，从 QQ 拉回来了），
// 只有截图留 keepDays 天、最多 maxMB。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toJpeg } from '../gif-frames.js';
import { truncateText } from '../md-to-plain.js';
import { defang } from '../qq-model-view.js';
import { looksLikeImageBuffer, safeFetchBuffer } from '../safe-fetch.js';
import { SENSITIVE_RE } from '../sensitive.js';

// 风格：照着人设（八岁左右的小女孩）画蜡笔画。2026-10-27 两个模型各试了几张，都像小孩画的；
// 要像素画就画成小孩画的粗像素画。DRAW_STYLE_TAIL（不写字、适合小孩、她的描述接在后面）换成按年龄的风格时也带着。
const DRAW_STYLE_TAIL = [
  'No text, letters or signature unless the child asks for words below; if words are asked for, write them in big wobbly child handwriting.',
  'Keep it wholesome and child-appropriate.',
  'What the child wants to draw (written by the child in Chinese):',
].join('\n');
const DRAW_STYLE_DEFAULT = [
  'A drawing made by a cheerful, imaginative 8-year-old girl, drawn with crayons and colored pencils on a sheet of white drawing paper (the whole picture is the paper, slightly textured).',
  'Childlike style: simple rounded shapes, wobbly hand-drawn outlines, uneven coloring with visible crayon strokes that go a little outside the lines, bright happy colors, naive proportions (big heads, dot eyes, stick-like arms), a few little doodles such as stars, hearts or a smiling sun.',
  "It must look like a real child's drawing, not a polished illustration of a child's drawing: slightly lopsided, a bit clumsy and uneven, simple flat background, no realistic shading, no digital gradients.",
  'If the child asks for pixel art (像素画), draw it instead as simple chunky pixel art a kid would make, still cute and a little clumsy.',
  DRAW_STYLE_TAIL,
].join('\n');

const OWN_IMAGE_RE = /^(draw|shot|video)-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)$/;
// 会清的只有截图
const CLEANABLE_IMAGE_RE = /^shot-/;

export function createDraw(app) {
  const {
    PLAY_KEY, STATE_DIR, appendActivity, cfg, log
  } = app;
  // 别的模块里的，等都装好了在 link() 里拿
  let MAX_MEDIA_BYTES, castIdsV2, convLabelV2, getSocialV2State, jobPromptLineV2, markNotesShownV2, mimeFromBuffer, notesOfV2,
    pendingJobsV2, socialV2, selfSenderFieldsV2, submitJobV2, todayJobsV2, whenV2;

  const IMAGE_DIR = path.join(STATE_DIR, 'images');

  // ── 她自己发的图留几天 ─────────────────────────────────
  function ownImagesCfgV2() {
    const c = cfg.socialV2?.ownImages ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return { keepDays: Math.max(1, num(c.keepDays, 7)), maxMB: Math.max(10, num(c.maxMB, 500)) };
  }
  function ownNameV2(prefix, ext, now) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  }
  // 存一张，返回文件名（存不了返回 null，不耽误发）
  function saveOwnImageV2(prefix, buffer, now = Date.now()) {
    if (!buffer?.length || !looksLikeImageBuffer(buffer)) return null;
    try {
      const mime = mimeFromBuffer(buffer) || 'image/png';
      const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] || 'png';
      const name = ownNameV2(prefix, ext, now);
      fs.mkdirSync(IMAGE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(IMAGE_DIR, name), buffer, { mode: 0o600 });
      return name;
    } catch (error) {
      log(`[画画] 图片没存下来：${error?.message ?? error}`);
      return null;
    }
  }
  // 做好的视频本身也留一份（2026-11-10 起；以前只留抽帧拼的图）：和帧图同名、后缀 .mp4，没有帧图就自己起名。
  // 不经 readOwnImageV2（不给模型看），只是留着。返回文件名，存不了返回 null
  function saveOwnVideoV2(sheetName, buffer, now = Date.now()) {
    if (!buffer?.length) return null;
    try {
      const name = sheetName && OWN_IMAGE_RE.test(sheetName) ? sheetName.replace(/\.\w+$/, '.mp4') : ownNameV2('video', 'mp4', now);
      fs.mkdirSync(IMAGE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(IMAGE_DIR, name), buffer, { mode: 0o600 });
      return name;
    } catch (error) {
      log(`[做视频] 视频没存下来：${error?.message ?? error}`);
      return null;
    }
  }
  // 帧图对应的那份 mp4 在不在（11-10 从 aiohub 找回来的 10 段是手放进去的，记录里没写 mp4）
  function ownVideoOfV2(sheetName) {
    const s = String(sheetName ?? '');
    if (!OWN_IMAGE_RE.test(s) || !s.startsWith('video-')) return null;
    const name = s.replace(/\.\w+$/, '.mp4');
    return fs.existsSync(path.join(IMAGE_DIR, name)) ? name : null;
  }
  // 按文件名读回来（只认 saveOwnImageV2 起的名字，不会读到别的路径）；没了返回 null
  function readOwnImageV2(name) {
    const s = String(name ?? '');
    if (!OWN_IMAGE_RE.test(s)) return null;
    try {
      const buf = fs.readFileSync(path.join(IMAGE_DIR, s));
      return buf.length <= MAX_MEDIA_BYTES && looksLikeImageBuffer(buf) ? buf : null;
    } catch {
      return null;
    }
  }
  // 截图过了 keepDays 的删掉，截图总量超了 maxMB 从最旧的删；画和视频不删
  function cleanOwnImagesV2(now = Date.now()) {
    const c = ownImagesCfgV2();
    let files;
    try {
      files = fs.readdirSync(IMAGE_DIR).filter((f) => OWN_IMAGE_RE.test(f) && CLEANABLE_IMAGE_RE.test(f)).map((f) => {
        const st = fs.statSync(path.join(IMAGE_DIR, f));
        return { f, at: st.mtimeMs, size: st.size };
      }).sort((a, b) => a.at - b.at);
    } catch {
      return 0;
    }
    let total = files.reduce((n, x) => n + x.size, 0);
    const maxBytes = c.maxMB * 1024 * 1024;
    let removed = 0;
    for (const x of files) {
      if (!(now - x.at > c.keepDays * 86400000 || total > maxBytes)) continue;
      try {
        fs.rmSync(path.join(IMAGE_DIR, x.f), { force: true });
        total -= x.size;
        removed++;
      } catch {}
    }
    if (removed) log(`[画画] 清掉了 ${removed} 张过期的截图（留 ${c.keepDays} 天、最多 ${c.maxMB}MB）`);
    return removed;
  }

  // ── 画画 ─────────────────────────────────────────────────
  function drawCfgV2() {
    const c = cfg.socialV2?.draw ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    const ageStyle = String(app.growthV2?.()?.drawStyle || '').trim();
    return {
      enabled: c.enabled !== false,
      url: String(c.url || 'https://api.aiohub.org/v1/images/generations'),
      apiKeyEnv: String(c.apiKeyEnv || 'AIOHUB_API_KEY'),
      model: String(c.model || 'gpt-image-2.5-flare-2026-09-08'),
      fallbackModel: c.fallbackModel === '' || c.fallbackModel === false ? '' : String(c.fallbackModel || 'gpt-image-2'),
      size: String(c.size || '1024x1024'),
      dailyLimit: Math.max(0, num(c.dailyLimit, 100)), // 0 = 不限
      maxPending: Math.max(1, num(c.maxPending, 2)),
      minIntervalMs: Math.max(0, num(c.minIntervalMs, 60000)), // 两张开画至少隔这么久（aiohub 一分钟只能画两张）
      timeoutMs: Math.max(10000, num(c.timeoutMs, 240000)),
      fallbackTimeoutMs: Math.max(10000, num(c.fallbackTimeoutMs, 240000)),
      maxPromptChars: Math.max(20, num(c.maxPromptChars, 300)),
      // 配置里写了就用配置的；没写跟着她的年龄（src/app/growth.js，8 岁是这里的蜡笔画）
      style: typeof c.style === 'string' && c.style.trim() ? c.style.trim() : (ageStyle ? `${ageStyle}\n${DRAW_STYLE_TAIL}` : DRAW_STYLE_DEFAULT),
      jpegQuality: num(c.jpegQuality, 3),
    };
  }
  // 内容审核拒了：换模型多半也一样，不换
  const REFUSED_RE = /safety|moderation|content[_ ]?policy|violat|inappropriate|not allowed|安全|违规|审核/i;
  async function generateOnceV2(c, model, prompt, timeoutMs) {
    const apiKey = process.env[c.apiKeyEnv];
    const res = await fetch(c.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: c.size, n: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data?.data) || !data.data[0]) {
      const msg = String(data?.error?.message || data?.message || `HTTP ${res.status}`).slice(0, 200);
      const err = new Error(`${model}：${msg}`);
      err.status = res.status;
      err.refused = res.status === 400 && REFUSED_RE.test(msg);
      throw err;
    }
    const item = data.data[0];
    let buf = null;
    if (item.b64_json) buf = Buffer.from(String(item.b64_json), 'base64');
    else if (item.url) buf = (await safeFetchBuffer(String(item.url), 20 * 1024 * 1024)).buffer;
    if (!looksLikeImageBuffer(buf)) throw new Error(`${model}：返回的不是图片`);
    return buf;
  }
  // 先用 model，失败（没了、限流、超时、出错）换 fallbackModel；审核拒了不换
  async function generateV2(prompt, cast = '') {
    const c = drawCfgV2();
    const full = `${c.style}\n${prompt}${cast}`;
    const tries = [[c.model, c.timeoutMs], ...(c.fallbackModel && c.fallbackModel !== c.model ? [[c.fallbackModel, c.fallbackTimeoutMs]] : [])];
    let lastError = null;
    for (const [model, timeoutMs] of tries) {
      const t0 = Date.now();
      try {
        const buffer = await generateOnceV2(c, model, full, timeoutMs);
        log(`[画画] ${model} 画好了（${Math.round((Date.now() - t0) / 1000)} 秒）`);
        return { buffer, model };
      } catch (error) {
        const why = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `${model}：${Math.round(timeoutMs / 1000)} 秒没画完` : (error?.message ?? String(error));
        log(`[画画] ${why}${error?.refused ? '（审核没过，不换模型）' : ''}`);
        lastError = Object.assign(new Error(why), { refused: !!error?.refused });
        if (error?.refused) break;
      }
    }
    throw lastError ?? new Error('没有可用的模型');
  }

  // 一张一张画（aiohub 同时画两张会 429），排着队的最多 maxPending 张；两张开画至少隔 minIntervalMs。排队、发出去、告诉她在 jobs.js
  const drawLabelV2 = (prompt) => truncateText(String(prompt ?? '').replace(/\s+/g, ' '), 60);

  // POST /api/socialV2/draw 的主体（令牌、白名单、工具开关、play 的分享限额在 console-server 里查过了）
  // body: { prompt, caption? }；from 是调用的会话（聊天的 key，或 play:main）
  function drawV2(key, from, body, now = Date.now()) {
    const c = drawCfgV2();
    if (!c.enabled) return { ok: false, status: 403, error: '现在画不了画' };
    if (!process.env[c.apiKeyEnv]) return { ok: false, status: 503, error: '现在画不了画（画笔没准备好），跟人照实说' };
    if (!/^(group|private):\d+$/.test(String(key))) return { ok: false, status: 400, error: 'key 要填画好以后发到哪个聊天，比如 group:123' };
    const prompt = String(body?.prompt ?? '').replace(/\s+/g, ' ').trim();
    const caption = String(body?.caption ?? '').replace(/\s+/g, ' ').trim();
    if (!prompt) return { ok: false, status: 400, error: 'prompt 不能为空：写你要画什么（画面里有谁、在干嘛、什么颜色）' };
    if (prompt.length > c.maxPromptChars) return { ok: false, status: 400, error: `prompt 太长了，${c.maxPromptChars} 字以内` };
    if (caption.length > 100) return { ok: false, status: 400, error: 'caption 太长了，100 字以内' };
    if (SENSITIVE_RE.test(prompt) || (caption && SENSITIVE_RE.test(caption))) return { ok: false, status: 403, error: '内容含敏感信息，不画' };
    const people = castIdsV2(body?.people);
    if (people.error) return { ok: false, status: 400, error: people.error };
    if (c.dailyLimit && todayJobsV2('draw', now) >= c.dailyLimit) {
      return { ok: false, status: 429, error: `今天已经画了 ${c.dailyLimit} 张，画不动了，明天再画；跟人说一声手画酸了就好` };
    }
    const pending = pendingJobsV2('draw');
    if (pending.length >= c.maxPending) return { ok: false, status: 429, error: '手上还有好几张没画完，先等这几张画好' };
    if (pending.some((e) => e.key === key && e.prompt === prompt)) {
      return { ok: false, status: 409, error: '这张已经在画了，画好了会自己发出去，不用再画一遍' };
    }
    const { entry, ahead } = submitJobV2('draw', { key, from, prompt, ...(caption ? { caption } : {}), ...(people.ids.length ? { people: people.ids } : {}) }, now);
    log(`[画画] ${from} 要画（发到 ${key}${ahead ? `，前面还有 ${ahead} 张` : ''}）：${prompt}`);
    appendActivity(`${key} [画画] 开始画：${drawLabelV2(prompt)}`);
    const left = c.dailyLimit ? c.dailyLimit - todayJobsV2('draw', now) : null;
    const where = key === from ? '这里' : convLabelV2(key, socialV2.conversations.get(key));
    return {
      ok: true, queued: true, id: entry.id, ...(ahead ? { ahead } : {}),
      hint: `开始画了${ahead ? `（前面还有 ${ahead} 张在画）` : ''}：一张要一两分钟到好几分钟，画好了会自己发到${where}，到时候会告诉你。`
        + `${key === from ? '先跟对方说一声你去画了（比如“等我画一下”），别说已经画好了，' : ''}也别再调一次 qq_draw。${left !== null ? `今天还能画 ${left} 张。` : ''}`,
    };
  }

  // 发出去的图记进那边的 recentMessages（带 local，qq_get_message_images 能再看）
  function recordOwnImageV2(key, { messageId, text, file, byPlay, now = Date.now() }) {
    const st = getSocialV2State(key);
    st.recentMessages.push({
      messageId: messageId ? String(messageId) : null,
      ...selfSenderFieldsV2(byPlay),
      text,
      plain: text,
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      media: file ? [{ kind: 'image', local: file }] : [],
      hasMedia: !!file,
      forwardIds: [],
      hasForward: false,
      time: now,
    });
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    return st;
  }

  // 画好了：转成 JPEG（小了才用）、存一份，图和配的那句一起发
  async function produceDrawV2(entry, cast) {
    const { buffer, model } = await generateV2(entry.prompt, cast);
    const jpeg = await toJpeg(buffer, { quality: drawCfgV2().jpegQuality }).catch(() => null);
    const out = jpeg && jpeg.length < buffer.length ? jpeg : buffer;
    const file = saveOwnImageV2('draw', out);
    const segments = [{ type: 'image', data: { file: 'base64://' + out.toString('base64') } }];
    if (entry.caption) segments.push({ type: 'text', text: entry.caption });
    return { model, file, parts: [{ segments }], text: `[画:${drawLabelV2(entry.prompt)}]${entry.caption ? ` ${entry.caption}` : ''}` };
  }

  // 给她看的没画成的原因（不提模型名）
  function drawFailReasonV2(entry) {
    if (entry.refused) return '这个内容画不了，换个别的画吧';
    if (/没发出去|不能往那边发/.test(entry.error || '')) return '画好了，可是没发出去';
    if (/重启/.test(entry.error || '')) return '画到一半被打断了';
    return '画笔出了点毛病，没画出来';
  }
  function drawWhereV2(entry, viewer) {
    return entry.key === viewer ? '这里' : convLabelV2(entry.key, socialV2.conversations.get(entry.key));
  }
  function drawResultTextV2(entry, viewer) {
    const what = `你 ${whenV2(entry.at)} 开始画的“${defang(drawLabelV2(entry.prompt))}”`;
    if (entry.ok) {
      const look = entry.messageId && entry.key === viewer ? `（要看画成什么样用 qq_get_message_images(messageId="${entry.messageId}")）` : '';
      return `${what}画好了，已经发到${drawWhereV2(entry, viewer)}了${look}`;
    }
    return `${what}没画成：${drawFailReasonV2(entry)}`;
  }
  const DRAW_JOB = {
    tag: '[画画]', logField: 'drawLog', idPrefix: 'd', unit: '张', verb: '画', overlap: false, logFile: true,
    cfg: () => drawCfgV2(),
    produce: produceDrawV2,
    label: (e) => drawLabelV2(e.prompt),
    playWhat: (e) => `画了一张画：${truncateText(e.prompt, 30)}`,
    resultText: drawResultTextV2,
    pendingText: (e, viewer) => `你 ${whenV2(e.at)} 开始画的“${defang(drawLabelV2(e.prompt))}”还在画，画好了会自己发到${drawWhereV2(e, viewer)}`,
    section: '画画',
    failedFooter: '没画成的，等着的人还不知道，跟他们照实说一声。',
    steerTitle: (ok) => (ok ? '画好了' : '没画成'),
    steerTail: (e, to) => (to === PLAY_KEY ? '' : e.ok
      ? ' 想说一句就自然地说（比如“画好啦”）；要讲画里有什么先看一眼，别照着自己写的描述猜。'
      : ' 跟等着的人照实说一声没画好（可以等会儿再画一次），别说画好了。'),
    blockedError: '画好了，可现在不能往那边发',
    sendFailedPrefix: '画好了，但没发出去',
    restartError: '画到一半 bridge 重启了',
    wakeReason: 'draw', wakeOnFail: true,
  };
  const drawNotesOfV2 = (key, now = Date.now()) => notesOfV2(key, 'draw', now);
  const drawPromptLineV2 = (key, now = Date.now()) => jobPromptLineV2('draw', key, now);
  const markDrawShownV2 = (key) => markNotesShownV2(key, ['draw']);

  return {
    exports: {
      OWN_IMAGE_RE,
      cleanOwnImagesV2,
      drawCfgV2,
      drawNotesOfV2,
      drawPromptLineV2,
      drawV2,
      markDrawShownV2,
      ownVideoOfV2,
      readOwnImageV2,
      recordOwnImageV2,
      saveOwnImageV2,
      saveOwnVideoV2,
    },
    link() {
      ({
        MAX_MEDIA_BYTES, castIdsV2, convLabelV2, getSocialV2State, jobPromptLineV2, markNotesShownV2, mimeFromBuffer, notesOfV2,
        pendingJobsV2, socialV2, selfSenderFieldsV2, submitJobV2, todayJobsV2, whenV2
      } = app);
      app.defineJobKindV2('draw', DRAW_JOB);
    },
    start() {
      app.scheduler.every('own-images-clean', 6 * 3600 * 1000, () => cleanOwnImagesV2(), { firstDelayMs: 60 * 1000 });
    },
  };
}
