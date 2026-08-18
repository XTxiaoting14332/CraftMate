// 世界感知: 方块检查(含箱子内容)、周围实体、方块搜索、视线方块
import Vec3 from 'vec3'
import { fmtPos, round1 } from './util.js'
import { formatItem, decodeText } from './items.js'

const SHULKER_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const CONTAINER_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest', ...SHULKER_COLORS.map((c) => `${c}_shulker_box`), 'shulker_box'])
const OTHER_CONTAINERS = new Set(['dispenser', 'dropper', 'hopper', 'brewing_stand', 'lectern', 'chest_minecart'])
const FURNACE_LIKE = new Set(['furnace', 'blast_furnace', 'smoker'])

// 视线所指方块(兼容新旧 API)
export function sightBlock(bot, maxDistance = 64) {
  try {
    if (typeof bot.blockAtCursor === 'function') {
      const r = bot.blockAtCursor(maxDistance)
      const b = r?.block ?? r
      if (b) return b
    }
  } catch { /* ignore */ }
  try {
    const { yaw, pitch } = bot.entity
    const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
    const hit = bot.world.raycast(eye, dir, maxDistance)
    return hit?.block ?? null
  } catch {
    return null
  }
}

export async function inspectBlock(bot, coords, fairOnly = false) {
  let block
  if (coords && coords.x != null && coords.y != null && coords.z != null) {
    const target = new Vec3(Math.floor(coords.x), Math.floor(coords.y), Math.floor(coords.z))
    if (fairOnly) {
      const center = target.offset(0.5, 0.5, 0.5)
      const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
      const inReach = eye.distanceTo(center) <= 4.5
      if (!inReach && !hasLineOfSightToPoint(bot, center, target)) {
        throw new Error('拟真模式: 该方块不在视线/触及范围内(看不到的无法查询)。走近后重试; 自建服可用 connect(fair_perception=false) 关闭拟真感知。')
      }
    }
    block = bot.blockAt(target, true)
    if (!block) throw new Error('该位置的区块尚未加载(太远), 请先走近。')
  } else {
    block = sightBlock(bot)
    if (!block) throw new Error('视线内没有指向任何方块, 请提供 x/y/z 坐标。')
  }

  const info = {
    name: block.name,
    title: block.displayName,
    position: fmtPos(block.position),
    bounding: block.boundingBox,
    diggable: Boolean(block.diggable),
    hardness: block.hardness ?? null,
  }
  try { info.properties = block.getProperties() } catch { /* 版本差异, 忽略 */ }
  try {
    if (bot.heldItem && block.diggable) info.can_harvest_with_held = Boolean(block.canHarvest(bot.heldItem.type ?? bot.heldItem.id))
  } catch { /* ignore */ }

  const d = round1(bot.entity.position.distanceTo(block.position))
  info.distance = d

  if (CONTAINER_BLOCKS.has(block.name)) {
    if (d <= 4.5) {
      const window = await bot.openContainer(block)
      try {
        const items = window.items()
        info.container = {
          type: 'chest_like',
          slots_used: items.length,
          total_items: items.reduce((s, it) => s + it.count, 0),
          contents: items.map((it) => formatItem(it, bot.registry)),
        }
      } finally {
        try { window.close() } catch { /* ignore */ }
      }
    } else {
      info.container = { type: 'chest_like', hint: `距离 ${d} 格太远无法打开, 先 goto 到附近(坐标 ${JSON.stringify(fmtPos(block.position))})再 inspect。` }
    }
  } else if (FURNACE_LIKE.has(block.name)) {
    info.container = { type: block.name, hint: '是熔炉类方块, 用 container(action="open") 打开后 deposit(原料/燃料自动判断)/withdraw(取产物)。' }
  } else if (OTHER_CONTAINERS.has(block.name)) {
    info.container = { type: block.name, hint: '是一个容器, 但当前版本暂不支持自动打开其界面。' }
  }

  return info
}

function groupEntities(bot, entities) {
  const map = new Map()
  for (const e of entities) {
    const key = e.name || e.displayName || 'unknown'
    const d = round1(bot.entity.position.distanceTo(e.position))
    const cur = map.get(key)
    if (!cur) {
      map.set(key, { name: key, display: e.displayName ?? key, count: 1, nearest_distance: d, example_position: fmtPos(e.position) })
    } else {
      cur.count += 1
      if (d < cur.nearest_distance) {
        cur.nearest_distance = d
        cur.example_position = fmtPos(e.position)
      }
    }
  }
  return [...map.values()].sort((a, b) => a.nearest_distance - b.nearest_distance)
}

// 玩家头顶名 = 队伍前缀 + 用户名 + 后缀(称号/前缀类插件用 scoreboard team 实现)
function playerNametag(bot, username) {
  try {
    for (const team of Object.values(bot.teams || {})) {
      if (team.nameMap?.has?.(username)) {
        const prefix = decodeText(team.prefix?.toString?.() ?? team.prefix ?? '')
        const suffix = decodeText(team.suffix?.toString?.() ?? team.suffix ?? '')
        const tag = `${prefix}${username}${suffix}`
        if (tag !== username) return tag
        return undefined
      }
    }
  } catch { /* ignore */ }
  return undefined
}

export function nearbySummary(bot, radius = 48, fairOnly = false) {
  const pos = bot.entity.position
  const players = []
  const animals = []
  const drops = []
  const named = []

  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue
    const d = pos.distanceTo(e.position)
    if (d > radius) continue
    // 拟真模式: 墙体遮挡的实体不可见(贴身 3 格内除外 —— 相当于擦身而过)
    if (fairOnly && d > 3 && !hasLineOfSightToPoint(bot, e.position.offset(0, (e.height ?? 1.6) * 0.85, 0))) continue

    if (e.type === 'player') {
      if (e.username && e.username !== bot.username) {
        players.push({
          player: e.username,
          nametag: playerNametag(bot, e.username),
          distance: round1(d),
          position: fmtPos(e.position),
          ping: bot.players?.[e.username]?.ping ?? null,
        })
      }
    } else if (e.type === 'object' && e.name === 'item') {
      let itemName = '未知物品'
      try {
        const it = e.getDroppedItem?.()
        if (it?.name) itemName = it.name
      } catch { /* ignore */ }
      drops.push({ item: itemName, distance: round1(d), position: fmtPos(e.position) })
    } else if (e.customName != null) {
      // 命名实体: 盔甲架/展示实体(全息文字、悬浮商店说明)、被命名的生物 —— customName 就是头顶悬浮字
      named.push({
        entity: e.name ?? e.displayName ?? 'unknown',
        title: decodeText(String(e.customName)),
        distance: round1(d),
        position: fmtPos(e.position),
      })
    } else if (e.type === 'mob' || e.type === 'hostile' || e.type === 'animal') {
      let kind = e.type
      try {
        kind = bot.registry?.entitiesByName?.[e.name]?.type ?? e.type
      } catch { /* ignore */ }
      if (kind !== 'hostile') animals.push(e) // 敌对生物由 hostilesNear 单独归类
    }
  }

  const hostiles = hostilesNear(bot, radius).map((h) => h.entity)
  players.sort((a, b) => a.distance - b.distance)
  const dropGroups = groupEntities(bot, drops.map((x) => ({ ...x, name: x.item, displayName: x.item, position: x.position })))

  return {
    radius,
    perception: fairOnly ? 'fair(仅视线内实体)' : 'full(含墙后)',
    players,
    named_entities: named.sort((a, b) => a.distance - b.distance).slice(0, 12),
    hostile_mobs: groupEntities(bot, hostiles).slice(0, 12),
    passive_mobs: groupEntities(bot, animals).slice(0, 12),
    dropped_items: dropGroups.slice(0, 12),
  }
}

// 轻量接近扫描("听觉"语义, 不做视线检测): 附近的玩家与敌对生物, 供"有人靠近"唤醒判定用
export function proximityScan(bot, playerRadius = 10, hostileRadius = 12) {
  const players = new Map()
  const hostiles = new Map()
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue
    const d = bot.entity.position.distanceTo(e.position)
    if (e.type === 'player' && e.username && e.username !== bot.username) {
      if (d <= playerRadius) players.set(e.username, round1(d))
    } else if (e.type === 'mob' || e.type === 'hostile') {
      let kind = e.type
      try {
        kind = bot.registry?.entitiesByName?.[e.name]?.type ?? e.type
      } catch { /* ignore */ }
      if (kind === 'hostile' && d <= hostileRadius) hostiles.set(`${e.name ?? 'unknown'}#${e.id}`, round1(d))
    }
  }
  return { players, hostiles }
}

// 半径内的敌对生物(按 minecraft-data 分类), 按距离从近到远
export function hostilesNear(bot, radius) {  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue
    if (!(e.type === 'mob' || e.type === 'hostile' || e.type === 'animal')) continue
    let kind = e.type
    try {
      kind = bot.registry?.entitiesByName?.[e.name]?.type ?? e.type
    } catch { /* ignore */ }
    if (kind !== 'hostile') continue
    const d = bot.entity.position.distanceTo(e.position)
    if (d <= radius) {
      out.push({ entity: e, name: e.name ?? e.displayName ?? 'unknown', display: e.displayName ?? e.name, distance: d })
    }
  }
  return out.sort((a, b) => a.distance - b.distance)
}

// ---- 拟真感知(反矿透) ----
// 拟真原则: AI 只能知道"一个玩家真正看得到/听得到/摸得到"的信息

const NEIGHBOR_DIRS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
  new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
]

// 方块是否"暴露": 六邻至少一面是空气/水等可穿透方块 —— 即洞壁或地表上玩家看得到的方块
export function isBlockExposed(bot, pos) {
  for (const dir of NEIGHBOR_DIRS) {
    const n = bot.blockAt(pos.plus(dir))
    if (n && n.boundingBox === 'empty') return true
  }
  return false
}

// 眼睛到某点之间是否有墙体遮挡(射线检测)。
// targetBlockPos 给定时: 命中的必须正是该方块(用于方块查询);
// 否则: 命中点距目标 1.6 格内视为可见(用于实体)。
export function hasLineOfSightToPoint(bot, point, targetBlockPos = null) {
  try {
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
    const dist = eye.distanceTo(point)
    if (dist <= 3) return true // 贴身必然能感知
    if (typeof bot.world?.raycast !== 'function') return true
    const dir = point.minus(eye).normalize()
    const hit = bot.world.raycast(eye, dir, dist)
    if (!hit || !hit.block?.position) return true
    if (targetBlockPos) return hit.block.position.equals(targetBlockPos)
    return hit.block.position.distanceTo(point) <= 1.6
  } catch {
    return true
  }
}

// 方块搜索(拟真模式下只保留暴露方块; 注意不返回被过滤数量, 避免元信息泄露)
export function findBlockPositions(bot, ids, radius = 64, max = 16, fairOnly = false) {
  const fetchCount = fairOnly ? Math.min(120, Math.max(8, max * 6)) : Math.max(1, max) * 4
  let positions = bot.findBlocks({ matching: ids, maxDistance: radius, count: fetchCount })
  if (fairOnly) positions = positions.filter((p) => isBlockExposed(bot, p))
  return positions
    .map((p) => ({ p, d: bot.entity.position.distanceTo(p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
}

export function resolveBlockIds(registry, namesStr) {
  const names = String(namesStr).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  const ids = []
  const unknown = []
  for (const n of names) {
    const b = registry?.blocksByName?.[n]
    if (b) ids.push(b.id)
    else unknown.push(n)
  }
  if (!ids.length) {
    throw new Error(`未知的方块名: ${unknown.join(', ') || namesStr}。请使用英文 id, 例如 stone / iron_ore / crafting_table`)
  }
  return { ids, unknown }
}

export function findBlocksTool(bot, namesStr, opts = {}) {
  const { radius = 64, max = 16, fairOnly = false } = opts
  const { ids, unknown } = resolveBlockIds(bot.registry, namesStr)
  const withD = findBlockPositions(bot, ids, radius, max, fairOnly)
  return {
    searched: String(namesStr),
    found: withD.length,
    perception: fairOnly ? 'fair(仅暴露方块: 洞壁/地表可见)' : 'full(不过滤, 含深埋)',
    closest_distance: withD.length ? round1(withD[0].d) : null,
    blocks: withD.map(({ p, d }) => ({ name: bot.blockAt(p)?.name ?? '未加载', position: fmtPos(p), distance: round1(d) })),
    unknown_names: unknown.length ? unknown : undefined,
    hint: withD.length
      ? '可直接用 goto 前往 position'
      : (fairOnly
          ? '拟真模式只搜索暴露的方块(洞壁/地表); 深埋的矿需要探索洞穴发现。自建服可 connect(fair_perception=false) 关闭'
          : `${radius} 格范围内没有找到, 可加大 radius`),
  }
}
