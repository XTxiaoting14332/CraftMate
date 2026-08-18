// 移动: 寻路(一次规划、原生执行)、跟随、看向
import pathfinderPkg from 'mineflayer-pathfinder'
import Vec3 from 'vec3'
import { state, eventsSince } from './bot.js'
import { fmtPos, round1 } from './util.js'

const { Movements, goals } = pathfinderPkg
const { GoalNear, GoalFollow } = goals

export function defaultMovements(bot, allowDig = false, allowPlace = false) {
  let movements
  try {
    movements = new Movements(bot)
  } catch {
    return null // 构造失败时保持 pathfinder 现有配置(真实环境不会发生)
  }
  movements.canDig = !!allowDig // 默认不破坏方块, 防止破坏他人建筑
  if (!allowPlace) movements.scafoldingBlocks = [] // 默认不放置方块, 防止意外改动世界(搭桥/起塔)
  movements.allowSprinting = true
  movements.allowParkour = true
  movements.allow1by1towers = !!allowPlace && !!allowDig // 起塔需两者都允许
  return movements
}

export function safeStopPathfinding(bot) {
  try { bot.pathfinder.stop() } catch { /* ignore */ }
  try { bot.pathfinder.setGoal(null) } catch { /* ignore */ }
}

function distanceTo(bot, p) {
  return bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z))
}

function remaining(bot, target) {
  return round1(distanceTo(bot, target))
}

// 寻路并走到目标。整个 A* + 行走过程在 Node 内以原生速度执行,
// 期间无需 LLM 参与, 直到到达/超时/被打断才返回 —— 这是低延迟的关键。
export async function pathfindTo(bot, target, opts = {}) {
  const { range = 1, timeoutMs = 120000, allowDig = false, allowPlace = false, task, interruptOnEvents = false, startSeq = null } = opts
  const goal = new GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), Math.max(0, Math.floor(range)))
  const movements = defaultMovements(bot, allowDig, allowPlace)
  if (movements) {
    // 拟人: 短途不疾跑(人走近处是走的), 远途大概率疾跑
    const dist = bot.entity.position.distanceTo(new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)))
    movements.allowSprinting = dist > 16 ? Math.random() < 0.85 : false
    bot.pathfinder.setMovements(movements)
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    safeStopPathfinding(bot)
  }, Math.max(1000, timeoutMs))

  // 事件中断: 途中有人说话/被打时取消寻路提前返回(社交优先, 不让长导航吞掉聊天)
  let interruptedBy = null
  let watcher = null
  if (interruptOnEvents && task && startSeq != null) {
    const WAKE = ['chat', 'whisper', 'damaged']
    watcher = setInterval(() => {
      if (task.cancelled) return
      const ev = eventsSince(startSeq).find((e) => WAKE.includes(e.type))
      if (ev) {
        interruptedBy = ev.type
        task.cancelled = true
        task.interruptedBy = ev.type
        safeStopPathfinding(bot)
      }
    }, 400)
    if (typeof watcher.unref === 'function') watcher.unref()
  }

  const interruptedResult = () => ({
    completed: false,
    reason: `interrupted_by_${interruptedBy}`,
    note: interruptedBy === 'damaged' ? '途中受到伤害, 已停下(查看 new_events)。' : '期间有玩家说话, 已停下(查看 new_events 并回复)。',
    remaining_distance: remaining(bot, target),
    position: fmtPos(bot.entity.position),
  })

  try {
    await bot.pathfinder.goto(goal)
  } catch (err) {
    const msg = String(err?.message || err)
    if (timedOut) return { completed: false, reason: 'timeout', remaining_distance: remaining(bot, target), position: fmtPos(bot.entity.position) }
    if (interruptedBy) return interruptedResult()
    if (task?.cancelled) {
      const reason = task.interruptedBy === 'auto_defense' ? 'interrupted_by_auto_defense' : 'stopped_by_user'
      return { completed: false, reason, remaining_distance: remaining(bot, target), position: fmtPos(bot.entity.position) }
    }
    if (/NoPath|No path|obscured/i.test(msg)) {
      return {
        completed: false,
        reason: 'no_path',
        hint: '找不到可行路径: 目标不可达, 或需要开路(可在 goto 里设置 allow_dig=true 允许边走边挖)',
        remaining_distance: remaining(bot, target),
        position: fmtPos(bot.entity.position),
      }
    }
    return { completed: false, reason: 'error: ' + msg, remaining_distance: remaining(bot, target), position: fmtPos(bot.entity.position) }
  } finally {
    if (watcher) clearInterval(watcher)
    clearTimeout(timer)
  }

  if (interruptedBy) return interruptedResult()
  const d = remaining(bot, target)
  return {
    completed: d <= range + 1.5,
    distance: d,
    position: fmtPos(bot.entity.position),
    note: d <= range + 1.5 ? '已到达' : '寻路已结束但未完全抵达目标半径内',
  }
}

export function resolvePlayerEntity(bot, name) {
  if (!name) return null
  const q = String(name).toLowerCase()
  const entries = Object.entries(bot.players || {})
  for (const [n, p] of entries) {
    if (n.toLowerCase() === q) return p.entity ?? null
  }
  for (const [n, p] of entries) {
    if (n.toLowerCase().includes(q)) return p.entity ?? null
  }
  return null
}

// 按用户名/实体名/显示名找最近实体
export function resolveEntity(bot, name) {
  if (!name) return null
  const q = String(name).toLowerCase().replace(/\s+/g, '_')
  let best = null
  let bestD = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue
    const candidates = [e.username, e.name, e.displayName]
    const matched = candidates.some((n) => {
      if (!n) return false
      const s = String(n).toLowerCase().replace(/\s+/g, '_')
      return s === q
    })
    if (matched) {
      const d = bot.entity.position.distanceTo(e.position)
      if (d < bestD) { best = e; bestD = d }
    }
  }
  return best
}

// 持续跟随玩家 durationS 秒: 意图一次下发, 执行在本地循环
// interruptOnChat(默认开): 期间有人说话立即返回, 便于 AI 及时回复
export async function followPlayer(bot, playerName, opts = {}) {
  const { durationS = 60, distance = 3, task, interruptOnChat = true } = opts
  const entity = resolvePlayerEntity(bot, playerName)
  if (!entity) throw new Error(`找不到玩家「${playerName}」的实体(可能不在线或不在渲染范围内), 可用 nearby 查看。`)

  const movements = defaultMovements(bot, false)
  if (movements) bot.pathfinder.setMovements(movements)
  const goal = new GoalFollow(entity, Math.max(1, distance))
  bot.pathfinder.setGoal(goal, true)

  const start = Date.now()
  const startSeq = state.notifiedSeq
  let reason = 'duration_end'
  try {
    while (Date.now() - start < durationS * 1000) {
      if (task?.cancelled) {
        reason = task.interruptedBy === 'auto_defense' ? 'interrupted_by_auto_defense' : 'stopped_by_user'
        break
      }
      if (interruptOnChat) {
        const wake = eventsSince(startSeq).find((e) => e.type === 'chat' || e.type === 'whisper')
        if (wake) { reason = 'new_chat'; break }
      }
      const e = bot.entities[entity.id]
      if (!e || e.isValid === false) { reason = 'target_lost'; break }
      if ((bot.entity?.health ?? 20) <= 0) { reason = 'self_dead'; break }
      // 靠近时面向目标, 更像真人
      try {
        const d = bot.entity.position.distanceTo(e.position)
        if (d < distance + 4) await bot.lookAt(e.position.offset(0, e.height ?? 1.6, 0))
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400))
    }
  } finally {
    safeStopPathfinding(bot)
  }

  const e = bot.entities[entity.id]
  return {
    player: playerName,
    followed_seconds: round1((Date.now() - start) / 1000),
    final_distance: e ? round1(bot.entity.position.distanceTo(e.position)) : null,
    reason,
    note: reason === 'new_chat' ? '期间有玩家说话, 提前结束跟随(查看 new_events 并回复)。' : undefined,
    position: fmtPos(bot.entity.position),
  }
}

export async function lookAtPoint(bot, x, y, z) {
  await bot.lookAt(new Vec3(x, y, z), true)
}
