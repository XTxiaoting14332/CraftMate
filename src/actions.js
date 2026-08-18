// 动作: 挖掘/放置/攻击/使用/吃/丢弃/装备/合成/采集(复合)
import Vec3 from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { state, eventsSince, currentNs } from './bot.js'
import { fmtPos, round1, sleep, smoothLook, aimJitter, reactionDelayMs } from './util.js'
import { isBlockItem, isFoodItem, itemTitle } from './items.js'
import { resolveEntity, pathfindTo } from './movement.js'
import { sightBlock, resolveBlockIds, findBlockPositions, hasLineOfSightToPoint } from './world.js'
import { recallMemories } from './store.js'

const { GoalFollow } = pathfinderPkg.goals

const DIRS = [
  new Vec3(0, -1, 0), // 优先以下方为支撑面
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
]

function coordsOrNull(a) {
  if (a?.x != null && a?.y != null && a?.z != null) {
    return { x: Math.floor(Number(a.x)), y: Math.floor(Number(a.y)), z: Math.floor(Number(a.z)) }
  }
  return null
}

// 名称归一化: 大小写/空格/minecraft: 前缀/全角空格 都容忍 —— "Oak Log"、"minecraft:oak_log"、"OAK_LOG" 都能匹配 oak_log
function normalizeItemName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/minecraft:/g, '')
    .replace(/[\s　]+/g, '_')
    .trim()
}

// prismarine 物品的数字 id 在 item.type(部分旧版本只有 item.id), canHarvest/digTime 等 API 要的是这个数字
function itemNumericId(it) {
  return it?.type ?? it?.id ?? null
}

export function findInvItems(bot, name) {
  const q = normalizeItemName(name)
  if (!q) return []
  return bot.inventory.items().filter((it) => {
    const title = normalizeItemName(itemTitle(it))
    return (
      normalizeItemName(it.name).includes(q) ||
      normalizeItemName(it.displayName).includes(q) ||
      title.includes(q)
    )
  })
}

// 按挖掘耗时动态给超时: 慢方块(黑曜石等)自动放宽, 快方块也不会被过长超时拖住
export function digTimeoutMs(bot, block, minMs = 8000) {
  let digMs = 0
  try {
    const t = bot.digTime?.(block)
    if (Number.isFinite(t) && t > 0) digMs = t
  } catch { /* digTime 版本差异, 交给 dig 处理 */ }
  return Math.max(Math.ceil(minMs || 8000), Math.ceil(digMs * 1.5 + 4000))
}

// 带超时/重试的挖掘: forceLook 立即对准, digFace=raycast 挖"玩家实际看得到的面"以兼容反作弊;
// 服务器迟迟不回确认时主动 stopDigging, 避免一直原地挥锄头。
// 视线检查: 不允许隔墙挖(拟真 + 防掉落物落在墙对面捡不到)。
async function digWithTimeout(bot, block, minTimeoutMs = 8000) {
  const timeoutMs = digTimeoutMs(bot, block, minTimeoutMs)
  const center = block.position.offset(0.5, 0.5, 0.5)
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  if (eye.distanceTo(center) > 5.1) {
    throw new Error(`目标距离 ${round1(eye.distanceTo(center))} 格超出挖掘范围, 请先 goto 靠近。`)
  }
  if (!hasLineOfSightToPoint(bot, center, block.position)) {
    throw new Error('视线被遮挡(可能隔着墙), 挖不到这个方块; 请走到能直接看到它的位置再挖。')
  }
  let canDig = true
  try {
    canDig = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true
  } catch { /* canDigBlock 版本差异, 交给 dig 处理 */ }
  if (!canDig) throw new Error('当前无法挖掘该方块(超出范围或不可挖掘)。')

  const tryDig = async (digFace) => {
    const p = bot.dig(block, true, digFace)
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (bot.targetDigBlock) bot.stopDigging() } catch { /* ignore */ }
        reject(new Error('挖掘超时: 服务器未返回方块破坏确认(距离/工具/服务器插件可能有问题)'))
      }, timeoutMs)
    })
    try {
      await Promise.race([p, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    await tryDig('raycast')
  } catch (err) {
    if (!/not in view/i.test(String(err?.message || err))) throw err
    try { if (bot.targetDigBlock) bot.stopDigging() } catch { /* ignore */ }
    await tryDig()
  }
}

export function droppedItemsNear(bot, radius) {
  const pos = bot.entity.position
  return Object.values(bot.entities || {})
    .filter((e) => e && e !== bot.entity && e.type === 'object' && e.name === 'item' && e.position && e.isValid !== false && pos.distanceTo(e.position) <= radius)
    .sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position))
}

function nearbyDrops(bot, radius) {
  return droppedItemsNear(bot, radius)
}

// 挖完立刻本地收掉落物: 走到每个掉落实体旁边触发拾取, 不用等模型再回头规划。
// 三个关键点(都是踩过的坑):
//  1) 等待实体生成: 服务器的物品实体包有延迟, 立刻扫会扑空并误报"已拾取"
//  2) 双圆心扫描: 掉落物出现在"挖掉的方块"附近而不是机器人附近(挖远处方块时两者差 4~6 格),
//     所以既扫机器人周围, 也扫挖掘点周围更大的半径
//  3) 走不到的掉落物进黑名单: 不让一个 no_path 烧光全部预算; 结束时报告最近一个未拾取位置
export async function pickupNearbyDrops(bot, { radius = 8, task, timeoutMs = 6000, pauseMs = 200, center = null } = {}) {
  if (!bot.entity || bot.entity.health <= 0) return { drops_checked: 0, drops_remaining: 0, remaining_nearest: null }
  const centerPos = center ?? null
  const start = Date.now()
  const deadline = start + Math.max(1500, timeoutMs)
  const blacklist = new Set()
  let checked = 0

  const dropsAround = (pos, r) => Object.values(bot.entities || {})
    .filter((e) => e && e !== bot.entity && e.type === 'object' && e.name === 'item'
      && e.position && e.isValid !== false && !blacklist.has(e.id)
      && (pos.distanceTo(e.position) <= r || (centerPos && centerPos.distanceTo(e.position) <= radius * 1.6)))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))

  // 阶段一: 等掉落实体出现(最多 2.2s) —— 挖掘确认包和实体生成包不是同一个
  await sleep(pauseMs)
  if (centerPos) {
    while (Date.now() < start + pauseMs + 2000) {
      if (dropsAround(bot.entity.position, radius).length) break
      await sleep(150)
    }
  }

  // 阶段二: 逐个走过去拾取, 直到没有新的或超时
  while (Date.now() < deadline) {
    if (task?.cancelled || !bot.entity || bot.entity.health <= 0) break
    const list = dropsAround(bot.entity.position, radius)
    const drop = list[0]
    if (!drop) break
    const fresh = bot.entities[drop.id]
    if (!fresh || !fresh.position || fresh.isValid === false) continue
    const d = bot.entity.position.distanceTo(fresh.position)
    if (d > 1.8) {
      const r = await pathfindTo(bot, fresh.position, {
        range: 1,
        timeoutMs: Math.min(4000, deadline - Date.now()),
        task,
        interruptOnEvents: false,
      })
      if (r.reason === 'no_path' || r.reason === 'timeout' || r.completed === false) {
        blacklist.add(drop.id) // 走不到就别再试它, 留给结尾报告
      }
    } else {
      blacklist.add(drop.id) // 已贴近: 等拾取判定, 下轮如果还在(没被吸走)也不再追
    }
    await sleep(300) // 拾取判定窗口
    checked += 1
  }

  const remaining = nearbyDrops(bot, radius)
    .concat(centerPos ? nearbyDropsAt(bot, centerPos, radius * 1.6) : [])
    .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
  const nearest = remaining.length
    ? remaining.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0]
    : null
  return {
    drops_checked: checked,
    drops_remaining: remaining.length,
    remaining_nearest: nearest
      ? { position: fmtPos(nearest.position), distance: round1(bot.entity.position.distanceTo(nearest.position)) }
      : null,
  }
}

function nearbyDropsAt(bot, pos, radius) {
  return Object.values(bot.entities || {})
    .filter((e) => e && e !== bot.entity && e.type === 'object' && e.name === 'item' && e.position && e.isValid !== false && pos.distanceTo(e.position) <= radius)
}

// 自动选工具: 按方块材质选类别(镐/斧/锹/锄), 同类选最高品质, 手持不对就换。
// 优先用 registry 的 block.harvestTools(能采出的工具白名单)与 block.material(新版),
// 兜底用方块名启发式。返回 {equipped, reason} 供结果展示。
const TOOL_CATEGORIES = {
  pickaxe: /(stone|ore|deepslate|granite|diorite|andesite|cobble|obsidian|netherrack|blackstone|basalt|calcite|tuff|brick|quartz|amethyst|concrete|ice|magma|furnace|spawner|lantern|hopper|rail|anvil|cauldron)/,
  axe: /(log|planks|wood|fence|door|stair|slab|table|chest|barrel|bookshelf|bamboo|sign|banner|crafting|pumpkin|melon|campfire)/,
  shovel: /(dirt|grass|sand|gravel|clay|snow|mud|path|farmland|soul_)/,
  hoe: /(leaves|hay|nether_wart|target|sculk)/,
}
const TOOL_TIERS = { wooden: 1, golden: 2, stone: 2, iron: 3, diamond: 4, netherite: 5 }

export async function equipBestToolFor(bot, block) {
  try {
    const items = bot.inventory.items()
    if (!items.length) return { equipped: null, reason: '背包为空' }

    // 1) 类别: 新版 material 优先, 兜底名字启发式
    let category = null
    const mat = String(block.material ?? block.materials ?? '')
    for (const c of ['pickaxe', 'axe', 'shovel', 'hoe']) {
      if (mat.includes(c)) { category = c; break }
    }
    if (!category) {
      for (const [c, re] of Object.entries(TOOL_CATEGORIES)) {
        if (re.test(block.name)) { category = c; break }
      }
    }
    if (!category) return { equipped: bot.heldItem?.name ?? null, reason: '该方块无特定工具' }

    // 2) 同类工具里选最高品质; harvestTools 白名单(若提供)能过滤出"能采出掉落"的
    const harvestIds = block.harvestTools ? new Set(Object.keys(block.harvestTools).map(Number)) : null
    let best = null
    let bestScore = 0
    for (const it of items) {
      if (!it.name.includes(category)) continue
      const m = /^([a-z]+)_/.exec(it.name)
      if (harvestIds && !harvestIds.has(itemNumericId(it))) continue
      const tier = TOOL_TIERS[m?.[1]] ?? 1
      if (tier > bestScore) { best = it; bestScore = tier }
    }
    if (!best && harvestIds) {
      // 白名单里没有常规工具(如需要剪刀/特定工具), 找背包里任意在白名单内的物品
      best = items.find((it) => harvestIds.has(itemNumericId(it))) ?? null
    }
    if (!best) return { equipped: bot.heldItem?.name ?? null, reason: `背包里没有${category === 'pickaxe' ? '镐' : category === 'axe' ? '斧' : category === 'shovel' ? '锹' : '锄'}` }
    if (bot.heldItem?.name === best.name) return { equipped: best.name, reason: '已持有合适工具' }
    await bot.equip(best, 'hand')
    return { equipped: best.name, reason: `自动换用「${best.name}」` }
  } catch (err) {
    return { equipped: bot.heldItem?.name ?? null, reason: `选工具失败: ${String(err?.message || err).slice(0, 80)}` }
  }
}

export async function digBlock(bot, args, task) {
  const coords = coordsOrNull(args)
  let block
  if (coords) {
    block = bot.blockAt(new Vec3(coords.x, coords.y, coords.z), true)
    if (!block) throw new Error('该位置区块未加载, 请先走近。')
  } else {
    block = sightBlock(bot)
    if (!block) throw new Error('视线内没有指向方块, 请提供 x/y/z 坐标。')
  }
  if (!block || block.name === 'air' || block.boundingBox === 'empty') throw new Error('目标是空气/空位, 无需挖掘。')
  if (!block.diggable) throw new Error(`「${block.name}」不可挖掘(如基岩)。`)

  // 自动选工具(解决"空手挖石头": 慢且石头无掉落)
  const tool = await equipBestToolFor(bot, block)
  if (typeof block.canHarvest === 'function' && bot.heldItem && !block.canHarvest(itemNumericId(bot.heldItem))) {
    return {
      warning: `背包里没有能采集「${block.name}」掉落物的工具(当前手持「${bot.heldItem.name}」)。${tool.reason}。先去获取对应工具吧。`,
      dug: false,
      equipped: tool.equipped,
    }
  }

  await digWithTimeout(bot, block)
  const pickup = await pickupNearbyDrops(bot, { task, timeoutMs: 8000, center: block.position })
  return {
    dug: block.name,
    position: fmtPos(block.position),
    equipped: tool.equipped && tool.equipped !== bot.heldItem?.name ? tool.equipped : undefined,
    drops_checked: pickup.drops_checked,
    drops_remaining: pickup.drops_remaining,
    note: pickup.drops_remaining
      ? `已挖掘; ${pickup.drops_remaining} 个掉落物未能自动拾取, 最近一个在 ${JSON.stringify(pickup.remaining_nearest.position)}(距 ${pickup.remaining_nearest.distance} 格)。需要的话 goto 到附近再 nearby 查看。`
      : '已挖掘并自动拾取附近掉落物',
  }
}

// 批量挖掘: 一次传入多个坐标(先 find/scan 确认视野内要挖什么, 再一口气挖完),
// 每个方块自动选工具, 全部挖完统一拾取 —— 消除"一次思考挖一块"的来回延迟
export async function digBatch(bot, coordsList, task) {
  const list = (Array.isArray(coordsList) ? coordsList : []).slice(0, 16).map(coordsOrNull).filter(Boolean)
  if (!list.length) throw new Error('positions 需要包含至少一个 {x,y,z} 对象。')
  const results = []
  let dug = 0
  let toolsUsed = new Set()
  for (const c of list) {
    if (task?.cancelled) break
    try {
      const block = bot.blockAt(new Vec3(c.x, c.y, c.z), true)
      if (!block) {
        results.push({ position: c, error: '区块未加载' })
        continue
      }
      if (block.boundingBox === 'empty' || block.name === 'air') {
        results.push({ position: c, skipped: '空气' })
        continue
      }
      if (!block.diggable) {
        results.push({ position: c, error: `「${block.name}」不可挖掘` })
        continue
      }
      const tool = await equipBestToolFor(bot, block)
      if (tool.equipped) toolsUsed.add(tool.equipped)
      await digWithTimeout(bot, block)
      dug += 1
      results.push({ position: c, dug: block.name })
    } catch (err) {
      results.push({ position: c, error: String(err?.message || err).slice(0, 120) })
    }
  }
  const pickup = await pickupNearbyDrops(bot, { task, timeoutMs: 9000, radius: 10 })
  return {
    requested: list.length,
    dug_total: dug,
    tools_used: toolsUsed.size ? [...toolsUsed] : undefined,
    results,
    drops_checked: pickup.drops_checked,
    drops_remaining: pickup.drops_remaining,
    remaining_nearest: pickup.remaining_nearest,
    stopped_by_user: Boolean(task?.cancelled),
    position: fmtPos(bot.entity.position),
    note: dug > 0
      ? (pickup.drops_remaining
        ? `已挖 ${dug}/${list.length} 个; ${pickup.drops_remaining} 个掉落物未拾取(最近: ${JSON.stringify(pickup.remaining_nearest.position)})。`
        : `已挖 ${dug}/${list.length} 个并拾取掉落物。`)
      : '没有挖到任何方块(看 results 里的原因)。',
  }
}

export async function placeBlockAt(bot, args) {
  const coords = coordsOrNull(args)
  if (!coords) throw new Error('需要提供 x/y/z(要放置到的位置)。')
  const target = new Vec3(coords.x, coords.y, coords.z)
  const cur = bot.blockAt(target)
  if (cur && cur.boundingBox !== 'empty') throw new Error(`目标位置被「${cur.name}」占用。`)

  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  if (eye.distanceTo(target) > 4.5) {
    throw new Error(`目标距离 ${round1(eye.distanceTo(target))} 格超出触及范围(4.5), 请先 goto 到附近。`)
  }

  // 确保手持可放置方块
  if (!isBlockItem(bot.heldItem, bot.registry)) {
    const cand = bot.inventory.items().find((it) => isBlockItem(it, bot.registry))
    if (!cand) throw new Error('手持的不是方块, 物品栏里也没有可放置的方块。')
    await bot.equip(cand, 'hand')
  }
  const itemName = bot.heldItem?.name

  for (const dir of DIRS) {
    const ref = bot.blockAt(target.plus(dir))
    if (ref && ref.boundingBox === 'block') {
      await bot.placeBlock(ref, dir.scaled(-1))
      return {
        placed: itemName,
        position: coords,
        placed_against: fmtPos(ref.position),
        note: '已放置手持方块',
      }
    }
  }
  throw new Error('目标位置周围 6 格没有可作为支撑面的实体方块(不能悬空放置)。')
}

function headOf(entity) {
  return entity.position.offset(0, entity.height ?? 1.6, 0)
}

export async function attackEntity(bot, targetName, opts = {}, task) {
  const entity = resolveEntity(bot, targetName)
  if (!entity) throw new Error(`找不到目标「${targetName}」(玩家名或实体名, 如 zombie / creeper / 玩家名)。可用 nearby 查看。`)
  const label = entity.username ?? entity.name ?? targetName
  // 默认追猎: 不传 seconds = 追着打直到目标死亡(上限 60s); 显式 seconds=0 才是单次出手
  const seconds = opts.seconds == null ? 60 : Math.max(0, Number(opts.seconds))

  // 尽力装备武器
  try {
    const sword = bot.inventory.items().find((it) => /sword/.test(it.name))
    if (sword && bot.heldItem?.name !== sword.name) await bot.equip(sword, 'hand')
  } catch { /* ignore */ }

  if (seconds <= 0) {
    await smoothLook(bot, aimJitter(headOf(entity)), 200)
    await sleep(reactionDelayMs())
    bot.attack(entity)
    return { attacked: label, hits: 1, note: '单次攻击完成。要追着打请不传 seconds(默认追击到目标死亡)。' }
  }

  // 持续战斗: 反应时间 + 追击 + 攻击冷却 + 侧向走位(拟人, 不再直线冲脸)
  await sleep(reactionDelayMs())
  bot.pathfinder.setGoal(new GoalFollow(entity, 1.2), true)
  const start = Date.now()
  let hits = 0
  let reason = 'duration_end'
  let strafeDir = Math.random() < 0.5 ? 'left' : 'right'
  let goalActive = true
  try {
    while (Date.now() - start < seconds * 1000) {
      if (task?.cancelled) { reason = 'stopped_by_user'; break }
      const e = bot.entities[entity.id]
      if (!e || e.isValid === false) { reason = 'target_dead_or_gone'; break }
      if ((bot.entity?.health ?? 20) <= 0) { reason = 'self_dead'; break }
      const d = bot.entity.position.distanceTo(e.position)
      await smoothLook(bot, aimJitter(headOf(e)), 220)
      if (d <= 3.2) {
        // 近战: 停掉寻路, 出手后攻击冷却期间侧移走位
        if (goalActive) {
          goalActive = false
          try { bot.pathfinder.stop() } catch { /* ignore */ }
          try { bot.pathfinder.setGoal(null) } catch { /* ignore */ }
        }
        try { bot.attack(e) } catch { /* ignore */ }
        hits += 1
        bot.setControlState(strafeDir, true)
        await sleep(650 + Math.random() * 550)
        bot.setControlState(strafeDir, false)
        if (Math.random() < 0.3) strafeDir = strafeDir === 'left' ? 'right' : 'left'
      } else {
        if (!goalActive) {
          goalActive = true
          try { bot.pathfinder.setGoal(new GoalFollow(e, 1.2), true) } catch { /* ignore */ }
        }
        await sleep(250)
      }
    }
  } finally {
    try { bot.setControlState('left', false); bot.setControlState('right', false) } catch { /* ignore */ }
    try { bot.pathfinder.stop() } catch { /* ignore */ }
    try { bot.pathfinder.setGoal(null) } catch { /* ignore */ }
  }

  const still = Boolean(bot.entities[entity.id])
  // 击杀后收战利品: 猪/牛掉落的肉/皮革就在尸体旁, 顺手捡走不用模型再规划
  let loot = null
  if (!still && hits > 0) {
    const pickup = await pickupNearbyDrops(bot, { task, timeoutMs: 7000, radius: 10 })
    loot = { drops_checked: pickup.drops_checked, drops_remaining: pickup.drops_remaining }
  }
  return {
    attacked: label,
    hits,
    seconds: round1((Date.now() - start) / 1000),
    target_still_alive: still,
    reason,
    health: Math.round(bot.entity?.health ?? 20),
    loot,
    note: !still && hits > 0
      ? (loot?.drops_remaining ? '目标已击杀; 有掉落物未能拾取(见 new_events/nearby)。' : '目标已击杀并拾取掉落物。')
      : undefined,
  }
}

export async function useItem(bot, times = 1) {
  const n = Math.min(16, Math.max(1, Math.floor(Number(times) || 1)))
  for (let i = 0; i < n; i++) {
    bot.activateItem()
    await sleep(300)
  }
  return { used: bot.heldItem?.name ?? '空手', times: n, note: '已对手持物品按下右键(使用/放置/互动)。' }
}

export async function eatFood(bot, itemName) {
  let target = null
  if (itemName) {
    const items = findInvItems(bot, itemName)
    if (!items.length) throw new Error(`物品栏里没有「${itemName}」。`)
    target = items[0]
  } else if (bot.heldItem && isFoodItem(bot.heldItem, bot.registry)) {
    target = bot.heldItem
  } else {
    target = bot.inventory.items().find((it) => isFoodItem(it, bot.registry))
    if (!target) throw new Error('物品栏里没有任何可食用的食物。')
  }
  // 手持不同才换; equip 后 mineflayer 的 heldItem 可能异步更新, 等一拍确认
  if (bot.heldItem?.name !== target.name || bot.heldItem?.count !== target.count) {
    await bot.equip(target, 'hand')
    // 等 heldItem 更新(1.21 下 equip 后 set_slot 包有延迟); 按物品名判断
    for (let i = 0; i < 20 && !(bot.heldItem && bot.heldItem.name === target.name); i++) {
      await sleep(100)
    }
  }
  if (!bot.heldItem) {
    throw new Error(`装备食物失败: 尝试拿取「${target.name}」但手上还是空的。背包物品可能被服务器锁定/插件保护, 或该物品不在快捷栏且快捷栏满了。`)
  }
  await bot.consume()
  return { ate: target.name, food_level: bot.entity?.food, note: '进食完成。' }
}

export async function dropItems(bot, itemName, count) {
  const items = findInvItems(bot, itemName)
  if (!items.length) {
    const have = bot.inventory.items().slice(0, 25).map((it) => it.name).join(', ')
    throw new Error(`物品栏里没有「${itemName}」。现有: ${have || '(空)'}。名称可用任意大小写/带 minecraft: 前缀/空格代替下划线。`)
  }
  const total = items.reduce((s, it) => s + it.count, 0)
  const want = Math.min(total, count ? Math.floor(Number(count)) : total)
  let dropped = 0
  let stackTossed = false // 用了"整组丢"的兜底(数量可能多于请求)
  for (const it of items) {
    if (dropped >= want) break
    const need = want - dropped
    if (need >= it.count) {
      // 整组直接按格子丢: 不依赖 registry 查询, 绕开 Invalid itemType
      await bot.tossStack(it)
      dropped += it.count
    } else {
      // 部分数量: 先试按数量的 toss(需要 registry); 不行就整组丢并标记
      try {
        await bot.toss(it.type, it.metadata, need)
        dropped += need
      } catch (err) {
        if (!/Invalid itemType/i.test(String(err?.message || err))) throw err
        await bot.tossStack(it)
        dropped += it.count
        stackTossed = true
      }
    }
  }
  return {
    dropped: items[0].name,
    requested: want,
    count: dropped,
    note: stackTossed && dropped > want
      ? `已丢弃 ${dropped} 个(该版本按数量丢弃受限, 按"整组"丢出, 略多于请求数)。`
      : undefined,
  }
}

const SLOT_ALIASES = {
  main_hand: 'hand', mainhand: 'hand', hand: 'hand',
  off_hand: 'off-hand', offhand: 'off-hand',
  head: 'head', helmet: 'head',
  chest: 'torso', chestplate: 'torso', torso: 'torso',
  legs: 'legs', leggings: 'legs',
  feet: 'feet', boots: 'feet',
}

export async function equipItem(bot, itemName, slot = 'hand') {
  const dest = SLOT_ALIASES[String(slot || 'hand').toLowerCase()] ?? 'hand'
  const items = findInvItems(bot, itemName)
  if (!items.length) {
    const have = bot.inventory.items().slice(0, 20).map((it) => it.name).join(', ')
    throw new Error(`物品栏里没有「${itemName}」。现有: ${have || '(空)'}。可用 inventory 查看。`)
  }
  await bot.equip(items[0], dest)
  return { equipped: items[0].name, slot: dest, title: itemTitle(items[0]) }
}

export async function craftItem(bot, itemName, count = 1) {
  const reg = bot.registry
  const item = resolveItem(reg, itemName)
  if (!item) throw new Error(`未知物品「${itemName}」(需英文 id, 如 bread / stone_pickaxe; 或中文名如 面包)。`)
  const n = Math.max(1, Math.floor(Number(count) || 1))

  const tableBlock = reg?.blocksByName?.crafting_table
    ? bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 4 })
    : null
  const table = tableBlock ?? null

  const recipes = bot.recipesFor(item.id, null, n, table)
  if (!recipes.length) {
    // 用 recipesAll 判断真正原因: 需要工作台 vs 材料不足
    const all = bot.recipesAll ? bot.recipesAll(item.id, null, table) : []
    if (all.length && !table) {
      // 配方存在但需要工作台且附近没有
      let placedHint = ''
      try {
        const placed = recallMemories(currentNs(), 'crafting_table')
          .filter((m) => m.key === '放置:crafting_table')
        if (placed.length) placedHint = ` 你之前放过工作台: ${placed[0].text}`
      } catch { /* ignore */ }
      throw new Error(`「${itemName}」的配方需要工作台, 而附近 4 格内没有。先放置/走到工作台旁再试(或用 find 找 crafting_table)。${placedHint}`)
    }
    if (all.length) {
      // 配方在但材料不足: 列出缺的材料
      let need = ''
      try {
        const missing = missingMaterialsFor(bot, all[0], n)
        if (missing.length) need = ` 缺: ${missing.join(', ')}`
      } catch { /* ignore */ }
      throw new Error(`「${itemName}」的材料不足${need}。先 collect 采集/craft 合成材料, 再重试。`)
    }
    throw new Error(`没有「${itemName}」的可用配方(该物品可能无法合成, 或需要特定机器——本服是 Slimefun 服时部分物品要走机器)。`)
  }
  await bot.craft(recipes[0], n, table)
  return { crafted: itemName, count: n, used_crafting_table: Boolean(table) }
}

// 物品名解析: 支持 minecraft: 前缀 / 英文 id / 中文显示名 / 大小写变体
function resolveItem(reg, name) {
  if (!reg?.itemsByName) return null
  const raw = String(name ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  if (reg.itemsByName[raw]) return reg.itemsByName[raw]
  // 中文名/显示名匹配
  for (const it of Object.values(reg.itemsByName)) {
    const dn = String(it.displayName ?? '').toLowerCase()
    if (dn === String(name ?? '').trim().toLowerCase()) return it
  }
  // 去掉下划线/空格再比一次
  const flat = raw.replace(/[_ ]/g, '')
  for (const it of Object.values(reg.itemsByName)) {
    if (String(it.name ?? '').replace(/[_ ]/g, '') === flat) return it
  }
  return null
}

// 计算合成某配方还缺哪些材料
function missingMaterialsFor(bot, recipe, count) {
  const out = []
  try {
    for (const d of recipe.delta ?? []) {
      if (d.count >= 0) continue // 正数=产物, 负数=消耗
      const have = bot.inventory.count(d.id, d.metadata)
      const need = -d.count * Math.ceil(count / (recipe.result?.count ?? 1))
      if (have < need) {
        const nm = bot.registry?.itemsByName?.[d.id]?.displayName || d.id
        out.push(`${nm} ×${need - have}`)
      }
    }
  } catch { /* ignore */ }
  return out
}

// 复合采集: 找方块 → 寻路过去 → 挖掘 → 拾取, 循环直到数量/超时
export async function collectBlocks(bot, namesStr, opts = {}, task) {
  const { count = 4, radius = 64, timeoutMs = 240000 } = opts
  const { ids } = resolveBlockIds(bot.registry, namesStr)
  const deadline = Date.now() + Math.max(5000, timeoutMs)
  const startSeq = state.notifiedSeq
  const skip = new Set()
  const perBlock = {}
  let dug = 0
  let pickedUp = 0
  let strayDrops = []
  const losRetried = new Set() // 隔墙重试过的方块(防死循环)
  let stopped = false
  let timedOut = false
  let noMore = false
  let chatWake = false

  const chatEventSince = () => (opts.interruptOnChat === false
    ? null
    : eventsSince(startSeq).find((e) => e.type === 'chat' || e.type === 'whisper'))

  while (dug < count) {
    if (task?.cancelled) { stopped = true; break }
    if (Date.now() > deadline) { timedOut = true; break }
    if (chatEventSince()) { chatWake = true; break }

    const found = findBlockPositions(bot, ids, radius, 8, Boolean(opts.fairOnly))
    const entry = found.find(({ p }) => !skip.has(`${p.x},${p.y},${p.z}`) && p.distanceTo(bot.entity.position) > 1.2)
    if (!entry) { noMore = true; break }

    const { p } = entry
    const key = `${p.x},${p.y},${p.z}`
    const r = await pathfindTo(bot, p, { range: 1, timeoutMs: Math.min(45000, deadline - Date.now()), task, interruptOnEvents: opts.interruptOnChat !== false, startSeq })
    if (r.reason === 'stopped_by_user' || r.reason === 'interrupted_by_auto_defense') { stopped = true; break }
    if (String(r.reason || '').startsWith('interrupted_by_')) { chatWake = true; break }

    const block = bot.blockAt(p)
    if (!block || !ids.includes(block.id)) { skip.add(key); continue }
    if (!block.diggable) { skip.add(key); continue }

    try {
      await equipBestToolFor(bot, block)
      if (typeof block.canHarvest === 'function' && bot.heldItem && !block.canHarvest(itemNumericId(bot.heldItem))) {
        skip.add(key) // 没有能采出的工具, 跳过该方块不白挖
        continue
      }
      await digWithTimeout(bot, block)
      dug += 1
      perBlock[block.name] = (perBlock[block.name] ?? 0) + 1
      const pickup = await pickupNearbyDrops(bot, { task, timeoutMs: 7000, center: block.position })
      pickedUp += pickup.drops_checked
      if (pickup.drops_remaining && pickup.remaining_nearest) {
        // 掉落物走不到(掉进洞里等): 记下来放进返回, 提示模型或后续路过再收
        strayDrops.push(pickup.remaining_nearest)
      }
    } catch (err) {
      const msg = String(err?.message || err)
      // 视线被挡(隔墙): 贴近一步重试一次, 仍不行再跳过
      if (/视线被遮挡|隔.*墙/.test(msg) && !losRetried.has(key)) {
        losRetried.add(key)
        await pathfindTo(bot, p, { range: 1, timeoutMs: 12000, task, interruptOnEvents: opts.interruptOnChat !== false, startSeq })
        try {
          await digWithTimeout(bot, block)
          dug += 1
          perBlock[block.name] = (perBlock[block.name] ?? 0) + 1
          const pickup = await pickupNearbyDrops(bot, { task, timeoutMs: 7000, center: block.position })
          pickedUp += pickup.drops_checked
        } catch { skip.add(key) }
        continue
      }
      skip.add(key)
      if (/No path|too far/i.test(msg)) continue
      // 其他错误也跳过该方块继续
    }
  }

  return {
    requested: count,
    dug_total: dug,
    drops_checked: pickedUp,
    per_block: perBlock,
    stray_drops: strayDrops.length ? strayDrops : undefined,
    stopped_by_user: stopped,
    timed_out: timedOut,
    no_more_in_radius: noMore,
    chat_wake: chatWake || undefined,
    position: fmtPos(bot.entity.position),
    note: chatWake
      ? '期间有玩家说话, 提前结束采集(查看 new_events 并回复)。'
      : dug > 0 ? '已挖掘并拾取(站在掉落点自动拾取)。' : '没有挖到目标方块。',
  }
}
