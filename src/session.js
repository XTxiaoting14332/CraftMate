// 连接装配: MCP connect 工具与 Web 面板共用的完整连接流程
// 含掉线自动重连(指数退避)与手动断开标记
import { connectBot, disconnectBot, state, pushEvent } from './bot.js'
import { startDefense, stopDefense, defenseStatus } from './defense.js'
import { startHumanize, stopHumanize } from './humanize.js'
import { startDropPatrol, stopDropPatrol, dropPatrolStatus } from './drop-patrol.js'
import { startSocial, stopSocial } from './social.js'
import { startLighting, stopLighting } from './lighting.js'
import { rememberServer, sanitizeNs, saveLastConnection, lastConnection } from './store.js'
import { loadPersona, personaPromptText } from './persona.js'
import { contextSnapshot } from './context.js'
import { fmtPos, sleep } from './util.js'

let viewerPort = null
let manualDisconnect = false

export function viewerInfo() {
  return { enabled: Boolean(viewerPort), port: viewerPort }
}

// 3D 实况视图(prismarine-viewer): MC_VIEWER=1 时启用, 默认端口 3002
async function tryStartViewer(bot) {
  if (process.env.MC_VIEWER !== '1') return
  try {
    const mod = await import('prismarine-viewer')
    const plugin = mod.mineflayer ?? mod.default?.mineflayer
    const port = Number(process.env.MC_VIEWER_PORT || 3002)
    bot.loadPlugin(plugin)
    bot.viewer.listen(port)
    viewerPort = port
    bot.once('end', () => { if (viewerPort === port) viewerPort = null })
    console.error(`[minecraft-mcp] 3D 实况视图: http://127.0.0.1:${port} (局域网: http://<本机IP>:${port})`)
    try {
      const nets = require('node:os').networkInterfaces()
      for (const list of Object.values(nets)) {
        for (const n of list ?? []) {
          if (n.family === 'IPv4' && !n.internal) {
            console.error(`[minecraft-mcp] 手机/局域网 3D 实况: http://${n.address}:${port}`)
            break
          }
        }
      }
    } catch { /* ignore */ }
  } catch (err) {
    console.error('[minecraft-mcp] 3D 视图启动失败(可忽略):', err?.message ?? err)
  }
}

// 自动重连器: 指数退避(5s→10s→20s→40s→60s 封顶), 上限 MC_RECONNECT_MAX(默认 5)次。
// connectFn 由调用方注入(重连成功后 connectFull 会重新装配一切并挂新的 end 监听)
export function createReconnector(connectFn, opts = {}) {
  const base = opts.baseDelayMs ?? 5000
  const maxAttempts = opts.maxAttempts ?? Number(process.env.MC_RECONNECT_MAX || 5)
  const maxDelay = opts.maxDelayMs ?? 60000
  const sleepFn = opts.sleepFn ?? sleep
  let attempt = 0
  let cancelled = false
  let timer = null

  async function tryConnect() {
    if (cancelled || state.bot) return
    try {
      await connectFn()
      pushEvent('reconnected', { attempt })
    } catch {
      schedule()
    }
  }

  function schedule() {
    if (cancelled) return
    attempt += 1
    if (attempt > maxAttempts) {
      pushEvent('reconnect_gave_up', { attempts: maxAttempts })
      console.error(`[minecraft-mcp] 自动重连已达上限(${maxAttempts} 次), 放弃。可用 connect 手动重连。`)
      return
    }
    const delay = Math.min(maxDelay, base * 2 ** (attempt - 1))
    pushEvent('reconnecting', { attempt, max_attempts: maxAttempts, delay_seconds: Math.round(delay / 1000) })
    console.error(`[minecraft-mcp] 连接断开, ${Math.round(delay / 1000)}s 后自动重连(第 ${attempt}/${maxAttempts} 次)`)
    timer = setTimeout(() => { void tryConnect() }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    schedule,
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
    },
  }
}

let reconnector = null

export async function connectFull(a = {}) {
  manualDisconnect = false
  if (reconnector) {
    reconnector.cancel()
    reconnector = null
  }
  const isReconnect = Boolean(a.isReconnect)
  const opts = { ...a }
  delete opts.isReconnect

  // 没传 host 时用上次成功连接的配置(重启后免手填)
  if (!opts.host) {
    const last = lastConnection()
    if (last) {
      if (!opts.host) opts.host = last.host
      if (opts.port == null) opts.port = last.port
      if (!opts.username) opts.username = last.username
      if (!opts.auth) opts.auth = last.auth
      if (!opts.version && last.version) opts.version = last.version
    }
  }

  const info = await connectBot(opts)
  const ns = sanitizeNs(`${info.host}:${info.port}`)
  rememberServer(ns)
  saveLastConnection(info)
  startDefense(info.bot, {
    enabled: opts.auto_defense !== false,
    engageRadius: opts.defense_engage_radius ?? 8,
    fleeHp: opts.defense_flee_hp ?? 6,
    autoEat: opts.auto_eat !== false,
  })
  startHumanize(info.bot, info.humanize)
  startDropPatrol(info.bot, { enabled: opts.auto_pickup !== false })
  startSocial(info.bot, { enabled: opts.social !== false })
  startLighting(info.bot, { enabled: opts.auto_torch !== false })
  void tryStartViewer(info.bot)

  const persona = loadPersona()
  if (!isReconnect && persona.auto_greeting && persona.greeting) {
    const bot = info.bot
    setTimeout(() => {
      try { bot.chat(persona.greeting) } catch { /* ignore */ }
    }, 3000)
  }

  // 掉线自动重连(手动断开不触发)
  if (opts.auto_reconnect !== false) {
    reconnector = createReconnector(() => connectFull({ ...opts, isReconnect: true }))
    const rc = reconnector
    info.bot.once('end', () => {
      if (!manualDisconnect) rc.schedule()
    })
  }

  return {
    connected: true,
    server: { host: info.host, port: info.port, version: info.version },
    username: info.username,
    position: info.bot.entity ? fmtPos(info.bot.entity.position) : null,
    players: Object.keys(info.bot.players || {}).filter((n) => n !== info.username),
    auto_defense: defenseStatus(),
    drop_patrol: dropPatrolStatus(),
    fair_perception: info.fairPerception,
    humanize: info.humanize,
    auto_reconnect: opts.auto_reconnect !== false,
    persona: {
      name: persona.name || info.username,
      identity: persona.identity || undefined,
      speaking_style: persona.speaking_style || undefined,
      rules: persona.rules?.length ? persona.rules : undefined,
      greeting: persona.greeting || undefined,
    },
    persona_prompt: personaPromptText(info.username),
    context_snapshot: contextSnapshot(sanitizeNs(`${info.host}:${info.port}`)),
    tip: '恢复上下文: memory(recall, query="上次会话") 看上次总结; chatlog 看错过的聊天。全程按 persona 人设说话行事。',
  }
}

// 手动断开(面板/MCP disconnect 都走这里): 标记后自动重连不会触发
export async function disconnectFull() {
  manualDisconnect = true
  if (reconnector) {
    reconnector.cancel()
    reconnector = null
  }
  stopDefense()
  stopHumanize()
  stopDropPatrol()
  stopSocial()
  stopLighting()
  return disconnectBot()
}
