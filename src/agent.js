// 自主 Agent: 独立于 MCP 客户端的游玩循环
// 直接调用 OpenAI 兼容 API(/chat/completions + function calling),
// 工具复用 registry 的全部能力, 循环永不停——解决了"code agent 完成任务就停"的问题。
// 空闲时自动进入 wait 等事件; 断线时安全空转等待重连。
import { TOOLS, executeTool } from './registry.js'
import { state, pushActivity, currentNs, eventsSince, drainNewEvents } from './bot.js'
import { loadConfig, personaPromptText } from './persona.js'
import { sleep } from './util.js'
import { recordCall, predictNext, saveAll, habitsStats } from './habits.js'
import { contextSnapshot } from './context.js'
import { startThinkingFill, stopThinkingFill } from './humanize.js'

const MAX_HISTORY_TOKENS = 24_000 // 除 system 外的历史 token 预算, 超出裁剪最旧的工具往返(比固定条数更能保留长前缀)

// 惯性执行安全名单: 只有"错了也无害/可纠正"的工具才允许绕过模型本地先执行。
// 聊天/丢弃/交易/交互等有社交后果的一律不猜。
const SAFE_HABIT_TOOLS = new Set(['find', 'collect', 'goto', 'nearby', 'status', 'scan', 'eat', 'inventory', 'look_at', 'wait'])

const AGENT_RULES = `

## 自主游玩规则(你是独立运行的 Agent, 不是命令执行器)
- 想说话必须用 chat/whisper 工具, 说话内容严格遵守上面的"人设/说话方式"
- 公屏一律用 chat 直接发文本, 不要用 /tell /msg /say 或 command 发聊天消息; 私聊才用 whisper
- 社交优先: 有玩家对你说话/提醒/提问时, 先回应他们再忙自己的事; 附近有玩家且有空闲时, 主动打个招呼或聊几句, 不要埋头干活不理人
- 进服/换服先观察: 用 status/nearby 看看周围环境, 有玩家就先打招呼回应; 不要一进主城就砍树挖矿造东西, 先融入环境
- 你是自主玩家: 有自己的目标、兴趣和节奏, 不用等玩家下命令。进服先用 goal(list) / memory(recall, query="goal:") 恢复目标, 没有目标就用 goal(set) 立一个(含动机/下一步/计划), 然后按计划动手
- 空闲也优先推进当前目标: 探索、收集、建设、社交、研究新玩法都算; 只有明确在等人/等事时才 wait(15~30)
- 完成一步就推进下一步, 目标完成用 goal(done) 标记并给自己立新目标; 改计划用 goal(update)
- 本地会定期注入【工作记忆快照】(目标/建筑进度/最近完成/你放过和存过的东西的位置), 直接把它当最新事实继续推进; 计划已变就先用 goal(update)/build(status) 修正, 不要反过来问玩家
- 长任务用 goto/collect/attack(seconds) 一次性下发, 等结果再决定下一步
- 每 15~30 分钟主动把重要进展、玩家说过的重要信息存入 memory; 关键地点存 waypoint; 每 20~40 分钟复盘一次自己的目标
- 需要材料/物品时, 先看工作记忆快照里"放过/存过的东西"——工作台、箱子、熔炉在哪, 存了什么, 直接去取/去用, 不要重复制作; 快照里没有再用 memory(recall) 查
- 收到工具错误时读错误信息调整, 不要重复同样的失败调用
- 服务器命令纪律: 想了解服务器玩法用 command 试 /help、/menu 等常见命令; 命令发出后没反馈/报错(在 new_events 里看), 就换命令或问玩家, 不要连续盲目试一堆命令刷屏; 菜单窗口弹出(window_open 事件)后, 用 container(action="click", slot=N) 点选项, 选项的 title/lore 描述了它是什么
- 行动要果断: 工具返回里已带 self/new_events(/nearby), 通常不需要先 status/nearby 扫一遍再行动; 想到就直接调用, 犹豫的停顿会暴露你不是真人
- 同类方块要挖多个时, 先 find 看视野内有哪些, 把坐标列表用 dig(positions=[...]) 批量挖或用 collect, 不要一块一块挖
- 建房子/摆多个方块时, 先用 build(action="plan") 一次性给蓝图, build(action="need") 查缺料, collect/craft 补料后再 build(action="place") 一次施工; 不要一格一格 place
- 已经在脑内想清楚的一串连续动作(赶路→采集→合成→放置→建造)不要一步一步单独调用, 用 plan 一次下发并本地连续执行; 只有遇到需要新信息或新决定的节点再单独调用工具
- 你自己发过的消息会以 self_chat 事件出现在上下文里——看到就说明已经回复过, 不要对同一条消息回复第二次
- chat/whisper 工具返回后说明这条回复已发出, 不要再对同一句/同一个问题重复回复
- 自己放置过的重要方块(工作台/熔炉/箱子)会自动记入 memory(key="放置:方块名"), 需要时 recall 查位置, 不要重复制作
- 断线就等重连(反复 wait), 不要惊慌也不要刷屏
- 一次只做一件事, 一步一步来`

let running = false
let loopPromise = null
let messages = []
let lastConnected = null
let lastServerKey = null // 当前对话所属的服务器(host:port)
let lastGoalReminderAt = 0
let lastSnapshotHash = null
let recentCalls = [] // 最近调用(习惯预测的上下文)
let habitChain = 0
let observeUntil = 0 // 进服观察期截止时间戳: 期间不干活只观察, 防止"一上来就砍树建房子"
let observeWarned = false // 观察期提前解除的提示是否已发
const stats = {
  running: false,
  model: null,
  api_base: null,
  started_at: null,
  calls: 0,
  tool_calls: 0,
  habit_execs: 0,
  cache_hit_tokens: 0,
  cache_miss_tokens: 0,
  cache_measured_calls: 0,
  last_action: null,
  last_error: null,
}

export function agentStatus() {
  const cacheTotal = stats.cache_hit_tokens + stats.cache_miss_tokens
  let habits = null
  try { habits = habitsStats(currentNs()) } catch { /* ignore */ }
  return {
    ...stats,
    running,
    elapsed_minutes: stats.started_at ? Math.round((Date.now() - stats.started_at) / 6000) / 10 : 0,
    cache_hit_rate: cacheTotal > 0 ? Math.round((stats.cache_hit_tokens / cacheTotal) * 1000) / 10 : null,
    habits,
  }
}

export function startAgent(overrides = {}) {
  if (running) return { started: false, note: 'Agent 已在运行' }
  running = true
  stats.running = true
  stats.started_at = Date.now()
  stats.calls = 0
  stats.tool_calls = 0
  stats.habit_execs = 0
  stats.cache_hit_tokens = 0
  stats.cache_miss_tokens = 0
  stats.cache_measured_calls = 0
  stats.last_action = null
  stats.last_error = null
  messages = []
  lastConnected = null
  lastServerKey = null
  lastGoalReminderAt = 0
  lastSnapshotHash = null
  recentCalls = []
  habitChain = 0
  observeUntil = 0
  observeWarned = false
  loopPromise = agentLoop(overrides).catch((err) => {
    console.error('[minecraft-mcp] agent loop crashed:', err)
  })
  return { started: true }
}

export function stopAgent() {
  running = false
  stats.running = false
  saveAll()
  return { stopped: true, note: '若正在执行阻塞工具(如 wait), 最多 45 秒内完全停止。' }
}

// 惯性执行链: 模型刚执行完调用后, 按学到的习惯把高置信度的下一步先跑掉。
// 任何事件(聊天/受击等)出现立即停, 把控制权交回模型; 连锁有上限, 不会无限自动驾驶。
async function runHabitChain(cfg, preSeq = null) {
  if (cfg.habits === false) return
  if (observeUntil > Date.now()) return // 观察期内不惯性执行(会绕过模型直接干活)
  const minConf = Number(cfg.habit_min_confidence ?? 0.7)
  const maxChain = Number(cfg.habit_max_chain ?? 2)
  const ns = currentNs()
  const seq0 = preSeq ?? state.seq // 用工具执行前的序号: 期间发生的事件(如聊天)必须交回模型, 不能惯性执行
  while (running && habitChain < maxChain) {
    if (eventsSince(seq0).some((e) => WAKE_ANY.has(e.type))) return // 有事发生: 交回模型
    const pred = predictNext(ns, recentCalls)
    if (!pred || !SAFE_HABIT_TOOLS.has(pred.name) || pred.confidence < minConf) return
    const id = `habit_${Date.now().toString(36)}`
    pushActivity({ source: 'habit', kind: 'tool', text: `惯性执行 ${pred.name} (置信度 ${Math.round(pred.confidence * 100)}%, 样本 ${pred.samples})` })
    messages.push({
      role: 'assistant',
      content: `【惯性执行】根据历史习惯自动执行了「${pred.name}」(置信度 ${Math.round(pred.confidence * 100)}%), 结果见下一条工具返回; 如不符合你的意图, 请用 stop 或直接做别的。`,
      tool_calls: [{ id, type: 'function', function: { name: pred.name, arguments: JSON.stringify(pred.args ?? {}) } }],
    })
    stats.last_action = `${pred.name}(惯性) ${JSON.stringify(pred.args ?? {}).slice(0, 80)}`
    const { payload } = await executeTool(pred.name, pred.args ?? {})
    stats.tool_calls += 1
    stats.habit_execs += 1
    recordCall(ns, pred.name, pred.args ?? {})
    recentCalls.push({ name: pred.name, args: pred.args ?? {} })
    if (recentCalls.length > 6) recentCalls.shift()
    messages.push({
      role: 'tool',
      tool_call_id: id,
      content: summarizeToolResult(pred.name, payload, 3000),
    })
    habitChain += 1
  }
}

const WAKE_ANY = new Set(['chat', 'whisper', 'damaged', 'death', 'kicked', 'disconnected', 'auto_defense', 'window_open', 'action_bar', 'system', 'reconnecting', 'reconnected', 'self_chat', 'resource_pack', 'social_hint'])

// 长动作: 这些工具执行时间长(几十秒), 期间并行预判下一步, 实现"边执行边思考"
const LONG_ACTIONS = new Set(['goto', 'collect', 'explore', 'plan', 'wander', 'follow', 'attack', 'pillar', 'build'])

// 进服观察期拦截的"干活类工具": 刚进服先观察环境/回应玩家, 不砍树不建房子
const OBSERVE_BLOCKED = new Set(['collect', 'dig', 'build', 'plan', 'craft', 'place', 'attack', 'kill', 'fight', 'pillar'])

// 服务器标识: 切换服务器时清空对话历史, 防止把上一台服务器的思考/聊天/事件带到新服。
// 持久化记忆(goal/memory/waypoint/chatlog)本来就按 host:port 命名空间隔离, 上下文也必须隔离。
function serverKey() {
  const o = state.options
  return o?.host ? `${o.host}:${o.port ?? 25565}` : null
}

function buildMessages(cfg) {
  ensureSystemPrompt()
  stats.model = cfg.model
  stats.api_base = cfg.api_base
  // 服务器切换检测: 换服 → 重置会话, 让模型在新服重新恢复上下文
  const curServer = serverKey()
  if (curServer && curServer !== lastServerKey) {
    if (messages.length > 1) {
      pushActivity({ source: 'agent', kind: 'system', text: `检测到服务器切换(${lastServerKey ?? '无'} → ${curServer}), 已清空旧会话上下文` })
    }
    lastServerKey = curServer
    lastConnected = null
    lastSnapshotHash = null
    recentCalls = [] // 惯性执行上下文也按服隔离
    habitChain = 0
    messages = []
    ensureSystemPrompt()
    // 已连接状态下换服: 新会话直接带恢复上下文的引导提示
    if (state.bot && state.bot.entity) {
      observeUntil = Date.now() + (cfg.observe_seconds ?? 90) * 1000
      messages.push({
        role: 'user',
        content: `【系统提示】你已切换到一台新的服务器。现在是观察期(约 ${Math.round((cfg.observe_seconds ?? 90) / 60)} 分钟): 先看看周围情况(status/nearby), 附近有玩家就先打招呼、回应他们的提醒, 别急着干活。观察期结束前不要砍树/挖矿/建房子。`,
      })
      pushActivity({ source: 'agent', kind: 'system', text: '新服务器会话已开始(观察期: 先融入环境)' })
      lastConnected = true
    }
  }
  // 连接状态变化提示
  const connected = Boolean(state.bot && state.bot.entity)
  if (lastConnected !== null && connected !== lastConnected) {
    if (connected) {
      // 进服观察期: 先融入环境再干活, 防止"一上来就砍树建房子不理人"
      observeUntil = Date.now() + (cfg.observe_seconds ?? 90) * 1000
      messages.push({
        role: 'user',
        content: `【系统提示】机器人已连接到服务器。现在是观察期(约 ${Math.round((cfg.observe_seconds ?? 90) / 60)} 分钟): 先 status/nearby 看看周围环境, 有玩家就先打招呼、回应他们的话。观察期结束前不要砍树/挖矿/建房子/合成, 先融入环境。想了解服务器玩法(菜单/商店/传送等): 用 command 试 /help 或 /menu 等常见命令, 或直接问玩家; 命令没反应/报错就换思路, 不要反复试同一个命令。有人跟你说话就直接回应。`,
      })
      pushActivity({ source: 'agent', kind: 'system', text: `已连接服务器, 进入观察期 ${Math.round((cfg.observe_seconds ?? 90) / 60)} 分钟(先融入环境再干活)` })
    } else {
      messages.push({
        role: 'user',
        content: '【系统提示】机器人已断开连接。保持冷静, 调用 wait 等待管理员重连。',
      })
      pushActivity({ source: 'agent', kind: 'system', text: '连接已断开, Agent 等待重连' })
    }
  }
  lastConnected = connected
  // 观察期提前解除: 玩家说话说明环境活跃, 可以开始正常互动(但仍不主动干活)
  if (observeUntil > Date.now() && connected) {
    const hasChat = eventsSince(0).slice(-20).some((e) => e.type === 'chat' || e.type === 'whisper')
    if (hasChat) {
      observeUntil = Date.now() + 20 * 1000 // 再留 20 秒缓冲, 等玩家把话说完
      if (!observeWarned) {
        observeWarned = true
        messages.push({
          role: 'user',
          content: '【系统提示】玩家在和你说话, 观察期提前结束(还有 20 秒缓冲)。回应他们, 之后可以正常活动。',
        })
      }
    }
  }
  maybeInjectSnapshot()
  return messages
}

function ensureSystemPrompt() {
  const content = personaPromptText(state.bot?.username) + AGENT_RULES
  if (messages.length === 0) {
    messages.push({ role: 'system', content })
    return
  }
  if (messages[0]?.content !== content) {
    messages[0] = { ...messages[0], content }
    pushActivity({ source: 'agent', kind: 'system', text: '检测到人设/说话方式变化, 已自动刷新运行中的 system prompt' })
  }
}

export function refreshAgentPersona() {
  if (messages.length === 0) {
    return { updated: false, running, note: '自主 Agent 尚未生成会话, 启动后会自动使用最新人设' }
  }
  const before = messages[0]?.content
  ensureSystemPrompt()
  const updated = messages[0]?.content !== before
  return {
    updated,
    running,
    note: updated ? '已刷新运行中 Agent 的 system prompt, 下一次请求立即生效' : '人设未变化, 无需刷新',
  }
}

function hashText(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

// 目标/建筑/最近完成记录变化时自动提醒 Agent, 不用等模型自己想起来去 memory(recall)。
// 快照内容没变就永不重复注入(裁剪后若同内容快照还在上下文里也不重复): 注入同样内容的 user 消息会切断缓存前缀, 且毫无信息增益。
function maybeInjectSnapshot(force = false) {
  // 观察期内不注入快照(目标/建筑/存放记录会诱导"快去干活"), 观察期结束再恢复
  if (observeUntil > Date.now()) return
  const snap = contextSnapshot(currentNs())
  if (!snap) return
  const hash = hashText(snap)
  if (!force && (hash === lastSnapshotHash || messages.some((m) => m.role === 'user' && m.content?.includes(snap)))) return
  lastSnapshotHash = hash
  messages.push({
    role: 'user',
    content: `【工作记忆快照(本地自动维护)】\n${snap}\n\n按这份快照继续。如果某项已经过时, 先用 goal(update)/build(status) 修正, 不要重复问玩家“要建什么/接下来做什么”。`,
  })
  pushActivity({ source: 'agent', kind: 'system', text: '已注入工作记忆快照(目标/建筑进度/最近完成)' })
}

// 消息的 token 估算: 内容已 JSON 转义(引号/反斜杠双倍), 按字符数保守估算
function estTokens(m) {
  const s = JSON.stringify(m) || ''
  return Math.ceil(s.length / 3)
}

function trimMessages() {
  if (messages.length <= 3) return // system + note + 至少一轮
  const system = messages[0]
  let total = messages.slice(1).reduce((n, m) => n + estTokens(m), 0)
  if (total <= MAX_HISTORY_TOKENS) return
  const note = { role: 'user', content: '(更早的对话历史已省略, 重要信息请确保已存入 memory)' }
  let from = 2 // system 保留, note 占 index 1
  while (from < messages.length && total > MAX_HISTORY_TOKENS * 0.7) {
    total -= estTokens(messages[from])
    from += 1
    // 不能从 tool 结果中间截断: tool 消息必须跟在对应的 assistant tool_calls 后面
    while (from < messages.length && messages[from].role === 'tool') {
      total -= estTokens(messages[from])
      from += 1
    }
  }
  if (from >= messages.length) {
    // 全部裁掉也不可能低于预算(单轮往返本身就超预算), 保留下限 2 轮往返
    from = Math.min(messages.length - 4, messages.length - 1)
    while (from > 2 && messages[from].role === 'tool') from -= 1
  }
  messages = [system, note, ...messages.slice(from)]
  lastSnapshotHash = null
}

// 工具 schema 瘦身: 完整描述每次 API 调用都要重发(41 个工具 1.5 万+字符, 直接拖慢推理)。
// Agent 模式: 工具描述只留第一分句(≤45字), 参数描述整个去掉(保留 type/enum —— enum 承载 action 语义),
// 详细用法靠处理器返回的详细错误消息自行纠正(MCP 模式仍用完整 schema)。
function slimDesc(text, max) {
  const s = String(text ?? '').split(/[。;,,;;]/)[0].trim()
  return s.length > max ? s.slice(0, max) : s
}

// 聊天旁路: 长动作(施工/采集/赶路)执行期间, 本地监听聊天事件,
// 聚合 2~3 秒后用轻量请求让模型回复——"边干活边聊天", 不打断正在执行的动作。
// 只允许 chat/whisper 工具, 模型不能干扰任务; 回复走拟人打字队列, 非阻塞。
async function chatSideChannel(cfg, baseMsgs, preSeq, runningUntil) {
  try {
    const waitMs = 2500 + Math.random() * 1500 // 聚合窗口: 等人把话说完
    const chatStart = Date.now() + waitMs
    let lastLen = 0
    // 收集期间的新聊天(在 preSeq 之后、旁路开始前就已发生的也算——刚被任务吞掉的)
    const pending = () => eventsSince(preSeq).filter((e) => e.type === 'chat' || e.type === 'whisper')
    // 等待聚合窗口, 有新消息就重置计时(但不超过任务结束时间)
    while (Date.now() < chatStart && Date.now() < runningUntil) {
      const evs = pending()
      if (evs.length > lastLen) {
        lastLen = evs.length
        chatStart = Math.min(runningUntil, Date.now() + 2000)
      }
      await sleep(300)
    }
    const chats = pending()
    if (!chats.length || !running) return
    // 构造迷你上下文: 最近几轮 + 新聊天(不污染主对话, 用完即弃)
    const tail = baseMsgs.slice(-14)
    const chatText = chats
      .map((e) => (e.type === 'whisper' ? `私聊 ${e.from}: ${e.message}` : `${e.player}: ${e.message}`))
      .join('\n')
    // 只给 chat/whisper 两个工具 + auto: 模型可回复, 也可静默(把消息交回主任务处理)
    const chatOnlyTools = slimTools().filter((t) => t.function?.name === 'chat' || t.function?.name === 'whisper')
    const reply = await callApi(cfg, [
      ...tail,
      { role: 'user', content: `【边干活边聊天】你正在忙(长任务执行中), 玩家发来了消息:\n${chatText}\n\n如果是纯闲聊/问候/简单问题, 用 chat 或 whisper 简短回复(可以说"在忙, 等下说")。如果对方在叫你过去、让你做某件事、或有重要的事——不要调用工具, 静默处理, 主任务会停下处理。` },
    ], { tool_choice: 'auto', tools: chatOnlyTools, max_tokens: 120 })
    if (!running) return
    const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : []
    const replied = []
    for (const tc of calls) {
      if (tc.function?.name !== 'chat' && tc.function?.name !== 'whisper') continue
      let args = {}
      try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* ignore */ }
      await executeTool(tc.function?.name, args)
      stats.tool_calls += 1
      pushActivity({ source: 'agent', kind: 'chat_side', text: `[干活中回复] ${tc.function?.name}: ${String(args.message ?? '').slice(0, 80)}` })
      recordCall(currentNs(), tc.function?.name, args)
      replied.push(`「${String(args.message ?? '').slice(0, 80)}」`)
    }
    // 不标记 notifiedSeq: 消息仍会流向主循环的 new_events(旁路只是提前回复, 不能吞消息)
    return { chats: chats.map((c) => (c.type === 'whisper' ? `私聊 ${c.from}: ${c.message}` : `${c.player}: ${c.message}`)), replied, handled: replied.length > 0 }
  } catch { /* 旁路失败不影响主任务 */ }
}

// 工具结果精简: 大 JSON(建筑逐格/计划逐步/探索发现/背包)只保留关键统计,
// 完整细节按需用 status/build(status)/inventory 查。省 token 且模型读得快。
function summarizeToolResult(name, payload, maxLen) {
  try {
    const p = payload ?? {}
    if (name === 'build' && p.action === 'place' && Array.isArray(p.entries)) {
      const entries = p.entries
      const done = entries.filter((e) => e.status === 'placed' || e.status === 'already').length
      const fail = entries.filter((e) => e.status !== 'placed' && e.status !== 'already' && e.status !== 'pending').length
      const { entries: _drop, ...rest } = p
      return JSON.stringify({ ...rest, entries_summary: `${done}/${entries.length} 已放, ${fail} 处失败(详情用 build(action=status) 查逐格)`, _hint: '逐格列表已精简' }).slice(0, maxLen)
    }
    if (name === 'plan' && Array.isArray(p.done_steps)) {
      const steps = p.done_steps
      const ok = steps.filter((s) => s.ok).length
      const { done_steps: _drop, ...rest } = p
      return JSON.stringify({ ...rest, steps_summary: `${ok}/${steps.length} 步成功(失败步骤见下)`, failed_steps: steps.filter((s) => !s.ok).slice(0, 5) }).slice(0, maxLen)
    }
    if (name === 'explore' && Array.isArray(p.positions)) {
      const { positions: _drop, ...rest } = p
      return JSON.stringify({ ...rest, position_count: p.positions.length, _hint: '发现物列表已精简, 详细坐标可再 explore' }).slice(0, maxLen)
    }
    if (name === 'inventory' && (Array.isArray(p.hotbar) || Array.isArray(p.backpack))) {
      // 背包必须显示物品名(AI 需要知道自己有什么); 只压缩冗长字段(lore/附魔), 保留 name×count
      const brief = (arr, max) => (arr ?? []).slice(0, max).map((it) => {
        if (!it) return null
        const t = it.title && it.title !== it.name ? `(${it.title})` : ''
        return `${it.name}${t}×${it.count ?? 1}`
      }).filter(Boolean)
      return JSON.stringify({
        held: p.held ? (p.held.title && p.held.title !== p.held.name ? `${p.held.name}(${p.held.title})×${p.held.count ?? 1}` : `${p.held.name}×${p.held.count ?? 1}`) : null,
        hotbar: brief(p.hotbar, 9),
        backpack: brief(p.backpack, 27),
        armor: (p.armor ?? []).map((it) => (it ? it.name : null)).filter(Boolean),
        _hint: '物品只显示 名称×数量, 详细 lore/附魔用 inventory 工具查看',
      }).slice(0, maxLen)
    }
    return JSON.stringify(p).slice(0, maxLen)
  } catch {
    return JSON.stringify(payload).slice(0, maxLen)
  }
}

let slimToolsCache = null

export function slimTools() {
  if (slimToolsCache) return slimToolsCache
  slimToolsCache = TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: slimDesc(t.description, 45),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.inputSchema?.properties ?? {}).map(([k, v]) => [
            k,
            v.enum ? { type: v.type, enum: v.enum } : { type: v.type },
          ]),
        ),
        required: t.inputSchema?.required,
      },
    },
  }))
  return slimToolsCache
}

async function callApi(cfg, msgs, opts = {}) {
  const base = String(cfg.api_base || '').replace(/\/+$/, '')
  const tools = opts.tools ?? slimTools()
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key || ''}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: msgs,
      tools,
      tool_choice: opts.tool_choice ?? 'auto',
      temperature: cfg.temperature ?? 0.8,
      max_tokens: opts.max_tokens ?? cfg.max_tokens ?? 2048,
    }),
    signal: AbortSignal.timeout(cfg.timeout_ms ?? 120000),
  })
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const data = await res.json()
  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error(`API 返回异常: ${JSON.stringify(data).slice(0, 200)}`)
  const usage = data.usage
  if (usage && typeof usage === 'object') {
    let hit = Number(usage.prompt_cache_hit_tokens)
    let miss = Number(usage.prompt_cache_miss_tokens)
    if (!Number.isFinite(hit)) hit = Number(usage.prompt_tokens_details?.cached_tokens)
    if (!Number.isFinite(miss) && Number.isFinite(hit)) miss = Number(usage.prompt_tokens) - hit
    if (Number.isFinite(hit) && Number.isFinite(miss)) {
      stats.cache_hit_tokens += Math.max(0, hit)
      stats.cache_miss_tokens += Math.max(0, miss)
      stats.cache_measured_calls += 1
    }
  }
  return msg
}

async function agentLoop(overrides) {
  while (running) {
    const cfg = { ...(loadConfig().agent ?? {}), ...overrides }
    if (!cfg.api_base || !cfg.model) {
      stats.last_error = '未配置 api_base 或 model(在 Web 面板"自主运行"页配置)'
      stats.api_base = cfg.api_base || null
      await sleep(3000)
      continue
    }
    try {
      stats.last_error = null
      if (Date.now() - lastGoalReminderAt > 20 * 60 * 1000) {
        lastGoalReminderAt = Date.now()
        pushActivity({ source: 'agent', kind: 'system', text: '自主复盘提醒: 检查/更新目标' })
        messages.push({
          role: 'user',
          content: '【系统提示】自主复盘时间: 用 goal(list) 检查你的目标。没有目标就 goal(set) 给自己立一个(写清下一步), 完成/受阻/改主意用 goal(update/done) 更新, 然后立刻推进目标, 不要停在原地等待。',
        })
      }
      const thinkingFill = startThinkingFill(state.bot)
      let msg
      try {
        msg = await callApi(cfg, buildMessages(cfg))
      } finally {
        stopThinkingFill()
      }
      stats.calls += 1
      if (msg.reasoning_content) {
        pushActivity({ source: 'agent', kind: 'reasoning', text: String(msg.reasoning_content).slice(0, 800) })
      }
      if (msg.content) {
        pushActivity({ source: 'agent', kind: 'thinking', text: String(msg.content).slice(0, 800) })
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        habitChain = 0 // 模型亲自出手了, 惯性链重新计数
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })
        const sentChats = []
        // 长动作(耗时工具): 执行期间并行预判下一步, 实现"边执行边思考"
        const longAction = msg.tool_calls.some((tc) => LONG_ACTIONS.has(tc.function?.name))
        let predictPromise = null
        if (longAction && running) {
          const preMsgs = [
            ...messages,
            {
              role: 'user',
              content: '【系统】你现在同时执行多个动作。在动作执行期间, 先思考: 这次行动(可能耗时几十秒)完成后, 下一步最该做什么? 只给结论, 不要调用工具。考虑: 结果是否达标? 还要继续吗? 途中可能发生什么事? 需要提前准备什么?',
            },
          ]
          predictPromise = callApi(cfg, preMsgs, { tool_choice: 'none', max_tokens: 300 })
            .then((m) => m?.content || '')
            .catch(() => '')
        }
        const preSeq = state.seq // 记录工具执行前的事件序号: 期间发生的事件必须交回模型
        // 聊天旁路: 长动作执行期间并行回复玩家(边干活边聊天, 不打断任务); agent.chat_side=false 可关
        const sideChannelPromise = longAction && running && cfg.chat_side !== false
          ? chatSideChannel(cfg, messages, preSeq, Date.now() + (cfg.side_chat_timeout_ms ?? 45000))
          : null
        for (const tc of msg.tool_calls) {
          if (!running) break
          let args = {}
          try {
            args = JSON.parse(tc.function?.arguments || '{}')
          } catch { /* 参数解析失败按空参数执行, 错误会反馈给模型 */ }
          stats.last_action = `${tc.function?.name} ${JSON.stringify(args).slice(0, 100)}`
          // 进服观察期硬拦截: 不执行干活类工具, 先融入环境(玩家在观察期说话会解除)
          if (observeUntil > Date.now() && OBSERVE_BLOCKED.has(tc.function?.name)) {
            const remain = Math.max(1, Math.round((observeUntil - Date.now()) / 1000))
            const payload = {
              ok: false,
              error: `观察期还剩约 ${remain} 秒: 刚进服务器先看看环境/回应玩家, 暂时不要「${tc.function?.name}」。先用 status/nearby 观察, 或 wait 看看有没有人说话。`,
            }
            // 关键: 拦截也要 drain 事件——玩家消息不能因为工具被拦就积压丢失
            try {
              const evs = drainNewEvents()
              if (evs.length) payload.new_events = evs
            } catch { /* ignore */ }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(payload).slice(0, 1000) })
            continue
          }
          const { payload } = await executeTool(tc.function?.name, args)
          stats.tool_calls += 1
          recordCall(currentNs(), tc.function?.name, args)
          recentCalls.push({ name: tc.function?.name, args })
          if (recentCalls.length > 6) recentCalls.shift()
          const content = summarizeToolResult(tc.function?.name, payload, 3000)
          messages.push({ role: 'tool', tool_call_id: tc.id, content })
          if (tc.function?.name === 'chat' || tc.function?.name === 'whisper') {
            sentChats.push(`「${String(args.message ?? '').slice(0, 80)}」(${tc.function?.name})`)
          }
        }
        // 预判结果带回上下文: 模型带着"边执行边想的结论"看实际结果, 决策更快
        if (predictPromise) {
          const predict = await predictPromise
          if (predict && running) {
            pushActivity({ source: 'agent', kind: 'reasoning', text: `[动作期间预判] ${String(predict).slice(0, 400)}` })
            messages.push({
              role: 'user',
              content: `【系统】刚才你在动作执行期间的预判: ${String(predict).slice(0, 600)}。结合上面的实际执行结果判断下一步。`,
            })
          }
        }
        // 等聊天旁路收尾(最多 8 秒): 旁路聚合 2.5~4 秒 + API 请求, 正常能完成;
        // 没结束就让它在后台跑完(旁路有 45 秒上限, 不会无限挂)
        if (sideChannelPromise) {
          const sideResult = await Promise.race([sideChannelPromise, sleep(8000)])
          // 旁路处理了聊天: 让主模型知情(玩家说了什么 + 你已回复什么), 避免重复回复/失忆
          if (sideResult?.chats?.length) {
            const note = sideResult.handled
              ? `你已回复: ${sideResult.replied.join('、')}。`
              : '你判断这些是需要停下处理的消息(比如叫你过去), 尚未回复。'
            messages.push({
              role: 'user',
              content: `【边干活边聊天记录】你在执行任务期间, 玩家发来: ${sideResult.chats.join('；')}。${note}如果对方还在等回应或需要你行动, 现在处理。`,
            })
            pushActivity({ source: 'agent', kind: 'system', text: `任务期间收到 ${sideResult.chats.length} 条聊天(边干活边聊天)` })
          }
        }
        // 同一轮多次发言合并成一条提示, 避免每条都中途插入 user 消息切断缓存前缀
        if (sentChats.length) {
          messages.push({
            role: 'user',
            content: `【系统提示】你刚才已发出: ${sentChats.join('、')}。这些回复已经算数, 不要再对同一句/同一个问题重复回复, 除非对方又说了新内容。`,
          })
        }
        maybeInjectSnapshot()
        // 惯性执行: 按历史习惯在模型思考前先执行高置信度的下一步(动作与推理重叠, 消除"动一下停一阵")
        await runHabitChain(cfg, preSeq)
        maybeInjectSnapshot()
      } else {
        // 模型没有调用工具: 替它待机(相当于自动 wait), 把等待结果带回下一轮。
        // 但引导它"空闲 ≠ 干等": 空闲时优先 explore/wander 探索推进, 只有明确在等人/等事才纯等待。
        const idle = await idleWait()
        pushActivity({ source: 'agent', kind: 'idle', text: JSON.stringify(idle).slice(0, 300) })
        messages.push({
          role: 'user',
          content: `【系统提示】你上一条回复没有调用工具。已替你待机等待, 结果: ${JSON.stringify(idle).slice(0, 250)}。如果你一直没在等人/等事, 不要继续干等——用 explore 探索周围、wander 走走、或调用工具推进目标(goal); 只有明确在等人/等事时才 wait。`,
        })
      }
      trimMessages()
    } catch (err) {
      stats.last_error = String(err?.message || err)
      await sleep(5000)
    }
  }
}

// 空转: 待机 = wait(事件秒醒, 含"有人靠近"感知) + 纯超时无事后本地走动一小段。
// 未连接/失败时用真实睡眠兜底, 防止热循环刷 API。观察期内不走动, 纯等玩家说话。
async function idleWait() {
  if (!state.bot) {
    await sleep(10000)
    return { note: '未连接到服务器, 空转等待 10 秒' }
  }
  const startedAt = Date.now()
  const observing = observeUntil > Date.now()
  // 观察期: 纯 wait 拉长, 等玩家说话/靠近; 非观察期第一段也先 wait
  const { isError, payload } = await executeTool('wait', { seconds: observing ? 25 + Math.floor(Math.random() * 10) : 15 + Math.floor(Math.random() * 10) })
  if (isError) {
    await sleep(8000)
    return payload
  }
  // 纯超时(没被事件/靠近唤醒): 非观察期本地走动一小段; 观察期保持安静观察
  if (payload?.timed_out && !observing) {
    const w = await executeTool('wander', { seconds: 15 + Math.floor(Math.random() * 15), interrupt_on_chat: true })
    if (!w.isError && Date.now() - startedAt < 1500) await sleep(3000)
    return { wait_payload: payload, wandered: w.payload }
  }
  // 极短返回时补一个下限, 避免异常状态下热循环
  if (Date.now() - startedAt < 1500) await sleep(3000)
  return payload
}
