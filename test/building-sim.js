// 建筑规划本地施工模拟: 不连真实服务器, 验证蓝图能按材料库存本地逐格放置,
// 缺料时自动标记 missing 并给出缺口, 而不是把每一步决策交还给模型。
import Vec3 from 'vec3'
import { buildEntries, computeMaterials } from '../src/building.js'

const world = new Map()
for (let x = 8; x <= 12; x++) {
  for (let z = 8; z <= 12; z++) {
    world.set(`${x},63,${z}`, { name: 'dirt', boundingBox: 'block', position: new Vec3(x, 63, z) })
  }
}
let inventory = [{ name: 'oak_planks', count: 2 }]
const bot = {
  registry: { blocksByName: { oak_planks: {} } },
  entity: { position: new Vec3(9.5, 63.5, 10.5), height: 1.6, health: 20 },
  heldItem: null,
  inventory: { items: () => inventory },
  blockAt(pos) {
    const k = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    return world.get(k) ?? { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) }
  },
  async equip(item) { this.heldItem = item },
  async placeBlock(ref) {
    const t = ref.position.offset(0, 1, 0)
    const k = `${Math.floor(t.x)},${Math.floor(t.y)},${Math.floor(t.z)}`
    world.set(k, { name: this.heldItem.name, boundingBox: 'block', position: t })
    inventory = inventory.map((it) => it.name === this.heldItem.name ? { ...it, count: it.count - 1 } : it)
  },
}

const plan = [
  { x: 10, y: 64, z: 10, block: 'oak_planks' },
  { x: 11, y: 64, z: 10, block: 'oak_planks' },
  { x: 12, y: 64, z: 10, block: 'oak_planks' },
]

const materials = computeMaterials(bot, plan)
if (materials.required[0]?.need !== 3) throw new Error(`应统计需要 3 个 oak_planks: ${JSON.stringify(materials)}`)
if (materials.missing[0]?.shortage !== 1) throw new Error(`2 个库存应缺 1 个: ${JSON.stringify(materials)}`)
console.log('PASS 建筑材料: 蓝图自动汇总需求/库存缺口')

const r = await buildEntries(bot, plan, {}, {})
if (r.placed !== 2 || r.missing !== 1 || r.remaining !== 1) {
  throw new Error(`应本地放 2 格、缺料 1 格: ${JSON.stringify(r)}`)
}
const finalBlock = bot.blockAt(new Vec3(12, 64, 10))
if (finalBlock.boundingBox !== 'empty' || finalBlock.name !== 'air') {
  throw new Error(`第 3 格不应被放置(材料不足): ${JSON.stringify(finalBlock)}`)
}
if (world.get('10,64,10').name !== 'oak_planks' || world.get('11,64,10').name !== 'oak_planks') {
  throw new Error('前两格应已由本地程序放置')
}
if (!r.missing_materials.some((m) => m.block === 'oak_planks' && m.shortage === 1)) {
  throw new Error(`施工后应报告剩余缺料: ${JSON.stringify(r.missing_materials)}`)
}
console.log('PASS 建筑施工: 按库存本地放 2 格, 缺料格自动标记并报告缺口')
