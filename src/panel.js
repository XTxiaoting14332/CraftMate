// Web 管理面板: 内置 HTTP 服务(默认 127.0.0.1:8765)
// 环境变量: MC_PANEL=0 关闭 | MC_PANEL_PORT 端口 | MC_PANEL_HOST 绑定地址
// 功能: 人设编辑 / 连接管理 / 状态总览 / 记忆与路标管理 / 聊天记录查看
import http from 'node:http'
import { state, currentNs } from './bot.js'
import { loadConfig, saveConfig, loadPersona } from './persona.js'
import { startAgent, stopAgent, agentStatus, refreshAgentPersona } from './agent.js'
import { connectFull, disconnectFull, viewerInfo } from './session.js'
import { nearbySummary } from './world.js'
import { scanTerrain } from './scan.js'
import * as store from './store.js'

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
  })
}

function statusPayload() {
  const bot = state.bot
  const ns = currentNs()
  const persona = loadPersona()
  return {
    connected: Boolean(bot && bot.entity),
    namespace: ns,
    persona_name: persona.name || '',
    agent: agentStatus(),
    bot: bot?.entity
      ? {
          username: bot.username,
          position: {
            x: Math.floor(bot.entity.position.x),
            y: Math.floor(bot.entity.position.y),
            z: Math.floor(bot.entity.position.z),
          },
          health: Math.round(bot.health ?? 20),
          food: bot.food ?? 20,
          version: bot.version ?? null,
        }
      : null,
    players: bot ? Object.keys(bot.players || {}).filter((n) => n !== bot.username) : [],
    current_task: state.task?.name ?? null,
    defense_active: state.defense?.active ?? false,
    counts: {
      memories: store.listMemories(ns).length,
      waypoints: store.listWaypoints(ns).length,
      chatlog: store.listChatLog(ns, { limit: 200 }).length,
    },
    activity: state.activity.slice(-60).reverse(),
  }
}

async function route(req, res, url) {
  const path = url.pathname
  const q = url.searchParams

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PANEL_HTML)
    return
  }
  if (path === '/api/vision') {
    const bot = state.bot
    if (!bot?.entity) return json(res, 200, { connected: false })
    try {
      const fair = state.options?.fairPerception !== false
      const e = bot.entity
      return json(res, 200, {
        connected: true,
        fair,
        self: {
          position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
          yaw: e.yaw,
          health: Math.round(bot.health ?? 20),
          food: bot.food ?? 20,
          held: bot.heldItem?.name ?? null,
        },
        scan: scanTerrain(bot, 10),
        nearby: nearbySummary(bot, 48, fair),
        viewer: viewerInfo(),
      })
    } catch (err) {
      return json(res, 200, { connected: false, error: String(err?.message || err) })
    }
  }
  if (path === '/api/status') return json(res, 200, statusPayload())
  if (path === '/api/events') {
    const limit = Math.min(300, Math.max(1, Number(q.get('limit')) || 100))
    return json(res, 200, { events: state.events.slice(-limit).reverse() })
  }
  if (path === '/api/config') {
    if (req.method === 'GET') return json(res, 200, loadConfig())
    if (req.method === 'POST') {
      const body = await readBody(req)
      const patch = {}
      if (body?.persona && typeof body.persona === 'object') patch.persona = body.persona
      if (body?.agent && typeof body.agent === 'object') patch.agent = body.agent
      if (!Object.keys(patch).length) return json(res, 400, { error: 'body 需要 { persona } 或 { agent } 对象' })
      const saved = saveConfig(patch)
      const personaRefresh = patch.persona ? refreshAgentPersona() : null
      return json(res, 200, { saved, persona_refresh: personaRefresh })
    }
  }
  if (path === '/api/agent') {
    if (req.method === 'GET') return json(res, 200, agentStatus())
    if (req.method === 'POST') {
      const b = await readBody(req)
      if (b.action === 'start') {
        const r = startAgent()
        return json(res, 200, { ...r, status: agentStatus() })
      }
      if (b.action === 'stop') return json(res, 200, stopAgent())
      return json(res, 400, { error: 'action 需为 start 或 stop' })
    }
  }
  if (path === '/api/chatlog') {
    const ns = currentNs(q.get('server') || undefined)
    return json(res, 200, { namespace: ns, entries: store.listChatLog(ns, { limit: Math.min(200, Number(q.get('limit')) || 100), query: q.get('query') }) })
  }
  if (path === '/api/memory') {
    const ns = currentNs(q.get('server') || undefined)
    if (req.method === 'GET') return json(res, 200, { namespace: ns, memories: store.listMemories(ns).reverse() })
    if (req.method === 'POST') {
      const b = await readBody(req)
      if (!b.text) return json(res, 400, { error: '需要 text' })
      const tags = typeof b.tags === 'string' ? b.tags.split(/[,，\s]+/).filter(Boolean) : (b.tags ?? [])
      return json(res, 200, { saved: store.saveMemory(ns, { text: String(b.text), key: b.key || null, tags }) })
    }
    if (req.method === 'DELETE') {
      const ref = q.get('id') || q.get('key')
      if (!ref) return json(res, 400, { error: '需要 id 或 key' })
      return json(res, 200, { removed: store.forgetMemory(ns, ref) })
    }
  }
  if (path === '/api/waypoints') {
    const ns = currentNs(q.get('server') || undefined)
    if (req.method === 'GET') return json(res, 200, { namespace: ns, waypoints: store.listWaypoints(ns) })
    if (req.method === 'POST') {
      const b = await readBody(req)
      if (!b.name) return json(res, 400, { error: '需要 name' })
      const position = Number.isFinite(Number(b.x)) && Number.isFinite(Number(b.y)) && Number.isFinite(Number(b.z))
        ? { x: Math.floor(Number(b.x)), y: Math.floor(Number(b.y)), z: Math.floor(Number(b.z)) }
        : (() => {
            const e = state.bot?.entity
            return e ? { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) } : null
          })()
      if (!position) return json(res, 400, { error: '未连接且未提供 x/y/z' })
      return json(res, 200, { saved: store.saveWaypoint(ns, { name: String(b.name), position, note: b.note || null }) })
    }
    if (req.method === 'DELETE') {
      const name = q.get('name')
      if (!name) return json(res, 400, { error: '需要 name' })
      return json(res, 200, { removed: store.deleteWaypoint(ns, name) })
    }
  }
  if (path === '/api/connect' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.host) return json(res, 400, { error: '需要 host' })
    try {
      return json(res, 200, await connectFull(b))
    } catch (err) {
      return json(res, 400, { error: String(err?.message || err) })
    }
  }
  if (path === '/api/disconnect' && req.method === 'POST') {
    return json(res, 200, await disconnectFull())
  }
  if (path === '/api/say' && req.method === 'POST') {
    const b = await readBody(req)
    if (!state.bot) return json(res, 400, { error: '未连接' })
    if (!b.message) return json(res, 400, { error: '需要 message' })
    state.bot.chat(String(b.message))
    return json(res, 200, { said: String(b.message) })
  }
  json(res, 404, { error: 'not found' })
}

export function startPanel() {
  if (process.env.MC_PANEL === '0') return
  const port = Number(process.env.MC_PANEL_PORT || 8765)
  // 默认绑定所有网卡(局域网/手机可访问); 面板无鉴权, 介意暴露可用 MC_PANEL_TOKEN 设访问令牌
  const host = process.env.MC_PANEL_HOST || '0.0.0.0'
  const token = process.env.MC_PANEL_TOKEN || ''
  // 可选访问令牌: 设了 MC_PANEL_TOKEN 后, 所有请求需带 ?token= 或 Authorization: Bearer
  const authOk = (req, url) => {
    if (!token) return true
    if (url.searchParams.get('token') === token) return true
    const h = req.headers.authorization || ''
    return h === `Bearer ${token}`
  }
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      if (!authOk(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'unauthorized', hint: '需要 ?token=<MC_PANEL_TOKEN> 或 Authorization: Bearer <MC_PANEL_TOKEN>' }))
        return
      }
      void route(req, res, url)
    } catch (err) {
      json(res, 500, { error: String(err?.message || err) })
    }
  })
  server.on('error', (err) => {
    console.error(`[minecraft-mcp] 面板启动失败(${host}:${port}):`, err?.message ?? err)
  })
  server.listen(port, host, () => {
    console.error(`[minecraft-mcp] 管理面板: http://${host}:${port}${token ? ' (已启用访问令牌 MC_PANEL_TOKEN)' : ''}`)
    // 绑 0.0.0.0 时打印本机局域网地址, 方便手机直接访问
    if (host === '0.0.0.0') {
      try {
        const nets = require('node:os').networkInterfaces()
        for (const list of Object.values(nets)) {
          for (const n of list ?? []) {
            if (n.family === 'IPv4' && !n.internal) {
              console.error(`[minecraft-mcp] 手机/局域网访问: http://${n.address}:${port}${token ? `?token=${token}` : ''}`)
              break
            }
          }
        }
      } catch { /* ignore */ }
    }
  })
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minecraft MCP 管理面板</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&family=Roboto+Mono:wght@400;500;600&family=Roboto:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --md-sys-color-primary: #a8c7fa;
    --md-sys-color-on-primary: #04316a;
    --md-sys-color-primary-container: #0842a0;
    --md-sys-color-on-primary-container: #d3e3fd;
    --md-sys-color-secondary: #7cd5be;
    --md-sys-color-on-secondary: #00382e;
    --md-sys-color-secondary-container: #005143;
    --md-sys-color-on-secondary-container: #98f2da;
    --md-sys-color-tertiary: #d0bcff;
    --md-sys-color-on-tertiary: #381e72;
    --md-sys-color-tertiary-container: #4f378b;
    --md-sys-color-on-tertiary-container: #e8def8;
    --md-sys-color-error: #ffb4ab;
    --md-sys-color-on-error: #690005;
    --md-sys-color-error-container: #93000a;
    --md-sys-color-on-error-container: #ffdad6;
    --md-sys-color-success: #6dd58c;
    --md-sys-color-on-success: #0a3818;
    --md-sys-color-success-container: #0f5228;
    --md-sys-color-on-success-container: #c4eed0;
    --md-sys-color-warning: #ffba28;
    --md-sys-color-on-warning: #412d00;
    --md-sys-color-warning-container: #5f4200;
    --md-sys-color-on-warning-container: #ffdf9e;
    --md-sys-color-background: #0f1115;
    --md-sys-color-on-background: #e2e2e9;
    --md-sys-color-surface: #12141a;
    --md-sys-color-on-surface: #e2e2e9;
    --md-sys-color-surface-variant: #44474e;
    --md-sys-color-on-surface-variant: #c4c6d0;
    --md-sys-color-outline: #8e9099;
    --md-sys-color-outline-variant: #2d3139;
    --md-sys-color-surface-container-lowest: #0a0c10;
    --md-sys-color-surface-container-low: #151820;
    --md-sys-color-surface-container: #1b1e27;
    --md-sys-color-surface-container-high: #242834;
    --md-sys-color-surface-container-highest: #2e3342;
    --md-sys-shape-corner-xs: 4px;
    --md-sys-shape-corner-sm: 8px;
    --md-sys-shape-corner-md: 12px;
    --md-sys-shape-corner-lg: 16px;
    --md-sys-shape-corner-xl: 20px;
    --md-sys-shape-corner-full: 9999px;
    --md-elevation-1: 0 1px 3px 1px rgba(0, 0, 0, 0.25), 0 1px 2px 0 rgba(0, 0, 0, 0.35);
    --md-elevation-2: 0 2px 6px 2px rgba(0, 0, 0, 0.28), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
    --md-elevation-3: 0 4px 12px 3px rgba(0, 0, 0, 0.35), 0 1px 3px 0 rgba(0, 0, 0, 0.45);
    --md-transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--md-sys-color-background);
    color: var(--md-sys-color-on-background);
    font-family: "Google Sans", "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* --- Top App Bar --- */
  header {
    background: var(--md-sys-color-surface-container-low);
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    padding: 0 24px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
    box-shadow: var(--md-elevation-1);
  }
  .app-brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .app-logo {
    width: 34px;
    height: 34px;
    background: linear-gradient(135deg, #1b4480 0%, #005143 100%);
    border-radius: var(--md-sys-shape-corner-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--md-sys-color-primary);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), 0 2px 4px rgba(0,0,0,0.3);
  }
  .app-logo svg { width: 22px; height: 22px; fill: currentColor; }
  header h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--md-sys-color-on-surface);
    letter-spacing: -0.2px;
  }
  .app-status {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--md-sys-color-surface-container-high);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-full);
    padding: 5px 14px;
    font-size: 13px;
  }
  #dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--md-sys-color-outline);
    transition: var(--md-transition);
  }
  #dot.on {
    background: var(--md-sys-color-success);
    box-shadow: 0 0 8px var(--md-sys-color-success);
    animation: pulse 2s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.65; transform: scale(0.88); }
  }
  #headinfo {
    font-weight: 500;
    color: var(--md-sys-color-on-surface);
  }
  #namespace {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 12px;
    font-family: "Roboto Mono", monospace;
  }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--md-sys-color-on-surface-variant);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: var(--md-transition);
  }
  .icon-btn:hover {
    background: var(--md-sys-color-surface-container-highest);
    color: var(--md-sys-color-on-surface);
  }
  .icon-btn svg { width: 18px; height: 18px; fill: currentColor; }

  /* --- M3 Navigation Tabs --- */
  nav#tabs {
    background: var(--md-sys-color-surface-container-low);
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    padding: 0 20px;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  nav#tabs::-webkit-scrollbar { display: none; }
  nav#tabs button {
    background: none;
    border: none;
    outline: none;
    color: var(--md-sys-color-on-surface-variant);
    padding: 12px 18px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    position: relative;
    border-radius: var(--md-sys-shape-corner-md) var(--md-sys-shape-corner-md) 0 0;
    transition: var(--md-transition);
    white-space: nowrap;
  }
  nav#tabs button svg { width: 18px; height: 18px; fill: currentColor; opacity: 0.7; transition: var(--md-transition); }
  nav#tabs button:hover {
    color: var(--md-sys-color-on-surface);
    background: rgba(255, 255, 255, 0.04);
  }
  nav#tabs button.active {
    color: var(--md-sys-color-primary);
  }
  nav#tabs button.active svg {
    opacity: 1;
    fill: var(--md-sys-color-primary);
  }
  nav#tabs button::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 12px;
    right: 12px;
    height: 3px;
    background: var(--md-sys-color-primary);
    border-radius: 3px 3px 0 0;
    transform: scaleX(0);
    transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1);
  }
  nav#tabs button.active::after {
    transform: scaleX(1);
  }

  /* --- Main Content Layout --- */
  main {
    flex: 1;
    max-width: 1120px;
    width: 100%;
    margin: 0 auto;
    padding: 24px 20px 48px;
  }
  section {
    display: none;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.25s ease, transform 0.25s ease;
  }
  section.active {
    display: block;
    opacity: 1;
    transform: translateY(0);
  }

  /* --- M3 Cards --- */
  .card {
    background: var(--md-sys-color-surface-container);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-lg);
    padding: 22px 24px;
    margin-bottom: 20px;
    box-shadow: var(--md-elevation-1);
    transition: var(--md-transition);
  }
  .card:hover {
    border-color: rgba(255, 255, 255, 0.12);
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .card h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--md-sys-color-on-surface);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card h3 svg { width: 18px; height: 18px; fill: var(--md-sys-color-primary); }

  /* --- Form Inputs (Outlined Material Text Fields) --- */
  .m3-field {
    margin-bottom: 14px;
  }
  label {
    display: block;
    margin-bottom: 6px;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 13px;
    font-weight: 500;
  }
  input[type=text], input[type=number], input[type=password], textarea, select {
    width: 100%;
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    color: var(--md-sys-color-on-surface);
    border-radius: var(--md-sys-shape-corner-sm);
    padding: 10px 14px;
    font-family: inherit;
    font-size: 14px;
    outline: none;
    transition: var(--md-transition);
  }
  input[type=text]:hover, input[type=number]:hover, input[type=password]:hover, textarea:hover, select:hover {
    border-color: var(--md-sys-color-outline);
  }
  input[type=text]:focus, input[type=number]:focus, input[type=password]:focus, textarea:focus, select:focus {
    border-color: var(--md-sys-color-primary);
    box-shadow: 0 0 0 3px rgba(168, 199, 250, 0.15);
    background: var(--md-sys-color-surface-container-low);
  }
  textarea {
    min-height: 84px;
    resize: vertical;
    line-height: 1.6;
  }
  select {
    cursor: pointer;
  }

  .row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .row > div {
    flex: 1;
    min-width: 160px;
  }
  .key-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .key-wrap input {
    min-width: 0;
  }

  /* --- Checkbox / Switches --- */
  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 14px;
    color: var(--md-sys-color-on-surface);
    user-select: none;
    margin: 8px 0;
  }
  .checkbox-label input[type=checkbox] {
    appearance: none;
    -webkit-appearance: none;
    width: 20px;
    height: 20px;
    background: var(--md-sys-color-surface-container-lowest);
    border: 2px solid var(--md-sys-color-outline);
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    transition: var(--md-transition);
  }
  .checkbox-label input[type=checkbox]:checked {
    background: var(--md-sys-color-primary);
    border-color: var(--md-sys-color-primary);
  }
  .checkbox-label input[type=checkbox]:checked::after {
    content: "✓";
    font-size: 13px;
    font-weight: 700;
    color: var(--md-sys-color-on-primary);
  }

  /* --- M3 Buttons --- */
  .btn-group {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  button.primary {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    border-radius: var(--md-sys-shape-corner-full);
    padding: 10px 22px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    box-shadow: var(--md-elevation-1);
    transition: var(--md-transition);
  }
  button.primary:hover {
    filter: brightness(1.08);
    box-shadow: var(--md-elevation-2);
  }
  button.primary:active {
    transform: scale(0.98);
  }

  button.mini, .btn-tonal {
    background: var(--md-sys-color-surface-container-high);
    color: var(--md-sys-color-on-surface);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-full);
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: var(--md-transition);
  }
  button.mini:hover, .btn-tonal:hover {
    background: var(--md-sys-color-surface-container-highest);
    border-color: var(--md-sys-color-outline);
    color: #fff;
  }
  button.mini:active, .btn-tonal:active {
    transform: scale(0.98);
  }
  .btn-danger {
    background: rgba(242, 184, 181, 0.12) !important;
    color: var(--md-sys-color-error) !important;
    border-color: rgba(242, 184, 181, 0.25) !important;
  }
  .btn-danger:hover {
    background: var(--md-sys-color-error) !important;
    color: var(--md-sys-color-on-error) !important;
    border-color: var(--md-sys-color-error) !important;
  }

  /* --- Status Chips & Stat Grid --- */
  .kv {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }
  .stat-chip {
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: var(--md-transition);
  }
  .stat-chip:hover {
    border-color: var(--md-sys-color-outline);
    background: var(--md-sys-color-surface-container-low);
  }
  .stat-label {
    font-size: 12px;
    color: var(--md-sys-color-on-surface-variant);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stat-val {
    font-size: 15px;
    font-weight: 600;
    color: var(--md-sys-color-on-surface);
    font-family: "Roboto Mono", monospace;
  }

  /* --- Lists (Memory & Waypoints) --- */
  ul.list {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    max-height: 440px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  ul.list li {
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    transition: var(--md-transition);
  }
  ul.list li:hover {
    border-color: var(--md-sys-color-outline);
    background: var(--md-sys-color-surface-container-low);
  }
  ul.list li .meta {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 12px;
    margin-top: 4px;
    font-family: "Roboto Mono", monospace;
  }
  .empty-state {
    text-align: center;
    color: var(--md-sys-color-on-surface-variant);
    padding: 24px 0;
    font-size: 13px;
  }

  /* --- Chat & Events Log --- */
  .msg-container {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    max-height: 520px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .msg {
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-sm);
    padding: 8px 12px;
    font-size: 13px;
    line-height: 1.5;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    transition: var(--md-transition);
  }
  .msg:hover {
    background: var(--md-sys-color-surface-container-low);
  }
  .msg.whisper {
    background: rgba(255, 186, 40, 0.08);
    border-color: rgba(255, 186, 40, 0.3);
  }
  .msg .t {
    color: var(--md-sys-color-on-surface-variant);
    font-family: "Roboto Mono", monospace;
    font-size: 11px;
    flex-shrink: 0;
    padding-top: 2px;
  }
  .msg .who {
    font-weight: 600;
    color: var(--md-sys-color-primary);
    flex-shrink: 0;
  }
  .msg.whisper .who {
    color: var(--md-sys-color-warning);
  }
  .ev-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--md-sys-shape-corner-xs);
    background: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
    margin-right: 6px;
  }

  /* --- AI Vision HUD --- */
  .vision-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .canvas-wrapper {
    position: relative;
    border-radius: var(--md-sys-shape-corner-md);
    overflow: hidden;
    box-shadow: var(--md-elevation-2);
    border: 1px solid var(--md-sys-color-outline-variant);
    background: #08090c;
  }
  #vision-canvas {
    display: block;
    max-width: 100%;
    image-rendering: pixelated;
  }
  .hud-badge {
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-full);
    padding: 6px 16px;
    font-size: 12px;
    font-family: "Roboto Mono", monospace;
    color: var(--md-sys-color-on-surface);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .legend-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    padding: 10px 14px;
    font-size: 12px;
    color: var(--md-sys-color-on-surface-variant);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  /* --- Hint / Footnote --- */
  .hint {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 12px;
    margin-top: 10px;
    line-height: 1.5;
  }
  code {
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: "Roboto Mono", monospace;
    font-size: 12px;
    color: var(--md-sys-color-primary);
  }

  /* --- M3 Toast / Snackbar --- */
  #toast {
    position: fixed;
    bottom: 28px;
    right: 28px;
    background: var(--md-sys-color-surface-container-highest);
    color: var(--md-sys-color-on-surface);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-sm);
    padding: 12px 20px;
    box-shadow: var(--md-elevation-3);
    display: none;
    font-size: 14px;
    font-weight: 500;
    z-index: 1000;
    align-items: center;
    gap: 10px;
    animation: slideUp 0.25s cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 768px) {
    header { padding: 0 16px; height: 56px; }
    main { padding: 16px 12px 36px; }
    .card { padding: 16px; border-radius: var(--md-sys-shape-corner-md); }
    .row > div { min-width: 100%; }
  }
</style>
</head>
<body>

<header>
  <div class="app-brand">
    <div class="app-logo">
      <svg viewBox="0 0 24 24"><path d="M21 16.5C21 16.88 20.79 17.21 20.47 17.38L12.57 21.82C12.41 21.94 12.21 22 12 22C11.79 22 11.59 21.94 11.43 21.82L3.53 17.38C3.21 17.21 3 16.88 3 16.5V7.5C3 7.12 3.21 6.79 3.53 6.62L11.43 2.18C11.59 2.06 11.79 2 12 2C12.21 2 12.41 2.06 12.57 2.18L20.47 6.62C20.79 6.79 21 7.12 21 7.5V16.5M12 4.15L6.04 7.5L12 10.85L17.96 7.5L12 4.15M5 15.91L11 19.29V12.58L5 9.21V15.91M19 15.91V9.21L13 12.58V19.29L19 15.91Z"/></svg>
    </div>
    <h1>Minecraft MCP 管理面板</h1>
  </div>
  <div class="app-status">
    <div class="status-badge">
      <div id="dot"></div>
      <span id="headinfo">未连接</span>
      <span id="namespace"></span>
    </div>
    <button class="icon-btn" title="手动刷新" onclick="refresh();toast('已刷新状态')">
      <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
    </button>
  </div>
</header>

<nav id="tabs">
  <button data-t="conn" class="active">
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
    连接与状态
  </button>
  <button data-t="vision">
    <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
    AI 视野
  </button>
  <button data-t="agent">
    <svg viewBox="0 0 24 24"><path d="M13 2.05v3.03c3.39.49 6 3.39 6 6.92 0 .9-.18 1.75-.48 2.54l2.6 1.53c.56-1.24.88-2.62.88-4.07 0-5.18-3.95-9.45-9-9.95zM12 19c-3.87 0-7-3.13-7-7 0-3.53 2.61-6.43 6-6.92V2.05c-5.06.5-9 4.76-9 9.95 0 5.52 4.47 10 9.99 10 3.31 0 6.24-1.61 8.01-4.09l-2.45-1.44C16.27 17.84 14.28 19 12 19z"/></svg>
    自主运行
  </button>
  <button data-t="persona">
    <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
    人设
  </button>
  <button data-t="mem">
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
    记忆与路标
  </button>
  <button data-t="chat">
    <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>
    聊天记录
  </button>
  <button data-t="events">
    <svg viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
    事件流
  </button>
</nav>

<main>

<!-- 1. 连接与状态 -->
<section id="sec-conn" class="active">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
        连接 Minecraft 服务器
      </h3>
    </div>
    <div class="row">
      <div><label>服务器地址</label><input type="text" id="c-host" placeholder="127.0.0.1"></div>
      <div><label>端口</label><input type="number" id="c-port" value="25565"></div>
      <div><label>玩家名</label><input type="text" id="c-user" value="AI_Player"></div>
    </div>
    <div class="row">
      <div><label>版本 (留空自动检测)</label><input type="text" id="c-ver" placeholder="1.20.4"></div>
      <div>
        <label>登录方式</label>
        <select id="c-auth">
          <option value="offline">offline (离线模式)</option>
          <option value="microsoft">microsoft (微软正版)</option>
        </select>
      </div>
    </div>
    <div class="btn-group">
      <button class="primary" onclick="doConnect()">
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
        连接
      </button>
      <button class="mini btn-danger" onclick="api('/api/disconnect','POST')">
        <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        断开连接
      </button>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
        运行状态 (每 3 秒刷新)
      </h3>
    </div>
    <div id="status" class="kv"></div>
  </div>

  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
        机器人身份发言 (测试人设)
      </h3>
    </div>
    <div class="row">
      <div style="flex:1"><input type="text" id="say" placeholder="输入要发送的聊天消息，按回车或点击发送" onkeydown="if(event.key==='Enter')doSay()"></div>
    </div>
    <div class="btn-group">
      <button class="primary" onclick="doSay()">发送消息</button>
    </div>
  </div>
</section>

<!-- 2. AI 视野 -->
<section id="sec-vision">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
        AI 视野与环境感知 (实时可视化 AI 感知数据: 高度图 + 实体, 每 1.5 秒刷新)
      </h3>
    </div>
    <div class="vision-box">
      <div class="canvas-wrapper">
        <canvas id="vision-canvas" width="520" height="520"></canvas>
      </div>
      <div class="hud-badge" id="vision-info">未连接</div>
      <div class="legend-grid">
        <div class="legend-item"><div class="legend-dot" style="background:#4f9cf9"></div>玩家 (名称/距离)</div>
        <div class="legend-item"><div class="legend-dot" style="background:#e05252"></div>敌对生物</div>
        <div class="legend-item"><div class="legend-dot" style="background:#c9cdc4"></div>被动生物</div>
        <div class="legend-item"><div class="legend-dot" style="background:#e0c341"></div>掉落物</div>
        <div class="legend-item"><div class="legend-dot" style="background:#b06fd8"></div>命名实体/NPC</div>
        <div class="legend-item"><div class="legend-dot" style="background:#3d5a3d"></div>地形 (绿=同高, 红=更高, 蓝=更低, ~=水, !=岩浆, @=树)</div>
      </div>
    </div>
  </div>
  <div class="card" id="viewer-card" style="display:none">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M21 16.5C21 16.88 20.79 17.21 20.47 17.38L12.57 21.82C12.41 21.94 12.21 22 12 22C11.79 22 11.59 21.94 11.43 21.82L3.53 17.38C3.21 17.21 3 16.88 3 16.5V7.5C3 7.12 3.21 6.79 3.53 6.62L11.43 2.18C11.59 2.06 11.79 2 12 2C12.21 2 12.41 2.06 12.57 2.18L20.47 6.62C20.79 6.79 21 7.12 21 7.5V16.5M12 4.15L6.04 7.5L12 10.85L17.96 7.5L12 4.15M5 15.91L11 19.29V12.58L5 9.21V15.91M19 15.91V9.21L13 12.58V19.29L19 15.91Z"/></svg>
        3D 实况视图 (prismarine-viewer, 支持拖拽旋转与缩放)
      </h3>
    </div>
    <iframe id="viewer-frame" style="width:100%;height:480px;border:1px solid var(--md-sys-color-outline-variant);border-radius:var(--md-sys-shape-corner-md);background:#000"></iframe>
    <div class="hint">提示: 以 <code>MC_VIEWER=1</code> 启动 (通过 <code>MC_VIEWER_PORT</code> 修改端口) 即可开启 3D 实况视图。</div>
  </div>
</section>

<!-- 3. 自主运行 -->
<section id="sec-agent">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        自主运行配置 (内置 Agent 循环直接调用 OpenAI 兼容 API, 全自动游玩)
      </h3>
    </div>
    <div class="row">
      <div><label>API 地址 (OpenAI 兼容 /v1)</label><input type="text" id="a-base" placeholder="https://api.deepseek.com/v1"></div>
      <div><label>模型名称</label><input type="text" id="a-model" placeholder="deepseek-chat / glm-4-flash / qwen2.5 ..."></div>
    </div>
    <div class="row">
      <div><label>API Key</label><div class="key-wrap"><input type="password" id="a-key" placeholder="sk-..." style="flex:1"><button class="mini" onclick="copyApiKey()" title="复制 API Key">⧉ 复制</button></div></div>
      <div><label>Temperature (多样性)</label><input type="number" id="a-temp" step="0.1" value="0.8"></div>
      <div><label>Max Tokens</label><input type="number" id="a-tokens" value="2048"></div>
    </div>
    <div>
      <label class="checkbox-label">
        <input type="checkbox" id="a-auto">
        随 MCP 启动自动开始自主运行 (auto_start)
      </label>
    </div>
    <div class="btn-group">
      <button class="primary" onclick="saveAgentCfg()">保存配置</button>
      <button class="mini" onclick="agentCtl('start')">▶ 启动 Agent</button>
      <button class="mini btn-danger" onclick="agentCtl('stop')">■ 停止</button>
    </div>
    <div class="hint">兼容任何 OpenAI 格式端点: DeepSeek / GLM / Kimi / 通义千问 / 本地 Ollama (<code>http://127.0.0.1:11434/v1</code>) 等。纯独立运行模式: <code>MC_MCP=0 npm start</code>。</div>
  </div>

  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
        Agent 实时状态 (每 3 秒刷新)
      </h3>
    </div>
    <div id="agent-status" class="kv"></div>
    <div class="hint" id="agent-last" style="white-space:pre-wrap;margin-top:14px"></div>
  </div>

  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M4 4h16v2H4V4zm0 4h16v2H4V8zm0 4h16v2H4v-2zm0 4h10v2H4v-2z"/></svg>
        Agent 思考与工具日志 (思考/推理/工具调用/结果)
      </h3>
    </div>
    <div id="agent-log" style="max-height:420px;overflow:auto;background:var(--md-sys-color-surface-container-lowest);border:1px solid var(--md-sys-color-outline-variant);border-radius:8px;padding:12px;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap"></div>
  </div>
</section>

<!-- 4. 人设 -->
<section id="sec-persona">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        AI 玩家人设 (config.json, 保存后 Prompt/Status/运行中 Agent 立即生效)
      </h3>
    </div>
    <div class="row">
      <div><label>角色名 (留空使用机器人用户名)</label><input type="text" id="p-name"></div>
      <div style="display:flex;align-items:flex-end">
        <label class="checkbox-label" style="margin-bottom:12px">
          <input type="checkbox" id="p-auto">
          进服 3 秒后自动发送问候语
        </label>
      </div>
    </div>
    <div class="m3-field"><label>人设身份</label><textarea id="p-identity" placeholder="例: 17 岁萌新玩家, 喜欢挖矿和养动物"></textarea></div>
    <div class="m3-field"><label>说话方式</label><textarea id="p-style" placeholder="例: 口语化短句, 爱用语气词, 不用书面语"></textarea></div>
    <div class="m3-field"><label>背景故事</label><textarea id="p-bg" placeholder="例: 来自远方村庄的冒险者..."></textarea></div>
    <div class="m3-field"><label>行为守则 (每行一条)</label><textarea id="p-rules" placeholder="例:\n不随意破坏其他玩家建筑\n遇到危险优先寻求庇护"></textarea></div>
    <div class="m3-field"><label>问候语</label><input type="text" id="p-greet" placeholder="例: 大家好呀，我是新来的冒险者！"></div>
    <div class="btn-group">
      <button class="primary" onclick="savePersona()">保存人设</button>
    </div>
    <div class="hint">MCP 客户端可通过 prompts (get "persona") 或 persona 工具拉取完整人设 Prompt; connect 返回 persona_prompt 全文, status 带摘要。保存会同步刷新运行中的自主 Agent。</div>
  </div>
</section>

<!-- 5. 记忆与路标 -->
<section id="sec-mem">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        长期记忆管理
      </h3>
    </div>
    <div class="row">
      <div style="flex:2"><label>记忆内容</label><input type="text" id="m-text" placeholder="输入要记住的信息..."></div>
      <div><label>Key 唯一标识 (可选)</label><input type="text" id="m-key" placeholder="例如: base_coord"></div>
    </div>
    <div class="btn-group">
      <button class="primary" onclick="addMemory()">记住该信息</button>
    </div>
    <ul class="list" id="mem-list"></ul>
  </div>

  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        路标管理
      </h3>
    </div>
    <div class="row">
      <div><label>路标名称</label><input type="text" id="w-name" placeholder="主基地 / 矿洞入口"></div>
      <div><label>X 坐标</label><input type="number" id="w-x" placeholder="当前位置"></div>
      <div><label>Y 坐标</label><input type="number" id="w-y" placeholder="当前位置"></div>
      <div><label>Z 坐标</label><input type="number" id="w-z" placeholder="当前位置"></div>
    </div>
    <div class="hint">提示: 坐标全部留空将自动保存机器人当前所在位置。</div>
    <div class="btn-group">
      <button class="primary" onclick="addWaypoint()">保存路标</button>
    </div>
    <ul class="list" id="wp-list"></ul>
  </div>
</section>

<!-- 6. 聊天记录 -->
<section id="sec-chat">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>
        持久化聊天记录 (当前服务器命名空间)
      </h3>
    </div>
    <div class="row">
      <div style="flex:2"><label>关键词过滤</label><input type="text" id="cl-q" placeholder="搜索玩家发言或系统消息..."></div>
      <div><label>加载条数</label><input type="number" id="cl-n" value="100"></div>
    </div>
    <div class="btn-group">
      <button class="primary" onclick="loadChat()">查询聊天记录</button>
    </div>
    <div id="chat-list" class="msg-container"></div>
  </div>
</section>

<!-- 7. 事件流 -->
<section id="sec-events">
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
        本次会话事件流 (实时内存缓冲)
      </h3>
    </div>
    <div id="ev-list" class="msg-container"></div>
  </div>
</section>

</main>

<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id)
let ns = ''

document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'))
  document.querySelectorAll('main section').forEach((x) => x.classList.remove('active'))
  b.classList.add('active')
  const sec = $('sec-' + b.dataset.t)
  if (sec) sec.classList.add('active')
})

function toast(msg) {
  const t = $('toast')
  t.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:var(--md-sys-color-primary)"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> ' + esc(msg)
  t.style.display = 'inline-flex'
  clearTimeout(t._timer)
  t._timer = setTimeout(() => { t.style.display = 'none' }, 2400)
}

async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    toast('错误: ' + (d.error || r.status))
    throw new Error(d.error || r.status)
  }
  return d
}

async function refresh() {
  try {
    const s = await api('/api/status')
    $('dot').classList.toggle('on', s.connected)
    $('headinfo').textContent = s.connected ? (s.bot.username + ' @ ' + (s.bot.version || '')) : '未连接'
    ns = s.namespace
    $('namespace').textContent = '[' + s.namespace + ']'
    // 重启后预填上次连接信息, 免手填(只在输入框为空时)
    const lc = s.last_connection
    if (lc && !s.connected) {
      if (!$('c-host').value.trim()) $('c-host').value = lc.host || ''
      if (!$('c-port').value) $('c-port').value = lc.port || 25565
      if (!$('c-user').value.trim()) $('c-user').value = lc.username || ''
    }
    const b = s.bot
    $('status').innerHTML = [
      b ? '<div class="stat-chip"><div class="stat-label">📍 位置坐标</div><div class="stat-val">' + b.position.x + ', ' + b.position.y + ', ' + b.position.z + '</div></div>' : '',
      b ? '<div class="stat-chip"><div class="stat-label">❤️ 生命 / 🍖 饱食</div><div class="stat-val">' + b.health + ' / 20 &nbsp;·&nbsp; ' + b.food + ' / 20</div></div>' : '',
      '<div class="stat-chip"><div class="stat-label">👥 在线玩家 (' + s.players.length + ')</div><div class="stat-val">' + (s.players.length ? esc(s.players.join(', ')) : '无其他玩家') + '</div></div>',
      '<div class="stat-chip"><div class="stat-label">🎯 当前任务</div><div class="stat-val">' + (s.current_task ? esc(s.current_task) : '空闲 / 待命') + '</div></div>',
      '<div class="stat-chip"><div class="stat-label">🛡️ 自动防御</div><div class="stat-val">' + (s.defense_active ? '● 执行中' : '○ 待命') + '</div></div>',
      '<div class="stat-chip"><div class="stat-label">⚡ Agent 引擎</div><div class="stat-val">' + (s.agent?.running ? '<span style="color:var(--md-sys-color-success)">● 运行中</span>' : '○ 停止') + '</div></div>',
      '<div class="stat-chip"><div class="stat-label">📦 数据统计</div><div class="stat-val">记忆 ' + s.counts.memories + ' · 路标 ' + s.counts.waypoints + ' · 聊天 ' + s.counts.chatlog + '</div></div>',
    ].join('')
    renderAgent(s.agent, s.activity)
  } catch { /* ignore */ }
}
setInterval(refresh, 3000)
refresh()

async function loadPersonaForm() {
  const d = await api('/api/config')
  const p = d.persona || {}
  const a = d.agent || {}
  $('p-name').value = p.name || ''
  $('p-identity').value = p.identity || ''
  $('p-style').value = p.speaking_style || ''
  $('p-bg').value = p.background_story || ''
  $('p-rules').value = (p.rules || []).join('\\n')
  $('p-greet').value = p.greeting || ''
  $('p-auto').checked = Boolean(p.auto_greeting)
  $('a-base').value = a.api_base || ''
  $('a-model').value = a.model || ''
  $('a-key').value = a.api_key || ''
  $('a-temp').value = a.temperature ?? 0.8
  $('a-tokens').value = a.max_tokens ?? 2048
  $('a-auto').checked = Boolean(a.auto_start)
}

async function savePersona() {
  const persona = {
    name: $('p-name').value.trim(),
    identity: $('p-identity').value.trim(),
    speaking_style: $('p-style').value.trim(),
    background_story: $('p-bg').value.trim(),
    rules: $('p-rules').value.split('\\n').map((s) => s.trim()).filter(Boolean),
    greeting: $('p-greet').value.trim(),
    auto_greeting: $('p-auto').checked,
  }
  await api('/api/config', 'POST', { persona })
  toast('人设已保存')
}

async function copyApiKey() {
  const val = ($('a-key').value || '').trim()
  if (!val) return toast('API Key 为空, 没什么可复制的')
  try {
    await navigator.clipboard.writeText(val)
    toast('API Key 已复制')
  } catch {
    // 剪贴板 API 不可用时(非 https/权限), 退回选中输入框文本让用户手动复制
    $('a-key').select()
    toast('请手动复制(已为你选中)')
  }
}

async function saveAgentCfg() {
  const agent = {
    api_base: $('a-base').value.trim(),
    model: $('a-model').value.trim(),
    api_key: $('a-key').value.trim(),
    temperature: Number($('a-temp').value) || 0.8,
    max_tokens: Number($('a-tokens').value) || 2048,
    auto_start: $('a-auto').checked,
  }
  await api('/api/config', 'POST', { agent })
  toast('Agent 配置已保存')
}

async function agentCtl(action) {
  const d = await api('/api/agent', 'POST', { action })
  toast(action === 'start' ? 'Agent 已启动' : 'Agent 停止中')
  refresh()
}

function renderAgent(a, activity) {
  if (!a) return
  const cacheTotal = (a.cache_hit_tokens ?? 0) + (a.cache_miss_tokens ?? 0)
  const cacheLabel = a.cache_measured_calls
    ? (a.cache_hit_rate ?? 0) + '% (' + (a.cache_hit_tokens ?? 0) + '/' + cacheTotal + ' tok, ' + a.cache_measured_calls + ' 次)'
    : '— (API 未返回缓存用量)'
  $('agent-status').innerHTML = [
    '<div class="stat-chip"><div class="stat-label">运行状态</div><div class="stat-val">' + (a.running ? '<span style="color:var(--md-sys-color-success)">● 运行中</span>' : '○ 停止') + '</div></div>',
    '<div class="stat-chip"><div class="stat-label">模型</div><div class="stat-val">' + esc(a.model || '未配置') + '</div></div>',
    '<div class="stat-chip"><div class="stat-label">已运行时间</div><div class="stat-val">' + (a.elapsed_minutes ?? 0) + ' 分钟</div></div>',
    '<div class="stat-chip"><div class="stat-label">API / 工具调用</div><div class="stat-val">' + a.calls + ' 次 / ' + a.tool_calls + ' 次</div></div>',
    '<div class="stat-chip"><div class="stat-label">缓存命中率</div><div class="stat-val">' + cacheLabel + '</div></div>',
    '<div class="stat-chip"><div class="stat-label">习惯学习</div><div class="stat-val">惯性 ' + (a.habit_execs ?? 0) + ' 次 / 样本 ' + (a.habits?.samples ?? 0) + '</div></div>',
  ].join('')
  $('agent-last').textContent = (a.last_error ? '⚠ ' + a.last_error + '\\n' : '') + (a.last_action ? '最近动作: ' + a.last_action : '')
    + (a.habits?.patterns?.length ? '\\n已学模式: ' + a.habits.patterns.slice(0, 5).map((p) => p.after + ' ⇒ ' + p.next + ' (' + p.confidence + '%)').join(' | ') : '')
  const labels = { reasoning: '推理', thinking: '思考', tool_call: '工具调用', tool_result: '工具结果', idle: '待机', system: '系统' }
  const colors = { reasoning: '#c792ea', thinking: '#82aaff', tool_call: '#ffcb6b', tool_result: '#89ddff', idle: '#b0bec5', system: '#f78c6c' }
  $('agent-log').innerHTML = (activity || []).map((e) => {
    const t = (e.time || '').slice(11, 19)
    const label = labels[e.kind] || e.kind || '事件'
    const color = colors[e.kind] || '#b0bec5'
    const text = e.kind === 'tool_call'
      ? (e.name || '') + ' ' + (e.args || '')
      : e.kind === 'tool_result'
        ? (e.name || '') + ': ' + (e.summary || '')
        : (e.text || '')
    return '<div style="padding:5px 0;border-bottom:1px dashed var(--md-sys-color-outline-variant)"><span style="color:var(--md-sys-color-on-surface-variant)">' + t + '</span> <b style="color:' + color + '">[' + label + ']</b> ' + esc(text) + '</div>'
  }).join('') || '<div style="color:var(--md-sys-color-on-surface-variant)">暂无日志。自主 Agent 思考或任何工具调用后这里会实时出现。</div>'
}

async function loadMem() {
  const d = await api('/api/memory')
  $('mem-list').innerHTML = d.memories.map((m) =>
    '<li><div><b style="font-weight:600;color:var(--md-sys-color-on-surface)">' + esc(m.text) + '</b><div class="meta">' + (m.key ? '<span class="ev-badge">key: ' + esc(m.key) + '</span>' : '') + ((m.tags || []).length ? ' 🏷️ ' + esc(m.tags.join(', ')) : '') + '</div></div>' +
    '<button class="mini btn-danger" onclick="delMemory(\\'' + (m.key || m.id) + '\\')">删除</button></li>').join('') || '<div class="empty-state">暂无记忆记录</div>'
  const w = await api('/api/waypoints')
  $('wp-list').innerHTML = w.waypoints.map((x) =>
    '<li><div><b style="font-weight:600;color:var(--md-sys-color-on-surface)">' + esc(x.name) + '</b> <span class="meta">(' + x.position.x + ', ' + x.position.y + ', ' + x.position.z + ')</span>' +
    (x.note ? '<div class="meta">' + esc(x.note) + '</div>' : '') + '</div>' +
    '<button class="mini btn-danger" onclick="delWp(\\'' + esc(x.name) + '\\')">删除</button></li>').join('') || '<div class="empty-state">暂无路标记录</div>'
}

async function addMemory() {
  const val = $('m-text').value.trim()
  if (!val) return toast('请输入记忆内容')
  await api('/api/memory', 'POST', { text: val, key: $('m-key').value.trim() || null })
  $('m-text').value = ''
  $('m-key').value = ''
  toast('已记住')
  loadMem()
}

async function delMemory(ref) {
  await api('/api/memory?key=' + encodeURIComponent(ref), 'DELETE')
  toast('记忆已删除')
  loadMem()
}

async function addWaypoint() {
  const name = $('w-name').value.trim()
  if (!name) return toast('请输入路标名称')
  const body = { name }
  if ($('w-x').value !== '') { body.x = $('w-x').value; body.y = $('w-y').value; body.z = $('w-z').value }
  await api('/api/waypoints', 'POST', body)
  $('w-name').value = ''
  toast('路标已保存')
  loadMem()
}

async function delWp(name) {
  await api('/api/waypoints?name=' + encodeURIComponent(name), 'DELETE')
  toast('路标已删除')
  loadMem()
}

async function loadChat() {
  const d = await api('/api/chatlog?limit=' + ($('cl-n').value || 100) + ($('cl-q').value ? '&query=' + encodeURIComponent($('cl-q').value) : ''))
  $('chat-list').innerHTML = d.entries.map((e) => {
    const who = e.type === 'self_chat' ? (e.to ? '我→' + e.to : '我') : (e.player || e.from || '系统')
    const t = (e.time || '').slice(11, 19)
    return '<div class="msg' + (e.type === 'whisper' ? ' whisper' : '') + '"><span class="t">' + t + '</span><span class="who">' + esc(who) + ':</span> <span>' + esc(e.message || e.text || '') + '</span></div>'
  }).join('') || '<div class="empty-state">暂无聊天记录</div>'
}

async function loadEvents() {
  const d = await api('/api/events?limit=80')
  $('ev-list').innerHTML = d.events.map((e) =>
    '<div class="msg"><span class="t">' + (e.time || '').slice(11, 19) + '</span><span class="ev-badge">' + e.type + '</span> <span>' + esc(sumEvent(e)) + '</span></div>').join('') || '<div class="empty-state">暂无事件记录</div>'
}

function sumEvent(e) {
  if (e.type === 'chat') return e.player + ': ' + e.message
  if (e.type === 'whisper') return e.from + ' → 你: ' + e.message
  if (e.type === 'system' || e.type === 'action_bar') return e.text
  if (e.type === 'damaged') return '受到伤害，剩余生命 ' + e.health
  if (e.type === 'auto_defense') return e.action + (e.reason ? ' (' + e.reason + ')' : '')
  return JSON.stringify(e).slice(0, 120)
}

async function doConnect() {
  const body = {
    host: $('c-host').value.trim() || '127.0.0.1',
    port: Number($('c-port').value) || 25565,
    username: $('c-user').value.trim() || undefined,
    auth: $('c-auth').value
  }
  if ($('c-ver').value.trim()) body.version = $('c-ver').value.trim()
  toast('连接中…')
  try {
    await api('/api/connect', 'POST', body)
    toast('连接成功')
    refresh()
  } catch { /* handled */ }
}

async function doSay() {
  const val = $('say').value.trim()
  if (!val) return
  await api('/api/say', 'POST', { message: val })
  $('say').value = ''
  toast('消息已发送')
}

// ---- AI 视野渲染 ----
const VCHARS = '0123456789abcdefghijklmnopqrstuvwxyz'
function visionColor(ch) {
  if (ch === '?') return '#11141a'
  if (ch === '~') return '#154e7d'
  if (ch === '!') return '#c25b1e'
  if (ch === '@') return '#1b5e20'
  if (ch === '*') return '#2e482e'
  const idx = VCHARS.indexOf(ch)
  if (idx < 0) return '#1b1e26'
  const d = idx - 20 // k=同高
  if (d === 0) return '#2e482e'
  const t = Math.min(1, Math.abs(d) / 10)
  if (d > 0) return 'rgb(' + Math.round(70 + t * 185) + ',' + Math.round(110 - t * 70) + ',60)'
  return 'rgb(30,' + Math.round(100 + t * 90) + ',' + Math.round(140 + t * 90) + ')'
}

async function loadVision() {
  if (!document.querySelector('#sec-vision')?.classList.contains('active')) return
  let d
  try { d = await api('/api/vision') } catch { return }
  const cv = $('vision-canvas')
  if (!cv) return
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cv.width, cv.height)
  if (!d.connected || !d.scan) {
    $('vision-info').textContent = '未连接至服务器'
    ctx.fillStyle = '#11141a'
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.fillStyle = '#8e9099'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('尚未连接到 Minecraft 服务器', cv.width / 2, cv.height / 2)
    ctx.textAlign = 'left'
    return
  }
  const s = d.scan
  const size = s.size
  const cell = cv.width / size
  for (let row = 0; row < s.grid.length; row++) {
    for (let col = 0; col < s.grid[row].length; col++) {
      ctx.fillStyle = visionColor(s.grid[row][col])
      ctx.fillRect(col * cell, row * cell, cell + 0.6, cell + 0.6)
    }
  }
  const toXY = (p) => [(p.x - (s.center.x - s.radius)) * cell + cell / 2, (p.z - (s.center.z - s.radius)) * cell + cell / 2]
  const dot = (p, color, label) => {
    const [x, y] = toXY(p)
    ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(x, y, Math.max(4, cell * 0.55), 0, 7); ctx.fill()
    if (label) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 11px "Google Sans", "PingFang SC", sans-serif'
      ctx.shadowColor = 'rgba(0,0,0,0.8)'
      ctx.shadowBlur = 4
      ctx.fillText(label, x + 7, y + 4)
      ctx.shadowBlur = 0
    }
  }
  const nb = d.nearby || {}
  ;(nb.players || []).forEach((p) => dot(p.position, '#4f9cf9', p.nametag || p.player))
  ;(nb.hostile_mobs || []).forEach((g) => dot(g.example_position, '#e05252', g.name + (g.count > 1 ? '×' + g.count : '')))
  ;(nb.passive_mobs || []).forEach((g) => dot(g.example_position, '#c9cdc4', g.name + (g.count > 1 ? '×' + g.count : '')))
  ;(nb.dropped_items || []).forEach((g) => dot(g.example_position, '#e0c341', g.item + (g.count > 1 ? '×' + g.count : '')))
  ;(nb.named_entities || []).forEach((n) => dot(n.position, '#b06fd8', String(n.title || n.entity).slice(0, 8)))

  // 视野扇形 + 自身朝向
  const cx = cv.width / 2
  const cy = cv.height / 2
  const dx = -Math.sin(d.self.yaw)
  const dz = Math.cos(d.self.yaw)
  ctx.fillStyle = 'rgba(168, 199, 250, 0.15)'
  ctx.beginPath(); ctx.moveTo(cx, cy)
  const ang = Math.atan2(dz, dx)
  ctx.arc(cx, cy, cell * 7.5, ang - Math.PI / 4, ang + Math.PI / 4)
  ctx.closePath(); ctx.fill()
  ctx.strokeStyle = '#a8c7fa'; ctx.lineWidth = 2.5
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * cell * 2.6, cy + dz * cell * 2.6); ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.fill()

  $('vision-info').textContent = '📍 坐标 ' + d.self.position.x + ', ' + d.self.position.y + ', ' + d.self.position.z +
    ' ｜ ❤️ 生命 ' + d.self.health + ' ｜ 🗡️ 手持 ' + (d.self.held || '空手') +
    ' ｜ 👁️ 感知: ' + (d.fair ? '拟真 (所见即 AI 所见)' : '全开') + (s.biome ? ' ｜ 🌲 群系: ' + s.biome : '')
  if (d.viewer && d.viewer.enabled) {
    $('viewer-card').style.display = ''
    const frame = $('viewer-frame')
    const src = 'http://' + location.hostname + ':' + d.viewer.port + '/'
    if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src }
  }
}
setInterval(loadVision, 1500)
loadVision()

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

loadPersonaForm()
loadMem()
loadChat()
loadEvents()
setInterval(loadEvents, 5000)
</script>
</body>
</html>`
