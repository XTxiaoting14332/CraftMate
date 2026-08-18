// 光照感知 + 自动放火把(反射): 黑暗处自动点亮, 不经过模型
// 光照来源: 区块光照数据(getBlockLight/getSkyLight), 夜晚天空光按暗化系数折减
import Vec3 from 'vec3'
import { state, pushEvent } from './bot.js'
import { sleep } from './util.js'

const CHECK_MS = 2500
const COOLDOWN_MS = 8000
const LIGHT_ITEMS = ['torch', 'soul_torch', 'lantern', 'soul_lantern', 'glowstone', 'shroomlight', 'ochre_froglight', 'sea_lantern']
const DARK_AT = 7 // 低于此等级算黑暗(刷怪阈值附近)

let timer = null
let botRef = null
let lastPlaceAt = 0
let lastFailAt = 0

// 夜晚天空光暗化(粗略: 夜间-11, 黄昏/黎明-8, 白天 0)
function skyDarkening(bot) {
  const t = bot.time?.timeOfDay ?? 0
  if (t >= 13000 && t < 22000) return 11
  if (t >= 12000 && t < 13000) return 8
  if (t >= 22000 && t < 23000) return 8
  return 0
}

// 读取脚所在位置的有效光照: max(方块光, 天空光-暗化); 读不到返回 null
export function currentLight(bot) {
  const p = bot.entity.position
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  const z = Math.floor(p.z)
  // 优先 blockAt: 版本适配由 mineflayer 内部处理, 且能拿到已加载区块的真实光照;
  // 某些服务器/版本 getColumn 的光照 section 可能为空(返回 0 而非 null), 会误判为黑暗。
  try {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && Number.isFinite(b.light)) return Math.max(b.light ?? 0, (b.skyLight ?? 0) - skyDarkening(bot))
  } catch { /* ignore */ }
  try {
    const col = bot.world?.getColumn?.(Math.floor(x / 16), Math.floor(z / 16))
    if (col && typeof col.getBlockLight === 'function') {
      const blockLight = col.getBlockLight(x & 15, y, z & 15)
      const skyLight = typeof col.getSkyLight === 'function' ? col.getSkyLight(x & 15, y, z & 15) : 0
      if (blockLight || skyLight) return Math.max(blockLight ?? 0, (skyLight ?? 0) - skyDarkening(bot))
    }
  } catch { /* ignore */ }
  return null
}

export function lightLabel(level) {
  if (level == null) return null
  if (level < DARK_AT) return '暗'
  if (level < 11) return '昏暗'
  return '明亮'
}

// 找一个放火把的位置: 优先脚下的相邻空位(地板火把), 其次贴墙
function pickTorchSpot(bot) {
  const feet = bot.entity.position.floored()
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  const candidates = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    candidates.push(feet.offset(dx, 0, dz)) // 同层空位, 下方是实体方块 → 立地火把
  }
  for (const c of candidates) {
    if (eye.distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.2) continue
    const air = bot.blockAt(c)
    if (!air || air.boundingBox !== 'empty') continue
    const below = bot.blockAt(c.offset(0, -1, 0))
    if (below && below.boundingBox === 'block') {
      return { ref: below, face: new Vec3(0, 1, 0), target: c }
    }
  }
  return null
}

// 空闲时自动放火把(黑暗 + 有光源物品 + 无任务/战斗/开窗)
async function maybePlaceTorch(bot) {
  if (Date.now() - lastPlaceAt < COOLDOWN_MS) return
  if (Date.now() - lastFailAt < COOLDOWN_MS) return
  if (state.defense?.active || state.task || state.containerWindow) return
  if (!bot.entity || bot.health <= 0 || !bot.entity.onGround) return

  const level = currentLight(bot)
  if (level == null || level >= DARK_AT) return

  const item = bot.inventory.items().find((it) => LIGHT_ITEMS.includes(it.name))
  if (!item) return

  const spot = pickTorchSpot(bot)
  if (!spot) { lastFailAt = Date.now(); return }

  try {
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand')
    await bot.placeBlock(spot.ref, spot.face)
    lastPlaceAt = Date.now()
    pushEvent('auto_torch', {
      item: item.name,
      position: { x: spot.target.x, y: spot.target.y, z: spot.target.z },
      note: '你顺手在黑暗处放了个光源(本能)',
    })
  } catch {
    lastFailAt = Date.now()
  }
}

export function startLighting(bot, opts = {}) {
  stopLighting()
  botRef = bot
  if (opts.enabled === false) return
  timer = setInterval(() => {
    if (state.bot !== botRef) { stopLighting(); return }
    void maybePlaceTorch(botRef)
  }, CHECK_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopLighting() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  botRef = null
  // 冷却时间不重置: 防止快速 stop/start 绕过放置间隔
}
