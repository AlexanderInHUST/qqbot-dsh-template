// 她慢慢长大（2026-11-04，主人：“一年一岁……生日就是上线第一天，所有的各种风格、画画、视频、喜欢讨论的东西，
// 都会渐渐和年龄增长，但是又要考虑本身喜欢什么”）。
// 成长档案在 extras（extras/selfprofile.py，/data/self-profile.json）：每晚 4 点整理记忆时看一眼她最近玩了什么、
// 记了什么，偶尔改一条兴趣、喜恶，开头、说话、性格只往大里长。这里每 refreshMinutes 分钟取一次 /self/card，
// 把人格卡里 <!-- grow:名字 --> 包着的部分换成档案里的，变了就重写 state/role-card-v2.md（系统提示里那份要等压缩才换）。
// 画画、做视频的风格也跟着年龄（socialV2.draw.style / video.style 写了就以配置为准）。
// extras 连不上、档案还没有时照人格卡原文。档案还没导入时把人格卡原文送去导入一次（那天就是她的生日）。

import { applyGrowRegions } from '../role-card.js';

export function createGrowth(app) {
  const { cfg, log } = app;
  let roleRawContent, syncRoleCardFileV2;
  let card = null; // 上次取到的 /self/card（ok 且不 empty）
  let sig = '';
  let seededTried = false;
  let lastError = '';

  function growthCfgV2() {
    const c = cfg.socialV2?.growth ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled !== false,
      refreshMs: Math.max(1, num(c.refreshMinutes, 10)) * 60000,
      timeoutMs: Math.max(1000, num(c.timeoutMs, 10000)),
    };
  }
  const extrasUrlV2 = (route) => String(cfg.socialV2?.longTermMemory?.url ?? 'http://extras:8940/recall').replace(/\/recall$/, route);

  async function extrasJsonV2(route, body) {
    const res = await fetch(extrasUrlV2(route), {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(growthCfgV2().timeoutMs),
    });
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  function setCardV2(next) {
    const nextSig = next ? JSON.stringify([next.regions, next.drawStyle, next.videoStyle]) : '';
    card = next;
    if (nextSig === sig) return;
    sig = nextSig;
    log(next ? `[成长] ${next.age} 岁（生日 ${next.born}），人格卡用成长档案里的` : '[成长] 人格卡用原文');
    try { syncRoleCardFileV2(); } catch (error) { log(`[成长] 重写人格卡失败：${error?.message ?? error}`); }
  }

  async function refreshGrowthV2() {
    if (!growthCfgV2().enabled) { setCardV2(null); return; }
    try {
      let data = await extrasJsonV2('/self/card');
      if (data.empty && !seededTried) {
        const raw = String(roleRawContent() || '');
        if (/<!--\s*grow:\w+\s*-->/.test(raw)) {
          seededTried = true;
          const r = await extrasJsonV2('/self/profile/seed', { card: raw });
          log(`[成长] 从人格卡导入档案：${r.seeded ?? 0} 条，生日 ${r.born}`);
          data = await extrasJsonV2('/self/card');
        }
      }
      lastError = '';
      setCardV2(data.empty || data.enabled === false || !data.regions ? null : data);
    } catch (error) {
      // 连不上就接着用上次的（重启后第一次就是原文）
      const msg = String(error?.message ?? error);
      if (msg !== lastError) log(`[成长] 取成长档案失败：${msg}`);
      lastError = msg;
    }
  }

  // 生日那天【你现在】里的一句
  function birthdayLineV2(c = growthV2()) {
    return c?.birthday && Number.isFinite(Number(c.age)) ? `- 今天是你的生日，你满 ${Number(c.age)} 岁了。` : '';
  }
  // 喜欢、不喜欢、兴趣变了的那两天【你现在】里的一句（2026-11-10，主人选的“她知道，只说她自己感觉得到的”）：
  // 说话、性格往大里长不告诉她，免得她故意装大人；也不提档案。extras 只给 noticeDays 天内、没被退回的。
  function growthNoticeLineV2(c = growthV2()) {
    const list = (Array.isArray(c?.notices) ? c.notices : [])
      .map((x) => String(x?.text ?? '').trim().replace(/[。！!；;，,\s]+$/u, ''))
      .filter(Boolean)
      .slice(0, 3);
    return list.length ? `- 你最近发现自己有点变了：${list.join('；')}。这是你自己心里的感觉，聊到了自然说，不用专门去跟人讲。` : '';
  }
  function growthV2() {
    return growthCfgV2().enabled && card ? card : null;
  }

  return {
    exports: {
      birthdayLineV2,
      growthNoticeLineV2,
      growRoleTextV2: (raw) => applyGrowRegions(raw, growthCfgV2().enabled ? card?.regions : null),
      growthV2,
      refreshGrowthV2,
    },
    link() {
      ({ roleRawContent, syncRoleCardFileV2 } = app);
    },
    start() {
      app.scheduler.every('growth', growthCfgV2().refreshMs, refreshGrowthV2, { firstDelayMs: 0 });
    },
  };
}
