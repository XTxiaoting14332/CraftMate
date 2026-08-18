// 建筑规划: AI 一次性给出蓝图(坐标+方块), 本地程序负责移动/换手持/逐格放置/进度持久化,
// 不再需要模型对每一格做"走过去→拿起→放"的推理。
import Vec3 from 'vec3'
import { sleep } from './util.js'
import { pathfindTo } from './movement.js'
import { state, eventsSince } from './bot.js'
import { findBuildingPlan, listBuildingPlans, saveBuildingPlanRecord, deleteBuildingPlan, listMemories, saveMemory } from './store.js'

const MAX_ENTRIES = 512
const SUPPORT_DIRS = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
]

export function normalizeBlockName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/minecraft:/g, '')
    .replace(/[\s　]+/g, '_')
    .trim()
}

function parsedEntry(e) {
  const x = Math.floor(Number(e?.x))
  const y = Math.floor(Number(e?.y))
  const z = Math.floor(Number(e?.z))
  const block = normalizeBlockName(e?.block)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !block) return null
  return { x, y, z, block }
}

// 只统计还没放完的条目: placed/already 不再占用材料
export function computeMaterials(bot, entries = []) {
  const need = new Map()
  for (const e of entries) {
    if (!e || e.status === 'placed' || e.status === 'already') continue
    const b = normalizeBlockName(e.block)
    if (!b || b === 'air') continue
    need.set(b, (need.get(b) ?? 0) + 1)
  }
  const have = new Map()
  for (const it of bot.inventory.items()) {
    const b = normalizeBlockName(it.name)
    if (need.has(b)) have.set(b, (have.get(b) ?? 0) + it.count)
  }
  const required = [...need].map(([block, count]) => ({ block, need: count }))
  const missing = []
  for (const [block, count] of need) {
    const haveCount = have.get(block) ?? 0
    if (haveCount < count) {
      missing.push({ block, need: count, have: haveCount, shortage: count - haveCount })
    }
  }
  return {
    required,
    have: [...have].map(([block, count]) => ({ block, count })),
    missing,
    ready: missing.length === 0,
  }
}

// 站在目标周围一块能落脚的实心方块上, 且眼睛距离目标 ≤4.5
function candidateStands(bot, target) {
  const out = []
  const pos = bot.entity.position
  const center = target.offset(0.5, 0.5, 0.5)
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0 && dy === 0) continue
        const p = target.offset(dx, dy, dz)
        const at = bot.blockAt(p)
        if (!at || at.boundingBox === 'block') continue
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (!below || below.boundingBox !== 'block') continue
        const eye = p.offset(0, bot.entity.height ?? 1.6, 0)
        if (eye.distanceTo(center) > 4.4) continue
        out.push(p)
      }
    }
  }
  return out
    .sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos))
    .slice(0, 12)
}

async function ensureReach(bot, target, task) {
  const center = target.offset(0.5, 0.5, 0.5)
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  if (eye.distanceTo(center) <= 4.5) return { reached: true }
  for (const p of candidateStands(bot, target)) {
    if (task?.cancelled) return { cancelled: true }
    const r = await pathfindTo(bot, p, {
      range: 0.5,
      timeoutMs: 9000,
      task,
      interruptOnEvents: false,
    })
    if (r.reason === 'stopped_by_user' || r.reason === 'interrupted_by_auto_defense') return { cancelled: true }
    if (r.completed !== true) continue
    const nowEye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
    if (nowEye.distanceTo(center) <= 4.5) return { reached: true }
  }
  return { reached: false }
}

async function placeOne(bot, entry, stock, task) {
  const target = new Vec3(entry.x, entry.y, entry.z)
  const blockName = normalizeBlockName(entry.block)
  const cur = bot.blockAt(target)
  if (!cur) return { status: 'error', note: '该位置区块未加载' }
  if (cur.boundingBox === 'block') {
    if (normalizeBlockName(cur.name) === blockName) {
      return { status: 'already', note: `已是 ${cur.name}` }
    }
    return { status: 'blocked', note: `被 ${cur.name} 占用` }
  }
  if ((stock.get(blockName) ?? 0) <= 0) {
    return { status: 'missing', note: `缺材料 ${blockName}` }
  }
  const reach = await ensureReach(bot, target, task)
  if (reach.cancelled) return { status: 'cancelled' }
  if (!reach.reached) return { status: 'unreachable', note: '够不到该位置, 也没找到可站立的位置' }

  const cur2 = bot.blockAt(target)
  if (cur2 && cur2.boundingBox === 'block') {
    if (normalizeBlockName(cur2.name) === blockName) return { status: 'already', note: `已是 ${cur2.name}` }
    return { status: 'blocked', note: `被 ${cur2.name} 占用` }
  }
  let ref = null
  let dir = null
  for (const d of SUPPORT_DIRS) {
    const neighbor = bot.blockAt(target.plus(d))
    if (neighbor && neighbor.boundingBox === 'block') {
      ref = neighbor
      dir = d.scaled(-1)
      break
    }
  }
  if (!ref) return { status: 'no_support', note: '周围没有支撑面(低层没先放或目标悬空)' }
  const item = bot.inventory.items().find((it) => normalizeBlockName(it.name) === blockName)
  if (!item) return { status: 'missing', note: `缺材料 ${blockName}` }
  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand')
    await bot.placeBlock(ref, dir)
    stock.set(blockName, (stock.get(blockName) ?? 0) - 1)
    await sleep(90)
    return { status: 'placed', note: `已放 ${item.name}` }
  } catch (err) {
    return { status: 'error', note: String(err?.message || err).slice(0, 120) }
  }
}

// 本地执行一份蓝图(不处理持久化, 便于测试与复用)。返回逐条状态 + 汇总。
export async function buildEntries(bot, entries = [], opts = {}, task = {}) {
  const working = entries
    .map((e, i) => {
      const p = parsedEntry(e)
      if (!p) return null
      return { ...p, status: e?.status || 'pending', note: e?.note || null, _i: i }
    })
    .filter(Boolean)
    .slice(0, MAX_ENTRIES)
  const material = computeMaterials(bot, entries)
  const stock = new Map(material.required.map(({ block }) => [block, (material.have.find((h) => h.block === block)?.count ?? 0)]))
  const ordered = working
    .filter((e) => e.status !== 'placed' && e.status !== 'already' && e.status !== 'cancelled')
    .sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
  // 社交优先: 施工期间有人说话/私聊就停下, 把进度带回让模型先回复(不吞聊天)
  const startSeq = opts.startSeq ?? state.notifiedSeq
  const chatWake = () => eventsSince(startSeq).some((e) => e.type === 'chat' || e.type === 'whisper')

  let interruptedByChat = false
  for (const entry of ordered) {
    if (chatWake()) { interruptedByChat = true; break }
    if (task?.cancelled || !bot.entity || bot.entity.health <= 0) {
      entry.status = entry.status || 'cancelled'
      break
    }
    const r = await placeOne(bot, entry, stock, task)
    entry.status = r.status
    entry.note = r.note ?? null
  }

  const count = (s) => working.filter((e) => e.status === s).length
  const placed = count('placed')
  const already = count('already')
  const materials = computeMaterials(bot, working)
  return {
    entries_total: working.length,
    placed,
    already,
    blocked: count('blocked'),
    missing: count('missing'),
    unreachable: count('unreachable'),
    no_support: count('no_support'),
    errors: count('error'),
    pending: count('pending'),
    stopped_by_user: Boolean(task?.cancelled),
    interrupted_by_chat: interruptedByChat || undefined,
    progress_percent: working.length ? Math.round(((placed + already) / working.length) * 100) : 100,
    remaining: working.length - placed - already,
    missing_materials: materials.missing,
    materials,
    entries: working
      .sort((a, b) => a._i - b._i)
      .map(({ _i, ...rest }) => rest),
    note: interruptedByChat
      ? '期间有玩家说话, 已停下施工(进度已保存, 回复后可用 build(action=place) 续建)。'
      : missingMaterialsNote(materials.missing),
  }
}

function missingMaterialsNote(missing) {
  if (!missing.length) return '材料齐备, 剩余进度可直接继续。'
  const top = missing.slice(0, 5).map((m) => `${m.block}×${m.shortage}`).join(', ')
  return `缺材料: ${top}${missing.length > 5 ? ` 等 ${missing.length} 种` : ''}; 先用 collect/craft 补齐再 place, 或 allow_missing=true 先放已有的。`
}

export function buildingSummary(plan) {
  const count = (s) => plan.entries.filter((e) => e.status === s).length
  const placed = count('placed')
  const already = count('already')
  return {
    name: plan.name,
    entries_total: plan.entries.length,
    placed,
    already,
    blocked: count('blocked'),
    missing: count('missing'),
    unreachable: count('unreachable'),
    no_support: count('no_support'),
    errors: count('error'),
    pending: count('pending'),
    remaining: plan.entries.length - placed - already,
    progress_percent: plan.entries.length ? Math.round(((placed + already) / plan.entries.length) * 100) : 100,
    updated: plan.updated,
  }
}

export function saveBuildingPlan(ns, name, rawEntries) {
  const entries = (Array.isArray(rawEntries) ? rawEntries : [])
    .map(parsedEntry)
    .filter(Boolean)
    .slice(0, MAX_ENTRIES)
  if (!entries.length) throw new Error('entries 需要至少一个 {x,y,z,block} 对象(block 用英文 id, 如 oak_planks)。')
  const existing = findBuildingPlan(ns, name)
  return saveBuildingPlanRecord(ns, {
    name,
    entries,
    created: existing?.created,
  })
}

export function getBuildingPlan(ns, name) {
  const plan = findBuildingPlan(ns, name)
  if (!plan) throw new Error(`没有名为「${name}」的建筑规划。先用 build action=plan 保存。`)
  return plan
}

export function listBuildingPlansLocal(ns) {
  return listBuildingPlans(ns).map(buildingSummary)
}

export function removeBuildingPlan(ns, name) {
  const removed = deleteBuildingPlan(ns, name)
  if (removed !== 1) throw new Error(`没有名为「${name}」的建筑规划。`)
  return removed
}

// 加载已保存规划并本地施工, 施工结束后把逐条状态写回持久化。
export async function buildSavedPlan(bot, ns, name, opts = {}, task = {}) {
  const plan = getBuildingPlan(ns, name)
  const material = computeMaterials(bot, plan.entries)
  if (!opts.allow_missing && !material.ready) {
    return {
      plan_name: plan.name,
      ready: false,
      materials: material,
      note: missingMaterialsNote(material.missing),
      tip: '先用 collect/craft 补齐材料, 再 action=place 继续; 想先放背包里已有的可传 allow_missing=true。',
    }
  }
  const r = await buildEntries(bot, plan.entries, opts, task)
  return updatePlanAfterBuild(ns, plan, r)
}

function updatePlanAfterBuild(ns, plan, r) {
  saveBuildingPlanRecord(ns, {
    name: plan.name,
    entries: r.entries,
    created: plan.created,
  })
  let completion_memory_key = null
  let completion_goal = null
  if (r.remaining === 0 && r.missing_materials.length === 0) {
    try {
      const key = `建造:${plan.name}`
      const first = r.entries?.[0] ?? null
      saveMemory(ns, {
        key,
        text: `建筑规划「${plan.name}」已全部完成: ${r.entries_total} 格, 位置示例 (${first ? `${first.x}, ${first.y}, ${first.z}` : '未知'}), 完成于 ${new Date().toLocaleString('zh-CN')}`,
        tags: ['建造记录', '建筑'],
      })
      completion_memory_key = key
      // 目标标题或正文含规划名时自动收尾, 避免 AI 建完还追问"要建什么"
      const related = listMemories(ns).find((m) =>
        m.key?.startsWith('goal:')
        && !/状态:\s*已完成/.test(m.text ?? '')
        && ((m.text ?? '').includes(plan.name) || (m.key ?? '').includes(plan.name)))
      if (related) {
        const text = (related.text ?? '').replace(/\n?状态:\s*已完成.*$/s, '') + '\n状态: 已完成'
        saveMemory(ns, { key: related.key, text, tags: [...new Set([...(related.tags ?? []), 'goal'])] })
        completion_goal = related.key
      }
    } catch { /* 记忆写盘失败不影响施工 */ }
  }
  const { entries, ...summary } = r
  return {
    ...summary,
    plan_name: plan.name,
    ready: r.remaining === 0 && r.missing_materials.length === 0,
    completion_memory_key,
    completion_goal,
    note: r.note || (r.remaining === 0 ? '建筑规划已全部完成。' : '建筑规划部分完成(看逐条状态)。'),
  }
}

// 蓝图结构校验: 在保存规划前检查常见"建得乱"的问题, 提醒模型修正。
// 不阻止保存(模型可能故意建非标准结构), 只给建议。
export function validateBlueprint(entries = []) {
  const pts = entries
    .map(parsedEntry)
    .filter(Boolean)
  if (!pts.length) return { ok: true, warnings: [] }
  const warnings = []

  const byY = new Map()
  for (const p of pts) {
    if (!byY.has(p.y)) byY.set(p.y, [])
    byY.get(p.y).push(p)
  }
  const ys = [...byY.keys()].sort((a, b) => a - b)
  const minY = ys[0]
  const maxY = ys[ys.length - 1]
  const bottom = byY.get(minY) ?? []
  const top = byY.get(maxY) ?? []

  // 1. 是否有"地板"(最低层形成平面: 面积足够且不全是散点)
  const bottomSet = new Set(bottom.map((p) => `${p.x},${p.z}`))
  if (bottom.length >= 4) {
    const xs = bottom.map((p) => p.x)
    const zs = bottom.map((p) => p.z)
    const w = Math.max(...xs) - Math.min(...xs) + 1
    const d = Math.max(...zs) - Math.min(...zs) + 1
    const area = w * d
    // 覆盖率低 → 地板不完整
    if (bottom.length / area < 0.4) {
      warnings.push(`最低层(y=${minY})只覆盖 ${Math.round((bottom.length / area) * 100)}% 的底面积(${w}×${d} 范围内 ${bottom.length}/${area} 格)——像是散点, 不像完整地板。如果要建房间, 先铺满一层做地基。`)
    }
  } else {
    warnings.push(`最低层(y=${minY})只有 ${bottom.length} 格, 可能没有完整地基。房子建议先铺一层地板。`)
  }

  // 2. 是否有墙(四壁: 看中间层在水平方向是否围成闭合)
  const midY = ys[Math.floor(ys.length / 2)]
  const mid = byY.get(midY) ?? []
  if (mid.length >= 8) {
    const xs = mid.map((p) => p.x)
    const zs = mid.map((p) => p.z)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minZ = Math.min(...zs)
    const maxZ = Math.max(...zs)
    const set = new Set(mid.map((p) => `${p.x},${p.z}`))
    const perimeter = 2 * ((maxX - minX + 1) + (maxZ - minZ + 1))
    const onEdge = mid.filter((p) => p.x === minX || p.x === maxX || p.z === minZ || p.z === maxZ).length
    if (onEdge / perimeter < 0.5) {
      warnings.push(`中间层(y=${midY})只有 ${Math.round((onEdge / perimeter) * 100)}% 的方块在轮廓边缘——不像闭合的墙。如果建的是房子, 四壁(轮廓一圈)应该基本连续。`)
    }
  }

  // 3. 高度异常
  if (maxY - minY > 12) {
    warnings.push(`高度跨度 ${maxY - minY} 格(y=${minY}~${maxY}), 可能是塔/高楼; 如果是普通房子, 3~6 格高比较正常。`)
  }

  // 4. 屋顶缺失检查: 最高层面积明显小于地板面积(墙层 vs 完整地板) = 可能没封顶
  if (top.length >= 4 && maxY > minY) {
    const bottomArea = bottom.length
    if (bottomArea >= 8 && top.length / bottomArea < 0.7) {
      warnings.push(`最高层(y=${maxY})只有 ${top.length} 格, 不到地板(${bottomArea} 格)的 70%——如果这是房子, 你可能忘了铺屋顶(封顶)。`)
    }
  }

  return { ok: warnings.length === 0, warnings: warnings.slice(0, 5) }
}
