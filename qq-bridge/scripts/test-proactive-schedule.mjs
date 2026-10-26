// qqbot_agent：作息表的单元测试。node scripts/test-proactive-schedule.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inNightSleep, proactiveSlot } from '../src/proactive-schedule.js'

const at = (hh, mm) => new Date(2026, 9, 21, hh, mm)
const cfg = {
  schedule: [
    { from: '22:30', to: '07:30', probability: 0 },
    { from: '07:30', to: '12:00', probability: 0.4, checkIntervalMinMs: 5400000 },
    { from: '19:00', to: '22:30', probability: 0.8 },
  ],
}

test('没有 schedule 时返回 null，沿用旧逻辑', () => {
  assert.equal(proactiveSlot({ probability: 0.5 }, at(12, 0)), null)
})

test('命中普通时间段并带上该段的间隔', () => {
  const slot = proactiveSlot(cfg, at(9, 15))
  assert.equal(slot.probability, 0.4)
  assert.equal(slot.checkIntervalMinMs, 5400000)
})

test('跨零点的时间段两侧都能命中', () => {
  assert.equal(proactiveSlot(cfg, at(23, 59)).probability, 0)
  assert.equal(proactiveSlot(cfg, at(3, 0)).probability, 0)
  assert.equal(proactiveSlot(cfg, at(7, 29)).probability, 0)
  assert.equal(proactiveSlot(cfg, at(7, 30)).probability, 0.4)
})

test('区间左闭右开，未覆盖的时间概率为 0', () => {
  assert.equal(proactiveSlot(cfg, at(22, 29)).probability, 0.8)
  assert.equal(proactiveSlot(cfg, at(22, 30)).probability, 0)
  assert.equal(proactiveSlot(cfg, at(15, 0)).probability, 0)
})

test('坏数据被忽略，概率被夹到 0~1', () => {
  const slot = proactiveSlot({ schedule: [{ from: 'x', to: '10:00', probability: 1 }, { from: '00:00', to: '23:59', probability: 5 }] }, at(9, 0))
  assert.equal(slot.probability, 1)
})

test('夜里睡觉：跨零点、左闭右开、关掉或坏数据就不睡', () => {
  const n = { enabled: true, from: '22:30', to: '07:30' }
  assert.equal(inNightSleep(n, at(22, 29)), false)
  assert.equal(inNightSleep(n, at(22, 30)), true)
  assert.equal(inNightSleep(n, at(3, 0)), true)
  assert.equal(inNightSleep(n, at(7, 30)), false)
  assert.equal(inNightSleep({ ...n, enabled: false }, at(3, 0)), false)
  assert.equal(inNightSleep({ from: 'x', to: '07:30' }, at(3, 0)), false)
  assert.equal(inNightSleep(undefined, at(3, 0)), false)
})
