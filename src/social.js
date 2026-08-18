// 主动社交巡检: 真人会主动找熟人搭话、跟新玩家打招呼、回应靠近的人。
// 这里在空闲时周期性检测"社交机会", 产生 social_hint 事件唤醒模型, 由模型决定要不要搭话。
// 只提示不自动发言——说什么、对谁说由 AI 决定(社交有后果, 不猜)。
import { state, pushEvent } from './bot.js'

const SCAN_MS = 15000 // 每 15 秒轻扫一次
const NEARBY_RADIUS = 16 // 附近玩家半径
const SILENT_FOR_MS = 90 * 1000 // 同一玩家 90 秒内不重复提示
const NEW_PLAYER_GRACE_MS = 25 * 1000 // 新玩家进服后 25 秒内给一次提示
const MAX_HINTS_PER_TICK = 1

let timer = null
let botRef = null
let lastHintAt = new Map() // name -> timestamp, 防重复提示
let notifiedNew = new Set() // 已提示过的新玩家
let enabled = true

export function startSocial(bot, opts = {}) {
  stopSocial()
  botRef = bot
  enabled = opts.enabled !== false
  if (!enabled) return
  timer = setInterval(tick, SCAN_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopSocial() {
  if (timer) clearInterval(timer)
  timer = null
  botRef = null
}

export function socialStatus() {
  return { enabled: Boolean(timer && enabled) }
}

function tick() {
  if (!timer || state.bot !== botRef || !botRef?.entity || botRef.entity.health <= 0) return
  // 只在真正空闲时提示(有任务/战斗/开箱时不打扰模型)
  if (state.defense?.active || state.task || state.containerWindow) return
  void scanOnce(botRef)
}

function scanOnce(bot) {
  try {
    const me = bot.entity
    const now = Date.now()
    let hints = 0

    for (const e of Object.values(bot.entities || {})) {
      if (hints >= MAX_HINTS_PER_TICK) break
      if (!e || e === me || e.type !== 'player' || !e.username || e.username === bot.username) continue
      if (e.isValid === false || !e.position) continue
      if (e.position.distanceTo(me.position) > NEARBY_RADIUS) continue

      const lastSeen = bot.players?.[e.username]
      const joinedRecently = lastSeen && (now - (lastSeen.lastSeen ?? 0)) < NEW_PLAYER_GRACE_MS
      // 1. 新玩家(进服后第一次出现在附近): 提示一次
      if (joinedRecently && !notifiedNew.has(e.username)) {
        notifiedNew.add(e.username)
        lastHintAt.set(e.username, now)
        pushEvent('social_hint', {
          kind: 'new_player',
          player: e.username,
          distance: Math.round(e.position.distanceTo(me.position)),
          note: `新玩家「${e.username}」就在附近(约 ${Math.round(e.position.distanceTo(me.position))} 格), 可以主动打个招呼。`,
        })
        hints += 1
        continue
      }
      // 2. 附近有玩家但最近没互动(超过 90 秒没提示过): 提醒一次
      const last = lastHintAt.get(e.username) ?? 0
      if (now - last > SILENT_FOR_MS) {
        lastHintAt.set(e.username, now)
        pushEvent('social_hint', {
          kind: 'nearby_player',
          player: e.username,
          distance: Math.round(e.position.distanceTo(me.position)),
          note: `玩家「${e.username}」在你附近(约 ${Math.round(e.position.distanceTo(me.position))} 格)有一阵了, 可以主动说句话或互动一下。`,
        })
        hints += 1
      }
    }
  } catch { /* ignore */ }
}
