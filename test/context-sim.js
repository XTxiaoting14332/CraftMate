// 工作记忆快照测试: 目标/进行中建筑/最近完成记录会整理成固定提示,
// 让 Agent 不用重新猜"我现在在干嘛"。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveMemory, forgetMemory, saveBuildingPlanRecord, deleteBuildingPlan } from '../src/store.js'
import { contextSnapshot } from '../src/context.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ns = '__context_sim__'
const dataDir = path.join(root, 'data', ns)

saveMemory(ns, { key: 'goal:盖小木屋', text: '目标: 盖小木屋\n下一步: 收集木头', tags: ['goal'] })
saveBuildingPlanRecord(ns, { name: '小木屋', entries: [
  { x: 1, y: 64, z: 1, block: 'oak_planks', status: 'placed' },
  { x: 2, y: 64, z: 1, block: 'oak_planks', status: 'missing' },
] })
saveMemory(ns, { key: '建造:小木屋', text: '建筑规划「小木屋」已全部完成: 2 格', tags: ['建造记录', '建筑'] })

const snap = contextSnapshot(ns)
if (!snap || !snap.includes('盖小木屋') || !snap.includes('进行中的建筑') || !snap.includes('最近完成')) {
  throw new Error(`工作记忆快照缺少目标/建筑/完成记录: ${snap ?? '(空)'}`)
}
if (!snap.includes('小木屋')) throw new Error('快照应包含建筑名: ' + snap)
console.log('PASS 工作记忆快照: 目标/建筑进度/最近完成自动汇总')

forgetMemory(ns, 'goal:盖小木屋')
forgetMemory(ns, '建造:小木屋')
deleteBuildingPlan(ns, '小木屋')
fs.rmSync(dataDir, { recursive: true, force: true })
if (contextSnapshot(ns) !== null) throw new Error('清理后快照应为空')
console.log('PASS 工作记忆快照: 无内容时静默跳过')
