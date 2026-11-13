// 画画、做视频把群友画进去（qq_draw / qq_make_video 的 people）。
// 2026-11-03：以前她画大家都是小动物（她自己怕画真人），主人说现在都有对每个人的印象了，画的时候把印象和样子都带进去。
// 她给 QQ 号，bridge 拼一段“画里的人”接在 prompt 后面：叫什么（这个聊天里的群名片）、长什么样（照着 QQ 头像，
// extras /describe-avatar 描述一次、按头像的 sha256 缓存在 socialV2.avatarDescs）、平时什么样（人物卡里这个聊天能看的那份，
// extras /people/cast，和唤醒时一样按来路过滤，家里以外的群看不到家里的事）。主人在家里以外的群只写名字，不写是她爸爸妈妈。
import crypto from 'node:crypto';
import { truncateText } from '../md-to-plain.js';
import { ownerTitleHere } from '../privacy-policy.js';
import { safeFetchBuffer } from '../safe-fetch.js';

export function createCast(app) {
  const { cfg, isOwnerId, log } = app;
  let MAX_MEDIA_BYTES, acceptImageBuffer, getSocialV2State, saveSocialV2State, socialV2;

  function castCfgV2() {
    const c = cfg.socialV2?.cast ?? {};
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: c.enabled !== false,
      maxPeople: Math.max(1, num(c.maxPeople, 4)),
      avatar: c.avatar !== false,
      avatarRefreshMs: Math.max(0, num(c.avatarRefreshHours, 24)) * 3600 * 1000, // 隔这么久再看一眼头像换没换
      traitChars: Math.max(0, num(c.traitChars, 100)),
    };
  }
  const extrasUrlV2 = (route) => String(cfg.socialV2?.longTermMemory?.url ?? 'http://extras:8940/recall').replace(/\/recall$/, route);

  // 她给的 people：QQ 号（"123" / "qq:123"），去重，最多 maxPeople 个；有不对的返回 error
  function castIdsV2(raw) {
    if (raw === undefined || raw === null || raw === '') return { ids: [] };
    const list = Array.isArray(raw) ? raw : [raw];
    const ids = [];
    for (const x of list) {
      const id = String(x ?? '').trim().replace(/^qq:/, '');
      if (!/^\d{5,12}$/.test(id)) return { error: `people 要填 QQ 号（消息里的 userId），“${truncateText(String(x ?? ''), 20)}”不是` };
      if (!ids.includes(id)) ids.push(id);
    }
    const max = castCfgV2().maxPeople;
    if (ids.length > max) return { error: `people 最多 ${max} 个人，挑最要紧的几个` };
    return { ids };
  }

  // 这个人的头像长什么样（描述过、头像没换就用缓存的）；出错返回旧的或空
  async function avatarDescV2(id) {
    const c = castCfgV2();
    const old = socialV2.avatarDescs?.[id];
    if (!c.avatar) return '';
    if (old?.desc && Date.now() - Number(old.at || 0) < c.avatarRefreshMs) return old.desc;
    try {
      const fetched = await safeFetchBuffer(`https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`, MAX_MEDIA_BYTES);
      const img = acceptImageBuffer(fetched.buffer, 'QQ 头像');
      if (!img) throw new Error('头像不是有效图片');
      const hash = crypto.createHash('sha256').update(img.buffer).digest('hex');
      let desc = old?.hash === hash ? old.desc : '';
      if (!desc) {
        const res = await fetch(extrasUrlV2('/describe-avatar'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mimeType: img.mimeType, data: img.buffer.toString('base64'), who: 'other' }),
          signal: AbortSignal.timeout(120000),
        });
        const data = await res.json();
        if (!data?.ok || !String(data.text ?? '').trim()) throw new Error(data?.error ?? `HTTP ${res.status}`);
        desc = String(data.text).replace(/\s+/g, ' ').trim().slice(0, 120);
        log(`[avatar] 记下 ${id} 的头像：${desc}`);
      }
      if (!socialV2.avatarDescs || typeof socialV2.avatarDescs !== 'object') socialV2.avatarDescs = {};
      delete socialV2.avatarDescs[id];
      socialV2.avatarDescs[id] = { hash, desc, at: Date.now() };
      const ids = Object.keys(socialV2.avatarDescs);
      for (const k of ids.slice(0, Math.max(0, ids.length - 300))) delete socialV2.avatarDescs[k];
      saveSocialV2State();
      return desc;
    } catch (error) {
      log(`[avatar] 看 ${id} 的头像失败：${error?.message ?? error}`);
      return old?.desc || '';
    }
  }

  async function castCardsV2(key, ids) {
    try {
      const res = await fetch(extrasUrlV2('/people/cast'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjects: ids.map((id) => `qq:${id}`), key }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.people)) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return new Map(data.people.map((p) => [String(p?.subject ?? '').replace(/^qq:/, ''), p]));
    } catch (error) {
      log(`[画里的人] 拿人物卡失败：${error?.message ?? error}`);
      return new Map();
    }
  }

  // 主人在这个聊天里能不能叫爸爸妈妈（和 ownerLabelFor 一样：私聊、ownerTitlesGroups / homeGroups 里的群）
  function titleHereV2(key, id) {
    return ownerTitleHere(cfg, key, id);
  }

  // 拼进 prompt 的“画里的人”；names 用来记日志、写进记录
  async function castTextV2(key, ids) {
    if (!ids?.length || !castCfgV2().enabled) return { text: '', names: [] };
    const c = castCfgV2();
    const self = String(app.selfUserId || '');
    const others = ids.filter((id) => id !== self);
    const [cards, looks] = await Promise.all([
      others.length && cfg.socialV2?.longTermMemory?.enabled !== false ? castCardsV2(key, others) : new Map(),
      Promise.all(ids.map((id) => (id === self ? Promise.resolve(socialV2.selfAvatar?.desc || '') : avatarDescV2(id)))),
    ]);
    const recent = getSocialV2State(key)?.recentMessages ?? [];
    const lines = [];
    const names = [];
    ids.forEach((id, i) => {
      let name;
      const bits = [];
      if (id === self) {
        name = String(app.selfDisplayName || '').trim() || '我';
        bits.push('就是我自己');
      } else {
        const card = cards.get(id);
        const said = [...recent].reverse().find((m) => String(m?.userId ?? '') === id && m.sender);
        name = String(said?.sender || card?.aliases?.[0] || id).replace(/\s+/g, ' ').trim().slice(0, 20);
        const title = isOwnerId(cfg, id) ? titleHereV2(key, id) : '';
        if (title) bits.push(`是我${title}`);
        const traits = [card?.mine, ...String(card?.card ?? '').split('\n').filter((l) => /^(了解|在做|最近)：/.test(l.trim())).map((l) => l.trim().replace(/^[^：]+：/, ''))]
          .filter(Boolean).join('；');
        if (traits && c.traitChars) bits.push(`平时：${truncateText(traits.replace(/\s+/g, ' '), c.traitChars)}`);
      }
      if (looks[i]) bits.push(`样子照着头像：${looks[i]}`);
      names.push(name);
      lines.push(`- ${name}${bits.length ? `：${bits.join('；')}` : ''}`);
    });
    const text = `\n\n画面里的人（照着下面的样子画成卡通人物，可以在旁边写上名字；不画真人长相，不丑化、不画成坏人）：\n${lines.join('\n')}`;
    log(`[画里的人] ${key}：${names.join('、')}`);
    return { text, names };
  }

  return {
    exports: { castCfgV2, castIdsV2, castTextV2 },
    link() {
      ({ MAX_MEDIA_BYTES, acceptImageBuffer, getSocialV2State, saveSocialV2State, socialV2 } = app);
    },
    start() {},
  };
}
