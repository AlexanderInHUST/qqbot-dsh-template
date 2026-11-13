// 做视频（qq_make_video）：和画画（draw.js）分开，各记各的、各限各的。
// 2026-11-03：aiohub 有了 grok 的视频接口（POST /v1/videos 建任务，GET /v1/videos/{id} 查，完成后 metadata.url 是 mp4）。
// grok-imagine-video-1.5 一段 8 秒 1280×720 带声音，实测一分钟左右做好、4~5MB。
// 工具马上返回，做好了 bridge 自己下载、按 QQ 视频发到聊天里，再告诉她（正聊着就插一句【视频做好了】，不在就记着下次说；
// 没做成还叫她一次）。两段开做至少隔 minIntervalMs（默认一分钟一段），做的过程可以重叠。
// 发出去的视频抽几帧拼成一张图存进 state/images，她那条消息带上 media.local，qq_get_message_images 能看个大概；
// mp4 本身也存一份（同名 .mp4，一直留着，2026-11-10 起）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { truncateText } from '../md-to-plain.js';
import { defang } from '../qq-model-view.js';
import { SENSITIVE_RE } from '../sensitive.js';

const videoExecV2 = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(String(stdout));
  });
});

// mp4 / mov：第 4~8 字节是 ftyp
function looksLikeVideoBuffer(buf) {
  return !!buf && buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}

// 抽 4 帧拼成 2×2 的 JPEG 给她看个大概；出错返回 null
async function videoSheetV2(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const input = path.join(dir, 'in.mp4');
  const output = path.join(dir, 'sheet.jpg');
  try {
    fs.writeFileSync(input, buffer);
    const dur = parseFloat((await videoExecV2('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], 15000)).trim());
    const fps = Number.isFinite(dur) && dur > 0 ? 4 / dur : 0.5;
    await videoExecV2('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', `fps=${fps.toFixed(4)},scale=480:-2,tile=2x2:padding=6:color=white`,
      '-frames:v', '1', '-q:v', '4', output], 30000);
    const out = fs.readFileSync(output);
    return out.length && out[0] === 0xff && out[1] === 0xd8 ? out : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function createVideo(app) {
  const {
    PLAY_KEY, appendActivity, cfg, log
  } = app;
  let castIdsV2, convLabelV2, jobPromptLineV2, markNotesShownV2, notesOfV2, pendingJobsV2, saveOwnImageV2, saveOwnVideoV2, saveSocialV2State,
    socialV2, submitJobV2, todayJobsV2, whenV2;

  function videoCfgV2() {
    const c = cfg.socialV2?.video ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled !== false,
      url: String(c.url || 'https://api.aiohub.org/v1/videos').replace(/\/+$/, ''),
      apiKeyEnv: String(c.apiKeyEnv || 'AIOHUB_API_KEY'),
      model: String(c.model || 'grok-imagine-video-1.5'),
      size: String(c.size || '1280x720'),
      seconds: Math.min(15, Math.max(1, Math.round(num(c.seconds, 8)))),
      dailyLimit: Math.max(0, num(c.dailyLimit, 0)), // 0 = 不限
      maxPending: Math.max(1, num(c.maxPending, 3)),
      minIntervalMs: Math.max(0, num(c.minIntervalMs, 60000)), // 两段开做至少隔这么久
      pollMs: Math.max(20, num(c.pollMs, 5000)),
      timeoutMs: Math.max(1000, num(c.timeoutMs, 600000)),
      maxBytes: Math.max(1, num(c.maxMB, 50)) * 1024 * 1024,
      sendTimeoutMs: Math.max(10000, num(c.sendTimeoutMs, 180000)),
      maxPromptChars: Math.max(20, num(c.maxPromptChars, 500)),
      // 配置里写了就用配置的；没写跟着她的年龄（src/app/growth.js，7 岁不加）
      style: typeof c.style === 'string' && c.style.trim() ? c.style.trim() : String(app.growthV2?.()?.videoStyle || '').trim(),
    };
  }

  const REFUSED_RE = /safety|moderation|content[_ ]?policy|violat|inappropriate|not allowed|安全|违规|审核|敏感/i;
  const failMsg = (data, status) => String(data?.error?.message || data?.error || data?.fail_reason || data?.message
    || data?.metadata?.error || (status ? `HTTP ${status}` : '失败')).slice(0, 200);

  async function generateV2(entry, cast = '') {
    const c = videoCfgV2();
    const headers = { authorization: `Bearer ${process.env[c.apiKeyEnv]}`, 'content-type': 'application/json' };
    const deadline = Date.now() + c.timeoutMs;
    const res = await fetch(c.url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: c.model, prompt: `${c.style ? `${c.style}\n` : ''}${entry.prompt}${cast}`, seconds: String(entry.seconds), size: c.size }),
      signal: AbortSignal.timeout(60000),
    });
    const created = await res.json().catch(() => ({}));
    const id = String(created?.id || created?.task_id || '');
    if (!res.ok || !id) {
      const msg = failMsg(created, res.status);
      throw Object.assign(new Error(`${c.model}：${msg}`), { refused: REFUSED_RE.test(msg) });
    }
    entry.taskId = id;
    saveSocialV2State();
    let videoUrl = '';
    while (!videoUrl) {
      if (Date.now() > deadline) throw new Error(`${Math.round(c.timeoutMs / 1000)} 秒没做完`);
      await new Promise((resolve) => setTimeout(resolve, c.pollMs));
      let data;
      try {
        const r = await fetch(`${c.url}/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(30000) });
        data = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 404 && r.status < 500) throw Object.assign(new Error(failMsg(data, r.status)), { fatal: true });
      } catch (error) {
        if (error?.fatal) throw error;
        continue; // 查的时候网络抖了，接着查
      }
      const status = String(data?.status || '').toLowerCase();
      if (/fail|error|cancel|reject/.test(status)) {
        const msg = failMsg(data);
        throw Object.assign(new Error(`${c.model}：${msg}`), { refused: REFUSED_RE.test(msg) });
      }
      if (/complete|succe/.test(status)) {
        videoUrl = String(data?.metadata?.url || data?.url || data?.video_url || data?.data?.[0]?.url || '');
        if (!videoUrl) throw new Error(`${c.model}：做完了却没给视频地址`);
      }
    }
    if (!/^https:\/\//i.test(videoUrl)) throw new Error('视频地址不是 https');
    const r = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`视频下载失败：HTTP ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > c.maxBytes) throw new Error(`视频太大（${Math.round(buffer.length / 1048576)}MB）`);
    if (!looksLikeVideoBuffer(buffer)) throw new Error('下载下来的不是视频');
    return { buffer, model: c.model };
  }

  // 开做排队（隔够 minIntervalMs），开了以后各做各的；排队、发出去、告诉她在 jobs.js
  const videoLabelV2 = (prompt) => truncateText(String(prompt ?? '').replace(/\s+/g, ' '), 60);

  // POST /api/socialV2/video 的主体（令牌、白名单、工具开关、play 的分享限额在 console-server 里查过了）
  // body: { prompt, caption?, seconds? }；from 是调用的会话（聊天的 key，或 play:main）
  function makeVideoV2(key, from, body, now = Date.now()) {
    const c = videoCfgV2();
    if (!c.enabled) return { ok: false, status: 403, error: '现在做不了视频' };
    if (!process.env[c.apiKeyEnv]) return { ok: false, status: 503, error: '现在做不了视频（工具没准备好），跟人照实说' };
    if (!/^(group|private):\d+$/.test(String(key))) return { ok: false, status: 400, error: 'key 要填做好以后发到哪个聊天，比如 group:123' };
    const prompt = String(body?.prompt ?? '').replace(/\s+/g, ' ').trim();
    const caption = String(body?.caption ?? '').replace(/\s+/g, ' ').trim();
    if (!prompt) return { ok: false, status: 400, error: 'prompt 不能为空：写视频里有什么、谁在干嘛、镜头怎么动、什么风格' };
    if (prompt.length > c.maxPromptChars) return { ok: false, status: 400, error: `prompt 太长了，${c.maxPromptChars} 字以内` };
    if (caption.length > 100) return { ok: false, status: 400, error: 'caption 太长了，100 字以内' };
    if (SENSITIVE_RE.test(prompt) || (caption && SENSITIVE_RE.test(caption))) return { ok: false, status: 403, error: '内容含敏感信息，不做' };
    const people = castIdsV2(body?.people);
    if (people.error) return { ok: false, status: 400, error: people.error };
    let seconds = c.seconds;
    if (body?.seconds !== undefined && body?.seconds !== null && body?.seconds !== '') {
      const s = Math.round(Number(body.seconds));
      if (!Number.isFinite(s) || s < 1 || s > 15) return { ok: false, status: 400, error: 'seconds 要在 1~15 之间' };
      seconds = s;
    }
    if (c.dailyLimit && todayJobsV2('video', now) >= c.dailyLimit) {
      return { ok: false, status: 429, error: `今天已经做了 ${c.dailyLimit} 段视频，明天再做；跟人照实说一声` };
    }
    const pending = pendingJobsV2('video');
    if (pending.length >= c.maxPending) return { ok: false, status: 429, error: '手上还有好几段视频没做完，先等这几段做好' };
    if (pending.some((e) => e.key === key && e.prompt === prompt)) {
      return { ok: false, status: 409, error: '这段已经在做了，做好了会自己发出去，不用再做一遍' };
    }
    const { entry, ahead } = submitJobV2('video', { key, from, prompt, seconds, ...(caption ? { caption } : {}), ...(people.ids.length ? { people: people.ids } : {}) }, now);
    log(`[做视频] ${from} 要做（发到 ${key}，${seconds} 秒${ahead ? `，前面还有 ${ahead} 段` : ''}）：${prompt}`);
    appendActivity(`${key} [做视频] 开始做：${videoLabelV2(prompt)}`);
    const left = c.dailyLimit ? c.dailyLimit - todayJobsV2('video', now) : null;
    const where = key === from ? '这里' : convLabelV2(key, socialV2.conversations.get(key));
    return {
      ok: true, queued: true, id: entry.id, ...(ahead ? { ahead } : {}),
      hint: `开始做了${ahead ? `（前面还有 ${ahead} 段在做）` : ''}：一段要一两分钟，做好了会自己发到${where}，到时候会告诉你。`
        + `${key === from ? '先跟对方说一声你去做了（比如“等我做一下”），别说已经做好了，' : ''}也别再调一次 qq_make_video。${left !== null ? `今天还能做 ${left} 段。` : ''}`,
    };
  }

  // 做好了：发视频，配的那句另发一条；抽几帧拼成图存一份给她看个大概
  async function produceVideoV2(entry, cast) {
    const t0 = Date.now();
    const { buffer, model } = await generateV2(entry, cast);
    log(`[做视频] ${model} 做好了（${Math.round((Date.now() - t0) / 1000)} 秒，${Math.round(buffer.length / 1024)}KB）`);
    const sheet = await videoSheetV2(buffer).catch(() => null);
    const file = sheet ? saveOwnImageV2('video', sheet) : null;
    const mp4 = saveOwnVideoV2(file, buffer);
    const parts = [{ segments: [{ type: 'video', data: { file: 'base64://' + buffer.toString('base64') } }], opts: { timeoutMs: videoCfgV2().sendTimeoutMs } }];
    if (entry.caption) parts.push({ segments: [{ type: 'text', data: { text: entry.caption } }], optional: true });
    return {
      model, file, parts, ...(mp4 ? { record: { mp4 } } : {}),
      text: `[视频:${videoLabelV2(entry.prompt)}]${entry.caption ? ` ${entry.caption}` : ''}`,
      ...(file ? { media: [{ kind: 'image', local: file, videoFrames: true }] } : {}),
    };
  }

  function videoFailReasonV2(entry) {
    if (entry.refused) return '这个内容做不了，换个别的吧';
    if (/没发出去|不能往那边发/.test(entry.error || '')) return '做好了，可是没发出去';
    if (/重启/.test(entry.error || '')) return '做到一半被打断了';
    return '出了点毛病，没做出来';
  }
  const videoWhereV2 = (entry, viewer) => (entry.key === viewer ? '这里' : convLabelV2(entry.key, socialV2.conversations.get(entry.key)));
  function videoResultTextV2(entry, viewer) {
    const what = `你 ${whenV2(entry.at)} 开始做的视频“${defang(videoLabelV2(entry.prompt))}”`;
    if (entry.ok) {
      const look = entry.messageId && entry.key === viewer && entry.file ? `（要看拍成什么样用 qq_get_message_images(messageId="${entry.messageId}")，是抽了几帧拼的图）` : '';
      return `${what}做好了，已经发到${videoWhereV2(entry, viewer)}了${look}`;
    }
    return `${what}没做成：${videoFailReasonV2(entry)}`;
  }
  const VIDEO_JOB = {
    tag: '[做视频]', logField: 'videoLog', idPrefix: 'v', unit: '段', verb: '做', overlap: true,
    cfg: () => videoCfgV2(),
    produce: produceVideoV2,
    label: (e) => videoLabelV2(e.prompt),
    playWhat: (e) => `做了一段视频：${truncateText(e.prompt, 30)}`,
    resultText: videoResultTextV2,
    pendingText: (e, viewer) => `你 ${whenV2(e.at)} 开始做的视频“${defang(videoLabelV2(e.prompt))}”还在做，做好了会自己发到${videoWhereV2(e, viewer)}`,
    section: '做视频',
    failedFooter: '没做成的，等着的人还不知道，跟他们照实说一声。',
    steerTitle: (ok) => (ok ? '视频做好了' : '视频没做成'),
    steerTail: (e, to) => (to === PLAY_KEY ? '' : e.ok
      ? ' 想说一句就自然地说（比如“做好啦”）；要讲视频里有什么先看一眼，别照着自己写的描述猜。'
      : ' 跟等着的人照实说一声没做好（可以等会儿再做一次），别说做好了。'),
    blockedError: '做好了，可现在不能往那边发',
    sendFailedPrefix: '做好了，但没发出去',
    restartError: '做到一半 bridge 重启了',
    wakeReason: 'video', wakeOnFail: true,
  };
  const videoNotesOfV2 = (key, now = Date.now()) => notesOfV2(key, 'video', now);
  const videoPromptLineV2 = (key, now = Date.now()) => jobPromptLineV2('video', key, now);
  const markVideoShownV2 = (key) => markNotesShownV2(key, ['video']);

  return {
    exports: { makeVideoV2, markVideoShownV2, videoCfgV2, videoNotesOfV2, videoPromptLineV2 },
    link() {
      ({
        castIdsV2, convLabelV2, jobPromptLineV2, markNotesShownV2, notesOfV2, pendingJobsV2, saveOwnImageV2, saveOwnVideoV2, saveSocialV2State,
        socialV2, submitJobV2, todayJobsV2, whenV2
      } = app);
      app.defineJobKindV2('video', VIDEO_JOB);
    },
    start() {},
  };
}
