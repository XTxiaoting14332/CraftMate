import Vec3 from 'vec3'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function fmtPos(p) {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

export function vecOfCoords(coords) {
  return new Vec3(Math.floor(coords.x), Math.floor(coords.y), Math.floor(coords.z))
}

export function round1(n) {
  return Math.round(n * 10) / 10
}

// Minecraft 朝向: yaw=0 朝南(+Z), 90° 朝西(-X), 180° 朝北(-Z), 270° 朝东(+X)
export function facingOf(yaw) {
  const TWO_PI = Math.PI * 2
  const a = ((yaw % TWO_PI) + TWO_PI) % TWO_PI
  const i = Math.round(a / (Math.PI / 2)) % 4
  return ['南(+Z)', '西(-X)', '北(-Z)', '东(+X)'][i]
}

// 两点间的相对方位(按 Minecraft 坐标: +Z 为南, +X 为东)
export function directionBetween(from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.1) return '正下方/重叠'
  const yaw = Math.atan2(-dx, dz) // 与游戏内朝向同系
  const TWO_PI = Math.PI * 2
  const a = ((yaw % TWO_PI) + TWO_PI) % TWO_PI
  const i = Math.round(a / (Math.PI / 2)) % 4
  const dir = ['南', '西', '北', '东'][i]
  const dy = to.y - from.y
  const vert = Math.abs(dy) >= 3 ? (dy > 0 ? ' 上方' : ' 下方') : ''
  return `${dir}${vert} ${Math.round(dist)} 格`
}

// 空间锚定: 用最近的路标/放置记录回答"我在哪"
// 返回最近地标名称与距离, 没有则 null
export function nearestLandmark(position, landmarks) {
  if (!position || !landmarks?.length) return null
  let best = null
  let bestDist = Infinity
  for (const lm of landmarks) {
    const p = lm.position
    if (!p || typeof p.x !== 'number') continue
    const d = Math.hypot(p.x - position.x, p.z - position.z)
    if (d < bestDist) {
      bestDist = d
      best = lm
    }
  }
  return best ? { name: lmName(best), distance: Math.round(bestDist), ...best } : null
}

function lmName(lm) {
  if (lm.name) return lm.name
  const t = lm.text ?? ''
  const m = /(?:放置|建造|我在)\s*(?:了)?\s*([^\s,，。]+)/.exec(t)
  return m?.[1] ?? '某处'
}

export function timeLabelOfTicks(t) {
  if (t == null) return null
  if (t < 1000) return '清晨'
  if (t < 11000) return '白天'
  if (t < 13000) return '日落'
  if (t < 22500) return '夜晚'
  return '日出'
}

// ---- 拟人转头: 在 durationMs 内逐步转向(缓入缓出), 而非瞬间吸附 ----
export async function smoothLookAngles(bot, yaw, pitch, durationMs = 300) {
  const startYaw = bot.entity.yaw
  const startPitch = bot.entity.pitch
  let dYaw = (yaw - startYaw) % (Math.PI * 2)
  if (dYaw > Math.PI) dYaw -= Math.PI * 2
  if (dYaw < -Math.PI) dYaw += Math.PI * 2
  const steps = Math.max(1, Math.min(10, Math.floor(durationMs / 50)))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    try {
      bot.look(startYaw + dYaw * ease, startPitch + (pitch - startPitch) * ease)
    } catch {
      return
    }
    if (i < steps) await sleep(50)
  }
}

// 平滑看向空间某点(自动换算 yaw/pitch)
export async function smoothLook(bot, point, durationMs = 300) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.6, 0)
  const d = point.minus(eye)
  const yaw = Math.atan2(-d.x, d.z)
  const pitch = Math.atan2(-d.y, Math.hypot(d.x, d.z))
  await smoothLookAngles(bot, yaw, pitch, durationMs)
}

// 瞄准偏移(拟人): 人不是狙击枪, 视线落点带随机误差; 不影响攻击命中(命中按距离判定)
export function aimJitter(point, amount = 0.25) {
  const r = () => (Math.random() - 0.5) * 2 * amount
  return point.offset(r(), r() * 0.6, r())
}

// 反应时间(拟人): 人从"看到"到"动手"有 150~400ms 延迟, 完美反应反而是机器人特征
export function reactionDelayMs() {
  return 150 + Math.random() * 250
}
