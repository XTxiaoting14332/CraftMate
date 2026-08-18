// 自动防御决策逻辑模拟测试(不需要 MC 服务器)
// 用假 bot 驱动 defense.js 的巡检循环, 验证: 触发反击 / 低血逃跑 / 激怒中立生物 / stop 打断
import Vec3 from 'vec3'
import { state } from '../src/bot.js'
import { startDefense, stopDefense } from '../src/defense.js'

function makeBot() {
  const bot = {
    entity: { position: new Vec3(0, 64, 0), health: 20, food: 20 },
    health: 20, // mineflayer: 玩家生命在 bot.health(update_health 包), entity.health 不更新
    food: 20,
    entities: {},
    registry: {
      entitiesByName: {
        zombie: { type: 'hostile' },
        skeleton: { type: 'hostile' },
        creeper: { type: 'hostile' },
        cow: { type: 'passive' },
        wolf: { type: 'neutral' },
      },
    },
    inventory: { items: () => [] },
    pathfinder: {
      setGoal: () => {},
      stop: () => {},
      setMovements: () => {},
      goto: async () => {},
    },
    lookAt: async () => {},
    look: () => {},
    setControlState: () => {},
    attack: () => {},
  }
  return bot
}

function addMob(bot, name, type, x, y, z) {
  const e = { type, name, displayName: name, position: new Vec3(x, y, z), isValid: true, height: 1.9, id: name + x }
  bot.entities[e.id] = e
  return e
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function check(cond, msg) {
  if (cond) console.log('PASS', msg)
  else { console.error('FAIL', msg); failed = true }
}

// ---- 场景 1: 敌对生物进入警戒半径 → 自动反击 ----
{
  state.bot = null
  state.task = null
  state.defense = { active: false, action: null, cancelled: false }
  state.lastDamagedAt = null
  state.events = []
  state.seq = 0
  const bot = makeBot()
  addMob(bot, 'cow', 'animal', 3, 64, 0) // 牛贴近不应触发
  state.bot = bot
  startDefense(bot, { engageRadius: 8 })
  await sleep(1200)
  check(state.defense.active === false, '场景1a: 只有被动生物时不触发')

  const zombie = addMob(bot, 'zombie', 'mob', 5, 64, 0)
  await sleep(1200)
  check(state.defense.active === true && state.defense.action === 'engage', '场景1b: 僵尸进入警戒半径触发反击')
  const ev = state.events.filter((e) => e.type === 'auto_defense')
  check(ev.some((e) => e.action === 'engage' && e.targets?.[0]?.name === 'zombie'), '场景1c: 产生 engage 事件')
  // stop 打断
  state.defense.cancelled = true
  await sleep(1600)
  check(state.defense.active === false, '场景1d: stop(cancelled)后反击结束')
  // 注意: 每次断言时重新过滤(事件数组在持续增长)
  check(
    state.events.filter((e) => e.type === 'auto_defense').some((e) => e.action === 'engage_end' && e.reason === 'stopped_by_user'),
    '场景1d: engage_end(stopped_by_user) 事件',
  )
  delete bot.entities[zombie.id]
  stopDefense()
  state.bot = null
}

// ---- 场景 2: 生命值过低 → 自动逃跑 ----
{
  state.task = null
  state.defense = { active: false, action: null, cancelled: false }
  state.lastDamagedAt = null
  const bot = makeBot()
  addMob(bot, 'skeleton', 'mob', 10, 64, 0)
  bot.health = 4
  state.bot = bot
  startDefense(bot, { engageRadius: 8, fleeHp: 6 })
  await sleep(1200)
  check(state.defense.action === 'flee', '场景2a: 低血+敌对生物触发逃跑')
  check(state.events.some((e) => e.type === 'auto_defense' && e.action === 'flee'), '场景2b: 产生 flee 事件')
  state.defense.cancelled = true
  await sleep(800)
  stopDefense()
  state.bot = null
}

// ---- 场景 3: 被中立生物打 → 反击(激怒机制) ----
{
  state.task = null
  state.defense = { active: false, action: null, cancelled: false }
  state.lastDamagedAt = Date.now()
  const bot = makeBot()
  addMob(bot, 'wolf', 'mob', 2, 64, 0)
  bot.health = 16
  state.bot = bot
  startDefense(bot, { engageRadius: 8 })
  await sleep(1200)
  check(state.defense.action === 'engage', '场景3: 贴身狼+刚掉血 → 视为威胁反击')
  state.defense.cancelled = true
  await sleep(1600)
  stopDefense()
  state.bot = null
}

// ---- 场景 4: AI 主动战斗时不抢 ----
{
  state.task = { name: 'fight', since: Date.now(), cancelled: false }
  state.defense = { active: false, action: null, cancelled: false }
  state.lastDamagedAt = null
  const bot = makeBot()
  addMob(bot, 'zombie', 'mob', 5, 64, 0)
  state.bot = bot
  startDefense(bot, { engageRadius: 8 })
  await sleep(1200)
  check(state.defense.active === false, '场景4: AI 正在 fight 时不抢占')
  stopDefense()
  state.bot = null
  state.task = null
}

if (failed) {
  console.error('\n存在失败项 ✗')
  process.exit(1)
}
console.log('\n自动防御模拟测试全部通过 ✓')
process.exit(0)
