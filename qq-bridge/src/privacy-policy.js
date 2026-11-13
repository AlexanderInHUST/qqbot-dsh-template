// qqbot_agent：家里 / 外面的分寸，一处说了算（2026-11-09，架构调整第 6 步）。
// 以前“这是不是家里以外的群”“这里能不能叫爸爸”“这里看别处的事给原文还是只给条数”散在 wake-prompt、cast、
// tell-myself、away、bridge.js 的 ownerLabelFor 里各写一遍，判断稍有不同就会把家里的事带到大群。现在都调这里。
// extras 那边同一条规矩在 extras/store.py 的 home_groups / outside（记忆、人物卡、成长按它过滤）。
//
// 地方分四种（placeOf）：
//   private  私聊（白名单里的）
//   home     家里的群（cfg.homeGroups；没配 homeGroups 时所有群都算家里的，和以前一样）
//   outside  家里以外的群（大群、技术群、以后新加的群）
//   play     自由时间（play:main）
// 规矩：
//   - outside 看不到私聊和家里群的内容，看别处的事只给条数；看到的“在哪答应的”写“别处”。
//   - 主人的称呼（爸爸、妈妈）只在私聊和 ownerTitlesGroups（没配就用 homeGroups）里的群用。
//   - 跨窗口的事（qq_tell_myself、qq_send_elsewhere、主人又让玩游戏）只认私聊和家里的群发起。
//   - socialV2.noReachOut 里的聊天她不主动去找（2026-11-09 主人：私聊她要回，但别主动私聊他）：
//     主动找人不找、自由时间不往里分享（托的照发）、qq_send_elsewhere 不往里发、系统提示不发到那里。对方来找她照常回。

const GROUP_RE = /^group:(\d+)$/;
const CHAT_RE = /^(private|group):\d+$/;

export const PLAY_PLACE_KEY = 'play:main';

export function placeOf(cfg, key) {
  const k = String(key ?? '');
  if (k === PLAY_PLACE_KEY) return 'play';
  if (k.startsWith('private:')) return 'private';
  const m = GROUP_RE.exec(k);
  if (!m) return 'other';
  return Array.isArray(cfg?.homeGroups) && !cfg.homeGroups.includes(m[1]) ? 'outside' : 'home';
}

// 家里以外的群
export function isOutsideGroup(cfg, key) {
  return placeOf(cfg, key) === 'outside';
}

// 私聊或家里的群（跨窗口的事只认这些地方发起）
export function isHomeChat(cfg, key) {
  return CHAT_RE.test(String(key ?? '')) && !isOutsideGroup(cfg, key);
}

// 主人在这里能用的称呼（“爸爸”）；不能叫就是 ''。没给 title 的主人一律 ''。
export function ownerTitleHere(cfg, key, ownerId) {
  const title = cfg?.ownerTitles?.[String(ownerId ?? '')];
  if (!title) return '';
  const m = GROUP_RE.exec(String(key ?? ''));
  const groups = cfg?.ownerTitlesGroups ?? cfg?.homeGroups;
  return m && Array.isArray(groups) && !groups.includes(m[1]) ? '' : title;
}

// 在 viewer 这里看 other 那边的事：'full' 给原文，'count' 只给条数。
// 家里以外的群看哪儿都只给条数；summaryOnlyKeys（crossSession 配置，默认大群）里的会话看私聊只给条数。
export function crossSessionView(cfg, viewer, other, summaryOnlyKeys = []) {
  if (!other || other === viewer || other === PLAY_PLACE_KEY) return 'full';
  if (isOutsideGroup(cfg, viewer)) return 'count';
  return crossSessionSummaryOnly(cfg, viewer, summaryOnlyKeys) && String(other).startsWith('private:') ? 'count' : 'full';
}

// 这个会话看私聊只给条数（summaryOnlyKeys 里的，加上所有家里以外的群）
export function crossSessionSummaryOnly(cfg, viewer, summaryOnlyKeys = []) {
  return summaryOnlyKeys.includes(viewer) || isOutsideGroup(cfg, viewer);
}

// 她不主动找的聊天（socialV2.noReachOut）
export function noReachOut(cfg, key) {
  const list = cfg?.socialV2?.noReachOut;
  return Array.isArray(list) && list.some((k) => String(k) === String(key));
}

// 家里的群的会话 key（系统提示发到第一个）
export function homeGroupKeys(cfg) {
  return (Array.isArray(cfg?.homeGroups) ? cfg.homeGroups : []).map((g) => `group:${g}`);
}
