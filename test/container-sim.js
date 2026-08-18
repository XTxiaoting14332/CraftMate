// 容器接口模拟测试: 不连真实服务器, 验证箱子 deposit/withdraw 走 mineflayer
// 真实存在的 window.deposit/window.withdraw, 菜单点击走 bot.clickWindow,
// 熔炉放料把 undefined metadata 归一化为 null, 不再引用不存在的 depositStack。
import { containerTool } from '../src/interact.js'
import { state } from '../src/bot.js'
import Vec3 from 'vec3'

let inventory = []
let containerItems = []
const depositCalls = []
const withdrawCalls = []
const clickCalls = []
const putInputCalls = []
const putFuelCalls = []

function makeItem(name, type, metadata, count) {
  return { name, displayName: name, type, metadata, count }
}

function move(src, dst, itemType, metadata, count) {
  let left = count
  for (const it of src) {
    if (left <= 0) break
    if (it.type !== itemType || (metadata != null && it.metadata !== metadata) || it.count <= 0) continue
    const take = Math.min(left, it.count)
    it.count -= take
    left -= take
    const existing = dst.find((d) => d.type === itemType && d.metadata === it.metadata)
    if (existing) existing.count += take
    else dst.push(makeItem(it.name, it.type, it.metadata, take))
  }
  for (let i = src.length - 1; i >= 0; i--) {
    if (src[i].count <= 0) src.splice(i, 1)
  }
  return count - left
}

const chestWindow = {
  inventoryStart: 27,
  containerItems() { return containerItems.map((it) => ({ ...it })) },
  items() { return this.containerItems() },
  async deposit(itemType, metadata, count) {
    depositCalls.push([itemType, metadata, count])
    return move(inventory, containerItems, itemType, metadata, count)
  },
  async withdraw(itemType, metadata, count) {
    withdrawCalls.push([itemType, metadata, count])
    return move(containerItems, inventory, itemType, metadata, count)
  },
  close() { state.containerWindow = null },
}

const furnaceWindow = {
  inputItem() { return null },
  fuelItem() { return null },
  outputItem() { return null },
  async putInput(itemType, metadata, count) { putInputCalls.push([itemType, metadata, count]) },
  async putFuel(itemType, metadata, count) { putFuelCalls.push([itemType, metadata, count]) },
  async takeOutput() { return null },
  async takeInput() { return null },
  async takeFuel() { return null },
  close() { state.containerWindow = null },
}

let blockName = 'chest'
const bot = {
  registry: { itemsByName: { oak_planks: {}, coal: {} } },
  entity: { position: new Vec3(0, 64, 0), height: 1.6 },
  inventory: { items: () => inventory.map((it) => ({ ...it })) },
  blockAt() {
    return { name: blockName, position: new Vec3(0, 64, 0) }
  },
  async openContainer() { state.containerWindow = chestWindow; return chestWindow },
  async openFurnace() { state.containerWindow = furnaceWindow; return furnaceWindow },
  async clickWindow(slot, button, mode) { clickCalls.push([slot, button, mode]) },
}

// 1. 打开箱子并列表
let r = await containerTool(bot, { action: 'open', x: 0, y: 64, z: 0 })
if (r.opened !== 'chest' || state.containerWindow !== chestWindow) throw new Error('箱子打开失败')

// 2. 整组/部分放入: 走 window.deposit(itemType, metadata ?? null, count)
inventory = [makeItem('oak_planks', 5, undefined, 8)]
containerItems = []
r = await containerTool(bot, { action: 'deposit', item: 'oak_planks', count: 3 })
if (r.count !== 3 || inventory[0]?.count !== 5 || containerItems[0]?.count !== 3) {
  throw new Error(`部分放入失败: ${JSON.stringify(r)} ${JSON.stringify(inventory)} ${JSON.stringify(containerItems)}`)
}
if (depositCalls.length !== 1 || depositCalls[0][0] !== 5 || depositCalls[0][1] !== null || depositCalls[0][2] !== 3) {
  throw new Error(`deposit 参数不对: ${JSON.stringify(depositCalls)}`)
}

// 3. 取出: 走 window.withdraw(itemType, metadata ?? null, count)
r = await containerTool(bot, { action: 'withdraw', item: 'oak_planks', count: 2 })
if (r.count !== 2 || containerItems[0]?.count !== 1 || inventory[0]?.count !== 7) {
  throw new Error(`取出失败: ${JSON.stringify(r)} ${JSON.stringify(inventory)} ${JSON.stringify(containerItems)}`)
}
if (withdrawCalls.length !== 1 || withdrawCalls[0][0] !== 5 || withdrawCalls[0][1] !== null || withdrawCalls[0][2] !== 2) {
  throw new Error(`withdraw 参数不对: ${JSON.stringify(withdrawCalls)}`)
}

// 4. 菜单点击: 走 bot.clickWindow(slot, button, mode)
r = await containerTool(bot, { action: 'click', slot: 2, button: 1 })
if (clickCalls.length !== 1 || clickCalls[0][0] !== 2 || clickCalls[0][1] !== 1 || clickCalls[0][2] !== 0) {
  throw new Error(`clickWindow 参数不对: ${JSON.stringify(clickCalls)}`)
}
await containerTool(bot, { action: 'close' })
if (state.containerWindow !== null) throw new Error('close 后窗口未清空')

// 5. 熔炉放料: metadata 未定义时归一化为 null
blockName = 'furnace'
inventory = [makeItem('coal', 263, undefined, 4)]
r = await containerTool(bot, { action: 'open', x: 0, y: 64, z: 0 })
if (r.opened !== 'furnace') throw new Error('熔炉打开失败')
r = await containerTool(bot, { action: 'deposit', item: 'coal' })
if (r.count !== 4 || putFuelCalls.length !== 1 || putFuelCalls[0][0] !== 263 || putFuelCalls[0][1] !== null || putFuelCalls[0][2] !== 4) {
  throw new Error(`熔炉放料失败: ${JSON.stringify(r)} ${JSON.stringify(putFuelCalls)}`)
}

console.log('PASS 容器: deposit/withdraw/click 使用真实 mineflayer API, metadata 归一化为 null')
