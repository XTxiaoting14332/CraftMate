// 交互动作: 右键实体(喂食/繁殖/驯服/骑乘)、右键方块(门/按钮/拉杆)、潜行、容器存取、村民交易、原地起柱
import Vec3 from 'vec3'
import { state, currentNs } from './bot.js'
import { resolveEntity } from './movement.js'
import { sightBlock } from './world.js'
import { findInvItems } from './actions.js'
import { formatItem, isBlockItem, decodeText } from './items.js'
import { fmtPos, round1, sleep } from './util.js'
import { saveMemory, recallMemories } from './store.js'

const REACH = 4.5
const ENTITY_REACH = 6

// 菜单点击的 stateId 跟踪: mineflayer 的 clickWindow 依赖内部 stateId,
// 插件菜单(DeluxeMenus 等)频繁刷新/替换窗口时容易不同步导致点击被服务器静默忽略。
// 这里自己监听 window_items/set_slot 拿最新 stateId, 直接发 window_click 包。
let menuStateId = -1
function trackMenuStateId(bot) {
  try {
    const c = bot._client
    const listener = (packet) => { if (typeof packet.stateId === 'number') menuStateId = packet.stateId }
    c.on('window_items', listener)
    c.on('set_slot', listener)
    // 窗口关闭后重置, 避免下次窗口用旧 stateId
    bot.on('windowClose', () => { menuStateId = -1 })
  } catch { /* ignore */ }
}

// 直接发 window_click 包(绕过 mineflayer clickWindow), 返回是否"看起来生效了":
// 收到 transaction 确认, 或 stateId 变化(服务器处理了点击), 或当前窗口变化(开了子菜单)。
function rawClickMenuSlot(bot, windowId, slot, button = 0, mode = 0) {
  return new Promise((resolve) => {
    try {
      const c = bot._client
      if (menuStateId < 0) { resolve(false); return }
      const startStateId = menuStateId
      const startWindow = bot.currentWindow
      let transOk = false
      const onTrans = (packet) => { if (packet.windowId === windowId) transOk = true }
      c.on('transaction', onTrans)
      c.write('window_click', {
        windowId,
        stateId: startStateId,
        slot,
        mouseButton: button,
        mode,
        changedSlots: [],
        cursorItem: { itemCount: 0, components: [], removeComponents: [] },
      })
      const started = Date.now()
      const check = () => {
        const changed = transOk
          || menuStateId !== startStateId // stateId 前进 = 服务器响应了
          || bot.currentWindow !== startWindow // 窗口被替换(子菜单)
        if (changed || Date.now() - started > 1200) {
          c.removeListener('transaction', onTrans)
          resolve(changed)
          return
        }
        setTimeout(check, 100)
      }
      setTimeout(check, 100)
    } catch {
      resolve(false)
    }
  })
}

const FACE_VECTORS = {
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
  east: new Vec3(1, 0, 0),
}

// 默认点"机器人眼睛实际看到的那一面"(打火石点火/水桶倒水时需要正确的面)
function faceTowardBot(bot, block) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  const d = eye.minus(block.position.offset(0.5, 0.5, 0.5))
  const ax = Math.abs(d.x)
  const ay = Math.abs(d.y)
  const az = Math.abs(d.z)
  if (ay > ax && ay > az) return new Vec3(0, d.y >= 0 ? 1 : -1, 0)
  if (ax > az) return new Vec3(d.x >= 0 ? 1 : -1, 0, 0)
  return new Vec3(0, 0, d.z >= 0 ? 1 : -1)
}

function coordsOrNull(a) {
  if (a?.x != null && a?.y != null && a?.z != null) {
    return { x: Math.floor(Number(a.x)), y: Math.floor(Number(a.y)), z: Math.floor(Number(a.z)) }
  }
  return null
}

// ---- 右键实体 ----
export async function interactEntity(bot, targetName, action = 'use') {
  if (action === 'dismount') {
    await bot.dismount()
    state.sneaking = state.sneaking // 下坐骑不影响潜行状态
    return { dismounted: true }
  }
  const entity = resolveEntity(bot, targetName)
  if (!entity) throw new Error(`找不到实体「${targetName}」(玩家名或实体名, 如 horse / cow / villager)。可用 nearby 查看。`)
  const d = bot.entity.position.distanceTo(entity.position)
  if (d > ENTITY_REACH) throw new Error(`「${targetName}」距离 ${round1(d)} 格, 交互需要 ≤${ENTITY_REACH} 格, 请先靠近(goto)。`)
  const label = entity.username ?? entity.name ?? targetName

  if (action === 'mount') {
    await bot.mount(entity)
    return { mounted: label, note: '已骑乘。下坐骑用 interact_entity(action="dismount")。' }
  }
  await bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0), true)
  await bot.activateEntity(entity)
  return {
    interacted: label,
    note: '已对目标右键。喂食/繁殖前先 equip 对应食物(如小麦/胡萝卜); 驯服狼需要骨头; 羊剪毛需要手持剪刀。',
  }
}

// ---- 右键方块(门/按钮/拉杆/栅栏门等) ----
export async function activateBlockAt(bot, coords, direction = 'auto') {
  let block
  if (coords) {
    const v = new Vec3(coords.x, coords.y, coords.z)
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
    const dist = eye.distanceTo(v.offset(0.5, 0.5, 0.5))
    if (dist > REACH) throw new Error(`距离 ${round1(dist)} 格超出触及范围(${REACH}), 请先走近。`)
    block = bot.blockAt(v, true)
    if (!block) throw new Error('该位置区块未加载, 请先走近。')
  } else {
    block = sightBlock(bot)
    if (!block) throw new Error('视线内没有指向方块, 请提供 x/y/z 坐标。')
  }
  try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch { /* ignore */ }
  const face = FACE_VECTORS[String(direction).toLowerCase()] ?? faceTowardBot(bot, block)
  await bot.activateBlock(block, face)
  return {
    activated: block.name,
    position: fmtPos(block.position),
    face: direction !== 'auto' ? String(direction).toLowerCase() : undefined,
    note: '已右键该方块。开门/按按钮直接生效; 对打火石/水桶/药水瓶等物品, 这会向该面使用手持物。',
  }
}

// ---- 潜行 ----
export function setSneak(bot, enabled) {
  bot.setControlState('sneak', Boolean(enabled))
  state.sneaking = Boolean(enabled)
  return {
    sneaking: state.sneaking,
    note: enabled ? '潜行中: 不会从方块边缘坠落, 移动减速, 名牌对玩家更隐蔽。' : '已结束潜行。',
  }
}

// ---- 容器存取(实体箱子 / NPC 菜单窗口 / 熔炉) ----
const FURNACE_BLOCKS = /^(furnace|blast_furnace|smoker)$/
const FUEL_NAMES = /(coal|charcoal|_log$|_planks$|stick|lava_bucket|coal_block|dried_kelp|blaze_rod|bamboo|_sapling|wooden_|crafting_table|bookshelf)/

function isFurnaceWindow(win) {
  return Boolean(win && typeof win.inputItem === 'function')
}

function furnaceSummary(win, registry) {
  const fmt = (it) => (it ? formatItem(it, registry) : null)
  return {
    type: 'furnace',
    input: fmt(win.inputItem?.()),
    fuel: fmt(win.fuelItem?.()),
    output: fmt(win.outputItem?.()),
    progress_seconds: win.progressSeconds ?? null,
    fuel_seconds: win.fuelSeconds ?? null,
    hint: '放原料: container(deposit, item=..., slot="input"); 放燃料: slot="fuel"(不指定会自动判断——煤/木类进燃料槽); 取产物: withdraw。',
  }
}

function listContainerItems(win, registry) {
  try {
    const out = []
    const start = win.inventoryStart ?? 0
    if (Array.isArray(win.slots)) {
      // 带格子序号(菜单点击需要); 只列容器区(不含玩家背包区)
      win.slots.forEach((it, i) => {
        if (it && i < start) out.push({ ...formatItem(it, registry), slot: i })
      })
      return out
    }
  } catch { /* ignore */ }
  try {
    return (win.containerItems?.() ?? win.items()).map((it) => formatItem(it, registry))
  } catch {
    return []
  }
}

export async function containerTool(bot, args) {
  const action = args.action ?? 'list'
  const registry = bot.registry
  // 每个 bot 只初始化一次 stateId 跟踪
  if (!bot._menuStateTracked) {
    bot._menuStateTracked = true
    trackMenuStateId(bot)
  }

  if (action === 'open') {
    const coords = coordsOrNull(args)
    let block
    if (coords) {
      const v = new Vec3(coords.x, coords.y, coords.z)
      const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
      const dist = eye.distanceTo(v.offset(0.5, 0.5, 0.5))
      if (dist > REACH) throw new Error(`距离 ${round1(dist)} 格超出触及范围(${REACH}), 请先走到容器旁。`)
      block = bot.blockAt(v, true)
      if (!block) throw new Error('该位置区块未加载。')
    } else {
      block = sightBlock(bot)
      if (!block) throw new Error('视线内没有指向容器, 请提供 x/y/z 坐标。')
    }
    if (state.containerWindow) {
      try { state.containerWindow.close() } catch { /* ignore */ }
      state.containerWindow = null
    }
    // 熔炉类: 用 openFurnace(putInput/putFuel API, 与箱子完全不同)
    if (FURNACE_BLOCKS.test(block.name)) {
      const furnace = await bot.openFurnace(block)
      state.containerWindow = furnace
      const summary = furnaceSummary(furnace, registry)
      return {
        opened: block.name,
        position: fmtPos(block.position),
        ...summary,
      }
    }
    const win = await bot.openContainer(block)
    state.containerWindow = win
    const items = listContainerItems(win, registry)
    return {
      opened: block.name,
      position: fmtPos(block.position),
      slots_used: items.length,
      contents: items,
      hint: '接着用 deposit(放入)/withdraw(取出)/close(关闭)。',
    }
  }

  const win = state.containerWindow
  if (!win) throw new Error('还没有打开的容器, 先 container(action="open")。')

  // 熔炉窗口分支: putInput/putFuel/takeOutput(没有箱子的 deposit/withdraw)
  if (isFurnaceWindow(win)) {
    if (action === 'list') return furnaceSummary(win, registry)
    if (action === 'deposit') {
      if (!args.item) throw new Error('deposit 需要 item。')
      const items = findInvItems(bot, String(args.item))
      if (!items.length) throw new Error(`背包里没有「${args.item}」。`)
      const total = items.reduce((s, it) => s + it.count, 0)
      const want = Math.min(total, args.count ? Math.floor(Number(args.count)) : total)
      const dest = String(args.slot || (FUEL_NAMES.test(items[0].name) ? 'fuel' : 'input'))
      if (dest !== 'input' && dest !== 'fuel') throw new Error('熔炉的 slot 只能是 "input"(原料) 或 "fuel"(燃料)。')
      let moved = 0
      for (const it of items) {
        if (moved >= want) break
        const n = Math.min(want - moved, it.count)
        if (dest === 'fuel') await win.putFuel(it.type, it.metadata ?? null, n)
        else await win.putInput(it.type, it.metadata ?? null, n)
        moved += n
      }
      return {
        deposited: items[0].name,
        into: dest === 'fuel' ? '燃料槽' : '原料槽',
        requested: want,
        count: moved,
        furnace: furnaceSummary(win, registry),
        note: '已放入熔炉; 烧好后用 container(action="withdraw") 取产物。',
      }
    }
    if (action === 'withdraw') {
      const which = String(args.slot || 'output')
      let took = null
      if (which === 'output') took = await win.takeOutput()
      else if (which === 'input') took = await win.takeInput()
      else if (which === 'fuel') took = await win.takeFuel()
      else throw new Error('熔炉的 slot 只能是 "output"(产物, 默认)/"input"/"fuel"。')
      return {
        withdrew: took ? took.name : null,
        count: took?.count ?? 0,
        furnace: furnaceSummary(win, registry),
        note: took ? '已取出。' : '该槽位是空的。',
      }
    }
    if (action === 'click') throw new Error('熔炉窗口不支持按格子点击, 用 deposit/withdraw 操作。')
    // close 走下面的通用分支
  }

  if (action === 'list') {
    const items = listContainerItems(win, registry)
    return {
      slots_used: items.length,
      contents: items,
      hint: items.length && items[0].slot != null ? '点击选项: container(action="click", slot=N)' : undefined,
    }
  }

  if (action === 'click') {
    const slot = Math.floor(Number(args.slot))
    if (!Number.isFinite(slot)) throw new Error('click 需要 slot(格子序号, 见 list/contents 里的 slot 字段, 从 0 开始)。')
    const button = args.button === 1 ? 1 : 0
    // 优先用原始 window_click 包(插件菜单 stateId 可靠); 确认失败再 fallback mineflayer clickWindow
    let clicked = false
    try {
      clicked = await rawClickMenuSlot(bot, win.id, slot, button, 0)
    } catch { /* ignore */ }
    if (!clicked) {
      try {
        await bot.clickWindow(slot, button, 0)
        clicked = true
      } catch (err) {
        throw new Error(`点击格子 ${slot} 失败: ${String(err?.message || err)}`)
      }
    }
    await sleep(500)
    // 点击后窗口可能: 刷新内容 / 被服务器替换成新窗口(子菜单) / 被关闭。
    // 用 state.containerWindow(可能已被 windowOpen 事件更新为新窗口)读当前内容。
    let after = null
    const cur = state.containerWindow
    if (cur) {
      try {
        after = {
          title: cur.title ? decodeText(cur.title) : null, // title 是 NBT/component, 用 decodeText 解析
          contents: listContainerItems(cur, registry),
        }
      } catch { /* ignore */ }
    }
    const isNew = cur && cur !== win
    return {
      clicked_slot: slot,
      button,
      contents_after: after,
      window_changed: isNew || undefined, // true = 点击后打开了新窗口(子菜单)
      note: isNew
        ? '已点击, 服务器打开了新的子菜单窗口(见上面 contents_after / 新 window_open 事件), 继续用 container(action="click", slot=N) 操作。'
        : after
          ? '已点击, 上面是点击后的窗口内容(可能刷新了)。'
          : '已点击; 窗口已被关闭(可能是确认了选项/取消了菜单), 反馈注意 new_events(action_bar/chat)。',
    }
  }

  if (action === 'deposit') {
    if (!args.item) throw new Error('deposit 需要 item(要从背包放进容器的物品名)。')
    const items = findInvItems(bot, String(args.item))
    if (!items.length) throw new Error(`背包里没有「${args.item}」。`)
    const total = items.reduce((s, it) => s + it.count, 0)
    const want = Math.min(total, args.count ? Math.floor(Number(args.count)) : total)
    let moved = 0
    for (const it of items) {
      if (moved >= want) break
      const need = want - moved
      await win.deposit(it.type, it.metadata ?? null, need)
      moved += need
    }
    // 存放记忆: "我在哪存了什么" —— AI 常忘记存过东西/放在哪, 记下来供 recall/快照用
    try {
      const where = win.window?.position ? fmtPos(win.window.position) : null
      const key = `存放:${items[0].name}`
      const text = `我在 ${where ? `(${where.x}, ${where.y}, ${where.z})` : '容器'} 存放了 ${items[0].name} ×${moved} —— ${new Date().toLocaleString('zh-CN')}`
      saveMemory(currentNs(), { key, text, tags: ['存放记录', items[0].name] })
      return { deposited: items[0].name, requested: want, count: moved, memory_saved: key }
    } catch {
      return { deposited: items[0].name, requested: want, count: moved }
    }
  }

  if (action === 'withdraw') {
    if (!args.item) throw new Error('withdraw 需要 item(要从容器取出的物品名)。')
    // 复用归一化匹配(大小写/minecraft: 前缀/空格)
    const items = findInvItems({ inventory: { items: () => win.containerItems?.() ?? win.items() } }, String(args.item))
    if (!items.length) {
      // 当前容器没有: 提示之前在哪存过(防 AI 开错箱子/忘了存在哪)
      let hint = ''
      try {
        const stored = recallMemories(currentNs(), String(args.item))
          .filter((m) => m.key?.startsWith('存放:'))
        if (stored.length) hint = ` 你之前存过: ${stored[0].text}`
      } catch { /* ignore */ }
      throw new Error(`这个容器里没有「${args.item}」。可用 container(action="list") 查看本箱; ${hint || '去别处找找(或 memory recall 查存放记录)。'}`)
    }
    const total = items.reduce((s, it) => s + it.count, 0)
    const want = Math.min(total, args.count ? Math.floor(Number(args.count)) : total)
    let moved = 0
    for (const it of items) {
      if (moved >= want) break
      const need = want - moved
      await win.withdraw(it.type, it.metadata ?? null, need)
      moved += need
    }
    return { withdrew: items[0].name, requested: want, count: moved }
  }

  if (action === 'close') {
    win.close()
    state.containerWindow = null
    return { closed: true }
  }

  throw new Error(`未知 action: ${action}`)
}

// ---- 村民交易 ----
function summarizeTrades(v) {  try {
    return (v.trades ?? []).map((t, i) => ({
      index: i,
      input: [t.inputItem1, t.inputItem2]
        .filter(Boolean)
        .map((it) => `${it.name} ×${it.count ?? 1}`),
      output: t.outputItem ? `${t.outputItem.name} ×${t.outputItem.count ?? 1}` : null,
      disabled: Boolean(t.disabled ?? t.tradeDisabled),
    }))
  } catch {
    return []
  }
}

export async function villagerTool(bot, args) {
  const action = args.action ?? 'list'
  const targetName = String(args.target || 'villager')
  const entity = resolveEntity(bot, targetName)
  if (!entity) throw new Error(`找不到村民「${targetName}」(可用 nearby 查看)。`)
  const d = bot.entity.position.distanceTo(entity.position)
  if (d > ENTITY_REACH) throw new Error(`村民距离 ${round1(d)} 格, 需要 ≤${ENTITY_REACH} 格, 请先靠近。`)

  const v = await bot.openVillager(entity)
  try {
    if (action === 'trade') {
      const idx = Math.max(0, Math.floor(Number(args.trade_index ?? 0)))
      const count = Math.max(1, Math.floor(Number(args.count ?? 1)))
      if (typeof v.trade === 'function') await v.trade(idx, count)
      else if (typeof v.selectTrade === 'function') v.selectTrade(idx)
      else throw new Error('当前 mineflayer 版本不支持自动交易, 可先 list 查看交易表。')
      return { traded: { index: idx, count }, trades: summarizeTrades(v) }
    }
    return { villager: entity.name, trades: summarizeTrades(v), hint: '用 trade + trade_index 交易' }
  } finally {
    try { v.close() } catch { /* ignore */ }
  }
}

// ---- 原地起柱(脚下往上搭) ----
// 原生执行"跳跃→空中向脚下放置→落地"循环, 每块带重试与头顶空间检查
function waitFor(bot, cond, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      let ok = false
      try { ok = cond() } catch { /* ignore */ }
      if (ok) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 25)
  })
}

export async function pillarUp(bot, height, task) {
  const reg = bot.registry

  // 手持方块
  if (!isBlockItem(bot.heldItem, reg)) {
    const cand = bot.inventory.items().find((it) => isBlockItem(it, reg))
    if (!cand) throw new Error('物品栏里没有可放置的方块。')
    await bot.equip(cand, 'hand')
  }
  const blockName = bot.heldItem.name
  // inventory.items() 通常已包含手持物品(快捷栏), 不要重复计数
  const pool = bot.inventory.items()
  const available = pool.filter((it) => it.name === blockName).reduce((s, it) => s + it.count, 0)
    || (bot.heldItem?.name === blockName ? bot.heldItem.count : 0)
  const want = Math.max(1, Math.floor(Number(height) || 1))
  const n = Math.min(want, available)
  if (n < 1) throw new Error(`「${blockName}」数量不足(0 个)。`)

  const startY = Math.floor(bot.entity.position.y)
  let placed = 0
  let stoppedReason = null
  let note = null

  try {
    for (let i = 0; i < n; i++) {
      if (task?.cancelled) { stoppedReason = 'stopped_by_user'; break }
      const pos = bot.entity.position
      const fx = Math.floor(pos.x)
      const fy = Math.floor(pos.y)
      const fz = Math.floor(pos.z)

      // 头顶空间: 跳起后头部约到 fy+3, 不够就停(防止把自己闷死)
      for (const dy of [2, 3]) {
        const above = bot.blockAt(new Vec3(fx, fy + dy, fz))
        if (above && above.boundingBox !== 'empty') {
          stoppedReason = 'headroom'
          note = `头顶 ${dy} 格处有「${above.name}」, 继续搭会卡住/窒息。`
          break
        }
      }
      if (stoppedReason) break

      // 脚下必须有支撑(起柱的前提)
      const below = bot.blockAt(new Vec3(fx, fy - 1, fz))
      if (!below || below.boundingBox === 'empty') {
        stoppedReason = 'no_support'
        note = '脚下没有支撑方块(悬空?), 无法起柱。'
        break
      }

      let ok = false
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (task?.cancelled) break
        bot.setControlState('jump', true)
        const rose = await waitFor(bot, () => bot.entity.position.y - fy >= 0.9, 800)
        if (rose) {
          try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch { /* 重试 */ }
          bot.setControlState('jump', false)
          await waitFor(bot, () => bot.entity.onGround, 2500)
          const at = bot.blockAt(new Vec3(fx, fy, fz))
          if (at && at.boundingBox !== 'empty') {
            ok = true
            placed += 1
          }
        } else {
          bot.setControlState('jump', false)
          await sleep(400)
        }
      }
      if (!ok) {
        stoppedReason = 'place_failed'
        note = '多次尝试放置失败(可能被服务器拒绝或位置受限)。'
        break
      }
    }
  } finally {
    bot.setControlState('jump', false)
  }

  return {
    blocks_placed: placed,
    requested: want,
    used: blockName,
    from_y: startY,
    to_y: Math.floor(bot.entity.position.y),
    position: fmtPos(bot.entity.position),
    stopped_reason: stoppedReason,
    note: note ?? `已站在柱顶(升高 ${placed} 格)。下来可以跳落(注意摔伤)或 goto; 也可以继续 pillar。`,
  }
}
