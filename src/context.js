// 工作记忆快照: 把持久化的目标/建筑进度/最近完成记录整理成一小段固定提示,
// 由 Agent 在连接/计划变化/裁剪后自动注入, 防止模型在长会话里忘记自己在做什么。
import { listMemories, listBuildingPlans, listChatLog } from './store.js'

function goalBrief(m) {
  const text = m.text ?? ''
  const title = /目标:\s*([^\n]+)/.exec(text)?.[1] || m.key?.replace(/^goal:/, '') || '未命名目标'
  const next = /下一步:\s*([^\n]+)/.exec(text)?.[1]
  return { title, next, done: /状态:\s*已完成/.test(text) }
}

function buildBrief(plan) {
  const entries = plan.entries ?? []
  const placed = entries.filter((e) => e.status === 'placed' || e.status === 'already').length
  const blocked = entries.filter((e) => e.status === 'blocked').length
  const missing = entries.filter((e) => e.status === 'missing').length
  const errors = entries.filter((e) => e.status === 'error' || e.status === 'unreachable' || e.status === 'no_support').length
  return {
    name: plan.name,
    placed,
    total: entries.length,
    remaining: entries.length - placed,
    blocked,
    missing,
    errors,
    updated: plan.updated,
  }
}

// 放置/存放记忆的简洁描述: "在 (x,y,z) 放了 crafting_table" / "在 (x,y,z) 存了 oak_log ×32"
function placeBrief(m) {
  const text = m.text ?? ''
  const coord = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/.exec(text)
  const pos = coord ? `(${coord[1]}, ${coord[2]}, ${coord[3]})` : '某处'
  const verb = m.key?.startsWith('存放:') ? '存了' : '放了'
  const what = (m.key ?? '').replace(/^(放置|存放):/, '')
  const count = /×(\d+)/.exec(text)?.[1]
  return `${pos} ${verb} ${what}${count ? ` ×${count}` : ''}`
}

// 只在有值得记住的内容时返回文本, 否则返回 null(不向上下文塞噪音)
export function contextSnapshot(ns) {
  const memories = listMemories(ns)
  const goals = memories
    .filter((m) => m.key?.startsWith('goal:') && !/状态:\s*已完成/.test(m.text ?? ''))
    .map(goalBrief)
  const builds = listBuildingPlans(ns)
    .map(buildBrief)
    .filter((b) => b.remaining > 0)
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, 4)
  const buildDone = memories
    .filter((m) => m.key?.startsWith('建造:'))
    .sort((a, b) => (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''))
    .slice(0, 2)
  const lastSession = memories
    .filter((m) => m.key === '上次会话')
    .slice(-1)[0]
  // 放置/存放位置记录: "我在哪放过什么"(工作台/箱子/熔炉等), 防止 AI 忘记东西放哪
  const placedThings = memories
    .filter((m) => m.key?.startsWith('放置:'))
    .sort((a, b) => (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''))
    .slice(0, 6)
  // 存放记录: "我在哪存了什么"(箱子/容器), 防止 AI 忘了自己存过东西
  const storedThings = memories
    .filter((m) => m.key?.startsWith('存放:'))
    .sort((a, b) => (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''))
    .slice(0, 6)
  // 最近聊天(玩家说过的话): 防止 AI 忘记玩家交代的事/重要对话
  const recentChats = listChatLog(ns, { limit: 8 })
    .filter((c) => c.type !== 'self_chat' && (c.player || c.from))
    .slice(0, 5)

  const lines = []
  if (goals.length) {
    lines.push('## 你当前的目标(本地快照)')
    for (const g of goals) {
      lines.push(`- ${g.title}${g.next ? `: 下一步是 ${g.next}` : ''}`)
    }
  }
  if (placedThings.length) {
    lines.push('## 你放过的东西(位置记忆, 别重复制作/存放)')
    for (const m of placedThings) {
      lines.push(`- ${placeBrief(m)}`)
    }
  }
  if (storedThings.length) {
    lines.push('## 你存过的东西(存放记忆, 别重复存放)')
    for (const m of storedThings) {
      lines.push(`- ${placeBrief(m)}`)
    }
  }
  if (recentChats.length) {
    lines.push('## 最近玩家说的话(别忘记他们交代的事)')
    for (const c of recentChats) {
      const who = c.player || c.from
      const msg = String(c.message ?? c.text ?? '').slice(0, 80)
      lines.push(`- ${who}: ${msg}`)
    }
  }
  if (builds.length) {
    lines.push('## 进行中的建筑(本地进度快照)')
    for (const b of builds) {
      lines.push(`- 「${b.name}」已放 ${b.placed}/${b.total} 格, 剩 ${b.remaining} 格${b.missing ? `, ${b.missing} 格缺料` : ''}${b.blocked ? `, ${b.blocked} 格被占用` : ''}${b.errors ? `, ${b.errors} 格有问题` : ''}`)
    }
    lines.push('- 按这条快照继续施工或修问题; 完成后用 goal(done) 收尾, 不要重复问玩家“要建什么”')
  }
  if (buildDone.length) {
    lines.push('## 最近完成的建筑(别再当新任务问)')
    for (const m of buildDone) {
      const brief = (m.text ?? '').split('\n')[0]
      lines.push(`- ${brief}`)
    }
  }
  if (lastSession) {
    lines.push('## 上次会话要点')
    lines.push(`- ${(lastSession.text ?? '').split('\n')[0].slice(0, 300)}`)
  }
  if (!lines.length) return null
  return lines.join('\n')
}
