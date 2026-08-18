// 掉落物巡检模拟: 验证空闲巡检能本地捡起视野内掉落物并产生 auto_pickup 事件,
// 让 wait/下一条工具结果能直接看见"已经捡了"，不用模型再规划一次。
import Vec3 from 'vec3'
import { scanDropsOnce, stopDropPatrol, dropPatrolStatus } from '../src/drop-patrol.js'
import { state } from '../src/bot.js'

const drop = { id: 'd1', type: 'object', name: 'item', position: new Vec3(1, 0, 0), isValid: true }
const bot = {
  registry: {},
  entity: { position: new Vec3(0, 0, 0), height: 1.6, health: 20 },
  inventory: { items: () => [] },
  entities: { d1: drop },
  blockAt() { return { boundingBox: 'empty' } },
  pathfinder: {},
}

// 模拟服务器拾取判定：巡检贴近后掉落实体消失
setTimeout(() => { delete bot.entities.d1 }, 300)
const r = await scanDropsOnce(bot, { radius: 8, timeout_ms: 2000 })
if (r.picked !== 1 || r.drops_remaining !== 0) {
  throw new Error(`掉落物巡检应捡起 1 个: ${JSON.stringify(r)}`)
}
if (!state.events.some((e) => e.type === 'auto_pickup' && e.picked === 1)) {
  throw new Error(`应产生 auto_pickup 事件: ${JSON.stringify(state.events.slice(-3))}`)
}
stopDropPatrol()
if (dropPatrolStatus().enabled) throw new Error('停止巡检后不应再有定时器')
console.log('PASS 掉落物巡检: 本地捡起并产生 auto_pickup 事件')

const none = await scanDropsOnce(bot, { radius: 8 })
if (none.picked !== 0 || none.scanned !== 0) {
  throw new Error(`无掉落物时不应巡检: ${JSON.stringify(none)}`)
}
console.log('PASS 掉落物巡检: 无目标时静默跳过')
