// 机器人生命周期管理 + 事件环形缓冲 + 任务互斥
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { decodeText, formatItem } from './items.js'
import { saveMemory, appendChatLog, sanitizeNs, lastServer } from './store.js'

const { pathfinder, Movements } = pathfinderPkg

const MAX_EVENTS = 500

export const state = {
  bot: null,
  options: null,
  events: [], // [{seq, time, type, ...}]
  seq: 0,
  notifiedSeq: 0, // 已通过工具返回自动下发给 AI 的最新 seq
  activity: [], // 面板用: 思考/推理/工具调用/工具结果/待机日志
  task: null, // { name, since, cancelled, interruptedBy }
  lastHealth: null,
  defense: { active: false, action: null, cancelled: false }, // 由 defense.js 驱动
  lastDamagedAt: null,
  containerWindow: null, // 当前打开的容器窗口
  sneaking: false,
  lastChatFrom: null, // 最近说话的玩家(拟人: 待机时看向他)
  lastChatAt: 0,
  sessionStats: null, // { startedAt, chats: {玩家: 条数}, chatCount, whisperCount, systemCount, damagedCount }
  disconnectReason: null,
}

export function pushEvent(type, data = {}) {
  state.seq += 1
  state.events.push({ seq: state.seq, time: new Date().toISOString(), type, ...data })
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS)
  }
}

export function eventsSince(seq) {
  return state.events.filter((e) => e.seq > seq)
}

// 记录自己发出的发言(事件 + 落盘 chatlog): 让模型在上下文里看到"我说过什么",
// 避免同一条消息回复两次。服务器回显已在 chat 处理器里过滤, 这里是唯一来源。
export function recordSelfChat(message, to = null) {
  try {
    pushEvent('self_chat', { message: String(message), to })
    const ns = state.options ? `${state.options.host}:${state.options.port}` : 'global'
    appendChatLog(sanitizeNs(ns), { time: new Date().toISOString(), type: 'self_chat', to, message: String(message) })
  } catch { /* ignore */ }
}

// 取出尚未自动附带在工具返回里的事件(取后即标记已下发)
export function drainNewEvents() {
  const evs = eventsSince(state.notifiedSeq)
  state.notifiedSeq = state.seq
  return evs
}

const MAX_ACTIVITY = 300
export function pushActivity(entry) {
  state.activity.push({ time: new Date().toISOString(), ...entry })
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity.splice(0, state.activity.length - MAX_ACTIVITY)
  }
}

export function currentTask() {
  return state.task ? { ...state.task, elapsed_seconds: Math.round((Date.now() - state.task.since) / 1000) } : null
}

// 存储 namespace: 当前连接的服务器 → 上次连接的服务器 → global
export function currentNs(explicit) {
  if (explicit) return sanitizeNs(explicit)
  if (state.options?.host) return sanitizeNs(`${state.options.host}:${state.options.port ?? 25565}`)
  return lastServer() ?? 'global'
}

export function requireBot() {
  if (!state.bot) {
    const e = new Error('尚未连接到 Minecraft 服务器,请先调用 connect。')
    e.code = 'NOT_CONNECTED'
    throw e
  }
  return state.bot
}

// 长任务互斥: 同一时间只允许一个阻塞型任务(goto/follow/collect/fight...)
// 自动防御激活期间也占用此锁(AI 可等待或用 stop 打断)
const DEFENSE_LABELS = { engage: '自动战斗', flee: '自动撤退', heal: '自动进食' }

export async function runTask(name, fn) {
  if (state.defense?.active) {
    const label = DEFENSE_LABELS[state.defense.action] ?? state.defense.action ?? '生存反射'
    const e = new Error(`生存反射正在进行(${label}), 稍等它结束, 或调用 stop 打断。`)
    e.code = 'DEFENSE_BUSY'
    throw e
  }
  if (state.task) {
    const held = Math.round((Date.now() - state.task.since) / 1000)
    const e = new Error(`正忙: 正在执行「${state.task.name}」(已 ${held} 秒)。如需打断请先调用 stop。`)
    e.code = 'BUSY'
    throw e
  }
  state.task = { name, since: Date.now(), cancelled: false }
  try {
    return await fn(state.task)
  } finally {
    state.task = null
  }
}

// stop 工具: 取消当前任务的循环/寻路, 同时打断自动防御
export function cancelTask() {
  if (state.task) state.task.cancelled = true
  if (state.defense) state.defense.cancelled = true
  const bot = state.bot
  try { bot?.pathfinder?.stop?.() } catch { /* ignore */ }
  try { bot?.pathfinder?.setGoal?.(null) } catch { /* ignore */ }
}

function cleanText(reason) {
  try {
    if (reason == null) return '未知原因'
    // prismarine-chat 的 ChatMessage: getText() 返回纯文本(去格式码)
    if (typeof reason.getText === 'function') return String(reason.getText())
    return reason.toString ? reason.toString() : String(reason)
  } catch {
    return String(reason)
  }
}

function teardownFor(bot) {
  if (state.bot !== bot) return
  // 断线自动总结(存入该服务器的记忆, key="上次会话", 下次连接 recall 可恢复上下文); 连接失败(<15秒)不生成
  try {
    const s = state.sessionStats
    if (s && Date.now() - s.startedAt > 15000 && state.options?.autoSummary !== false) {
      const summary = sessionSummary()
      if (summary) saveMemory(`${state.options.host}:${state.options.port}`, { key: '上次会话', text: summary, tags: ['会话记录'] })
    }
  } catch { /* ignore */ }
  state.sessionStats = null
  state.bot = null
  state.lastHealth = null
  try { state.containerWindow?.close?.() } catch { /* ignore */ }
  state.containerWindow = null
  state.sneaking = false
  if (state.defense) { state.defense.active = false; state.defense.cancelled = true }
  if (state.task) {
    state.task.cancelled = true
    state.task = null
  }
}

// 生成会话总结文本(断线时自动保存)
export function sessionSummary() {
  const s = state.sessionStats
  const options = state.options
  if (!s || !options) return null
  const mins = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000))
  const chatList = Object.entries(s.chats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p, c]) => `${p}×${c}`)
    .join(', ') || '无'
  const pos = state.bot?.entity
    ? `${Math.floor(state.bot.entity.position.x)}, ${Math.floor(state.bot.entity.position.y)}, ${Math.floor(state.bot.entity.position.z)}`
    : '未知'
  return `[会话总结] ${new Date(s.startedAt).toLocaleString('zh-CN')} 起 ${mins} 分钟 @ ${options.host}:${options.port} | 最后位置 (${pos}) | 交谈: ${chatList} | 消息: 公屏${s.chatCount} 私聊${s.whisperCount} 系统${s.systemCount} 受击${s.damagedCount} | 结束方式: ${state.disconnectReason ?? '未知'}`
}

function wireEvents(bot, options) {
  let lastDup = null
  const isDup = (key) => {
    const now = Date.now()
    if (lastDup && lastDup.key === key && now - lastDup.t < 1500) return true
    lastDup = { key, t: now }
    return false
  }
  const ns = `${options.host}:${options.port}`
  const bumpStat = (kind, player) => {
    const s = state.sessionStats
    if (!s) return
    if (kind === 'chat') s.chatCount += 1
    else if (kind === 'whisper') s.whisperCount += 1
    else if (kind === 'system') s.systemCount += 1
    else if (kind === 'damaged') s.damagedCount += 1
    if (player) s.chats[player] = (s.chats[player] ?? 0) + 1
  }

  bot.on('login', () => pushEvent('login', { username: bot.username }))
  // 资源包: 自动接受(协议上回复"已加载"), 避免被强制资源包服务器踢出。
  // 机器人不渲染材质, 无需真正下载; 对服务器而言与真人"下载并加载"等效。
  bot.on('resourcePack', (url, id) => {
    try {
      bot.acceptResourcePack()
    } catch { /* ignore */ }
    pushEvent('resource_pack', {
      url: String(url ?? '').slice(0, 200),
      note: '服务器要求下载资源包, 已自动接受(协议回复"已加载", 未实际下载——机器人不需要材质)',
    })
  })
  bot.on('spawn', () => {
    if (bot.entity) pushEvent('spawn', { position: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) } })
  })

  // 1.19+ 玩家聊天协议包: 直接从 senderName(玩家名组件) 和 plainMessage(原文) 解析,
  // 不依赖 mineflayer 的 chat pattern(服务器自定义聊天格式会匹配失败)。
  // 服务器把显示名设为 UUID 时, senderName 仍是真实玩家名。
  try {
    bot._client.on('playerChat', (data) => {
      let who = null
      try {
        const sn = data.senderName ? JSON.parse(data.senderName) : null
        if (typeof sn === 'string') {
          who = sn
        } else if (sn?.text) {
          who = String(sn.text)
        } else if (Array.isArray(sn?.extra)) {
          who = sn.extra.map((x) => x?.text ?? '').join('')
        }
      } catch { /* ignore */ }
      if (!who) return
      if (who === bot.username) return // 自己的消息不回显
      const message = String(data.plainMessage ?? data.message ?? '')
      if (!message) return
      if (isDup(`chat|${who}|${message}`)) return
      state.lastChatFrom = who
      state.lastChatAt = Date.now()
      pushEvent('chat', { player: who, message })
      bumpStat('chat', who)
      appendChatLog(ns, { time: new Date().toISOString(), type: 'chat', player: who, message })
    })
  } catch { /* 旧版本无 playerChat 包 */ }

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (isDup(`chat|${username}|${message}`)) return
    state.lastChatFrom = username
    state.lastChatAt = Date.now()
    pushEvent('chat', { player: username, message: String(message) })
    bumpStat('chat', username)
    appendChatLog(ns, { time: new Date().toISOString(), type: 'chat', player: username, message: String(message) })
  })
  bot.on('whisper', (username, message) => {
    if (isDup(`whisper|${username}|${message}`)) return
    state.lastChatFrom = username
    state.lastChatAt = Date.now()
    pushEvent('whisper', { from: username, message: String(message) })
    bumpStat('whisper', username)
    appendChatLog(ns, { time: new Date().toISOString(), type: 'whisper', from: username, message: String(message) })
  })
  // 系统消息(加入/离开/死亡/命令反馈等)。1.19+ 走 systemChat, 旧版走 message(position=system)
  bot.on('systemChat', (message) => {
    const text = cleanText(message)
    if (isDup(`sys|${text}`)) return
    pushEvent('system', { text })
    bumpStat('system')
    appendChatLog(ns, { time: new Date().toISOString(), type: 'system', text })
  })
  bot.on('message', (jsonMsg, position, sender, verified) => {
    // 兜底路径(旧版本无 playerChat 协议包, 或 mineflayer 版本不触发上面的监听):
    // 从消息文本里解析玩家名。1.19+ 已有 playerChat 处理, 这里基本不会命中。
    if (position === 'chat') {
      const raw = cleanText(jsonMsg).replace(/\u00a7./g, '')
      let who = null
      let text = raw
      // 1) [世界]:组名:名字 > 内容
      let m = /^\[[^\]]*\](?::[\w\u4e00-\u9fa5 ]+)?:([\w\u4e00-\u9fa5]{1,16})\s*[>:»-]\s*(.+)$/.exec(raw)
      // 2) [世界] 名字 > 内容
      if (!m) m = /^\[[^\]]*\]\s*([\w\u4e00-\u9fa5]{1,16})\s*[>:»-]\s*(.+)$/.exec(raw)
      // 3) 名字: 内容 / 名字 > 内容
      if (!m) m = /^([\w\u4e00-\u9fa5]{1,16})\s*[>:»-]\s*(.+)$/.exec(raw)
      // 4) <名字> 内容
      if (!m) m = /^<([\w\u4e00-\u9fa5]{1,16})>\s*(.+)$/.exec(raw)
      if (m) {
        who = m[1]
        text = m[2].trim()
      }
      // 解析出的名字是 UUID(服务器把显示名设成 UUID)时放弃, 交给 playerChat 路径
      if (!who || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who)) return
      if (isDup(`chat|${who}|${text}`)) return
      state.lastChatFrom = who
      state.lastChatAt = Date.now()
      pushEvent('chat', { player: who, message: text })
      bumpStat('chat', who)
      appendChatLog(ns, { time: new Date().toISOString(), type: 'chat', player: who, message: text })
      return
    }
    if (position !== 'system' && position !== 1) return
    const text = cleanText(jsonMsg)
    if (isDup(`sys|${text}`)) return
    pushEvent('system', { text })
    bumpStat('system')
    appendChatLog(ns, { time: new Date().toISOString(), type: 'system', text })
  })

  bot.on('kicked', (reason) => {
    state.disconnectReason = `被踢: ${cleanText(reason)}`
    pushEvent('kicked', { reason: cleanText(reason) })
    teardownFor(bot)
  })
  bot.on('error', (err) => {
    pushEvent('error', { message: err?.message ? String(err.message) : cleanText(err) })
  })
  bot.on('end', (reason) => {
    if (!state.disconnectReason) state.disconnectReason = `连接断开: ${cleanText(reason)}`
    pushEvent('disconnected', { reason: cleanText(reason) })
    teardownFor(bot)
  })

  bot.on('death', () => {
    pushEvent('death', { note: '你死了' })
    if (options.autoRespawn) {
      setTimeout(() => {
        try { bot.respawn() } catch { /* ignore */ }
      }, 2000)
    }
  })
  bot.on('health', () => {
    // mineflayer: 玩家自己的生命走 bot.health(update_health 包), bot.entity.health 一直是 undefined
    const h = bot.health
    if (h != null) {
      if (state.lastHealth != null && h < state.lastHealth) {
        state.lastDamagedAt = Date.now()
        if (state.sessionStats) state.sessionStats.damagedCount += 1
        pushEvent('damaged', { health: Math.round(h), food: bot.food })
      }
      state.lastHealth = h
    }
  })
  bot.on('playerJoined', (player) => pushEvent('player_joined', { player: String(player) }))
  bot.on('playerLeft', (player) => pushEvent('player_left', { player: String(player) }))

  // action bar(物品栏上方的悬浮提示, 插件常用作菜单/购买反馈); 服务器常周期性重发同一条, 去重
  let lastActionBar = null
  bot.on('actionBar', (message) => {
    const text = cleanText(message)
    if (lastActionBar && lastActionBar.text === text && Date.now() - lastActionBar.t < 4000) return
    lastActionBar = { text, t: Date.now() }
    pushEvent('action_bar', { text })
  })

  // 服务器主动弹出的窗口(NPC 菜单/商店等): 挂接为当前容器, 并把菜单项(含 Lore)直接放进事件
  bot.on('windowOpen', (window) => {
    if (state.containerWindow && state.containerWindow !== window) {
      try { state.containerWindow.close() } catch { /* ignore */ }
    }
    state.containerWindow = window
    const items = []
    try {
      const start = window.inventoryStart ?? 0
      window.slots?.forEach((it, i) => {
        if (it && i < start) items.push({ ...formatItem(it, bot.registry), slot: i })
      })
    } catch { /* ignore */ }
    pushEvent('window_open', {
      title: decodeText(window.title), // window.title 是 chat component 对象, decodeText 正确解析(不能用 toString)
      type: window.type ?? null,
      slots: Array.isArray(window.slots) ? window.slots.length : null,
      contents: items,
      hint: items.length ? '用 container(action="click", slot=N) 点击选项(注意返回的 window_open 事件若带 contents_after)' : undefined,
    })
  })
  bot.on('windowClose', (window) => {
    if (state.containerWindow === window) state.containerWindow = null
    pushEvent('window_closed', {})
  })
}

export function connectBot(options = {}) {
  if (state.bot) throw new Error('已经有一个活动连接,请先调用 disconnect。')
  // 新连接开启全新事件序号, 避免上次断线事件在 wait/长任务里把 AI 立刻唤醒
  state.events = []
  state.seq = 0
  state.notifiedSeq = 0

  const merged = {
    host: String(options.host || process.env.MC_HOST || '127.0.0.1'),
    port: Number(options.port || process.env.MC_PORT || 25565),
    username: String(options.username || process.env.MC_USERNAME || 'AI_Player'),
    version: options.version || process.env.MC_VERSION || false,
    auth: options.auth || process.env.MC_AUTH || 'offline',
    password: options.password || process.env.MC_PASSWORD || undefined,
    autoRespawn: options.auto_respawn !== false,
    fairPerception: options.fair_perception !== false, // 拟真感知(反矿透), 默认开
    humanize: options.humanize !== false, // 拟人化(张望/打字模拟), 默认开
    autoSummary: options.auto_summary !== false, // 断线自动保存会话总结, 默认开
  }

  const bot = mineflayer.createBot({
    host: merged.host,
    port: merged.port,
    username: merged.username,
    version: merged.version,
    auth: merged.auth,
    password: merged.password,
    hideErrors: true,
  })
  bot.loadPlugin(pathfinder)

  state.bot = bot
  state.options = merged
  state.lastHealth = null
  state.disconnectReason = null
  state.sessionStats = { startedAt: Date.now(), chats: {}, chatCount: 0, whisperCount: 0, systemCount: 0, damagedCount: 0 }
  wireEvents(bot, merged)

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { bot.quit() } catch { /* ignore */ }
      setTimeout(() => teardownFor(bot), 200)
      reject(err)
    }
    const timer = setTimeout(() => {
      fail(new Error(`连接 ${merged.host}:${merged.port} 超时(90秒)。请检查地址/端口,或显式指定 version。`))
    }, 90000)

    bot.once('spawn', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { bot.pathfinder.setMovements(new Movements(bot)) } catch { /* ignore */ }
      resolve({ bot, ...merged, version: bot.version })
    })
    bot.once('kicked', (reason) => fail(new Error(`被服务器踢出: ${cleanText(reason)}`)))
    bot.once('error', (err) => fail(new Error(`连接失败: ${err?.message || cleanText(err)}(检查服务器地址/版本/账号)`)))
    bot.once('end', () => {
      if (!settled) fail(new Error('连接中断: 服务器拒绝了连接(常见原因: 版本不匹配、白名单、正版验证)。'))
    })
  })
}

export async function disconnectBot() {
  const bot = state.bot
  if (!bot) return { connected: false, note: '当前没有活动连接' }
  if (!state.disconnectReason) state.disconnectReason = '手动断开'
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 4000)
    bot.once('end', () => { clearTimeout(t); resolve() })
    try { bot.quit('再见!') } catch { clearTimeout(t); resolve() }
  })
  teardownFor(bot)
  return { connected: false }
}
