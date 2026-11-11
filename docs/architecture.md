# 总体架构

## 1. 架构目标

- 手机 App、dsh 与未来连接器可以独立演进。
- 更换 dsh 版本或模型提供方时，不重写角色领域逻辑。
- 聊天、动态、游戏与媒体事件共享同一角色身份和记忆。
- 首版保持单 DSH 进程、单用户、低运维成本；TTS 等重计算放在独立 worker。
- 任一扩展能力失败，不影响核心聊天。

## 2. 当前基础包实现

`v0.15.0`（开发候选，尚未部署或实机验收）使用一个 pnpm workspace，交付一个 DSH bundle 和一个独立的 Expo App。原生构建目录、Expo 开发面板和模型密钥不进入 DSH tarball：

```text
bot/
├─ src/
│  ├─ core/                  # Persona / Context / Activity / Task / Memory / Feed / Autonomy / Media
│  │  ├─ store.ts            # 多场景、中央记忆、设备、媒体、自主任务与游戏经验：SQLite schema v14
│  │  ├─ game-learning.ts    # 真实失败案例、避开名单与成功核验
│  │  ├─ memory.ts           # 检索、修订、遗忘与历史
│  │  ├─ self-note.ts        # 最多 40 条有效自我观察、证据、归档与回滚
│  │  ├─ media.ts            # 真实媒体元数据、重复内容与清理预览
│  │  ├─ autonomy.ts         # 自主任务、节律设置、去重与恢复
│  │  └─ feed.ts             # 动态、回复与游标分页
│  ├─ host/
│  │  ├─ runtime.ts          # 事件采集、Presence 与统一视图
│  │  ├─ session.ts          # Agent 创建恢复、发送、取消与历史
│  │  ├─ tool-policy.ts      # Session setup 中的场景工具索引与限制
│  │  ├─ events.ts           # 可配置授权的 WebSocket 与活动回放
│  │  ├─ devices.ts          # 一次性配对、凭据哈希、连接跟踪与撤销
│  │  ├─ device-http.ts      # 独立设备 API 与本机设备管理接口
│  │  ├─ recall.ts           # 有预算的按需召回与场景隔离
│  │  ├─ memory-tools.ts     # 已注册场景的记忆工具与权限
│  │  ├─ autonomy.ts         # 持久自主调度、结构化分析与执行租约
│  │  ├─ media.ts            # 私有目录扫描、哈希、用量与缺失标记
│  │  ├─ avatar.ts           # 私有形象、动作任务、心跳与停止回执
│  │  ├─ avatar-http.ts      # 同源舞台、模型资源与动作 API
│  │  ├─ security.ts         # 本机同源管理认证与子资源边界
│  │  ├─ tts.ts             # 有界语音任务队列、进程与媒体生命周期
│  │  ├─ tts-provider.ts    # 回环 GPT-SoVITS 请求与 WAV 校验
│  │  ├─ tts-worker.py      # 旧 Piper Python 工作进程
│  │  ├─ audio.ts           # 受控 WAV 与 Range 响应
│  │  ├─ minecraft.ts       # 独立 worker、任务、事件与真实经历记忆
│  │  ├─ minecraft-tools.ts # 仅 game.minecraft 可见的受控游戏工具
│  │  └─ http.ts             # 本机同源管理 API
│  ├─ client/                # DSH 侧栏工作台、设备、自主节律、形象与 Minecraft 页
│  ├─ avatar/                # 开源网页舞台与许可，不含模型或 Cubism Core
│  ├─ protocol/              # 宿主与面板共享协议
│  └─ index.ts               # apply(ctx)、Config 与生命周期
├─ apps/minecraft-worker/
│  ├─ cbi-world.ts          # Carpet＋CBI、FIFO、真实回执与安全动作
│  ├─ index.ts              # 本机 worker API 与可选 Mineflayer 适配器
│  └─ console.sh            # 私有 FIFO 和既有 Java 服务启动器
├─ apps/mobile/
│  ├─ app/                   # 配对、场景和聊天页面
│  └─ src/host/              # SecureStore、设备 API、WebSocket 与生命周期
├─ patches/                  # React Native 非 ASCII 路径构建补丁
├─ cordis.patch.yml
├─ package.json
├─ pnpm-workspace.yaml
├─ tsdown.config.ts
└─ docs/
```

插件通过 `ctx.agents.create/resume()` 创建或恢复多个独立根 Session。活动观察以 DSH Session 为原始事实，Companion SQLite 只保存领域投影，不复制消息正文。动态已接入 SQLite 与受控工具；真实用户轮次已触发自主记忆分析并生成候选，自主动态默认关闭。按需语音由独立 GPT-SoVITS v5 turbo 服务合成，不阻塞 Agent 事件循环；旧 Piper 仅保留技术验证。基础 Live2D 已接入，RTC 尚未接入；Minecraft 采用 Carpet＋CBI，动作完成度以真实世界回执为准。

### 场景与记忆的核心不变量

- `contextId` 是长期场景身份，`sessionId` 是该场景当前的执行上下文；换 Session 不改变场景身份。
- 一个角色可同时拥有聊天、游戏、任务和话题场景，Session 之间不共享原始上下文。
- Persona 与中央记忆独立于所有 Session。固定档案版本由本机工作台提交，当前版本进入已绑定聊天、游戏和话题根会话的系统提示。场景私有记忆只在同一 `contextId` 内可见，共享记忆才可跨场景召回。
- 中央记忆是当前可修订事实，memory_revision 保存历史版本，DSH Session 保存原始执行日志；三者不互相冒充权威。
- 记忆工具只接受已注册场景的调用，私有记忆只能在所属场景修改。
- 只有真实用户输入参与检索，召回条数与字符预算有硬上限；候选、遗忘和历史修订不进入默认召回。

### 会话与实时事件不变量

- Agent 创建和恢复统一使用 `agentDefaultModel.currentSelection()`，与原生 DSH 流程一致，不硬编码模型。
- `accepted` 只表示消息进入队列；回复完成以 DSH 的持久事件为准，取消也必须记录真实终止状态。
- `message.delta` 是瞬时显示通道，activity id 是持久活动 cursor，二者不互相冒充。
- 重连只补发持久活动，最终文本通过 `message.completed` 与历史对账；场景过滤在服务端执行。
- 每 10 秒向每个连接发送不持久化的 `ping`，用于保活而不携带场景数据，不经过场景过滤。客户端 25 秒未收到任何帧则启动 watchdog，设备健康检查超时为 10 秒。
- 撤销是订阅的终止状态，不再重连；旧 generation 的连接、迟到健康检查和关闭事件不得覆盖撤销状态或造成重复连接。
- `/companion/api` 管理 HTTP／WebSocket 限本机同源请求；`/companion-device/api` 只接受独立 `Device <id>.<secret>` 凭据，数据库只保存 secret 的 SHA-256 哈希。
- 配对链接有效期 5 分钟、只能兑换一次；配对码只保存在当前进程。设备撤销会立即终止该设备的已跟踪 WebSocket，后续认证返回 401。
- 手机不持有 DSH 启动令牌或模型密钥；断线后先通过设备健康接口区分撤销与网络失败，不将 1006 简单等同于撤销。

## 3. 目标逻辑架构

```text
┌──────────────────────────────────────────────┐
│ Mobile App                                   │
│ Chat / Feed / Notifications / Profile        │
└──────────────────────┬───────────────────────┘
                       │ HTTPS + WebSocket
                       │ Tailscale tailnet only
┌──────────────────────▼───────────────────────┐
│ Companion Mobile Gateway                     │
│ Pairing / Auth / API / Event Stream          │
├──────────────────────────────────────────────┤
│ Companion Core（不依赖 dsh 的领域包）          │
│ Persona / Memory / Feed / Tasks / Presence   │
│ Capability Registry / Repository Interfaces  │
├──────────────────────────────────────────────┤
│ dsh Adapter                                  │
│ Agent / Session / Stream / Tools / Schedule  │
├──────────────────────────────────────────────┤
│ DeepSeek Harness web profile                 │
│ Model / Agent Loop / Session Log / Storage   │
└──────────────────────┬───────────────────────┘
                       │
             ┌─────────┴──────────┐
             ▼                  ▼
       Local Data         Capability Adapters
       SQLite/Files       TTS / RTC / Avatar /
                          Minecraft / Media
```

### 部署边界

- **默认部署**：Companion bundle 加载在 dsh Host 内，手机直接连接 dsh 暴露的受控接口。
- **备选部署**：若原生 App 认证、WebSocket 或媒体代理不适合放在 dsh 内，增加独立 Mobile Gateway 进程，通过本地接口与插件通信。
- **不采用**：手机直接访问模型 API、手机持有模型密钥、把 dsh SDK stdio 当作手机网络协议。

## 4. 模块职责

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Mobile App | 展示、输入、播放、实时事件、本地缓存 | 人设真相、长期记忆、模型密钥 |
| Mobile Gateway | 配对认证、权限、限流、API、事件推送 | 模型推理、角色决策 |
| Persona | 人设版本、关系设定、状态与行为边界 | 保存完整聊天日志 |
| Memory | 写入、检索、纠错、遗忘、来源追踪 | 无上限保存所有原始内容 |
| Feed | 动态、回复、活动卡片、时间线 | 独立维护另一套角色 |
| Task | 主动行为与长期任务的执行状态 | 把调度投递等同于执行成功 |
| dsh Adapter | Agent 创建恢复、followup、流式事件、工具注册 | 具体业务页面与社交规则 |
| Domain Store | 人设、记忆、动态、任务、能力配置 | 原始模型会话日志 |
| Capability Adapter | 外部能力的受控动作、事件和健康状态 | 绕过权限直接控制宿主 |

小家从角色状态投影活动和语义位置。游戏 worker、Live2D 舞台、聊天场景和已保存的回执仍各自拥有事实来源，宿主只在状态响应中组合它们。工作台和安卓把 `window`、`bed`、`sofa`、`desk`、`stage` 映射到各自的房间布局。换房间图或加入社区时可保留这些点位，继续复用当前状态接口。

## 5. 聊天主链路

```text
用户发送消息
  → Mobile Gateway 验证身份和请求
  → dsh Adapter 创建或恢复 Agent/Session
  → Agent.followup()
  → dsh 执行模型与工具轮次
  → agent/assistant-stream 提供实时增量
  → session/event 提供持久 settlement
  → Gateway 向 App 推送增量与完成状态
  → Memory 根据明确规则提取候选记忆
```

必须区分：

- **实时增量**：用于显示，可能因断线需要重新同步。
- **持久会话事件**：用于恢复和权威完成状态。
- **App 本地缓存**：不是服务端会话真相。
- **长期记忆**：从会话和活动中按规则生成，不是完整日志的替代品。

建议逻辑接口如下，最终路由以 dsh 技术验证为准：

```text
chat.createSession
chat.sendMessage
chat.cancel
chat.getHistory
chat.follow             # 流式
feed.list
feed.create
feed.reply
persona.get
memory.list
memory.correct
memory.delete
events.subscribe        # 独立领域事件协议
health.get
```

## 6. 中央记忆设计

### 三层事实与上下文

| 层 | 职责 | 存储位置 |
| --- | --- | --- |
| 执行上下文 | 当前话题或任务的原始交互，允许隔离、压缩和换 Session | 各 DSH Session 日志 |
| 当前中央记忆 | 跨场景仍有用的紧凑事实，支持共享/场景私有、候选、活跃、归档、遗忘与长期锚点 | Companion `memory` 表 |
| 记忆修订与原始来源 | 历史版本、归档或遗忘原因、写入者、原始 Session／活动指针 | `memory_revision` 与 `sourceRefs` |

当前 `MemoryRecord` 字段：

```text
id、kind、content、scope、contextId、status、importance、confidence、pinned
recallCount、sourceRefs、createdAt、updatedAt、lastUsedAt、forgetReason
reinforcementCount、lastReinforcedAt、retention、archivedFrom、archiveReason
```

- `scope=shared` 才允许跨场景召回；`scope=context` 只允许所属 `contextId` 检索和修改。
- 置信度低于 `0.8` 默认成为候选；候选不会进入默认召回，确认后转为活跃。
- 遗忘保留 tombstone 和完整修订，不再进入召回；恢复按当前置信度回到活跃或候选。
- 长期锚点只在 Session 第一轮注入，普通记忆只在真实用户输入的关键词命中时召回。
- 单次最多召回 4 条，中央记忆文本总预算 3000 字符；不会把其他 Session 的对话历史拼入当前上下文。
- 已注入的自动召回片段仍需服从中央记忆的当前状态与场景权限。后续模型步骤和 Companion 的闲置压缩前，宿主通过 DSH 的位置替换撤回已经失效的条目，并保留同段有效条目及独立原始日志。
- 记忆检索以关键词相关度为主，结合重要度、置信度、使用时间和长期权重排序。已注入且与真实用户输入强匹配的活跃记录，每个 UTC 日最多强化一次。模型工具、锚点自动注入和游戏环境提示可以产生普通召回，但不提高强化次数。
- 归档保留正文、来源和原状态。日常召回跳过归档，主人可从工作台搜索并恢复。批量归档会重查记录的最近修订与使用，保护长期锚点和高置信且带事件、任务或活动来源的记忆。后台归档需单独开启，最多每天处理 50 条。显式遗忘维持自己的 tombstone 和恢复规则。
- 工具／面板可显式写入；真实聊天与活动完成后也会由独立 `memory.curator` 提炼候选，自动候选不直接进入活跃召回。真实 Minecraft 移动与采集按任务回执写入共享经历，保留 Session、任务和事件来源，去重、纠正与候选机制不变。

### 记忆写入权限

`companion_memory_search / remember / correct / forget` 只对已注册场景的 Session 开放。工具从 DSH 执行上下文取得真实 Agent 和场景绑定，不能由模型传入另一个场景身份来越权。场景私有记忆只能在所属场景纠正或遗忘，管理面板的修改保留独立审计记录。

## 7. 动态与任务

动态是角色活动的一种公开给所有者的投影，不是模型内部日志的简单复制。

动态类型可包括：

- 用户或角色发布的文字。
- 图片、语音和媒体卡片。
- Minecraft 建造、探索等游戏活动。
- 任务完成或失败摘要。
- 听歌、看视频后的受控生成内容。

dsh Schedule 可触发提示词或会话输入，但其保存的投递记录不表示任务执行完成，也不是外部通知渠道。因此 Companion Task Store 必须独立记录：

```text
accepted → running → succeeded / failed / cancelled
```

主动行为需要频率限制、免打扰时段、重复内容抑制和全局停止开关。

### 自主角色内核

- `autonomous_job` 与现有 Task 共用生命周期，保存任务类型、场景、去重键、计划执行时间、结构化负载、尝试次数和执行租约；进程重启后从 SQLite 恢复，不把 `setInterval` 当成完成状态。
- 聊天／游戏完成事件只触发有界、延迟的记忆整理，内部记忆分析使用独立 `memory.curator` Session，不把原始 Session 全文复制进其他聊天上下文。
- 记忆分析输出必须经 Zod 校验，最多 3 条，强制 `status=candidate`、confidence 不超过 0.79；相同规范化内容不重复插入。活跃记忆与召回规则不变。
- 自主动态使用另一独立 Session 和固定提示词，只有总开关、动态开关、最小间隔、免打扰和真实活动门槛同时满足才可执行。模型只能使用已注册的受控工具，发布结果以实际 Feed 为准。
- 同时只执行一个自主分析任务，避免模型调用和 Mac mini 资源竞争；超时、重试、取消和跳过都写入真实任务状态。管理 API 只接受允许的任务类型，不接收任意自主提示词。

## 8. 本地语音链路

- 用户主动点击一条真实助手消息的语音按钮后，服务才读取对应 `contextId` 的持久历史；用户消息或任意提交文本不能冒充角色语音。
- `TtsService` 复用 Companion Task 状态机，最多一个执行中任务、最多四个运行／等待任务，单条文本不超过 1500 字，单个 Provider 请求超时 60 秒。
- GPT-SoVITS v5 turbo 在独立常驻服务中加载一次模型，Companion 仅通过回环 HTTP 传入固定参考声线和真实消息文本，不让每条消息重复加载模型，也不向手机暴露模型管理接口。WAV 先写临时文件，验证后原子改名；退出、超时与服务停止均清理请求和临时文件。旧 Piper worker 仅作为历史 Provider 保留。
- `tts_asset` 保存任务、来源消息、声线、文本哈希、受控文件位置、格式、大小和时长，不另建聊天正文副本。相同消息与声线复用任务和文件。
- 设备只能以任务 ID 查询状态和读取音频；Authorization 必需，音频接口不接受文件路径。WAV 文件权限为 600，支持单段 Range 响应。
- 手机使用一个 `expo-audio` 播放器，支持等待、取消等待、失败重试、暂停、继续、重播和离开页面释放；不自动朗读所有消息，也不声明麦克风或后台播放权限。
- 正式声线使用用户已有的大肥鱼参考音频及配套文本，素材使用范围以其来源和授权为准。华炎仅用于旧技术验证，Drama3 是后续独立 Provider 候选。TTS 故障只影响语音任务，不得中断文字聊天或其他 Session。
- `0.13.0` 新增 `RealtimeVoiceService` 与 `TtsService.synthesizeClip()`：真实助手消息按标点与长度最多拆成 6 段，复用现有 TTS 队列和 WAV 资产。分段合成、就绪、实际播放、完成与取消分别记录，后段可在前段播放时继续合成。只有浏览器 `start()` 后才是 `playing`，`onended` 才是 `completed`；未开始段与当前播放都可取消，取消与 `onended` 竞态不会误报成功。当前实现是分段实时化，不是 Provider 原生流式输出或手机 RTC。

## 9. 数据与文件

- **会话日志**：归 dsh 管理，不另写一份冲突的消息真相。
- **领域数据**：通过 Repository 接口访问 dsh Storage 或插件自有 SQLite；首版单用户规模下优先简单方案。
- **媒体文件**：放 Mac mini 文件系统，数据库仅保存元数据和受控访问引用。
- **密钥**：放 dsh 凭据机制、系统钥匙串或专用环境配置，不写入 Git、日志或人设。
- **备份**：至少覆盖领域数据库、人设版本、媒体元数据和必要配置；备份中密钥单独处理。
- **迁移**：所有持久记录带 schema 版本，升级前备份，禁止无回退方案的破坏性迁移。

dsh 官方 SQLite 后端采用同步 `node:sqlite` 写入。首版低写入量可以评估复用；高频媒体、游戏遥测或大流量事件不得直接压在该路径上。

## 10. 能力接口

每个后续能力应提供统一描述：

```text
id、version、displayName、permissions、configSchema
health、actions、events、dispose
```

原则：

- 模型只决定受控的高层意图，具体动作由适配器校验后执行。
- 危险操作采用允许列表，而不是只维护拒绝列表。
- 每个动作可取消、可审计、可超时。
- 连接器不可用时，核心聊天保持运行。
- Minecraft 后续还需区域限制、操作频率、保护清单和紧急停止。

当前 Minecraft、B 站和歌唱的接入点为 `src/host/world-manifest.ts` 和 `src/host/world-connectors.ts`。前者声明场景 ID、会话类型和每项动作的权限，供模型工具可见性与会话绑定校验共用。后者装配实际服务、注册工具、在执行前核对绑定，并负责状态投影和停止。各服务继续持有自己的配置、授权、超时、动作和回执校验。自主调度从已有领域回执接续，连接器状态不充当行动证据。

后续连接器可在宿主代码里增加独立服务、声明和装配，沿用同一权限与退出流程。回归应核对实际注册动作和声明一致，并覆盖错误场景、停机、有效回执和另一个 World 保持可用。配对端沿用 `state.worlds` 版本 1 的只读清单，每项只返回 ID、显示名和状态。状态读取使用宿主现有观测，额外的远程探测和模型调用不进入状态轮询。

## 11. 网络与安全

- 手机和 Mac mini 均加入同一 tailnet。
- 优先使用 Tailscale Serve 提供仅 tailnet 可访问的 HTTPS；不使用 Funnel，不做公网端口映射。
- dsh 的 Host 信任检查、启动凭据或会话 cookie 仍需正确配置，Tailscale 不替代应用认证。
- 原生 App 不复用 dsh 浏览器启动凭据：使用独立配对链接和可撤销设备凭据；长期设备密钥仅存于原生 SecureStore。Web 调试存储不是生产凭据存储方案。
- API 默认仅允许所有者身份，写操作增加限流与幂等键。
- 日志不记录模型密钥、配对令牌、完整认证头或私密媒体地址。
- dsh 官方明确说明其处于开发者预览、尚未接受安全审计，因此权限隔离和备份不能只依赖 dsh 自身。

## 12. 技术默认值

| 项目 | 默认选择 | 说明 |
| --- | --- | --- |
| 服务端语言 | TypeScript | 与 dsh 插件和 Cordis 一致 |
| 手机端 | React Native + Expo | 优先跨平台与迭代速度；需要时用自定义原生模块 |
| 包管理 | pnpm | 与 dsh 工具链一致 |
| 数据 | SQLite + 本地文件 | 单机、单用户、易备份 |
| 网络 | Tailscale Serve + HTTPS/WSS | 仅 tailnet |
| 实时音视频 | 后续评估 WebRTC/LiveKit | 不在 MVP 引入 |
| 形象 | 后续评估 Live2D 或 3D | 不在 MVP 引入 |

## 13. 长期角色世界与接口

### 分层职责

| 层 | 唯一职责 | 不应承担 |
| --- | --- | --- |
| DSH | Agent Loop、模型调用、Session 持久化、工具调度 | 角色自己的世界状态与跨场景记忆真相 |
| Companion Core | 人设、记忆、自治任务、世界状态、权限与媒体元数据 | 直接执行每个 World 的底层动作 |
| World Adapter | 环境观察、事件、动作、回执、健康与释放 | 修改人格、合并其他场景的 Session |
| Provider | TTS、实时语音、ASR、歌唱、图像与存储等可替换能力 | 决定角色该做什么或是否授权 |
| Presenter | 手机、桌面、Live2D、OBS 等展示与互动 | 把动画或文本当作真实活动证据 |

一个 World 的定义应包含稳定 ID、能力声明、配置边界、观察事件、受控动作、健康检查和 `dispose()`。模型只看到该场景所需的环境描述和工具，不直接获得其他 World 的权限。

### 会话与记忆路由

```text
来源／话题连续性 → 稳定的 contextId → 当前 Session
                                    ↓
原始 Session 日志  → 空闲摘要与事件索引 → 中央记忆与自我笔记
                                    ↓
有限锚点 + 按相关性检索 → 当前 Session 的工作上下文
```

- 手机聊天、游戏、动态、桌宠和自主分析各自拥有独立 Session，避免重复上下文和无关工具。
- `contextId` 是长期身份，`sessionId` 可恢复、替换或压缩。跨场景关联提供证据，不自动扩大授权或隐私范围。
- 原始消息不跨场景复制；共享记忆记录事实、目标、偏好与重要经历。私有内容只有在明确授权时才可被其他场景检索。
- 自我笔记属于带证据的观察，最多 40 条有效项，归档保留历史；不能自动覆盖核心人设。遗忘、修订、回滚与主人纠正是协议的一部分。
- 空闲压缩保留真实任务状态与来源，避免在活跃回复中反复重写上下文。模型重复生成的内容不能单独提高事实置信度。

### 自治与授权

借鉴 `dsh-superagent` 的 Trigger → Eval → Mandate → Assignment → Outbox，但继续使用现有 Companion Task Store，不另建 Agent：

```text
真实事件 → 去重与意图生成 → 权限／预算／场景检查 → 执行与回读 → 真实回执与记忆
```

- 用户发帖、评论或游戏事件可以触发评估，必要时回复，必要时沉默。定期自主动态只是可选意图，不是默认打卡。
- Mandate 记录来源、允许的场景和动作、预算、有效期与停止条件。它决定角色可以做什么，不由一句“我想做”代替。
- 执行结果与计划分离：accepted 表示入队，running 表示执行中，succeeded 只在有真实证据时成立，skipped/cancelled 记录有意的跳过或取消，failed 表示实际失败。
- 高风险或不可逆动作需要单独确认和回滚路径；低风险的交流、浏览和有限游戏动作可以在预算内自主完成。

### 工具与 Token 预算

- 常驻工具只保留当前场景必需的小集合。扩展工具以简短索引声明名称、用途和权限，按场景与意图启用，不把全部说明书注入每轮对话。
- 工具索引优先由宿主按确定规则选择，避免模型每轮先读一个工具目录再决定工作。需要新工具时才加载对应说明和执行权限。
- 记忆召回保留有限锚点与按需检索；活跃回复中不反复进行大范围历史整理。
- 视频采用来源去重、分段读取、相关片段摘要和独立取稿上限。抓取字节数、媒体文件大小和估算 token 分开统计，不能冒充供应商账单。

### 语音与媒体生命周期

- 普通 TTS：真实助手消息 → 任务 → 整段 WAV → 鉴权播放 → 缓存与保留策略。
- 实时 TTS：可朗读文本增量 → 分段合成 → 有序 PCM → 播放时钟 → 取消／恢复；音频能量驱动口型，不能预先写“正在说话”。
- 歌唱是独立 Provider，处理歌声、音高、伴奏和授权，不复用普通语音任务的生命周期来冒充实时演唱。
- 媒体清单统一保存哈希、类型、来源、大小、保留策略和访问状态。先提供用量和清理预览，再对可再生产物去重、归档或删除。
- 模型权重、角色原素材、参考声线、原始聊天、中央记忆与备份不属于自动垃圾清理范围。清理不能依赖客户端传入的任意文件路径。

### Live2D 与动作

- `DeepSeek免费公皮.zip` 含标准 `.moc3` 与 `.model3.json`，用于真正的 Live2D 渲染；`大肥鱼合集_1.2` 的 `ysm-pack.json/png` 用于 YSM／游戏资源，不能混用渲染方式。
- 优先复用本地鲸语的舞台与动作编译、参数映射和回执，或兼容的 Coopanion 形象包机制。Windows 专用桌面壳只作为交互参考，Mac mini 先验证网页运行时。
- 模型参数与动作采用允许列表、优先级和时段。语义动作先转换为受控 intent，再由现有仲裁处理，不能让自然语言直接覆盖所有底层参数。
- 物理输入相位、参数所有权、打断和释放遵循鲸语的约束，避免自主动作、待机和手动互动相互覆盖。动作执行完成才进入活动记录。
- `0.13.0` 新增 `voice.mjs`：Web Audio `AudioBufferSourceNode` 驱动真实播放，`AnalyserNode` 每帧测量 PCM 能量并只映射 `ParamMouthOpenY / ParamMouthForm`。音频上下文、当前段、播放毫秒和能量进入真实舞台心跳；停止、失败或换段清零口型。自动播放策略通过舞台“启用声音”按钮处理，未实测的听感和声画延迟不提前承诺。
- `0.13.1` 新增 `avatar-tools.ts`：`companion_avatar_action` 只允许 `blush / point`，`companion_avatar_stop` 只发停止请求。普通聊天、游戏和话题 Session 可调用，记忆整理与动态内部场景拒绝。`accepted` 与 `stop-requested` 只表示意图已接收，后续 `playing / completed / cancelled` 仍以真实舞台回执结算，不把自然语言意图写成已执行动作。

### Minecraft

- Coopcraft 已核实为 Fabric 1.21.1 模组，提供共享路径点、进度、死亡点和文明机制，不是现成 AI 协议。当前使用 Carpet fake player＋CBI 的本机服务端接入；Tailscale 继续用于主人连接，不打开新的 RCON、OP 或公网端口。
- `apps/minecraft-worker/cbi-world.ts` 通过私有 FIFO 向既有 Java 进程发送宿主固定拼接的命令，再按写入前的日志偏移等待真实回执。模型不能传入控制台命令。Mineflayer 适配器仅保留给未来有独立正版账号的服务器。
- 真实观察来自实体 `Pos / Dimension / Health / foodLevel / foodSaturationLevel / Air / playerGameType / Inventory`、玩家列表和 `time query daytime`。实测该服务端没有 `weather query`，因此不虚构天气。坐标和方块通过 `/data` 与 `execute if block` 回读。
- CBI 负责跟随、短距离寻路、精确单方块操作和对应物种拾取。执行阶段的区块检查使用权威 `ServerLevel`，必要时只加载当前路径段；查找以明确完成回执结束，并在角色周围最多 5×5 区块内同步扫描。采集候选限制在 24 格与垂直 8 格内，优先接近当前高度，要求同树种 `persistent=false` 树叶证据，再操作精确坐标；默认禁止放置和通用破坏。动作有超时、取消、范围和危险目标限制，背包未实际增加不记为采集成功。
- CBI 的私聊自动回执必须绕过其第二套 LLM，防止 `[CBI]` 回复自触发循环。这个补丁与 AGPL 源码独立保存，不把 CBI 的凭据、会话或模型配置接入 Companion。
- `0.12.0` 候选新增 `EmergencyAvoidanceController` 生存反射与 `SurvivalResourcePolicy`：每 tick 处理举盾、反击、火球反弹、无武器退避和攻击冷却期后退；模型只决定低频目标。资源账本直接读取真实背包，保留两根原木，回程储备不足时才每 20 tick 限量合成一根原木，战斗时暂停。`mc_stop` 同步关闭战斗、避险、进食和自动合成，新的明确动作才恢复。地下 MINE 在工具耐久不超过 5 或即时／可合成回程储备不足时停止，不继续盲挖。候选尚未实机验收，自动垫脚回程未开放。
- `0.12.1` 新增 `GameLearningRepository`：按动作、错误码和目标生成稳定签名，保存失败次数、来源、学习中／已验证状态。worker 的 `PUT /api/lessons` 只接受最多 64 个合法坐标，在后续采集前剔除接近失败的目标；同目标真实成功后才标记 resolved，不扩大权限，也不做在线训练。模型每次最多读取三条相关经验，同步失败只降级为普通动作，不阻断游戏。
- `0.12.2` 新增 `SafeReturnPlan / SafeReturnTask` 与 `mc_return`：只在最多 16 格内选择四邻方向的真实出口，预检完整立柱空间、两格站立高度、稳定支撑和廉价方块。服务端逐 tick 完成居中、跳跃、放置、落地与最后一步寻路下台，每格核对世界状态和背包扣减；保留原木，拒绝流体、下落方块、穿顶和任意建造。worker 只有收到 `SUCCEEDED` 且角色实际站上出口才记成功，状态包含出口、放置数与错误码；普通移动仍保持 `allowPlace=false`。候选尚未实机验收。
- `0.12.3` 新增 `SurvivalCraftingService` 与 `mc_craft`：一次只匹配一个白名单配方，支持八种木板、木棍、工作台、木镐、石镐和盾牌。`RecipeManager / CraftingInput` 核对真实配方 ID、产物 ID 和原版数量；镐与盾牌需要三格内可交互的已有工作台。库存事务在产物或剩余物写入失败时恢复原材料，worker 再核对前后增量。保留两根原木，失败进入经验课；这不是通用制造、批量合成或在线学习。候选尚未实机验收。
- `0.12.4` 新增 schema v12 `minecraft_build_zone`、`BuildZone / CampBuildPlan / CampBuildTask` 与 `mc_build_camp`：主人通过本机管理 API 创建或撤销半径 2～8 格的区域，模型只能引用有效 ID。营地固定为 8 块地板和 1 个工作台，逐块检查授权、空气目标、既有支撑、实体、材料与放置回执；不覆盖、不自动拆回。worker 再核验最终结构和扣料，合成与建造回读期间暂停自动木板合成以避免库存竞态。候选尚未实机验收。
- `0.12.5` 新增 `MinecraftService.prepareCamp()` 与 `mc_prepare_camp`：复用真实 `dig / craft / build` 子动作，每次循环读取实际背包计算缺口，保留两根原木，最多 6 次采集、5 次配方、1 次建造和 8 分钟总时限。父任务与子任务分别结算，撤销当前区域在采集、合成或建造阶段都会停止目标；取消与失败分开记录，部分进展不自动拆回。本轮未修改 CBI Java，复用 `0.12.4` 建筑版，真实连续目标仍待实机验收。
- Coopcraft 的共享路径点和文明事件可作为后续适配器输入，不能直接假定它提供 Agent API。Java 版本、白名单、备份与运行方式已按实际服务端核验；合成、建造、战斗和区域保护继续分阶段开放。
- `0.115.0` 的每日建筑备料沿用同一宿主提案与授权租约，但使用独立的 `minecraft.house-project.supply` 子任务。只读预检绑定项目、地块、分段、材料及精确缺口；Worker 要求角色在指定地块内静止站稳，保留至少两根同种自然原木，且没有同配方竞争材料。每次消耗一根橡木或云杉自然原木，合成四块同种木板。宿主核对合成与库存前后增量后记录共享事实，不把备料记为分区完工。撤销、到期、换会话或无法确认位置时不确认成果，冷重启保留每日去重，SQLite 保持 v43。
- `0.116.0` 新增 schema v44 `minecraft_place` 与 `MinecraftPlaceRepository`。整栋核对通过且授权有效的工程才可命名，地点取授权区中心而非猜测入口。命名和改名通过同一事务更新任务、地点及共享中央记忆；记忆修订保留原名。`mc_status(section=places)` 只向游戏根会话提供已验收工程与有效地点，`mc_name_place` 不能移动角色或改变世界。撤权和已归档记忆退出可用清单，配对活动过滤项目内部 ID、游戏 Session 和记忆关联。
- `0.117.0` 通过可选 `minecraftOvoRoot` 直接加载用户本地 DeepseekOVO 技能函数，不启动其 Agent。`apps/minecraft-worker/ovo-skills.ts` 使用项目固定的上游 Mineflayer 与 `minecraft-data` 组合承载箱子存取和后台烧炼。技能查找与动作限制在授权区，禁止破坏、放置与命令回退。宿主复核真实容器、背包变化与目标所有权，烧炼区分投料和取出。未配置时继续使用 CBI；启用时使用现有账号认证及白名单流程，不共享凭据、不新增第二个人格。

这些长期接口允许继续接入编曲、绘画、其他游戏和外部服务，而无需替换角色核心、中央记忆或 DSH。

## 14. M3a 当前实现与运行边界

### 真实事件与自主任务

- 用户动态通过 `CompanionRuntime.publishPost()` 产生 `feed.reply` 任务，进入现有自主队列；`feed.reply.<postId>` 是独立长期场景，不合并手机聊天或自主动态 Session。
- `feedRepliesEnabled` 控制用户互动回应，默认开启；`feedEnabled` 控制主动发帖，默认关闭。两者互不打开对方。
- 每个线程复用一个待处理任务，连续互动更新触发事件；全局同时只运行一个分析任务。冷却与免打扰推迟执行，暂停取消未开始任务，不把沉默写成回复。
- `companion_feed_read` 在回应场景只能读取自己的线程；`companion_post_create` 只能回复该线程且不超过 240 字。真实回复、来源 Session 和完成事件核验后任务才成功，随后进入候选记忆整理。

### 自我笔记与媒体

- `self_note` 与 `self_note_revision` 独立于中央记忆。自动观察必须逐字匹配真实交互，统一为 `inference`，置信度不超过 0.79；主人可纠正、归档、恢复和回滚，超过 40 条仅归档最旧有效项。
- `media_asset` 保存相对路径、真实 SHA-256、来源、保留策略和最近使用时间。`MediaService` 仅扫描 Companion 媒体目录，跳过符号链接，不把模型、原素材、记忆或备份列入清理候选。
- TTS 与实时分段读取均更新媒体使用时间。`0.14.0` 新增本机管理 `POST /media/cleanup`：主人在预览后明确确认，才对过期可再生成缓存逐项核对路径、文件类型、大小和 SHA-256 并删除。缺失、变化、哈希不符与保护项跳过；schema v12 保留删除墓碑和实际释放字节，扫描不复活已清理记录，同名新文件可重新生成。后台自动清理仍未开放。
- `0.15.0` 新增 `DeviceMediaService`：手机经设备鉴权上传 PNG/JPEG/WebP，最大 10MB，同时验证声明 MIME、真实魔数和 SHA-256。图片以随机 ID 写入 `media/images/`，权限 600；schema v12 的 `post.media_id` 只保存附件引用，不保存 Base64 或对话正文。设备通过 `/companion-device/api/media/:id` 读取，工作台通过 `/companion/api/media-file/:id` 展示同一附件；读取再次核验文件与哈希，篡改拒绝。
- `0.15.1` 的 schema v13 允许带图片引用的动态和回复正文为空，原有动态 ID、回复关系与媒体引用随事务迁移。工作台通过现有管理请求头取得图片，再在页面中显示。自主回复只接收文字和附件存在提示，图片本身留在媒体库。
- 工具策略通过 `ctx.agents.create/resume({ setup })` 在首轮模型调用前限制 Companion 工具：普通场景四个记忆工具与两个形象动作工具、动态场景两个动态工具、记忆整理零个。该机制不声称限制 DSH 其他插件的工具，也不承诺固定的 token 节省量。

### 私有形象与真实回执

- 静态舞台由 `dsh-companion-bot/package.json` 定位到 `lib/avatar`，避免模块 URL 差异造成目录误判。包内只包含开源代码与许可，模型、参数配置和官方 Core 位于 `~/.local/share/companion/avatar/`。
- `AvatarService` 在素材存在时提供两个 allowlist 动作；真实舞台心跳就绪后才接受动作。任务先通过 `pendingActions` 下发，浏览器执行后通过 `receipt` 更新状态，不能由客户端文本直接写成完成。
- 宿主停止先写 `stopRequestIds`，舞台实际停止后回传取消；断线或重启不会把未核验动作标为成功。动作执行失败也必须有失败回执，不能卡在假运行状态。
- `managementAssetAllowed` 只允许同源 GET/HEAD 资源读取，API 继续使用 `managementAllowed`，不把设备凭据当作管理权限，也不绕过 DSH 官方登录。目录诊断仅出现在本机管理 API，不向设备公开。
- `AutonomyService` 只读取 Avatar 的能力与在线状态，帮助角色如实描述已配置动作；不把配置或提示词当作实际画面和执行经历。实时口型、完整动作编排、自主表演与手机端 Live2D 仍属后续阶段。
