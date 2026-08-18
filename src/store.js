// 本地持久化存储: 记忆/路标/聊天日志, 按"服务器"命名空间隔离(每台服务器一个目录)
// data/<host_port>/{memory,waypoints,chatlog}.json, 原子写入(临时文件+rename)
// 另有 data/last_server.json 记录最近连接的服务器(MCP 重启后仍可定位聊天记录)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const CHATLOG_CAP = 2000 // 每服务器最多保留的聊天条数(超出丢最旧)

export function sanitizeNs(ns) {
  return String(ns ?? 'global').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

// 调试日志: 追加写 data/debug.log, 带时间戳, 超过 2MB 截断保留尾部(排查问题用)
const DEBUG_LOG = path.join(DATA_DIR, 'debug.log')
const DEBUG_MAX = 2 * 1024 * 1024
export function appendDebugLog(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const text = `[${new Date().toISOString()}] ${String(line)}\n`
    fs.appendFileSync(DEBUG_LOG, text, 'utf8')
    try {
      const st = fs.statSync(DEBUG_LOG)
      if (st.size > DEBUG_MAX) {
        const buf = fs.readFileSync(DEBUG_LOG, 'utf8')
        fs.writeFileSync(DEBUG_LOG, buf.slice(-DEBUG_MAX / 2), 'utf8')
      }
    } catch { /* ignore */ }
  } catch { /* 调试日志失败不影响主流程 */ }
}

function nsFile(ns, baseName) {
  return path.join(DATA_DIR, sanitizeNs(ns), `${baseName}.json`)
}

function loadEntries(ns, baseName) {
  const file = nsFile(ns, baseName)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { /* 不存在则尝试迁移旧版全局数据 */ }
  // 一次性迁移: 旧版(无命名空间)的 data/<name>.json 归第一个加载它的服务器
  const legacy = path.join(DATA_DIR, `${baseName}.json`)
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'))
    const entries = Array.isArray(parsed) ? parsed : []
    persistEntries(ns, baseName, entries)
    fs.renameSync(legacy, `${legacy}.migrated`)
    return entries
  } catch {
    return []
  }
}

function persistEntries(ns, baseName, entries) {
  fs.mkdirSync(path.dirname(nsFile(ns, baseName)), { recursive: true })
  const target = nsFile(ns, baseName)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

// ---- 最近服务器(用于 MCP 重启后未连接时定位聊天记录 / 免手填重连) ----
export function rememberServer(ns) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, 'last_server.json'), JSON.stringify({ ns: sanitizeNs(ns) }, null, 2), 'utf8')
  } catch { /* ignore */ }
}

export function lastServer() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'last_server.json'), 'utf8')).ns ?? null
  } catch {
    return null
  }
}

// 保存上次成功连接的完整信息(host/port/username/auth/version), 重启后免手填重连
export function saveLastConnection(info) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const data = {
      ns: sanitizeNs(`${info.host}:${info.port}`),
      host: info.host,
      port: info.port,
      username: info.username,
      auth: info.auth,
      version: info.version || null,
      time: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(DATA_DIR, 'last_server.json'), JSON.stringify(data, null, 2), 'utf8')
  } catch { /* ignore */ }
}

export function lastConnection() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'last_server.json'), 'utf8'))
    if (!d.host || !d.port) return null
    return d
  } catch {
    return null
  }
}

// ---- 路标 ----

export function listWaypoints(ns) {
  return loadEntries(ns, 'waypoints')
}

export function findWaypoint(ns, name) {
  const q = String(name).toLowerCase()
  return listWaypoints(ns).find((w) => String(w.name).toLowerCase() === q) ?? null
}

export function saveWaypoint(ns, { name, position, dimension, note }) {
  const entries = listWaypoints(ns)
  const existing = findWaypoint(ns, name)
  const fields = {
    name: String(name),
    position,
    dimension: dimension ?? existing?.dimension ?? null,
    note: note ?? existing?.note ?? null,
    time: new Date().toISOString(),
  }
  let entry
  if (existing) {
    entry = Object.assign(existing, fields)
  } else {
    entry = fields
    entries.push(entry)
  }
  persistEntries(ns, 'waypoints', entries)
  return entry
}

export function deleteWaypoint(ns, name) {
  const entries = listWaypoints(ns)
  const q = String(name).toLowerCase()
  const next = entries.filter((w) => String(w.name).toLowerCase() !== q)
  const removed = entries.length - next.length
  if (removed > 0) persistEntries(ns, 'waypoints', next)
  return removed
}

// ---- 建筑规划(按服务器命名空间持久化, 重启不丢) ----

export function listBuildingPlans(ns) {
  return loadEntries(ns, 'building')
}

export function findBuildingPlan(ns, name) {
  const q = String(name ?? '').toLowerCase()
  return listBuildingPlans(ns).find((p) => String(p.name ?? '').toLowerCase() === q) ?? null
}

export function saveBuildingPlanRecord(ns, plan) {
  const entries = listBuildingPlans(ns)
  const existing = findBuildingPlan(ns, plan.name)
  const fields = {
    name: String(plan.name ?? '未命名'),
    entries: plan.entries ?? [],
    created: plan.created ?? existing?.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
  }
  if (existing) {
    Object.assign(existing, fields)
  } else {
    entries.push(fields)
  }
  persistEntries(ns, 'building', entries)
  return fields
}

export function deleteBuildingPlan(ns, name) {
  const entries = listBuildingPlans(ns)
  const q = String(name ?? '').toLowerCase()
  const next = entries.filter((p) => String(p.name ?? '').toLowerCase() !== q)
  const removed = entries.length - next.length
  if (removed > 0) persistEntries(ns, 'building', next)
  return removed
}

// ---- 长期记忆 ----

export function listMemories(ns) {
  return loadEntries(ns, 'memory')
}

export function saveMemory(ns, { text, key, tags }) {
  const entries = listMemories(ns)
  let entry = key ? entries.find((m) => m.key === key) : null
  if (entry) {
    entry.text = text
    entry.tags = tags
    entry.updated = new Date().toISOString()
  } else {
    entry = {
      id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      key: key ?? null,
      tags,
      text,
      created: new Date().toISOString(),
      updated: null,
    }
    entries.push(entry)
  }
  persistEntries(ns, 'memory', entries)
  return entry
}

export function recallMemories(ns, query, limit = 20) {
  const entries = listMemories(ns)
  if (!query) return entries.slice(-limit).reverse()
  const q = String(query).toLowerCase()
  return entries
    .filter((m) =>
      m.text?.toLowerCase().includes(q)
      || m.key?.toLowerCase().includes(q)
      || (m.tags ?? []).some((t) => String(t).toLowerCase().includes(q)))
    .slice(-limit)
    .reverse()
}

export function forgetMemory(ns, ref) {
  const entries = listMemories(ns)
  const next = entries.filter((m) => m.id !== ref && m.key !== ref)
  const removed = entries.length - next.length
  if (removed > 0) persistEntries(ns, 'memory', next)
  return removed
}

// ---- 聊天记录(持久化, MCP 重启不丢) ----

export function appendChatLog(ns, entry) {
  try {
    const entries = loadEntries(ns, 'chatlog')
    entries.push(entry)
    if (entries.length > CHATLOG_CAP) entries.splice(0, entries.length - CHATLOG_CAP)
    persistEntries(ns, 'chatlog', entries)
  } catch { /* 磁盘问题不影响游戏 */ }
}

export function listChatLog(ns, { limit = 50, query = null } = {}) {
  let entries = loadEntries(ns, 'chatlog')
  if (query) {
    const q = String(query).toLowerCase()
    entries = entries.filter((e) =>
      (e.player ?? '').toLowerCase().includes(q)
      || (e.from ?? '').toLowerCase().includes(q)
      || (e.message ?? e.text ?? '').toLowerCase().includes(q))
  }
  return entries.slice(-Math.min(200, Math.max(1, limit))).reverse()
}
