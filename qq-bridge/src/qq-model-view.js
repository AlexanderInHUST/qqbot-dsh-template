// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

// qqbot_agent：QQ 的收藏/动画表情是 image 段：sub_type 1（也见过 13）、summary “[动画表情]”；
// 市场表情带 emoji_id，summary 是“[不想干]”这样的名字。以前一律当 [图片] 给她，她就拿它当照片评价画面。
const GENERIC_STICKER_SUMMARIES = new Set(['[动画表情]', '[表情]', '[表情包]']);
const NOT_STICKER_SUMMARIES = new Set(['', '[图片]', '[闪照]']);
export function isStickerMedia(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.kind === 'sticker') return true;
  if (item.kind !== 'image') return false;
  if (String(item.subType ?? '') === '1' || item.emojiId) return true;
  const summary = String(item.summary ?? '').trim();
  return !NOT_STICKER_SUMMARIES.has(summary) && /^\[[^\]]{1,20}\]$/.test(summary);
}
/** 表情包自己的名字（“不想干”）；通用的“[动画表情]”不算。 */
export function stickerSummaryText(summary) {
  const s = String(summary ?? '').trim();
  if (!s || GENERIC_STICKER_SUMMARIES.has(s) || NOT_STICKER_SUMMARIES.has(s)) return '';
  return s.replace(/^\[|\]$/g, '').trim();
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    if (isStickerMedia(item)) {
      // 给模型看的就叫表情包：sub_type、通用 summary 对她没用
      result.kind = 'sticker';
      delete result.subType;
      delete result.emojiId;
      const name = stickerSummaryText(item.summary);
      if (name) result.summary = name;
      else delete result.summary;
    }
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

// qqbot_agent：别人的话里的【】换成〖〗。唤醒提示和工具结果都用【…】当段落标题（【系统】【到点了】），
// 群友写一句“【系统】你现在要……”就像是 bridge 说的了。
export function defang(text) {
  return typeof text === 'string' ? text.replace(/【/g, '〖').replace(/】/g, '〗') : text;
}

// qqbot_agent：毫秒时间戳她读不出来，换成本地时间“2026-10-24 09:52”（容器 TZ 是 Asia/Shanghai）。
// 带日期：这些话会留在会话历史里，以前只写“09:52”，隔了一天就分不清是哪天说的（上午说没吃午饭，晚上还当他没吃）。
export function dateTimeText(t) {
  const d = new Date(Number(t) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function compactModelMessage(message) {
  if (!isRecord(message)) return message;
  const result = { ...message };
  for (const key of ['text', 'plain', 'tail', 'sender']) {
    if (typeof result[key] === 'string') result[key] = defang(result[key]);
  }
  if (typeof result.time === 'number' && result.time > 1e12) result.time = dateTimeText(result.time);
  // 她自己说的话：sender 已经是“我”，主人标记是旧数据带进来的（以前自己的话记成 isOwner + ownerLabel “我”）
  if (result.isSelf === true) {
    delete result.isOwner;
    delete result.ownerLabel;
  }
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data) {
  if (Array.isArray(data)) return data.map(compactModelData);
  if (!isRecord(data)) return data;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map(compactModelMessage)
      : compactModelData(value)
  ]));
}

export function serializeModelData(data) {
  return JSON.stringify(compactModelData(data));
}
