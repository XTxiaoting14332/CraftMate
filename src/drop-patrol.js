// 掉落物巡检: 空闲时周期性扫描视野内/周围的掉落物并本地捡起,
// 不依赖模型再规划一次"走过去捡东西", 捡到后产生 auto_pickup 事件让 AI 知情。
import { state, pushEvent, pushActivity } from './bot.js'
import { droppedItemsNear, pickupNearbyDrops } from './actions.js'
import { hasLineOfSightToPoint } from './world.js'

const DEFAULT_CONFIG = {
  enabled: true,
  scan_interval_ms: 10000,
  radius: 12,
  timeout_ms: 12000,
}

let timer = null
let botRef = null
let config = { ...DEFAULT_CONFIG }
let busy = false
let nextScanAt = 0
let lastPickedAt = 0
let pickedTotal = 0

export function startDropPatrol(bot, opts = {}) {
  stopDropPatrol()
  botRef = bot
  config = { ...DEFAULT_CONFIG, ...opts }
  nextScanAt = Date.now() + 5000 + Math.random() * 5000
  if (!config.enabled) return
  timer = setInterval(tick, 2000)
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopDropPatrol() {
  if (timer) clearInterval(timer)
  timer = null
  botRef = null
  busy = false
}

export function dropPatrolStatus() {
  return {
    enabled: Boolean(timer),
    scan_interval_ms: config.scan_interval_ms,
    radius: config.radius,
    next_scan_in_ms: Math.max(0, Math.round((nextScanAt - Date.now()) / 1000) * 1000),
    busy,
    last_picked_at: lastPickedAt || null,
    picked_total: pickedTotal,
  }
}

function tick() {
  if (!timer || state.bot !== botRef || !botRef?.entity || botRef.entity.health <= 0) return
  if (state.defense?.active || state.task || state.containerWindow || busy) return
  if (Date.now() < nextScanAt) return
  void scanDropsOnce(botRef, config)
}

// 拟真模式下只检"看得见"的掉落物(3 格内视线天然成立);
// 主动挖掘后的自动拾取仍按原有双圆心逻辑覆盖墙角/脚下掉落。
function scanTargets(bot, radius) {
  const all = droppedItemsNear(bot, radius)
  if (state.options?.fairPerception === false) return all
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  return all.filter((e) => {
    if (eye.distanceTo(e.position) <= 3) return true
    return hasLineOfSightToPoint(bot, e.position.offset(0, 0.2, 0))
  })
}

export async function scanDropsOnce(bot, opts = {}) {
  if (busy) return { busy: true }
  const cfg = { ...DEFAULT_CONFIG, ...opts }
  const before = scanTargets(bot, cfg.radius)
  if (!before.length) {
    nextScanAt = Date.now() + cfg.scan_interval_ms + Math.random() * cfg.scan_interval_ms
    return { scanned: 0, picked: 0, drops_remaining: droppedItemsNear(bot, cfg.radius).length }
  }
  busy = true
  const scanTask = { cancelled: false }
  const guard = setInterval(() => {
    if (state.task || state.defense?.active || state.bot !== bot) scanTask.cancelled = true
  }, 400)
  if (typeof guard.unref === 'function') guard.unref()
  try {
    const r = await pickupNearbyDrops(bot, {
      radius: cfg.radius,
      timeoutMs: cfg.timeout_ms,
      pauseMs: 150,
      task: scanTask,
    })
    const remaining = droppedItemsNear(bot, cfg.radius).length
    if (before.length > remaining || remaining < r.drops_remaining) {
      // 用实体数量差作为被吸进背包的近似值(服务器拾取会有短暂延迟)
      const picked = Math.max(1, before.length - remaining)
      lastPickedAt = Date.now()
      pickedTotal += picked
      pushEvent('auto_pickup', {
        picked,
        scanned: before.length,
        remaining,
        remaining_nearest: r.remaining_nearest,
      })
      pushActivity({ source: 'drop_patrol', kind: 'pickup', text: `自动捡起 ${picked} 个掉落物, 附近还剩 ${remaining} 个` })
    }
    return { scanned: before.length, picked: Math.max(0, before.length - remaining), drops_remaining: remaining, detail: r }
  } finally {
    clearInterval(guard)
    busy = false
    nextScanAt = Date.now() + cfg.scan_interval_ms + Math.random() * cfg.scan_interval_ms
  }
}
