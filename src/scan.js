// 地形扫描: 生成"心智地图" —— 高度图网格 + 表面构成 + 生物群系 + 四向地势/危险 + 深坑检测
// 读取的是已加载区块的方块数据, 只读不改, 不需要额外权限
import Vec3 from 'vec3'

const CHARS = '0123456789abcdefghijklmnopqrstuvwxyz' // 36 档相对高度: -20..+15
const TOP_SCAN = 14 // 从脚下向上扫的格数
const BOTTOM_SCAN = 20 // 从脚下向下扫的格数

// 单列扫描: 从上往下找第一个表面(实心方块/水面/岩浆面)
function scanColumn(bot, x, by, z) {
  let seenLoaded = false
  for (let y = by + TOP_SCAN; y >= by - BOTTOM_SCAN; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) {
      // 上方超出加载范围当作空气; 中途出现空洞视为未知
      if (seenLoaded) return { unknown: true, d: null, special: null, surface: null }
      continue
    }
    seenLoaded = true
    if (b.name === 'water') return { unknown: false, d: y - by, special: 'water', surface: 'water' }
    if (b.name === 'lava') return { unknown: false, d: y - by, special: 'lava', surface: 'lava' }
    if (b.boundingBox !== 'empty') {
      const isTree = /_log$/.test(b.name) || /_leaves$/.test(b.name) || b.name === 'bamboo'
      return { unknown: false, d: y - by, special: isTree ? 'tree' : null, surface: b.name }
    }
  }
  return { unknown: true, d: null, special: null, surface: null }
}

function heightChar(relD) {
  const idx = Math.max(0, Math.min(CHARS.length - 1, relD + 20))
  return CHARS[idx]
}

function stripStats(columns) {
  const known = columns.filter((c) => !c.unknown && c.d != null)
  if (!known.length) return { avg_delta: null, min_delta: null, max_delta: null, water: 0, lava: 0, trees: 0, known_columns: 0 }
  const ds = known.map((c) => c.d)
  return {
    avg_delta: Math.round((ds.reduce((s, v) => s + v, 0) / ds.length) * 10) / 10,
    min_delta: Math.min(...ds),
    max_delta: Math.max(...ds),
    water: known.filter((c) => c.special === 'water').length,
    lava: known.filter((c) => c.special === 'lava').length,
    trees: known.filter((c) => c.special === 'tree').length,
    known_columns: known.length,
  }
}

export function scanTerrain(bot, radius = 12) {
  const r = Math.min(24, Math.max(4, Math.floor(Number(radius) || 12)))
  const pos = bot.entity.position
  const bx = Math.floor(pos.x)
  const by = Math.floor(pos.y)
  const bz = Math.floor(pos.z)
  const size = r * 2 + 1

  // 逐列扫描 (行 = Z 从北到南, 列 = X 从西到东)
  const rows = []
  const surfaceCounts = new Map()
  let water = 0
  let lava = 0
  let trees = 0
  let unknown = 0
  const columns = []
  for (let dz = -r; dz <= r; dz++) {
    const row = []
    for (let dx = -r; dx <= r; dx++) {
      const col = scanColumn(bot, bx + dx, by, bz + dz)
      col.dx = dx
      col.dz = dz
      columns.push(col)
      if (col.unknown) unknown++
      else if (col.special === 'water') water++
      else if (col.special === 'lava') lava++
      else if (col.special === 'tree') trees++
      if (col.surface) surfaceCounts.set(col.surface, (surfaceCounts.get(col.surface) ?? 0) + 1)
      row.push(col)
    }
    rows.push(row)
  }

  // 以机器人脚下所在列的表面为基准(平地 = 0)
  const baseCol = rows[r][r]
  const baseD = baseCol?.d ?? -1

  // 生成字符网格
  const grid = rows.map((row, ri) => {
    let line = ''
    for (let ci = 0; ci < row.length; ci++) {
      if (ri === r && ci === r) {
        line += '*'
        continue
      }
      const c = row[ci]
      if (c.unknown) line += '?'
      else if (c.special === 'water') line += '~'
      else if (c.special === 'lava') line += '!'
      else if (c.special === 'tree') line += '@'
      else line += heightChar(c.d - baseD)
    }
    return line
  })

  // 表面构成
  const totalKnown = columns.length - unknown
  const surface = [...surfaceCounts.entries()]
    .map(([name, count]) => ({ name, count, percent: totalKnown ? Math.round((count / totalKnown) * 100) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)

  // 四向摘要(取边缘 3 列/行)
  const flat = rows.flat()
  const dirs = [
    { direction: '北(-Z)', strip: flat.filter((c) => c.dz <= -r + 2) },
    { direction: '东(+X)', strip: flat.filter((c) => c.dx >= r - 2) },
    { direction: '南(+Z)', strip: flat.filter((c) => c.dz >= r - 2) },
    { direction: '西(-X)', strip: flat.filter((c) => c.dx <= -r + 2) },
  ].map(({ direction, strip }) => {
    const s = stripStats(strip)
    const notes = []
    if (s.min_delta != null && s.min_delta - baseD <= -4) notes.push(`有悬崖/深谷(最深 ${-(s.min_delta - baseD)} 格)`)
    if (s.max_delta != null && s.max_delta - baseD >= 4) notes.push(`地势明显升高(最高 +${s.max_delta - baseD} 格)`)
    if (s.water >= 4) notes.push('有水域')
    if (s.lava > 0) notes.push('有岩浆!')
    const avg = s.avg_delta != null ? Math.round((s.avg_delta - baseD) * 10) / 10 : null
    if (avg != null && avg >= 2) notes.push('整体偏高')
    if (avg != null && avg <= -2) notes.push('整体偏低')
    return { direction, avg_delta: avg, min_delta: s.min_delta != null ? s.min_delta - baseD : null, max_delta: s.max_delta != null ? s.max_delta - baseD : null, water_columns: s.water, lava_columns: s.lava, tree_columns: s.trees, note: notes.join('; ') || '地势平缓' }
  })

  // 深坑/可能的洞口: 相对基准低 8 格以上
  const pits = columns.filter((c) => !c.unknown && c.d != null && c.d - baseD <= -8)
  pits.sort((a, b) => Math.abs(a.dx) + Math.abs(a.dz) - Math.abs(b.dx) - Math.abs(b.dz))

  let biome = null
  try {
    biome = bot.blockAt(new Vec3(bx, by - 1, bz))?.biome?.name
      ?? bot.blockAt(new Vec3(bx, by, bz))?.biome?.name
      ?? null
  } catch { /* ignore */ }
  let dimension = null
  try { dimension = bot.game?.dimension ?? null } catch { /* ignore */ }

  return {
    center: { x: bx, y: by, z: bz },
    radius: r,
    size,
    biome,
    dimension,
    grid,
    legend: {
      map: '行=Z(上=北-z, 下=南+z), 列=X(左=西-x, 右=东+x), *=你的位置',
      height: '高度字符是相对你脚下平地的海拔: k=同高, 每相差1字符=1格(l=高1格, j=低1格), 0=低20格, y=高15格(超出会截断)',
      special: '?=未加载 ~ =水面 !=岩浆 @=树',
    },
    surface_composition: surface,
    trees,
    water_columns: water,
    lava_columns: lava,
    unknown_columns: unknown,
    directions: dirs,
    deep_pits: {
      count: pits.length,
      nearest: pits.length
        ? {
            position: { x: bx + pits[0].dx, y: by + pits[0].d, z: bz + pits[0].dz },
            depth: -(pits[0].d - baseD),
            note: '深坑/可能的洞口, 可 goto 到附近查看(注意坠落伤害)',
          }
        : null,
    },
  }
}
