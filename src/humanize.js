// 拟人化行为: 待机张望(优先看向最近说话的玩家) + 聊天打字模拟(分句、按长度延迟发送)
// + 闲逛 wander(随机溜达, 安全路段偶尔疾跑跳跃)
import Vec3 from 'vec3'
import { state, eventsSince, recordSelfChat } from './bot.js'
import { resolveEntity, pathfindTo, safeStopPathfinding } from './movement.js'
import { smoothLook, smoothLookAngles, sleep, fmtPos } from './util.js'

let timer = null
let botRef = null
let enabled = false
let nextGlanceAt = 0
let thinkingTimer = null
let thinkingBotRef = null

export function startHumanize(bot, on = true) {
  stopHumanize()
  botRef = bot
  enabled = Boolean(on)
  nextGlanceAt = 0
  if (!enabled) return
  timer = setInterval(tick, 1500)
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopHumanize() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  stopThinkingFill()
  botRef = null
}

// 模型思考期间的"活人填充": 只做安全的视线转动, 不移动、不改快捷栏,
// 避免模型返回动作时和本地动作抢控制权(也让玩家不会看见一个木头人站着发呆)。
export function startThinkingFill(bot) {
  stopThinkingFill()
  thinkingBotRef = bot
  if (!bot?.entity || bot.health <= 0) return
  thinkingTimer = setInterval(tickThinking, 2200)
  if (typeof thinkingTimer.unref === 'function') thinkingTimer.unref()
}

export function stopThinkingFill() {
  if (thinkingTimer) clearInterval(thinkingTimer)
  thinkingTimer = null
  thinkingBotRef = null
}

function tickThinking() {
  if (!thinkingBotRef || state.bot !== thinkingBotRef) return
  if (state.defense?.active || state.task || state.containerWindow) return
  const bot = thinkingBotRef
  if (!bot.entity || bot.health <= 0 || !Number.isFinite(bot.entity.yaw)) return
  void thinkingGlance(bot)
}

async function thinkingGlance(bot) {
  try {
    // 偶尔看向附近的玩家, 平时随意转头; 都是视线动作, 不影响后续工具执行
    const players = Object.values(bot.entities || {}).filter((e) => {
      if (!e || e === bot.entity || e.type !== 'player' || !e.username || e.username === bot.username || !e.position || e.isValid === false) return false
      return e.position.distanceTo(bot.entity.position) < 12
    })
    let target = null
    if (players.length && Math.random() < 0.5) {
      const p = players[Math.floor(Math.random() * players.length)]
      target = p.position.offset(0, p.height ?? 1.6, 0)
    }
    if (target) {
      await smoothLook(bot, target, 350 + Math.random() * 350)
    } else {
      const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.8
      const pitch = (Math.random() - 0.5) * 0.5
      await smoothLookAngles(bot, yaw, pitch, 250 + Math.random() * 250)
    }
  } catch { /* 思考填充失败不影响主流程 */ }
}

function tick() {
  if (!enabled || state.bot !== botRef) return
  if (thinkingTimer) return // 模型思考期间由 thinking fill 负责, 避免两套视线动作打架
  // 只在真正空闲时张望: 无任务、无防御、没开箱子、活着
  if (state.defense?.active || state.task || state.containerWindow) return
  const bot = botRef
  if (!bot.entity || bot.health <= 0) return
  if (Date.now() < nextGlanceAt) return
  nextGlanceAt = Date.now() + 3000 + Math.random() * 5000 // 每 3~8 秒随机看一眼(更密一点, 掩盖模型思考的停顿)
  void glance(bot)
}

async function glance(bot) {
  try {
    // 偶尔把玩手里的物品(切一下快捷栏再切回): 真人等人的标志性小动作
    if (Math.random() < 0.3) void hotbarFidget(bot)
    // 最近 25 秒内说过话的玩家优先(社交感: 谁说话看谁)
    let target = null
    if (state.lastChatFrom && Date.now() - (state.lastChatAt ?? 0) < 25000) {
      const e = resolveEntity(bot, state.lastChatFrom)
      if (e && bot.entity.position.distanceTo(e.position) < 14) {
        target = e.position.offset(0, e.height ?? 1.6, 0)
      }
    }
    if (!target && Math.random() < 0.55) {
      const players = Object.values(bot.entities || {}).filter((e) => {
        if (!e || e === bot.entity || e.type !== 'player' || !e.username || e.isValid === false || !e.position) return false
        return e.username !== bot.username && e.position.distanceTo(bot.entity.position) < 10
      })
      if (players.length) {
        const p = players[Math.floor(Math.random() * players.length)]
        target = p.position.offset(0, p.height ?? 1.6, 0)
      }
    }
    if (target) {
      await smoothLook(bot, target, 400 + Math.random() * 400)
      return
    }
    // 没人可看就随机张望
    const yaw = bot.entity.yaw + (Math.random() - 0.5) * 2.2
    const pitch = (Math.random() - 0.5) * 0.6
    await smoothLookAngles(bot, yaw, pitch, 300 + Math.random() * 300)
  } catch { /* ignore */ }
}

// hotbar 把玩: 无意识切换快捷栏再切回(像真人切着玩); 若期间开始了任务则不抢恢复
export async function hotbarFidget(bot) {
  try {
    const prev = bot.quickBarSlot
    if (typeof prev !== 'number') return
    const next = (prev + 1 + Math.floor(Math.random() * 7)) % 9
    bot.setQuickBarSlot(next)
    await sleep(600 + Math.random() * 900)
    if (!state.task) bot.setQuickBarSlot(prev)
  } catch { /* ignore */ }
}

// ---- 聊天打字模拟 ----
// 长消息按句切分, 每句之间留出"打字时间"(按长度估算), 命令(/开头)不走此逻辑

export function splitMessage(text) {
  const parts = String(text)
    .split(/(?<=[。！？!?~…])/)
    .flatMap((s) => s.split('\n'))
    .map((s) => s.trim())
    .filter(Boolean)
  const chunks = []
  let cur = ''
  for (const p of parts) {
    if (cur && (cur + p).length > 30) {
      chunks.push(cur)
      cur = p
    } else {
      cur = cur ? cur + p : p
    }
    if (cur.length >= 30) {
      chunks.push(cur)
      cur = ''
    }
  }
  if (cur) chunks.push(cur)
  if (chunks.length > 4) {
    // 最多 4 条, 余下并入末条(服务器单条上限 256 字符, 再截断)
    const rest = chunks.splice(3).join('')
    chunks.push(rest.slice(0, 240))
  }
  return chunks
}

export function typingDelayMs(chunk) {
  return Math.min(6000, 700 + chunk.length * 55)
}

// 串行发送队列: 多次调用不会交叉乱序
let sendChain = Promise.resolve()

function enqueue(fn) {
  const run = sendChain.then(fn)
  sendChain = run.catch(() => {})
  return run
}

export function sendChatHumanized(bot, message) {
  return enqueue(async () => {
    const chunks = splitMessage(message)
    for (const c of chunks) {
      await sleep(typingDelayMs(c))
      bot.chat(c)
      recordSelfChat(c)
    }
    return { sent_chunks: chunks.length }
  })
}

export function sendWhisperHumanized(bot, player, message) {
  return enqueue(async () => {
    const chunks = splitMessage(message)
    for (const c of chunks) {
      await sleep(typingDelayMs(c))
      bot.whisper(player, c)
      recordSelfChat(c, player)
    }
    return { sent_chunks: chunks.length }
  })
}

// ---- 闲逛(wander): 随机溜达 + 安全疾跑跳跃 ----

// 单列地表扫描: 从 yHint+6 向下找第一个表面(实心/水/岩浆), 顶部未加载当空气, 中途空洞返回 null
function columnSurface(bot, x, yHint, z) {
  let seen = false
  for (let y = yHint + 6; y >= yHint - 10; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) {
      if (seen) return null
      continue
    }
    seen = true
    if (b.name === 'water' || b.name === 'lava') return { y, name: b.name }
    if (b.boundingBox !== 'empty') return { y, name: b.name }
  }
  return null
}

// 疾跑跳跃前的安全预扫: 沿当前朝向前方 5 列(疾跑跳实际落点约 4 格, 留 1 格余量)
// 全部满足才允许跳: 已加载、无水/岩浆、上坡 ≤1 格、落差 ≤2 格
export function jumpPathIsSafe(bot) {
  const px = bot.entity.position.x
  const pz = bot.entity.position.z
  const fy = Math.floor(bot.entity.position.y)
  const dx = -Math.sin(bot.entity.yaw)
  const dz = Math.cos(bot.entity.yaw)
  const home = columnSurface(bot, Math.floor(px), fy, Math.floor(pz))
  if (!home || home.name === 'water' || home.name === 'lava') return false
  let lastX = Math.floor(px)
  let lastZ = Math.floor(pz)
  for (let i = 1; i <= 5; i++) {
    const cx = Math.floor(px + dx * i)
    const cz = Math.floor(pz + dz * i)
    if (cx === lastX && cz === lastZ) continue // 同一列
    lastX = cx
    lastZ = cz
    const surf = columnSurface(bot, cx, fy, cz)
    if (!surf) return false // 未加载或悬空
    if (surf.name === 'water' || surf.name === 'lava') return false
    const diff = surf.y - home.y
    if (diff > 1) return false // 前方有墙/陡坡
    if (diff < -2) return false // 前方有落差
  }
  return true
}

// 一次疾跑+跳跃(朝当前朝向)
async function casualSprintJump(bot) {
  bot.setControlState('sprint', true)
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  await sleep(350 + Math.random() * 150)
  bot.setControlState('jump', false)
  await sleep(550) // 腾空+落地滑行
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
}

function releaseControls(bot) {
  for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) {
    try { bot.setControlState(key, false) } catch { /* ignore */ }
  }
}

// 随机挑一个 6~16 格外的落脚点(表面已知且不是液体)
function randomStrollTarget(bot) {
  const ang = Math.random() * Math.PI * 2
  const dist = 6 + Math.random() * 10
  const x = Math.floor(bot.entity.position.x + Math.cos(ang) * dist)
  const z = Math.floor(bot.entity.position.z + Math.sin(ang) * dist)
  const yHint = Math.floor(bot.entity.position.y)
  const surf = columnSurface(bot, x, yHint, z)
  if (!surf || surf.name === 'water' || surf.name === 'lava') return null
  return { x, y: surf.y + 1, z }
}

// 闲逛: 走走停停、张望、平坦安全时偶尔蹦跶一下
export async function wanderAround(bot, seconds, task, opts = {}) {
  const startedAt = Date.now()
  const deadline = startedAt + Math.max(3, Math.min(600, seconds)) * 1000
  const startSeq = state.notifiedSeq
  const humanize = state.options?.humanize !== false
  let spots = 0
  let jumps = 0
  let reason = 'duration_end'

  try {
    while (Date.now() < deadline) {
      if (task?.cancelled) { reason = 'stopped_by_user'; break }
      if (state.bot !== bot) { reason = 'disconnected'; break }
      if ((bot.health ?? 20) <= 0) { reason = 'self_dead'; break }
      if (opts.interruptOnChat !== false) {
        const wake = eventsSince(startSeq).find((e) => e.type === 'chat' || e.type === 'whisper')
        if (wake) { reason = 'new_chat'; break }
      }

      const target = randomStrollTarget(bot)
      if (target) {
        try {
          const r = await pathfindTo(bot, target, { range: 1, timeoutMs: 15000, task })
          if (r.reason === 'stopped_by_user' || r.reason === 'interrupted_by_auto_defense') {
            reason = r.reason
            break
          }
          if (r.completed) spots += 1
        } catch { /* 该点不可达/寻路异常, 换下一个 */ }

        // 到了一个点: 平坦安全时偶尔疾跑蹦跶一下
        if (Date.now() < deadline && !task?.cancelled && humanize && Math.random() < 0.35) {
          const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.2
          await smoothLookAngles(bot, yaw, 0, 200)
          if (jumpPathIsSafe(bot)) {
            await casualSprintJump(bot)
            jumps += 1
          }
        }
      }

      // 站一会, 张望一下, 再去下一个点
      await sleep(800 + Math.random() * 1800)
      await glance(bot)
    }
  } finally {
    releaseControls(bot)
    safeStopPathfinding(bot)
  }

  return {
    wandered_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    spots_visited: spots,
    sprint_jumps: jumps,
    reason,
    position: bot.entity ? fmtPos(bot.entity.position) : null,
    note: reason === 'new_chat' ? '期间有玩家说话, 提前结束闲逛(查看 new_events 并回复)。' : undefined,
  }
}

// ---- 探索(explore): 比 wander 更有目的——连续走更远、沿途收集感知信息 ----

// 随机挑一个 12~40 格外的落脚点(比 wander 更远), 表面已知且非液体
function randomExploreTarget(bot) {
  const ang = Math.random() * Math.PI * 2
  const dist = 12 + Math.random() * 28
  const x = Math.floor(bot.entity.position.x + Math.cos(ang) * dist)
  const z = Math.floor(bot.entity.position.z + Math.sin(ang) * dist)
  const yHint = Math.floor(bot.entity.position.y)
  const surf = columnSurface(bot, x, yHint, z)
  if (!surf || surf.name === 'water' || surf.name === 'lava') return null
  return { x, y: surf.y + 1, z }
}

// 沿途轻扫: 收集附近玩家/生物/掉落物/NPC, 记录值得注意的发现
function collectSightings(bot, sightings) {
  try {
    const R = 24
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || e.isValid === false || !e.position) continue
      if (e.position.distanceTo(bot.entity.position) > R) continue
      const p = {
        x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z),
      }
      if (e.type === 'player' && e.username && e.username !== bot.username) {
        const k = `player|${e.username}`
        if (!sightings.has(k)) sightings.set(k, { kind: 'player', name: e.username, ...p })
      } else if (e.type === 'mob') {
        const k = `mob|${e.name}|${p.x},${p.z}`
        if (!sightings.has(k)) sightings.set(k, { kind: 'mob', name: e.name, ...p })
      } else if (e.type === 'object' || e.type === 'drop') {
        const k = `drop|${e.name ?? 'item'}|${p.x},${p.z}`
        if (!sightings.has(k)) sightings.set(k, { kind: 'drop', name: e.name ?? 'item', ...p })
      }
    }
  } catch { /* ignore */ }
}

// 探索: 连续走更远、沿途感知, 事件秒醒, 返回"探索报告"
export async function exploreAround(bot, seconds, task, opts = {}) {
  const startedAt = Date.now()
  const deadline = startedAt + Math.max(10, Math.min(600, seconds)) * 1000
  const startSeq = state.notifiedSeq
  const humanize = state.options?.humanize !== false
  const sightings = new Map()
  const sightingsOrder = []
  let spots = 0
  let reason = 'duration_end'
  let scannedAt = 0

  try {
    while (Date.now() < deadline) {
      if (task?.cancelled) { reason = 'stopped_by_user'; break }
      if (state.bot !== bot) { reason = 'disconnected'; break }
      if ((bot.health ?? 20) <= 0) { reason = 'self_dead'; break }
      if (opts.interruptOnChat !== false) {
        const wake = eventsSince(startSeq).find((e) => e.type === 'chat' || e.type === 'whisper' || e.type === 'window_open')
        if (wake) { reason = 'new_chat'; break }
      }

      // 每 4 秒轻扫一次周围(比 wander 多了"感知"维度)
      if (Date.now() - scannedAt > 4000) {
        scannedAt = Date.now()
        collectSightings(bot, sightings)
      }

      const target = randomExploreTarget(bot)
      if (target) {
        try {
          const r = await pathfindTo(bot, target, { range: 2, timeoutMs: 20000, task })
          if (r.reason === 'stopped_by_user' || r.reason === 'interrupted_by_auto_defense') {
            reason = r.reason
            break
          }
          if (r.completed) spots += 1
        } catch { /* 该点不可达/寻路异常, 换下一个 */ }

        // 到点后张望一下, 偶尔蹦跶(拟人)
        if (Date.now() < deadline && !task?.cancelled && humanize && Math.random() < 0.3) {
          const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.4
          await smoothLookAngles(bot, yaw, 0, 200)
          if (jumpPathIsSafe(bot)) {
            await casualSprintJump(bot)
          }
        }
        collectSightings(bot, sightings)
      }

      await sleep(600 + Math.random() * 1200)
      await glance(bot)
    }
  } finally {
    releaseControls(bot)
    safeStopPathfinding(bot)
  }

  const unique = (arr) => arr.filter((v, i) => arr.indexOf(v) === i)
  const found = {
    players: unique([...sightings.values()].filter((s) => s.kind === 'player').map((s) => s.name)),
    mobs: unique([...sightings.values()].filter((s) => s.kind === 'mob').map((s) => s.name)),
    drops: [...sightings.values()].filter((s) => s.kind === 'drop').length,
  }

  return {
    explored_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    spots_visited: spots,
    discovered: found,
    positions: [...sightings.values()].slice(0, 12),
    reason,
    position: bot.entity ? fmtPos(bot.entity.position) : null,
    note: reason === 'new_chat'
      ? '期间有玩家说话/窗口弹出, 提前结束探索(查看 new_events 并处理)。'
      : '沿途收集到以上发现, 可据此决定下一步(走向玩家/去交易/避开危险)。',
  }
}
