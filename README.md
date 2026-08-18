# CraftMate

CraftMate 是一个基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 与 Model Context Protocol (MCP) 构建的 Minecraft AI 玩家运行时。

项目旨在让大语言模型（LLM）以拟人化玩家的身份接入 Minecraft 服务器，支持与真人交互、世界感知、RPG 物品 Lore 读取、蓝图建造以及基于生存本能的低延迟自主决策。

---

## 运行模式

1. **MCP 模式（默认）**
   作为标准 MCP 服务器（通过 stdio 传输），供外部 MCP 客户端（如 Claude Desktop、Cursor、ZCode 等）调用，提供 42 个细粒度与复合控制工具。
2. **独立自主模式（Standalone）**
   内置 Agent 决策循环，直接对接兼容 OpenAI 接口的大模型 API。无需外部客户端宿主，自主规划目标并持续游玩。

---

## 主要特性

- **低延迟复合动作**：寻路（`goto`）、范围采集（`collect`）、蓝图施工（`build`）等耗时任务由本地原生执行，模型仅下发意图，减少网络往返延迟。
- **生存本能防御**：遭受攻击或低生命值时，本地自动执行反击、后撤与进食；处于暗光环境（光照 < 7）时自动顺手放置光源。
- **真实视线与反透视感知**：感知范围严格受限于视线与触及距离，默认过滤未暴露方块与墙后实体，贴近真实玩家视野。
- **RPG 与服务器适配**：支持物品 Lore 解析（自定义称号、属性与附魔）、容器存取与自定义 NPC 菜单交互、玩家身份指令执行（如 `/login`、`/menu`）。
- **持久化状态与记忆**：支持跨会话保存路标（Waypoints）、长期记忆（Memories）与任务目标（Goals）。
- **内置 Web 管理面板**：提供基础状态监视、地图渲染、事件日志流查看以及人设规则的热重载配置。

---

## 快速上手

### 环境要求

- Node.js >= 18.17
- Minecraft Java Edition 服务器（支持 1.8 ~ 1.21.x）

### 安装

```bash
git clone https://github.com/XTxiaoting14332/CraftMate.git
cd CraftMate
npm install
```

### 配置文件

复制配置模板并根据需要调整(独立运行下可直接在面板进行调整)：

```bash
cp config.example.json config.json
```

`config.json` 包含人设与自主 Agent 两部分配置：

```json
{
  "persona": {
    "name": "小明",
    "identity": "新加入服务器的玩家，喜欢挖矿与探险",
    "speaking_style": "口语化短句，不使用长篇大论或书面语",
    "rules": [
      "如果提示需要登录，执行 /login 命令",
      "保护自己的安全，遇到危险优先撤退"
    ]
  },
  "agent": {
    "api_base": "https://api.openai.com/v1",
    "api_key": "YOUR_API_KEY",
    "model": "gpt-5.6-luna",
    "temperature": 0.7,
    "max_tokens": 2048,
    "auto_start": false
  }
}
```

### 启动方式

- **作为 MCP 服务器运行**：
  ```bash
  npm start
  ```
- **独立自主模式运行**（仅 Web 面板 + 内置 Agent）：
  ```bash
  npm run standalone
  ```
- **运行测试套件**（含冒烟测试与模拟场景验证）：
  ```bash
  npm test
  ```

启动后可访问内置 Web 控制面板：`http://127.0.0.1:8765`（支持局域网设备直接访问）。

---

## 环境变量配置

所有配置均可通过系统环境变量或 MCP 客户端的 `env` 字段进行覆盖：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| **`MC_PANEL`** | `1` | 是否开启 Web 管理面板，设为 `0` 可完全关闭 |
| **`MC_PANEL_PORT`** | `8765` | Web 管理面板服务端口 |
| **`MC_PANEL_HOST`** | `0.0.0.0` | 管理面板监听地址（设为 `127.0.0.1` 仅允许本机访问） |
| **`MC_PANEL_TOKEN`** | `""` | 可选访问令牌。设置后访问面板需带 `?token=xxx` 或 `Authorization: Bearer` 请求头 |
| **`MC_MCP`** | `1` | 是否开启 stdio MCP 服务，设为 `0` 对应纯独立模式 |
| **`MC_CONFIG`** | `./config.json` | 指定自定义配置文件路径 |
| **`MC_HOST`** | `127.0.0.1` | 默认目标 Minecraft 服务器地址 |
| **`MC_PORT`** | `25565` | 默认目标 Minecraft 服务器端口 |
| **`MC_USERNAME`** | `AI_Player` | 默认 Bot 玩家名称 |
| **`MC_VERSION`** | 自动检测 | 指定游戏版本（如 `1.20.4`），留空则自动协商 |
| **`MC_AUTH`** | `offline` | 认证方式：`offline`（离线/盗版）或 `microsoft`（微软正版） |
| **`MC_PASSWORD`** | 无 | 微软账号密码或正版认证凭据 |
| **`MC_RECONNECT_MAX`** | `5` | 掉线后自动重连的最大重试次数 |
| **`MC_VIEWER`** | `0` | 是否开启网页端 3D 实况视角（设为 `1` 启用） |
| **`MC_VIEWER_PORT`** | `3002` | 3D 实况视角服务端口 |

---

## MCP 客户端配置

在支持 MCP 的客户端配置中添加如下内容：

```json
{
  "mcpServers": {
    "craftmate": {
      "command": "node",
      "args": ["/path/to/CraftMate/src/index.js"],
      "env": {
        "MC_HOST": "127.0.0.1",
        "MC_PORT": "25565",
        "MC_USERNAME": "CraftMate_Bot"
      }
    }
  }
}
```

进入游戏后可通过调用 `connect` 工具连接目标服务器：

```text
connect(host="127.0.0.1", port=25565, username="Bot_Player", auth="offline")
```

---

## 工具列表

CraftMate 提供 42 个 MCP 工具，按功能分类如下：

| 类别 | 工具 | 功能说明 |
|---|---|---|
| **连接与状态** | `connect`, `disconnect`, `status`, `persona` | 连接/断开服务器、全量状态查询、获取角色设定 Prompt |
| **社交与通信** | `chat`, `whisper`, `command`, `get_events`, `wait`, `chatlog` | 公屏与私聊、执行命令、事件队列轮询、事件等待阻塞唤醒、持久化聊天记录 |
| **移动与寻路** | `goto`, `follow`, `wander`, `explore`, `stop`, `look_at`, `sneak` | A* 寻路、实体跟随、区域闲逛、长程探索、急停、视角调整、潜行 |
| **战斗** | `attack` | 单次攻击或持续追击目标 |
| **世界与感知** | `dig`, `place`, `inspect`, `nearby`, `find`, `scan`, `analyze_structure` | 方块挖掘/放置、方块与容器检查、实体感知、方块搜索、高度图扫描、建筑模式分析 |
| **交互** | `interact_entity`, `activate_block`, `container`, `villager`, `pillar` | 右键交互实体/方块、容器存取与菜单点击、村民交易、原地向上搭柱 |
| **物品管理** | `inventory`, `equip`, `use_item`, `eat`, `drop`, `craft` | 物品栏与 Lore 读取、装备穿戴、物品右键使用、进食、丢弃、工作台合成 |
| **复合与建筑** | `collect`, `plan`, `build` | 自动找方块并采集、本地复合动作序列执行、蓝图保存与自动施工 |
| **记忆与目标** | `waypoint`, `memory`, `goal` | 坐标路标管理、长期记忆读写、自主目标规划与追踪 |

---

## 目录结构

```text
CraftMate/
├── src/
│   ├── index.js          # 入口：MCP stdio 注册、Web 面板拉起、Agent 启动管理
│   ├── registry.js       # 42 个 MCP 工具的 JSON Schema 契约定义与统一分发
│   ├── bot.js            # mineflayer 实例生命周期与事件监听
│   ├── agent.js          # 内置 Agent 决策循环与边执行边思考机制
│   ├── panel.js          # Web 管理面板（Express + WebSocket）
│   ├── persona.js        # 角色人设系统与 Prompt 生成
│   ├── actions.js        # 基础动作实现（挖掘/放置/攻击/合成等）
│   ├── movement.js       # 寻路与移动行为
│   ├── building.js       # 蓝图建筑与施工模块
│   ├── defense.js        # 自动防御与生存本能
│   ├── lighting.js       # 光源自动放置
│   ├── world.js          # 世界感知与反矿透视线过滤
│   ├── interact.js       # 实体/方块交互与容器操作
│   ├── items.js          # 物品与 Lore 解析
│   ├── social.js         # 聊天、指令与事件系统
│   ├── store.js          # 路标、记忆与目标的本地持久化
│   └── context.js        # 运行时上下文与状态汇总
├── test/                 # 单元与场景模拟测试
├── config.example.json   # 配置文件模板
└── package.json
```

---

## 开源协议

本项目采用 [GNU General Public License v3.0](LICENSE) 开源。
