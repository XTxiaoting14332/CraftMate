// 自动防御(生存本能反射): 不经过 LLM 的本地应对, 每 500ms 巡检一次
// - 敌对生物进入警戒半径 → 中断当前任务、装备武器、自动反击(苦力怕: 打了就跑)
// - 生命值过低 → 打断一切任务, 向远离敌人的方向撤退
// - 脱险且安全 → 自动进食(饥饿≥18 时游戏自然回血)
// 全部动作产生 auto_defense 事件, AI 在下一次工具返回的 new_events 里可见。
// 优先级: AI 主动 attack/fight 时不抢战斗; 但"逃跑"优先于一切(生存第一)。
// stop 工具随时可打断反射动作。
import pathfinderPkg from 'mineflayer-pathfinder'
import { state, pushEvent } from './bot.js'
import { hostilesNear } from './world.js'
import { pathfindTo, defaultMovements, safeStopPathfinding } from './movement.js'
import { eatFood } from './actions.js'
import { isFoodItem } from './items.js'
import { fmtPos, sleep, smoothLook, aimJitter, reactionDelayMs } from './util.js'

const { GoalFollow } = pathfinderPkg.goals

const TICK_MS = 500
const ENGAGE_MAX_MS = 60000 // 单次交战上限, 防止无限缠斗
const FLEE_MAX_MS = 30000
const CREEPER_KEEPAWAY = 6 // 与苦力怕保持的最小距离

let interval = null
let botRef = null
let enabled = false
let config = { engageRadius: 8, fleeHp: 6, autoEat: true }
let engageCooldownUntil = 0
let healCooldownUntil = 0

function headOf(entity) {
  return entity.position.offset(0, entity.height ?? 1.6, 0)
}

function summarize(targets) {
  const m = new Map()
  for (const t of targets) m.set(t.name, (m.get(t.name) ?? 0) + 1)
  return [...m.entries()].map(([name, count]) => ({ name, count }))
}

// 远离一群威胁的逃跑点: 所有威胁方向的反向合成
function awayPoint(bot, threats, dist) {
  const p = bot.entity.position
  let dx = 0
  let dz = 0
  for (const t of threats) {
    dx += p.x - t.position.x
    dz += p.z - t.position.z
  }
  const len = Math.hypot(dx, dz) || 1
  return { x: Math.floor(p.x + (dx / len) * dist), y: Math.floor(p.y), z: Math.floor(p.z + (dz / len) * dist) }
}

// 最近 2 秒内掉过血且贴身的生物也算威胁(激怒的中立生物, 如狼/铁傀儡); 不反击玩家
function provocationTarget(bot) {
  if (!state.lastDamagedAt || Date.now() - state.lastDamagedAt > 2000) return null
  let best = null
  let bestD = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue
    if (e.type !== 'mob' && e.type !== 'hostile' && e.type !== 'animal') continue
    const d = bot.entity.position.distanceTo(e.position)
    if (d <= 2.8 && d < bestD) {
      best = { entity: e, name: e.name ?? e.displayName ?? 'unknown', distance: d }
      bestD = d
    }
  }
  return best
}

function combatTargets(bot, radius) {
  const list = hostilesNear(bot, radius)
  const p = provocationTarget(bot)
  if (p && p.distance <= radius && !list.some((x) => x.entity === p.entity)) list.push(p)
  return list.sort((a, b) => a.distance - b.distance)
}

function interruptCurrentTask(bot, reason, includeFight = false) {
  const t = state.task
  if (!t) return
  if (!includeFight && (t.name === 'fight' || t.name === 'attack')) return
  t.cancelled = true
  t.interruptedBy = 'auto_defense'
  safeStopPathfinding(bot)
  pushEvent('auto_defense', { action: 'interrupt_task', task: t.name, reason })
}

async function equipWeapon(bot) {
  try {
    const items = bot.inventory.items()
    const best = items.find((it) => /sword/.test(it.name)) ?? items.find((it) => /_axe/.test(it.name))
    if (best && bot.heldItem?.name !== best.name) await bot.equip(best, 'hand')
  } catch { /* ignore */ }
}

async function runEngage() {
  const bot = botRef
  state.defense.active = true
  state.defense.cancelled = false
  state.defense.action = 'engage'
  interruptCurrentTask(bot, '遭遇敌对生物')
  const initial = combatTargets(bot, config.engageRadius)
  pushEvent('auto_defense', { action: 'engage', targets: summarize(initial), health: Math.round(bot.entity.health) })
  await equipWeapon(bot)
  await sleep(reactionDelayMs()) // 拟人反应时间: 看到→动手之间有延迟, 完美反应是机器人特征
  if (state.defense.cancelled || state.bot !== bot || !bot.entity || bot.entity.health <= 0) {
    state.defense.active = false
    state.defense.action = null
    return
  }
  const engMovements = defaultMovements(bot, false)
  if (engMovements) {
    try { bot.pathfinder.setMovements(engMovements) } catch { /* ignore */ }
  }

  const start = Date.now()
  let reason = 'cleared'
  let goalTarget = null
  let strafeDir = Math.random() < 0.5 ? 'left' : 'right'
  try {
    while (Date.now() - start < ENGAGE_MAX_MS) {
      if (state.defense.cancelled || state.bot !== bot || !bot.entity || bot.entity.health <= 0) {
        reason = state.bot === bot ? 'stopped_by_user' : 'bot_down'
        break
      }
      const targets = combatTargets(bot, config.engageRadius + 4)
      if (!targets.length) { reason = 'cleared'; break }
      if (bot.entity.health <= config.fleeHp) { reason = 'low_hp_flee'; break }
      const t = targets[0]
      const d = t.distance
      await smoothLook(bot, aimJitter(headOf(t.entity)), 150) // 快速甩头(受惊式) + 瞄准偏移, 比瞬移自然

      if (t.name === 'creeper') {
        // 苦力怕: 贴脸时敲一下击退, 然后立即拉开距离等它泄气
        if (d <= 2.6) {
          try { bot.attack(t.entity) } catch { /* ignore */ }
          pushEvent('auto_defense', { action: 'hit_and_run', target: 'creeper' })
        }
        if (d <= CREEPER_KEEPAWAY) {
          goalTarget = null
          safeStopPathfinding(bot)
          try { await pathfindTo(bot, awayPoint(bot, [t.entity], CREEPER_KEEPAWAY + 3), { range: 1, timeoutMs: 4000 }) } catch { /* ignore */ }
          await sleep(300) // 防止寻路瞬间返回时热循环
          continue
        }
        await sleep(400)
        continue
      }

      if (d <= 3.2) {
        // 近战: 出手后在攻击冷却期间侧移走位(拟人)
        if (goalTarget) {
          goalTarget = null
          safeStopPathfinding(bot)
        }
        try { bot.attack(t.entity) } catch { /* ignore */ }
        bot.setControlState(strafeDir, true)
        await sleep(650 + Math.random() * 550)
        bot.setControlState(strafeDir, false)
        if (Math.random() < 0.3) strafeDir = strafeDir === 'left' ? 'right' : 'left'
      } else {
        if (goalTarget !== t.entity) {
          try { bot.pathfinder.setGoal(new GoalFollow(t.entity, 1.5), true) } catch { /* ignore */ }
          goalTarget = t.entity
        }
        await sleep(300)
      }
    }
  } finally {
    try { bot.setControlState('left', false); bot.setControlState('right', false) } catch { /* ignore */ }
    safeStopPathfinding(bot)
    state.defense.active = false
    state.defense.action = null
    engageCooldownUntil = Date.now() + (reason === 'cleared' ? 1500 : 4000)
  }

  const health = Math.round(bot.entity?.health ?? 0)
  pushEvent('auto_defense', { action: 'engage_end', reason, health, position: bot.entity ? fmtPos(bot.entity.position) : undefined })
  if (reason === 'low_hp_flee') void runFlee()
}

async function runFlee() {
  const bot = botRef
  state.defense.active = true
  state.defense.cancelled = false
  state.defense.action = 'flee'
  const initial = combatTargets(bot, 16)
  interruptCurrentTask(bot, '生命值过低, 撤退', true) // 逃跑优先于一切, 包括 AI 指定的战斗
  pushEvent('auto_defense', { action: 'flee', from: summarize(initial), health: Math.round(bot.entity.health) })

  const start = Date.now()
  let reason = 'escaped'
  try {
    while (Date.now() - start < FLEE_MAX_MS) {
      if (state.defense.cancelled) { reason = 'stopped_by_user'; break }
      if (state.bot !== bot || !bot.entity || bot.entity.health <= 0) { reason = 'bot_down'; break }
      const targets = combatTargets(bot, 16)
      if (!targets.length) break
      try { await pathfindTo(bot, awayPoint(bot, targets.map((x) => x.entity), 24), { range: 2, timeoutMs: 8000 }) } catch { /* ignore */ }
      await sleep(500) // 每半秒重新评估逃跑方向; 同时防止寻路瞬间返回时形成热循环
    }
  } finally {
    safeStopPathfinding(bot)
    state.defense.active = false
    state.defense.action = null
  }
  pushEvent('auto_defense', { action: 'flee_end', reason, health: Math.round(bot.entity?.health ?? 0), position: bot.entity ? fmtPos(bot.entity.position) : undefined })
}

async function runHeal() {
  const bot = botRef
  state.defense.active = true
  state.defense.action = 'heal'
  pushEvent('auto_defense', { action: 'heal', health: Math.round(bot.entity.health), food: bot.entity.food })
  try {
    await eatFood(bot, null)
    pushEvent('auto_defense', { action: 'heal_done', food: bot.entity?.food })
  } catch (err) {
    healCooldownUntil = Date.now() + 60000 // 没有食物等一分钟再试
    pushEvent('auto_defense', { action: 'heal_failed', error: String(err?.message || err) })
  } finally {
    state.defense.active = false
    state.defense.action = null
  }
}

function tick() {
  if (state.bot !== botRef) { stopDefense(); return }
  const bot = botRef
  if (!enabled || state.defense.active) return
  if (!bot.entity || !bot.entity.health || bot.entity.health <= 0) return
  if (Date.now() < engageCooldownUntil) return

  const fighting = state.task && (state.task.name === 'fight' || state.task.name === 'attack')
  const hp = bot.entity.health
  const wideTargets = combatTargets(bot, 16)

  if (!fighting && hp <= config.fleeHp && wideTargets.length) { void runFlee(); return }
  if (!fighting && wideTargets.some((t) => t.distance <= config.engageRadius)) { void runEngage(); return }

  if (config.autoEat && Date.now() > healCooldownUntil && hp < 14 && (bot.entity.food ?? 20) < 18) {
    const has = bot.inventory.items().some((it) => isFoodItem(it, bot.registry))
    if (has) void runHeal()
    else healCooldownUntil = Date.now() + 60000
  }
}

export function startDefense(bot, opts = {}) {
  stopDefense()
  botRef = bot
  enabled = opts.enabled !== false
  config = {
    engageRadius: opts.engageRadius ?? 8,
    fleeHp: opts.fleeHp ?? 6,
    autoEat: opts.autoEat !== false,
  }
  engageCooldownUntil = 0
  healCooldownUntil = 0
  if (!enabled) return
  interval = setInterval(tick, TICK_MS)
  if (typeof interval.unref === 'function') interval.unref()
}

export function stopDefense() {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  if (state.defense) {
    state.defense.active = false
    state.defense.action = null
    state.defense.cancelled = true
  }
}

export function defenseStatus() {
  return {
    enabled,
    active: state.defense?.active ?? false,
    action: state.defense?.action ?? null,
    engage_radius: config?.engageRadius ?? null,
    flee_hp: config?.fleeHp ?? null,
    auto_eat: config?.autoEat ?? null,
  }
}
