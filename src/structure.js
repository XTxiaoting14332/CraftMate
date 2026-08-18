// 建筑识别(无视觉): 用"材料签名 + 几何规则性"判断区域是否为人造结构
// 原理类似考古学: 1) 人造方块(木板/玻璃/砖/门/火把...)几乎不可能自然生成;
// 2) 人造物有规则几何 —— 屋顶/地板平面、跨层连续墙面、封闭房间空腔、高塔柱体。
// 拟真模式(fair): 先洪泛出"连通外界"的空气, 只统计看得见的方块(其余当作石头),
// 并抑制完全埋于地下的封闭空间 —— 防止探测出埋藏的隐藏基地。
import Vec3 from 'vec3'

const MAN_MADE_PATTERNS = [
  /^polished_/, /^smooth_/, /^cut_/, /^chiseled_/, /^carved_/, /^stripped_/, /^glazed_/,
  /_planks$/, /_stairs$/, /_slab$/, /_door$/, /_fence$/, /_fence_gate$/, /_wall$/,
  /_wool$/, /_carpet$/, /_concrete$/, /_concrete_powder$/, /_terracotta$/, /_bricks$/,
]
const MAN_MADE_NAMES = new Set([
  'glass', 'glass_pane', 'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'campfire', 'soul_campfire',
  'torch', 'wall_torch', 'lantern', 'soul_lantern', 'sea_lantern', 'shroomlight',
  'bookshelf', 'chiseled_bookshelf', 'lectern', 'ladder', 'bed',
  'cobblestone', 'mossy_cobblestone', 'stone_bricks',
  'quartz_block', 'quartz_pillar', 'purpur_block',
  'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'cauldron',
  'brewing_stand', 'hopper', 'dispenser', 'dropper', 'observer', 'piston', 'sticky_piston',
  'redstone_lamp', 'lever', 'redstone_torch', 'redstone_wire', 'repeater', 'comparator',
  'note_block', 'jukebox', 'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'glowstone', 'jack_o_lantern', 'item_frame', 'glow_item_frame', 'flower_pot',
  'bell', 'grindstone', 'stonecutter', 'loom', 'cartography_table', 'fletching_table',
  'smithing_table', 'composter', 'scaffolding', 'hay_block', 'farmland', 'dirt_path',
  'candle', 'chain', 'iron_bars', 'spawner', 'end_portal_frame', 'sponge', 'wet_sponge',
  'packed_mud', 'mud_brick', // hmm: mud 自然, packed_mud 是合成
])
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])
const LIQUID_NAMES = new Set(['water', 'lava'])

// 网格值: 0=空气 1=自然实心 2=人造实心 3=液体 4=未知(未加载)
function classifyName(name) {
  if (!name) return 4
  if (AIR_NAMES.has(name)) return 0
  if (LIQUID_NAMES.has(name)) return 3
  if (MAN_MADE_NAMES.has(name) || MAN_MADE_PATTERNS.some((re) => re.test(name))) return 2
  return 1
}

const DIRS6 = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

export function analyzeStructure(bot, opts = {}) {
  const pos = bot.entity.position
  const bx = Math.floor(pos.x)
  const by = Math.floor(pos.y)
  const bz = Math.floor(pos.z)
  const fairOnly = opts.fairOnly !== false

  const r = Math.min(16, Math.max(3, Math.floor(Number(opts.radius) || 10)))
  const sy = Math.min(24, Math.max(6, Math.floor(Number(opts.height) || 16)))
  const cx = Number.isFinite(Number(opts.x)) ? Math.floor(Number(opts.x)) : bx
  let cy = Number.isFinite(Number(opts.y)) ? Math.floor(Number(opts.y)) : by
  const cz = Number.isFinite(Number(opts.z)) ? Math.floor(Number(opts.z)) : bz
  if (fairOnly) cy = Math.min(by + 8, Math.max(by - 8, cy)) // 拟真: 只分析自己附近的高度
  const y0 = cy - 4
  const sx = r * 2 + 1
  const sz = r * 2 + 1
  const total = sx * sz * sy

  // ---- 第一遍: 读入网格 + 名称 ----
  const grid = new Int8Array(total)
  const names = new Array(total).fill(null)
  let unknown = 0
  for (let yi = 0; yi < sy; yi++) {
    for (let zi = 0; zi < sz; zi++) {
      for (let xi = 0; xi < sx; xi++) {
        const b = bot.blockAt(new Vec3(cx - r + xi, y0 + yi, cz - r + zi))
        const idx = (yi * sz + zi) * sx + xi
        if (!b) {
          grid[idx] = 4
          unknown++
          continue
        }
        grid[idx] = classifyName(b.name)
        names[idx] = b.name
      }
    }
  }
  const idxOf = (yi, zi, xi) => (yi * sz + zi) * sx + xi
  const solid = (v) => v === 1 || v === 2

  // ---- 洪泛: 标记"连通到区域外界"的空气 ----
  const outside = new Uint8Array(total)
  const stack = []
  const pushIfOpenAir = (yi, zi, xi) => {
    const i = idxOf(yi, zi, xi)
    if (!outside[i] && grid[i] === 0) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let yi = 0; yi < sy; yi++) {
    for (let zi = 0; zi < sz; zi++) {
      pushIfOpenAir(yi, zi, 0)
      pushIfOpenAir(yi, zi, sx - 1)
    }
    for (let xi = 0; xi < sx; xi++) {
      pushIfOpenAir(yi, 0, xi)
      pushIfOpenAir(yi, sz - 1, xi)
    }
  }
  // 只有顶面和侧面算"外界"入口; 底面切开的是地下岩层, 贴底面的空气不是开放空间
  for (let xi = 0; xi < sx; xi++) {
    for (let zi = 0; zi < sz; zi++) {
      pushIfOpenAir(sy - 1, zi, xi)
    }
  }
  while (stack.length) {
    const i = stack.pop()
    const yi = Math.floor(i / (sz * sx))
    const rem = i % (sz * sx)
    const zi = Math.floor(rem / sx)
    const xi = rem % sx
    for (const [dy, dz, dx] of DIRS6) {
      const ny = yi + dy
      const nz = zi + dz
      const nx = xi + dx
      if (ny < 0 || ny >= sy || nz < 0 || nz >= sz || nx < 0 || nx >= sx) continue
      pushIfOpenAir(ny, nz, nx)
    }
  }

  // ---- 拟真遮罩: 看不见的人造方块当作石头 ----
  let eff = grid
  let masked = 0
  if (fairOnly) {
    // 每列地表(最上层实心/液体)
    const surface = new Int16Array(sx * sz).fill(-1)
    for (let yi = sy - 1; yi >= 0; yi--) {
      for (let zi = 0; zi < sz; zi++) {
        for (let xi = 0; xi < sx; xi++) {
          const sIdx = zi * sx + xi
          if (surface[sIdx] < 0 && grid[idxOf(yi, zi, xi)] !== 0 && grid[idxOf(yi, zi, xi)] !== 4) {
            surface[sIdx] = yi
          }
        }
      }
    }
    eff = Int8Array.from(grid)
    for (let yi = 0; yi < sy; yi++) {
      for (let zi = 0; zi < sz; zi++) {
        for (let xi = 0; xi < sx; xi++) {
          const i = idxOf(yi, zi, xi)
          if (grid[i] !== 2) continue
          const atOrAboveSurface = yi >= surface[zi * sx + xi]
          let visible = atOrAboveSurface
          if (!visible) {
            for (const [dy, dz, dx] of DIRS6) {
              const ny = yi + dy
              const nz = zi + dz
              const nx = xi + dx
              if (ny < 0 || ny >= sy || nz < 0 || nz >= sz || nx < 0 || nx >= sx) {
                visible = true // 紧贴区域边界, 保守视为可见
                break
              }
              if (outside[idxOf(ny, nz, nx)]) {
                visible = true
                break
              }
            }
          }
          if (!visible) {
            eff[i] = 1
            masked++
          }
        }
      }
    }
  }

  // ---- 统计(基于有效网格) ----
  let man = 0
  let natSolid = 0
  let airCells = 0
  let liquidCells = 0
  const nameCount = new Map()
  for (let i = 0; i < total; i++) {
    const v = eff[i]
    if (v === 2) {
      man++
      nameCount.set(names[i], (nameCount.get(names[i]) ?? 0) + 1)
    } else if (v === 1) natSolid++
    else if (v === 0) airCells++
    else if (v === 3) liquidCells++
  }

  const countLayer = (yi, pred) => {
    let n = 0
    for (let zi = 0; zi < sz; zi++) {
      for (let xi = 0; xi < sx; xi++) {
        if (pred(eff[idxOf(yi, zi, xi)])) n++
      }
    }
    return n
  }

  // ---- 平面检测(屋顶/地板): 逐层找最大连通实心块, 而非全区域占比(小房子屋顶占比很低) ----
  const planes = []
  for (let yi = 1; yi < sy - 1; yi++) {
    let solidCount = 0
    for (let i = yi * sz * sx; i < (yi + 1) * sz * sx; i++) if (solid(eff[i])) solidCount++
    if (solidCount < 12) continue
    // 2D 连通块
    const seen = new Uint8Array(sx * sz)
    let best = null
    for (let zi = 0; zi < sz; zi++) {
      for (let xi = 0; xi < sx; xi++) {
        if (seen[zi * sx + xi] || !solid(eff[idxOf(yi, zi, xi)])) continue
        const comp = []
        const bfs = [[zi, xi]]
        seen[zi * sx + xi] = 1
        while (bfs.length) {
          const [z, x] = bfs.pop()
          comp.push([z, x])
          for (const [dz, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nz = z + dz
            const nx = x + dx
            if (nz < 0 || nz >= sz || nx < 0 || nx >= sx || seen[nz * sx + nx]) continue
            if (solid(eff[idxOf(yi, nz, nx)])) {
              seen[nz * sx + nx] = 1
              bfs.push([nz, nx])
            }
          }
        }
        if (!best || comp.length > best.length) best = comp
      }
    }
    if (!best || best.length < 16) continue
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
    for (const [z, x] of best) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
    const w = maxX - minX + 1
    const d = maxZ - minZ + 1
    if (best.length / (w * d) < 0.55) continue // 长条/斜线不算平面
    // 平面上方主要是空气(是"顶面"而不是实心层)
    let aboveSolid = 0
    let aboveKnown = 0
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const v = eff[idxOf(yi + 1, z, x)]
        if (v !== 4) { aboveKnown++; if (solid(v)) aboveSolid++ }
      }
    }
    if (aboveKnown && aboveSolid / aboveKnown > 0.4) continue
    let belowAir = 0
    let belowKnown = 0
    let manInComp = 0
    for (const [z, x] of best) if (eff[idxOf(yi, z, x)] === 2) manInComp++
    for (let yy = Math.max(0, yi - 3); yy < yi; yy++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const v = eff[idxOf(yy, z, x)]
          if (v !== 4) { belowKnown++; if (v === 0) belowAir++ }
        }
      }
    }
    const belowAirFrac = belowKnown ? belowAir / belowKnown : 0
    // 自然地表也是"平面", 但下方是实心; 屋顶/桥的下方是空气。二者取其一才算人造平面
    if (belowAirFrac < 0.25 && manInComp / best.length < 0.3) continue
    planes.push({ y: y0 + yi, dims: `${w}×${d}`, area: best.length, below_air: Math.round(belowAirFrac * 100) / 100 })
  }
  planes.sort((a, b) => b.area - a.area)

  // ---- 墙面检测(同一线上跨多层的长实心段); 跳过整体接近全实心的层(地下岩体不是墙) ----
  const wallLines = new Map()
  const recordWall = (dir, line, yi, run) => {
    const key = `${dir}:${line}`
    const cur = wallLines.get(key) ?? { dir, line, layers: new Set(), maxLen: 0 }
    cur.layers.add(yi)
    cur.maxLen = Math.max(cur.maxLen, run)
    wallLines.set(key, cur)
  }
  for (let yi = 0; yi < sy; yi++) {
    const layerTotal = sx * sz
    let layerSolid = 0
    for (let i = yi * layerTotal; i < (yi + 1) * layerTotal; i++) if (solid(eff[i])) layerSolid++
    if (layerSolid / layerTotal >= 0.85) continue // 实心层(地下)不算墙面
    for (let zi = 0; zi < sz; zi++) {
      let run = 0
      for (let xi = 0; xi <= sx; xi++) {
        if (xi < sx && solid(eff[idxOf(yi, zi, xi)])) run++
        else {
          if (run >= 6) recordWall('东西向', cz - r + zi, yi, run)
          run = 0
        }
      }
    }
    for (let xi = 0; xi < sx; xi++) {
      let run = 0
      for (let zi = 0; zi <= sz; zi++) {
        if (zi < sz && solid(eff[idxOf(yi, zi, xi)])) run++
        else {
          if (run >= 6) recordWall('南北向', cx - r + xi, yi, run)
          run = 0
        }
      }
    }
  }
  const walls = [...wallLines.values()]
    .filter((w) => w.layers.size >= 3)
    .sort((a, b) => b.maxLen - a.maxLen)
    .slice(0, 3)

  // ---- 封闭空腔(房间) ----
  const visited = Uint8Array.from(outside)
  const rooms = []
  let suppressedRooms = 0
  for (let start = 0; start < total; start++) {
    if (eff[start] !== 0 || visited[start]) continue
    const cluster = []
    const bfs = [start]
    visited[start] = 1
    while (bfs.length) {
      const i = bfs.pop()
      cluster.push(i)
      const yi = Math.floor(i / (sz * sx))
      const rem = i % (sz * sx)
      const zi = Math.floor(rem / sx)
      const xi = rem % sx
      for (const [dy, dz, dx] of DIRS6) {
        const ny = yi + dy
        const nz = zi + dz
        const nx = xi + dx
        if (ny < 0 || ny >= sy || nz < 0 || nz >= sz || nx < 0 || nx >= sx) continue
        const ni = idxOf(ny, nz, nx)
        if (!visited[ni] && eff[ni] === 0) {
          visited[ni] = 1
          bfs.push(ni)
        }
      }
    }
    // 体积与包围盒
    let min = [Infinity, Infinity, Infinity]
    let max = [-Infinity, -Infinity, -Infinity]
    for (const i of cluster) {
      const yi = Math.floor(i / (sz * sx))
      const rem = i % (sz * sx)
      const zi = Math.floor(rem / sx)
      const xi = rem % sx
      min = [Math.min(min[0], xi), Math.min(min[1], yi), Math.min(min[2], zi)]
      max = [Math.max(max[0], xi), Math.max(max[1], yi), Math.max(max[2], zi)]
    }
    const roomMaxY = y0 + max[1]
    // 拟真: 完全埋在地下的空腔不报告(该列地表以上才算)
    if (fairOnly) {
      const cXi = Math.floor((min[0] + max[0]) / 2)
      const cZi = Math.floor((min[2] + max[2]) / 2)
      let surf = -1
      for (let yi = sy - 1; yi >= 0; yi--) {
        if (eff[idxOf(yi, cZi, cXi)] !== 0 && eff[idxOf(yi, cZi, cXi)] !== 4) { surf = y0 + yi; break }
      }
      if (surf >= 0 && roomMaxY < surf - 2) {
        suppressedRooms++
        continue
      }
    }
    rooms.push({
      volume: cluster.length,
      from: { x: cx - r + min[0], y: y0 + min[1], z: cz - r + min[2] },
      to: { x: cx - r + max[0], y: roomMaxY, z: cz - r + max[2] },
    })
  }
  rooms.sort((a, b) => b.volume - a.volume)

  // ---- 高柱(塔) ----
  let maxColMan = 0
  for (let zi = 0; zi < sz; zi++) {
    for (let xi = 0; xi < sx; xi++) {
      let run = 0
      for (let yi = 0; yi < sy; yi++) {
        if (eff[idxOf(yi, zi, xi)] === 2) {
          run++
          maxColMan = Math.max(maxColMan, run)
        } else run = 0
      }
    }
  }

  // ---- 评分与证据链 ----
  const denom = man + natSolid
  const manRatio = denom ? man / denom : 0
  let score = 0
  const evidence = []
  const topBlocks = [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}×${c}`)

  if ((man >= 15 && manRatio >= 0.2) || man >= 50) {
    score += 0.45
    evidence.push(`材料: 人造方块 ${man} 个(占实心 ${Math.round(manRatio * 100)}%), 主要是 ${topBlocks.join('、')}`)
  }
  if (manRatio >= 0.5 && man >= 40) {
    score += 0.15
    evidence.push('材料: 人造方块占绝对主导')
  }
  if (denom && man < 5) evidence.push('材料: 几乎没有人造方块')
  if (planes.length) {
    score += 0.15
    evidence.push(`几何: ${planes.slice(0, 2).map((p) => `y=${p.y} 有 ${p.dims} 实心平面(疑似屋顶/地板)`).join('; ')}`)
  }
  if (walls.length) {
    score += 0.2
    evidence.push(`几何: ${walls[0].dir}(坐标 ${walls[0].line})存在跨 ${walls[0].layers.size} 层、最长 ${walls[0].maxLen} 格的连续墙面`)
  }
  if (rooms.length) {
    score += 0.25
    evidence.push(`空间: ${rooms.length} 个封闭空腔, 最大 ${rooms[0].volume} 格(x${rooms[0].from.x}~${rooms[0].to.x}, y${rooms[0].from.y}~${rooms[0].to.y})(疑似房间)`)
  }
  if (maxColMan >= 8) {
    score += 0.15
    evidence.push(`几何: 存在 ${maxColMan} 格高的连续人造柱体(疑似塔/城墙)`)
  }
  const farmland = nameCount.get('farmland') ?? 0
  if (farmland >= 6) {
    score += 0.15
    evidence.push(`农田特征: 耕地 ${farmland} 块`)
  }
  if (unknown / total > 0.3) evidence.push(`注意: ${Math.round((unknown / total) * 100)}% 区域未加载, 结论可靠性下降`)

  const confidence = Math.min(0.95, Math.round(score * 100) / 100)
  let verdict
  if (score >= 0.6) verdict = '很可能人造结构'
  else if (score >= 0.35) verdict = '疑似人造结构(证据不够强)'
  else verdict = '更接近自然地形(未发现明显人造特征)'

  const hasDoor = [...nameCount.keys()].some((n) => n.endsWith('_door'))
  let typeGuess = null
  if (score >= 0.35) {
    if (rooms.length && (hasDoor || planes.length)) typeGuess = '房屋类建筑'
    else if (maxColMan >= 8) typeGuess = '塔/柱状构筑物'
    else if (farmland >= 6) typeGuess = '农田'
    else if (planes.length && !walls.length && planes[0].below_air >= 0.6) typeGuess = '桥/悬空平台'
    else if (!planes.length && !walls.length && !rooms.length) typeGuess = '人造痕迹(散点, 可能是玩家留下的)'
    else typeGuess = '结构(类型不确定)'
  }

  return {
    region: {
      center: { x: cx, y: cy, z: cz },
      from: { x: cx - r, y: y0, z: cz - r },
      to: { x: cx + r, y: y0 + sy - 1, z: cz + r },
      radius: r,
      height: sy,
    },
    perception: fairOnly ? 'fair(仅统计看得见的方块; 地下封闭空间不参与判断; 扫描中心限制在自身±8格)' : 'full(不过滤)',
    verdict,
    confidence,
    structure_type: typeGuess,
    evidence,
    stats: {
      man_made_cells: man,
      natural_solid_cells: natSolid,
      man_made_ratio: Math.round(manRatio * 100) / 100,
      air_cells: airCells,
      unknown_ratio: Math.round((unknown / total) * 100) / 100,
      top_man_made: topBlocks,
      masked_hidden_man_made: masked > 0 ? masked : undefined,
      underground_rooms_suppressed: suppressedRooms > 0 ? suppressedRooms : undefined,
    },
    planes: planes.slice(0, 3),
    walls: walls.map((w) => ({ direction: w.dir, line: w.line, layers: w.layers.size, max_length: w.maxLen })),
    rooms: rooms.slice(0, 3),
    hint: score >= 0.6
      ? '判定为人造结构: 避免在此区域 dig/place; 进入建议走门(activate_block)而不是挖墙。'
      : score >= 0.35
        ? '有人造痕迹, 作业(dig/collect)前建议谨慎确认。'
        : '看起来是自然地形, 可正常采集。',
  }
}
