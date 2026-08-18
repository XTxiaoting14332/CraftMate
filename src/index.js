#!/usr/bin/env node
// Minecraft AI 玩家运行时
// - 默认: MCP stdio 服务器(供 code agent 客户端调用) + Web 面板 + 可选自主 Agent
// - MC_MCP=0: 纯独立模式(不开 stdio, 只靠面板连接 + 自主 Agent 玩)
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { state } from './bot.js'
import { TOOLS, executeTool } from './registry.js'
import { personaPromptText } from './persona.js'
import { loadConfig } from './persona.js'
import { startPanel } from './panel.js'
import { startAgent, agentStatus } from './agent.js'

const server = new Server(
  { name: 'minecraft-mcp', version: '0.1.0' },
  { capabilities: { tools: {}, prompts: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

// 人设 prompt: 客户端可通过 prompts/get "persona" 拉取完整角色设定(含说话方式与游玩守则)
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'persona',
      description: 'AI 玩家人设(来自 config.json): 身份/背景/说话方式/行为守则/游玩循环建议。建议会话开始时注入。',
    },
  ],
}))

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params?.name !== 'persona') {
    throw new Error(`未知 prompt: ${request.params?.name}`)
  }
  return {
    description: 'AI 玩家人设与游玩方式',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: personaPromptText(state.bot?.username) },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name
  const args = request.params?.arguments ?? {}
  const { isError, payload } = await executeTool(name, args)
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
})

process.on('unhandledRejection', (err) => console.error('[minecraft-mcp] unhandledRejection:', err))
process.on('uncaughtException', (err) => console.error('[minecraft-mcp] uncaughtException:', err))
process.on('SIGINT', () => {
  try { state.bot?.quit() } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300)
})

const headless = process.env.MC_MCP === '0'
if (!headless) {
  await server.connect(new StdioServerTransport())
  console.error('[minecraft-mcp] stdio server started, tools:', TOOLS.length)
} else {
  console.error('[minecraft-mcp] 独立模式(MC_MCP=0): stdio MCP 已关闭, 使用 Web 面板 + 自主 Agent')
}

startPanel()

// 自主 Agent: config.agent.auto_start 开启时自动启动(未连接/未配置会安全空转等待)
const agentCfg = loadConfig().agent
if (agentCfg?.auto_start) {
  startAgent()
  console.error('[minecraft-mcp] 自主 Agent 已随配置自动启动, 状态:', agentStatus().running)
}
