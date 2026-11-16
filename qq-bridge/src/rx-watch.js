// 收消息的连接卡住了就自己重连、太久没好私聊告诉主人（2026-11-15）。
//
// 11-15 09:06 QQ 掉线一下、SnowLuma 重启了 OneBot 服务。SDK 重连了一次：建连失败只来了 error、
// 没来 close，connect() 的 promise 一直挂着，SDK 不再重试。之后 77 分钟她一条消息都收不到
// （往外发走 HTTP，还能发，所以她照样往小群发推箱子截图），主人以为她玩得不理人。
//
// 这里只做判断，不碰连接：bridge.js 每 30 秒调一次 rxWatchStep，按返回的 reconnect / alarm 去做。
//   卡住：没连上超过 reconnectAfterMs，或者连着但这么久一个事件包都没有（心跳 30 秒一次）。
//   重连：第一次在卡住满 reconnectAfterMs 时，之后间隔 1、2、4、8 分钟，最多 10 分钟一次。
//   告警：从卡住起 alarmAfterMs 还没好，私聊主人一次（主人 11-15 说直接私聊他，不在小群发）；
//         没发出去 10 分钟后再试；好了再说一声。alarmAfterMs 0 不告警。

export const RX_WATCH_DEFAULTS = { reconnectAfterMs: 3 * 60_000, alarmAfterMs: 10 * 60_000 };
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 10 * 60_000;
const ALARM_RETRY_MS = 10 * 60_000;

export function rxWatchConfig(snowluma = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    reconnectAfterMs: Math.max(60_000, num(snowluma.reconnectAfterMs, RX_WATCH_DEFAULTS.reconnectAfterMs)),
    alarmAfterMs: num(snowluma.alarmAfterMs, RX_WATCH_DEFAULTS.alarmAfterMs),
  };
}

export function newRxWatchState() {
  return { stalledSince: 0, attempts: 0, nextReconnectAt: 0, alarmed: false, alarmTriedAt: 0 };
}

/**
 * 最后一次“收得到”的时间：连着就看最近的事件包（或刚连上的时间），没连上就看断开的时间。
 * @param {{connected?: boolean, lastPacketAt?: number, openedAt?: number, downSince?: number}} health
 */
export function rxQuietSince(health) {
  if (health.connected) return Math.max(Number(health.lastPacketAt) || 0, Number(health.openedAt) || 0);
  return Number(health.downSince) || 0;
}

/**
 * 走一步。会改 state，返回这次要做的事。
 * alarm：'stall' 私聊告诉主人收不到消息了；'recovered' 告诉主人好了（只在之前告诉过时）。
 * 发出去了调用方要 markAlarmSent，没发出去不用管（10 分钟后再给一次 'stall'）。
 */
export function rxWatchStep(state, health, now, cfg) {
  const quietSince = rxQuietSince(health);
  const stalled = quietSince > 0 && now - quietSince >= cfg.reconnectAfterMs;
  if (!stalled) {
    // 刚连上、还没来过新的事件包，不算好了（连上又马上断的时候别告诉主人“好了”）
    if (state.stalledSince && !(health.connected && Number(health.lastPacketAt) > state.stalledSince)) {
      return { stalled: false, reconnect: false, alarm: null, stalledSince: state.stalledSince, attempts: state.attempts };
    }
    const recovered = state.stalledSince > 0;
    const out = { stalled: false, reconnect: false, alarm: recovered && state.alarmed ? 'recovered' : null,
      stalledSince: state.stalledSince, attempts: state.attempts };
    Object.assign(state, newRxWatchState());
    return out;
  }
  if (!state.stalledSince) {
    state.stalledSince = quietSince;
    state.nextReconnectAt = now;
  }
  let reconnect = false;
  if (now >= state.nextReconnectAt) {
    reconnect = true;
    state.nextReconnectAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** state.attempts);
    state.attempts += 1;
  }
  let alarm = null;
  if (cfg.alarmAfterMs > 0 && !state.alarmed && now - state.stalledSince >= cfg.alarmAfterMs
      && (!state.alarmTriedAt || now - state.alarmTriedAt >= ALARM_RETRY_MS)) {
    alarm = 'stall';
    state.alarmTriedAt = now;
  }
  return { stalled: true, reconnect, alarm, stalledSince: state.stalledSince, attempts: state.attempts };
}

export function markAlarmSent(state) {
  state.alarmed = true;
}
