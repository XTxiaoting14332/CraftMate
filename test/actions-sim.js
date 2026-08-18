// 挖掘动作模拟测试: 不连真实服务器, 验证 dig 会强制对准、优先 raycast 取面、
// raycast 失败时退化为默认面(而不是一直对同一面空挥)。
import Vec3 from 'vec3'
import { digBlock, digTimeoutMs, pickupNearbyDrops } from '../src/actions.js'

const calls = []
const block = {
  name: 'oak_log',
  position: new Vec3(10, 64, 10),
  boundingBox: 'block',
  diggable: true,
  canHarvest() { return true },
}

const bot = {
  registry: {},
  entity: { position: new Vec3(10.5, 63.5, 10.5), height: 1.6 },
  heldItem: { name: 'iron_axe', canHarvest() { return true } },
  blockAt() { return block },
  canDigBlock() { return true },
  entities: {},
  dig(_block, forceLook, digFace) {
    calls.push({ forceLook, digFace })
    if (digFace === 'raycast') return Promise.reject(new Error('Block not in view'))
    return Promise.resolve()
  },
}

const r = await digBlock(bot, { x: 10, y: 64, z: 10 })
if (r.dug !== 'oak_log') throw new Error(`dig 未成功: ${JSON.stringify(r)}`)
if (calls.length !== 2) throw new Error(`应有 2 次 dig 尝试(raycast + 默认), 实际 ${calls.length}`)
if (calls[0].forceLook !== true || calls[0].digFace !== 'raycast') {
  throw new Error(`第一次 dig 应为 forceLook=true + raycast: ${JSON.stringify(calls[0])}`)
}
if (calls[1].forceLook !== true) throw new Error(`第二次 dig 也应 forceLook=true: ${JSON.stringify(calls[1])}`)
console.log('PASS 挖掘: forceLook + raycast 优先, 失败自动退化为默认面')

// 铁镐能采深板岩钻石矿: canHarvest 收的是物品数字 id(item.type), 不是整个物品对象。
// 之前传 bot.heldItem 导致 prismarine-block 永远查不到 harvestTools, 误报"工具不支持"。
const deepslateBlock = {
  name: 'deepslate_diamond_ore',
  position: new Vec3(10, 64, 10),
  boundingBox: 'block',
  diggable: true,
  material: 'pickaxe',
  harvestTools: { '831': true },
  canHarvest(arg) { canHarvestArgs.push(arg); return arg === 831 },
}
const canHarvestArgs = []
const ironBot = {
  registry: {},
  entity: { position: new Vec3(10.5, 63.5, 10.5), height: 1.6, health: 20 },
  heldItem: { name: 'iron_pickaxe', type: 831 },
  inventory: { items: () => [{ name: 'iron_pickaxe', type: 831, count: 1 }] },
  blockAt() { return deepslateBlock },
  canDigBlock() { return true },
  entities: {},
  dig() { return Promise.resolve() },
}
const ironResult = await digBlock(ironBot, { x: 10, y: 64, z: 10 })
if (ironResult.dug !== 'deepslate_diamond_ore' || !canHarvestArgs.includes(831)) {
  throw new Error(`铁镐挖深板岩钻石矿被误拒: ${JSON.stringify(ironResult)}`)
}
console.log('PASS 挖掘工具: 铁镐传数字 id 给 canHarvest, 深板岩钻石矿可采')

// 慢方块(如钻石镐挖黑曜石约 11s)不能套固定 6s 超时, 超时应随 digTime 放宽
const obsidianBot = { digTime() { return 11000 } }
const slowTimeout = digTimeoutMs(obsidianBot, block)
if (slowTimeout < 15000 || slowTimeout > 30000) {
  throw new Error(`黑曜石超时应按 digTime 放宽到 15~30s, 实际 ${slowTimeout}ms`)
}
if (digTimeoutMs({}, block) < 8000) throw new Error('快速方块超时最低也应有 8s')
console.log('PASS 挖掘超时: 按 digTime 动态计算, 慢方块自动放宽')

// 挖完自动收掉落物: 不依赖模型回头补一次"捡东西"规划
const pickupBot = {
  registry: {},
  entity: { position: new Vec3(0, 0, 0), height: 1.6, health: 20 },
  blockAt() { return null },
  canDigBlock() { return true },
  pathfinder: {},
  entities: {
    item1: { id: 'item1', type: 'object', name: 'item', position: new Vec3(3, 0, 2), isValid: true },
  },
}
const pickupResult = await pickupNearbyDrops(pickupBot, { radius: 8, timeoutMs: 3000 })
if (pickupResult.drops_checked !== 1) throw new Error(`应自动处理 1 个掉落物: ${JSON.stringify(pickupResult)}`)
console.log('PASS 掉落物: 挖完自动走近/等待拾取, 不留给模型重新规划')
