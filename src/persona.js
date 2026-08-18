// 人设配置: 从 config.json 读取 AI 玩家的身份/说话方式/守则
// 注入途径: ① MCP prompt(prompts/get "persona") ② persona 工具 ③ connect persona_prompt ④ status 摘要 ⑤ 自主 Agent system prompt(热更新)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = process.env.MC_CONFIG || path.join(ROOT, 'config.json')

export const DEFAULT_PERSONA = {
  name: '', // 留空则用机器人用户名
  identity: '',
  speaking_style: '',
  background_story: '',
  rules: [],
  greeting: '',
  auto_greeting: false,
}

export const DEFAULT_AGENT = {
  api_base: '', // OpenAI 兼容地址, 如 https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1
  api_key: '',
  model: '',
  temperature: 0.8,
  max_tokens: 2048,
  auto_start: false, // MCP 启动时自动开始自主游玩
  timeout_ms: 120000,
  habits: true, // 习惯学习: 记录工具调用序列, 高置信度下一步在模型思考前本地执行
  habit_min_confidence: 0.7, // 惯性执行的最低置信度
  habit_max_chain: 2, // 单轮最多连续惯性执行次数
  chat_side: true, // 边干活边聊天: 长任务执行期间并行回复玩家(不打断任务)
  side_chat_timeout_ms: 45000, // 旁路最长运行时间(任务本身可能更长, 超时后未回复的留给主循环)
  observe_seconds: 90, // 进服观察期: 刚进服不干活(砍树/挖矿/建房子会被拦截), 先观察环境/回应玩家
}

export function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const p = parsed?.persona ?? {}
    return {
      persona: { ...DEFAULT_PERSONA, ...p, rules: Array.isArray(p.rules) ? p.rules : [] },
      agent: { ...DEFAULT_AGENT, ...(parsed?.agent ?? {}) },
    }
  } catch {
    return { persona: { ...DEFAULT_PERSONA }, agent: { ...DEFAULT_AGENT } }
  }
}

export function saveConfig(patch = {}) {
  const cur = loadConfig()
  const next = {
    persona: patch.persona
      ? { ...cur.persona, ...patch.persona, rules: Array.isArray(patch.persona.rules) ? patch.persona.rules : cur.persona.rules }
      : cur.persona,
    agent: patch.agent ? { ...cur.agent, ...patch.agent } : cur.agent,
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  // 覆写前备份: config.json.bak 永远保留上一版内容, 误写可回滚
  try {
    const prev = fs.readFileSync(CONFIG_PATH, 'utf8')
    if (prev !== JSON.stringify(next, null, 2)) fs.writeFileSync(`${CONFIG_PATH}.bak`, prev, 'utf8')
  } catch { /* 首次写入无备份 */ }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function loadPersona() {
  return loadConfig().persona
}

export function savePersona(persona) {
  return saveConfig({ persona }).persona
}

// 组装成完整的"角色 prompt"(MCP prompt 与连接注入共用)
export function personaPromptText(username) {
  const p = loadPersona()
  const name = p.name || username || 'AI 玩家'
  const lines = []
  lines.push(`你在 Minecraft 服务器里扮演一名真实玩家「${name}」。`)
  if (p.identity) lines.push(`\n## 人设\n${p.identity}`)
  if (p.background_story) lines.push(`\n## 背景故事\n${p.background_story}`)
  if (p.speaking_style) lines.push(`\n## 说话方式\n${p.speaking_style}`)
  if (p.rules?.length) lines.push(`\n## 行为守则\n${p.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
  if (p.greeting) lines.push(`\n## 进服问候(参考)\n${p.greeting}`)
  lines.push(`\n## 游玩方式
- 全程保持人设说话, 不暴露技术实现细节
- 说话只用两个工具: 公屏直接发 chat(不要前缀 /tell /msg /say), 私聊用 whisper; 聊天消息永远不用 command 发送
- 你是自主玩家, 不是命令执行器: 有自己的游戏目标和生活节奏(探索/建设/攒资源/交朋友都算), 不用等玩家下指令
- 进服先 goal(list) 或 memory(recall, query="goal:") 看之前自己在忙什么; 没有目标就 goal(set) 立一个(动机 + 下一步 + 计划), 然后按计划动手
- 完成一步就推进下一步, 完成后 goal(done) 更新并立新目标; 关键进展记 memory, 地点存 waypoint
- 建房子/摆多个方块先用 build 规划蓝图(plan→need→collect/craft→place), 本地程序会一次施工, 不要一格一格放
- 空闲时优先做当前目标相关的事; 只有明确在等人/等事时才 wait(10~30) 或 wander, 有人说话立即回复
- 拟真感知默认开启(不透视矿物), 挖掘/采集前用 analyze_structure 确认不是别人的建筑`)
  return lines.join('\n')
}
