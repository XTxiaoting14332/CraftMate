// 工具注册表: 工具定义 + 处理器 + 统一分发(MCP stdio 与自主 Agent 共用)
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import {
  state, disconnectBot, requireBot, currentNs,
  eventsSince, drainNewEvents, currentTask, runTask, cancelTask, pushActivity, recordSelfChat,
} from './bot.js'
import { formatItem, itemTitle } from './items.js'
import { pathfindTo, followPlayer, resolvePlayerEntity, resolveEntity, lookAtPoint } from './movement.js'
import { inspectBlock, nearbySummary, findBlocksTool, proximityScan } from './world.js'
import * as actions from './actions.js'
import { stopDefense, defenseStatus } from './defense.js'
import { scanTerrain } from './scan.js'
import { analyzeStructure } from './structure.js'
import * as interact from './interact.js'
import { startHumanize, stopHumanize, sendChatHumanized, sendWhisperHumanized, wanderAround, exploreAround } from './humanize.js'
import { currentLight, lightLabel } from './lighting.js'
import { connectFull, disconnectFull } from './session.js'
import { loadPersona, personaPromptText } from './persona.js'
import { saveBuildingPlan, getBuildingPlan, buildSavedPlan, listBuildingPlansLocal, removeBuildingPlan, computeMaterials, buildingSummary, validateBlueprint } from './building.js'
import { startPanel } from './panel.js'
import { contextSnapshot } from './context.js'
import {
  listWaypoints, findWaypoint, saveWaypoint, deleteWaypoint,
  saveMemory, recallMemories, forgetMemory, listMemories, listChatLog,
  lastConnection,
} from './store.js'
import { fmtPos, round1, facingOf, timeLabelOfTicks, nearestLandmark, directionBetween } from './util.js'


export const TOOLS = [
  {
    name: 'connect',
    description: '连接到 Minecraft 服务器并以机器人玩家身份进入。成功后返回初始状态。默认开启自动防御(生存反射)。参数可用环境变量 MC_HOST/MC_PORT/MC_USERNAME/MC_VERSION/MC_AUTH 预设默认值。',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '服务器地址(必填), 如 127.0.0.1 或 play.example.com' },
        port: { type: 'number', description: '端口, 默认 25565' },
        username: { type: 'string', description: '机器人玩家名, 默认 AI_Player' },
        version: { type: 'string', description: '游戏版本如 1.20.4; 留空自动检测(支持 1.8~1.21.x)' },
        auth: { type: 'string', enum: ['offline', 'microsoft'], description: '登录方式; 离线服用 offline(默认), 正版服用 microsoft' },
        password: { type: 'string', description: '密码(仅账号体系需要时填写)' },
        auto_respawn: { type: 'boolean', description: '死亡后约 2 秒自动重生, 默认 true' },
        auto_defense: { type: 'boolean', description: '本地生存反射(不经过 AI): 敌对生物进入警戒半径自动反击(苦力怕打了就跑)、生命过低自动撤退、脱险后自动进食回血, 全程产生 auto_defense 事件。默认 true' },
        defense_engage_radius: { type: 'number', description: '自动防御警戒半径(格), 默认 8' },
        defense_flee_hp: { type: 'number', description: '生命值低于该值触发自动撤退, 默认 6' },
        auto_eat: { type: 'boolean', description: '安全且需要回血时自动进食, 默认 true' },
        fair_perception: { type: 'boolean', description: '拟真感知(反矿透), 默认 true: find/collect 只搜暴露的方块(洞壁/地表可见), inspect 限视线/触及范围, nearby 过滤墙后实体。自建服调试可设 false' },
        humanize: { type: 'boolean', description: '拟人化, 默认 true: 空闲时随机张望/看向说话的玩家、聊天按打字速度分句发送、战斗侧向走位、平滑转头、短途不疾跑' },
        auto_pickup: { type: 'boolean', description: '空闲掉落物巡检, 默认 true: 本地周期性扫描视野内掉落物并自动拾取, 捡到后产生 auto_pickup 事件' },
        auto_summary: { type: 'boolean', description: '断线时自动保存会话总结到该服务器的记忆(key="上次会话"), 默认 true' },
        auto_reconnect: { type: 'boolean', description: '掉线后自动重连(指数退避 5s~60s, 最多 MC_RECONNECT_MAX 次, 默认 5), 默认 true; 手动 disconnect 不触发' },
        auto_torch: { type: 'boolean', description: '黑暗自动放光源(本能反射): 所处位置光照 <7 且背包有火把/灯笼等且空闲时自动放置, 产生 auto_torch 事件。默认 true' },
      },
      required: ['host'],
    },
  },
  {
    name: 'disconnect',
    description: '断开与服务器的连接。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: '一次性获取完整状态快照: 服务器信息、自身位置/朝向/生命/饥饿/经验、手持物品(含 Lore)、快捷栏、在线玩家、世界时间、当前任务。是"我在哪、我是谁、我在干什么"的权威来源。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_events',
    description: '读取事件缓冲(聊天、私聊、系统消息、受击、死亡、玩家进出、被踢等)。提示: 每个工具的返回都会自动附带 new_events, 一般无需单独调用; 需要回看历史时用 since 序号增量拉取。',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'number', description: '只返回 seq 大于该值的事件; 不填则返回全部缓冲(最近 500 条)' } },
    },
  },
  {
    name: 'chat',
    description: '在公屏发一条聊天消息(直接出现在聊天框, 带拟人打字节奏)。这是你说话的唯一直观方式; 不要用 /tell /msg /w /say 之类发消息。以 / 开头的其他命令会作为服务器命令执行(如 /tp、/home)。发送即时返回, 之后的回复会出现在工具返回的 new_events 里。',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: '消息内容' } },
      required: ['message'],
    },
  },
  {
    name: 'whisper',
    description: '私聊某位玩家(/msg)。',
    inputSchema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '目标玩家名' },
        message: { type: 'string', description: '消息内容' },
      },
      required: ['player', 'message'],
    },
  },
  {
    name: 'command',
    description: '以玩家身份执行一条服务器命令(必须以 / 开头, 如 /tp、/home、/back、/give)。【禁止用这个工具发聊天消息】: 禁止 /tell、/msg、/w、/say(公屏用 chat, 私聊用 whisper)。命令走聊天通道即时发送, 无打字延迟; 执行结果/权限不足/冷却等反馈出现在之后工具返回的 new_events(system/chat/action_bar)。权限取决于服务器配置, 部分命令需要管理员或插件授权。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '完整命令, 必须以 / 开头, 如 /tp 小明 100 64 100' },
      },
      required: ['command'],
    },
  },
  {
    name: 'wait',
    description: '【事件等待】挂起等待最多 N 秒(默认 30), 事件或"有人靠近"立即唤醒: 玩家聊天/私聊/受击/死亡/被踢/自动防御, 或有玩家新进入 10 格/敌对生物进入 12 格(眼角余光)。每次返回自动附带 nearby 快照(周围玩家/生物/掉落物)——"醒来即睁眼"。比反复轮询省调用; 空闲时建议用它等待而不是结束回合。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '最长等待秒数, 1-300, 默认 30' },
      },
    },
  },
  {
    name: 'wander',
    description: '【闲逛】拟人化地在附近溜达: 随机选寻路可达的近点走过去, 平坦安全路段偶尔疾跑+跳跃(起跳前本地预扫前方 5 格: 落差/水/岩浆/陡坡, 不安全就正常走), 走走停停张望。有人说话提前返回, 可被 stop/自动防御打断。适合"等人/没事干"时使用, 比干等更像真人。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '闲逛秒数, 3-600, 默认 60' },
        interrupt_on_chat: { type: 'boolean', description: '期间有人说话立即返回以便回复, 默认 true' },
      },
    },
  },
  {
    name: 'explore',
    description: '【探索】连续走更远(每次 12~40 格)、沿途周期性感知周围(玩家/生物/掉落物/NPC), 把发现整理成探索报告一次返回——一次探索 = 连续行动 + 信息收集, 不用一步步 goto+nearby 来回。有人说话/窗口弹出立即返回以便处理。适合进新服摸底、找村庄/玩家/资源、熟悉地形。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '探索秒数, 10-600, 默认 90' },
        interrupt_on_chat: { type: 'boolean', description: '期间有人说话/窗口弹出立即返回以便回复, 默认 true' },
      },
    },
  },
  {
    name: 'chatlog',
    description: '【持久化聊天记录】查看本服务器的聊天历史(公屏/私聊/系统消息, 存本地文件, MCP 重启后仍在)。get_events 只有本次会话的内存缓冲, 更早/错过的消息都在这里——重连后先看它。支持关键词过滤(玩家名/内容)。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最近多少条, 默认 50, 上限 200' },
        query: { type: 'string', description: '可选: 关键词过滤(匹配玩家名/消息内容)' },
        server: { type: 'string', description: '可选: 指定服务器(host:port), 默认当前/上次连接的' },
      },
    },
  },
  {
    name: 'goto',
    description: '【低延迟核心】一次调用 = 完整导航: 本地 A* 规划并以正常行走速度原生执行(自动跳跃/绕行/开门), 到达/超时/被打断才返回, 无需逐步指挥移动。可给坐标、player(走向某玩家)或 waypoint(已保存的路标名)。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标(与 y/z 一起提供)' },
        y: { type: 'number', description: '目标 Y 坐标' },
        z: { type: 'number', description: '目标 Z 坐标' },
        player: { type: 'string', description: '替代坐标: 走到该玩家当前位置附近' },
        waypoint: { type: 'string', description: '替代坐标: 已保存的路标名(waypoint 工具保存的)' },
        range: { type: 'number', description: '到达判定半径(格), 默认 1; 走向玩家时默认 2' },
        timeout_ms: { type: 'number', description: '超时毫秒, 默认 120000; 超时会停在原地并报告剩余距离' },
        allow_dig: { type: 'boolean', description: '允许途中挖方块开路, 默认 false(防止破坏建筑)' },
        allow_place: { type: 'boolean', description: '允许途中放置方块搭桥/搭台阶(消耗泥土/圆石等), 默认 false(防止意外改动世界)' },
        interrupt_on_event: { type: 'boolean', description: '途中有人说话/受击时中断寻路提前返回(便于回复), 默认 true' },
      },
    },
  },
  {
    name: 'follow',
    description: '【长时意图】持续跟随一位玩家(自动寻路+面向他), 直到时长结束/目标消失/被 stop 打断。一次下发, 持续执行。',
    inputSchema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要跟随的玩家名' },
        duration_s: { type: 'number', description: '跟随秒数, 默认 60' },
        distance: { type: 'number', description: '保持的距离(格), 默认 3' },
        interrupt_on_chat: { type: 'boolean', description: '期间有人说话立即返回以便回复, 默认 true' },
      },
      required: ['player'],
    },
  },
  {
    name: 'stop',
    description: '紧急停止: 打断当前正在执行的任务(goto/follow/collect/战斗/挖掘)并停止寻路, 也会打断自动防御的当前动作。随时可调用。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'look_at',
    description: '把视角转向某个坐标或实体(玩家/生物)。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        entity: { type: 'string', description: '目标名称(玩家名或实体名), 与坐标二选一' },
      },
    },
  },
  {
    name: 'dig',
    description: '挖掘方块(自动选工具: 镐/斧/锹按方块材质自动换, 不会空手挖石头)。单个: 给 x/y/z 或挖视线所指; **批量**: 给 positions=[{x,y,z},...](最多 16 个)一次挖完并统一拾取——先 find/scan 确认视野内要挖什么, 再把坐标列表一口气传入, 不要一块一块挖。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        positions: { type: 'array', description: '批量挖掘的坐标列表 [{x,y,z},...], 最多 16 个', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'place',
    description: '把(手持的或物品栏第一个)方块放置到 x/y/z 位置。需距离 ≤4.5 格且相邻有支撑面。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'attack',
    description: '攻击一个实体(玩家名或生物名, 如 zombie/cow/pig, 取最近匹配)。**默认就是追猎**: 自动追着打直到目标死亡(上限 60 秒), 击杀后自动拾取掉落(肉/皮革等)——打猪牛羊直接调用即可, 目标跑了也会追。seconds=0 才是单次出手; seconds>0 自定义时长。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标: 玩家名或实体英文名' },
        seconds: { type: 'number', description: '持续战斗秒数; 不填或 0 表示只攻击一次' },
      },
      required: ['target'],
    },
  },
  {
    name: 'inventory',
    description: '列出完整物品栏(手持/快捷栏/背包/盔甲), 每件物品含: 名称、自定义称号、数量、耐久、附魔、以及完整 Lore(物品描述文本) —— RPG 服的物品说明也能读懂。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'equip',
    description: '把物品栏中的某件物品装备到指定部位。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品名(支持模糊匹配)' },
        slot: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'], description: '装备位置, 默认 hand' },
      },
      required: ['item'],
    },
  },
  {
    name: 'use_item',
    description: '对手持物品按下右键, 但不指定目标方块/实体(射箭、投掷雪球/末影珍珠、喝药水、放烟花等)。需要点向方块或实体的物品请用 activate_block(打火石点火、水桶倒水/装水、药水投到方块等)或 interact_entity(拴绳、剪刀、鞍、喂食)。',
    inputSchema: {
      type: 'object',
      properties: { times: { type: 'number', description: '连续使用次数(1-16), 默认 1' } },
    },
  },
  {
    name: 'eat',
    description: '吃东西恢复饥饿。可指定食物, 不指定则优先吃手持的, 否则吃物品栏第一个食物。',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', description: '食物名(可选)' } },
    },
  },
  {
    name: 'drop',
    description: '丢弃物品。item 用 inventory 返回的英文名(如 oak_log); 大小写/空格/minecraft: 前缀随意, 会自动匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品名(如 oak_log / Oak Log 均可)', },
        count: { type: 'number', description: '数量, 不填则全部' },
      },
      required: ['item'],
    },
  },
  {
    name: 'inspect',
    description: '查看方块详情: 名称/硬度/属性, 是箱子类则打开并列出内容(每件含 Lore)。给坐标查指定方块(拟真模式下需在视线或触及范围内), 不给则查视线所指。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
    },
  },
  {
    name: 'nearby',
    description: '感知周围(默认 48 格): 玩家列表(含延迟)、敌对生物分组、被动生物分组、地面掉落物分组。拟真模式(默认)只显示视线内/贴身的实体, 墙后的看不到。',
    inputSchema: {
      type: 'object',
      properties: { radius: { type: 'number', description: '搜索半径(格), 默认 48' } },
    },
  },
  {
    name: 'find',
    description: '搜索附近方块的位置(如矿/树/工作台), 返回从近到远排序的坐标, 可直接 goto。blocks 支持逗号分隔多个。拟真模式(默认)只搜索"暴露"的方块(洞壁/地表可见, 六邻有空气/水), 深埋的矿要探索洞穴才能发现——和真人一样。',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'string', description: '方块英文 id, 逗号分隔, 如 "iron_ore,deepslate_iron_ore"' },
        radius: { type: 'number', description: '搜索半径(格), 默认 64' },
        max: { type: 'number', description: '最多返回数量, 默认 16' },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'craft',
    description: '合成物品。若配方需要工作台, 需站在工作台 4 格内(会自动寻找)。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品英文 id, 如 bread' },
        count: { type: 'number', description: '合成数量, 默认 1' },
      },
      required: ['item'],
    },
  },
  {
    name: 'collect',
    description: '【复合技能】自动采集: 循环执行 找最近的目标方块→走过去→换合适工具→挖掘→拾取掉落物, 直到够数/超时/被打断。期间有玩家说话会提前返回(便于回复)。拟真模式(默认)只采集暴露的方块(洞壁/地表)。',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'string', description: '方块英文 id, 逗号分隔, 如 "oak_log"' },
        count: { type: 'number', description: '要采集的数量, 默认 4' },
        radius: { type: 'number', description: '搜索半径(格), 默认 64' },
        timeout_ms: { type: 'number', description: '总超时毫秒, 默认 240000' },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'build',
    description: '【建筑规划/本地施工】一次性下发蓝图 entries=[{x,y,z,block}...] 并让本地程序逐格施工, 不需要一格一格推理。action=plan 保存蓝图并汇总所需材料; need 查询背包还缺什么; place 本地施工(默认缺任一材料不施工, 先 collect/craft 补齐再回来 place; allow_missing=true 则先放背包里已有的); status 查看规划与施工进度; delete 删除规划。施工时本地自动按低→高排序、寻路、换手持方块、找支撑面放置, 进度持久化可断点续建。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'need', 'place', 'status', 'delete'], description: 'plan=保存规划(默认), need=查缺料, place=本地施工, status=查进度, delete=删除' },
        name: { type: 'string', description: '规划名(place/need/status/delete 指定已保存的规划; 不填默认未命名)' },
        entries: { type: 'array', description: 'plan 必填: [{x,y,z,block}...], block 用英文 id(如 oak_planks/stone_bricks/glass), 最多 512 格', items: { type: 'object' } },
        allow_missing: { type: 'boolean', description: 'place: true=先放背包里已有的, false=缺任一材料就不施工(默认)' },
        server: { type: 'string', description: '可选: 指定服务器(host:port), 默认当前/上次连接的' },
      },
    },
  },
  {
    name: 'scan',
    description: '【地形感知】扫描周围地形生成"心智地图": 高度图字符网格(相对你的海拔, 可看坡向/悬崖/洼地)、表面方块构成(草地/沙/水占比)、生物群系、四个方向的地势与危险(落差/水/岩浆)、深坑/可能的洞口。回答"我站在什么地方、往哪走"这类问题。',
    inputSchema: {
      type: 'object',
      properties: { radius: { type: 'number', description: '扫描半径(格), 4-24, 默认 12(25×25 网格); 越大越慢' } },
    },
  },
  {
    name: 'waypoint',
    description: '【持久化路标】保存/列出/删除命名地点(按服务器隔离存储, 重启不丢)。保存当前位置或指定坐标; goto 的 waypoint 参数可直接导航前往。适合记"家/矿洞入口/主城商店/约定碰面点"。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete'], description: 'save=保存(默认取当前位置, 也可给 x/y/z 记录别处), list=列出全部, delete=按名删除' },
        name: { type: 'string', description: '路标名, save/delete 必填, 如 "家"' },
        note: { type: 'string', description: '备注(save 可选)' },
        x: { type: 'number', description: '可选: 记录指定坐标而非当前位置' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory',
    description: '【长期记忆】跨会话持久化关键信息(按服务器隔离存储): 玩家喜好/约定、任务进度、基地布局、踩过的坑。断线时会自动保存一条 key="上次会话" 的会话总结。save 写入(给 key 再存同 key 为更新), recall 按关键词检索(不填返回最近 20 条; 建议连接后先查"上次会话"), forget 删除。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'recall', 'forget'], description: 'save=记住, recall=回忆/检索, forget=遗忘' },
        text: { type: 'string', description: 'save: 要记住的内容' },
        key: { type: 'string', description: 'save: 可选唯一键(同 key 再存会覆盖更新); forget: 可按 key 删' },
        tags: { type: 'string', description: 'save: 可选标签, 逗号分隔, 如 "玩家,约定"' },
        query: { type: 'string', description: 'recall: 搜索词(匹配内容/键/标签), 不填返回最近的记忆' },
        id: { type: 'string', description: 'forget: 按 id 删除' },
        server: { type: 'string', description: '可选: 指定服务器(host:port), 默认当前/上次连接的' },
      },
      required: ['action'],
    },
  },
  {
    name: 'goal',
    description: '【自驱目标】自主设定/查看/更新/完成自己的游戏目标(按服务器持久化, 你有权做自己想做的事)。set=立新目标或更新同标题目标(写清动机/下一步/计划), list=查看全部(含完成状态), done=标记完成, drop=放弃。没有目标时先用它给自己立一个, 然后按 plan/next_step 推进, 不要只等玩家指令。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'update', 'done', 'drop'], description: '默认 list' },
        title: { type: 'string', description: '目标标题, set/update/done/drop 必填(set 与 update 都按标题覆盖)' },
        why: { type: 'string', description: 'set: 为什么想做这件事(动机)' },
        next_step: { type: 'string', description: 'set: 当前下一步要做的最具体动作' },
        plan: { type: 'string', description: 'set: 计划步骤, 逗号/换行分隔(如 "找一棵橡树, 砍 32 个原木, 做出工作台, 做木镐")' },
        tags: { type: 'string', description: 'set: 可选标签, 逗号分隔' },
        server: { type: 'string', description: '可选: 指定服务器(host:port), 默认当前/上次连接的' },
      },
    },
  },
  {
    name: 'interact_entity',
    description: '右键一个实体: 喂食/繁殖动物(先 equip 对应食物)、驯服(狼要骨头)、剪羊毛(手持剪刀)、挂拴绳、给马装鞍、骑乘, 以及与主城 NPC(商店/任务等假玩家或盔甲架)交互——右键后弹出的菜单会以 window_open 事件出现, 用 container(action="click") 点选项。mount=骑上, dismount=下来。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标: 玩家名或实体英文名(如 horse/cow/boat)' },
        action: { type: 'string', enum: ['use', 'mount', 'dismount'], description: 'use=右键交互(默认), mount=骑乘, dismount=下坐骑' },
      },
      required: ['target'],
    },
  },
  {
    name: 'activate_block',
    description: '右键一个方块: 开门/关门、按钮、拉杆、栅栏门、音符盒; 手持打火石/水桶/熔岩桶/药水瓶等物品时向该面使用(点火/倒水/投掷)。默认点击机器人视线可见的那一面, 也可用 direction 指定。给坐标或用视线所指(需在 4.5 格触及范围内)。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '方块 X 坐标(不给则用视线所指)' },
        y: { type: 'number' },
        z: { type: 'number' },
        direction: { type: 'string', enum: ['auto', 'up', 'down', 'north', 'south', 'east', 'west'], description: '点击方块的面; 默认 auto(根据机器人位置选可见面)' },
      },
    },
  },
  {
    name: 'sneak',
    description: '下蹲(潜行)开关: 潜行时不会从方块边缘坠落、移动减速。适合在屋顶/悬崖边作业。不需要时记得关掉。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true=开始潜行, false=结束' },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'container',
    description: '容器/菜单/熔炉操作: ① 箱子木桶: open→deposit/withdraw→close; ② NPC 菜单窗口: list→click(按 slot)→close; ③ **熔炉**(furnace/blast_furnace/smoker): open→deposit(原料, 燃料自动判断——煤/木类进燃料槽, 也可 slot="fuel"/"input" 指定)→withdraw(取产物)→close, list 显示进度秒数。物品名大小写/minecraft: 前缀随意。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'list', 'click', 'deposit', 'withdraw', 'close'], description: 'open=打开实体容器(coords 或视线), list=列出内容, click=点击菜单格子(NPC 菜单选选项), deposit=放入, withdraw=取出, close=关闭' },
        x: { type: 'number', description: 'open: 容器坐标(可选, 默认视线所指)' },
        y: { type: 'number' },
        z: { type: 'number' },
        item: { type: 'string', description: 'deposit/withdraw: 物品名' },
        count: { type: 'number', description: 'deposit/withdraw: 数量(不填=全部)' },
        slot: { type: 'number', description: 'click: 格子序号(见 contents 的 slot 字段, 从 0 开始)' },
        button: { type: 'number', description: 'click: 0=左键(默认), 1=右键' },
      },
      required: ['action'],
    },
  },
  {
    name: 'villager',
    description: '村民交易: list 查看交易表(材料→产出, 含禁用状态), trade 按 trade_index 交易。需站在村民 6 格内。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'trade'], description: 'list=看交易表(默认), trade=执行交易' },
        target: { type: 'string', description: '村民实体(默认找最近的 villager)' },
        trade_index: { type: 'number', description: 'trade: 交易表序号(从 0 开始)' },
        count: { type: 'number', description: 'trade: 交易次数, 默认 1' },
      },
    },
  },
  {
    name: 'pillar',
    description: '【搭方块向上】原地起柱: 原生执行"跳跃→空中向脚下放置→落地"循环, 一次搭到指定高度(受方块数量与头顶空间限制)。自动手持方块、逐块校验、头顶不够自动停。适合上房顶/堵高洞口/立高塔。',
    inputSchema: {
      type: 'object',
      properties: {
        height: { type: 'number', description: '要搭的高度(格数), 会自动按手持方块数量截断' },
      },
      required: ['height'],
    },
  },
  {
    name: 'analyze_structure',
    description: '【建筑识别】无视觉判断前方/周围是否为人造结构: 扫描立方体区域, 用"材料签名"(人造方块占比: 木板/玻璃/砖/门/火把等自然界不会自然生成的方块)+"几何规则性"(屋顶/地板平面、跨层连续墙面、封闭房间空腔、高塔柱体)给出带证据链的判断与类型猜测(房屋/塔/桥/农田/散点痕迹)。拟真模式下只统计看得见的方块, 不会探测埋在地下的隐藏基地。用于: 避免挖坏建筑、找村庄、探索决策。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '扫描中心 X(默认自己所在位置)' },
        y: { type: 'number', description: '扫描中心 Y(默认自己; 拟真模式下会被限制在自身±8格)' },
        z: { type: 'number', description: '扫描中心 Z' },
        radius: { type: 'number', description: '水平半径(格), 3-16, 默认 10' },
        height: { type: 'number', description: '垂直高度(格), 6-24, 默认 16, 从中心下方 4 格起算' },
      },
    },
  },
  {
    name: 'plan',
    description: '【连续动作计划/本地连续执行】一次下发一串已经决定好的动作步骤, 本地按顺序连续执行, 不需要每步都停下来等模型推理。steps 数组每项是 {"tool": "...", "args": {}} 或直接 "工具名" (用缺省参数)。支持步骤: goto/follow/dig(含 positions 批量)/collect/build(plan/need/place/status/delete)/wander/eat/equip/craft/place/use_item/find/nearby/inventory/status/look_at/attack/wait/pillar。适合"先想好再一口气做完"的工作流: 例如 [{"tool":"collect","args":{"blocks":"oak_log","count":32}}, {"tool":"goto","args":{"waypoint":"家"}}, {"tool":"craft","args":{"item":"crafting_table"}}, {"tool":"place","args":{...}}, {"tool":"craft","args":{"item":"oak_planks","count":64}}]。有玩家说话/受击/自动防御等事件会中断并把已完成步骤带回; 单步失败会记录原因继续下一步。聊天/私聊/command/交易/丢弃等社交动作不能放进计划, 必须由模型逐次调用。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', description: '步骤数组, 每项 {"tool":"collect","args":{"blocks":"oak_log"}} 或 "collect"; 最多 16 步', items: { type: 'object' } },
        max_seconds: { type: 'number', description: '整条计划最长执行秒数, 默认 600, 超时返回已完成进度' },
        interrupt_on_event: { type: 'boolean', description: '期间有人说话/受击/自动防御等事件时中断, 默认 true' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'persona',
    description: '获取最新 AI 玩家人设: 完整 prompt 全文(人设/说话方式/行为守则/游玩方式)+ 字段摘要。会话开始或人设可能变化时调用一次, 并严格遵守其中的人设与语气; 与 MCP prompts/get "persona" 等价, 供不会自动注入 prompt 的客户端使用。',
    inputSchema: { type: 'object', properties: {} },
  },
]

function coordsOrNull(a) {
  if (a?.x != null && a?.y != null && a?.z != null) {
    return { x: Math.floor(Number(a.x)), y: Math.floor(Number(a.y)), z: Math.floor(Number(a.z)) }
  }
  return null
}

// 拟真感知(反矿透): 默认开启, 只允许 AI 获取"玩家真正看得到"的信息
function fairMode() {
  return state.options?.fairPerception !== false
}

function statusSnapshot() {
  const bot = state.bot
  if (!bot || !bot.entity) {
    return { connected: false, hint: '调用 connect 连接服务器后再来。' }
  }
  const e = bot.entity
  const reg = bot.registry
  const hotbar = []
  try {
    for (let i = 36; i <= 44; i++) {
      const it = bot.inventory.slots[i]
      if (it) hotbar.push({ slot: i - 36, name: it.name, count: it.count })
    }
  } catch { /* ignore */ }

  let gamemode
  try { gamemode = ['生存', '创造', '冒险', '旁观'][bot.player?.gamemode] ?? bot.player?.gamemode } catch { /* ignore */ }

  return {
    connected: true,
    server: {
      host: state.options?.host,
      port: state.options?.port,
      version: bot.version,
      ping_ms: bot.players?.[bot.username]?.ping ?? null,
    },
    you: {
      username: bot.username,
      position: fmtPos(e.position),
      // 空间参照: 相对最近路标的方向与距离, 让模型知道"我在哪"
      spatial_context: (() => {
        try {
          const wps = listWaypoints(currentNs())
          const rel = wps.slice(0, 8).map((w) => w.position
            ? `${w.name} 在${directionBetween(e.position, w.position)}`
            : null).filter(Boolean)
          const lm = nearestLandmark(e.position, wps)
          return {
            nearest: lm ? { name: lm.name, relation: directionBetween(e.position, lm.position) } : null,
            landmarks: rel,
          }
        } catch {
          return null
        }
      })(),
      facing: facingOf(e.yaw),
      health: Math.round(e.health ?? 20),
      food: e.food ?? 20,
      oxygen: e.oxygen,
      light: (() => { const l = currentLight(bot); return l == null ? undefined : { level: l, label: lightLabel(l) } })(),
      xp_level: bot.experience?.level,
      gamemode,
      sneaking: state.sneaking,
      container_open: Boolean(state.containerWindow),
    },
    held_item: formatItem(bot.heldItem, reg),
    hotbar,
    world: {
      time_of_day: timeLabelOfTicks(bot.time?.timeOfDay),
      ticks: bot.time?.timeOfDay,
      day: bot.time?.day,
      dimension: bot.game?.dimension,
    },
    online_players: Object.entries(bot.players || {})
      .filter(([n]) => n !== bot.username)
      .map(([name, p]) => ({ name, ping: p.ping })),
    current_task: currentTask(),
    auto_defense: defenseStatus(),
    fair_perception: state.options?.fairPerception !== false,
    humanize: state.options?.humanize !== false,
    persona_name: loadPersona().name || state.bot?.username || null,
    context_snapshot: contextSnapshot(currentNs()),
    namespace: currentNs(),
    saved_waypoints: listWaypoints(currentNs()).length,
    latest_event_seq: state.seq,
    last_connection: lastConnection(), // 上次成功连接的配置(面板用来预填表单, 免手填)
  }
}

const HANDLERS = {
  connect: async (a) => connectFull(a),
  disconnect: async () => disconnectFull(),
  status: async () => statusSnapshot(),
  get_events: async (a) => {
    const since = Number.isFinite(Number(a.since)) ? Number(a.since) : 0
    return { events: eventsSince(since), latest_seq: state.seq }
  },
  chat: async (a) => {
    const bot = requireBot()
    let msg = String(a.message ?? '').trim()
    if (!msg) throw new Error('message 不能为空。')
    if (/^\/(tell|msg|w)\b/i.test(msg)) {
      throw new Error('私聊请用 whisper(player, message), 不要在 chat 里发 /tell /msg /w。')
    }
    if (msg.startsWith('/')) {
      if (/^\/say\s+/i.test(msg)) msg = msg.replace(/^\/say\s+/i, '')
      else {
        bot.chat(msg)
        return { said: msg, note: '命令已直接发送(无打字延迟)。' }
      }
    }
    if (!msg) throw new Error('message 不能为空。')
    if (state.options?.humanize !== false) {
      // 非阻塞: 后台按拟人节奏排队打字发送, 立即返回 —— 模型可以边"打字"边继续行动(边走边说)
      void sendChatHumanized(bot, msg).catch(() => {})
      return { said: msg, note: '正在后台按拟人节奏分句发送(无需等待), 可继续做其他事。' }
    }
    bot.chat(msg)
    recordSelfChat(msg)
    return { said: msg }
  },
  whisper: async (a) => {
    const bot = requireBot()
    const player = String(a.player ?? '')
    const msg = String(a.message ?? '')
    if (!player || !msg) throw new Error('需要 player 与 message。')
    if (state.options?.humanize !== false) {
      void sendWhisperHumanized(bot, player, msg).catch(() => {})
      return { to: player, said: msg, note: '正在后台按拟人节奏分句发送(无需等待)。' }
    }
    bot.whisper(player, msg)
    recordSelfChat(msg, player)
    return { to: player, said: msg }
  },
  command: async (a) => {
    const bot = requireBot()
    const cmd = String(a.command ?? '').trim()
    if (!cmd.startsWith('/')) throw new Error('command 必须以 / 开头(如 /tp、/home); 普通聊天请用 chat。')
    if (/^\/(tell|msg|w|say)\b/i.test(cmd)) {
      throw new Error('command 禁止发聊天消息: 公屏用 chat, 私聊用 whisper。')
    }
    bot.chat(cmd)
    return { executed: cmd, note: '命令已即时发送, 执行反馈见 new_events。' }
  },
  wait: async (a) => {
    const bot = requireBot()
    const seconds = Math.min(300, Math.max(1, Math.floor(Number(a.seconds ?? 30))))
    const startedAt = Date.now()
    const startSeq = state.notifiedSeq // 也包含"上一轮推理期间已发生但还没交给 AI"的事件, 避免白等一轮
    const until = startedAt + seconds * 1000
    const WAKE_TYPES = new Set(['chat', 'whisper', 'damaged', 'death', 'kicked', 'disconnected', 'auto_defense', 'system', 'action_bar', 'player_joined', 'player_left', 'window_open', 'error', 'auto_pickup', 'resource_pack', 'social_hint'])

    // 接近感知("眼角余光/听觉"): 每 2 秒对比基线, 新进入 10 格的玩家 / 12 格的敌对生物会唤醒
    let base = proximityScan(bot)
    let approach = null
    const poll = setInterval(() => {
      try {
        const now = proximityScan(bot)
        if (!approach) {
          const newPlayer = [...now.players.keys()].find((p) => !base.players.has(p))
          if (newPlayer) {
            approach = { type: 'player_approach', who: newPlayer, distance: now.players.get(newPlayer) }
          } else {
            const newMob = [...now.hostiles.keys()].find((h) => !base.hostiles.has(h))
            if (newMob) approach = { type: 'mob_approach', who: newMob.split('#')[0], distance: now.hostiles.get(newMob) }
          }
        }
        base = now
      } catch { /* ignore */ }
    }, 2000)
    if (typeof poll.unref === 'function') poll.unref()

    // 醒来时"睁眼看一眼": 附带 nearby 快照(玩家/敌对/被动/掉落物)
    const snapshot = () => {
      try {
        return nearbySummary(bot, 48, fairMode())
      } catch {
        return undefined
      }
    }

    try {
      while (Date.now() < until) {
        if (!state.bot) break
        if (approach) {
          return {
            waited_seconds: round1((Date.now() - startedAt) / 1000),
            woken_by: approach.type,
            note: approach.type === 'player_approach'
              ? `你注意到玩家「${approach.who}」靠近(约 ${approach.distance} 格)`
              : `你注意到敌对生物「${approach.who}」靠近(约 ${approach.distance} 格)`,
            nearby: snapshot(),
          }
        }
        const wake = eventsSince(startSeq).find((e) => WAKE_TYPES.has(e.type))
        if (wake) {
          // 聊天聚合: 被聊天/私聊唤醒后, 本地再等 3~5 秒收尾音, 把一批消息一起返回,
          // 避免"来一条回一条"像机器人抢答(真人会攒几秒一起看一起回)
          const isChat = wake.type === 'chat' || wake.type === 'whisper'
          if (isChat) {
            let grace = Date.now() + 3000 + Math.random() * 2000
            while (Date.now() < grace && Date.now() < until) {
              if (state.bot !== bot) break
              const more = eventsSince(startSeq).some((e) => e.type === 'chat' || e.type === 'whisper')
              if (!more) {
                await new Promise((r) => setTimeout(r, 300))
                continue
              }
              // 有更多消息: 重置收尾计时, 但总时长仍受 until 限制
              grace = Math.min(until, Date.now() + 2500)
              await new Promise((r) => setTimeout(r, 300))
            }
          }
          return { waited_seconds: round1((Date.now() - startedAt) / 1000), woken_by: wake.type, note: '有新事件, 事件详情见 new_events。', nearby: snapshot() }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
    } finally {
      clearInterval(poll)
    }
    return { waited_seconds: round1((Date.now() - startedAt) / 1000), timed_out: true, nearby: snapshot() }
  },
  goto: (a) => runTask('goto', async (task) => {
    const bot = requireBot()
    let target
    if (a.waypoint) {
      const wp = findWaypoint(currentNs(), String(a.waypoint))
      if (!wp) throw new Error(`没有名为「${a.waypoint}」的路标, 可用 waypoint 工具查看/保存。`)
      target = wp.position
    } else if (a.player) {
      const ent = resolvePlayerEntity(bot, String(a.player))
      if (!ent) throw new Error(`找不到玩家「${a.player}」(可能不在线或不在渲染范围), 可用 nearby 查看。`)
      target = fmtPos(ent.position)
    } else {
      target = coordsOrNull(a)
      if (!target) throw new Error('需要提供 x/y/z 坐标、player 或 waypoint 参数。')
    }
    const range = a.range ?? (a.player ? 2 : 1)
    return pathfindTo(bot, target, {
      range,
      timeoutMs: a.timeout_ms ?? 120000,
      allowDig: Boolean(a.allow_dig),
      allowPlace: Boolean(a.allow_place),
      interruptOnEvents: a.interrupt_on_event !== false,
      startSeq: state.notifiedSeq,
      task,
    })
  }),
  follow: (a) => runTask('follow', async (task) => {
    const bot = requireBot()
    return followPlayer(bot, String(a.player), {
      durationS: a.duration_s ?? 60,
      distance: a.distance ?? 3,
      interruptOnChat: a.interrupt_on_chat !== false,
      task,
    })
  }),
  stop: async () => {
    const was = currentTask()?.name ?? null
    cancelTask()
    return { stopped: true, was_doing: was }
  },
  look_at: async (a) => {
    const bot = requireBot()
    if (a.entity) {
      const ent = resolveEntity(bot, String(a.entity))
      if (!ent) throw new Error(`找不到实体「${a.entity}」。`)
      await bot.lookAt(ent.position.offset(0, ent.height ?? 1.6, 0), true)
      return { looking_at: a.entity }
    }
    const c = coordsOrNull(a)
    if (!c) throw new Error('提供 x/y/z 或 entity。')
    await lookAtPoint(bot, c.x, c.y, c.z)
    return { looking_at: c }
  },
  dig: (a) => runTask('dig', async (task) => {
    const bot = requireBot()
    if (Array.isArray(a.positions) && a.positions.length) {
      return actions.digBatch(bot, a.positions, task)
    }
    return actions.digBlock(bot, a, task)
  }),
  place: (a) => runTask('place', async () => {
    const bot = requireBot()
    const r = await actions.placeBlockAt(bot, a)
    // 放置记忆(防"忘了工作台在哪再造一个"): 自动记到该服务器的长期记忆
    try {
      const key = `放置:${r.placed}`
      const text = `我在 (${r.position.x}, ${r.position.y}, ${r.position.z}) 放置了 ${r.placed} —— ${new Date().toLocaleString('zh-CN')}`
      saveMemory(currentNs(), { key, text, tags: ['放置记录', r.placed] })
      return { ...r, memory_saved: key }
    } catch {
      return r
    }
  }),
  attack: (a) => {
    const seconds = a.seconds == null ? 60 : Math.max(0, Number(a.seconds))
    return runTask(seconds > 0 ? 'fight' : 'attack', async (task) => {
      const bot = requireBot()
      return actions.attackEntity(bot, String(a.target), { seconds }, task)
    })
  },
  inventory: async () => {
    const bot = requireBot()
    const reg = bot.registry
    const slots = bot.inventory.slots
    const pick = (from, to, offset) => {
      const out = []
      for (let i = from; i <= to; i++) {
        const it = slots[i]
        if (it) out.push(formatItem(it, reg, i - offset))
      }
      return out
    }
    return {
      held: formatItem(bot.heldItem, reg),
      hotbar: pick(36, 44, 36),
      backpack: pick(9, 35, 9),
      armor: pick(5, 8, 5),
    }
  },
  equip: async (a) => {
    const bot = requireBot()
    return actions.equipItem(bot, String(a.item), a.slot)
  },
  use_item: async (a) => {
    const bot = requireBot()
    return actions.useItem(bot, a.times)
  },
  eat: async (a) => {
    const bot = requireBot()
    return actions.eatFood(bot, a.item ? String(a.item) : null)
  },
  drop: async (a) => {
    const bot = requireBot()
    return actions.dropItems(bot, String(a.item), a.count)
  },
  inspect: (a) => runTask('inspect', async () => {
    const bot = requireBot()
    return inspectBlock(bot, coordsOrNull(a), fairMode())
  }),
  nearby: async (a) => {
    const bot = requireBot()
    return nearbySummary(bot, a.radius ?? 48, fairMode())
  },
  find: async (a) => {
    const bot = requireBot()
    return findBlocksTool(bot, String(a.blocks), { radius: a.radius ?? 64, max: a.max ?? 16, fairOnly: fairMode() })
  },
  craft: (a) => runTask('craft', async () => {
    const bot = requireBot()
    return actions.craftItem(bot, String(a.item), a.count)
  }),
  collect: (a) => runTask('collect', async (task) => {
    const bot = requireBot()
    return actions.collectBlocks(bot, String(a.blocks), {
      count: a.count ?? 4,
      radius: a.radius ?? 64,
      timeoutMs: a.timeout_ms ?? 240000,
      fairOnly: fairMode(),
    }, task)
  }),
  build: (a) => runTask('build', async (task) => {
    const action = a.action ?? 'plan'
    const ns = currentNs(a.server)
    const name = String(a.name ?? '未命名').trim() || '未命名'
    if (action === 'plan') {
      const plan = saveBuildingPlan(ns, name, a.entries)
      let materials = null
      try {
        if (state.bot?.entity) materials = computeMaterials(state.bot, plan.entries)
      } catch { /* 未连接/背包不可用时只保存规划 */ }
      // 蓝图结构校验: 提醒模型"建得乱"的常见问题(不阻止, 只是建议)
      const blueprint = validateBlueprint(plan.entries)
      return {
        action,
        plan_name: plan.name,
        entries_total: plan.entries.length,
        materials,
        blueprint_check: blueprint.warnings.length ? blueprint.warnings : undefined,
        note: [
          materials
            ? (materials.ready ? '材料齐备, 可直接 action=place 施工。' : '已保存规划, 先用 need/collect/craft 补料, 再 action=place。')
            : '已保存规划; 连接后可用 action=need 查看材料缺口。',
          blueprint.warnings.length ? '蓝图有结构建议, 见 blueprint_check; 可先调整 entries 再重新 plan, 或直接施工。' : '蓝图结构看起来正常。',
        ].join(' '),
      }
    }
    if (action === 'need') {
      const bot = requireBot()
      const plan = getBuildingPlan(ns, name)
      const materials = computeMaterials(bot, plan.entries)
      return {
        action,
        plan_name: plan.name,
        entries_total: plan.entries.length,
        progress: buildingSummary(plan),
        ready: materials.ready,
        materials,
        note: materials.ready ? '材料齐备, 可直接 action=place。' : '先 collect/craft 补料, 再 action=place; 或 allow_missing=true 先放已有的。',
      }
    }
    if (action === 'status') {
      if (a.name) return { action, plan: buildingSummary(getBuildingPlan(ns, name)) }
      return { action, plans: listBuildingPlansLocal(ns) }
    }
    if (action === 'delete') {
      removeBuildingPlan(ns, name)
      return { action, deleted: name }
    }
    const bot = requireBot()
    const r = await buildSavedPlan(bot, ns, name, { allow_missing: Boolean(a.allow_missing) }, task)
    return { action, ...r }
  }),
  scan: async (a) => {
    const bot = requireBot()
    return scanTerrain(bot, a.radius ?? 12)
  },
  persona: async () => {
    const p = loadPersona()
    return {
      persona_name: p.name || state.bot?.username || null,
      identity: p.identity || undefined,
      speaking_style: p.speaking_style || undefined,
      rules: p.rules?.length ? p.rules : undefined,
      greeting: p.greeting || undefined,
      prompt: personaPromptText(state.bot?.username),
    }
  },
  analyze_structure: async (a) => {
    const bot = requireBot()
    return analyzeStructure(bot, {
      x: a.x, y: a.y, z: a.z,
      radius: a.radius, height: a.height,
      fairOnly: fairMode(),
    })
  },
  waypoint: async (a) => {
    const action = a.action ?? 'list'
    const ns = currentNs(a.server)
    if (action === 'save') {
      if (!a.name) throw new Error('save 需要提供 name。')
      let position
      let dimension = null
      if (a.x != null && a.y != null && a.z != null) {
        position = { x: Math.floor(Number(a.x)), y: Math.floor(Number(a.y)), z: Math.floor(Number(a.z)) }
      } else {
        const bot = requireBot()
        position = fmtPos(bot.entity.position)
        try { dimension = bot.game?.dimension ?? null } catch { /* ignore */ }
      }
      const entry = saveWaypoint(ns, { name: String(a.name), position, dimension, note: a.note ? String(a.note) : null })
      return { saved: entry, hint: '可用 goto(waypoint=...) 直接前往。' }
    }
    if (action === 'delete') {
      if (!a.name) throw new Error('delete 需要提供 name。')
      return { removed: deleteWaypoint(ns, String(a.name)) }
    }
    const all = listWaypoints(ns)
    return { namespace: ns, count: all.length, waypoints: all }
  },
  memory: async (a) => {
    const action = a.action ?? 'recall'
    const ns = currentNs(a.server)
    if (action === 'save') {
      if (!a.text) throw new Error('save 需要提供 text。')
      const tags = a.tags ? String(a.tags).split(/[,，\s]+/).filter(Boolean) : []
      return { saved: saveMemory(ns, { text: String(a.text), key: a.key ? String(a.key) : null, tags }) }
    }
    if (action === 'forget') {
      const ref = a.id ?? a.key
      if (!ref) throw new Error('forget 需要 id 或 key。')
      return { removed: forgetMemory(ns, String(ref)) }
    }
    const results = recallMemories(ns, a.query ? String(a.query) : null)
    return { namespace: ns, count: results.length, memories: results, hint: results.length ? undefined : '没有匹配的记忆。' }
  },
  goal: async (a) => {
    const ns = currentNs(a.server)
    const action = a.action ?? 'list'
    const all = listMemories(ns)
    const keyFor = (t) => `goal:${String(t).trim()}`

    if (action === 'list') {
      const goals = all.filter((m) => m.key?.startsWith('goal:'))
      return {
        namespace: ns,
        count: goals.length,
        goals: goals.map((g) => ({ ...g, done: /状态: 已完成/.test(g.text ?? '') })),
        hint: goals.length ? undefined : '还没有自驱目标。可 goal(set, title=..., why=..., next_step=..., plan=...) 给自己立一个。',
      }
    }

    const title = a.title ? String(a.title).trim() : ''
    if (!title) throw new Error(`${action} 需要提供 title(目标标题)。`)
    const key = keyFor(title)

    if (action === 'set' || action === 'update') {
      const lines = [`目标: ${title}`]
      if (a.why) lines.push(`动机: ${String(a.why)}`)
      if (a.next_step) lines.push(`下一步: ${String(a.next_step)}`)
      const steps = a.plan
        ? String(a.plan).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
        : []
      if (steps.length) lines.push(`计划: ${steps.map((s, i) => `${i + 1}. ${s}`).join(' | ')}`)
      const tags = ['goal', ...(a.tags ? String(a.tags).split(/[,，\s]+/).filter(Boolean) : [])]
      const saved = saveMemory(ns, { key, text: lines.join('\n'), tags: [...new Set(tags)] })
      return { goal: saved, hint: '按 plan/next_step 推进; 完成后用 goal(done, title=...) 标记, 需要改计划就再 goal(update)。' }
    }

    const entry = all.find((m) => m.key === key || (m.text ?? '').includes(`目标: ${title}`))
    if (!entry) throw new Error(`没有找到目标「${title}」, 可先 goal(list) 查看。`)
    if (action === 'drop') return { removed: forgetMemory(ns, entry.key) }
    if (action === 'done') {
      const text = (entry.text ?? '').replace(/\n?状态: 已完成.*$/s, '') + '\n状态: 已完成'
      const saved = saveMemory(ns, { key: entry.key, text, tags: [...new Set([...(entry.tags ?? []), 'goal'])] })
      return { done: entry.key, goal: saved, hint: '目标已完成。可以 goal(set) 立下一个目标, 或推进其他目标。' }
    }
    throw new Error(`未知 action: ${action}`)
  },
  chatlog: async (a) => {
    const ns = currentNs(a.server)
    const entries = listChatLog(ns, { limit: a.limit ?? 50, query: a.query ? String(a.query) : null })
    return { namespace: ns, count: entries.length, entries, hint: entries.length ? undefined : '还没有聊天记录。' }
  },
  interact_entity: (a) => runTask('interact', async () => {
    const bot = requireBot()
    return interact.interactEntity(bot, String(a.target ?? ''), a.action ?? 'use')
  }),
  activate_block: (a) => runTask('activate', async () => {
    const bot = requireBot()
    return interact.activateBlockAt(bot, coordsOrNull(a), a.direction)
  }),
  sneak: async (a) => {
    const bot = requireBot()
    return interact.setSneak(bot, Boolean(a.enabled))
  },
  container: (a) => runTask('container', async () => {
    const bot = requireBot()
    return interact.containerTool(bot, a)
  }),
  villager: (a) => runTask('villager', async () => {
    const bot = requireBot()
    return interact.villagerTool(bot, a)
  }),
  pillar: (a) => runTask('pillar', async (task) => {
    const bot = requireBot()
    return interact.pillarUp(bot, a.height ?? 1, task)
  }),
  wander: (a) => runTask('wander', async (task) => {
    const bot = requireBot()
    return wanderAround(bot, a.seconds ?? 60, task, { interruptOnChat: a.interrupt_on_chat !== false })
  }),
  explore: (a) => runTask('explore', async (task) => {
    const bot = requireBot()
    return exploreAround(bot, a.seconds ?? 90, task, { interruptOnChat: a.interrupt_on_chat !== false })
  }),

  // 连续动作计划: 模型一次定好步骤, 本地按顺序连续执行, 中途可被事件/stop 打断
  plan: (a) => runTask('plan', async (task) => {
    const bot = requireBot()
    const raw = Array.isArray(a.steps) ? a.steps : []
    const steps = raw.slice(0, 16).map((s, i) => {
      const rec = (s && typeof s === 'object') ? s : {}
      const tool = String(rec.tool ?? rec.step ?? '').trim()
      return { index: i + 1, tool, args: (rec.args && typeof rec.args === 'object') ? rec.args : {} }
    }).filter((s) => s.tool)
    if (!steps.length) throw new Error('plan 需要 steps 数组: [{"tool":"collect","args":{...}},...]')
    const allowed = new Set(['goto', 'follow', 'dig', 'collect', 'build', 'wander', 'explore', 'eat', 'equip', 'craft', 'place', 'use_item', 'find', 'nearby', 'inventory', 'status', 'look_at', 'attack', 'wait', 'pillar'])
    for (const s of steps) {
      if (!allowed.has(s.tool)) {
        const list = [...allowed].join('/')
        throw new Error(`plan 步骤「${s.tool}」不在支持列表内(聊天/交易/丢弃请单独用对应工具): ${list}`)
      }
    }

    const startSeq = state.notifiedSeq
    const deadline = Date.now() + Math.max(5000, Number(a.max_seconds ?? 600) * 1000)
    const interruptOnEvent = a.interrupt_on_event !== false
    const wake = () => interruptOnEvent && eventsSince(startSeq).find((e) => PLAN_WAKE.has(e.type))

    const dispatch = async (tool, args) => {
      switch (tool) {
        case 'goto': {
          const ns = currentNs()
          let target
          if (args.waypoint) {
            const wp = findWaypoint(ns, String(args.waypoint))
            if (!wp) throw new Error(`没有名为「${args.waypoint}」的路标, 可用 waypoint 工具查看/保存。`)
            target = wp.position
          } else if (args.player) {
            const ent = resolvePlayerEntity(bot, String(args.player))
            if (!ent) throw new Error(`找不到玩家「${args.player}」。`)
            target = fmtPos(ent.position)
          } else {
            target = coordsOrNull(args)
            if (!target) throw new Error('goto 需要 x/y/z、player 或 waypoint。')
          }
          return pathfindTo(bot, target, {
            range: args.range ?? (args.player ? 2 : 1),
            timeoutMs: args.timeout_ms ?? 120000,
            allowDig: Boolean(args.allow_dig),
            allowPlace: Boolean(args.allow_place),
            interruptOnEvents: true,
            startSeq,
            task,
          })
        }
        case 'follow':
          return followPlayer(bot, String(args.player), { seconds: args.seconds, task, interruptOnChat: true })
        case 'dig':
          if (Array.isArray(args.positions) && args.positions.length) return actions.digBatch(bot, args.positions, task)
          return actions.digBlock(bot, args, task)
        case 'collect':
          return actions.collectBlocks(bot, String(args.blocks), {
            count: args.count ?? 4,
            radius: args.radius ?? 64,
            timeoutMs: args.timeout_ms ?? 240000,
            fairOnly: fairMode(),
          }, task)
        case 'build': {
          const ns = currentNs(args.server)
          const name = String(args.name ?? '未命名').trim() || '未命名'
          const action = args.action ?? 'plan'
          if (action === 'plan') {
            if (!args.entries) throw new Error('build plan 步骤需要 entries=[{x,y,z,block},...]')
            const plan = saveBuildingPlan(ns, name, args.entries)
            return { action, plan_name: plan.name, entries_total: plan.entries.length, materials: computeMaterials(bot, plan.entries) }
          }
          if (action === 'need') {
            const plan = getBuildingPlan(ns, name)
            const materials = computeMaterials(bot, plan.entries)
            return { action, plan_name: plan.name, entries_total: plan.entries.length, progress: buildingSummary(plan), ready: materials.ready, materials }
          }
          if (action === 'status') return { action, plan: buildingSummary(getBuildingPlan(ns, name)) }
          if (action === 'delete') { removeBuildingPlan(ns, name); return { action, deleted: name } }
          const r = await buildSavedPlan(bot, ns, name, { allow_missing: Boolean(args.allow_missing) }, task)
          return { action, ...r }
        }
        case 'wander':
          return wanderAround(bot, args.seconds ?? 60, task, { interruptOnChat: true })
        case 'explore':
          return exploreAround(bot, args.seconds ?? 90, task, { interruptOnChat: true })
        case 'eat':
          return actions.eatFood(bot, args.item ? String(args.item) : null)
        case 'equip':
          return actions.equipItem(bot, String(args.item), args.slot)
        case 'craft':
          return actions.craftItem(bot, String(args.item), args.count)
        case 'place': {
          const r = await actions.placeBlockAt(bot, args)
          try {
            const key = `放置:${r.placed}`
            saveMemory(currentNs(), { key, text: `我在 (${r.position.x}, ${r.position.y}, ${r.position.z}) 放置了 ${r.placed} —— ${new Date().toLocaleString('zh-CN')}`, tags: ['放置记录', r.placed] })
            return { ...r, memory_saved: key }
          } catch {
            return r
          }
        }
        case 'use_item':
          return actions.useItem(bot, args.times)
        case 'find':
          return findBlocksTool(bot, String(args.blocks), { radius: args.radius ?? 64, max: args.max ?? 16, fairOnly: fairMode() })
        case 'nearby':
          return nearbySummary(bot, args.radius ?? 48, fairMode())
        case 'inventory': {
          const reg = bot.registry
          const slots = bot.inventory.slots
          const pick = (from, to, offset) => { const out = []; for (let i = from; i <= to; i++) { const it = slots[i]; if (it) out.push(formatItem(it, reg, i - offset)) } return out }
          return { held: formatItem(bot.heldItem, reg), hotbar: pick(36, 44, 36), backpack: pick(9, 35, 9), armor: pick(5, 8, 5) }
        }
        case 'status':
          return statusSnapshot()
        case 'look_at':
          return lookAtPoint(bot, args.x, args.y, args.z)
        case 'attack':
          return actions.attackEntity(bot, String(args.target), { seconds: args.seconds }, task)
        case 'wait': {
          const started = Date.now()
          const until = started + Math.min(300, Math.max(1, Number(args.seconds ?? 30))) * 1000
          while (Date.now() < until) {
            if (task?.cancelled) return { waited_seconds: round1((Date.now() - started) / 1000), stopped: true }
            const ev = eventsSince(startSeq).find((e) => PLAN_WAKE.has(e.type))
            if (ev) return { waited_seconds: round1((Date.now() - started) / 1000), woken_by: ev.type }
            await new Promise((r) => setTimeout(r, 200))
          }
          return { waited_seconds: round1((Date.now() - started) / 1000), timed_out: true }
        }
        case 'pillar':
          return interact.pillarUp(bot, args.height ?? 1, task)
        default:
          throw new Error(`未知计划步骤: ${tool}`)
      }
    }

    const doneSteps = []
    let interrupted = null
    let timedOut = false
    let stopped = false
    for (const s of steps) {
      if (task?.cancelled) { stopped = true; break }
      if (Date.now() > deadline) { timedOut = true; break }
      const w = wake()
      if (w) { interrupted = w.type; break }
      try {
        const data = await dispatch(s.tool, s.args)
        doneSteps.push({ step: s.index, tool: s.tool, ok: true, result: JSON.stringify(data).slice(0, 800) })
      } catch (err) {
        doneSteps.push({ step: s.index, tool: s.tool, ok: false, error: String(err?.message || err).slice(0, 300) })
        // 单个步骤失败不整条计划报废: 记录原因继续下一项, 模型收到后决定是否补做
        if (s.tool === 'collect' && /没有找到|找不到/.test(String(err?.message || err))) break
      }
    }
    const okCount = doneSteps.filter((d) => d.ok).length
    return {
      total_steps: steps.length,
      done_steps: doneSteps,
      ok_steps: okCount,
      interrupted_by: interrupted,
      timed_out: timedOut,
      stopped_by_user: stopped,
      position: fmtPos(bot.entity.position),
      note: interrupted
        ? `计划被事件 interrupted_by_${interrupted} 打断, 已完成 ${okCount}/${doneSteps.length} 步(查看 new_events 后再决定)。`
        : stopped
          ? `计划已由 stop 中止(完成 ${okCount}/${doneSteps.length} 步)。`
          : timedOut
            ? `计划超时, 已完成 ${okCount}/${doneSteps.length} 步, 剩余步骤下轮可继续用 plan/find 传递。`
            : `计划执行完成(成功 ${okCount}/${doneSteps.length} 步)。`,
    }
  }),
}

const PLAN_WAKE = new Set(['chat', 'whisper', 'damaged', 'death', 'kicked', 'disconnected', 'auto_defense', 'system', 'action_bar', 'player_joined', 'player_left', 'window_open', 'error'])

// 每个工具返回都自动附带自身状态与未下发的事件 —— AI 无需额外轮询
// 信息瘦身: self 在内容没变化时不重复输出(位置/生命/手持都没变 = 状态没变, 省 token 且缓存友好)
let lastSelfSnap = null
function buildPayload(err, data) {
  const payload = err
    ? { ok: false, error: String(err?.message || err) }
    : { ok: true, ...data }
  const bot = state.bot
  if (bot && bot.entity) {
    try {
      const light = currentLight(bot)
      const pos = bot.entity.position
      // 空间锚定: 用最近路标/放置记录告诉模型"我在哪"(解决挖矿到地下不知道在哪的问题)
      let area = null
      try {
        const lm = nearestLandmark(pos, listWaypoints(currentNs()))
        if (lm) area = `在「${lm.name}」${directionBetween(pos, lm.position)}附近`
      } catch { /* ignore */ }
      const snap = {
        position: fmtPos(pos),
        area,
        health: Math.round(bot.entity.health ?? 20),
        food: bot.entity.food ?? 20,
        held: bot.heldItem ? `${itemTitle(bot.heldItem)} ×${bot.heldItem.count}` : '空手',
        light: light == null ? undefined : (light < 7 ? `${light}(暗!记得放光源)` : light),
      }
      const snapKey = JSON.stringify(snap)
      if (lastSelfSnap !== snapKey) {
        payload.self = snap
        lastSelfSnap = snapKey
      }
    } catch { /* ignore */ }
    try {
      const evs = drainNewEvents()
      if (evs.length) {
        // 事件太多时只带最新的若干条, 控制每轮追加的 token 量(缓存友好)
        payload.new_events = evs.length > 20 ? evs.slice(-20) : evs
      }
    } catch { /* ignore */ }
  }
  return payload
}

// 统一分发: MCP 与 Agent 都走这里; 永不抛异常, 错误封装为 {isError, payload}
export async function executeTool(name, args = {}) {
  const a = args ?? {}
  const handler = HANDLERS[name]
  if (!handler) {
    const payload = buildPayload(new Error(`未知工具: ${name}`), null)
    pushActivity({ source: 'tool', kind: 'tool_call', name, args: JSON.stringify(a).slice(0, 300), error: '未知工具' })
    pushActivity({ source: 'tool', kind: 'tool_result', name, ok: false, summary: `未知工具: ${name}` })
    return { isError: true, payload }
  }
  pushActivity({ source: 'tool', kind: 'tool_call', name, args: JSON.stringify(a).slice(0, 300) })
  try {
    const data = await handler(a)
    const payload = buildPayload(null, data)
    pushActivity({ source: 'tool', kind: 'tool_result', name, ok: true, summary: JSON.stringify(payload).slice(0, 300) })
    return { isError: false, payload }
  } catch (err) {
    const payload = buildPayload(err, null)
    pushActivity({ source: 'tool', kind: 'tool_result', name, ok: false, summary: String(err?.message || err).slice(0, 300) })
    return { isError: true, payload }
  }
}
