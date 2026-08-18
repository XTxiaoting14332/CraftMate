// 习惯学习: 记录 AI 的工具调用序列, 挖掘高频模式(n-gram),
// 高置信度的"下一步"可以在模型思考期间先本地执行(惯性执行), 让动作与推理重叠。
// 学习的是"调用序列", 不是具体坐标——坐标易变, 模式稳定(find→collect、击杀→eat、上线→recall)。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeNs } from './store.js'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const JOURNAL_CAP = 3000 // 每服务器保留的调用记录数
const SAVE_EVERY = 20 // 每 N 条落盘一次(防磁盘抖动)

const journals = new Map() // ns -> { calls: [sig...], unsaved: n }
const cache = new Map() // ns -> { patterns: Map<ctx, Map<sig, count>>, namePatterns: Map<ctxName, Map<name, count>>, dirty }

function fileOf(ns) {
  return path.join(DATA_DIR, sanitizeNs(ns), 'habits.json')
}

// 规范化签名: 参数键排序, 屏蔽易变噪声(超时毫秒等)
function canonicalArgs(args) {
  const clean = {}
  for (const k of Object.keys(args ?? {}).sort()) {
    if (/^(timeout_ms|seconds|duration_s|max|limit|radius|count)$/.test(k)) continue // 数值型参数不稳定, 不参与模式
    clean[k] = args[k]
  }
  return JSON.stringify(clean)
}

function sigOf(name, args) {
  return `${name}|${canonicalArgs(args)}`
}

function getJournal(ns) {
  let j = journals.get(ns)
  if (!j) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileOf(ns), 'utf8'))
      j = { calls: Array.isArray(parsed.calls) ? parsed.calls.slice(-JOURNAL_CAP) : [], unsaved: 0 }
    } catch {
      j = { calls: [], unsaved: 0 }
    }
    journals.set(ns, j)
  }
  return j
}

function getCache(ns) {
  let c = cache.get(ns)
  if (!c || c.dirty) {
    const calls = getJournal(ns).calls
    const patterns = new Map()
    const namePatterns = new Map()
    const bump = (map, key, next) => {
      let m = map.get(key)
      if (!m) { m = new Map(); map.set(key, m) }
      m.set(next, (m.get(next) ?? 0) + 1)
    }
    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1]
      const prevName = prev.split('|')[0]
      bump(patterns, prev, calls[i])
      bump(namePatterns, prevName, calls[i].split('|')[0])
      if (i >= 2) {
        bump(patterns, calls[i - 2] + '>>' + prev, calls[i])
        bump(namePatterns, calls[i - 2].split('|')[0] + '>>' + prevName, calls[i].split('|')[0])
      }
    }
    c = { patterns, namePatterns, dirty: false }
    cache.set(ns, c)
  }
  return c
}

export function recordCall(ns, name, args) {
  const j = getJournal(ns)
  j.calls.push(sigOf(name, args))
  if (j.calls.length > JOURNAL_CAP) j.calls.splice(0, j.calls.length - JOURNAL_CAP)
  j.unsaved += 1
  const c = cache.get(ns)
  if (c) c.dirty = true
  if (j.unsaved >= SAVE_EVERY) saveJournal(ns)
}

export function saveJournal(ns) {
  const j = journals.get(ns)
  if (!j) return
  try {
    fs.mkdirSync(path.dirname(fileOf(ns)), { recursive: true })
    const tmp = `${fileOf(ns)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ calls: j.calls }, null, 0), 'utf8')
    fs.renameSync(tmp, fileOf(ns))
    j.unsaved = 0
  } catch { /* 磁盘问题不影响运行 */ }
}

export function saveAll() {
  for (const ns of journals.keys()) saveJournal(ns)
}

// 预测下一步: 优先长上下文(2-gram), 兜底 1-gram; 置信度 = 次数占比。
// 参数来源: 精确参数模式(如 goto waypoint=家 / memory recall 上次会话);
// find→collect 特例: blocks 参数从上一个调用继承(挖矿主链路)。
export function predictNext(ns, recent) {
  const j = getJournal(ns).calls
  if (j.length < 8) return null // 样本太少不预测
  const c = getCache(ns)
  const sigs = (recent ?? []).map((r) => sigOf(r.name, r.args))
  const names = sigs.map((s) => s.split('|')[0])

  const tryCtx = (key) => {
    const m = c.patterns.get(key)
    if (!m) return null
    let total = 0
    let bestSig = null
    let bestN = 0
    for (const [sig, n] of m) {
      total += n
      if (n > bestN) { bestN = n; bestSig = sig }
    }
    if (!bestSig) return null
    const [name, argJson] = bestSig.split('|')
    let args = {}
    try { args = JSON.parse(argJson || '{}') } catch { /* ignore */ }
    return { name, args, confidence: bestN / total, samples: total }
  }

  // 1) 精确参数模式(长上下文优先)
  let hit = sigs.length >= 2 ? tryCtx(sigs[sigs.length - 2] + '>>' + sigs[sigs.length - 1]) : null
  if (!hit) hit = tryCtx(sigs[sigs.length - 1])
  if (hit) return hit

  // 2) 名称级模式 + 参数继承(find→collect / find→dig批量)
  const tryNameCtx = (key) => {
    const m = c.namePatterns.get(key)
    if (!m) return null
    let total = 0
    let bestName = null
    let bestN = 0
    for (const [name, n] of m) {
      total += n
      if (n > bestN) { bestN = n; bestName = name }
    }
    if (!bestName) return null
    return { name: bestName, args: null, confidence: bestN / total, samples: total }
  }
  let nhit = names.length >= 2 ? tryNameCtx(names[names.length - 2] + '>>' + names[names.length - 1]) : null
  if (!nhit) nhit = tryNameCtx(names[names.length - 1])
  if (!nhit) return null
  // 参数继承规则
  const last = recent[recent.length - 1]
  if (nhit.name === 'collect' && last?.name === 'find' && last?.args?.blocks) {
    return { ...nhit, args: { blocks: last.args.blocks } }
  }
  return null // 名称命中但拿不到参数 → 不猜(乱参数比不执行更糟)
}

// 面板展示: 学到的头部模式
export function habitsStats(ns) {
  const c = getCache(ns)
  const out = []
  for (const [ctx, m] of c.patterns) {
    let total = 0
    let bestSig = null
    let bestN = 0
    for (const [sig, n] of m) { total += n; if (n > bestN) { bestN = n; bestSig = sig } }
    if (bestN >= 3 && total >= 4) {
      out.push({ after: ctx.replace(/\|/g, ' ').replace(/>>/g, ' → '), next: bestSig.replace(/\|/, ' '), confidence: Math.round((bestN / total) * 100) })
    }
  }
  return { samples: getJournal(ns).calls.length, patterns: out.sort((a, b) => b.confidence - a.confidence).slice(0, 8) }
}
