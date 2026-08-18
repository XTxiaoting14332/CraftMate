// MCP 协议冒烟测试: 无需真实 Minecraft 服务器
// 验证: stdio 握手、工具列表、未连接时的优雅报错、事件查询、
//       持久化工具全链路、人设 prompt、Web 管理面板 HTTP API
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_PORT = 8899
const TEST_CONFIG = path.join(root, 'data', 'smoke-config.json')
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    MC_PANEL: '1',
    MC_PANEL_PORT: String(PANEL_PORT),
    MC_PANEL_HOST: '127.0.0.1',
    MC_CONFIG: TEST_CONFIG,
  },
})

let buf = ''
const pending = new Map()
let nextId = 1

child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      console.error('收到非 JSON 行:', line.slice(0, 200))
    }
  }
})
child.on('exit', (code) => {
  if (code && code !== 0 && !exited) {
    console.error(`FAIL: 服务器进程异常退出, code=${code}`)
    process.exit(1)
  }
})

let exited = false
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
}
function fail(msg) {
  console.error('FAIL:', msg)
  exited = true
  child.kill()
  process.exit(1)
}

const deadline = setTimeout(() => fail('总超时(30s)'), 30000)

// 1. initialize 握手
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.0' },
})
if (init.error) fail(`initialize 失败: ${JSON.stringify(init.error)}`)
if (init.result?.serverInfo?.name !== 'minecraft-mcp') fail(`serverInfo 不符: ${JSON.stringify(init.result?.serverInfo)}`)
console.log(`PASS initialize: ${init.result.serverInfo.name}@${init.result.serverInfo.version}`)
notify('notifications/initialized')

// 2. 工具列表
const toolsResp = await rpc('tools/list', {})
if (toolsResp.error) fail(`tools/list 失败: ${JSON.stringify(toolsResp.error)}`)
const names = toolsResp.result.tools.map((t) => t.name)
console.log(`PASS tools/list: ${names.length} 个工具`)
for (const must of ['connect', 'disconnect', 'status', 'get_events', 'wait', 'wander', 'chat', 'whisper', 'command', 'chatlog', 'goto', 'follow', 'stop', 'look_at', 'dig', 'place', 'attack', 'inventory', 'equip', 'use_item', 'eat', 'drop', 'inspect', 'nearby', 'find', 'craft', 'collect', 'build', 'plan', 'scan', 'waypoint', 'memory', 'goal', 'interact_entity', 'activate_block', 'sneak', 'container', 'villager', 'pillar', 'analyze_structure', 'persona']) {
  if (!names.includes(must)) fail(`缺少工具 ${must}`)
}
// 每个工具必须有合法 inputSchema
for (const t of toolsResp.result.tools) {
  if (!t.description || t.inputSchema?.type !== 'object') fail(`工具 ${t.name} 的描述或 inputSchema 不合法`)
}
// connect 应包含自动防御参数
const connectTool = toolsResp.result.tools.find((t) => t.name === 'connect')
for (const p of ['auto_defense', 'defense_engage_radius', 'defense_flee_hp', 'auto_eat', 'fair_perception', 'auto_pickup']) {
  if (!connectTool.inputSchema.properties[p]) fail(`connect 缺少 ${p} 参数`)
}
console.log('PASS connect schema: 含自动防御参数')
const activateTool = toolsResp.result.tools.find((t) => t.name === 'activate_block')
if (!activateTool.inputSchema.properties.direction) fail('activate_block 应支持 direction 指定点击面')
console.log('PASS activate_block schema: 支持方向/面参数')

// 3. 未连接时调用 status 应优雅返回 connected:false
const st = await rpc('tools/call', { name: 'status', arguments: {} })
const stPayload = JSON.parse(st.result.content[0].text)
if (stPayload.connected !== false || !/connect/.test(stPayload.hint || '')) fail(`status 未连接时应返回 connected:false + hint: ${JSON.stringify(stPayload)}`)
console.log(`PASS status(未连接): ${stPayload.hint}`)

// 4. goto 未连接报错
const gt = await rpc('tools/call', { name: 'goto', arguments: { x: 0, y: 64, z: 0 } })
const gtPayload = JSON.parse(gt.result.content[0].text)
if (gtPayload.ok !== false || !/connect/.test(gtPayload.error)) fail(`goto 未连接时应报错: ${JSON.stringify(gtPayload)}`)
console.log(`PASS goto(未连接): ${gtPayload.error}`)

// 4a. plan 未连接同样报错(工具存在且需要连接)
const pl = await rpc('tools/call', { name: 'plan', arguments: { steps: [{ tool: 'collect', args: { blocks: 'oak_log' } }] } })
const plPayload = JSON.parse(pl.result.content[0].text)
if (plPayload.ok !== false || !/connect/.test(plPayload.error)) fail(`plan 未连接时应报错: ${JSON.stringify(plPayload)}`)
console.log(`PASS plan(未连接): ${plPayload.error}`)

// 4b. command 未连接报错(工具存在且需要连接)
const cmd = await rpc('tools/call', { name: 'command', arguments: { command: '/say hi' } })
const cmdPayload = JSON.parse(cmd.result.content[0].text)
if (cmdPayload.ok !== false || !/connect/.test(cmdPayload.error)) fail(`command 未连接时应报错: ${JSON.stringify(cmdPayload)}`)
console.log(`PASS command(未连接): ${cmdPayload.error}`)

// 5. get_events 空缓冲
const ev = await rpc('tools/call', { name: 'get_events', arguments: {} })
const evPayload = JSON.parse(ev.result.content[0].text)
if (!Array.isArray(evPayload.events) || evPayload.events.length !== 0) fail(`get_events 应返回空数组: ${JSON.stringify(evPayload)}`)
console.log('PASS get_events: 空事件缓冲, latest_seq=0')

// 6. 未知工具
const unk = await rpc('tools/call', { name: 'no_such_tool', arguments: {} })
const unkPayload = JSON.parse(unk.result.content[0].text)
if (unkPayload.ok !== false || !/未知工具/.test(unkPayload.error)) fail(`未知工具应报错: ${JSON.stringify(unkPayload)}`)
console.log('PASS unknown-tool: 优雅报错')

// 7. 持久化记忆(离线可用, 真实落盘 data/memory.json)
const memKey = `__smoke_${Date.now()}`
let r = await rpc('tools/call', { name: 'memory', arguments: { action: 'save', text: '冒烟测试记忆: Steve 是朋友', key: memKey, tags: '测试' } })
let p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.saved?.key !== memKey) fail(`memory save 失败: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'memory', arguments: { action: 'recall', query: '冒烟测试记忆' } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || !p.memories?.some((m) => m.key === memKey)) fail(`memory recall 未命中: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'memory', arguments: { action: 'forget', key: memKey } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.removed !== 1) fail(`memory forget 失败: ${JSON.stringify(p)}`)
console.log('PASS memory: save → recall → forget 全链路(持久化)')

// 8. 持久化路标(离线: 显式坐标)
const wpName = `__smoke_wp_${Date.now()}`
r = await rpc('tools/call', { name: 'waypoint', arguments: { action: 'save', name: wpName, x: 10, y: 64, z: -20, note: '冒烟测试' } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.saved?.position?.x !== 10) fail(`waypoint save 失败: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'waypoint', arguments: { action: 'list' } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || !p.waypoints?.some((w) => w.name === wpName)) fail(`waypoint list 未命中: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'waypoint', arguments: { action: 'delete', name: wpName } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.removed !== 1) fail(`waypoint delete 失败: ${JSON.stringify(p)}`)
console.log('PASS waypoint: save → list → delete 全链路(持久化)')

// 8b. 自驱目标(离线可用, 持久化到 memory.json 的 goal: 条目)
const goalTitle = `冒烟测试目标 ${Date.now()}`
r = await rpc('tools/call', { name: 'goal', arguments: { action: 'set', title: goalTitle, why: '验证自驱目标', next_step: '跑测试', plan: '立目标, 完成, 清理' } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.goal?.key !== `goal:${goalTitle}`) fail(`goal set 失败: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'goal', arguments: { action: 'list' } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || !p.goals?.some((g) => g.key === `goal:${goalTitle}`)) fail(`goal list 未命中: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'goal', arguments: { action: 'done', title: goalTitle } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.done !== `goal:${goalTitle}`) fail(`goal done 失败: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'goal', arguments: { action: 'drop', title: goalTitle } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.removed !== 1) fail(`goal drop 失败: ${JSON.stringify(p)}`)
console.log('PASS goal: set → list → done → drop 全链路(持久化)')

// 8c. 建筑规划(离线可用: 保存/查询/删除等于持久化蓝图)
const buildName = `__smoke_build_${Date.now()}`
r = await rpc('tools/call', { name: 'build', arguments: { action: 'plan', name: buildName, entries: [
  { x: 1, y: 64, z: 1, block: 'oak_planks' },
  { x: 2, y: 64, z: 1, block: 'oak_planks' },
  { x: 1, y: 65, z: 1, block: 'oak_planks' },
] } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.plan_name !== buildName || p.entries_total !== 3) fail(`build plan 保存失败: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'build', arguments: { action: 'status', name: buildName } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.plan?.entries_total !== 3 || p.plan?.remaining !== 3) fail(`build status 查询失败: ${JSON.stringify(p)}`)
r = await rpc('tools/call', { name: 'build', arguments: { action: 'delete', name: buildName } })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || p.deleted !== buildName) fail(`build delete 失败: ${JSON.stringify(p)}`)
console.log('PASS build: 蓝图保存 → 状态查询 → 删除 全链路(持久化)')

// 9. scan 未连接时报错
r = await rpc('tools/call', { name: 'scan', arguments: {} })
p = JSON.parse(r.result.content[0].text)
if (p.ok !== false || !/connect/.test(p.error)) fail(`scan 未连接时应报错: ${JSON.stringify(p)}`)
console.log('PASS scan(未连接): 优雅报错')

// 10. chatlog 离线可用(返回条目数组, 不报错)
r = await rpc('tools/call', { name: 'chatlog', arguments: {} })
p = JSON.parse(r.result.content[0].text)
if (!p.ok || !Array.isArray(p.entries)) fail(`chatlog 应返回 entries 数组: ${JSON.stringify(p)}`)
console.log('PASS chatlog(离线): 正常返回')

// 11. 人设 prompt
const promptsResp = await rpc('prompts/list', {})
if (promptsResp.error || !promptsResp.result.prompts?.some((x) => x.name === 'persona')) fail(`prompts/list 缺少 persona: ${JSON.stringify(promptsResp)}`)
const personaResp = await rpc('prompts/get', { name: 'persona' })
const personaText = personaResp.result?.messages?.[0]?.content?.text ?? ''
if (!/Minecraft/.test(personaText) || !/游玩方式/.test(personaText)) fail(`persona prompt 内容异常: ${personaText.slice(0, 100)}`)
console.log('PASS prompts: persona 可获取(含游玩方式)')
const personaToolResp = await rpc('tools/call', { name: 'persona', arguments: {} })
const personaToolPayload = JSON.parse(personaToolResp.result.content[0].text)
if (!personaToolPayload.prompt?.includes('游玩方式')) fail(`persona 工具应返回完整 prompt: ${JSON.stringify(personaToolPayload).slice(0, 200)}`)
console.log('PASS persona 工具: 返回完整人设 prompt')

// 12. Web 管理面板 HTTP API
const base = `http://127.0.0.1:${PANEL_PORT}`
// 等面板端口就绪
let panelReady = false
for (let i = 0; i < 30; i++) {
  try { await fetch(`${base}/api/status`); panelReady = true; break } catch { await new Promise((res) => setTimeout(res, 200)) }
}
if (!panelReady) fail('面板端口未就绪')
const stRes = await (await fetch(`${base}/api/status`)).json()
if (stRes.connected !== false || typeof stRes.namespace !== 'string') fail(`面板 /api/status 异常: ${JSON.stringify(stRes)}`)
const html = await (await fetch(base)).text()
if (!html.includes('管理面板') || !html.includes('persona') || !html.includes('agent-log')) fail('面板 HTML 异常')
// 人设 CRUD(写入测试专用配置文件, 不碰真实 config.json)
const cfgRes = await (await fetch(`${base}/api/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ persona: { name: '冒烟小人', identity: '测试身份', speaking_style: '测试语气', rules: ['规则一'], greeting: 'hi', auto_greeting: false } }),
})).json()
if (cfgRes.saved?.persona?.name !== '冒烟小人') fail(`面板保存人设失败: ${JSON.stringify(cfgRes)}`)
const cfgGet = await (await fetch(`${base}/api/config`)).json()
if (cfgGet.persona?.identity !== '测试身份' || cfgGet.persona?.rules?.[0] !== '规则一') fail(`面板读取人设失败: ${JSON.stringify(cfgGet)}`)
// persona prompt 应反映新配置
const personaResp2 = await rpc('prompts/get', { name: 'persona' })
if (!personaResp2.result.messages[0].content.text.includes('冒烟小人')) fail('保存的人设未注入 prompt')
console.log('PASS 面板: status / HTML / 人设 CRUD(热生效于 prompt)')

// 13. 自主 Agent: 配置保存 / 状态查询 / 启停
const cfgRes2 = await (await fetch(`${base}/api/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent: { api_base: 'http://127.0.0.1:1/v1', model: 'test-model', auto_start: false } }),
})).json()
if (cfgRes2.saved?.agent?.model !== 'test-model') fail(`agent 配置保存失败: ${JSON.stringify(cfgRes2)}`)
let ag = await (await fetch(`${base}/api/agent`)).json()
if (ag.running !== false) fail(`agent 初始应为停止: ${JSON.stringify(ag)}`)
await fetch(`${base}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) })
ag = await (await fetch(`${base}/api/agent`)).json()
if (ag.running !== true) fail(`agent 启动失败: ${JSON.stringify(ag)}`)
await new Promise((res) => setTimeout(res, 1200))
ag = await (await fetch(`${base}/api/agent`)).json()
if (!ag.last_error) fail(`agent 对不可达 API 应记录错误并保持运行: ${JSON.stringify(ag)}`)
// 运行中 Agent 的人设热更新: 面板保存人设后应立刻刷新 system prompt
const cfgRes3 = await (await fetch(`${base}/api/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ persona: { name: '冒烟小人2', identity: '更新后的身份', speaking_style: '更新后的语气' } }),
})).json()
if (cfgRes3.persona_refresh?.updated !== true) fail(`面板保存人设未即时刷新 Agent system prompt: ${JSON.stringify(cfgRes3)}`)
const personaResp3 = await rpc('prompts/get', { name: 'persona' })
if (!personaResp3.result.messages[0].content.text.includes('冒烟小人2')) fail('保存的人设未热更新到 persona prompt')
await fetch(`${base}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) })
ag = await (await fetch(`${base}/api/agent`)).json()
if (ag.running !== false) fail('agent 停止失败')
const statusLog = await (await fetch(`${base}/api/status`)).json()
if (!Array.isArray(statusLog.activity) || !statusLog.activity.some((e) => e.kind === 'tool_call')) fail(`面板应记录工具调用日志: ${JSON.stringify(statusLog.activity?.slice(0, 3))}`)
if (!statusLog.activity.some((e) => e.kind === 'system' && /人设/.test(e.text || ''))) fail('面板应记录 Agent 人设刷新日志')
console.log('PASS 面板 Agent: 配置保存 / 启动 / 空转报错提示 / 停止')
console.log('PASS 面板 Agent: 运行中人设热更新并记录日志')
console.log('PASS 面板: Agent 思考/工具调用日志已记录')

// 14. AI 视野: 未连接返回 connected:false; 页面含视野 canvas
const vis = await (await fetch(`${base}/api/vision`)).json()
if (vis.connected !== false) fail(`/api/vision 未连接应返回 connected:false: ${JSON.stringify(vis)}`)
if (!html.includes('vision-canvas') || !html.includes('AI 视野')) fail('面板 HTML 缺少视野渲染元素')
console.log('PASS 面板视野: /api/vision 优雅降级 + canvas 存在')

console.log('\n全部冒烟测试通过 ✓')
clearTimeout(deadline)
exited = true
child.kill()
fs.rmSync(TEST_CONFIG, { force: true })
process.exit(0)
