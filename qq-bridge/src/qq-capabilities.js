// QQ 工具的能力表（2026-11-08，架构调整第 3 步）：一个工具一条，写着说明、参数、哪个窗口能用、调桥接哪个接口。
// DSH 原生插件 plugins/qq-agent-presets/qq-native-tools.mjs 照它注册工具。DSH 执行工具时知道是哪个会话调的，
// 插件把会话 id 放在 x-agent-session 头里，桥接控制台换成那个会话自己的令牌（console-server.js 的集中关卡），
// 所以参数里没有 key 和 token；之后的权限、限额检查还是各接口原来那套。
// 自由时间（qq-play，side 'play'）发东西用 to 写发去哪；聊天（qq-chat-v2，side 'chat'）只管自己这个聊天，key 就是调用它的会话。
// 同名工具两边各一条（qq_mark_read、qq_send_message……），说明和参数不一样；DSH 的注册在各会话自己的作用域里，不冲突。
// 返回图片的工具（qq_get_message_images 等）留在 MCP（src/mcp-snowluma-safe.js）：原生工具要自己存附件、查模型能不能看图。
// 纯数据和纯函数，不读文件：插件、桥接、测试都直接 import。
//
// 参数 schema 只能用 DSH 认的那几个关键字（type/oneOf/properties/required/additionalProperties/items/enum/const
// 和 description 这些注解），数字范围、字数写在说明里，桥接接口自己再查。

const TO = {
  type: 'string',
  description: '发到哪个聊天：group:群号 或 private:QQ号（见唤醒提示里的【能分享到的聊天】）',
};
const ID = { oneOf: [{ type: 'number' }, { type: 'string' }] };
const PEOPLE = {
  type: 'array',
  items: { type: 'string' },
  description: '画进去的人（或你自己）的 QQ 号（消息里的 userId），最多 4 个。填了会照着他们的头像和你对他们的了解画成卡通人物',
};
// 大事随时说，小事睡前说（2026-11-10）：家里的小群白天只收她忍不住马上想说的大事，一天一回（free-time.js 的 bigNewsLeftV2）
const BIG = {
  type: 'boolean',
  description: '这是你忍不住马上就想告诉家里人的大事才填 true：自己特别得意的画、卡了好久的游戏终于过了、心里难受、在别的群里受了委屈。家里的小群白天平常的事留到睡前说，这种大事一天能专门来说一回；普通的见闻、好玩的东西别填',
};

// 像人打字那样发、发前看一眼开着时，qq_send_message 的说明里多写一句（同 mcp-snowluma-safe.js）
function humanSendNote(cfg) {
  return cfg?.socialV2?.send?.human?.enabled === true
    ? '条与条之间按你打下一条要的时间发，不用自己定间隔；一次最多几条看场景（私聊和家里的群 4 条，别的群 2 条），多出来的会并进最后一条。发的过程中对方插话，后面的就不发了，返回 notSent，先看他说了啥再决定。'
    : '';
}
function holdSendNote(cfg) {
  const rt = cfg?.socialV2?.replyTiming;
  return rt?.enabled === true && rt?.holdBeforeSend !== false
    ? '你想发的时候对方又说了话（你还没看过的），这次先不发，返回 held 和他新说的话（newMessages），你那段原样在 notSent 里；看完意思没变就照发，要改就改，不用说了就别发。'
    : '';
}

// 模型有时把数组或一句话写成 JSON 字符串（"[...]"、"\"你好\""），照 MCP 那边一样拆开
function unwrapMessages(messages) {
  if (typeof messages !== 'string') return messages;
  const t = messages.trim();
  if (!t.startsWith('[') && !t.startsWith('"')) return messages;
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === 'string') return parsed;
  } catch {}
  return messages;
}

const post = (path, body, timeoutMs = 30000) => ({ method: 'POST', path, body, timeoutMs });
const get = (path, query, timeoutMs = 30000) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return { method: 'GET', path: `${path}?${q}`, timeoutMs };
};

// 聊天那边的参数
const SEQ = (description) => ({ type: 'integer', description });
const MEMORY_CATEGORY = { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'] };
const STICKER_ID = { type: 'string', description: '表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）' };
const REPLY_RULE = '只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。';
const stickersOn = (cfg) => cfg?.socialV2?.sticker?.enabled !== false;
const voiceOn = (cfg) => cfg?.socialV2?.voice?.enabled !== false;

// 每条：
//   name；flag：socialV2.tools 里的开关名（false 就不注册、桥接也拒）；sides：哪些窗口有这个工具
//   enabled(cfg)：除了 flag 还要看的总开关（表情包、语音）
//   description(cfg)；properties / required：参数（没有 key、token）
//   call(args, { key }) → { method, path, body, timeoutMs, longPoll }：key 是调用它的会话；play 发东西用 args.to
//   check(args) → 错误文字或 null：说明里写的范围
//   errorPrefix：失败时接在错误前面的话（同 MCP 那边）
export const CAPABILITIES = Object.freeze([
  {
    name: 'qq_mark_read',
    flag: 'markRead',
    sides: ['play'],
    description: () => '这次自由时间玩够了就用它收尾（先用 browser_tabs 关掉多余的标签页）。还没玩够时会被退回来，那就接着玩。',
    properties: {},
    required: [],
    call: (_args, { key }) => post('/api/socialV2/mark-read', { key }),
    errorPrefix: '没收成尾：',
  },
  {
    name: 'qq_set_mood',
    flag: 'setMood',
    sides: ['play', 'chat'],
    description: () => '心情变了时记一下（开心、无聊、有点烦、困、被夸了美滋滋……）。所有聊天窗口和电脑那边的你都会在【你现在】里看到同一份心情。它只影响你说话的语气，不用跟别人宣布。mood 传空字符串就是不写心情了。',
    properties: {
      mood: { type: 'string', description: '现在的心情，几个字，最多 20 字，比如“有点无聊”“美滋滋”' },
      why: { type: 'string', description: '为什么，一句话，最多 60 字，比如“这关终于过了”' },
    },
    required: ['mood'],
    call: (args, { key }) => post('/api/socialV2/mood', { key, mood: args.mood, why: args.why || '' }),
    errorPrefix: '没记上：',
  },
  {
    name: 'qq_send_message',
    flag: 'sendMessage',
    sides: ['play'],
    description: (cfg) => '往某个聊天里说话（自由时间里想分享时用），to 填发到哪个聊天。字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。一般不用引用；要回那边更早的某条才传 replyToMessageId。'
      + humanSendNote(cfg) + holdSendNote(cfg),
    properties: {
      to: TO,
      messages: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '要发送的内容：字符串=一条；数组=分多条' },
      replyToMessageId: { ...ID, description: '要引用的消息 id（可选）' },
      atUserId: { ...ID, description: '要 @ 的群成员 QQ 号（可选，别滥用）' },
      big: BIG,
    },
    required: ['to', 'messages'],
    check: (args) => (Array.isArray(args.messages) && !args.messages.length ? 'messages 不能是空数组' : null),
    call: (args) => post('/api/socialV2/send-message', {
      key: args.to,
      messages: unwrapMessages(args.messages),
      replyToMessageId: args.replyToMessageId,
      atUserId: args.atUserId ?? null,
      ...(args.big === true ? { big: true } : {}),
    }, 300000),
    errorPrefix: '发送失败：',
  },
  {
    name: 'qq_send_screenshot',
    flag: 'sendScreenshot',
    sides: ['play'],
    description: () => '把你浏览器里正在看的网页截一张图发到某个聊天里（想给大家看看你看到的东西时用），to 填发到哪个聊天。默认截最后打开的那个标签页，要截别的就传 tabIndex（browser_tabs 列表里的序号）。图里不能带文字说明，想说的话先用 qq_send_message 单独发。',
    properties: {
      to: TO,
      tabIndex: { type: 'integer', description: '要截的标签页序号（可选）' },
      big: BIG,
    },
    required: ['to'],
    check: (args) => (args.tabIndex !== undefined && args.tabIndex < 0 ? 'tabIndex 不能是负数' : null),
    call: (args) => post('/api/socialV2/send-screenshot', { key: args.to, tabIndex: args.tabIndex, ...(args.big === true ? { big: true } : {}) }, 120000),
    errorPrefix: '截图发送失败：',
  },
  {
    name: 'qq_draw',
    flag: 'draw',
    sides: ['play'],
    description: () => '画一张画发到某个聊天里，to 填发到哪个聊天。画出来是你自己用蜡笔、彩铅画的小孩画，风格不用写，只写画什么：画面里有谁、在干嘛、什么颜色、背景是什么，写具体一点。想要画上写字就写明要写哪几个字。画家里人或群友就真把他们画进去，别换成小动物：prompt 里用群名片叫他们，people 填他们的 QQ 号；友好地画，不丑化、不画成坏人、不画黄的。一张要一两分钟到好几分钟，工具马上返回，画好了会自己发出去，到时候会告诉你，这期间接着玩，同一张别再调一次。caption 是跟在图后面的一句话（可选）。一天最多画 100 张。结果不是 ok 就是没开始画。',
    properties: {
      to: TO,
      prompt: { type: 'string', description: '要画什么（中文描述画面，300 字以内）' },
      caption: { type: 'string', description: '跟在图后面的一句话（可选）' },
      people: PEOPLE,
      big: BIG,
    },
    required: ['to', 'prompt'],
    check: (args) => (Array.isArray(args.people) && args.people.length > 4 ? 'people 最多 4 个' : null),
    call: (args) => post('/api/socialV2/draw', { key: args.to, prompt: args.prompt, caption: args.caption, people: args.people, ...(args.big === true ? { big: true } : {}) }),
    errorPrefix: '没开始画：',
  },
  {
    name: 'qq_make_video',
    flag: 'video',
    sides: ['play'],
    description: () => '做一段短视频发到某个聊天里，to 填发到哪个聊天，和画画是两回事。做出来是一段几秒的视频，带声音，可以是真人实拍感、动画、手绘等任何风格，prompt 里写清楚：画面里有谁、在干嘛、怎么动、镜头怎么走、什么风格、要什么声音。要有家里人或群友就真让他们出演，别换成小动物：prompt 里用群名片叫他们，people 填他们的 QQ 号；友好地画，不丑化、不画成坏人、不画黄的。一段要一两分钟，工具马上返回，做好了会自己发出去，到时候会告诉你，这期间接着玩，同一段别再调一次。caption 是视频后面跟着的一句话（可选）；seconds 是时长，1~15 秒，不填就是 8 秒。结果不是 ok 就是没开始做。',
    properties: {
      to: TO,
      prompt: { type: 'string', description: '视频内容（中文描述画面、动作、镜头、风格、声音，500 字以内）' },
      caption: { type: 'string', description: '跟在视频后面的一句话（可选）' },
      seconds: { type: 'integer', description: '时长，1~15 秒，不填是 8 秒' },
      people: PEOPLE,
      big: BIG,
    },
    required: ['to', 'prompt'],
    check: (args) => {
      if (args.seconds !== undefined && (args.seconds < 1 || args.seconds > 15)) return 'seconds 要在 1~15 之间';
      if (Array.isArray(args.people) && args.people.length > 4) return 'people 最多 4 个';
      return null;
    },
    call: (args) => post('/api/socialV2/video', { key: args.to, prompt: args.prompt, caption: args.caption, seconds: args.seconds, people: args.people, ...(args.big === true ? { big: true } : {}) }),
    errorPrefix: '没开始做：',
  },
  {
    name: 'qq_send_meme',
    flag: 'sendMeme',
    sides: ['play'],
    description: () => '把 Telegram 沙雕图频道的一条帖子（先用 mcp__qqbot-extras__tg_browse / tg_look 找到、看过）的图发到某个聊天里，to 填发到哪个聊天，caption 是可选的一句短吐槽，会跟在图后面。一条一次调用。频率、白名单、红线关键词由工具检查，被拒绝就算了。发出去的不要再用 qq_send_message 重复发。',
    properties: {
      to: TO,
      post: { type: 'string', description: '帖子编号，形如 "woshadiao/209091"（tg_browse 返回的 post）' },
      caption: { type: 'string', description: '一句短吐槽（可选）' },
    },
    required: ['to', 'post'],
    call: (args) => post('/api/socialV2/send-meme', { key: args.to, post: args.post, caption: args.caption }, 120000),
    errorPrefix: '搬图失败：',
  },

  // ── 聊天那边（qq-chat-v2）：都只管调用它的这个聊天 ──────────────────────
  {
    name: 'qq_get_prompt',
    flag: 'getPrompt',
    sides: ['chat'],
    description: () => '查看人格卡、当前唤醒配置、表情和黑话（只读）。',
    properties: {},
    required: [],
    call: (_args, { key }) => get('/api/socialV2/prompt', { key }),
    errorPrefix: '获取提示词失败：',
  },
  {
    name: 'qq_get_unread_messages',
    flag: 'getUnread',
    sides: ['chat'],
    description: () => '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
    properties: {
      limit: { type: 'number', description: '最多返回条数，默认 30，最大 100' },
      afterSeq: SEQ('读取本地 seq 大于此水位的最早一页；省略则返回最新一页'),
    },
    required: [],
    call: (args, { key }) => get('/api/socialV2/unread', { key, limit: args.limit ?? 30, afterSeq: args.afterSeq }),
    errorPrefix: '获取未读消息失败：',
  },
  {
    name: 'qq_get_recent_messages',
    flag: 'getRecent',
    sides: ['chat'],
    description: () => '查看这个聊天的最近消息（只读），支持 offset 扩大范围。',
    properties: {
      limit: { type: 'number', description: '最多返回条数，默认 20，最大 100' },
      offset: { type: 'number', description: '跳过最近 N 条，用于向前翻看更早消息，默认 0' },
    },
    required: [],
    call: (args, { key }) => get('/api/socialV2/recent', { key, limit: args.limit ?? 20, offset: args.offset ?? 0 }),
    errorPrefix: '获取最近消息失败：',
  },
  {
    name: 'qq_social_state',
    flag: 'socialState',
    sides: ['chat'],
    description: () => '查看这个聊天的状态：唤醒配置、未读数、上次为什么被叫醒、上次发言时间等（只读）。',
    properties: {},
    required: [],
    call: (_args, { key }) => get('/api/socialV2/state', { key }),
    errorPrefix: '获取状态失败：',
  },
  {
    name: 'qq_mark_read',
    flag: 'markRead',
    sides: ['chat'],
    description: () => '看完、回完、不想接了就用它收尾，把看过的消息标成已读；有人再找你会叫醒你。throughSeq 传最近读取结果的 readThroughSeq，这样读完以后才到的新消息不会被一起清掉；省略 throughSeq 会清空当前全部未读，所以总是带上水位。',
    properties: {
      throughSeq: SEQ('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息'),
    },
    required: [],
    call: (args, { key }) => post('/api/socialV2/mark-read', { key, throughSeq: args.throughSeq }),
    errorPrefix: '标记已读失败：',
  },
  {
    name: 'qq_set_wake_config',
    flag: 'setWakeConfig',
    sides: ['chat'],
    description: () => '设置这个聊天下次怎么叫你：潜水（无限期或到某个时间）、活跃（有消息就叫你）、指定成员一说话就叫你。@、引用、叫名字、拍一拍你、私聊来消息总会叫醒你；群里别的消息不会每条都叫你，有时会叫你来看一眼。triggers.speakerIds 填一个或多个群友 QQ 号，其中谁在群里说话就叫你，适合在等某个人回复时用，等到了就清掉。keywords 是你感兴趣的词，群里聊到了更可能叫你来看。',
    properties: {
      throughSeq: SEQ('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置'),
      config: {
        type: 'object',
        description: '要设置的唤醒配置，缺省字段保留原值',
        properties: {
          mode: { type: 'string', enum: ['diving', 'active'], description: 'diving=潜水，active=活跃（anyMessage 开启）' },
          infinite: { type: 'boolean', description: 'true=无限期，只有条件命中才唤醒；false=有限时间' },
          sleepMs: { type: 'number', description: '有限潜水毫秒数（从当前时间起算）' },
          sleepUntil: { type: 'string', description: '有限潜水截止时间 ISO 字符串，优先级高于 sleepMs' },
          triggers: {
            type: 'object',
            properties: {
              atMention: { type: 'boolean', description: '被 @ 或引用自己时唤醒' },
              nameMention: { type: 'boolean', description: '被叫名字/昵称时唤醒' },
              speakerIds: { type: 'array', items: ID, description: '指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（最多 20 个，不设置则不启用；私聊不适用；可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）' },
              keywords: { type: 'array', items: { type: 'string' }, description: '你感兴趣的词：群里聊到了更可能叫你来看一眼' },
              poke: { type: 'boolean', description: '有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）' },
              anyMessage: { type: 'boolean', description: '任意新消息都唤醒（活跃模式）' },
            },
          },
          batchWindowMs: { type: 'number', description: '多条消息合并唤醒窗口（毫秒，>=1000）' },
        },
      },
    },
    required: ['config'],
    check: (args) => (Array.isArray(args.config?.triggers?.speakerIds) && args.config.triggers.speakerIds.length > 20 ? 'speakerIds 最多 20 个' : null),
    call: (args, { key }) => post('/api/socialV2/wake-config', { key, config: args.config, throughSeq: args.throughSeq }),
    errorPrefix: '设置唤醒配置失败：',
  },
  {
    name: 'qq_send_message',
    flag: 'sendMessage',
    sides: ['chat'],
    description: (cfg) => '在这个聊天里说话：可发一条或多条，可引用某条消息，条间隔按字数自动算。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。'
      + REPLY_RULE.replace('只有以下情况才需要引用', '只有以下情况才需要传 replyToMessageId 引用') + humanSendNote(cfg) + holdSendNote(cfg),
    properties: {
      messages: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '要发送的内容：字符串=一条；数组=分多条' },
      replyToMessageId: { ...ID, description: '要引用/回复的消息 id（非零整数，可为负数，可选）' },
      atUserId: { ...ID, description: '要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）' },
      gapMode: { type: 'string', enum: ['auto', 'fixed', 'byLength'], description: 'auto=随机；fixed=固定间隔；byLength=按字数计算' },
      gapMs: { type: 'number', description: 'fixed 模式下的统一间隔（毫秒）' },
      gaps: { type: 'array', items: { type: 'number' }, description: 'fixed 模式下逐条间隔（长度=条数-1）' },
    },
    required: ['messages'],
    check: (args) => (Array.isArray(args.messages) && !args.messages.length ? 'messages 不能是空数组' : null),
    call: (args, { key }) => post('/api/socialV2/send-message', {
      key,
      messages: unwrapMessages(args.messages),
      replyToMessageId: args.replyToMessageId,
      atUserId: args.atUserId ?? null,
      gapMode: args.gapMode,
      gapMs: args.gapMs,
      gaps: args.gaps,
    }, 300000),
    errorPrefix: '发送失败：',
  },
  {
    // MCP 那边的 qq_reply 只能在群里用、走 /api/send/reply；这里就是带引用的一条 qq_send_message，私聊也能用
    name: 'qq_reply',
    flag: 'reply',
    sides: ['chat'],
    description: (cfg) => '在这个聊天里引用/回复某条消息，并发送一条文本。适合消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id；这个 id 必须是这个聊天里的消息。不要每条都引用。'
      + REPLY_RULE + holdSendNote(cfg),
    properties: {
      replyToMessageId: { ...ID, description: '被引用/回复的消息 id（非零整数，可为负数）' },
      message: { type: 'string', description: '要发送的文本，纯文本，不要用 Markdown 或 CQ 码' },
    },
    required: ['replyToMessageId', 'message'],
    call: (args, { key }) => post('/api/socialV2/send-message', { key, messages: unwrapMessages(args.message), replyToMessageId: args.replyToMessageId, atUserId: null }, 300000),
    errorPrefix: '发送失败：',
  },
  {
    name: 'qq_send_poke',
    flag: 'sendPoke',
    sides: ['chat'],
    description: () => '发送 QQ 拍一拍。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传（默认拍当前私聊对象）。',
    properties: {
      targetUserId: { ...ID, description: '要拍的群友 QQ 号（群聊必填；私聊可选）' },
    },
    required: [],
    call: (args, { key }) => post('/api/socialV2/send-poke', { key, targetUserId: args.targetUserId != null ? String(args.targetUserId) : '' }, 60000),
    errorPrefix: '拍一拍失败：',
  },
  {
    name: 'qq_wait_for_messages',
    flag: 'waitMessages',
    sides: ['chat'],
    description: () => '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。等对方继续说、等某个人回答：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs。群里最多等半分钟，等到的大部分不是对你说的，有人 @/引用/叫你名字、或群里在接你的话时会提前返回并带 earlyReturn。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。回完不用守着等，收尾用 qq_mark_read，有人找你会叫醒你。',
    properties: {
      purpose: { type: 'string', enum: ['messages', 'reply'], description: '默认 messages：等新消息、等对方回答；reply：回复前短静默，计入最后来信后已过去的时间' },
      timeoutMs: { type: 'number', description: '等待预算毫秒数，默认 30000、最长 600000（群里最多 30000）；reply 达到静默即返回，不必等满' },
      minNewMessages: { type: 'integer', description: '仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它' },
      quietMs: { type: 'number', description: '' },
    },
    required: [],
    // quietMs 的说明看等对方说完开着没有（同 MCP 那边），parametersOf 里换
    quietNote: (cfg) => (cfg?.socialV2?.replyTiming?.enabled === true
      ? '一般不用填：会按对方平时连发的快慢和他最后那句（说一半、只发了图、问你的话）自动定；填了只会等得更久。reply 从最后来信开始计时，messages 只在等到新消息后计时'
      : '静默窗口毫秒数，建议 3000~5000，对方明显没说完再长一点；reply 从最后来信开始计时，messages 只在等到新消息后计时'),
    // 走长轮询：私聊里最多等 600 秒，超过 fetch 的 300 秒 headersTimeout（见 mcp-snowluma-safe.js 的 agentApiLongPoll）
    call: (args, { key }) => ({
      ...post('/api/socialV2/wait', { key, purpose: args.purpose, timeoutMs: args.timeoutMs, minNewMessages: args.minNewMessages, quietMs: args.quietMs },
        Math.min(725000, (Number(args.timeoutMs) || 30000) + Math.max(Number(args.quietMs) || 0, 10000) + 20000)),
      longPoll: true,
    }),
    errorPrefix: '等待失败：',
  },
  {
    name: 'qq_get_message_detail',
    flag: 'getMessageDetail',
    sides: ['chat'],
    description: () => '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
    properties: {
      messageId: { ...ID, description: '要查看的消息 id（QQ 消息 id 可能为负数）' },
    },
    required: ['messageId'],
    call: (args, { key }) => get('/api/socialV2/message-detail', { key, messageId: args.messageId }),
    errorPrefix: '获取消息详情失败：',
  },
  {
    name: 'qq_get_active_members',
    flag: 'getActiveMembers',
    sides: ['chat'],
    description: () => '查看最近活跃成员列表（只读），帮助判断话题参与者。',
    properties: {
      limit: { type: 'number', description: '最多返回人数，默认 10，最大 20' },
    },
    required: [],
    call: (args, { key }) => get('/api/socialV2/active-members', { key, limit: args.limit ?? 10 }),
    errorPrefix: '获取活跃成员失败：',
  },
  {
    name: 'qq_memory_append',
    flag: 'memory',
    sides: ['chat'],
    description: () => '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
    properties: {
      category: { ...MEMORY_CATEGORY, description: '记忆类别' },
      content: { type: 'string', description: '记忆内容，例如话题、想说的话、对某人的印象标签' },
      extra: {
        type: 'object',
        description: '附加信息',
        properties: {
          target: { type: 'string', description: 'memberImpression 时的群友名字/昵称' },
          participants: { type: 'array', items: { type: 'string' }, description: 'activeTopic 的参与者列表' },
          pendingQuestion: { type: 'string', description: 'activeTopic 里还没问出口的问题' },
          motivation: { type: 'string', description: 'pendingThought 的动机，如 curiosity/sociability' },
          expiresAtMs: { type: 'number', description: 'pendingThought 过期毫秒数，默认 2 小时' },
        },
      },
    },
    required: ['category', 'content'],
    call: (args, { key }) => post('/api/socialV2/memory-append', { key, category: args.category, content: args.content, extra: args.extra || {} }),
    errorPrefix: '记忆写入失败：',
  },
  {
    name: 'qq_memory_query',
    flag: 'memory',
    sides: ['chat'],
    description: () => '查看这个聊天的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
    properties: {
      category: { ...MEMORY_CATEGORY, description: '可选：只看某一类记忆' },
    },
    required: [],
    call: (args, { key }) => get('/api/socialV2/memory', { key, category: args.category }),
    errorPrefix: '记忆读取失败：',
  },
  {
    name: 'qq_memory_remove',
    flag: 'memory',
    sides: ['chat'],
    description: () => '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
    properties: {
      category: { ...MEMORY_CATEGORY, description: '记忆类别' },
      content: { type: 'string', description: '要删除的话题/想法原文（memberImpression 不需要）' },
      target: { type: 'string', description: 'memberImpression 时要删除的群友名字' },
    },
    required: ['category'],
    call: (args, { key }) => post('/api/socialV2/memory-remove', { key, category: args.category, content: args.content || '', target: args.target || '' }),
    errorPrefix: '记忆删除失败：',
  },
  {
    name: 'qq_memory_clear',
    flag: 'memory',
    sides: ['chat'],
    description: () => '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
    properties: {
      category: { ...MEMORY_CATEGORY, description: '要清空的类别，缺省清空全部' },
    },
    required: [],
    call: (args, { key }) => post('/api/socialV2/memory-clear', { key, category: args.category || '' }),
    errorPrefix: '记忆清空失败：',
  },
  {
    name: 'qq_slang_query',
    flag: 'slangQuery',
    sides: ['chat'],
    description: () => '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
    properties: {
      q: { type: 'string', description: '可选搜索词，按词条/含义/用法/示例过滤' },
    },
    required: [],
    call: (args, { key }) => get('/api/socialV2/slang/query', { key, q: args.q }),
    errorPrefix: '查询黑话失败：',
  },
  {
    name: 'qq_slang_submit',
    flag: 'slangSubmit',
    sides: ['chat'],
    description: () => '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达记下来。先进候选，确认后会写进黑话表，以后能查、能用。',
    properties: {
      content: { type: 'string', description: '要提交的陌生词/黑话/梗（最多 50 字）' },
      context: { type: 'string', description: '可选：你是在什么语境/哪条消息里看到的' },
    },
    required: ['content'],
    call: (args, { key }) => post('/api/socialV2/slang/submit', { key, content: args.content, context: args.context || '' }),
    errorPrefix: '提交黑话失败：',
  },
  {
    name: 'qq_list_stickers',
    flag: 'listStickers',
    sides: ['chat'],
    enabled: stickersOn,
    description: () => '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    properties: {
      query: { type: 'string', description: '可选搜索词，按备注/本地笔记/标签/用法过滤' },
      count: { type: 'number', description: '最多返回条数，默认 48，最多 100' },
      refresh: { type: 'boolean', description: '是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）' },
    },
    required: [],
    // 强制同步有副作用，走 POST（同 MCP 那边）
    call: (args, { key }) => post('/api/socialV2/sticker-list', { key, query: args.query ? String(args.query) : '', count: args.count, refresh: args.refresh === true }),
    errorPrefix: '获取表情列表失败：',
  },
  {
    name: 'qq_send_sticker',
    flag: 'sendSticker',
    sides: ['chat'],
    enabled: stickersOn,
    description: () => '在这个聊天里发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    properties: {
      stickerId: STICKER_ID,
      replyToMessageId: { ...ID, description: '要引用/回复的消息 id（非零整数，可为负数，可选）' },
      atUserId: { ...ID, description: '要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）' },
    },
    required: ['stickerId'],
    call: (args, { key }) => post('/api/socialV2/send-sticker', { key, stickerId: String(args.stickerId), replyToMessageId: args.replyToMessageId, atUserId: args.atUserId ?? null }, 300000),
    errorPrefix: '发送表情失败：',
  },
  {
    name: 'qq_collect_sticker',
    flag: 'collectSticker',
    sides: ['chat'],
    enabled: stickersOn,
    description: () => '收藏这个聊天里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（写它表达什么，如“不想干活”“得意坏笑”）和用法 usage（什么时候发）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    properties: {
      messageId: { ...ID, description: '要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）' },
      remark: { type: 'string', description: '简短备注，最多 20 字：它表达什么，例如“不想干活”“得意坏笑”，别只写长相' },
      usage: { type: 'string', description: '可选：什么时候发它，例如“被说中了、得逞的时候”，最多 200 字（只记在本地）' },
    },
    required: ['messageId'],
    call: (args, { key }) => post('/api/socialV2/collect-sticker', { key, messageId: String(args.messageId), remark: args.remark || '', usage: args.usage || '' }, 60000),
    errorPrefix: '收藏表情失败：',
  },
  {
    name: 'qq_sticker_note',
    flag: 'stickerNote',
    sides: ['chat'],
    enabled: stickersOn,
    description: () => '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。最要紧的是 usage：它替你说什么话、什么时候发（“被说中了得意”“不想干活”），别只记长相。',
    properties: {
      stickerId: STICKER_ID,
      note: { type: 'string', description: '你理解的表情含义/适合场景，最多 200 字' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 ["嘲讽","笑哭","怼人"]' },
      usage: { type: 'string', description: '它表达什么、什么时候发，例如“得逞了、坏笑”，最多 200 字' },
    },
    required: ['stickerId'],
    call: (args, { key }) => {
      const body = { key, stickerId: String(args.stickerId) };
      if (args.note !== undefined && args.note !== null) body.note = String(args.note);
      if (args.tags !== undefined && args.tags !== null) body.tags = args.tags.map(String);
      if (args.usage !== undefined && args.usage !== null) body.usage = String(args.usage);
      return post('/api/socialV2/sticker-note', body);
    },
    errorPrefix: '记录表情备注失败：',
  },
  {
    name: 'qq_send_screenshot',
    flag: 'sendScreenshot',
    sides: ['chat'],
    description: () => '把你浏览器里正在看的网页截一张图发到这个聊天里（想给大家看看你看到的东西时用）。默认截最后打开的那个标签页，要截别的就传 tabIndex（browser_tabs 列表里的序号）。图里不能带文字说明，想说的话先用 qq_send_message 单独发。',
    properties: {
      tabIndex: { type: 'integer', description: '要截的标签页序号（可选）' },
    },
    required: [],
    check: (args) => (args.tabIndex !== undefined && args.tabIndex < 0 ? 'tabIndex 不能是负数' : null),
    call: (args, { key }) => post('/api/socialV2/send-screenshot', { key, tabIndex: args.tabIndex }, 120000),
    errorPrefix: '截图发送失败：',
  },
  {
    name: 'qq_draw',
    flag: 'draw',
    sides: ['chat'],
    description: () => '画一张画发到这个聊天里（有人让你画、或者你自己想画给大家看时用）。画出来是你自己用蜡笔、彩铅画的小孩画，风格不用写，只写画什么：画面里有谁、在干嘛、什么颜色、背景是什么，写具体一点。想要画上写字就写明要写哪几个字。画群里的人（“画画我们”“把大家画进去”“画某某”）就真把他们画进去，别换成小动物：prompt 里用群名片叫他们，写上你知道的他们的事、群里正聊的梗，people 填他们的 QQ 号，会照着头像和你对他们的了解补上样子；说了不要谁就别画谁。友好地画，不丑化、不画成坏人、不画黄的。一张要一两分钟到好几分钟，工具马上返回，画好了会自己发出去，到时候会告诉你；所以先跟人说一声你去画了（“等我画一下”），别说已经画好了，也别为同一张再调一次。caption 是跟在图后面的一句话（可选）。要看画成什么样，画好以后用 qq_get_message_images 看你发的那条。一天最多画 100 张。结果不是 ok 就是没开始画，照实说。',
    properties: {
      prompt: { type: 'string', description: '要画什么（中文描述画面，300 字以内）' },
      caption: { type: 'string', description: '跟在图后面的一句话（可选）' },
      people: PEOPLE,
    },
    required: ['prompt'],
    check: (args) => (Array.isArray(args.people) && args.people.length > 4 ? 'people 最多 4 个' : null),
    call: (args, { key }) => post('/api/socialV2/draw', { key, prompt: args.prompt, caption: args.caption, people: args.people }),
    errorPrefix: '没开始画：',
  },
  {
    name: 'qq_make_video',
    flag: 'video',
    sides: ['chat'],
    description: () => '做一段短视频发到这个聊天里（有人让你做个视频、或者你自己想做一段给大家看时用），和画画是两回事。做出来是一段几秒的视频，带声音，可以是真人实拍感、动画、手绘等任何风格，prompt 里写清楚：画面里有谁、在干嘛、怎么动、镜头怎么走、什么风格、要什么声音。视频里要有群里的人（“拍拍我们”“把大家画进去”“画某某”）就真让他们出演，别换成小动物：prompt 里用群名片叫他们，写上你知道的他们的事、群里正聊的梗，people 填他们的 QQ 号，会照着头像和你对他们的了解补上样子；说了不要谁就别画谁。友好地画，不丑化、不画成坏人、不画黄的。一段要一两分钟，工具马上返回，做好了会自己发出去，到时候会告诉你；所以先跟人说一声你去做了（“等我做一下”），别说已经做好了，也别为同一段再调一次。caption 是视频发出去后跟着的一句话（可选）；seconds 是时长，1~15 秒，不填就是 8 秒。要看做成什么样，做好以后用 qq_get_message_images 看你发的那条（是抽了几帧拼的图）。结果不是 ok 就是没开始做，照实说。',
    properties: {
      prompt: { type: 'string', description: '视频内容（中文描述画面、动作、镜头、风格、声音，500 字以内）' },
      caption: { type: 'string', description: '跟在视频后面的一句话（可选）' },
      seconds: { type: 'integer', description: '时长，1~15 秒，不填是 8 秒' },
      people: PEOPLE,
    },
    required: ['prompt'],
    check: (args) => {
      if (args.seconds !== undefined && (args.seconds < 1 || args.seconds > 15)) return 'seconds 要在 1~15 之间';
      if (Array.isArray(args.people) && args.people.length > 4) return 'people 最多 4 个';
      return null;
    },
    call: (args, { key }) => post('/api/socialV2/video', { key, prompt: args.prompt, caption: args.caption, seconds: args.seconds, people: args.people }),
    errorPrefix: '没开始做：',
  },
  {
    name: 'qq_send_meme',
    flag: 'sendMeme',
    sides: ['chat'],
    description: () => '把 Telegram 沙雕图频道的一条帖子（先用 mcp__qqbot-extras__tg_browse / tg_look 找到、看过）的图发到这个聊天里，caption 是可选的一句短吐槽，会跟在图后面。一条一次调用。频率、白名单、红线关键词由工具检查，被拒绝就算了，像人一样随口带过，别把拒绝理由原样转述给别人。发出去的不要再用 qq_send_message 重复发。',
    properties: {
      post: { type: 'string', description: '帖子编号，形如 "woshadiao/209091"（tg_browse 返回的 post）' },
      caption: { type: 'string', description: '一句短吐槽（可选）' },
    },
    required: ['post'],
    call: (args, { key }) => post('/api/socialV2/send-meme', { key, post: args.post, caption: args.caption }, 120000),
    errorPrefix: '搬图失败：',
  },
  {
    name: 'qq_go_play',
    flag: 'goPlay',
    sides: ['chat'],
    description: () => '聊天里说好要去看个视频、玩个游戏、查个东西，或者答应了“接着玩”“多玩一会儿”“玩到通关再给你们看”时，用它交给“去玩的你”去做（另一个会话，用另一台浏览器），聊天这边不会被占住、照样能回消息。note 写清楚要做什么、看完要不要发回这里。说好要多玩一会儿就填 minutes：那边会一直玩到差不多这么久，中途把截图、进展发回这里。',
    properties: {
      note: { type: 'string', description: '要去做什么，比如“看看 BV1xx 这个视频，好笑的话截图发回来”，最多 300 字' },
      minutes: { type: 'number', description: '说好要接着玩/多玩一会儿时，大概玩几分钟（3~60）；只是看一眼、查个东西就不填' },
    },
    required: ['note'],
    call: (args, { key }) => post('/api/socialV2/go-play', { key, note: args.note, ...(args.minutes ? { minutes: args.minutes } : {}) }, 60000),
    errorPrefix: '没交出去：',
  },
  {
    name: 'qq_go_to_sleep',
    flag: 'goToSleep',
    sides: ['chat'],
    description: () => '你说要去睡了的时候调用（先在聊天里说完晚安再调；晚安在家里的小群、私聊或正聊着的地方说，别专门跑去别的群说）。所有地方一起睡：电脑那边在玩的你会收尾，别的聊天窗口也会收尾，之后谁找你都看不到，只有主人亲自叫才醒，早上起床时间自然醒。只在快到睡觉时间或夜里能用；白天困了用 qq_set_mood 记一下就好。调完就结束这一轮。',
    properties: {
      note: { type: 'string', description: '一句话，比如“困了，跟大家说了晚安”，最多 100 字' },
    },
    required: [],
    call: (args, { key }) => post('/api/socialV2/go-to-sleep', { key, note: args.note || '' }),
    errorPrefix: '没睡成：',
  },
  {
    name: 'qq_remind_me',
    flag: 'remindMe',
    sides: ['chat'],
    description: () => '答应了“待会儿”“过半小时”“晚上八点”“明天”再做的事，用它记下来，到点这个聊天会叫你回来（提示里是【到点了】）。光嘴上说“等会儿给你看”是做不到的：你不会自己记得。答应的是“等某人睡了/回来了/说了什么再告诉你”这种，填 waitFor 和 waitWords：那个人说了这类话，这里马上叫你回来（时间就是最晚等到什么时候，不填等 3 小时）；你自己没法盯着谁，不记就别这么答应。只填 note 不填时间、也不填 cancel，就是看看这里记着哪些。夜里睡着时不叫，醒了再叫。',
    properties: {
      note: { type: 'string', description: '到点要做什么，写给到时候的自己看，比如“给阿红发 2048 的截图，说好打到 1024”，最多 100 字' },
      minutes: { type: 'number', description: '多少分钟以后（1~2880）' },
      at: { type: 'string', description: '或者到几点，24 小时制 HH:MM，比如 "20:30"；已经过了就是明天这个点' },
      cancel: { type: 'string', description: '不用提醒了：填那条的 id，或者 "all" 把这里的都取消' },
      waitFor: { type: 'string', description: '等谁：QQ 号最准，也可以填群名片/昵称或“爸爸”“妈妈”' },
      waitWords: { type: 'string', description: '等他说什么，几个词用逗号隔开，比如 "晚安,睡了,去睡"；不填就是他一说话就叫你' },
      waitIn: { type: 'string', description: '只看哪个聊天（group:群号 / private:QQ号），"any" 是哪里都算；不填时私聊只看这里，群里哪里都算' },
    },
    required: [],
    call: (args, { key }) => post('/api/socialV2/remind', {
      key,
      note: args.note || '',
      ...(args.minutes ? { minutes: args.minutes } : {}),
      ...(args.at ? { at: args.at } : {}),
      ...(args.cancel ? { cancel: args.cancel } : {}),
      ...(args.waitFor ? { waitFor: args.waitFor, waitWords: args.waitWords || '', waitIn: args.waitIn || '' } : {}),
    }),
    errorPrefix: '没记上：',
  },
  {
    name: 'qq_tell_myself',
    flag: 'tellMyself',
    sides: ['chat'],
    description: () => '你在每个聊天窗口、电脑那边都是分开的，这里说好的事别处的你不知道。主人在这里（私聊或家里的小群）让你做的事牵涉到别的窗口时（“别玩了”“去群里跟大家说一声”“那边别再发图了”），用它捎给那边的你：那边正聊着会马上看到，不在聊就等那边下次被叫醒时看到（不会专门叫醒）。让你别玩了就填 stopPlay=true：电脑那边在玩的你马上收尾，之后一段时间不去玩，有人托你去玩也会被拦；在大群里陪人玩着的，再用 to 捎一句让那边跟大家说一声。note 只写那边要做什么，别写这里聊了什么。只能在私聊和家里的小群用，而且得是主人刚说的。',
    properties: {
      to: { type: 'string', description: '捎给哪：那个聊天（比如 "group:123"），"play:main" 是电脑那边，"all" 是别的所有聊天窗口；只 stopPlay 可以不填' },
      note: { type: 'string', description: '那边要做什么，写给那边的自己，比如“先不玩了，跟大家说一声晚点再玩”，最多 150 字' },
      stopPlay: { type: 'boolean', description: '答应了先不玩：电脑那边马上收尾，一段时间内不去玩' },
      minutes: { type: 'number', description: 'stopPlay 时多久不去玩（10~360），不填是 60' },
    },
    required: [],
    call: (args, { key }) => post('/api/socialV2/tell-myself', { key, to: args.to || '', note: args.note || '', ...(args.stopPlay ? { stopPlay: true } : {}), ...(args.minutes ? { minutes: args.minutes } : {}) }, 60000),
    errorPrefix: '没捎过去：',
  },
  {
    name: 'qq_send_elsewhere',
    flag: 'sendElsewhere',
    sides: ['chat'],
    description: () => '替这里去别的聊天窗口说句话：主人在这里（私聊或家里的小群）让你现在就去别处说一声时用（“跟妈妈说晚安”“去小群里告诉大家我到家了”）。qq_send_message 只能在这个窗口里说。to 填要去说话的那个聊天；只能发到私聊和家里的小群，别的群用 qq_tell_myself 让那边的你去说。发的就是那边的人会看到的话，写成在那边说的样子（别把这里聊的内容搬过去）；那边的你下次看消息时会知道这是你从这里发的，那边有人回话是那边的你去接。得是主人刚在这里说的。结果不是 ok 就是没发出去，照实跟这边说，别说已经发了。',
    properties: {
      to: { type: 'string', description: '要去说话的聊天，比如 "group:123" 或 "private:456"' },
      messages: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '在那边要说的话：字符串=一条；数组=分多条' },
      atUserId: { ...ID, description: '群里要 @ 的人的 QQ 号（可选，私聊不用）' },
    },
    required: ['to', 'messages'],
    check: (args) => {
      if (!/^(group|private):\d+$/.test(String(args.to))) return 'to 要写成 group:群号 或 private:QQ号';
      return Array.isArray(args.messages) && !args.messages.length ? 'messages 不能是空数组' : null;
    },
    call: (args, { key }) => post('/api/socialV2/send-elsewhere', { key, to: args.to, messages: unwrapMessages(args.messages), atUserId: args.atUserId ?? null }, 300000),
    errorPrefix: '没发出去：',
  },
  {
    name: 'qq_send_voice',
    flag: 'sendVoice',
    sides: ['chat'],
    enabled: voiceOn,
    description: () => '在这个聊天里发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经回读到这条语音确实落地了，只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    properties: {
      voice: { type: 'string', description: '语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）' },
      label: { type: 'string', description: '可选：写进会话记录里的说明，如「说了句晚安」' },
      verify: { type: 'boolean', description: '是否回读校验语音已落地（默认 true，建议保持开启）' },
      readback: { type: 'boolean', description: '是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）' },
    },
    required: ['voice'],
    call: (args, { key }) => post('/api/socialV2/send-voice', { key, voice: String(args.voice), label: args.label || '', verify: args.verify !== false, readback: args.readback === true }, 300000),
    errorPrefix: '发送语音失败：',
  },
  {
    name: 'qq_list_voices',
    flag: 'sendVoice',
    sides: ['chat'],
    enabled: voiceOn,
    description: () => '查看可用的语音库（准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    properties: {
      probe: { type: 'boolean', description: '是否逐个探测时长（默认 true；文件多时可传 false 加快）' },
    },
    required: [],
    call: (args, { key }) => get('/api/socialV2/voices', { key, probe: args.probe === false ? '0' : undefined }),
    errorPrefix: '获取语音库失败：',
  },
]);

export function capabilitiesFor(side) {
  return CAPABILITIES.filter((c) => c.sides.includes(side));
}
// 所有原生 QQ 工具的名字（守卫 qq-tool-restrict 按它放行；两边同名的只算一次）
export const NATIVE_TOOL_NAMES = Object.freeze([...new Set(CAPABILITIES.map((c) => c.name))]);
// 一边的原生工具名（preset 的 hideTools 要把同名的 MCP 版藏掉）
export function nativeToolNamesFor(side) {
  return capabilitiesFor(side).map((c) => c.name);
}

export function capabilityEnabled(cap, cfg) {
  return cfg?.socialV2?.tools?.[cap.flag] !== false && (cap.enabled?.(cfg) ?? true);
}

export function parametersOf(cap, cfg) {
  const properties = cap.quietNote ? { ...cap.properties, quietMs: { ...cap.properties.quietMs, description: cap.quietNote(cfg) } } : cap.properties;
  return { type: 'object', properties, required: cap.required, additionalProperties: false };
}

// 照参数 schema 查一遍（DSH 的注册表不替原生工具查参数）：多的参数、缺的参数、类型不对。返回错误文字或 null。
function typeOk(schema, value) {
  if (schema.oneOf) return schema.oneOf.some((s) => typeOk(s, value));
  switch (schema.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && (!schema.items || value.every((v) => typeOk(schema.items, v)));
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}
export function checkArgs(cap, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数要是一个对象';
  for (const k of Object.keys(args)) {
    if (!Object.hasOwn(cap.properties, k)) {
      return k === 'key' || k === 'token'
        ? `${cap.name} 不用填 ${k}${cap.properties.to === TO ? '，发到哪个聊天写在 to 里' : ''}`
        : `${cap.name} 没有参数 ${k}`;
    }
  }
  for (const k of cap.required) if (args[k] === undefined || args[k] === null) return `缺参数 ${k}`;
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (!typeOk(cap.properties[k], v)) return `参数 ${k} 的类型不对`;
  }
  if (cap.properties.to === TO && !/^(group|private):\d+$/.test(String(args.to))) return 'to 要写成 group:群号 或 private:QQ号';
  for (const k of ['throughSeq', 'afterSeq']) if (Number.isInteger(args[k]) && args[k] < 0) return `${k} 不能是负数`;
  return cap.check?.(args) ?? null;
}
