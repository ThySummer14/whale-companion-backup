# DeepSeek Harness 接入说明

## 1. 调研基线

- 官方仓库：`deepseek-ai/deepseek-harness`
- 默认分支：`master`
- 本次核实的分支头：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
- 调研日期：2026-11-06
- 官方状态：开发者预览，未来会出现破坏兼容性的变更。

本文只把官方源码或文档明确描述的内容列为“已确认”。实际 Mac mini 环境、原生 App 认证和具体插件实现仍需 M0 验证。

## 2. 已确认能力

| 能力 | 官方机制 | 对本项目的意义 |
| --- | --- | --- |
| 插件入口 | TypeScript 模块导出 `apply(ctx)`，用 `inject` 声明依赖 | 可实现 Companion Host 插件 |
| 生命周期 | 通过 `ctx` 注册的监听、工具和定时器随插件卸载清理；外部资源用 `ctx.effect()` | 可承载长驻连接，但必须正确释放 |
| 可安装包 | 包清单声明 `dsh.bundle.patch`；profile 保存有序 `dsh.profile.bundles` | 能满足“制作插件包并安装到 Mac mini” |
| 版本约束 | bundle 可声明 `engines.dsh` SemVer 范围 | 避免插件被安装到不兼容宿主 |
| 本地 tarball | `pnpm pack` 后可通过 `dsh plugin add ./<package>.tgz` 安装预构建产物 | 首版无需发布 npm，也无需 Git 安装构建授权 |
| Agent 输入 | 创建／恢复 Agent，通过 `followup()` 投递输入 | 手机聊天可复用 dsh Agent Loop |
| 实时输出 | 监听 `agent/assistant-stream` | 实现流式文字回复 |
| 持久事件 | 监听 `session/event`；Session 日志是模型上下文来源 | 用于完成状态、恢复与审计 |
| Remote API | `@Remote` 支持一元方法，`mode: 'stream'` 支持双向流 | 可定义 Companion 业务接口 |
| HTTP／WebSocket | Remote 一元调用有 `POST /api/<namespace>/<method>` 桥；流使用 `/api/remote.mux` | 手机网络接入有现成基础 |
| 存储 | dsh Storage 提供 SQLite 后端，适合按行保存 JSON 文档 | 可评估保存人设、记忆和动态 |
| 定时任务 | Schedule 可向现有或新 Session 投递指令 | 可复用为主动行为触发器 |
| 记忆扩展 | 官方扩展手册建议“section 提供方 + 工具”；也可接入 MCP 记忆服务 | 记忆系统无需修改 Agent Loop |
| 模型提供方 | dsh 负责模型配置与适配 | 手机无需接触模型密钥 |

## 3. 推荐接入方式

### 3.1 一个 bundle，内部保持分层

首版交付一个 Companion bundle，但代码拆成：

- `core`：不依赖 dsh 的领域逻辑。
- `dsh-plugin`：Cordis 生命周期、Agent、Session、Storage 和 Remote API 适配。
- `protocol`：手机端与服务端共享的数据类型和事件版本。

这样仍符合“一次安装一个包”，同时避免以后无法替换宿主。

### 3.2 使用 web profile

首版在 Mac mini 的独立 web profile 中安装插件，原因：

- Web profile 自带服务器、Remote API 和 Schedule 等产品组合。
- `headless` 是一次性运行器，不适合长期手机服务。
- `sdk` 使用 stdio JSON-RPC，不适合作为手机直接连接的网络入口。
- 独立 profile 便于隔离插件依赖、配置和升级故障。

建议 profile 名：`companion`。实际创建和维护方式以安装时 CLI 输出为准。

### 3.3 bundle 最小形态

```text
companion-bundle/
├─ package.json
├─ cordis.patch.yml
└─ lib/
   └─ index.js
```

概念性 manifest：

```json
{
  "name": "dsh-companion-bot",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml"],
  "engines": {
    "dsh": ">=0.2.0 <0.3.0"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

上面的版本范围只是文档示例，编码前必须根据实际开发宿主版本重新确认，不应原样当作最终兼容声明。

概念性 patch：

```yaml
- insert:
    - id: companion
      name: dsh-companion-bot
```

概念性安装流程：

```sh
pnpm pack
# 将生成的 .tgz 复制到 Mac mini
dsh plugin --profile companion add ./dsh-companion-bot-0.1.0.tgz
dsh --profile companion --dump-config
```

实际包文件名以 `pnpm pack` 输出为准。安装后还需验证启动、日志、接口和卸载，不以 `add` 成功作为完成标准。

## 4. API 与事件策略

### 使用 Remote API 的部分

适合：

- 创建会话。
- 发送消息与取消。
- 获取人设、动态、记忆和健康状态。
- 修改受控配置。
- 需要标准取消与类型校验的单次动作。

### 需要独立领域事件协议的部分

官方 API Gateway 文档明确说明：会话事件、增量 reduce、projection 和实体子流不属于普通 Remote 方法描述符，即使复用同一 Connection，也应使用独立协议。

因此以下事件应定义 Companion 自有 envelope：

```json
{
  "eventId": "evt_...",
  "schemaVersion": 1,
  "type": "post.created",
  "occurredAt": "ISO-8601",
  "actor": "companion",
  "sessionId": null,
  "payload": {}
}
```

首版事件类型控制在：

- `message.delta`
- `message.completed`
- `message.failed`
- `post.created`
- `presence.changed`
- `task.updated`
- `capability.health.changed`

事件必须支持断线后的序列号或时间游标恢复；不能只依赖 WebSocket 永远在线。

## 5. 会话与记忆边界

- dsh Session 是模型所见上下文与原始会话事实的来源。
- Companion Memory 是角色长期领域状态，不复制完整 Session。
- 新增长期记忆时保留来源 Session／事件引用。
- 对模型可见的新增信息必须通过 dsh 支持的上下文路径进入，不能只写进外部数据库便假定模型知道。
- dsh 自带上下文压缩可继续使用；它不等于可查询、可纠正的长期记忆。
- 第三方记忆 MCP 可作为候选提供方，但首版不应为了使用 MCP 而放弃自己的来源、状态和权限模型。

## 6. Schedule 复用边界

可直接复用：

- 定时向角色会话投递“总结今天并考虑发布一条动态”等指令。
- 一次性或周期性唤醒角色。

不能假定：

- 投递成功等于模型任务完成。
- dsh Schedule 会替手机发送通知。
- 它会保存 Companion 所需的完整执行结果、重试和业务幂等状态。

因此，Schedule 是触发器，Companion Task Store 是执行真相。

## 7. 存储注意事项

官方 SQLite 后端：

- 使用 `node:sqlite` 同步驱动。
- 每个键对应一行 JSON 文档。
- 适合单进程、低到中等写入量的领域状态。
- 不负责跨进程写协调。
- 高频写入可能阻塞 JavaScript 事件循环。

首版可通过 Repository 接口复用；若动态复杂查询、媒体索引或游戏事件超出其适用边界，再切换插件自有数据库，不影响核心接口。

## 8. Tailscale 部署约束

dsh 官方 Web 部署文档要求：

- `--public-url` 只负责公告地址，不授予信任。
- 浏览器可见的 authority 还需通过 `--trusted-host` 接纳。
- 反向代理需要保留浏览器可见的 `Host`，并正确转发 WebSocket Upgrade。
- 打印的启动 URL 携带进程凭据，不应公开分享。
- 外部链路应使用 HTTPS。

Tailscale Serve 可将本地服务以 HTTPS 提供到 tailnet；本项目不使用 Funnel。原生 App 不必复刻浏览器 UI，但认证、Host 信任和 WebSocket 行为必须通过真实设备验证。

## 9. M0 技术验证清单

### 插件与包

- [ ] Mac mini 上记录 macOS、芯片、Node.js、pnpm、dsh 版本。
- [ ] 建立隔离的 `companion` profile，不污染日常 dsh 配置。
- [ ] 最小 `apply(ctx)` 插件成功加载并输出可识别日志。
- [ ] 配置 schema 的默认值、非法配置失败和 HMR 行为符合预期。
- [ ] `pnpm pack` 的 tarball 可在 Mac mini 安装、启动、升级和卸载。
- [ ] 不符合 `engines.dsh` 时能被明确拒绝。
- [ ] 插件卸载后计时器、连接和监听均被释放。

### Agent 与流

- [ ] 插件能创建并恢复指定 Session。
- [ ] `followup()` 能发送一条测试消息。
- [ ] 能收到实时 `agent/assistant-stream` 增量。
- [ ] 能收到对应持久 `session/event`，区分完成、失败和取消。
- [ ] dsh 重启后会话历史可恢复，不重复执行旧请求。

### Remote API 与手机

- [ ] 自定义一元方法可通过 HTTP 调用。
- [ ] 自定义流方法可通过 WebSocket 调用并取消。
- [ ] 非所有者或未认证请求不能调用业务接口。
- [ ] 原生 iOS／Android 客户端可完成认证，而不是只有浏览器可用。
- [ ] Tailscale Serve 下 Host、HTTPS、Cookie／Token 和 WebSocket 均正常。
- [ ] 断网重连后可通过游标补齐，不重复写入消息或动态。

### 数据与调度

- [ ] 人设和测试记忆重启后仍存在。
- [ ] 数据库备份与恢复流程实际执行一次。
- [ ] Schedule 触发后能关联到 Companion Task 的执行结果。
- [ ] 停机期间的调度行为符合文档和预期，不把投递记录当执行成功。

## 10. 尚未确认、不得提前假定的事项

1. 当前 dsh 版本是否提供适合第三方原生 App 的稳定认证方式。
2. 自定义 Remote 贡献在独立外部 bundle 中的完整构建与发布步骤是否无需调整 dsh Client assembly。
3. `/api/remote.mux` 是否适合作为手机长期领域事件通道，还是应另设只读事件 WebSocket。
4. 手机后台时 iOS／Android 对长连接和推送的限制下，是否需要额外通知服务。
5. TTS、实时音视频和 Minecraft 连接器的进程隔离程度。
6. Mac mini 的实际硬件能否同时承担 dsh、TTS、虚拟形象渲染和 Minecraft 服务端。

这些不是架构障碍，但必须在相应阶段用原型验证，不能写成已具备能力。

## 11. v0.1.1 本机实测记录

实现验证环境为本机 DSH `0.2.1-rc.5`、Node.js `22.23.1`、pnpm `10.33.2`，使用全新隔离 `companion` web profile，不读取或修改日常 DSH 数据。

### 已通过

- `pnpm typecheck`、`pnpm build` 与 `pnpm pack`，包内含宿主 ESM、浏览器 CJS、类型声明和 bundle patch。
- tarball 首次安装、`0.1.0 → 0.1.1` 升级、移除和重新安装；`--dump-config` 能确认插件条目按预期增删。
- 真实 DSH 浏览器中加载侧栏 Companion，打开总览、活动、任务、能力和角色设置页面，保存角色档案。
- 绑定真实根会话、跳转会话、重启后绑定恢复；未绑定、离线、空闲状态正确。
- 本机同源管理接口 `/companion/api/`；缺少 `x-companion-request: 1` 的请求返回 403。
- 健康与状态读取、任务创建、`accepted → running → succeeded`，以及终态退回 running 返回 409。
- 通过隔离本地 OpenAI 兼容模拟模型完成真实 Agent Loop：绑定会话后产生 `turn.started`、`assistant.completed`、`turn.completed`，记录输入 42、输出 1、总计 43 token。
- 无模型认证时，真实请求产生并记录 `turn.error(AUTH)`，没有伪造成功结果。
- 移除后重新安装，角色档案、历史活动、任务和 token 统计恢复。

### 验证中发现并修复

- 浏览器端最初误将 `@deepseek-ai/dsh-session` 作为运行时依赖，DSH 客户端模块表拒绝加载。改为纯类型引用并重新打包验证后恢复。
- 同版本 tarball 再次 `add` 可能只显示 `Already up to date` 而不替换文件。开发发布必须提升版本号；运行时版本号现直接读取包 `package.json`。
- 隔离 profile 会提示 DSH peer 包未在 profile 内重复安装；rc.5 宿主实际提供并解析这些包，真实启动和面板验证通过，不能只凭警告判断失败。

### 尚未验证

- 插件主动创建／恢复 Session 和发送 `followup()`；当前仅绑定现有根会话。
- 自定义 Remote API、`/api/remote.mux`、手机长期事件通道与断线游标。
- 原生 App 配对、Tailscale Serve、真实手机外网访问和后台推送。
- 数据库备份恢复、Schedule、长期驻留和 Mac mini 实机部署。
- 真实第三方模型账号链路；成功模型测试仅使用隔离本地模拟服务，不代表供应商兼容性验收。

## 12. v0.2.0 多场景与中央记忆实测记录

### 参考机制选择

- AIRI：场景与后台任务使用独立 Session、记忆索引加单条事实、遗忘 tombstone。
- Tobs / Hermes：少量核心锚点与冻结快照思路，详细内容按需检索，避免每轮全量注入。
- ECHO：来源与原始 Session 指针、唯一权威、可吊销索引。
- SurfCore：活跃记忆与全量修订分离、清晰度与召回、隐私 scope、低重要度遗忘。
- Mem0：按角色与场景过滤、写入后按需 search 的流程，作为后续语义 Provider 候选；本版未引入其运行时。
- Graphiti：事实来源与时间失效机制作为后续参考；本版不引入 Neo4j、嵌入模型或图数据库。

### 已通过

- 真实 v1 数据库迁移到 schema v2：原单绑定转成 `chat.main`，旧活动补全场景归属，记忆与修订表保留升级路径。
- 同一角色同时绑定 `chat.main` 与 `game.main` 两个不同根 Session，未合并上下文。
- 游戏场景通过真实 Agent 工具调用 `companion_memory_remember` 创建“用户喜欢白饭”共享记忆，来源记录为游戏场景及其 Session。
- 主聊天后续输入“白饭”，`agent/pre-step` 只注入匹配的共享记忆；`memory.recalled` 精确记录该记忆 ID，模拟模型请求也确认收到中央记忆内容。
- 场景私有检索隔离、共享记忆跨场景召回、候选不包含遗忘、低置信候选、修订历史、遗忘与恢复。
- 面板查看记忆和召回次数、设为长期锚点并生成第二条修订，重启后两个绑定、记忆、召回次数与修订均恢复。
- `pnpm typecheck`、宿主与浏览器构建、tarball 安装与真实面板使用通过。

### 当前边界

- 当前采用显式工具／面板写入与关键词召回，不自动把每次聊天提炼成记忆。
- 召回是关键词、重要度、置信度、时间和场景过滤的组合，不宣称语义检索质量；确有召回问题后再评估 embedding 或 Mem0。
- 低重要度且 60 天未召回的记忆只在用户主动“整理记忆”时遗忘，本版没有后台自动遗忘调度。
- 多 Session 是并行观察与记忆共享，不等于已经实现手机、游戏或任务的自动编排。
- 真实模型供应商、手机 Tailscale、Mac mini 实机、数据库备份恢复与长期驻留仍未验证。

## 13. v0.3.3 会话生命周期与实时事件实测记录

### 已通过

- `ctx.agents.create()` 分别创建聊天、游戏 Agent，并绑定不同长期 `contextId`；`ctx.agents.resume()` 在 DSH 重启后恢复同一 Session。
- `ctx.agentDefaultModel.currentSelection()` 提供与原生 Session 创建一致的模型，未在插件或手机协议中硬编码模型。
- `followup()` 发送真实用户消息，accepted 回执只表示进入队列；`message.delta` 收到 `O`、`K`，`message.completed` 返回 `OK`，usage 为 42/2/44。
- `deriveMessages()` 返回真实用户与助手历史，恢复后历史仍存在，恢复后再次发送成功。
- 延迟回复取消产生 `message.cancel.requested` 与 `turn.aborted`，不把取消误报为成功。
- WebSocket 回放包含 15 条持久活动，不包含瞬时 delta；最终文本通过历史对账，未认证握手返回 403。
- 真实面板“新建专用 Session”成功；空白 `sessionId` 会生成 UUID，场景恢复按钮可恢复离线绑定。

### 验证中发现并修复

- 首次程序化创建时未提供模型，宿主 `{{model}}` 人设变量渲染失败。已改为复用 `agentDefaultModel.currentSelection()`，与 DSH 原生流程一致。
- 留空新建时，空字符串先被服务生成逻辑、再被 HTTP schema 拒绝。已统一空白 ID 语义：留空即生成 UUID；两处均补充真实面板与 API 验收。
- `0.3.0 → 0.3.1 → 0.3.2 → 0.3.3` 均按版本升级安装，避免同版本 tarball 只显示 `Already up to date` 而未替换文件。

### 当前边界

- 当前 HTTP／WebSocket 使用 DSH 本机同源管理认证，未提供手机独立设备凭据，不能直接把该管理面开放到 Tailscale。
- 持久活动回放以 activity id 为 cursor；瞬时增量没有持久游标，客户端必须通过完成事件和历史确认最终内容。
- 已验证本地模拟模型，不代表真实供应商、原生 App、Tailscale、后台推送或 Mac mini 实机兼容性。
- 数据库备份恢复、长期驻留、设备撤销、限流和手机推送仍是 M0b2 工作。

## 14. v0.4.4 设备接入与备份恢复实测

### 已通过：独立设备边界

- schema v3 新增设备表；`WorkbenchView` 与设备健康响应的 `schemaVersion: 2` 是协议版本，不能与 SQLite schema v3 混为一谈。
- 配对链接 5 分钟有效、只能兑换一次，错误设备凭据返回 401，重复兑换同一配对码返回 401。
- 设备创建 Session、发送消息后收到 `O`、`K` 流式增量与最终 `OK`，历史包含真实用户与助手消息。
- 设备记录只保存 SHA-256 凭据哈希，列表不返回 `secretHash`；撤销立即终止 WebSocket（客户端观测 1006），后续认证返回 401。
- 管理 API 仍限本机同源；设备 API 不复用 DSH 启动令牌。管理页面可以生成候选 HTTPS 路由和本机调试路由。

### 已通过：含真实数据的全新 Home 恢复

在正常停止宿主后，以 Node 22 的 `node:sqlite` `backup()` 生成一致性备份，源数据库 `integrity_check` 为 `ok`，备份共 31 页。另保存停止后的 `$DSH_HOME/sessions` 与 `$DSH_HOME/storages`。将数据库与这些文件恢复到全新 DSH Home，并安装同一 `0.4.4` tarball，实测：

- 恢复 6 个场景绑定、1 条活跃共享记忆和 1 条记忆修订。
- 原 `chat.device` 的 2 条真实用户／助手消息可读取；设备凭据在新 Home 仍通过认证。
- WebSocket 回放 19 条持久活动，未伪造瞬时 delta。
- 恢复后的设备撤销生效，WebSocket 断开，健康检查返回 401，撤销时间保留。
- 管理接口设备列表不包含凭据哈希。

这证明 Companion 领域数据与上述 DSH Session 文件可以一起迁移，不证明 DSH 启动令牌、模型密钥或其他宿主配置可以省略。恢复后仍需重新配置这些宿主级凭据。

### 早期恢复演练使用的命令

日常升级使用含媒体、原生附件和旧安装包的 [离线快照流程](#85-离线升级与回退演练)。

先停止对应 DSH profile，并使用新的备份目录，避免覆盖上一份备份。以下变量必须替换为实际绝对路径；若 `dataDir` 已自定义，应替换 Companion 数据库路径。

```sh
export DSH_HOME=/absolute/path/to/dsh-home
export BACKUP_DIR=/absolute/path/to/new-backup
install -d -m 700 "$BACKUP_DIR"
node --input-type=module -e 'import { DatabaseSync, backup } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); await backup(db, process.argv[2]); db.close();' "$DSH_HOME/companion/companion.db" "$BACKUP_DIR/companion.db"
cp -R "$DSH_HOME/sessions" "$DSH_HOME/storages" "$BACKUP_DIR/"
chmod -R go-rwx "$BACKUP_DIR"
```

`backup()` 的结果已是独立数据库，不需要再同时复制其 WAL。不要在宿主仍在写入时直接复制数据库文件来代替一致性备份。恢复时先在新 Home 安装相同版本插件，再复制文件：

```sh
export NEW_DSH_HOME=/absolute/path/to/new-dsh-home
install -d -m 700 "$NEW_DSH_HOME/companion"
cp "$BACKUP_DIR/companion.db" "$NEW_DSH_HOME/companion/companion.db"
cp -R "$BACKUP_DIR/sessions" "$BACKUP_DIR/storages" "$NEW_DSH_HOME/"
```

### 原生工具链与尚未完成的验收

- Expo Web 导出通过；iOS 原生构建与安装通过。Xcode 27 使用 Device Hub，不再有旧的 `Simulator.app`。
- React Native 的两处 Hermes Node 路径需按 UTF-8 解码，否则 CocoaPods 的 `BINARY` 路径与 UTF-8 中文项目目录在命令拼接时冲突。项目以 `patches/react-native@0.88.1.patch` 和 pnpm lockfile 固定此修复，不修改全局依赖。
- iOS 配对输入曾受中文输入法候选文本影响；配对框已按平台改为 ASCII 键盘。iOS 的完整配对聊天尚未完成，不将构建成功等同于聊天验收。
- 用户实际使用安卓手机，后续原生验收以 Android 为优先。Android SDK、模拟器和原生工程已准备，配对聊天与独立 APK 的验证结果待补充。
- 当前 tailnet 未启用 Serve，未配置任何转发，也未启用 Funnel。Tailscale 应用在线不等于 Serve 已开启；HTTPS/WSS、真实安卓手机外网、真实模型供应商和 Mac mini 实机仍未验收。

## 15. v0.4.6 Android 原生与断线恢复实测

### Android 模拟器中的真实操作

验证环境为 Android 36 模拟器，Gradle 实际选择 buildTools 37、compileSdk 37、targetSdk 36；服务端为恢复 Home 中的 `0.4.6`，模型为隔离的本地 OpenAI 兼容模拟服务，不是实际供应商账号。

- 在 App 中粘贴一次性链接完成配对，创建 `chat.mobile` 并显示“已连接”；没有向 App 提供 DSH 启动令牌或模型密钥。
- 发送 `android-chat-1`，App 实际显示首个 `O`，宿主事件包含 `O`、`K` 增量，最终历史为 `OK`。
- 使用 10 秒延迟模型验证取消：收到 `message.cancel.requested` 和 `turn.aborted`，中断的 `O` 保留为部分回复，界面清除等待状态。
- 彻底停止并重新打开 App，SecureStore 中的设备凭据可加载，场景与旧聊天消息均恢复。
- 使用仅限回环地址的 TCP 代理同时暂停双向流量，模拟“TCP 未关闭但数据不再到达”。watchdog 约 28 秒触发并显示“重连中”，恢复代理后自动连接；历史没有重复。
- 撤销设备后收到关闭事件，健康检查返回 401，显示“已撤销”和“重新配对”。撤销是订阅的终止状态，不会被旧连接回调覆盖为重连；随后用新一次性链接重新配对成功。

### 发现并完成的真实修复

- `ping` 每 10 秒发送到每个连接，不携带场景数据，也不进入活动回放。初版误用场景广播过滤导致订阅场景的客户端收不到 ping，已改为逐连接保活。
- 客户端 25 秒未收到任何帧会关闭当前连接并启动恢复，健康检查 10 秒超时；撤销后清除重试，不再建立新连接。
- 旧 generation 的连接和迟到的回调会被忽略，避免网络失败与撤销竞争时覆盖状态。
- Android 键盘覆盖发送按钮的问题已修复。使用 Expo 58 清单支持的 `react-native-keyboard-controller@1.22.7`、`automaticOffset` 与 `react-native-safe-area-context`，不再依赖无效的标准避让方式；`react-native-reanimated@4.7.1` 作为直接依赖声明。
- 新增键盘原生模块后的 iOS 构建与安装复验通过；iOS 仍未完成完整配对聊天，不将其列为已验收平台。
- 独立 Android 包使用 `babel-preset-expo` 的标准 Babel 配置，release manifest 明确 `usesCleartextTraffic=false`。本机 ADB HTTP 只用于 debug，不能作为正式手机连接方案。

### 独立 APK 与真实网络

- 最新 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` 为 96,038,580 字节，包含默认四种 Android ABI 与 3,161,396 字节的内嵌 JS bundle；包名为 `ai.companion.bot.dev`。用户视频在 APK 中重命名为 `res/VC.mp4`，内容 SHA-256 与原素材完全一致；静态头像正常显示。
- 使用 `CN=Android Debug` 的开发签名，仅用于个人验收，不能视为正式分发签名。本次文件 SHA-256 为 `48146aecb38e09a40adfd9e2a06603feeaf6a737d6a5decb2c5f49620631bd19`。
- 关闭 Metro 后安装该 release，能进入场景页，并可通过“更换 Host”进入配对页，证明无需开发服务器即可启动。release manifest 明确拒绝明文 HTTP，本机 HTTP 连接按预期被网络安全策略拒绝；这不算 HTTPS 聊天验收。
- Tailscale Serve 在当前 tailnet 仍未启用，未使用 Funnel；真实安卓手机外网、真实模型供应商和 Mac mini 实机部署仍待完成。

## 16. v0.4.6 第一版深色工程骨架（外观方向已否决）

曾以用户提供的 X 录屏为参考，在 1080×2400、420dpi 的 Android 模拟器上实际操作第一版界面。用户随后明确：主要界面不要黑色，只希望参考丝滑动效。因此本节仅保留初版链路与问题记录，不把深色外观作为交付方向：

- 场景页采用黑色单列时间线、细分隔线、角色占位头像、在线／离线文字、底部场景／聊天／设置导航和右侧蓝色主操作按钮。
- 通过真实设备配对创建 `chat.mobile`，发送 `android-chat-1` 后收到完整 `OK`；键盘弹出时输入框、取消和发送均保持可见。
- 横向抽屉可打开，展示真实人设名称、简介与场景入口；可通过遮罩、Android 返回或明确关闭按钮退出。没有为未实现的动态、TTS、视频或 Minecraft 放置虚假功能按钮。
- 聊天页保留原有流式、取消、撤销和恢复逻辑，使用深色左右气泡；调整了用户气泡的标签对比度和按钮点击区域。
- 开启 Android 减少动态效果后，抽屉仍能正常打开和关闭。装饰性位移动画与模态淡入均会降级，后台轮询不会重放场景入场动画。

当时角色正式头像、动态 Feed、完整动效细节和最新 iOS 界面仍需后续验收。Expo 开发菜单及其右上 Tools 悬浮齿轮属于 `expo-dev-menu` 的 debug 实现，不是产品的设置按钮；独立 release 另做无 Metro 启动检查。release 继续禁止明文 HTTP，本机模拟模型不用于证明 HTTPS 手机链路通过。

## 17. 浅色动效与用户动态形象验收

用户明确纠正“参考 Twitter”的方向后，主要界面已改为白色与浅蓝色，而不是黑色。参考 Bluesky 的导航层级与 AIRI 的角色空间、紧凑输入区，保留单一 Expo 运行时，没有复制其品牌素材或引入第二套 UI 框架。

- 角色区突出真实人设、场景数与中央记忆数，主聊天为明确主操作。预览库通过管理 API 写入用户明确提供的“爱吃白饭”偏好，界面实际显示 1 条活跃记忆，不是写死的展示数字。
- 使用 `expo-video@58.0.13` 播放用户指定的 `whale.mp4`。只给角色区创建一个静音循环播放器，小头像使用 `whale.png`；播放器随页面焦点与 `AppState` 暂停，不请求摄像头或录音权限。原视频副本与源文件 SHA-256 相同，release 中的 `res/VC.mp4` 内容哈希也一致。
- 通过 `screenrecord` 对角色区域连续采样，确认睁眼、闭眼等真实帧变化。React Native Android 源码实际读取 `TRANSITION_ANIMATION_SCALE`；设为 0 后动态形象标签消失、连续帧差异为 0，使用静态图。测试后已恢复 1.0，并清除无效的自定义测试键。
- 原生 Stack 页面转场、角色与消息入场、Reanimated 按压反馈和抽屉均有减少动态效果回退。原生检查没有声称完成帧率或真实手机功耗测量。
- `android-light-1`、`android-light-2` 均返回最终 `OK` 并写入持久历史；键盘弹出时输入和发送可用，最新回复完整位于输入区上方。蓝色用户气泡使用白字，修复了浅色切换后的对比度问题。
- 浅色配对页、设置抽屉、Android 返回关闭和重新配对均已实测。独立 release 在关闭 Metro 后可启动并显示静态头像，还能进入配对页；本机 HTTP 被正确拒绝并显示可理解的提示，不将此当成 HTTPS 聊天通过。

工程上，DSH 面板的 React 18 类型与手机的 React 19 类型分离在 `apps/mobile/tsconfig.typecheck.json`，Metro 仍解析真实 `react` 包，避免类型路径污染运行时。`pnpm check`、Expo 依赖兼容检查与 Web 导出均通过；导出只包含实际使用的 Ionicons 字体、角色视频及静态帧。

最新 iOS 浅色和 `expo-video` 原生组件尚未复验。真实安卓手机、Tailscale HTTPS/WSS、真实模型供应商和 Mac mini 实机部署仍待完成；动态 Feed、TTS、实时视频通话和 Minecraft 不在本轮完成范围内。

## 18. Mac mini 实机部署进度

本节记录真实环境，不把本机模拟器结果当成 Mac mini 部署结果。

### 已确认的环境与安全边界

- 通过 Tailscale 可直接连接 `filisi@100.99.51.86`。目标机为 Apple Silicon、macOS 27.2，现有用户级 Node 为 24.22.2。
- 短主机名没有对应的 known_hosts 记录，但目标 IP 的 ED25519 指纹 `SHA256:U0cEMsiD5giZKGkzvA20aJ7xuqMgNZZe0AZ0fAy9BuY` 与既有记录及当前主机密钥一致。后续连接使用 IP、`filisi` 用户和 `StrictHostKeyChecking=yes`，没有关闭主机校验、读取私钥或覆盖 known_hosts。
- 原 `desktop` profile 使用 DSH `0.2.1-rc.5`，已有服务监听 `127.0.0.1:18787`。它包含其他聊天插件，未修改、停止或向 Tailscale 暴露该服务。Companion 使用独立 profile 和端口。
- `$DSH_HOME/.credentials.yaml` 存在，但未读取其内容。后续通过 DSH 的默认模型选择完成了真实模型请求，未把模型密钥写入插件或 App。
- 插件包已上传到 `/Users/filisi/.local/share/companion/dsh-companion-bot-0.4.6.tgz`，远端与本地 SHA-256 都是 `421db5d87010b9eda4b58d59b693c53b9bca6ec80de4103afd9e28d0281c1e80`。

### Tailscale Serve

Mac mini 上没有原 Serve 配置。经用户在 Tailscale 官方页面完成授权后，已添加且仅添加以下私网转发：

```text
https://filisimac-mini.tail7af395.ts.net/ → http://127.0.0.1:18788
```

未使用 Funnel。启动 Companion 前，从当前电脑访问该 HTTPS 地址返回 502，证明 HTTPS 握手和 Serve 转发已到达尚未启动的后端，不证明 DSH 已启动或聊天已可用。

### Mac mini 安装与真实模型验收（已完成）

- DSH `0.2.1-rc.5` 与 pnpm `10.33.2` 安装于 `/Users/filisi/.local/share/companion/runtime`，与原桌面运行时分离。`koffi` 和 `node-pty` 的原生加载检查通过；只给所需的 DSH 官方构建脚本补充了单次许可，没有放开所有第三方脚本。
- 已创建 `$DSH_HOME/profiles/companion`，安装上述 SHA-256 的 `0.4.6` 插件。通过 `~/Library/LaunchAgents/ai.companion.bot.dsh.plist` 启动 `ai.companion.bot.dsh`，`RunAtLoad=true`，异常退出时按节流间隔重启。日志文件权限为 600，未向手机提供启动令牌。
- 本机 `/companion/api/health` 返回 `ok: true`、`schemaVersion: 2`、`pluginVersion: 0.4.6`。Tailscale 未认证设备健康请求返回 401，远程 Companion 管理请求返回 403；无效 WebSocket 握手按现有协议返回 403。
- 有效设备凭据的 WSS 连接已收到 `stream.ready` 和 `stream.replay.complete`。最终自检等待回放完成和 `turn.completed`，并确认本次请求的新助手消息已持久化，未把中间助手事件当成回合完成。
- 真实模型请求收到文本增量，最终回复包括“你好呀～我是小鲸鱼，一条爱吃白饭的蓝色大肥鱼，正陪着你一起聊天、干活。”以及“我最喜欢吃白米饭啦，尤其喜欢用铁盆盛着吃～”。这验证了真实模型、流式消息、人设与历史记录，不是本机模拟模型的固定 `OK`。未读取模型凭据，也未对具体供应商名称作未经核实的额外断言。
- 自检使用的临时设备均已撤销，未在项目或日志中打印配对码和设备密钥。

npm 项目级配置曾把 registry 和代理指向 `registry.npmmirror.com` 与不可用的 `127.0.0.1:7897`。安装最终从独立目录使用临时 registry 配置和直连镜像完成，没有修改用户原有的全局或项目配置。`dsh plugin add` 使用 pnpm 的临时配置覆盖参数完成，未扩大权限。

### 真实安卓接入（待手机操作）

- 当前 tailnet 中未发现安卓设备，也没有 ADB 连接。需要在手机上安装 APK 和 Tailscale，并加入同一账号后，再生成新的 5 分钟一次性配对链接。
- APK 使用开发签名，只用于个人验收。真实手机的配对、动态头像、聊天、断线恢复和功耗仍待实际验证；最新 iOS 也尚未复验。


## 19. v0.6.1 Mac mini 本地语音与安装升级验收

### 实际部署与数据保留

- Companion `0.6.1` 已在独立 profile 和 `ai.companion.bot.dsh` 用户服务中运行，管理健康检查仍返回 `schemaVersion: 2`。Companion SQLite 已迁移到 schema v5，与 API v2 不是同一个版本号。
- 真实数据库是 `$HOME/.dsh/companion/companion.db`，插件管理目录则是 `$HOME/.dsh/profiles/companion`；不能把后者直接当作 `DSH_HOME`。原 `desktop` 服务和 18787 未修改或暴露。
- 升级前成功备份至 `/Users/filisi/.local/share/companion/backups/20261107-125117-tts`（schema v4）和 `/Users/filisi/.local/share/companion/backups/20261107-130524-tts-fix`（schema v5），源库 `integrity_check` 均为 `ok`，并保存了 DSH sessions 与 storages。
- 升级后数据库 `integrity_check=ok`，保留 2 个场景绑定、2 条有效设备记录、1 条活跃记忆和 7 条未删除动态／回复。未重新生成配对码，未读取或复制设备明文、模型密钥、DSH 启动令牌或 SSH 私钥。
- 服务使用 `launchctl bootout` 卸载、`launchctl bootstrap` 恢复。卸载后立即 bootstrap 曾遇到一次 5 号错误，随后确认标签已卸载再启动成功；升级流程必须包含服务恢复，不能只安装后离开停止状态。
- DSH 的包管理器会保留旧 tarball 的文件引用。之前删除 `/tmp` 中旧包导致下一次安装出现 ENOENT，因此现保留在 `/Users/filisi/.local/share/companion/packages/`，当前依赖指向同目录的 `dsh-companion-bot-0.6.1.tgz`，不再依赖会被清理的临时路径。

### Piper 与真实消息语音

- Piper `1.8.0` 与 ONNX Runtime `1.31.1` 安装于 `~/.local/share/companion/tts/venv`，不进入系统 Python。模型和配置位于 `~/.local/share/companion/tts/models/`，模型哈希和来源见 `docs/references.md`。
- 先以独立 worker 实际生成 4.296 秒中文 WAV：22,050Hz、单声道、16 位 PCM，RMS 为 5886.83，存在有效声音信号。模型与配置必须使用相同的 `zh_CN-huayan-medium` 基名，临时下载文件名不能直接作为加载路径。
- 插件内的 `TtsService` 使用同一持久助手消息创建任务，经过 `accepted → running → succeeded`，生成 653,356 字节、14.814 秒的 WAV。重复请求返回同一任务和缓存，没有重复合成。
- 鉴权音频请求 `Range: bytes=0-11` 返回 206 和正确的 Content-Range；未认证设备音频请求返回 401。媒体文件权限为 600，响应不暴露服务器文件路径。
- 首次接入时遇到 `NOT NULL constraint failed: task.updated_at`。实际表结构和输入参数均已检查，改为显式列名的 INSERT 后，全新临时数据库的真实任务创建和 Mac mini 上的真实语音任务均通过；没有重建或清空用户数据库。之前关于列顺序的初步猜测未被证实，不作为最终原因记录。

### 手机交付边界

- `expo-audio@58.0.11` 已安装，Expo Android autolinking 确认包含 `expo-audio` 与 `expo-video`。APK 内嵌 Hermes bundle 中确认了“听语音”“正在生成”等控件文本和鉴权音频路径；中文文本在 Hermes 中以 UTF-16LE 存储，不以 UTF-8 字节搜索失败来误判缺失。
- 安卓 `0.3.0`（versionCode 3）release 构建通过，应用名“小鲸鱼”，包名仍为 `ai.companion.bot.dev`，使用 Android Debug 签名。没有声明 RECORD_AUDIO；已关闭后台录音与后台播放。
- 当前没有 ADB 连接的真实手机可供代为试听。**构建、autolinking 和 Mac mini 的真实音频验收，不等于已在用户手机上实际听到声音。** 需要在已配对手机安装新版后，点击一条助手消息的“听语音”，检查实际播放、暂停、重播、断线恢复和历史不重复。
- 当前没有自动朗读、主动发帖节律、视频通话、实时口型或 Minecraft 接入。媒体清理界面、真实手机功耗和长期声线体验仍属后续工作。华炎模型卡片的数据集许可证为 Unknown，目前只用于个人本地 Bot。

## 20. v0.7.0 GPT-SoVITS v5 turbo 与大肥鱼声线

用户明确调整了方向：不再以 Piper 为正式声线，复用本地二创工作流中的 GPT-SoVITS v5 turbo 和大肥鱼音频。此前的“暂停 TTS”不是取消语音功能；本版同时包含基础聊天、动态、连接修复和语音，没有单独制作无语音版本。

### 独立运行时与素材迁移

- Mac mini 使用独立目录 `/Users/filisi/.local/share/companion/gsv/`，Python `3.10.20`、torch `2.14.1`、torchaudio `2.11.0`，MPS 可用，推理为全精度。未修改 `/Users/thysummer/工作流/二创` 中的原工程，也未进入系统 Python。
- 源码来自本地 GPT-SoVITS 当前源码快照，保留已有的音频读取兼容处理。`api.py` 另增加 `/companion-health`，并在读取参考音频时使用已有的 soundfile 回退，避免额外引入 TorchCodec。
- 已迁移 turbo、vocoder、s1v3、中文 BERT、HuBERT、G2PW 和大肥鱼参考音频。turbo 与 vocoder 的 SHA-256 与当前模型仓库 LFS 记录一致，详见 `docs/references.md`。
- 初次合成发现 `torchcodec` 和 `fast_langdetect` 缺失。前者由 soundfile 回退解决，后者补齐已有的 `pretrained_models/fast_langdetect/lid.176.bin`，没有从不明来源下载替代文件。
- 服务由 `ai.companion.bot.gsv` LaunchAgent 管理，只监听 `127.0.0.1:9881`，启用离线模型加载环境。其原生模型管理接口不向 Tailscale 或手机开放；Companion 使用固定参考音频、配套文本和语言，不允许客户端传服务器路径或任意切换模型。

### 真实生成与 Companion 联调

- 独立服务实际生成一句中文：48kHz、单声道、4.32 秒、414,764 字节，RMS 3324.86、峰值 21651。请求耗时约 8.94 秒，服务 RSS 约 2,000,240KiB。这里证明真实生成，不把视频中的 NVIDIA 性能当作本机速度；首次合成仍需等待。
- 测试音频已设权限 600，并复制到本机 `/tmp/大肥鱼-v5turbo-试听.wav`，供用户直接比较声线；没有仅凭波形或文件名宣称主观音色已获用户确认。
- Companion `0.7.0` 默认 `ttsProvider=gpt-sovits`，通过回环 HTTP 请求 Provider；固定 `voice=deepseek-whale-v5turbo`，不会复用 Piper 的消息缓存。旧 worker 仅作历史 Provider 保留。
- 一条来自 `chat.mobile` 持久历史的真实助手消息，经 `accepted → running → succeeded` 生成 15.64 秒、1,501,484 字节的 WAV，端到端任务耗时约 8.69 秒。重复请求复用同一任务；音频 Range 请求返回 206，无设备凭据的请求返回 401，媒体权限为 600。
- 最新 `tts_asset.voice` 已核实为 `deepseek-whale-v5turbo`，Companion 数据库 `integrity_check=ok`。升级前备份位于 `/Users/filisi/.local/share/companion/backups/20261107-144036-gsv`，包括领域数据库、DSH sessions、storages 和已有媒体。
- 手机 `0.4.0` 恢复按需语音按钮，并同时修复回复展开后刷新、旧历史请求覆盖、流式轮次区分、状态请求合并、回前台重连和重复打开 Session 的加载状态。APK 为 `/tmp/小鲸鱼-0.4.0.apk`，96,698,513 字节，SHA-256 `efabcf29f5dadad7f0d97fa46bdd4c785c5797b3328cfbfee808f2b2755ac0ad`。包名和开发签名保持不变，没有麦克风权限。

### 尚未完成

- 当前没有可代为操作的真实手机 ADB 连接。服务端真实生成、鉴权读取、APK 构建和包内检查，不等于用户已在手机上听到声音。需要安装 `0.4.0` 后实际试听、暂停／重播，并复验动态及断线恢复。
- Drama3 只完成选型与本地 16GB 可行性调研，未安装或接入。实时性、声线主观满意度、长期资源占用和媒体清理仍需分别验收，不在本版提前宣称完成。

## 21. v0.8.0 自主角色内核与真实记忆闭环

### 已落地的地基

- 新增 SQLite schema v6 和 `autonomous_job`：每个自主任务都有场景、类型、去重键、计划执行时间、结构化负载、尝试次数和执行租约。与现有 Task 共用真实状态机，支持 `running → accepted` 重试和重启恢复。
- `AutonomyService` 复用 DSH Agent 和 Session，不引入第二套 Agent Loop。按场景接收完成事件，同时只执行一个自主分析任务，支持超时、失败重试、暂停和取消。
- `memory.curator` 是独立记忆分析 Session。它接收有限的真实最近交互与已有相关记忆，输出受 Zod 校验的 JSON；最多 3 条，强制候选状态，confidence 不超过 0.79，来源包含目标场景和事件序号。
- 原场景工具权限没有放开：记忆整理 Session 不能通过工具直接改写中央记忆或发布动态，只有宿主校验结构化结果后才能写入。相同规范化内容不重复插入，遗忘记忆也不会被自动重建。
- 自主动态使用另一 Session，默认关闭。启用后仍需通过最小间隔、免打扰、真实活动门槛和模型判断，不接受任意自主提示词。
- 新增本机管理 API `GET/PUT /companion/api/autonomy` 与 `POST /companion/api/autonomy/jobs`，以及工作台“自主节律”页。开关、时间、队列、尝试次数和最近决策均来自真实状态。

### 真实执行结果

- 第一次真实 Agent 分析判断最近交互没有值得新增的长期事实，任务以 `cancelled` 结束并明确原因，没有为了演示强行写入记忆。
- 创建一个延迟任务后暂停并重启 Companion，任务仍以 `accepted` 保留且未执行。随后通过现有 Task 接口取消，恢复 `enabled=true`、`reviewDelaySec=90` 和 `feedEnabled=false`。没有额外产生模型调用。
- 使用一条与项目目标一致的真实长期要求进行一轮真实对话后，自动产生 `chat.mobile:78` 对应的记忆任务，而不是通过手动按钮触发。该任务从 `accepted → running → succeeded`，真实 Agent 输出 1 条候选记忆：
  - 类型为 `preference`，场景为 `chat.mobile`，scope 为 `shared`，confidence 为 0.7，sourceRefs 包含真实 Session 与 `eventSeq: 78`。
  - 内容表达只保留重要事实、不囤积闲聊与临时安排，并在之后主动接续旧话题。它是待用户确认的候选，没有自动进入活跃记忆或召回。
- 在同一真实对话中，普通助手也通过既有受控 `companion_memory_remember` 工具记录了一条长期目标，confidence 为 0.9。这与自主分析产生的候选是不同来源，不能混称“自主任务自动激活了记忆”。当前活跃记忆包含原有偏好和这条长期目标，候选另计。
- `lastDecision` 为“整理出 1 条候选记忆”，数据库 `integrity_check=ok`、schema v6，GPT-SoVITS 继续为 ready，原有设备、动态和聊天能力未回归。
- 升级前备份位于 `/Users/filisi/.local/share/companion/backups/20261107-153409-autonomy`，包含数据库、DSH sessions、storages 和媒体。

### 与 AIRI 的对照及未完成边界

已具备对应的地基机制：场景隔离、事件队列与处理锁、结构化自主分析、独立后台任务、有限历史、记忆候选与遗忘、持久恢复、受控节律和单一角色核心。这些能力已通过真实模型和真实事件验证，而不是仅有类名或页面。

仍不能宣称达到 AIRI 全量完成度：实时形象与舞台、Minecraft／视频等世界感知、更多技能生态、长期主动生活与多模态互动尚未完成。下一步应优先完善角色世界状态和受控技能执行，再接游戏、实时形象和其他 Provider，不继续只增加静态面板。

工作台浏览器访问需要 DSH 官方登录。尝试通过本地 SSH 转发访问时返回 `dsh web authentication required; reopen the URL printed by dsh web.`，未读取或绕过启动令牌，未把管理 API 正常等同于浏览器视觉验收。可在 Mac mini 上通过 DSH 官方输出地址进入“自主节律”页复验。

## 22. v0.9.2 角色生活基础与真实 Live2D 验收

### 部署、迁移与回退

- 正式版本为 Companion `0.9.2`，运行在原独立 Companion profile 和 `ai.companion.bot.dsh` 用户服务中；原 `desktop` 服务和 GPT-SoVITS LaunchAgent 未改动。
- 安装包位于 `/Users/filisi/.local/share/companion/packages/dsh-companion-bot-0.9.2.tgz`，本机 `/tmp/dsh-companion-bot-0.9.2.tgz` 与其 SHA-256 一致：`72845692f916b4ec02af1f56867260d6c012df9dfcf786d3f8931f78f01c2170`。包内 18 个文件，开源舞台与许可齐全，不包含模型、贴图、PSD、模型参数配置或 Cubism Core。
- 升级前一致性备份为 `/Users/filisi/.local/share/companion/backups/20261107-190251-m3a`，包含 Companion DB、DSH sessions、storages 和旧 `0.8.0` 安装包，备份数据库 `integrity_check=ok`。
- schema 6 原地迁移到 schema 8，`integrity_check=ok`。升级和真实验收后保留 2 个有效设备、2 条活跃记忆、11 条未删除动态／回复和 4 个场景绑定；新增动态／回复明确标为联调测试。自我笔记接口的临时测试项已归档，不冒充主人偏好。
- 同版本再次安装曾返回 `Already up to date` 并保留旧文件。舞台静态路径改为通过 `dsh-companion-bot/package.json` 定位，最终使用 `lib/avatar`；补丁版本用于确保新代码被实际安装。该问题已记录为安装纪律，不用手工修改安装目录代替交付。

### 动态回应、记忆与工具索引

- 真实用户动态生成 `feed.reply` 任务，使用独立线程 Session，经过延迟、真实 Agent 和 Feed 工具后生成实际回复，最终任务为 `succeeded`，不是固定文本或仅入队。
- 后续动态回复使用真实 Avatar 能力视图，正确说明“脸红（2.4 秒）”和“抬手示意（1.25 秒）”是配置而非已执行动作，舞台未连接时也明确未看到画面。自主动态 `feedEnabled=false` 未被打开，互动回应 `feedRepliesEnabled=true` 独立工作。
- `AutonomyService` 仍只同时执行一个分析任务，成功动态会进入后续候选记忆整理。聊天后的真实记忆任务最终为 `succeeded`；自主动态未开启。
- 实际生成 2 条自我观察：分别来自 `chat.mobile` 和动态线程，均为 `inference`，confidence 分别为 0.55 和 0.6，带真实事件、Session、任务和原文证据。它们没有被当作不可修改的人设或真实行为证明。
- 自我笔记另有真实 API 的修订、归档、回滚验证；本地验证覆盖 40 条有效项上限、归档保留历史和伪造原文证据拒绝。工具策略在 Session 创建／恢复 setup 中生效：普通聊天／游戏 4 个记忆工具与 2 个形象动作工具，动态线程 2 个动态工具，记忆整理不注入这些工具；未把该机制夸大为固定 token 节省。

### 正式 DSH Live2D 舞台

- 私有模型位于 `/Users/filisi/.local/share/companion/avatar/model/`，`.moc3` 的 SHA-256 为 `b708e7953db9deeb5bf783643255dee1f3bf20d24786bc287e72d07e1b1052e6`。官方 Core 位于私有 `vendor/`，哈希与 `docs/references.md` 的官方来源记录一致；原使用须知和作者署名保留。
- Mac mini 的 Chrome 已实际加载标准模型，报告 Apple M6 Metal、509 个运行时参数、0 个异常参数。不是使用 YSM 资源、静态帧或另一台机器的结果替代验收。
- 在正式 `http://127.0.0.1:18788/companion/avatar/` 页面中，宿主通过心跳下发动作，抬手示意实际执行并以 `succeeded` 结束；脸红中途请求停止后，舞台实际停止并以 `cancelled` 结束。截图留存为本机 `/tmp/companion-dsh-avatar-action.png`，不进入插件包。
- 舞台动作采用 allowlist，拒绝未真实就绪的任务；停止请求经 `stopRequestIds` 传到舞台，只有真实回执才结算。未认证管理 API 与跨站模型读取返回 403，编码目录逃逸返回 404。模型与 Core 不随插件重新分发。
- 当前只完成基础加载、自然待机、受限表情／动作与真实回执。实时口型、完整动作编排、自主表演、手机 Live2D 和实时视频通话尚未接入；工作台官方登录态视觉验收仍需通过 DSH 官方地址完成。

### 真实聊天、语音与媒体

- 使用 `chat.mobile` 的真实模型完成一轮新聊天，随后从该真实助手消息合成语音。任务 `0e6cf243-a49a-473d-a00c-b4f10af11bfb` 成功，音频为 7.84 秒、752,684 字节；Range 请求返回 206，前四个字节为 `RIFF`，新媒体文件已登记真实哈希。
- `media.tts` 继续为 `ready`，使用 GPT-SoVITS v5 turbo 与大肥鱼声线。媒体清单验收时为 3 个语音文件、2,907,524 字节、0 个缺失文件，清理预览没有删除文件；模型、原始素材、记忆和备份不在清理范围内。
- 最终健康检查为 `pluginVersion=0.9.2`、`presence=idle`、自主队列 `pending=0, running=0`，GPT-SoVITS 正常，数据库 `integrity_check=ok`、`user_version=8`。真实模型的台词不作为记忆或执行成功的证明，均另行核对持久任务和文件。
- 真实手机试听、断线恢复和新版动态视觉仍需用户设备验收。当前没有可用 ADB 设备，不把服务端生成、Range 读取或 APK 构建等同于手机实际听到声音。Minecraft、实时口型、歌唱和完整 AIRI 能力仍未交付，下一阶段按路线进入 Coopcraft 实际连接。


## 23. v0.11.4 Minecraft 基础闭环、跨场景记忆与语音复验

### 部署、备份与源码交付

- 正式 Companion 已升级到 `0.11.4`，运行在原独立 profile 与 `ai.companion.bot.dsh` 用户服务中；原 `desktop` 服务和 Tailscale 配置未改动。最终安装包 SHA-256 为 `f99f9fa669b30e6eb4ed501ed63dba033106a5c582c136c5edb66a66b4dd335e`。
- 升级前备份位于 `/Users/filisi/.local/share/companion/backups/20261108-115053-m3b`，包含 Companion DB、DSH sessions、storages、语音媒体与旧 `0.10.1` 安装包。备份数据库和最终运行数据库均为 `integrity_check=ok`，最终 schema 仍为 v8。
- Coopcraft 使用 Carpet fake player＋CBI＋私有 FIFO，未新增微软账号、RCON、OP 或公网端口。最终 CBI JAR SHA-256 为 `a0c9fef38595e9799b4b292368467c9e930df983ba0d4e009a84a561033ec73f`。
- 完整对应源码保存在本机 `建设bot参考/CarpetBaritoneIntegration-companion-20261108.tar.gz` 和 Mac mini `~/.local/share/companion/minecraft/source/`，SHA-256 为 `4327d41d59ae4e611134ef8afbc1949f68cbb954533dbc5015febbfb6445f8ef`。许可声明差异与源码交付方式见 `docs/references.md`。

### CBI 与 worker 的实际修复

- 执行阶段原先误用后台寻路的快照视图检查区块，导致假人在边界反复清空输入。现在执行阶段读取权威 `ServerLevel`，只在当前路径段需要时加载目标区块；fresh restart 后同一导航也已完成。
- `find` 使用明确的“查找完成＋数量”回执，不再把任意 `[CBI]` 行当成列表结束。邻近扫描最多覆盖角色周围 5×5 区块，并合并缓存索引；worker 不再依赖固定 1.8 秒等待异步扫描。
- 自然原木候选限制水平 24 格、垂直 8 格，优先接近当前高度；必须存在六格内同树种 `persistent=false` 树叶证据。候选接受、拒绝和证据坐标进入 worker 事件。
- 首次成功后，剩余原木距离旧移动终点约 24.3／25.5 格，`safe-natural-log-not-found` 是正确的范围保护，不应通过扩大权限绕过。改为先合法移动到 `(-158,66,-86)` 后，正式采集成功。
- 服务器重启与假人离线会取消旧动作并清空旧观察；假人在停止期间死亡时，下线接口识别“只能操作现存玩家”并再次确认实体不存在。背包没有实际增加时，拆方块也不会被记为采集成功。
- worker 事件现在同时保留领域 `kind=action.*` 与 `action=move/dig`，不再让动作名覆盖事件类型。

### 真实任务与跨场景记忆

- 正式 `minecraft.move` 任务到达目标区域；随后 `minecraft.dig` 选中低处 `(-155,66,-65)` 橡木，以 `(-157,71,-69)` 的同树种自然树叶为证据。方块消失且背包实际增加 2 个橡木，最终背包为 3 个；不是仅收到规划或控制台文本。
- `minecraft.dig` 任务 ID `fe791bf5-b178-4df1-bcc8-1b14047090cc` 为 `succeeded`，停止位移为 0，假人随后安全下线。移动与采集均生成 `shared / active` 经历记忆，来源指向独立 `game.minecraft` Session 与对应任务。
- 在独立 `chat.mobile` Session 中询问这次采集，真实助手消息 `c77fbd74-a252-4d3b-baf1-b76da20a385c` 回复“橡木（oak_log）。”。这验证跨场景共享记忆，不需要把游戏 Session 全文复制到主聊天。
- 最终 `0.11.4` 又完成一次导航任务 `4f3a5886-1a3a-4b83-82d8-6d57be254493` 和停止任务 `32d31d55-d942-48a1-ac8e-dc4b334120ef`，两者均为 `succeeded`，停止位移为 0；审计事件 `action.started/finished/stopped` 类型正确。
- 测试中曾发生真实僵尸击退、饥饿下降和死亡。失败任务、停止受阻与死亡没有伪装成成功，没有用创造模式、无敌效果或修改世界时间规避。

### 混写文本语音与 NLTK 运行资源

- 含 `oak_log` 的真实助手消息首次合成失败，日志确认是英文 G2P 缺少 NLTK `cmudict`，不是模型或参考声线损坏。
- Mac mini 的官方 NLTK 下载链路被连接重置后，复用原二创工程 `.venv/nltk_data` 已有的 `cmudict`、`averaged_perceptron_tagger` 和 `averaged_perceptron_tagger_eng` ZIP。ZIP 完整性、解压后的资源查找和 `pos_tag(['oak','log'])` 均通过。
- 数据位于 `~/.local/share/companion/gsv/nltk_data/`，GSV LaunchAgent 以 `NLTK_DATA` 指向该目录；系统 Python 和原二创工程未修改，GSV 仍只监听 `127.0.0.1:9881`。
- 最终语音任务 `d895ea18-785b-425f-83a8-66f93592cd56` 为 `succeeded`，音频 115,244 字节、1.2 秒。鉴权 Range 返回 206、`Content-Range: bytes 0-11/115244`，前四字节为 `RIFF`。

### 尚未完成

- 主人当前未在线，因此 `mc_chat` 正向私聊和 `mc_follow` 持续跟随仍需主人在 Coopcraft 中验收；现有拒绝离线主人的负向测试不能代替正向验收。
- 服务端生成与读取 WAV 不等于手机实际听到声音。真实安卓手机还需复验播放、暂停、重播、新版动态与断线恢复。
- 战斗、合成、建造、长期无人值守生存、实时口型、可打断语音、歌唱、B站、手机高级媒体和小家仍未交付；自主动态保持默认关闭，媒体清理仍为预览，不自动删除文件。


## 24. v0.12.0 生存反射与回程资源开发候选

本节只记录实现和自动化验证。候选尚未部署到正式 Coopcraft，正式环境仍运行 `0.11.4`；主人在线、手机与实战验收按当前安排暂缓。

### 高频生存反射与模型分工

- `EmergencyAvoidanceController` 继续处理 TNT、苦力怕和普通敌对生物，并新增盾牌、火球与攻击冷却期行为。大模型只决定低频目标，不参与每 tick 的举盾、反击或退避。
- 有武器时在攻击距离和蓄力条件满足后攻击；冷却期且距离过近时面向目标后退，形成基础走 A。`CarpetInputController` 新增独立后退输入，不再只能转身逃跑。
- 有盾牌且尚未到攻击时机时装备副手盾牌并开始使用；攻击前停止举盾。没有武器时优先逃离，盾牌可用于退避防护。
- 对正在接近的 `Fireball` 预测最近距离，在真实攻击距离、蓄力和视线条件满足时调用正常 `player.attack(fireball)`，让 Minecraft 自身处理反弹，不伪造自定义火球轨迹。
- `autoEat` 仍只在没有威胁时执行。`mc_stop` 同时关闭战斗、紧急避险、自动进食和资源合成；新的明确动作才恢复，重连会重新应用完整安全配置。

### 资源账本与防止盲挖

- `SurvivalResourcePolicy` 直接读取真实背包，返回原木、木板、即时垫脚方块、食物、最佳工具耐久、武器、盾牌、威胁和下一步资源动作。工作台与 `mc_observe` 均暴露这些状态。
- 即时垫脚储备默认为 16 个。策略区分 `ready`、`craft-planks` 和 `gather-wood`，不把规划结果当作已经完成的回程。
- 至少保留两根原木作为工具原料；只有预计能达到储备且没有战斗威胁时，才每 20 tick 最多把一根原木合成四块木板。合成使用真实库存槽位，不创建物品或消耗全部木材。
- 地下 MINE 在最佳工具耐久不超过 5，或即时／可合成回程储备不足且无法继续准备时停止，不再继续盲挖。地表自然原木 BREAK 仍用于补充资源。
- 自动垫脚回程尚未开放。候选能识别资源不足、停止危险挖掘并准备材料，但不能据此宣称已经会安全脱困或长期无人值守生存。

### 自动化验证与交付边界

- CBI `compileJava`、`compileTestJava` 和完整 `./gradlew build` 通过，共 123 项测试。新增覆盖攻击冷却退避、盾牌使用条件，以及即时储备、保留原木、需要合成与必须采木的边界。
- 候选源码为 `建设bot参考/CarpetBaritoneIntegration-survival-20261108.tar.gz`，SHA-256 `0dd32f2411b0cdb0f533d71fdea2b935cd2b2b2bbeb85e8f9c372400673b937a`；候选 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-survival.jar`，SHA-256 `2b3f3e51c2d3d4d2f91f47a7739b11e15b701db813ea3b50e9dd3ae25d409f79`。稳定版 `0.11.4` 的源码与部署均保留，不覆盖。
- 仍需后续实机验证：举盾减伤、受击后快速退避、火球实际反弹、多数怪物下的走 A、工具临界耐久、木板合成槽位，以及停止后不再自主移动。未进行这些实机验收前，不写成“已经会战斗”。
- Companion 候选安装包为 `dsh-companion-bot-0.12.0.tgz`，SHA-256 `9b593f53d5916f363ddf0981ed378460b8c2f91a47a81d0711d17256baad374f`。`pnpm pack` 已同时通过宿主、工作台和移动端类型检查与构建；安装包仅归档，未安装。


## 25. v0.12.1 Live2D 尾巴清晰度与 Minecraft 经验课候选

本节记录实现和自动功能验证。候选未安装，正式环境继续运行 `0.11.4`；实机、视觉、主人与手机验收均未进行。

### petbox 尾巴修复的真实依据

- [whale-pet-shell / dsh-desktop-petbox](https://github.com/HoppoChan0721/dsh-desktop-petbox) 的 [`patch/apply-jingyu.mjs`](https://raw.githubusercontent.com/HoppoChan0721/dsh-desktop-petbox/main/patch/apply-jingyu.mjs) 明确指出：默认 256×256 遮罩缓冲会让尾巴网格裁切边缘放大成毛边，并把缓冲提高到 2048 作为修复。
- 当前舞台已按同一机制适配：模型加载后检查 `_clippingManager`，只在其支持时把 `setClippingMaskBufferSize(2048)`，并清理旧 `_maskTexture`、`_colorBuffer` 和帧号。管理器尚未就绪时最多等待 180 帧，不无限重试。
- 整体 `resolution` 上限继续保持 1.5，不把提高全屏像素当作根因，也不无限制增加显存。真实遥测新增 `clippingMaskBufferSize`，后续视觉验收可直接读取实际值。
- 已保留 whale-pet-shell contributors 的 MIT 署名和原许可。候选只完成代码与 `node --check src/avatar/stage.mjs` 验证，尚未进行新截图对比，不宣称尾巴视觉已验收。

### 从失败案例到改变后续动作

- schema v9 新增 `game_lesson`，按 `action + errorCode + targetKey` 形成稳定签名，保存目标、经验、来源、失败次数、首次／最近发生时间，以及 `learning / resolved / disabled` 状态。
- worker 失败事件包含真实动作、错误码和目标；宿主同时接收任务失败，2 秒内的同一失败事件与任务回执会去重，不制造重复记忆副本。
- `PUT /api/lessons` 每次最多接受 64 个经过坐标校验的目标。worker 在后续采集中排除 `dig-failed / dig-timeout / dig-unconfirmed` 对应坐标，优先其他有自然树叶证据的低处目标，不反复撞同一路径。
- 同目标后来真实成功才把经验标为 resolved 并移出避开名单；其他失败目标仍保持学习中。经验同步失败只记录降级事件，不阻断普通动作。
- 模型每次最多读取三条相关经验。工作台“她的经验课”显示错误、次数、目标和学习中／已验证状态。该机制不是在线权重训练，也不会自行提高动作权限。

### 自动功能验证

- 实际创建并重开 schema v9 数据库，验证失败去重、两个不同目标的独立经验、同目标成功后的解决，以及重启后仍保留另一目标的避开名单。
- 实际调用 worker `updateLessons`，确认合法目标进入 `avoidedTargets` 和视图投影；坐标 schema 限制继续生效。
- `pnpm typecheck`、`pnpm pack`、移动端检查、舞台 `node --check` 与 7 份文档检查均通过。没有修改本轮 CBI Java 代码，上一候选的 123 项 Java 测试结论仍属于 `0.12.0`。
- 候选安装包为 `dsh-companion-bot-0.12.1.tgz`，SHA-256 `c548f98ca5bd6aad1a966c3d8029a0e17f8961e48f530211e64ad8f8bfd257fe`。安装包只归档，未安装；生产数据库迁移和真实经验积累仍需后续验收。

### 总纲进度边界

- 已完成并有真实证据：多场景与中央记忆、手机基础聊天与动态、按需 TTS、基础 Live2D 动作、Minecraft 连接／观察／导航／自然原木采集／停止／下线与跨场景经历召回。
- 候选实现但尚未实机验收：生存反射、走 A、盾牌、火球、回程资源、尾巴遮罩修复，以及本轮目标级经验课。
- 仍未完成：安全自动垫脚回程、主人在线私聊与跟随、真实安卓试听、实时口型与可打断语音、歌唱、B站、手机高级媒体、小家和长期无人值守生存。不得把候选机制或参考项目的能力写成这些未完成项已经交付。


## 26. v0.12.2 受限安全垫脚回程候选

本节记录实现、自动化验证和归档结果。候选未安装，正式环境继续运行 `0.11.4`；没有启动真实竖井、战斗或停止位移验收。

### 受限路线与材料边界

- 新增 `SafeReturnPlan`：从角色当前竖井向上最多检查 16 格，只在北、东、南、西四个相邻位置选择具有稳定支撑和两格站立空间的真实出口。整个立柱必须完整，不能穿过天花板、流体、火、岩浆、仙人掌、凋零玫瑰、细雪或下落方块。
- 新增 `SafeReturnTask`：逐 tick 执行居中、跳跃、放置、落地，最后通过普通禁止放置的寻路走上相邻出口。出口被改变、角色偏离立柱、战斗威胁、单步或总超时都会中止，不把“垫高了一点”当成回程完成。
- 材料只来自配置的廉价石材／泥土类、垃圾石块或木板；沙砾等下落方块、潜影盒、贵重方块和原木均被排除。除物品标签外还保留保守 ID 回退，避免标签未加载时误耗原木、木块、菌柄或菌核。
- 每格放置都同时核对世界中的稳定支撑和生存背包扣减，失败分别返回 `return-placement-unconfirmed` 或 `return-inventory-unconfirmed`。普通移动和采集继续保持 `allowPlace=false`、通用 `allowBreak=false`，没有开放任意建造。

### worker、任务与经验课

- 新增显式 `mc_return`、worker `POST /api/return` 和本机管理动作，不改用手机或模型传入控制台命令。Companion 复用现有任务状态机，成功后写入共享经历；失败按具体错误码进入经验课。
- `survival` 观察新增 `return / returnError / returnExit / returnPlaced`。工作台显示当前回程状态、出口、实际放置数与错误，并提供“安全垫脚回程”按钮。
- worker 只有在角色实际站上计划出口且服务端状态为 `SUCCEEDED` 时才返回 `returned=true`。下台失败会取消残余寻路；`mc_stop` 继续统一停止任务与生存反射。
- 本次未改变 Companion SQLite schema，仍为 v9；没有新增第二套 Agent、在线训练或自动扩大权限。

### 自动化验证与产物

- CBI `compileJava`、`compileTestJava` 和完整 `./gradlew build` 通过，共 **131 项测试，0 失败**。新增 8 项覆盖最低安全出口、材料与高度上限、天花板、危险与下落方块、出口两格空间、出口变化、材料白名单和原木保留。
- 实际执行 worker 的 `returnToSafety()` 方法，以受控桩分别验证成功回执和 `return-no-safe-route` 失败传播；成功结构包含出口与 3 个实际放置块。该检查不冒充真实 Minecraft 世界验收。
- `pnpm pack` 通过宿主、工作台和移动端 TypeScript 检查与构建；7 份文档检查通过。JAR 内已核对 `SafeReturnPlan` 与 `SafeReturnTask` 类，Companion 包版本为 `0.12.2`。
- Companion 候选包为 `dsh-companion-bot-0.12.2.tgz`，SHA-256 `6c687920f58a524c6eaf300068efab0ab415219efe7114f7528ff693feeced4b`。只归档，未安装。
- CBI 候选 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-return.jar`，SHA-256 `a3bb0eebc3c8f2248a582488c0ce7390f21bf3ef1ae185cffe254dee2093d7ee`；完整源码为 `建设bot参考/CarpetBaritoneIntegration-return-20261108.tar.gz`，SHA-256 `0f4516764991af46f820deff2cef7b28be75e8372cec12c3b0442646bfbbe727`。

后续实机验收仍需分别覆盖一至三格短竖井、材料不足、头顶受阻、战斗中断、停止后零位移和最后一步下台；未通过前只能称为受限回程候选，不能宣称任意洞穴、复杂地形或长期无人值守生存已经解决。


## 27. v0.12.3 真实配方与受限生存合成候选

本节记录实现、自动化验证和归档结果。候选未安装，正式环境继续运行 `0.11.4`；没有把工作台附近、背包变化或配方调用写成已经通过真实 Coopcraft 验收。

### 真实配方与权限边界

- 新增 `SurvivalCraftingService` 和 `mc_craft`，一次调用只执行一个明确配方，不接受任意物品或数量。当前允许八种木板、木棍、工作台、木镐、石镐和盾牌。
- 服务端根据实际库存槽位构造 `CraftingInput`，通过 `RecipeManager` 查找真实 `CraftingRecipe`。配方 ID、产物 ID 和原版数量必须同时匹配；同名不同配方、异常 64 个木板等情况都会拒绝。
- 木板保留两根原木，木棍与工作台使用木板，镐和盾牌要求三格内存在可交互的已有工作台。没有开放远程工作台、任意配方、批量合成、自动放置工作台或通用建造。
- 材料搜索最多核对 64 个候选配方输入，避免异常材料组合导致无界回溯。威胁存在时不开始新合成，普通移动和采集权限不变。

### 可回滚库存事务与真实回执

- 配方匹配成功后先快照背包，再逐槽扣料、写回配方剩余物并加入真实 `assemble()` 产物。任一步失败都会恢复全部原材料，不把“扣了材料”当成“合成成功”。
- CBI 回执包含产物、配方和实际消耗；worker 独立读取合成前后库存，产物增量不一致返回 `craft-inventory-unconfirmed`，不记成功。
- Companion 复用现有任务状态机并写入共享经历。`craft-missing-materials`、`craft-table-required`、`craft-threat`、配方不符和背包异常分别进入经验课。
- `survival` 新增 `craft / craftError / craftItem / craftCount / craftRecipe`，工作台显示最近合成状态，并提供木板、木棍、石镐和盾牌按钮。Companion SQLite 仍为 schema v9，没有新增第二套 Agent 或在线训练。

### 自动化验证与产物

- CBI 完整 `./gradlew build` 通过，共 **139 项测试，0 失败**。新增 8 项覆盖白名单、真实 shaped 配方、精确扣料、同名不同配方拒绝、异常产物数量、材料不足、保留原木、插入失败回滚和盾牌配方。
- 实际执行 worker `craft()`，以受控桩验证 4 根木棍的成功回执、产物未增加时拒绝成功，以及 `craft-missing-materials` 的传播。该检查不冒充真实 Minecraft 世界验收。
- `pnpm pack` 通过宿主、工作台和移动端检查；7 份文档检查通过。JAR 内已核对 `SurvivalCraftingService`，Companion 包版本为 `0.12.3`，第三方许可说明已随包更新。
- Companion 候选包为 `dsh-companion-bot-0.12.3.tgz`，SHA-256 `43e695058ed7174688fe3006b63ab16b3fb817eb9d345372a0f57298d9d726c9`。只归档，未安装。
- CBI 候选 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-crafting.jar`，SHA-256 `5b3477367f169ea09addd432ded343d8a4039d653b6600875050253524eb0b82`；完整源码为 `建设bot参考/CarpetBaritoneIntegration-crafting-20261108.tar.gz`，SHA-256 `3276a816b113e7cb1aa1ac603a543d9720d0d03e505b317b55af77bba87ba64e`。

后续实机仍需分别验证已有工作台可达与不可达、各类木板、木镐／石镐／盾牌的实际合成、背包满、战斗中断和失败恢复。未通过这些检查前，只能称为受限合成候选，不能宣称通用制造、复杂资源规划或长期无人值守生存已经完成。


## 28. v0.12.4 主人授权区域与 3×3 营地建造候选

本节记录实现、自动化验证和归档结果。候选未安装，正式环境继续运行 `0.11.4`；没有在真实 Coopcraft 中放置营地或验证撤销后的现场状态。

### 主人授权而非模型自我扩权

- Companion SQLite 升级为 **schema v10**，新增 `minecraft_build_zone`，保存区域名称、维度、中心、半径、创建／更新时间和撤销标记。半径限定 2～8 格，坐标和维度均校验。
- 只有本机同源管理 API 可以创建、列出和撤销区域。工作台可按她当前位置创建半径 4 的区域；模型在事件提示中只能读取有效区域 ID，不能调用创建、扩大或撤销接口。
- `mc_build_camp` 先由宿主确认区域仍有效，再把受控区域参数交给 worker。撤销会立即阻止新任务；如果是当前营地，还会调用现有停止链，不等待模型同意。

### 固定营地与逐块回执

- `CampBuildPlan` 只寻找角色附近四个候选位置，结构固定为 **8 块同种地板和 1 个工作台**。地板允许木板、圆石、泥土或石头，不接受任意蓝图、数量、稀有方块或自动拆除。
- 所有修改位置必须在同一授权区、同一维度。每个地板格下方必须有稳定支撑，目标及其上方空间必须为空气，不能覆盖已有方块、流体、下落方块或实体。
- `CampBuildTask` 每 4 tick 最多放置一块，逐格核对世界状态、交互距离和真实背包扣减。已正确的方块跳过，威胁、越界、材料不足、遮挡、回读异常与停止分别结算；不会自动拆毁已完成部分。
- worker 再次检查最终 8 块地板和工作台，并按本次实际新增数量核对背包。自动木板合成在合成／建造独立回读期间暂停，完成后按停止前反射设置恢复，避免完成瞬间的库存竞态。
- 成功任务才写入共享经历；区域失效、位置不可用、材料不足、结构或背包回读失败进入经验课。`survival` 新增 `build / buildError / buildZone / buildCenter / buildFloor / buildTable`，工作台显示授权区与最近建造状态。

### 自动化验证与产物

- CBI 完整 `./gradlew build` 通过，共 **144 项测试，0 失败**。新增 5 项覆盖营地结构、遮挡、支撑、危险与实体、区域维度和三轴边界。
- 实际创建 schema v9 风格旧库并升级到 v10，保留既有经验记录；新建区域在关闭重开后仍存在，撤销后不再可读，最终 `integrity_check=ok`、`user_version=10`。非法半径被拒绝。
- 实际执行 worker `buildCamp()`，以受控桩验证 8 块地板和 1 个工作台的成功结构、`build-no-site` 传播，以及自动木板合成关闭后恢复。另以宿主方法验证当前区域撤销会调用一次停止，缺失区域返回 `build-zone-not-found`。这些检查不冒充真实世界建筑验收。
- `pnpm pack` 通过宿主、工作台和移动端检查；7 份文档检查通过。JAR 内已核对 `BuildZone / CampBuildPlan / CampBuildTask`，Companion 包版本为 `0.12.4`，许可说明已更新。
- Companion 候选包为 `dsh-companion-bot-0.12.4.tgz`，SHA-256 `6e5690668ac5c34a96d6a723d5ef0ac2ccd59757cd9e9b9cd02ececb1da47256`。只归档，未安装。
- CBI 候选 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-building.jar`，SHA-256 `38077d0635b1344cb716187aae467ea8d4a17609ff0bdc22acdf3f14bd4e2b7c`；完整源码为 `建设bot参考/CarpetBaritoneIntegration-building-20261108.tar.gz`，SHA-256 `e8ae39bc18cd4df0102603937b8c5b08d2d288bff06c8fc7e22d7a554062e7b6`。

后续实机仍需分别验证授权区边缘、跨维度拒绝、材料不足、部分完成后的停止与撤销、战斗中断和最终结构。未通过这些检查前，只能称为主人授权区域内的固定营地候选，不能宣称通用建筑、复杂庇护所、区域自动规划或长期无人值守生存已经完成。


## 29. v0.12.5 连续营地目标编排候选

本节记录宿主目标链实现和功能验证。候选未安装，正式环境继续运行 `0.11.4`；本轮没有修改 CBI Java，也没有在真实 Coopcraft 中连续执行采集、配方与建造。

### 用真实子动作组成目标

- 新增 `MinecraftService.prepareCamp()` 和 `mc_prepare_camp`，复用已有 `dig / craft / build` 子动作，不提供“直接生成营地”的捷径。支持八种原木及对应木板，区域仍只能由主人创建和撤销。
- 每次循环重新读取背包，计算当前树种原木、木板和工作台缺口。保留两根原木，已有木板、工作台或部分原木会减少实际采集与配方次数。
- 预算为最多 6 次采集、5 次配方、1 次建造和 8 分钟总时限。空手且没有工作台时，橡木目标实际需要 5 次采集和 4 次配方；可以先做出工作台，再补足地板木板，顺序不冒充固定材料数量。
- 父任务使用 `minecraft.prepare`，每个子动作另有真实任务 ID 和独立回执。只有最终营地成功后，父任务才写入共享经历；子动作失败、材料不足、超时或区域撤销都会停止后续步骤，部分进展不自动拆回。
- 撤销当前区域在采集、合成或建造阶段都会停止目标。`build-cancelled` 与主动取消统一记为 `cancelled`，不混同普通失败；尚未提供进程重启后的目标续跑，不能把当前任务记录说成持久目标恢复。

### 功能验证与交付

- 实际执行宿主 `prepareCamp()`，以受控库存和子动作桩验证：
  - 空手目标完成 5 次采集、4 次配方和 1 次建造，共 9 个准备子步骤；
  - 木板与工作台充足时直接建造，不重复采集或合成；
  - 部分库存正确减少调用次数；
  - `safe-natural-log-not-found` 会阻止最终建造并将父任务记为失败；
  - 区域撤销会调用停止、阻止建造并将父任务记为取消。
- 这些是宿主真实编排逻辑验证，不是 Minecraft 世界回执。底层仍使用 `0.12.4` 的 `BuildZone / CampBuildPlan / CampBuildTask` 与 144 项 Java 测试产物，本轮未修改或重新发布 CBI JAR。
- `pnpm pack` 通过宿主、工作台和移动端检查；7 份文档检查通过。Companion SQLite 保持 schema v10，未增加第二套 Agent 或新的权限通道。
- Companion 候选包为 `dsh-companion-bot-0.12.5.tgz`，SHA-256 `1f46b782dc68ffff3d6f99e037f93e2c29f3c8852daaf1a6d2994e8733673d8b`。只归档，未安装。CBI 继续复用 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-building.jar` 及其 `0.12.4` 源码归档。

后续实机需要验证从空背包连续采集 5 根原木、真实配方、授权区建造、中途撤销与停止后的现场状态，以及失败后的再次启动。未通过前，只能称为连续营地目标候选，不能宣称长期无人值守目标恢复或通用生存规划已经完成。


## 30. v0.13.0 可打断分段语音与真实音频能量口型候选

本节记录 M3c 第一段实现和自动功能验证。候选未安装，正式环境继续运行 `0.11.4`；没有在本轮操作真实 GPT-SoVITS、真实浏览器舞台或手机进行试听和视觉验收。

### 分段实时化而非整段 WAV 冒充实时

- `RealtimeVoiceService` 从指定场景的真实助手历史选择回复，最长 900 字，按标点与长度最多拆成 6 段。没有消息 ID 时选择最近一条助手消息，用户消息或任意提交文本不能冒充角色语音。
- 每段通过 `TtsService.synthesizeClip()` 复用现有 GPT-SoVITS 队列、固定声线、WAV 校验、任务状态和鉴权媒体。单段最多 240 字，队列保持有界；重复文本可复用缓存，媒体读取更新最近使用时间。
- 分段状态分别为 `pending / synthesizing / ready / playing / completed / cancelled`。前段实际播放时，后段仍继续合成；但 `ready` 不等于正在说话，`playing` 只在浏览器实际 `start()` 后成立，`completed` 只在 `onended` 后成立。
- 管理 API 提供开始、状态、取消、播放回执和鉴权音频读取。音频只能属于当前实时会话的就绪／播放／完成段，不能传任意文本或服务器路径。

### 可打断播放与取消仲裁

- 取消会将父会话置为 `cancelling`，停止当前 BufferSource、阻止后续段播放，并等待舞台真实取消回执。舞台离线且无法确认停止时返回 `voice-stop-unconfirmed`，不伪造已停止。
- 尚未开始播放时取消也必须回执，不能卡在 `cancelling`。同一会话的重复取消在舞台去重；`onended` 与取消竞争时最终保持 `cancelled`，不会变回成功。
- 当前正在合成的单个 Provider 请求可能先完成再被丢弃，但不允许启动下一段或恢复播放。服务关闭会取消未核验会话，随后停止现有 TTS worker。
- 父任务 `media.realtime` 与每段 `media.tts` 分开记录。只有全部分段实际播放完成，父任务才成功；部分完成不会写成整次实时对话完成。

### 真实口型与舞台遥测

- `voice.mjs` 使用 `AudioBufferSourceNode + AnalyserNode`，每帧读取 PCM 时域数据计算 RMS，映射为 `ParamMouthOpenY` 和较小幅度的 `ParamMouthForm`，不开放任意模型参数。
- 播放毫秒来自 `AudioContext.currentTime`，不是文本估计。停止、失败和换段会清空语音姿态与能量。
- 舞台“启用声音”按钮显式处理浏览器自动播放策略。心跳新增音频上下文、当前段、播放毫秒、能量和错误，工作台可播放最近真实回复、停止并查看每段状态。

### 自动功能验证与交付

- 宿主状态机验证通过：两段会话分别完成才成功；第一段完成后不会提前成功；取消与 `onended` 竞争保持取消；未知音频任务被拒绝。
- 模拟 Web Audio 验证通过：未播放取消只上报一次，实际 `start()` 产生 `playing`，取消停止音源，`onended` 记录 1250ms，能量驱动口型并在结束后清零。
- 使用本地模拟 HTTP Provider 执行真实 `TtsService` 队列，生成并校验 204 字节、10ms 的 RIFF/WAVE 文件和真实媒体资产。模拟 Provider 不代替真实 GPT-SoVITS 验收，模拟 Web Audio 也不代替真实浏览器视听验收。
- `pnpm pack` 通过宿主、工作台和移动端检查，`voice.mjs` 与舞台脚本检查通过，7 份文档检查通过。Companion SQLite 保持 schema v10，本轮未修改 CBI 或手机 App。
- Companion 候选包为 `dsh-companion-bot-0.13.0.tgz`，SHA-256 `db78222801d99b336c47a79ad0b09f99b9902bffd4fcf0db08dcb0b4ad1dcabf`。只归档，未安装。

后续需要在正式私有舞台验证真实模型声线、连续段播放、取消后零声音与零口型、实际延迟和浏览器自动播放策略；手机 RTC、麦克风输入、流式 Provider 增量 PCM、歌唱和完整连续对话仍属后续阶段。


## 31. v0.13.1 场景内语义动作候选

本节记录语义动作工具与自动验证。候选未安装，正式环境继续运行 `0.11.4`；本轮没有修改模型、舞台运行时、CBI 或手机 App，也没有进行新的真实动作视觉验收。

### 受限意图与场景权限

- 新增 `companion_avatar_action`：只允许 `blush` 或 `point`，不接受模型参数、任意动作名、时长或资源路径。
- 新增 `companion_avatar_stop`：只提交当前动作停止请求，支持携带前一次任务 ID，不把停止请求写成已经取消。
- 普通聊天、游戏和话题 Session 可以调用；`memory.curator`、`autonomy.feed` 和 `feed.reply.*` 不可见。未注册 Session 或系统内部场景会被拒绝。
- 工具索引同步更新为普通场景 4 个记忆工具与 2 个形象动作工具，动态线程继续使用独立动态工具，记忆整理不注入这些动作能力。

### 回执与完成边界

- `companion_avatar_action` 返回 `accepted` 和任务 ID，只表示 `AvatarService` 已接收动作。真实舞台心跳与待执行队列仍负责后续下发。
- 舞台 `playing` 回执将任务转为 `running`；`completed` 才转为 `succeeded`；停止后以 `cancelled` 结算，不能用自然语言“我脸红了”替代实际执行。
- 已有动作未结束时，新动作会被现有仲裁拒绝。停止请求进入 `stopRequestIds`，由舞台实际停止后回传取消。
- 工作台继续复用 `media.avatar` 任务展示，不新增第二套动作状态或第二套人格核心。

### 自动验证与交付

- 通过真实工具注册捕获定义并调用：普通场景返回 `accepted` 与任务 ID，停止返回 `stop-requested`，内部场景调用被拒绝。
- 工具索引验证普通聊天包含两个形象工具，`memory.curator` 没有任何 Companion 工具。
- 使用真实 `AvatarService` 和 Companion Task Store 验证：`accepted → running → cancelled`，停止不会误报成功。
- `pnpm pack` 通过宿主、工作台和移动端检查；7 份文档检查通过。Companion SQLite 保持 schema v10，临时数据库已清理。
- Companion 候选包为 `dsh-companion-bot-0.13.1.tgz`，SHA-256 `410be0eb8707d9b62badfd1868ac522dabb37c976f157d151584cead85c531e2`。只归档，未安装。

后续需在正式私有舞台让普通聊天 Session 实际调用一次脸红和抬手，并核对动作、停止和画面。自主情绪、完整动作编排、连续对话、手机 RTC 与歌唱仍属后续阶段。


## 32. v0.14.0 可执行媒体缓存清理与删除墓碑

本节记录 M4 第一项实际存储能力和真实文件验证。候选未安装，正式环境继续运行 `0.11.4`；未开放后台自动清理，也没有把预览字节当成已经释放的空间。

### 人工确认与最小删除范围

- 新增本机同源管理 `POST /companion/api/media/cleanup`，请求必须包含 `confirm: true`、未使用天数和最多 50 个候选的上限。模型与手机设备 API 没有该权限。
- 工作台沿用 `POST /media/preview`，主人在当前预览后明确点击“确认删除这些缓存”。执行使用预览时的天数，避免中途改变筛选条件。
- 仅处理 `retention=cache` 的过期、可再生成文件。模型权重、角色原素材、参考声线、原始聊天、中央记忆、数据库、备份和 `retention=keep` 的文件继续排除。

### 逐文件核验与实际释放

- 删除前重新解析受控媒体目录，拒绝越界路径、绝对路径注入、符号链接和非普通文件。
- 文件大小必须与清单一致，并重新计算 SHA-256；已变化文件按 `changed` 或 `hash-mismatch` 跳过，缺失文件按 `missing` 跳过，其他 I/O 错误单独记录，不强行删除。
- 只有 `unlink()` 成功后才记录 `deleted_at` 和实际释放字节。预览候选大小、缺失文件和跳过项均不记为已释放空间。
- schema v11 的 `deleted_at` 是清理墓碑，不是缺失标记。后续扫描不会把已删除记录恢复为有效文件；同名缓存重新生成时才建立新的有效记录。
- 工作台显示实际删除数量、释放字节、跳过原因，以及累计清理文件与字节。普通 TTS 和实时分段读取继续更新最近使用时间。

### 真实文件与迁移验证

- 使用真实临时 WAV 和保护文件验证：过期缓存被删除，实际释放 14 字节，保护文件仍在。
- 修改后的同名文件被跳过，未因名称匹配而误删。
- 重扫后删除墓碑没有复活；有效文件统计与累计清理统计分开。
- 从 schema v10 数据库升级到 v11，原授权建筑区保留，最终 `integrity_check=ok`、`user_version=11`。
- `pnpm pack` 通过宿主、工作台和移动端检查；7 份文档检查通过。临时数据库与测试文件已清理。
- Companion 候选包为 `dsh-companion-bot-0.14.0.tgz`，SHA-256 `b42613438d0abc04cb9132fddd059d5a2c3c7cc027c1707af7eb8dfbacf82cfa`。只归档，未安装。

后续需在 Mac mini 的真实 Companion 媒体目录中先备份，再预览并确认一次小范围清理，核对磁盘实际空间变化、任务缓存重建和备份恢复。后台自动垃圾清理、手机文件与图片、视频浏览、歌唱和完整自主生活仍属后续阶段。


## 33. v0.15.0 手机图片上传与动态附件候选

本节记录手机图片链路和真实文件、迁移与 Android 构建验证。Companion 候选未安装，正式环境继续运行 `0.11.4`；没有在真实安卓手机上操作相册或检查最终图片显示。

### 受控上传与本地媒体

- 手机使用 Expo 官方 `expo-image-picker` 和 `expo-file-system` 选择并读取图片，客户端先限制 10MB 并展示本地预览。iOS 相册用途已声明，未新增麦克风或后台音频权限。
- 新增 `DeviceMediaService`：仅接受 PNG/JPEG/WebP，同时检查声明 MIME、真实文件魔数、非空内容、10MB 上限和 SHA-256。MIME 不符、类型不符、Base64 异常和超限均拒绝。
- 图片使用随机 ID 写入 `media/images/`，权限 600，不把原始文件名或 Base64 注入 Session、中央记忆或动态正文。媒体清单登记真实哈希、类型、来源、大小和最近使用时间。

### 动态附件与鉴权读取

- schema v12 为 `post` 增加 `media_id`，动态只保存媒体引用。创建动态时拒绝不存在、已删除、缺失或非图片附件。
- 设备通过 `/companion-device/api/media/:id` 携带设备凭据读取；工作台通过 `/companion/api/media-file/:id` 使用同源管理权限展示同一附件。
- 每次读取再次检查普通文件、大小与 SHA-256，篡改文件被拒绝。上传失败不会生成“带图成功”的假动态。
- 手机发布编辑器支持选择、更换、移除和预览图片，时间线显示附件；Mac 工作台展示同一媒体 ID。后续图片清理复用现有媒体保留与墓碑机制，当前上传图片为 `keep`，不进入自动缓存清理。

### 验证与交付

- 使用真实 PNG 验证上传、哈希登记、600 权限、动态 `mediaId` 关联和鉴权读取；声明 JPEG 的 PNG 被拒绝，篡改后读取被拒绝。
- 从 schema v11 升级到 v12，最终 `integrity_check=ok`、`user_version=12`。
- 宿主与移动端 TypeScript 检查、`pnpm pack` 和 7 份文档检查通过。
- Android `:app:assembleRelease` 成功，包含新增 Expo 模块与相册用途配置。经后续 `aapt dump badging` 复核，原 APK 实际为 `0.4.0`、versionCode `5`，当时 Expo 配置与 Android 构建配置的版本号未同步。原 APK SHA-256 为 `1b3f571816fa895c1c78f85f69ade5d74e5614a8f8c2036b2f9a0d290deef715`，使用开发签名，仅供个人链路验收。
- Companion 候选包为 `dsh-companion-bot-0.15.0.tgz`，SHA-256 `e302597357e9f719643c33761344d125ba2e45cae571a847ba2b33e038c5ed81`。只归档，未安装。

后续需在真实安卓设备上选择一张图片，检查上传进度、断线恢复、动态显示、重连后的鉴权读取和旧版本升级。通用文件、视频附件、手机实时通话、歌唱和完整自主生活仍属后续阶段。

## 34. v0.15.1 图片动态与回复验收

- 修复 Expo 58 在运行时拒绝的旧文件读取 API，以及动态提交时丢失图片参数的问题。手机可发布纯图片动态与回复，文字动态仍使用原入口。图片上传已返回 ID 后，当前编辑器重试发布会复用该 ID。
- 工作台使用原有管理请求头获取附件，动态和回复均可显示。动态自主回应只接收文字和附件存在提示，模型不接收图片内容。
- 在隔离 DSH `0.2.1-rc.5` 安装 `0.15.0` 并造一组带图动态与回复，复现旧工作台图片请求 403。升级到 `0.15.1` 后，schema v13 保留动态、回复及媒体关联，SQLite 完整性检查与外键检查通过。使用真实 PNG 验证设备授权读取、管理请求头、声明类型不符、空动态、无效引用、文件篡改与符号链接。
- Android 36 模拟器使用开发构建和 ADB 回环转发，实际经过配对、系统相册、预览、纯图片发布和纯图片回复，确认手机渲染两张图片。Chrome 在 DSH 工作台解码迁移前和新发布的附件。宿主打包、移动端类型检查、Android release 构建和文档检查通过。
- Android release 应用版本为 `0.5.1`、versionCode `7`。模拟器使用本地隔离服务，真机相册、Mac mini 的 Tailscale HTTPS/WSS 和正式数据升级仍需复验。

## 35. DSH Go 安卓客户端 0.1.0

- 源码位于 `apps/dsh-go`，基于上游 `v1.0.13`（`4835500`）。独立应用 ID 为 `ai.companion.whale`，复用 DSH Go 的 Flutter 主题、Markdown 流式渲染、附件预览和看图界面。配对、聊天与动态通过 Companion 设备 API，配对信息使用系统安全存储。APK 使用大肥鱼图标。
- 用 Android 36 arm64 模拟器安装 release APK，通过现有 Tailscale HTTPS 完成一次性配对并打开原有 `chat.mobile`。两轮测试回复实际保存，第二轮观测到 53 个文本增量和最终完成事件，手机显示最终回复；覆盖安装保留设备配对和对话历史。
- 以 debug 构建连接隔离的 Companion `0.15.1`，通过 Android 系统相册选择真实 PNG，完成纯图片动态、纯图片回复和鉴权读取。两个上传及两个发布请求返回 201，附件读取返回 200，两个附件实际在手机渲染，SQLite 完整性检查通过。
- 用户授权后升级了 Mac mini 的 `ai.companion.bot.dsh` 服务。备份位于 `/Users/filisi/.local/share/companion/backups/20261108-231529-whale-android-0.15.1`，包含 schema v8 数据库、插件 profile、sessions 与 storages。健康探测期间旧切换脚本重复进入回滚流程，恢复旧服务后改用显式检查与单次回滚。最终正式运行 `0.15.1`，五个场景保留，schema v13 完整性及外键检查通过。
- 用交付 release APK 在升级后的 Mac mini 重新配对，读取升级前的历史，并观察新回复的 23 个流式文本增量和最终完成事件。经同一 Tailscale HTTPS 地址选择系统相册 PNG，发布标记为 `Android photo QA` 的动态，再提交纯图片回复。手机读回附件，正式数据库核对到一条带图动态和一条带图回复。
- `dart analyze lib/whale lib/whale_main.dart test/whale`、两项配对与重定向回归测试、release 签名核验和文档检查通过。release 使用本机开发签名，生产包强制 HTTPS。

```sh
flutter pub get
python3 tool/l10n_merge.py
flutter build apk --release --flavor companion --target lib/whale_main.dart \
  --target-platform android-arm64 --build-name 0.1.0 --build-number 1 --no-pub
```

构建命令在 `apps/dsh-go/app` 执行。Flutter 版本为 `3.47.7`，Android SDK 为 36，测试构建使用 Java 21。当前 APK 为 `whale-companion-go-0.1.0-arm64.apk`，SHA-256 为 `1205ead2222286bb6e895ff4866af92c8f337e8f6103ec508fbcd27071c55b53`。

## 36. v0.15.2 Minecraft 服务端兼容与回执

- 用正式服同 SHA-256 的旧 CBI JAR 在隔离服复现新版 worker 初始化失败。旧版缺少 `survivalAutoCraft`、`survivalResourceReserve` 和 `cbi survival`，现在 worker 通过 `cbi help` 与只读生存状态回执探测支持情况。旧服的基础控制可用，工作台禁用未确认支持的回程、合成和建造，备料任务会在创建任务、采集或耗材前返回 409。
- 建筑候选版的命令处理器已有实现，`CommandManager` 的注册表却没有 `survival`、`return`、`escape`、`craft` 和 `buildcamp`。修正版补全注册，并向调用者和服务端日志输出完整的生存快照，使 worker 能读取每项动作的完成状态。
- 两套隔离服均使用 Minecraft 1.21.1、Fabric Loader 0.20.1 与 Carpet 1.4.147。旧服通过进服、观察、移动 3 格、停止和下线。修正版通过用 1 根原木合成 4 块木板、回读营地的 8 块地板与 1 个工作台及扣料、放置 1 块垫脚方块并到达出口。CBI 145 项测试、Companion 构建和移动端 TypeScript 检查通过。
- 从 Companion 包启动 worker，再经 HTTP 验证宿主流程。旧版返回 409，SQLite 未生成任务。修正版从已有原木完成三次木板和一次工作台配方、营地建造、父子任务状态与共享经历写入。两套隔离数据库的完整性和外键检查通过。
- Companion 包为 `dsh-companion-bot-0.15.2.tgz`。对应 CBI JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-companion-0.15.2.jar`，SHA-256 `f7aea2eca6d81ffc021febdea1ab3516bd23af8993daaf66528d51e41edb9dca`。CBI 完整源码及许可证为 `建设bot参考/CarpetBaritoneIntegration-companion-0.15.2-20261108.tar.gz`，SHA-256 `29321114a354b05af2670ed62905d5ae69119f7c768238f352d9e2f0a71891eb`。正式 Mac mini 仍运行 Companion `0.15.1` 和旧版 CBI。

## 37. DSH Go 安卓客户端 0.2.0 按需语音

- 已完成的助手消息可点按“听语音”。仍由已配对的 Companion 使用现有 `/tts` 任务和 `/tts/:id/audio` 接口。客户端校验 WAV 类型、文件头和字节数，通过鉴权请求分块写入临时文件。取消等待会终止手机的轮询和下载，已提交的主机合成仍由既有任务和媒体清单管理。
- 复用 DSH Go 的 `CompanionVoicePlugin` 和 `ClipPlayer`。每次只播放一条，原生播放器确认开始后才显示播放中。暂停、继续和重播复用本地文件，切换消息、离开聊天或退出时清理缓存。
- Android 36 arm64 模拟器使用隔离数据库和原有 Companion HTTP/TTS 实现，语音 Provider 返回本地中文 WAV 作为可重复测试素材。Android 系统音频状态确认开始、暂停、继续和重播，且重播没有新 TTS 请求。切换到动态页后系统播放器停止。5 项 Flutter 测试、Dart 分析与 l10n 生成检查通过。行为测试使用 macOS 的中文字体作为环境替代。
- 停止隔离主机后，当前消息显示“重试语音”。恢复主机后点击重试，系统重新进入实际播放状态。切换到动态页后检查应用缓存，测试语音目录已删除。隔离 SQLite 完整性和外键检查通过。
- Release 包 `whale-companion-go-0.2.0-arm64.apk` 使用 `versionCode=11090011`，SHA-256 `db22856cb443dfd16f4dd1d71b1a3cac1d094b2800fa48f9976a58fbb329c2cb`。从 `0.1.0` 的实际 `versionCode=11082247` 覆盖安装成功，签名和首次安装时间一致，新版成功启动。正式 Mac mini 的 Companion 与声线未更改，手机真机和真实 Tailscale 语音播放待验收。

## 38. DSH Go 安卓客户端 0.3.0 状态与 Token

- 聊天和动态顶部显示角色最近同步的状态，另有状态页展示语音合成、Minecraft 和虚拟形象的可用性。区分手机连不上主机、角色会话离线和设备已撤销。网络请求失败时标明上次同步时间，撤销时清除状态快照。
- 复用设备 `GET /companion-device/api/state`，并发请求合并。进入状态页、手动刷新和回前台会同步，应用在前台时每 30 秒更新。Token 直接读取 `stats.inputTokens` 和 `stats.outputTokens`，覆盖仍保留的 Companion 活动。缺失字段显示未知，两项均为零时显示暂无记录。
- Android 36 arm64 模拟器配对后通过实际设备 HTTP 路由和隔离 SQLite 核对 Token 从 `12,500 / 417` 更新到 `13,000 / 497`。重复事件只统计一次。验证了忙碌、会话离线、请求失败和上次同步时间。7 项 Flutter 测试、Dart 分析、l10n 生成检查通过。正式 Mac mini 的 `0.15.1` 可供该客户端读取现有状态字段。
- 模拟器后台 32 秒内没有状态轮询，恢复前台立即刷新。Release APK `whale-companion-go-0.3.0-arm64.apk` 使用 `versionCode=11090025`，SHA-256 `a1c454a52171c9014f44c320f0839dac3759eebbd1f3ab86d9e1be4e066e80fc`，沿用 `0.2.0` 的签名，覆盖安装后正常启动。

## 39. v0.15.3 舞台分段语音打断与口型验收

- Web Audio 改用以零为静音的浮点 PCM，口型采样和模型更新位于同一渲染帧。舞台读取 Cubism 更新前的嘴型参数，避免用渲染后已恢复的参数诊断口型。
- 音频下载与解码独立于状态轮询，解码后再确认当前会话和段状态。舞台“停止语音”先停音源，再请求取消并发送回执。宿主拒绝并发启动和乱序回执，拒绝晚到的错误改写已取消的任务；舞台失联时区分未确认的停止与成功取消。
- 使用 Chrome、Apple M5 Metal 和真实大肥鱼模型，在隔离环境验证 509 个模型参数与 0 个非有限参数。带静音段的测试 WAV 实测静音能量和嘴型均为 0，语音时取样的嘴型值为 0.41 和 0.67。连续两段各完成约 4 秒。人为延迟音频响应 3.6 秒，两轮测试中管理端在约 0.42～0.53 秒内取消下载，舞台没有开始播放该段。关闭舞台后再停止会话，宿主在心跳过期后记录 `voice-stop-unconfirmed`。
- 3 项回归测试及 `pnpm pack` 通过。候选包 `dsh-companion-bot-0.15.3.tgz` 的 SHA-256 为 `cc52bd3b6213cddf01e6c9fb770e033fe46b0a180c2d90c5d69930676fa9ad16`，未包含私有模型、Cubism Core 或测试 WAV。正式 Mac mini 仍使用 `0.15.1`，正式 GPT-SoVITS 声线和麦克风连续对话待验收。

## 40. v0.16.0 记忆召回与归档

- 搜索先按状态、场景和共享权限筛选，再从全部符合条件的记录选出相关结果。宽字符和半角字符按同一关键词匹配。最后一次实际召回参与小幅时效衰减，重要度和置信度保持独立。
- 每个对话轮只在首步读新输入。选中最新用户消息，长输入保留开头和结尾，单独问候跳过相关检索。记忆整理器使用已准备的原文与源场景候选，不再套入普通聊天的自动召回。
- 首轮锚点与相关项去重。包含头尾标识的注入最多 3,000 字符，按完整条目装入，标记并转义超长或含标记字符的内容。召回计数和活动记录对应本次实际纳入注入消息的条目。
- 原有手动归档先筛选 60 天以上、低重要度、未召回且未置顶的记录，再按最旧优先处理，继续保留修订历史。SQLite 回归覆盖 500 条以上干扰记录、跨场景权限、最新输入、停用条件、预算、计数和归档保护。本次没有数据库迁移。

## 41. v0.16.0 舞台自动朗读

- 舞台默认关闭自动朗读。主人选择已绑定的场景并开启后，宿主根据 `assistant/message` 和成功结束的 `turn/end` 配对，只把对应的新回复交给原有分段语音链路。忙时仅保留最新一条，跳过工具中间消息、中断或超长回复。会话换绑后需要重新开启。
- 自动播放绑定请求开启的舞台。关闭或停止先撤销本地播放许可并立即停声，随后确认宿主取消。网络故障时旧状态无法重新起播，宿主在舞台租约到期后结算任务。手动播放与原有鉴权路径继续可用。
- 隔离 Chrome 使用真实大肥鱼 Live2D 与测试 WAV，验证默认关闭、同场景最终回复、第二个舞台隔离、关闭请求返回 503 后不重播，以及手动播放与停止。浏览器报告 509 个模型参数和 0 个非有限参数。8 项舞台回归、SQLite 完整性和宿主类型检查通过。

## 42. Android 0.4.0 活动页

- 从现有设备状态接口读取最近活动，只显示符合来源与成功状态的动态发布或回复、Minecraft 动作和 Live2D／舞台语音回执。支持按三类活动筛选、刷新、显示最后同步时间及离线提示，不展示游戏私聊原文、未完成任务和已知删除项。
- 通过原有鉴权动态接口打开活动对应的原帖，并定位相关回复。Android 36 arm64 隔离模拟器验证了一次性配对、分类、过滤、原帖跳转和 503 后刷新恢复。覆盖安装保留首次安装时间，Release 正常启动。Dart 分析、l10n 检查及 10 项 Flutter 测试通过。
- Android ARM64 包 `whale-companion-go-0.4.0-arm64.apk` 使用 `versionCode=11090759`，SHA-256 `6a7d6e8b2b6dfffb65b86b92a6f9d48fd9bbfb539aa5ee387eabc7536e94a399`。签名与 `0.3.0` 一致。

## 43. v0.16.0 Minecraft 私聊与跟随恢复

- worker 识别真实的未签名玩家聊天和旧版 CBI 私聊回执，私聊限配置中的主人和机器人。公开文本中的仿冒进出服句不会修改在线状态。回复根据 CBI 私聊回执确认，测试中 256 个中文字符通过两条私聊完整送达。
- 跟随中目标离开时，worker 确认 CBI 停止，释放动作占用。宿主把对应持久任务结算为取消，主人重连后可重新开始。全局活动和工作台近期事件脱敏，私聊原文只交给游戏事件处理。
- Minecraft 1.21.1 Fabric 隔离服使用独立测试玩家，在旧版和修正版 CBI 验证了双向私聊、旁观者隔离、连续两个目标位置跟随、停止后保持位置与玩家断线恢复。实际停止并重启测试服后，同一 worker 观察到离线、重启和重新上线，再次跟随通过。
- 旧 CBI 收到 `/tell` 后仍会显示内置自然语言控制关闭提示。补充平面表情在 Java 回执中保留，测试客户端 Mineflayer 显示异常，原版客户端待验收。正式 Coopcraft 及主人账号待联调。
- 集成包 `dsh-companion-bot-0.16.0.tgz` 的 SHA-256 为 `f0845bb06dc484b35978122e287b39614cf4284ac35ec50036874b95d7150d9b`。14 项宿主、舞台与 Minecraft 回归、`pnpm pack` 和文档检查通过。正式 Mac mini 继续使用 Companion `0.15.1`。

## 44. v0.17.0 低延迟 TTS 候选

### 引擎对照

- voice-pipeline-mvp 的用户录屏把判停后链路和完整体感分开计时。快路径组合 Mac 上的 MLX 小语言模型与云端讯飞 TTS。Companion 复用预热、长连接、逐块播放和打断清队列的做法。 [项目实测与分项说明](https://github.com/helloworldtang/voice-pipeline-mvp)
- AnifLive-TTS 的 74.578 ms 是 v1.3、RTX 5070 Ti、TensorRT 11、预热 HTTP/1.1 单并发下的可听样本估计 P50。TensorRT 11 支持矩阵没有 Apple Silicon。 [原始基准](https://github.com/Hiruynk/AnifLive-TTS/blob/main/benchmarks/README_BENCHMARK_SUMMARY.json) · [NVIDIA 支持矩阵](https://docs.nvidia.com/deeplearning/tensorrt/latest/getting-started/support-matrix.html)
- 正式 Mac mini 为 Apple M6、16 GiB，现有 GPT-SoVITS 快照缺少 `gpt_streaming`。本机 Apple M5、24 GiB 使用相同 v5 turbo 权重与参考音跑 `04a44eb`，普通 WAV 热态首个有声 PCM P50 4.75 秒，默认 raw 请求约 4.79 秒。该提交的 API 接受语义流参数，实际在 v5 turbo 回到整段推理。原始合并版 `1d9fe63` 的语义流路径在 MPS 上实际返回 400，提示缺少可用的 AR 加速后端。 [语义流合并与基准](https://github.com/RVC-Boss/GPT-SoVITS/pull/2848) · [加速后端选择](https://github.com/RVC-Boss/GPT-SoVITS/blob/1d9fe63/tools/acceleration.py#L46-L74)
- 选用 VoxWeft 的 4-bit VoxCPM2 MLX、4 步作为舞台实时候选，GPT-SoVITS 保留普通语音消息与 WAV 回退。两条路径复用同一段 6.83 秒大肥鱼参考音。VoxWeft 使用音频克隆，GPT-SoVITS 同时使用配套转写。 [VoxWeft 固定版本](https://github.com/HenryZ838978/VoxWeft/tree/097fb20faee43cec01d300832f21abf3014f84a6) · [VoxCPM2 模型](https://github.com/OpenBMB/VoxCPM)

| 本机热态推理 | 样本数 | 首个有声 PCM P50 | 最大值 | RTF P50 | 无断供预测可听 P50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| VoxWeft MLX 6 步 | 12 | 281 ms | 432 ms | 1.069 | 621 ms |
| VoxWeft MLX 4 步 | 6 | 251 ms | 315 ms | 0.778 | 354 ms |

两组交替生成相同三句中文，单并发，首音以 10 ms 窗的 RMS 达到 −45 dBFS 计算。RTF 是生成耗时除以音频时长。4 步六次 RTF 均低于 1，最大 0.850。预测值根据各块到达时间和累计样本数计算，排除声卡和实际扬声器延迟。4 步试验中 MLX 峰值 5.40 GiB、进程峰值 RSS 5.52 GiB，两者统计范围不同。正式机上 DSH、Minecraft 和两套语音引擎并行时的资源余量仍需复验。

在同一个 loopback HTTP 基准下，VoxWeft 4 步的 6 轮有声 PCM P50 为 275 ms，最大 419 ms，RTF P50 为 0.757。GPT-SoVITS v5 turbo `04a44eb` 的三轮完整 WAV 有声 PCM P50 为 4.75 秒，最大 4.81 秒。两组都用相同三句中文与原始参考音，输出长度、采样方式和音色随引擎变化。

### 隔离启动与计时

1. 在独立 Python 3.12 环境准备固定提交的 VoxWeft 和其运行时依赖，按其模型说明取得 `OpenBMB/VoxCPM2` 权重、配置和 tokenizer，再用 `scripts/convert_vae.py` 生成 `vae_mlx.safetensors`。本次在 MLX 0.31.1、Transformers 4.57.6、FastAPI 0.136.1、uvicorn 0.47.0 环境运行，`mlx-audio 0.5.2` 用于导入上游桥，TTS 启动脚本只加载 TTS 模型。权重与参考音都留在本机。 [上游模型清单](https://github.com/HenryZ838978/VoxWeft/blob/097fb20faee43cec01d300832f21abf3014f84a6/docs/MODELS.md) · [上游转换脚本](https://github.com/HenryZ838978/VoxWeft/blob/097fb20faee43cec01d300832f21abf3014f84a6/scripts/convert_vae.py)
2. 用下面的命令启动独立桥。模型和声线在同一 MLX 工作线程初始化、缓存并完整预热后，`/ready` 才能返回成功。`/voices` 应列出 `deepseek-whale-voxcpm2`。Companion 每次请求前核对声线，缺失时返回错误，防止引擎静默切到其他音色。

```sh
python scripts/run-voxweft-tts.py \
  --voxweft-dir "$VOX_WEFT_DIR" \
  --model-dir "$VOX_MODEL_DIR" \
  --ref-audio "$WHALE_REFERENCE_WAV" \
  --steps 4 --port 18133
curl -fsS http://127.0.0.1:18133/ready
curl -fsS http://127.0.0.1:18133/voices
```

3. 将 [本机配置示例](../README.md#低延迟舞台语音v0170-候选) 用于隔离 Companion。OpenAI 兼容 Provider 使用 `ttsStreamProtocol: openai`、固定 `ttsStreamModel` 和 `ttsStreamVoice`，默认 24 kHz。GPT-SoVITS v2 协议复用固定参考音、转写、语言和 `cut0`，v5 默认为 48 kHz，需自行提供已经支持语义流的引擎。留空 `ttsStreamEndpoint` 回到现有 WAV 路径。
4. 用 [HTTP 基准脚本](../scripts/bench-voice.mjs) 测三句固定中文。`firstByteMs` 为首网络数据，`firstPcmMs` 为首个完整样本，`firstVoicedMs` 为首个有声窗接收，`totalMs` 为读完响应。支持 PCM 和完整 PCM WAV、预热、顺序重复、连接复用或 `--fresh` 对照。舞台另报 `firstPacketMs`、`firstScheduledMs`、`audioClockReachedMs`、`firstSignalMs`、`underruns` 与 `peakBufferedMs`。这些指标从各自请求起算。

```sh
preset=$(mktemp)
printf '%s\n' '{"target_text":"","voice":"deepseek-whale-voxcpm2","stream":true}' > "$preset"
node scripts/bench-voice.mjs --endpoint http://127.0.0.1:18133/generate \
  --body-file "$preset" --format pcm --sample-rate 48000 --warmup 1 --trials 6
```

### 真实模型与舞台验收

- 隔离 Companion 使用实际 HTTP 管理路由、SQLite、VoxWeft 和 Chrome，通过真实大肥鱼模型渲染 509 个参数，非有限值为 0。首包 468 ms，Web Audio 时钟起播 478 ms，渲染帧的音频分析器首个有声观测 585 ms。8.96 秒音频无断供，回执 `playing` 早于传输 EOF 约 6.6 秒，最终任务为 `succeeded`。第二轮点停时已播放 221 ms，本地立刻静音，流提前关闭，回执依次为 `playing`、`cancelled`。两轮均无 WAV 任务。
- 合成测试流在 Chrome 的 10 轮均先开口后 EOF，覆盖点击声音授权前零请求、可恢复断供、连续播放、分块与点停。原始语音与模型文件留在私有目录，安装包只含插件和启动、基准脚本。
- 工作台在成功发起播放后通过同源父页信号唤醒舞台，独立舞台和未收到信号时保留轮询。在隔离 Chrome 验证会话建立后 7 ms 发出 PCM 请求，同源兄弟 iframe 与错误消息结构不会触发管理请求。
- 39 项回归、宿主与移动 workspace 类型检查、构建和 7 份文档检查通过。提取并载入 tarball 验证了默认 WAV 与 VoxWeft 可选配置。`dsh-companion-bot-0.17.0.tgz` 的 SHA-256 为 `5e5f373ba5116eb88d0afab7633ba073183e4412a015ed8d2ad8a05198725709`。
- 该版从已完成的助手文本启动舞台语音。手机按需语音沿用 GPT-SoVITS WAV，麦克风判停、ASR、文本增量触发和 Android 扬声器计时需要单独验收。正式 Mac mini Companion 仍为 `0.15.1`。

## 45. Android 0.5.0 与 Companion 0.18.0 流式语音

- 配对设备通过 `POST /companion-device/api/voice-stream` 提交 `contextId` 和 `messageId`。宿主只读对应场景的持久化助手消息，限制文本和日志读取范围，不恢复 Agent、不接受任意合成文本。超过 240 字符的回复使用已有 WAV 路径。响应使用 `application/octet-stream` 和 `x-companion-sample-rate`，音频为单声道 S16LE。
- 设备和舞台复用同一 PCM 槽。客户端退出、设备撤销和宿主停机中断上游。流式请求不创建 WAV 合成任务或语音文件。旧主机或起播前的可回退错误沿用原语音任务和缓存，流中故障显示重试。设备撤销按已有鉴权状态处理。
- Dart 按 40 ms PCM 块向 Android 音频层传输，并等待原生回压。AudioTrack 的播放头决定起播和完成，EOF 后等待队列播完。暂停、继续、停止、切页、音频焦点丢失和更换播放内容由各自的生命周期处理。
- Android 36 ARM64 隔离模拟器通过真实设备配对与 HTTP 路由验证 PCM 在 EOF 前起播、原生暂停与恢复、自然完成、离开聊天时停止和提前关闭上游、Provider 错误及旧主机 404 回退、播出后断流无自动重播。一轮本机 VoxWeft 四步真实合成中，从设备请求到宿主首 PCM 834 ms，到模拟器轮询首次观察 AudioTrack 起播 878 ms，宿主 EOF 5.19 秒。该轮合成 4.8 秒语音，未触发 WAV 回退。AudioTrack 观测包含轮询开销，实际扬声器和正式 Tailscale 延迟待测。
- 48 项宿主回归、16 项 Flutter 测试、Dart 分析、l10n 检查和 Release 构建通过。APK `whale-companion-go-0.5.0-arm64.apk` 的 `versionCode` 为 `11090857`，SHA-256 为 `cbc7e761af6bd7c5fc5342ddcda783ccca9248dd108619dbc2bb7574746703ea`，与 `0.4.0` 同签名。模拟器覆盖安装保留首次安装时间，Release 正常打开配对页。隔离 SQLite 完整性通过。插件候选 `dsh-companion-bot-0.18.0.tgz` 的 SHA-256 为 `7737fa78d298dc596ae08bda7f268059c961bae17a01535c270fe24eedc1f6d4`。
- 正式 Mac mini 仍运行 Companion `0.15.1`，安卓新版可继续用 WAV。启用手机 PCM 需要宿主候选和已预热的 PCM Provider。正式机同机负载、安卓真机听感和双向麦克风通话单独验收。

## 46. Android 0.6.0 与 Companion 0.19.0 本地语音输入

- 已配对的 Android 聊天页可点麦录音。使用 DSH Go 的 Android 原生录音器和系统权限提示。录音仅在前台生效，最长 15 秒，结束输出内存中的 16 kHz 单声道 PCM16 WAV。点麦前先停止当前播报。取消、切页或退到后台会丢弃当次录音并取消上传，晚到结果不会覆盖输入框。
- `GET /companion-device/api/transcribe` 查询宿主是否配置转写。`POST` 同路径仅接收已配对设备的 `audio/wav`，通过尺寸、时长、PCM 格式和静音检查后转给本机服务。Host 兼容 16、44.1 和 48 kHz，超过范围拒绝。录音不写数据库、任务或媒体目录。端点限制为 loopback，设备凭据不转发，单次推理占一个槽。超时、断连或设备撤销会关闭上游连接。
- 转写结果追加到原有输入草稿，用户编辑并点击发送后进入 `chat.mobile`。回复继续通过“听语音”走 PCM 或 WAV。旧宿主显示转写不可用，文字及已有语音播放可继续使用。

本机试验使用 Apple M5 和已有的 Qwen3-ASR-1.7B MLX 8-bit 模型。两句 3.44／5.92 秒的中文录音各测三次，均正确转写，首句冷推理 1.85 秒，其余五次 265–393 ms。模型加载约 3.52 秒，MLX 峰值约 3.08 GiB。数字只覆盖本机两句样本的推理，完整回合还包含采集、上传、LLM 和播放。 [Qwen3-ASR 官方实现](https://github.com/QwenLM/Qwen3-ASR) · [MLX Audio 本地推理](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/qwen3_asr/README.md)

把 Qwen3-ASR MLX 模型下载至本机后，在独立 Python 3.12 环境安装 MLX、MLX Audio、FastAPI、uvicorn、NumPy 和 SciPy。验证使用 MLX 0.32.4、MLX Audio 0.5.2。使用以下命令启动并预热，`/ready` 通过后将 `asrEndpoint` 配置到 Companion。模型与录音均不随 tarball 分发。 [MLX 量化模型](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit)

```sh
python scripts/run-mlx-asr.py --model-dir "$ASR_MODEL_DIR" --language Chinese --port 18135
curl -fsS http://127.0.0.1:18135/ready
```

```yaml
asrEndpoint: http://127.0.0.1:18135/transcribe
asrTimeoutMs: 15000
```

- 真实 Android 36 模拟器验证系统权限拒绝时零上传、点停止后收到原生录音 WAV、点麦停止 AudioTrack，以及退到后台丢弃录音。虚拟麦克风注入出现句首截断和静音，静音录音被拒绝。完整句的回合测试在隔离接口处换入同一固定测试 WAV，真实 Qwen3-ASR 在 656 ms 返回草稿，确认前零聊天请求。确认后，固定测试回复经真实 VoxWeft 播放并早于传输 EOF 起播。首次 TTS 首包约 3.81 秒，随即重播约 608 ms。模型直接转写带静音首尾的 12.94 秒样本约 910 ms。
- 57 项宿主回归、24 项 Flutter 测试、Dart 分析、文案生成检查和 Release 构建通过。APK `whale-companion-go-0.6.0-arm64.apk` 的 `versionCode` 为 `11091021`，SHA-256 为 `8da9692441577cef217268292a65f014a0dd99e20baa12db56bdd662808f7c3e`，签名与 `0.5.0` 一致。模拟器覆盖安装保留首次安装时间，Release 能冷启动并显示配对页，隔离 SQLite 完整性通过。候选包 `dsh-companion-bot-0.19.0.tgz` 的 SHA-256 为 `31a7d991f45897d0ffb301c0ea6158bdf0b600993405e77ffa0f65e53c0e85b2`。
- 正式 Mac mini 继续使用 `0.15.1`。手机在正式 Tailscale 下的录音与出声、两套模型同机负载、自然判停和自动播报仍待独立验收。

## 47. Android 0.7.0 与 Companion 0.20.0 停顿判停与回复朗读

- Android Companion 的录音器按 20 ms PCM 帧复用 DSH Go 的 `SpeechGate`。连续约 120 ms 确认发声后，连续安静 700 ms 触发停止。仍有 15 秒硬上限，纯静音与短脉冲达到上限时丢弃，不自动上传。保留手动停止、取消、后台丢弃和 WAV 无落盘路径。
- 语音草稿带本次朗读开关，用户确认发送前只编辑草稿。客户端用发送回执的 `sessionId` 与 `messageId` 匹配 `voice.reply.ready`。可缓存先于 POST 回执到达的事件，单次消费。断线、切页、切后台、停止、新录音或新发送清除资格，手动播放优先。
- 只有设备发送入口标记 `companion-mobile`。宿主根据 DSH 真实回合事件识别唯一的手机直接输入，等待 `turn/end` 成功及相应 Session 的持久化 checkpoint 后发出 `{userMessageId, assistantMessageId}`。工具中间回复、中断或多直接输入回合不发通知。事件仅发送给对应场景仍在线的设备订阅，不进入持久游标。旧宿主沿用手动播放。
- 在实际安装的 DSH `0.2.1-rc.5` 隔离 profile 上使用本地 OpenAI 兼容测试模型，先验收 `0.19.0` 的旧版回合，再升级到 `0.20.0`。真实 Agent Loop 的发送和最终回复 ID 完全匹配，收到通知后可立即从持久层读取回复并打开 PCM。管理网页发送不会触发事件，设备重连不补播。
- Android 36 ARM64 模拟器连到同一个隔离 DSH，使用固定测试 WAV 与 PCM 验证确认前零发送、旧主机手动播放兼容、选中时自动在 EOF 前起播、点停立刻停止，以及单次关闭后仍可正常发送。普通键入消息不会自动播报，模拟器纯静音录音达到上限时零上传。HTTP 测试代理刻意延迟发送回执，用于覆盖快回复。判停另以真实音频样本离线验证，不依赖模拟器虚拟麦克风。
- 64 项宿主回归、63 项 Flutter 测试、12 项 Kotlin 测试、Dart 分析、文案检查、Release 构建通过。`whale-companion-go-0.7.0-arm64.apk` 的 `versionCode` 为 `11091053`，SHA-256 为 `74869967717a713d4462c4ddb988d5ebff0bcc43cde5ffb2b58fd1cbf0bcc236`，签名与 `0.6.0` 相同。覆盖安装保留首次安装时间，Release 正常冷启动。`dsh-companion-bot-0.20.0.tgz` 的 SHA-256 为 `a8a0830107838d013afef36419d523faac2a34be54abe2bea325f4371c7ddf78`。
- 正式 Mac mini 只读确认仍运行 `0.15.1`。真实手机环境的误判率、Tailscale 下实际起播和两套模型与 Minecraft 的同机负载仍待验收。

## 48. Android 0.8.0 与 Companion 0.21.0 首句预合成

- 仅在 Android 确认发送勾选朗读的语音草稿时附带 `voiceReply: true`。真实 DSH 增量流里识别 40 字以内的完整中文首句，使用已配置的本机 PCM Provider 预合成。普通消息、工具块、失败、修订和中断沿用原有路径或撤回准备中的音频。
- Host 等待成功回合和 Session checkpoint。设备请求时再次读持久化回复，只有场景、消息 ID 和首句完全一致才取用一次缓存。全文只有首句时直接使用该段。仍有后文时先发首句 PCM，同时合成同采样率的后文。准备未完成、过期或文本不一致时使用全文流。
- 缓存仅驻内存，最多一个候选、8 秒 PCM、8 秒合成、15 秒有效期。普通设备播放与舞台流可抢占正在准备的音频，单槽最多等待 750 ms。首句已经发出后若后文失败，按原有断流策略处理。
- Android 状态页显示最近一次 PCM 请求到首字节、到原生已开始回执的时间。两项从本机发出 HTTP 前起算，保存在内存中。旧 Host 可继续使用原有语音功能。

### 隔离 DSH 与本机 VoxWeft 验收

- 使用 DSH `0.2.1-rc.5` 的真实 Agent Loop、设备配对、WebSocket 与 SQLite。本地测试模型固定中文回复，输出首句后等待约 3 秒才给出后文。TTS 使用已预热的真实 VoxWeft 四步模型、48 kHz PCM。相同回复交替运行三次预合成关闭、三次开启。
- 从设备发出 PCM 请求到收到首包，关闭时为 507、233、226 ms，中位数 233 ms。开启时为 4、5、4 ms，中位数 4 ms。开启的三轮全部命中，首句在最终回复可读前已准备好，后文按顺序接续，合计交付 4.64–5.12 秒 PCM。单独用旧宿主 `0.20.0` 跑一轮，首包为 522 ms。
- 首句与后文相隔约 1 ms 时，设备请求会取消未完成的首句合成，改用全文流，送出约 5.44 秒 PCM。在首句合成中取消整个回合也会关闭上游 HTTP，设备未收到朗读就绪事件。
- Android 36 ARM64 模拟器连接同一隔离 Host。测试代理以固定 WAV 替换原生录音，ASR 返回固定草稿，并延迟发送回执 450 ms。确认前无消息提交，勾选时自动播放，首字节 6 ms、原生起播回执 60 ms，早于传输 EOF。点停成功，关闭本次朗读后仍可发送文字。首包和起播计时从 PCM 请求开始，完整对话还包含录音、判停、ASR、模型生成和扬声器出声。
- 89 项宿主回归、64 项 Flutter 测试、Dart 分析、文案检查、TypeScript 检查、宿主打包、Release 构建和隔离 SQLite 完整性通过。APK `whale-companion-go-0.8.0-arm64.apk` 的 `versionCode` 为 `11091110`，SHA-256 为 `341787cfea8f3c3c2d30598ebf02c1f1ce32e02d277439cc0b783939ddd5e280`。签名与 `0.7.0` 一致，模拟器覆盖安装保留首次安装时间，Release 可冷启动。候选包 `dsh-companion-bot-0.21.0.tgz` 的 SHA-256 为 `7703646647a4987b394158a72d685bc4ede2713d4b635b54782577ba0ffafc07`，已在隔离 DSH 安装验证。
- 正式 Mac mini 仍为 Companion `0.15.1`。正式模型的预合成命中率、手机实录与扬声器、Tailscale 延迟和 ASR、VoxWeft、Minecraft 同机时的负载仍待验收。

## 49. Android 0.9.0 与 Companion 0.22.0 首句续流与分段计时

- 完整中文首句出现后留出 40 ms。助手最终消息在此期间提交时，省略首句推理，设备只请求全文合成。
- 回复通过持久化校验后，若同一首句已缓冲至少 80 ms PCM，可消费同一次正在运行的请求。宿主按顺序发送首句的已缓冲字节及其后续字节，等首句释放推理槽后再合成后文。已完整缓存的首句仍可和后文推理并行发送。
- 首句缓冲不足、过期或改写时走全文合成。继续中的首句受原有 8 秒推理和 8 秒 PCM 限制。设备取消、断连、撤销或宿主关闭会中止关联请求。已发音频后遇到上游失败时终止流。
- 成功的设备 PCM 响应通过 `x-companion-voice-source` 返回 `full`、`prefetch-live` 或 `prefetch-complete`。Android 状态页在收到受支持的标记时显示来源，也分别显示最近转写请求、最近自动朗读的发送至回复就绪／原生起播，以及 PCM 请求至首字节／原生起播的耗时。计时从手机本地事件起算，仅存于内存。

### 本机实测

在 Apple M5 24 GiB 上，使用真实 DSH `0.2.1-rc.5`、实际配对和已预热的 VoxWeft 四步模型。固定台词的测试模型控制首句和后文间隔，每版每档各测两轮。表中的时间从发出 PCM 请求到收到首字节。

| 首句与后文间隔 | Companion 0.21.0 | Companion 0.22.0 | 新版路径 |
| --- | ---: | ---: | --- |
| 约 1–2 ms | 424–642 ms | 213–246 ms | 只合成全文 |
| 350 ms | 244–290 ms | 8–10 ms | 继续正在合成的首句 |
| 650 ms | 258–298 ms | 8–14 ms | 继续正在合成的首句 |
| 1000 ms | 248–253 ms | 8–11 ms | 继续正在合成的首句 |
| 3000 ms | 6–7 ms | 4–9 ms | 复用已合成首句 |

- 六轮首句续流均早于首句上游 EOF 发出首 PCM，通过哈希核对完整输出和顺序。按接收时钟及首句音频时长估算，后文首包提前 407–1192 ms 到达，实际扬声器的连续性需真机复验。取消回合会中断上游，设备未收到朗读就绪事件。
- Android 36 ARM64 模拟器连接同一隔离 DSH。测试代理用固定 WAV 替换模拟器录音，实际通过 Qwen3-ASR 转写，确认前没有提交消息。全文、首句续流、已缓存首句三轮的 PCM 首字节／原生起播分别为 701／726、64／102、100／146 ms，均早于传输 EOF 起播。三种来源标签、点停和单次关闭朗读均通过。发送 HTTP 回执被延迟 450 ms 时，快回复的就绪计时仍为 91 ms。首句续流那一轮含模型 650 ms 人工等待，从确认发送到就绪为 750 ms，到原生起播为 853 ms。
- 真实 Qwen3-ASR 和 VoxWeft 同机常驻。经已配对设备上传固定 WAV，单次转写 474 ms。一轮 ASR 与 TTS 并行时，转写 946 ms，PCM 首包 283 ms。当前进程物理占用快照约为 VoxWeft 10.6 GiB、Qwen3-ASR 2.7 GiB。这些数据来自开发机单次观测。通过 Tailscale SSH 只读确认，正式 Mac mini 的内存为 16 GiB，Companion 为 `0.15.1`。正式机上的 Minecraft、ASR、TTS 并行负载和安卓扬声器延迟待实机验收。
- 93 项宿主回归、66 项 Flutter 测试、Dart 静态分析、5940 项文案检查、宿主构建与隔离 SQLite 完整性检查通过。APK `whale-companion-go-0.9.0-arm64.apk` 的 `versionCode` 为 `11091132`，SHA-256 为 `938ac54463018e0b97065fdf30d016a9ae4caf066f9b0b60b40cb2e117b31e05`，与 `0.8.0` 同签名。Release 覆盖安装保留首次安装时间，冷启动通过。已在实际隔离 DSH 验证的 Companion 代码和资源与最终候选包一致，`dsh-companion-bot-0.22.0.tgz` 的 SHA-256 为 `87980d37ff2c507a7ee5f1ca61067d326de18a80d7580fc6352d9c0b3401850d`。

## 50. Android 0.10.0 连续语音

- 聊天页检测到宿主提供转写和回复就绪通知后显示入口。开始前确认自动发送，输入框有未发草稿或已有回合运行时入口不可用。
- 确认后使用现有 15 秒录音和停顿判停。有效转写自动提交当前场景并请求朗读。回复仍以会话和消息 ID 匹配，转写失败、未收到回复就绪通知或发送失败时结束连续模式。发送失败的文字留在草稿框。
- 原生播放器先确认开始、再发出播完回执，客户端留出 180 ms 后重新开麦。点“打断并说话”则等待播放器停止回执，再执行同样的开麦流程。
- 该模式最长持续 5 分钟。无声、结束、切页、退后台、连接断开或撤销设备都会停止当前语音操作，重连后需手动再开启。原来的逐条转写与确认发送可继续使用。
- 本轮只改 Android，复用现有 Companion 协议。按本轮要求，验证范围为相关 Flutter 回归、静态检查和 Release 构建，暂缓真机和模拟器联调。
- 20 项既有语音回归、4 项新增连续语音回归、Dart 静态分析和 5948 项文案检查通过。Release APK `whale-companion-go-0.10.0-arm64.apk` 的 `versionCode` 为 `11091149`，与 `0.9.0` 同签名，SHA-256 为 `f9ebcfc71e22eab8f96dee4766205aa2d20ae2c28ca63a648249a6110d34d2ab`。

## 51. Companion 0.23.0 Minecraft 经历自主分享

- 在工作台「自主节律」开启后台自主任务、自主动态和 Minecraft 经历分享。新增开关默认关闭，候选由之后新取得的成功回执触发。共享队列最多保留一条待评估的游戏经历，候选有效期为 24 小时。
- 采集、合成、安全回程、建造和完整营地目标会提取物品、数量及结果。营地备料只提交完整父任务。坐标、玩家名、区域名、原始观察和游戏聊天不进入评估输入。
- 独立 `autonomy.minecraft-feed` 会话采用工具执行限制，跳过长期记忆注入。宿主匹配请求消息 ID、会话和完成轮次后才处理决定。她可以沉默，也可以给核验事实附一段不超过 50 字的感受。发布前再次检查授权、免打扰、共用动态冷却和来源状态。
- SQLite v14 为动态增加来源任务外键与唯一索引。工作台显示任务号，现有 Android 动态接口可继续读取。删帖后仍保留来源去重和发布间隔。成功分享会写入可从手机聊天召回的共享经历。旧版本回滚使用升级前的数据库备份。
- 验证范围为定向回归、隔离数据库迁移和构建。本轮按要求跳过真机、真实模型和正式 Minecraft 服务器联调。
- 10 项游戏回执、去重和分享调度回归以及 5 项既有记忆回归通过。上一版隔离数据库副本从 v13 升到 v14 后，设备、场景、任务、活动和测试动态的数量保留，父帖与回复关系、SQLite 完整性和外键检查通过。宿主与移动端 TypeScript 检查、构建和 7 份文档检查通过。候选包 `dsh-companion-bot-0.23.0.tgz` 的 SHA-256 为 `e6a83bed68efca1c3f1b3b0a0cd497070dd41bd08b2ad29e2b1735f6ca6e0a30`。

## 52. Companion 0.24.0 限时营地补给

- 在工作台 Minecraft 页选择已授权的营地并授权一次自主补给。最多有一份有效授权，15 分钟后到期。免打扰期间推迟评估；条件不符时不请求模型，留在窗口内低频重新检查。
- 只对已在线且空闲的 CBI 角色开放。角色需与授权区域处于同一维度，水平位置在区域内，高度差最多两格，当前无已知威胁，血量至少 16，饥饿至少 12。同种原木至少三根且木板总储备不足八块时，宿主提供一项白名单配方，消耗一根原木，保留至少两根同种原木。
- 角色在独立评估会话中只能选择合成或跳过。匹配完成轮次后，宿主与 worker 在下发前再次核对实际条件。动作是原地执行一次木板配方，成功以配方回执和实际增加 4 块木板为准。
- 可以在工作台撤销授权。停止动作、撤销区域、断线和关闭后台自主任务也会终止授权。若指令已发出则以实际回读为准；无法确认时提示核对背包。服务中断后不重试已开始的合成。
- 成功的补给同时保留自主任务和真实合成回执，并写入共享记忆。已有游戏经历分享流程可按其开关评估该回执。
- 16 项调度与既有分享回归、3 项执行回归和 8 条进程内管理接口断言通过。执行回归覆盖配方排队时取消、库存核验和区域撤销。宿主及移动端 TypeScript 检查、构建、打包和 7 份文档检查通过。候选包 `dsh-companion-bot-0.24.0.tgz` 的 SHA-256 为 `3a43e10afda69da9bf01bb3faaf76747dd32edfd4c469a00de0cf46ad11db65e`。本轮验证使用测试替身和本地构建，按要求暂缓真机、真实模型和正式服联调。

## 53. Companion 0.25.0 授权自主搭建

- Minecraft 工作台的每个授权区增加「授权一次自主搭建」。搭建和木板补给共用 15 分钟授权机制，每份授权只含一个目标。免打扰、到期、撤销、断线和停止沿用原有规则。旧版持久任务缺少目标字段时按木板补给处理。搭建授权使用单独的区域字段，回滚到 0.24.0 时会被旧解析器拒绝。
- 角色已上线、空闲、处于授权区且生存状态达标，背包已有 8 块同种木板和 1 个工作台时，宿主才给出确定的建材选项。模型只决定搭建或跳过。未备齐时保留在授权窗口内等待。
- worker 在取得独占动作位后再次观察位置、维度、威胁和库存，复用现有 CBI 3×3 营地动作。施工使用已核验的建材，保留原有地形、实体、方块占用和区域限制。
- 搭建需在授权维度确认区域内的 8 块地板和 1 个工作台，并核对实际扣料。撤销会请求停止后续放置，已放置的部分保留。停止或完工回执不完整时提示核对现场和背包，任务不会自动再下发。
- 完成后，工作台可查真实建造任务号，游戏经历进入共享记忆，并按既有自主动态设置参与分享评估。
- 21 项调度与分享回归、7 项 worker 和宿主执行回归、9 条进程内管理接口断言通过。执行检查覆盖授权区与库存复核、九个方块的授权维度回读，以及已下发后只排一次停止并持有动作位直至停止应答。宿主和移动端 TypeScript 检查、构建、打包及 7 份文档检查通过。候选包 `dsh-companion-bot-0.25.0.tgz` 的 SHA-256 为 `c17585d064a71828acbdd8afa8a022a403288578ec2239f0a134a5e64de42b9e`。本轮用测试替身验证，真机、真实模型及正式服务器联调按要求暂缓。

## 54. Companion 0.26.0 授权备料并搭建

- Minecraft 工作台为既有授权区新增「授权一次备料并搭建」。它与单次补给、单次搭建共用 15 分钟授权机制。角色决定开工或跳过，宿主根据真实回执执行后续步骤。准备授权使用独立区域字段，回滚到旧宿主时旧解析器会拒绝该任务。
- 背包需已有工作台。宿主根据同种木板和对应原木的库存选定一种木材，优先合成次数少的可用方案。8 块木板齐备就直接搭建，缺料时最多合成两批，并保留至少两根同种原木。初始材料和批次上限在后续步骤中锁定。
- 每一步重新检查期限、授权区、免打扰、位置、维度、威胁、空闲状态和库存。worker 继续使用独占动作位，逐批回读新增 4 块木板和减少 1 根同种原木。搭建继续要求授权维度的 8 块地板、1 个工作台和实际扣料回执。
- 每个确认步骤关联真实子任务号。撤销、条件变化或失败会停止后续步骤，已完成的合成或放置保留。整个目标只在最终完整建造回执通过后记为成功。已确认的部分备料可以单独写入共享记忆，发布分享只评估完成的建造回执。
- 23 项调度与分享回归、15 项宿主与 worker 执行回归、11 条进程内接口断言通过。验证覆盖材料齐备直接搭建、两批备料、库存变化阻止扩批、观察后撤销、扣料回执缺失以及部分回执和记忆。宿主及移动端 TypeScript 检查、构建、打包和文档检查通过。候选包 `dsh-companion-bot-0.26.0.tgz` 的 SHA-256 为 `7fea44900426fd0607b21a791d8b763c7325258efa75c585e89d84bb864c0ef6`。本轮使用测试替身，按要求暂缓真机、真实模型和正式服联调。

## 55. Companion 0.27.0 与 Android 0.11.0 小家

- 工作台与 Android 均可打开「小家」。它们在各自的房间图上复用宿主提供的语义位置。游戏动作移到电脑前，Live2D 正在朗读时移到舞台，聊天移到沙发，免打扰时段内空闲在床边，其余在线空闲在窗前。离线时房间不显示角色位置。
- 多项信号并存时依次采用游戏动作、舞台播放、绑定的聊天或话题回合。Minecraft worker 在既有本地事件轮询中报告正在执行的动作，失效或停止后退出游戏状态。舞台须同时有有效心跳与播放中的音频分段。内部记忆整理和自主评估不触发聊天状态。休息沿用宿主配置的本地免打扰时段，房间展示不改变调度或游戏行为。
- `/companion/api/state` 和配对设备的 `/companion-device/api/state` 新增可选 `home` 字段。沿用既有鉴权、`schemaVersion: 2` 和 SQLite v14。房间最近活动最多四条，仅含白名单类型和时间。聊天正文、动态正文、身份标识及世界坐标不进入房间字段。
- Android 连接旧宿主时显示兼容提示，连接失败时不继续显示过时的位置。小家在前台打开时复用状态刷新。工作台沿用已有轮询。房间使用原创布局，社区建筑和观看场景留有后续位置扩展。
- 6 项新增宿主检查、18 项相关游戏与语音回归、12 种网页静态渲染场景、5 项 Flutter 定向检查通过。宿主接口测试使用本地配对、撤销与隔离数据库，核对了旧健康检查响应和两端房间快照。Dart 分析、双语文案、宿主与移动端 TypeScript 检查通过。候选包 `dsh-companion-bot-0.27.0.tgz` 的 SHA-256 为 `c1e2d80349de865637afcb57ad9c53a9ab76044f0a59ffb171e0ef3fa19a7103`。
- Release APK `whale-companion-go-0.11.0-arm64.apk` 的 `versionCode` 为 `11091450`，与 `0.10.0` 使用相同签名，SHA-256 为 `a3e9347f0f4aef909b653ee2122aa314ab4f36471e999f09e89254173d4b136a`。本轮使用本地定向检查与构建，真机、模拟器、浏览器和正式服务联调待集中验收。

## 56. Companion 0.28.0 与 Android 0.12.0 聊天附件和 B 站浏览

- 安卓聊天沿用 DSH Go 的文件选择和草稿，允许图片、文件与文字一起发送，也可只发附件。每条最多四件，原始字节合计 8 MiB。宿主复用 DSH 原生附件存储，图片经原生校验和规范化，其他文件按原始字节保存。历史返回附件标识和展示信息，配对设备下载前核对附件属于指定场景当前可见历史或已接受队列中的消息。发送失败时保留草稿，同设备、同会话、同草稿重试复用已接受消息。旧宿主隐藏入口，继续支持原有文字与语音。
- 工作台「B 站」可按 BV 号或完整视频链接读公开资料，选中分 P 后可按需请求字幕。专用 `world.bilibili` 话题注册 `companion_bilibili_read`，普通聊天、游戏和内部任务不开放该工具。来源文字作为视频材料交给会话，控制调用范围由宿主负责。
- B 站连接器每次最多一个操作，合计 8 秒，每分钟最多 16 个上游请求。元数据最多缓存 32 条和 2 分钟。字幕回查使用公开 WBI 播放器与选定分 P，截取最多 12 句和 1200 UTF-8 字节。这是返回片段的字节预算。接口访问仅发送公开读取请求。
- 资料查询和实际字幕片段各有回执。小家只显示专用会话真实取得字幕片段的类型和时间，视频文字不会进入房间字段。公开视频的可读字幕取决于上游提供和身份核验。 [B 站参考与约束](references.md#视频浏览与-token-预算)
- 19 项新增定向检查覆盖附件协议、B 站预算与字幕核验、工作台权限和小家投影。20 项既有语音与状态接口回归通过。隔离的 DSH `0.2.1-rc.5` 原生附件存储通过中文文件名、原始字节、PNG 读取与重复保存检查。单次匿名联网读取用户给出的 `BV1dLx46TEhw`，取得真实分 P 资料，回执为 `video.inspected`。真实字幕成功路径仍待验收，本轮以测试夹具验证。宿主和移动端 TypeScript 检查及构建通过，候选包 SHA-256 为 `d578df98142aa6ee0faee8336aec87751b69be16a350c898537bcb6a6100d10e`。
- 17 项 Flutter 定向检查、Dart 分析和双语文案生成通过。Release APK `whale-companion-go-0.12.0-arm64.apk` 的 `versionCode` 为 `11091502`，与 `0.11.0` 使用相同签名，SHA-256 为 `1985e1184802218301fbc421ad2b70b25c58788333fc8e39126c72a6ede9b23e`。Android 系统选择器、另存和正式宿主联调待集中验收。当前附件读取范围随 DSH 会话历史变化，压缩前已移出可见历史的附件不从此接口取回。若导入后发送取消，DSH 可能保留未引用的原生对象，仍由 DSH 管理其存储生命周期。

## 57. Companion 0.29.0 与 Android 0.13.0 授权 B 站浏览

- 工作台「B 站」支持加入、撤回候选和查看结果。按 BV 与分 P 去重，最多 20 条同时等待或读取。主人备注留在管理工作台和授权评估输入，配对设备的状态接口省略队列。
- 「自主节律」里的 B 站自主浏览默认关闭，开启后沿用主开关和宿主本地免打扰，默认评估间隔 240 分钟，可设 30 至 1440 分钟。独立评估 Session 只向模型发送当前提示和至多五条授权候选，可选读一条、略过一条或稍后再决定。系统匹配真实用户消息、会话和完成轮次后才执行，评估 Session 禁用工具和自动记忆注入，旧决定留在本地会话日志。
- 宿主在开始读取前重新核对授权，并把领取和冷却写入同一 SQLite 事务。撤回与关闭会中止尚在执行的读取。重启先核对对应候选、分 P 和活动编号，已取得回执的读取恢复为成功，其余中断读取不重放。实际成功才关联共享经历，区分查阅资料和取得字幕片段。
- 网页和安卓小家增加手机阅读角。大肥鱼实际读取时才切换位置，轮询间隔内结束的动作可能只留下可用回执。字幕正文不进入小家或自动写入共享记忆。
- SQLite 从 v14 增量升级到 v15。正式更新前保留升级前数据库备份，旧宿主拒绝直接打开 v15。此轮升级验证使用前一版候选包创建的隔离库。
- 16 项自主浏览调度检查、23 项既有 Minecraft 回归，以及队列、B 站连接器、状态接口和记忆投影定向检查通过。隔离迁移核对旧场景、动态、SQLite 完整性和外键。宿主、工作台和移动端 TypeScript 检查、构建及打包通过。候选包 SHA-256 为 `462bb3c9e1a5e0e47767718ffdda268685b5371b66007236e2ebc2e4a4358198`。
- 4 项 Flutter 小家检查、Dart 分析与双语文案检查通过。Android Release 的 `versionCode` 为 `11091510`，与 `0.12.0` 同签名，APK SHA-256 为 `e8bb7a4a443a43c4f412e9ddbb5c8c7d04b422d8d33c15b5ff7a03d76baef89b`。自主读取使用模拟模型与网络测试，暂缓真机、真实模型和正式环境联调。

## 58. Companion 0.30.0 歌唱与阅读反思

- 「歌唱」工作台可填歌名、歌词、风格和 10–60 秒目标时长。主人也可在 `world.singing` 专用话题请大肥鱼提交。`singingApiOrigin` 留空时关闭生成，配置后只请求明确的本机 ACE-Step HTTP 端口，例如 `http://127.0.0.1:8001`。读取同一任务生成的 WAV，默认总超时 180 秒。 [ACE-Step 接口文档](https://github.com/ace-step/ACE-Step-1.5/blob/ca1e85fe9430179831e6bc6be790c332190a3866/docs/en/API.md)
- Companion 一次接受一首。中断后保留任务状态，重启不自动重放。取消会终止本地等待和未提交归档，ACE-Step 可能继续执行。已知的上游任务在同一进程内仍会挡住重复提交，直到获得终态。引擎自身的临时音频由引擎管理。
- WAV 必须为非静音 PCM16，最长 65 秒、最大 24 MiB，实际时长不得短于目标 5 秒以上。核对后以私有文件归档，歌曲任务、哈希和回执一起保存。工作台鉴权读取相同的核验字节并支持 Range。媒体重扫保留原始哈希和任务关联，歌曲采用保留策略。
- 「自主节律」新增默认关闭的 B 站反思开关。只有从自主阅读真正取得字幕片段的结果才可排队，一次最多一个反思。模型可跳过，或写一条简短个人观察并附逐字证据。宿主核对 BV、分 P、原句、时间及真实回执，结果进入场景私有的候选记忆，任务页可打开查看。旧材料不会混入本轮模型请求。
- 反思材料最长等待 24 小时。撤回开关会取消待处理或进行中的反思，终态任务清掉原字幕载荷，原样引文与引用编号进入候选记忆。本地 DSH 会话日志仍按原有规则保留本轮输入。SQLite v16 防止旧调度器打开可含反思任务的库，回滚使用升级前备份。
- 7 项 ACE-Step 本地协议检查、7 项歌唱任务与媒体归档检查、3 项宿主接口检查、42 项 B 站调度与记忆检查、18 项既有 ASR 和语音流检查通过。用 `0.29.0` 创建的隔离 SQLite v15 库迁移到 v16，既有绑定和 B 站候选保留，完整性、外键及旧宿主拒绝打开验证通过。打包通过，候选 SHA-256 为 `e80d388a70cbcc69d8e5de939514f89b232b495ae66a978efe11805fbcd10e0a`。
- 本机未发现可用的 ACE-Step 模型或服务。本轮以隔离 HTTP 和模型测试替身验证，实际唱声、大肥鱼音色、真机和正式环境联调留待集中验收。短歌试听入口目前在工作台。

## 59. Companion 0.31.0 与 Android 0.14.0 手机试听与导唱转换

- 已配对设备可读取最近最多 20 首已完成并登记的歌曲。设备列表只含曲目与文件展示字段，下载前重新验证 WAV 哈希，支持 Range 和 HEAD。每个设备同时一次下载，撤销凭据可中断尚未完成的响应。手机入口在「状态」页，复用原生 WAV 播放器，退出页面、退后台或发现配对已撤销会停止并清理临时文件。
- 工作台「歌唱」增加「转换导唱声线」。主人提交 3–60 秒的非静音 PCM16 人声 WAV，大小最多 24 MiB。宿主只调用明确配置的离线 Seed-VC v1，开启 F0 条件，关闭自动移调和半精度。`seedVcPythonPath`、`seedVcRepoDir` 与 `seedVcReferenceAudio` 一起配置，均用绝对路径。安装和缓存模型后，推理用离线模式运行。 [Seed-VC CLI](https://github.com/Plachtaa/seed-vc/blob/51383efd921027683c89e5348211d93ff12ac2a8/README.md)
- 转换和按歌词生成共用单任务限制、WAV 格式与哈希检查、私有归档和收听入口。用户上传的导唱只作为本次任务的临时输入，完成、失败和正常取消后清理。取消向本地转换进程发送停止信号，当前 SQLite 仍为 v16。
- 固定验证 Seed-VC `51383efd921027683c89e5348211d93ff12ac2a8` 和 44.1 kHz SVC 模型。附带的 `run-seed-vc-svc.py` 在进程内把 Apple GPU 的 F0 张量转为 float32，并让 torchaudio 输出 PCM16。检查点留在隔离缓存，候选包仅包含桥接脚本。 [Seed-VC 模型](https://huggingface.co/Plachta/Seed-VC)
- 在 Apple M5 24 GiB 上，8.0 秒的 CC0 人声音阶作为导唱，大肥鱼的本地 6.83 秒参考音频作为目标。候选的 `SingingService` 经真实模型完成 30 步离线转换、核验、归档和列表读取，成品为 7.999 秒、44.1 kHz 单声道 PCM16，共 705,580 字节。并行核验与模型加载计入约 50 秒的完成时间。单独的 15 步音阶检查中，四个有声窗口的中位音高与导唱差为 +30、−10、0、+5 音分。音色相似度、带歌词和伴奏的完整听感留待验收。 [导唱来源](https://freesound.org/people/mooncubedesign/sounds/442571/)
- 14 项宿主定向检查、28 项 Flutter 定向检查、Dart 分析、双语文案和两端构建通过。Companion 包 SHA-256 为 `efc8918fb7fd1c5d1f7120fd3af7855400249b87c425cdcefeac8b7103b075b6`。Android APK 的 `versionCode` 为 `11091538`，与 `0.13.0` 同签名，SHA-256 为 `70594198f5a999f6f7aba2558ca0bb7d9286de3111fce3b11b0a37ca742fa491`。真机及正式环境联调暂缓。

## 60. Companion 0.32.0 与 Android 0.15.0 伴奏和舞台歌唱

- 「歌唱」中的导唱转换可另选 PCM16 WAV 伴奏，每轨最多 24 MiB。先转换人声音色，再将伴奏线性重采样到人声采样率，两轨对齐起点。伴奏不足补静音，超出人声时长裁齐。默认音量为人声 −2 dB、伴奏 −10 dB，可各自调整，超出混音峰值上限时整体衰减。
- 可从归档曲目选中舞台歌曲。舞台先启用 Web Audio，再由工作台对当前 iframe 的已就绪标识提交播放。归档 WAV 在宿主核验后发给指定舞台，歌曲与实时朗读共用一个播放位置。
- 舞台报告实际起播、结束或停止。宿主核对对应舞台、音频交付与完成时间后记录 `song.played`，旧舞台心跳失效时不会产生成功回执。通用管理入口拒绝创建或更改舞台歌唱任务及提交此类播放回执。当前口型随播放成品音量变化，混入伴奏时使用整轨能量。
- 网页和安卓小家识别舞台歌唱及完成回执，最近活动仅显示类型和时间。手机仍可从「状态」打开已归档的混音成品。SQLite 仍为 v16。
- Apple M5 隔离环境用 15.24 秒的 CC0 英文带词导唱及自制 48 kHz 立体声伴奏，经离线 Seed-VC 转换、混音、私有归档和哈希复核。成品为 15.23 秒、44.1 kHz 立体声 PCM16，峰值 −2.4 dBFS。转换到成品验证用时 53.4 秒。音色相似度与口型观感留待试听。 [导唱来源](https://freesound.org/people/Ehved/sounds/726747/)
- 混音与归档 16 项、宿主舞台及语音 17 项、浏览器播放逻辑 20 项、小家接口及投影 7 项、Flutter 小家 5 项定向检查通过。两端打包与 APK 签名检查通过，APK `versionCode` 为 `11091550`，签名与 `0.14.0` 一致。Companion 包 SHA-256 为 `35d106e73cdf02372f2a8822ce0330eff0ad1b0f3c1e72c4da9db8d64174a479`，APK SHA-256 为 `9259db30453ca84c3f636433430985bffe75d6a64017e1a75a0c7ff35b5700a2`。舞台听感、安卓真机和正式宿主联调留待集中验收。

## 61. Companion 0.33.0 与 Android 0.16.0 情境舞台和互动小家

- 已就绪的前台舞台从现有心跳读取活动类型，与小家共用宿主状态判定。聊天、Minecraft、阅读、休息、朗读与歌唱各有轻量头部和视线姿态。客户端五秒后撤下过期姿态，隐藏、离线或心跳失败会清除姿态。可在舞台关闭情境姿态，也遵守系统减少动态效果设置。情境姿态不产生动作任务或活动回执，口型仍由实际音频驱动，显式动作优先。
- 模型可用 `companion_avatar_action` 请求点头、摇头、抬手示意或脸红。新动作以 1.2 秒的有界参数曲线执行。宿主只向指定的健康舞台交付任务，核对同一舞台的开始、经过时间和渲染帧推进，再持久化成功回执。后台标签页、超时和断线取消未完成动作。通用任务和事件入口无法代写舞台成功。
- 网页与安卓的小家可查看六个家具点位。选中位置仅显示说明和功能入口，角色位置仍由当前活动决定。安卓可从沙发进入聊天、从电脑桌进入活动、从舞台打开已归档歌曲。断线会保留已同步的回执，位置自动过期，配对撤销后隐藏缓存回执和快捷入口。
- 网页小家下方的社区地图用同一套原创 SVG 配方绘制小屋、声演工坊和阅览室，门和地基锚点与道路连通。点选建筑可回房间、打开 Live2D、歌唱、B 站或动态。社区当前记录浏览选择，角色的活动位置仍以房间里的宿主状态为准。 [参数化建筑参考](https://github.com/Zengkailin/parametric-topdown-pixel-architecture)
- 宿主 24 项、舞台驱动 11 项和 Flutter 小家 7 项定向检查通过。隔离 Chrome 在 360px 和 1040px 宽度验证社区图与入口。两端构建通过，ARM64 APK `versionCode` 为 `11091606`，沿用 `0.15.0` 签名。Companion 包 SHA-256 为 `504a6abb9ef30944bfa653d96c4dd555430b681eb0fa084463bdd59d862759c5`，APK SHA-256 为 `7e55508e9055f11c71d457c71a3930caa2ab72b4e569a297d35e525553c84d65`。本机缺少私有舞台 Core 与模型配置，私有模型渲染、安卓真机和正式宿主留待集中验收。SQLite 仍为 v16。

## 62. Companion 0.34.0 营地往返勘察

- 工作台 Minecraft 页可从真实位置授权一个半径 2–8 格的营地区域，原默认值仍为 4。半径至少 5 格且 CBI 明确声明勘察能力时，可授权一项 15 分钟的往返勘察。区域与该次执行授权分别登记。旧 CBI 继续开放已探测到的原有能力。
- CBI 从营地中心检查四个方向，只提供同维度、平整、干燥且有连续落脚面的路线。角色在独立的无工具决策场景选择一个已确认方向或跳过。宿主下发前再次预检，Java 收到执行命令时重新核对场地与角色状态。旧版不能把 `surveyZoneId` 当成补给授权。
- Carpet 假人从中心沿直线步行 4 格后原路返回。服务端逐 tick 检查路线、位置、健康和威胁，禁止走通用 Baritone 寻路。勘察本身不传送、不挖掘、不放置。接近外端和营地中心都要观察角色停稳。超时、危险、地形变化或越出走廊会停下，未确认回程时需以现场位置为准。
- Java 命令仅接受发给假人的 worker 自发指令。worker 以独立 ID 轮询执行状态，取消按同一 ID 提交。全局停止、撤销区域、授权到期及进入免打扰也会中止。取消和断线均不会重发执行命令。
- 完成需要 CBI 的同次外出与回程回执、worker 独立回读营地坐标和维度，以及宿主检查授权和任务仍有效。工作台显示方向和子任务回执，小家复用「完成回程」。共享经历引用游戏子任务与角色决策事件，保留方向、距离和时间，省略精确坐标。独立手机聊天 Session 可按相关问题召回。
- 宿主和小家 16 项、worker 10 项、授权调度与跨场景召回 31 项定向检查通过。Java 150 项 JUnit 检查通过，含 5 项勘察用例。Companion `pnpm pack` 通过，SHA-256 为 `80be4412f1065ae7aea48ea1545510e0ed4bb3047197570b8d9e706a15fb27eb`。 [CBI JAR](../建设bot参考/carpetbaritoneintegration-v1.7.1+260820-survey-0.34.jar) · [完整对应源码](../建设bot参考/CarpetBaritoneIntegration-survey-0.34-20261109.tar.gz)
- 本地隔离 Minecraft 1.21.1 Fabric GameTest 以同一版 Java 实现运行真实 Carpet 假人。预检只开放东向，假人实际外出 3.9375 格并在距起点 0.0127 格处回到同一营地格，沿线五列的地板和空气逐块回读一致。游戏回执为 `phase=succeeded reached=true returned=true`。正式 Coopcraft 留待集中联调，本轮安卓沿用 0.16.0。

## 63. Companion 0.35.0 闲置会话整理和压缩

- 工作台「自主节律」新增默认关闭的后台压缩开关，需要后台任务和记忆整理均启用。宿主只检查已在线的各自场景 Session。最新实际成功回合空闲满 30 分钟，模型输入达到其上下文窗口的 30%，并且同一 Session、同一回合已经记忆整理时，才会申请一次压缩。输入包含 DSH 分开报告的未缓存、缓存读和缓存写 Token。窗口或输入数据不明时跳过。
- 记忆整理冻结触发回合的原始对话片段，并为每次整理新建独立系统 Session，只给 curator 当前场景原文及少量可访问的相关记忆。候选带来源，自我观察的引文须经逐字核对。两者与该轮完成回执一起保存，合法的空结果也登记已整理。原场景换绑、后续回合覆盖整理任务或输出关联不上时，会丢弃旧草稿。候选沿用原有晋升规则。
- 宿主调用 DSH rc.5 的 `compactNow`，由原生维护锁、范围选择及日志刷新负责压缩提交。全局同时最多一个，每个源回合只申请一次。新输入、暂停、换绑和服务停止会取消维护请求，保留用户输入队列。原生引擎的已有前台压力处理及溢出恢复仍由 DSH 管理。
- 压缩只替换模型读取的历史范围。工作台和手机从原始消息事件读取历史，保留旧消息 ID、附件下载和重试去重。SQLite 仍为 v16。活动只显示来源回合、输入占用和被替换范围的估算 Token，压缩收益以之后实际请求为准。
- 隔离环境使用本机安装的 DSH rc.5 Basic 压缩引擎、真实 Session 与 TokenMeter，并用固定摘要替代模型请求。压缩将模型可见节点从 8 个减至 2 个，保留 26 条原始事件并写出 30 条事件的测试日志。取消用例保留全部 8 个模型可见节点。被替换范围估算为 4,474 Token，未调用收费模型。
- 记忆整理及相邻调度回归 80 项、语音回归 28 项均通过。闲置调度、原生适配和历史附件也分别通过定向检查。Companion 包 SHA-256 为 `151d7ae2d3c2709acdfe16e69b5da6c8d264c7c2c1de886d3775248eec6deee9`。安卓使用现有 0.16.0，正式宿主和真机留待集中验收。

## 64. Companion 0.36.0 长期记忆权重和可恢复归档

- 默认召回仍按相关度筛选。只有确实注入本轮上下文、与新进队列的用户文字强匹配的活跃记忆，才能累计长期强化。每条记忆每个 UTC 日最多一次，跨场景共享记录也合用该上限。自动锚点、模型工具、重放和 Minecraft 环境提示仍各自按原有权限处理，均不增加强化次数。
- 长期权重与重要度、置信度、普通召回次数分开保存和展示。重复强化的收益趋缓，权重随时间衰减，半衰期随强化次数从 35 天逐步接近 90 天。候选不会因为反复检索自动转为活跃。旧召回次数保留，强化计数从本版开始。
- 工作台可逐条归档和恢复，也可先预览正文片段再选择批量归档。批处理最多 50 条，要求重要度低于 0.4、长期权重低于 0.35，且创建、修订、使用、强化均已至少 60 天。固定锚点及置信度达到 0.8 且有事件、任务或活动来源的记录受自动规则保护。应用时重查条目状态及最新使用情况，跳过已经变化或不再符合条件的条目。
- 归档保留原文、场景范围、来源和修订历史，恢复时回到原来的候选或活跃状态。归档与遗忘分别展示，普通检索和模型工具都排除归档项，管理工作台可以按关键词检索归档。后台归档默认关闭，开启后也受自主任务总开关控制，每 24 小时至多一次，不调用模型。
- SQLite 迁移至 v17。由 `0.35.0` 安装包创建的隔离 v16 数据库升级后，四条旧记忆、五条原修订和手机绑定均保留，候选归档后可恢复。SQLite 完整性和外键检查通过，旧宿主拒绝打开 v17。回滚宿主需使用升级前的备份。
- 仓库层 5 项、召回及相邻流程 42 项、宿主接口和后台任务 17 项定向检查通过。隔离 Chromium 核验了预览勾选、提交跳过、中文归档搜索、恢复、锚点保护和后台开关。Companion 包 SHA-256 为 `c23d8e610857a1edcfecab0cb97cb71c33b0d7b42f98c7f3d4b9d2935b417796`。安卓沿用 0.16.0，正式宿主和真机留待集中验收。

## 65. Companion 0.37.0 Live2D 桌面与 OBS 展示

- 工作台「形象 → 桌面与 OBS 输出」可启停、刷新、复制 OBS 地址及打开桌面窗口。只允许主人启停，宿主重启后默认关闭。旧宿主仍可使用既有舞台和语音操作。桌面窗口提供背景和 65%～100% 缩放。
- 镜像只在 Companion 同机的 `127.0.0.1:18790` 监听。OBS 使用 `http://127.0.0.1:18790/?mode=obs`，建议设为 1280 × 720 和 30 FPS。透明画面不显示控件。主舞台负责音频，OBS 的声音按现有采音设置接入。 [OBS Browser Source](https://obsproject.com/kb/browser-source)
- 两种画面共用 Live2D 渲染和动作代码。镜像跟随当前活动、主舞台已经起播的动作进度及真实播放的近期口型采样。动作结束后回到情境待机，过期口型归零，展示连接丢失时画面淡出。主舞台继续认领动作和提交回执。
- 镜像接口只读，只提供画面所需的状态、程序和模型清单资源。会话、设备令牌、聊天原文、音频文件、动作执行入口和任务标识均不进入镜像。SQLite 保持 v17，私有模型及 Cubism Core 继续由本机提供。
- 40 项定向检查通过，工作台入口在隔离 Chromium 通过启停、剪贴板回退、独立窗口和旧宿主兼容验证。用用户提供的真实模型在 Apple M5 Chromium 验证了 1280 × 720 RGBA 画面、509 个参数无非有限值、活动联动、抬手镜像和唯一主舞台完成回执。OBS 应用里的场景、真实音频路由及正式设备验收留待集中完成。
- Companion 包 SHA-256 为 `96c9edac7dece6c298e2198845667789c2c25c7bf60b6453158c0529627be666`。安卓继续使用 DSH Go 0.16.0。

## 66. Companion 0.38.0 可变距离勘察与提前回程

- Minecraft 页继续使用原有一次性 15 分钟授权。新版 CBI 对四个方向各提供最长可确认直线路线，单程 4～7 格，且至少比授权区半径少一格。角色在独立无工具会话选一个方向或跳过。宿主下发前重新预检同一距离，服务端执行时再次检查真实路线。旧 CBI 保留原四格协议。
- 假人从营地中心出发，以生存模式步行，逐 tick 检查位置、健康、威胁和落脚点。前方发生地形变化时，仅在确认当前位置和身后整段路线安全的条件下提前折返。返回途中持续检查来路。来路受阻、受到威胁、偏离走廊、超时、停止或撤销时中止；未得到确认时以现场位置为准。勘察动作只移动和转向。
- worker 核对同一命令 ID、同一距离及回执状态，再独立回读维度和营地中心。宿主仅在授权仍有效时接纳结果。完整往返与确认提前回营分别显示，后者只记录已核验的回程。共享记忆引用角色决策和游戏回执，保留方向、结果和时间，不记录精确坐标。
- Java 153 项、Companion 与 worker 86 项定向检查通过。隔离 Minecraft 1.21.1 Fabric 的 4 项 Carpet GameTest 验证了旧版四格、七格完整往返、前路变化后提前回程和来路受阻。七格实测最远 6.981 格，回到距起点约 0.013 格处。提前折返用例最远 2.872 格，回到距起点约 0.013 格处。来路受阻用例停在距起点约 2.891 格，回执为 `returned=false`。隔离 Chromium 核验工作台新旧状态、回执文案与授权条件。
- 单独启动仅监听回环地址的 Minecraft 1.21.1 Fabric 服务，加载候选 JAR，接入打包后的 worker HTTP 和 Companion 宿主。固定的角色决策驱动了完整七格往返及实际行走后的提前折返，两次均核验营地位置并写入带两个来源引用的共享记忆。独立手机 Session 的检索上下文收到了提前折返经历。 [Fabric 服务端启动方式](https://fabricmc.net/use/?page=server)
- Companion 包 SHA-256 为 `6d5a184a72cd34a94bab1d81817edc1be62b92b45e9b702feda8fa35186b8ebd`，CBI JAR SHA-256 为 `6848d6eae2d3032cf8e997402d4a35442334b5d5addd74758fcd608b5f9bb03b`。SQLite 保持 v17，安卓继续使用 0.16.0。正式 Coopcraft 与真机留待集中验收。 [CBI JAR](../建设bot参考/carpetbaritoneintegration-v1.7.1+260820-surveyroute-0.38.jar) · [对应源码](../建设bot参考/CarpetBaritoneIntegration-surveyroute-0.38-20261109.tar.gz)

## 67. Companion 0.39.0 双段勘察与检查点

- Minecraft 页沿用一次性 15 分钟勘察授权。支持 `surveytrail` 的 CBI 可在八种先后方向组合中预检可走的 L 形路线。每段四格，拐点和终点都要在授权区内。角色在独立无工具会话从已核验的双段或直线路线中选择一次，也可跳过。旧 CBI 保留其直线能力。
- 服务端要求假人在拐点、终点及营地中心停稳。回程以相反顺序逐段重走，并在返回拐点时再次停稳。前路变化时，只有当前位置、来路和转弯处仍安全才允许提前返回。来路受阻、威胁、撤销、停止或越界会中止移动。
- worker 核对命令 ID、选定的方向组合、单调的检查点数量与回执阶段，并独立回读营地中心和维度。宿主在执行前重新预检同一条路线，并复查授权和子任务状态。工作台和共享记忆分别记载两个检查点完整往返与确认提前回营，提前回营只记录真实到达的 0 或 1 个检查点。记忆引用游戏回执和角色决策，省略精确坐标。
- Java 159 项、裁剪 SDK 27 项、Companion 与 worker 112 项定向检查通过。Minecraft 1.21.1 Fabric 的 8 项真实 Carpet GameTest 包含 4 项旧版单段回归，以及双段完整往返、拐点后折返、来路受阻和全局停止。完整往返与提前折返均停在距起点约 0.074 格处，受阻与停止用例均为 `returned=false`。隔离 Chromium 验证了新旧能力、检查点显示及原有授权请求。
- 独立回环 Fabric 服加载最终 CBI JAR，与打包 worker 和真实 Companion 宿主联调。用固定决策执行东转南完整往返及进入第二段后提前折返，分别得到 2 和 1 个检查点，两次都回到距中心约 0.065 格处并写入共享记忆。独立手机 Session 可召回折返记录。进入第二段后撤销授权的用例收到同一命令 ID 的取消回执，停止后测得约 0.039 格残余位移，没有生成回营记忆。
- Companion 包 SHA-256 为 `832a38febf6fb1f47393c178122eb3c2c1ea25cfcf31b64ebe06463eb701ba34`，CBI JAR SHA-256 为 `8f216d2570771041927318e0989a1e361b5fe34bd5930374e9c1f98c662e33ae`。SQLite 保持 v17，安卓沿用 0.16.0，正式 Coopcraft 和安卓真机留待集中联调。 [CBI JAR](../建设bot参考/carpetbaritoneintegration-v1.7.1+260820-surveytrail-0.39.jar) · [对应源码](../建设bot参考/CarpetBaritoneIntegration-surveytrail-0.39-20261109.tar.gz)

## 68. Companion 0.40.0 B 站公开合集发现

- 主人可在工作台 B 站页授权或撤回最多八个指定公开合集。接受 `https://space.bilibili.com/<mid>/lists/<seasonId>?type=season`，只保留两个数字 ID 和可选备注。创建授权不会打开浏览开关。配对设备状态省略队列、订阅和备注。
- 自主总开关与 B 站浏览均开启、处于允许时段且连接器空闲时，才会匿名读取一个合集中首屏最多六条。全局两次检查间隔至少六小时，同一合集至少 24 小时，失败后至少 48 小时。宿主先持久化检查名额再发请求。上游作者和合集 ID 必须匹配，发现不创建阅读回执、不切换小家位置，也不调用模型。
- 每次最多新增三条候选，自动候选同时最多六条，队列总上限仍是 20。自动入队对历史 BV 与分 P 去重，手工候选优先。主人可以对尚在排队的同一视频单独授权。撤回合集会取消其尚未完成的候选和正在运行的对应请求，保留已经完成的历史。迟到结果不得重新入队。
- 新候选沿用独立的角色决策会话。视频标题只用来识别候选，来源备注留在工作台。取得真实资料或字幕回执后才生成共享经历，反思继续要求可核验的字幕引文并存为场景私有候选。
- 真实匿名接口测试用一次请求取得六条公开候选，随后抽查一条，成功读取资料，匿名字幕未提供。隔离端到端用测试字幕和固定决策验证了入队、阅读回执、带引文私有反思、共享经历和撤回。隔离 Chromium 验证管理操作和旧宿主兼容。116 项定向检查与打包通过。 [实际验证使用的 B 站公开合集接口](https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=7380321&season_id=678635&page_num=1&page_size=6)
- 两个打包版本验证 SQLite v17 至 v18，旧候选、手机绑定和记忆保留，冷却跨重启，完整性及外键检查通过。旧宿主拒绝打开 v18，回滚使用升级前备份。候选包 SHA-256 为 `dca16a30b57cf50784dac5eb0e28c39282bc715c27a1a1dc17caea8822a0837f`。正式宿主和安卓真机留待集中联调。

## 69. Companion 0.41.0 本地字幕与反思来源

- 工作台 B 站页可为指定 BV 和分 P 导入、替换或撤回 UTF-8 SRT 与 WebVTT。导入读取该分 P 的实时 CID 和时长，检查完整时间轴。单文件最多 256 KiB、6,000 条字幕，同时最多保存 32 个分 P。BOM、常见换行和按起始时间排序的重叠字幕均可处理。 [SubRip 格式说明](https://www.loc.gov/preservation/digital/formats/fdd/fdd000569.shtml) · [WebVTT 规范](https://www.w3.org/TR/webvtt1/)
- 每个分 P 在本机保存文件 SHA-256 及最多 12 条、总计 1,200 个 UTF-8 字节的摘录。工作台列表返回格式、时间、分 P 和指纹等元数据。实际请求字幕时才读取摘录，再核对当前 CID 和时长。该分 P 缺少有效附件时，仍可尝试公开字幕。
- 阅读回执区分主人提供的字幕与 B 站公开字幕。反思把引文与原摘录、时间和阅读回执逐条核对，保存至场景私有候选。共享经历只保存阅读事实和来源类型。替换或撤回附件会取消依赖旧摘录的未完成反思，已确认的回执保留。通用活动入口拒绝写入 B 站阅读回执。
- 三条真实公开视频均可读取资料，匿名字幕为 0/3。真实分 P 和自制 WebVTT 验证了导入、自主阅读、确切时间引证、私有反思与撤回。角色决策使用固定输入，外部请求只取两次视频资料，字幕始终在本机。另有 103 项定向检查、隔离 Chromium 和打包通过。
- 两个打包版本验证 SQLite v18 至 v19，旧候选、来源、冷却、手机绑定和记忆均保留，完整性与外键检查通过。旧宿主拒绝打开 v19，回滚使用升级前备份。候选包 SHA-256 为 `d2dbcaceda2ae6fdaf3dad749be0879a8baa662cc29ab5b10c41adcd135f80fa`。安卓沿用 0.16.0，正式宿主及安卓真机留待集中联调。

## 70. Companion 0.42.0 混音歌曲的人声口型

- 新导唱混音从转换后、叠加伴奏前的人声 PCM 提取每 25 ms 的能量。每首最多 2,600 个单字节采样，与成品 WAV 的 SHA-256 一起在 SQLite 归档。归档 WAV 字节和手机试听协议沿用原实现。
- 只有指定舞台完整接收已核验的混音 WAV 时才附带人声能量。浏览器按实际播放时钟取样，声音仍由同一个混音音源输出。桌面和 OBS 镜像复用主舞台的口型心跳。旧混音及缺少有效能量数据的歌曲继续从实际播放波形取得口型。 [Web Audio 播放时钟](https://www.w3.org/TR/webaudio-1.0/#dom-baseaudiocontext-currenttime)
- 81 项定向检查和打包通过。真实 Live2D 皮套在隔离 Chromium 用可控音轨验证了 509 个参数、纯伴奏段有音量且口型为 0、人声段张嘴、镜像同步，以及完整播放只提交一次回执。随后手动停止的播放回执为取消，能量归零。
- Apple M5 上用 JaCRC 中由田昊演唱的《空城计》两句完整中文唱段，以大肥鱼私有参考声线完成 30 步 Seed-VC 离线转换。16.80 秒导唱转成 16.80 秒的 44.1 kHz PCM16，耗时 68.13 秒。两句在同时间窗的绝对音高误差中位数为 10 和 20 音分。转换原始样本有 3 个触及 PCM 满幅，逐字听感、整首歌词和音色仍待听审。 [JaCRC 数据与授权](https://zenodo.org/records/6536490) · [Seed-VC](https://github.com/Plachtaa/seed-vc)
- 测试在真实转换后附加 1.25 秒数字静音与原创伴奏，18.05 秒混音进入真实归档和 Chromium 舞台。纯伴奏段混音 RMS 约 0.043，主舞台和 OBS 镜像的口型能量均为 0。人声段主舞台口型实测张开，镜像收到人声能量。舞台完整播放和手动停止分别取得一次完成及取消回执。测试素材保存在隔离目录。
- 两个打包版本验证 SQLite v19 至 v20 迁移，保留旧归档歌曲、旧回执、手机绑定、记忆与字幕。旧宿主拒绝打开 v20，回滚使用升级前备份。候选包 SHA-256 为 `166088a2055d07b9a3015dda2bd77c2f079158b3bb0858321161371ec3bb7a76`。安卓沿用 0.16.0，正式宿主及安卓真机留待集中联调。

## 71. Companion 0.43.0 单文件翻唱

- 歌唱页支持上传主人有权使用的混合音源。接受 3–60 秒、16–96 kHz、单声道或立体声的 PCM16 WAV，最多 24 MiB。沿用本机工作台权限，音源从上传文件取得。手动选择导唱及伴奏的入口继续可用。
- 一个歌唱任务依次进行分轨、换声、混音和归档。宿主核对两条分轨和成品的时序，取消时停止当前工作并清理临时文件。成品进入原有私有归档并保留独立人声口型数据，安卓可沿用配对后的歌曲试听。
- Apple Silicon 安装 `demucs-mlx==1.6.1` 到独立 Python 环境，预先准备 `htdemucs` 模型缓存，并配置 `coverSeparatorPythonPath` 与 `coverSeparatorCacheDir` 为绝对路径。分轨运行时离线，`coverSeparatorTimeoutMs` 默认 60 秒。三项 Seed-VC 路径仍按 [导唱转换说明](#59-companion-0310-与-android-0140-手机试听与导唱转换) 配置。 [demucs-mlx 1.6.1](https://pypi.org/project/demucs-mlx/1.6.1/)
- 这条入口在工作台提交。歌唱会话目前可用文字提交原创短歌。分轨保留模型识别为 `vocals` 的全部声音，主唱和和声分离、RVC 同源试听及整曲仍待验证。

分轨环境和缓存可在独立目录预先准备。下面的 `cover_env` 和 `cover_cache` 分别指向选定的绝对路径。

```sh
python3.12 -m venv "$cover_env"
"$cover_env/bin/python" -m pip install demucs-mlx==1.6.1
"$cover_env/bin/python" -m demucs_mlx.hub download htdemucs --output-dir "$cover_cache"
```

将 `coverSeparatorPythonPath` 指向该环境的 `bin/python`。模型 `htdemucs.safetensors` 的验收 SHA-256 为 `339d267a7a6983a11eedbdc00413c602a65e9b9103f695fb5c2b2a481cd9d297`。 [官方模型缓存说明](https://github.com/ssmall256/demucs-mlx/blob/v1.6.1/docs/api.md)

- Apple M5 隔离验收将 JaCRC 中田昊演唱的《空城计》两句与自制伴奏混成一份 18.05 秒 WAV，从工作台 HTTP 接口提交。缓存已准备的这次任务分轨耗时 0.90 秒，换声 55.24 秒，到归档及回读共 56.34 秒。成品为 18.042 秒的 44.1 kHz 立体声 PCM16，峰值 −1.67 dBFS，包含 722 个独立口型采样。音频范围读取返回 206，归档指纹一致，分轨和换声的临时目录清空。 [JaCRC 数据及许可](https://zenodo.org/records/6536490)
- 该样本的独立人声已知。相对同一导唱，混合输入的 SI-SDR 为 −1.82 dB，分轨后为 25.42 dB。数值仅描述这一段用已知双轨混成的音源。全长歌曲、和声干扰及音色听感有待验证。
- 67 项定向检查、隔离 Chromium 的四阶段和旧版表单交互、候选包构建通过。SQLite 保持 v20，隔离数据库完整性和外键检查通过。候选包 SHA-256 为 `a75e87503827badb6ec29baca8f1bdae076ee6b0c1a64f138947a874bfb0b939`。正式宿主和安卓真机留待集中联调。

## 72. Companion 0.44.0 与 Android 0.17.0 会话翻唱

- 网页工作台「歌唱」和安卓「歌唱归档」可打开 `world.singing` 话题。启用 [本机分轨和换声](#71-companion-0430-单文件翻唱) 且宿主有附件存储时，会话可接收主人有权使用的混合 WAV。附上一份 3–60 秒的 PCM16 `.wav` 文件并发送「帮我翻唱这段，歌名叫《空城计》」或「翻唱：空城计」。附件上限为 8 MiB，工作台的直接上传仍可收 24 MiB。
- 工具从本轮认领并提交的同一条主人消息读取 WAV。工具参数仅有曲名。会话、文件内容和任务在本机关联，模型收到文件句柄及真实任务回执。每条消息最多创建一个任务。重放同一消息返回原任务状态，仍需另发一条明确的消息才能重新生成。唱完前可以问「这首歌进度怎么样」，有已核验归档时才显示可播放。
- 手机歌唱话题复用既有配对、消息、附件与 WebSocket 连接，并保有独立的会话历史。旧宿主仍可使用普通聊天与原歌曲归档。完成的歌曲可在配对手机试听，工作台继续支持查看阶段、取消任务及选到私有舞台。
- 隔离 DSH `0.2.1-rc.5` 用本地确定性模型响应、真实配对设备 API、MLX Demucs 和 Seed-VC 完成 18.05 秒中文音源的会话翻唱。四个 DSH 回合分别提交、查询运行状态、拒绝复用历史附件及查询成品。任务从接收到归档约 62 秒，成品 18.042 秒，配对下载返回 WAV 范围响应 `206`。SQLite v20 完整性和外键检查通过，独立口型包络已归档，分轨和换声暂存目录清空。 [测试音源](https://zenodo.org/records/6536490)
- 宿主 58 项定向回归、TypeScript 检查和打包通过。候选包 SHA-256 为 `54fd8fe564d26fe7ba1eb1875784141a76b99f1d0a17766a61f00197f80a5ba9`，其中宿主 bundle 和隔离实测一致。正式宿主和安卓真机留待集中联调。
- 安卓通过 18 项 Flutter 定向检查、Dart 分析和双语文案校验。Release ARM64 APK `versionCode` 为 `11091859`，签名与 `0.16.0` 一致，SHA-256 为 `c96b3fec7ee0a22946555b290c67a3e99464bdf45fb7d11e3cb9b476b893e3a1`。 [安卓候选 APK](../whale-companion-go-0.17.0-arm64.apk)

## 73. Companion 0.45.0 与 Android 0.18.0 街区活动和营地日记

- 网页和安卓小家增加营地联络站，与小屋、声演工坊、阅览室组成街区。房屋沿用按屋顶、楼层、配色、地基和入口绘制的原创布局。宿主活动与用户选择分别显示，网页和安卓按原有小家刷新节奏更新。断线或过期时清除实时标记，日记可查看上次同步的已确认回执。 [参数化建筑参考](https://github.com/Zengkailin/parametric-topdown-pixel-architecture)
- Minecraft Worker 的活动对应营地联络站，实时舞台对应声演工坊，B 站阅读对应阅览室，聊天、休息和空闲对应小屋。室内地图继续显示对应家具位置。两端可点建筑查看用途与可用入口。
- 共享 `community` 投影最多返回四条已确认的自主营地回执。宿主核对成功的授权父任务及其成功的 Minecraft 子任务。营地日记投影只含动作、时间和可公开的路线枚举，普通活动写入无法生成这类回执。直线提前折返只确认返回，双段提前折返保留实际已确认的检查点数。网页小图把已确认路段与计划路段分开绘制。
- 从两份真实 Fabric、CBI 与 Worker 隔离验收留下的 SQLite v17 副本读取了直线七格和向东再向南的双段回执，各保留一次完整完成和一次提前折返。被撤销的任务未进入日记。新版管理与配对 `/state` 投影相同，离线清除活动标记，配对撤销后拒绝读取。旧副本迁移到现有 v20 后，完整性与外键检查通过。此次验证复用了已保存的游戏回执。
- 宿主 112 项定向检查、TypeScript 检查和打包通过。隔离 Chromium 用状态样本验证 320px 窄屏、键盘导航、实时与点选标记、旧宿主和过期状态，以及按实际检查点绘图。Companion 候选包 SHA-256 为 `53b5d618842c1e4eb1c8d9cc2a0c2567e701af5f31acab2bd8d2f058ac8de441`。
- 安卓 30 项 Flutter 定向检查、Dart 分析和双语文案校验通过。Release ARM64 APK 的 `versionCode` 为 `11091912`，签名与 `0.17.0` 一致，SHA-256 为 `ef4120ecaa78ed83c6c7f3367428dce9787d035f09cf498dc69b4f11ec5fbfea`。正式宿主和安卓真机留待集中联调。 [安卓候选 APK](../whale-companion-go-0.18.0-arm64.apk)

## 74. Companion 0.46.0 每日营地勘察

- 本机工作台「Minecraft → 每日营地勘察时段」可以从已有授权中选一个半径至少 5 格的营地，设定同一天内 30–180 分钟的窗口和 1–7 个当地日历日的有效期。当天窗口已结束时从次日起算。授权绑定宿主时区，时区变化、无效的当地时刻和已过期的窗口会阻止新的执行。安卓 `0.18.0` 可从小家查看结果，规则设置在本机工作台。
- 宿主在窗口内且后台自主开启、处于非免打扰时段、没有正在执行的营地授权时，才尝试领取一次机会。还需 Worker 最近 5 秒报告角色在线、空闲并支持 CBI 勘察。每天最多创建一条任务，重复授权和重启沿用同一天的任务记录。角色自行决定直线、双段路线或跳过，剩余授权充足时可推迟一次，五分钟后重新预检。窗口结束前也会校验授权、状态和 CBI 真实路线。
- 「停止」或主动下线会暂停当天评估，撤销时段取消相应任务，撤销营地授权也会撤销对应规则。自动调度只使用已连接的角色。执行中断和无确认回执的任务不会进入营地日记。成功记录沿用现有共享记忆、返回状态和路线投影。
- 独立 Fabric 1.21.1 与实际 CBI Worker 验证了离线保持离线、手动连入后领取每日机会、确定性决策选择向东再向南、两个检查点停稳、原路回营和手机场景可访问的共享经历。回营终点距起点约 0.065 格。撤销后同日再次授权没有产生第二次任务。正式 Mac mini、Coopcraft 和安卓真机留待集中联调。
- 130 项定向检查、TypeScript 检查、打包及隔离 Chromium 320px 交互通过。SQLite 仍为 v20。旧版 `0.45.0` 在隔离回滚检查中撤销了排队的定时任务，没有调用 Worker。候选包 SHA-256 为 `8fc29c1bf4ad57d62e604a3289be9d846f2c6cde63569457c893acb978100038`。

## 75. Companion 0.47.0 角色自我笔记

- 定期记忆整理使用已提交的会话快照，每段引文核对对应消息 ID 和发言角色。自我观察至少引用一次大肥鱼自己的表达。中断的回复和带工具调用的中间文本仍按原有聊天历史保留，整理快照只选完整的对话表达。大肥鱼可以用新的表达接续当前场景里曾写过的观察，宿主原子保存新笔记、归档旧条目和更新整理回执。
- 工作台将角色观察和主人反馈分开展示。角色原文、置信度和证据由角色整理产生，主人可查看原文历史或归档一般条目。已被角色接续的旧笔记保留历史。主人反馈可以编辑、归档和回滚。两类各有 40 条有效项的上限。
- 角色可以为有出处的笔记选择一个预定义的行为倾向。独立场景首次交互最多带入一个短提示，相关输入最多得到两条自我观察提示。跨场景只渲染固定的行为倾向，来源文本、证据、消息 ID 和主人反馈留在原有数据面。旧笔记从首个修订读取角色原文，适用范围为原场景。
- SQLite 增加笔记作者证据元数据并迁移至 v21，原有笔记、修订、任务、共享记忆和设备仍在原表。需要回滚时使用升级前的备份。
- 隔离 DSH `0.2.1-rc.5` 用本地确定性模型响应驱动真实的手机配对、聊天、整理和跨场景调用。独立游戏会话取得「信息不足时先问清楚」，模型请求不含手机原文。后来角色凭另一条消息接续笔记，旧原文仍可查询，新会话只收到更新后的「把复杂问题拆成可核对的小步」。工作台拒绝了改写和回滚角色原文，配对接口没有公开笔记详情。
- 63 项定向检查、隔离 Chromium 320px、TypeScript 检查和打包通过。实际 `0.46.0` 库副本迁移 `20→21` 保留旧记录、Minecraft 规则和共享经历。迁移和真实隔离库完整性与外键检查均通过，旧候选拒绝打开 v21。候选包 SHA-256 为 `decc0e279883082b6010c6a90049c64b0d2d7f7bb86b1780e248990650cb1973`。正式 Mac mini 和安卓真机留待集中联调。

## 76. Companion 0.48.0 勘察图文动态

- 工作台「自主」开启后台自主、主动动态与 Minecraft 经历分享后，大肥鱼可以决定分享一次有回执的勘察，或将经历留在记忆里。再开启「允许角色为已确认的勘察动态附一张路线图」才会提供配图选择。该开关默认关闭。发布沿用免打扰、共享冷却和 24 小时分享时限。
- 宿主从成功的营地授权父任务与 Minecraft 子任务核对路线，在发布前再次核对回执和设置。配图由宿主离线绘制。实线代表已核实路段，虚线代表计划路段，提前回程保留已确认的检查点。卡片使用固定英文标签，只显示相对方向和距离。配图权限被撤回时取消该轮带图发布。
- 动态、媒体索引和活动回执同时提交。图片随发布记录保留，扫描时复核文件指纹。重复回执及已删除的原动态均不会触发重发。发布写入共享经历，网页和 Android `0.18.0` 沿用现有配对图片接口。SQLite 保持 v21。
- 隔离验收复用此前真实 Fabric 和 CBI Worker 的向东再向南双段回营回执，以确定性模型响应触发发布。网页和配对手机接口读取同一张 288 × 208 的 PNG，未配对请求返回 401。媒体扫描后来源和 SHA-256 一致，数据库完整性与外键检查通过。正式 Mac mini 与安卓真机留待集中联调。
- 200 项定向检查、TypeScript 检查及打包通过。候选包 SHA-256 为 `3db11ebd9c96a5a055852f8d0a4edd5c43abeeb477e2b9eead024467e37b2bca`。

## 77. Companion 0.49.0 肥鱼 RVC 翻唱

- `singingCoverEngine` 选择 `seed-vc` 或 `applio-rvc`，既有配置默认使用 `seed-vc`。Applio 需要 `rvcPythonPath`、`rvcApplioDir`、`rvcModelPath` 和 `rvcIndexPath`，均为绝对路径。分轨继续沿用已配置的 MLX Demucs，分轨与换声可分别配置。
- 本机验证使用 Applio `6d5d9511b7e719b1f613362bc767e841ad72fa72`、Python 3.12、`requirements-engine.txt` 及肥鱼 RVC v1 发布权重与匹配索引。模型名里的 v1 指声库发布版本，推理架构是 RVC v2、40 kHz、F0、HiFi-GAN。ContentVec 的 `pytorch_model.bin`、`config.json` 放在 Applio 的 `rvc/models/embedders/contentvec/`，`rmvpe.pt` 放在 `rvc/models/predictors/`。分别核对声库和配套推理资产 SHA-256。模型、推理环境和音源留在宿主私有目录。 [Applio 固定版本](https://github.com/IAHispano/Applio/tree/6d5d9511b7e719b1f613362bc767e841ad72fa72) · [肥鱼权重和参数](https://huggingface.co/Esmerubphire/FeiyuVoice-RVC) · [配套资产清单](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/main/server/runtime_compat/upstream_assets.json)
- 宿主预检本地资产，使用固定 ContentVec 路径、RMVPE、零移调、索引比例 0.3、保护 0.33，关闭自动清理。每次推理使用单独的暂存目录，取消会停止子进程并清理。工作台区分当前配置和作品实际引擎，作品来源与 WAV 指纹一起提交，SQLite 保持 v21。安卓沿用现有归档和试听接口。
- Apple M5 上用 JaCRC 田昊《空城计》的同一份 16.80 秒导唱测试。Applio 报告使用 Apple MPS，输出 16.78 秒、40 kHz 单声道 PCM16。首次独立 CLI 进程总耗时 90.00 秒，日志内转换段 30.64 秒。按谱合成、整曲和角色音色听审是后续独立验收。 [JaCRC 音源与许可](https://zenodo.org/records/6536490)
- 对原导唱做同时间窗的 pYIN 比较，肥鱼 RVC 与 Seed-VC 的绝对音高误差中位数均为 10 音分，P90 分别为 20 和 50 音分。肥鱼 RVC 原始输出峰值为 −7.37 dBFS，触及满幅的采样数为 0。Seed-VC 输出有 3 个满幅采样。两条人声另以相同响度和相同伴奏制成试听样本。指标只覆盖这一份短片段，音色、字音和唱腔继续用听审判断。
- 听感复核以同源清唱对齐。16.8 秒导唱由 JaCRC 田昊《我正在城楼观山景》的单声道录音从 3.72 秒裁切并量化为 PCM16。约 2.01–2.30 秒的「在」和 7.90–8.20 秒的「景」，原唱都有约五个半音的上滑，RVC 复现了近似的走势。Seed-VC 在约 2.33 秒有几十毫秒的局部偏高估计，快速转音附近的 F0 也可能有跟踪误差。试听混音另外叠加了测试用 A 和弦，核对换声时可先比较清唱。 [JaCRC 原录音及元数据](https://zenodo.org/records/6536490)
- 隔离 DSH `0.2.1-rc.5` 安装打包后的候选，用本地确定性工具调用响应测试歌唱会话。配对客户端附上一份混合 WAV，真实 MLX Demucs 和肥鱼 RVC 跑完任务。确认查询进度、拒绝复用历史附件、归档作品和配对下载。任务记录从接收到完成为 8.03 秒，成品 18.04 秒、40 kHz 立体声 PCM16，带 722 个独立人声口型采样。下载支持 206，归档哈希、引擎来源、清理后的暂存目录和 SQLite v21 完整性及外键均已核对。一次本机热缓存任务的耗时可作基线。
- 60 项定向检查、TypeScript 检查和打包通过。候选包 SHA-256 为 `13ff5e6e1cfcec97707e03c79a35e53fbec2e24b3e124a47333e1e823574eb92`。正式 Mac mini 与安卓真机留待集中联调。

## 78. Companion 0.50.0 中文按谱唱

- 网页「歌唱 → 按谱唱」接受 4–24 秒的普通话单声部短谱。每行用音高、拍数和汉字表示一个音符，音高可用 `C4` 或 `60`，`R 0.5` 为半拍休止，`E4 1 _` 延续前一音节。可填入示例并查看预计时长。第一版使用 MIDI 48–84、60–180 BPM 和四分之一拍粒度。
- 也可以在独立歌唱会话用「按谱唱」或「请按谱唱」开头，再给出曲名、速度和带歌词的音符。模型转成结构化音符提交，宿主核对本轮主人的请求、曲谱和两次 WAV 输出。一条消息最多创建一项任务，状态工具可继续查进度。配对手机复用现有歌唱会话和 WAV 归档，工作台的输入可逐行精确指定音符。
- 先配置换声引擎，再配置 `scorePythonPath`、`scoreSoulXDir`、`scoreModelPath`、`scorePromptAudio` 和 `scorePromptMetadata`，都用绝对路径。参考录音及对齐 metadata 由宿主提供，已对齐的录音起点应与 metadata 一致。Apple Silicon 默认 `scoreDevice: mps`，也可明确选 `cpu`。
- Apple M5 隔离环境用官方 SoulX-Singer `81aeb3ae772c70093c3de74dc23c92d983801ae4` 和 SHA-256 为 `447eaf41f91a6b6659d55e9ec3c9b809221724fb8592aebaec35a23751a5b500` 的 `model.pt`。Python 3.10.20 环境安装 `torch==2.7.1 torchaudio==2.7.1 transformers==4.41.2 numpy==1.26.4 librosa==0.10.2 scipy==1.13.1 soundfile==0.12.1 omegaconf==2.3.0 accelerate==1.11.0 g2pM==0.1.2.5 tqdm==4.70.1`。权重、参考音频和依赖由宿主私有保存。官方配置以 20 ms 对齐时间。 [SoulX-Singer 源码](https://github.com/Soul-AILab/SoulX-Singer/tree/81aeb3ae772c70093c3de74dc23c92d983801ae4) · [官方 SVS 权重](https://huggingface.co/Soul-AILab/SoulX-Singer/blob/40493ad90286056c7a9095035164434a79daa8c9/model.pt)
- 自制短谱《微光照归途》含六个有音高的音符、一个一字多音和一个 0.5 秒休止。Apple MPS 合成 4.00 秒、24 kHz 清唱，整个进程用时 23.08 秒，其中官方模型报告推理 14.92 秒。部分逆频谱操作走 CPU 回退。最终换声后按谱落实休止，休止内部各以最多 12 ms 淡化，保留相邻有声段的 PCM 采样。
- 已打包的候选在隔离 DSH `0.2.1-rc.5` 用确定性模型工具响应和真实 SoulX-Singer、肥鱼 RVC 验收。配对客户端发送文字短谱，查询会话任务，再下载 3.98 秒、40 kHz 单声道 PCM16，任务耗时 25.13 秒。成品的 1.512–1.988 秒逐样本验证为零。归档哈希、引擎来源、SQLite v21 完整性与外键、暂存清理和配对 206 均通过。工作台 390px 表单、51 项定向检查、TypeScript 检查和打包通过。
- 候选包 SHA-256 为 `1d930b328c0f2a3014b2caa9137452c74aae7eb977fe4afd621df83b3fb95cbd`。正式 Mac mini、安卓真机和整曲仍待验收。

## 79. Companion 0.51.0 营地联络站

- 安卓开发版从「小家 → 营地联络站」打开 Minecraft 状态页，查看角色是否进服、当前动作和最近的暂停回执。接口只返回有限状态，坐标、玩家名单、库存、原始聊天和 Worker 错误留在本机。既有营地日记和活动入口保留，旧宿主可继续使用。
- 本机「Minecraft → 营地联络站」可开启「允许配对手机暂停游戏动作」，默认关闭。收到暂停后，宿主先持久保存状态，再尝试让角色停稳，关闭生存反射、结束本轮游戏决策和当前营地授权。若当天有定时勘察，暂停会取消排队勘察并保留当天的暂停记录。手机分开显示确认停稳、当时离线和停稳未确认。未确认时可重新请求。
- 暂停后新动作、重新进服与自主营地动作受到宿主和 Worker 两层拦截。暂停前已开始但尚未调度到游戏控制台的动作会失效。只有本机工作台可以解除暂停，已取消的动作和勘察不会随解除而重跑。SQLite 保持 v21。
- 隔离 Fabric 1.21.1 与实际 CBI Worker 验证，角色跟随先实际移动 4.77 格，配对暂停后位移为 0，生存反射关闭。两条并发暂停只形成一次停止任务，跟随和排队勘察被取消。宿主重开后仍拒绝动作，本机解除后可开始新的跟随。当日勘察保持暂停，配对撤销、数据库完整性和外键检查通过。
- Android 通过 Dart 分析、双语文案校验与 27 项定向 Flutter 测试。一项既有测试由 `WHALE_LOCAL_QA` 控制，留待集中验收。按用户要求停止本轮签名构建，手机功能集中完成后再统一生成 APK。正式 Mac mini 和安卓真机留待集中联调。
- 宿主类型检查和 161 项定向回归通过，随后单独验证了暂停后恢复时旧事件失效的用例。候选包 `dsh-companion-bot-0.51.0.tgz` 的 SHA-256 为 `9154ede4484c16c23c0d8ad4b15ee36748cc29102898e4dc4f21528ac8347f90`。

## 80. Companion 0.52.0 MIDI 按谱唱

- 网页打开「歌唱 → 按谱唱 → 从 MIDI 导入旋律」，选择轨道、通道、起始音符和音符数。导入先填入可编辑的短谱，显示预计时长，确认后才提交。网页在浏览器内解析，宿主收到的是短谱。缺少对齐歌词时可逐行补齐，也可按音符一次填一串歌词。
- 接收最多 256 KiB 的 `.mid` 或 `.midi`，格式为标准 MIDI 0/1，采用 PPQ，最多 32 轨。导入以首个选中音符为起点，保留片段内部休止。选段须为恒速单声部、60–180 BPM、4–24 秒，沿用 0.25 拍网格与 C3–C6 音域。嵌入歌词须是同轨、与起音对齐的 UTF-8 歌词事件，每个音符一个汉字或 `_`。手动歌词按所选有音高的音符计数。文件的乐器音色、力度、踏板和弯音不进入歌声合成。 [MIDI 文件规范](https://midi.org/standard-midi-files)
- 配对客户端在独立歌唱会话把一份 MIDI 和请求一起发送。轨道、通道和起始音符都从 1 开始编号，音符数只计算有音高的音符。歌词行可省略，此时需有可用的内嵌歌词。附谱按以下格式填写，数字以所选 MIDI 为准。

```text
按谱唱 MIDI
曲名：微光照归途
轨道：3
通道：1
起始：1
音符数：6
歌词：微光_照归途
```

- 宿主只使用本轮已认领的文件和主人指令，重复调用返回同一歌唱任务。成品沿用实际的本地歌声合成、换声、归档、手机试听和舞台通道。安卓开发版根据宿主能力区分可发 WAV 和 MIDI，旧宿主仍沿用原有 WAV 行为。SQLite 保持 v21。
- 隔离 DSH `0.2.1-rc.5` 安装候选包后，配对客户端发送 197 字节的三轨 MIDI。真实 SoulX-Singer 与肥鱼 Applio RVC 将主人指定的六个音符生成 3.98 秒、40 kHz 单声道 PCM16。任务用时 27.90 秒。模型刻意返回了另一份合法短谱，成品仍按主人的曲名和音符生成。1.512–1.988 秒的 19,040 个休止采样全为零。重复上传、拒绝历史附件、配对范围下载、归档指纹、暂存清理、SQLite 完整性与外键均已核对。
- 390px Chromium 验证了损坏文件与和弦提示、选轨、补词、短谱预览、提交与旧宿主视图。69 项宿主定向检查及 `pnpm pack` 通过。宿主候选包 SHA-256 为 `2ff2c7e3db6323df651e2148e15dff73bdd068f6507cbef32bf7f4a9041ea70c`。
- 安卓支持插入可编辑的 MIDI 指令模板，宿主仅支持手写短谱时仍可打开歌唱会话。20 项 Flutter 定向检查、Dart 分析和双语文案校验通过。一项原有 `WHALE_LOCAL_QA` 检查、签名 APK、正式 Mac mini 及安卓真机留待集中验收。

## 81. Companion 0.53.0 长曲按谱唱

- 网页和配对歌唱会话均接受 4–180 秒、最多 512 行的中文单声部曲谱。MIDI 仍按主人指定的轨道、通道和音符范围导入。工作台显示预计时长和合成段数，可手动调整音高、歌词和时值。跨乐句的延音保留在同一段，难以完整分段时提交前说明原因。
- 宿主将曲谱分为 4–24 秒的乐句，优先在休止处切分。SoulX-Singer 一次加载模型和参考音频，沿同一条时间轴合成。换声每段最多 45 秒，进度可从工作台和歌唱会话查询，成品按原拍位合为单份 WAV。取消或失败时不归档部分曲目。新归档的时长与实际 WAV 指纹一起保存，旧归档仍可播放。 [SoulX-Singer 固定版本](https://github.com/Soul-AILab/SoulX-Singer/blob/81aeb3ae772c70093c3de74dc23c92d983801ae4/cli/inference.py)
- 隔离 DSH `0.2.1-rc.5` 实装候选包。配对客户端上传一份 1,233 字节的原创三轨 MIDI，宿主使用选定的 72 个音符。真实 SoulX-Singer 只加载一次，肥鱼 Applio RVC 换声三段。任务耗时 171.982 秒，归档为恰好 70 秒、40 kHz 单声道 PCM16。11 处休止核心共 209,440 个采样全部为零，邻段有声。配对范围下载、旧附件拒绝、上传重试、指纹、SQLite v21 完整性与外键、暂存清理均已核对。
- 安卓开发版通过 180 秒 WAV 的分块下载、播放器交接、暂停继续和缓存清理测试。31 项 Flutter 定向检查、Dart 分析和双语文案校验通过，一项原有 `WHALE_LOCAL_QA` 检查留待集中验收。宿主包 SHA-256 为 `d6e9566f8ef61dbb3476e087ac8b13eb73227ed381d8973970abd8a7c1d0e93a`。
- 用户试听认可 3.98 秒《微光照归途》和 70 秒《微光照小河》。两段保留为后续唱腔与换声调整的听感对照。

## 82. Companion 0.54.0 Minecraft 衣柜

- 已核对 ccci202 的六种 1.2 配色和蓝色冬装。新 ZIP 内的六款与已有解包原件逐个比对 SHA-256 一致，1.0、1.1 留作历史版本。七款的原件和私有索引保存在本机，旧的 Aly-Deepseek 单独保留原先登记。新素材说明标记免费且不可修改，联机自动同步需要另核对授权。 [YSM 模型目录说明](https://yesstevemodel.github.io/wiki/type/)
- 在兼容的 YSM 2.6.5、Minecraft 1.21.1 Fabric 环境准备已获授权的模型后，可配置 `minecraftWardrobeFile`，指向本机私有的 JSON 数组。清单最多 32 项，每项填写 `id`、`label` 和服务端命令补全实际列出的 `modelId`。路径和服务端模型 ID 留在宿主。工作台「Minecraft → 大肥鱼的衣柜」可以手动设置，大肥鱼也能在自己的游戏会话从同一清单中自主选择。 [YSM 相关命令](https://yesstevemodel.github.io/wiki/command/)
- Worker 仅能设置已有 Carpet 角色的默认模型纹理，按原 YSM 权限运行。检查 2.6.5 指令回执，并通过 `data get entity dafeiyu ysm.model_id` 回读选中的模型和显示状态。两者相符才写入任务、活动和共享经历。重复回执去重。工作台显示上一次接受设置的结果，游戏端渲染由兼容客户端确认。暂停、离线、拒绝和无法核对回执会阻止确认。 [YSM 2.6.5 Fabric 固定版本](https://modrinth.com/mod/yes-steve-model/version/eGOUtHWJ)
- 168 项 Minecraft 定向回归、实际回环 Worker HTTP 鉴权、390px Chromium 工作台与 `pnpm pack` 通过。浏览器验收使用隔离响应验证换装、暂停和旧宿主兼容。候选包 SHA-256 为 `4bff6d01a9ee9da46fecaa87cc870b78781f1f2d7c1a56951463a8e6af75b574`。本轮未构建签名 APK。
- 正式 Coopcraft 的 Apple Silicon macOS 宿主仍在 YSM 官方不支持的范围内。现有服务器与模型目录未变更。兼容平台上的假人换装与客户端渲染仍待联调。 [YSM 支持平台](https://yesstevemodel.github.io/wiki/intro/)

## 83. Companion 0.55.0 B 站阅读分享

- 工作台「自主 → B 站自主浏览」可以单独开启阅读分享，默认关闭。后台自主、自主动态及 B 站自主浏览须同时开启。大肥鱼在一段实际字幕读取成功后决定分享感受或略过。只读过视频标题或简介的候选不会触发。私人阅读反思仍由独立设置控制。
- 评估使用全新的无工具会话，只读本次已核验的有限字幕摘录。角色可选一个真实字幕时间点并写一句自己的感受，宿主拒绝未提供的时间点、带链接的输出和复制的字幕片段。网页和安卓显示宿主提供的视频号、分 P 和时间点，用户点击时打开 B 站。字幕、文件路径和私有评估消息不进入动态内容或配对消息流。 [B 站播放器分 P 和时间参数](https://player.bilibili.com/)
- 阅读分享和普通自主动态、Minecraft 经历共用冷却与免打扰。回执有效 24 小时，每个视频分 P 只排一次分享评估。分享权限、来源合集或主人提供的字幕撤回后，未完成的评估停止。实际发布进入共享经历，重复投递和重启不会重复发帖。
- SQLite v22 保持原有表结构，对不了解新任务类型的旧宿主启用版本保护。用隔离 v21 数据库副本验证升级，原来的任务、活动、记忆、Minecraft 动态、媒体及自主任务数据保持一致，完整性和外键检查通过。回滚到旧宿主时使用升级前的 v21 备份。
- 隔离 DSH `0.2.1-rc.5` 使用本地确定性模型决策、B 站真实匿名元数据和自写测试 VTT，完成了读取、分享、配对动态和回帖。手机只得到视频号、分 P 与所选字幕所在的第 5 秒。私有会话历史、重新绑入已释放会话和私有 WebSocket 订阅均被拦截。撤回测试字幕后，已发布的来源卡仍可读取。浏览与分享各留一条共享经历，SQLite v22 完整性与外键检查通过。
- B 站和 Minecraft 动态相关定向回归、54 项配对相关回归、6 项 Flutter 检查、Dart 分析、双语文案、390px Chromium 与 `pnpm pack` 通过。候选包 SHA-256 为 `e5d084d6125989b50822d11e6cfe219bda104f1bde3772ad38b4d5f4263298d9`。正式 Mac mini、安卓真机和签名 APK 留待集中验收。

## 84. Companion 0.56.0 站内收件箱

- 安卓从 Companion 状态页打开收件箱，前台状态刷新显示未读数。列表支持下拉刷新、分页、单条已读和将截至当前最新一条的提醒标为已读。手机聊天、动态原帖与回复、歌唱归档和营地日记沿用已有页面。旧宿主缺少能力字段时隐藏入口。
- 手机主聊天的助手回复经 DSH 持久化确认后记入收件箱。角色发动态或回帖、歌唱归档成功或失败、获授权的营地任务完成或核验提前返回营地时也记录提醒。提醒只携带类型、时间和内部跳转标识。动态删除后，相关提醒不再可见。
- 现有配对认证同时保护提醒列表与已读写入，已读状态按配对设备区分。宿主保留最新 200 条提醒，新配对从当前时间线开始。批量已读使用当前列表中的最高提醒 ID，随后到达的新提醒继续未读。SQLite v23 为新增表，升级前保留备份，回退旧宿主时恢复原版本备份。
- 修复可选工具未配置时无法创建或恢复会话的问题。会话限制只列出已注册的工具，内部评估仍沿用空工具白名单。宿主候选包 SHA-256 为 `841c166c40126842e6a30dbe60bfa9a0dc6638358541c72fa8e3fb126e101a33`。
- 在隔离 DSH `0.2.1-rc.5` 实装候选包，以回环模型响应验证离线手机回复、动态发布和自主线程回帖。两个配对设备各自保留未读状态，后来配对的设备从当前时间线开始。分页、批量已读保留后到提醒、匿名拒绝及 SQLite 完整性和外键检查通过。旧 v22 隔离副本迁移到 v23 后保留现有配对、动态、任务和活动。102 项宿主定向检查与 `pnpm pack` 通过。
- Android Companion flavor 的 `test/whale` 通过 71 项，包含新增的 6 项收件箱检查。一项原有 `WHALE_LOCAL_QA` 配对用例按环境跳过。Dart 分析和双语文案检查通过。正式 Mac mini、Coopcraft、安卓真机和签名 APK 留待集中联调。

## 85. 离线升级与回退演练

### 创建与校验快照

确认运行中的 Companion 版本、实际 `dataDir` 和对应 tarball。工具采用 DSH `0.2.1-rc.5` 的默认 `sessions`、`storages`、`attachments` 布局。若 DSH 配置另设了会话或存储根目录，先核对实际路径并另行纳入恢复。停止共用这些数据路径的写入服务，并在 DSH Home 外准备一条父目录已经存在的新快照路径。使用 Node 22.19 或更新版本和本机 `tar`。

```sh
node scripts/companion-backup.mjs create --offline \
  --dsh-home "$DSH_HOME" --snapshot "$SNAPSHOT_DIR" --package "$CURRENT_PACKAGE"
node scripts/companion-backup.mjs verify --snapshot "$SNAPSHOT_DIR"
```

使用自定义 `dataDir` 时，在 `create` 命令中加 `--data-dir "$COMPANION_DATA_DIR"`。快照中有一致性 SQLite、会话原文与索引、原生附件、全部 Companion 媒体、已存在的 CBI 事件游标和旧 tarball。文件清单核对大小与 SHA-256，同时校验 tarball 的名称及内部版本和 SQLite 的完整性与外键。启动令牌、模型配置与资产、YSM 素材、正式 Minecraft 世界及账号由各自的宿主维护流程保管。备份中的聊天、图片和记忆仍属于私有数据，快照目录以 `0700` 创建，文件以 `0600` 写入。

### 在新 Home 恢复并启动旧版

`RECOVERY_HOME` 指向一条父目录已存在的新路径。恢复先验证整个快照，然后在新 Home 写入数据。只有恢复副本中、位于原 `media/voice` 目录且快照中有对应文件的 WAV 路径会随目录迁移。检查命令输出的 `unavailableVoiceFiles`，它统计备份时已经缺失或路径在受管语音目录外的旧记录。

```sh
node scripts/companion-backup.mjs restore --offline \
  --snapshot "$SNAPSHOT_DIR" --dsh-home "$RECOVERY_HOME"
DSH_HOME="$RECOVERY_HOME" dsh --profile companion-recovery --from-default-profile web --dump-config
DSH_HOME="$RECOVERY_HOME" dsh plugin --profile companion-recovery add "$SNAPSHOT_DIR/dsh-companion-bot-0.15.1.tgz"
```

最后一行示例使用升级前版本 `0.15.1`，按快照里保存的 tarball 选择。恢复出来的数据路径为新 Home 下的默认路径。演练用独立回环地址和隔离模型配置启动，确认旧设备凭据、原会话历史、动态和媒体；正式切回前另核对服务启动参数及实际目录。`0.15.1` 只能打开 schema v13 或更旧的库。从已迁移的 v23 回退时使用升级前快照，并先保存升级后的数据供后续核对。

### 已完成的离线验证

- 实装 `0.15.1 → 0.56.0 → 0.15.1`，SQLite `13 → 23 → 13`。旧配对凭据和聊天 Session 在三段均可用，已撤销设备继续返回 401。聊天回复、纯图片动态及回复、共享记忆及修订保留，两张 PNG 与旧 WAV 的 SHA-256 一致。新版为旧 WAV 补媒体索引，恢复到新 Home 时迁移一条语音路径。旧包拒绝打开 v23。回退后，旧配对能继续在同一个 Session 流式聊天，升级后产生的新消息和提醒保存在独立的升级目录。
- 升级前在演练中暂停自主功能，避免旧队列在回退启动时重新调度，暂停状态贯穿迁移与恢复。正式切换前核对待处理任务与原自主设置，回退后先验证状态再恢复日常调度。演练的文字模型和语音接口使用确定性本地样本。
- 另一份 `0.52.0` 隔离快照恢复到全新 Home，再安装 `0.56.0`。配对设备从原歌唱 Session 读回 197 字节 MIDI 附件，并下载已归档的歌唱 WAV。两个文件的 SHA-256 与原验收相同，匿名附件请求返回 401，歌曲范围请求返回 206，SQLite v23 完整性与外键检查通过。
- 4 项工具回归覆盖 WAL 一致性、自定义数据路径、恢复权限、缺失和外部语音引用、同长度篡改、拒绝覆盖、符号链接及 tarball 版本不符。正式 Mac mini、Coopcraft、安卓真机和签名 APK 保留到集中联调。

## 86. Companion 0.57.0 手机 Live2D

- 私有手机舞台复用工作台的 Live2D 模型、参数配置和渲染逻辑。宿主设置 `avatarDeviceViewer: true` 且私有素材通过预检后，配对安卓从小家或状态页打开。旧宿主隐藏入口，材料仍留在宿主私有目录。SQLite 保持 v23。
- 手机沿当前配对的 HTTPS 路由领取 15 秒有效的一次性观看票据。WebView 首次请求通过请求头完成交换，随后使用仅限观看路径的 HttpOnly、SameSite=Strict 和 Secure Cookie。观看会话最长 20 分钟，空闲 45 秒过期。撤销配对会让后续状态与资源读取失效；回前台或重试时 App 申请新票据。
- 手机读取的快照只含活动类型、已确认动作及其进度、已确认播放的口型能量。手机舞台为静音镜像，主舞台负责实际播放、动作执行和回执。聊天语音和歌曲仍从各自入口试听。渲染限制为 30 FPS 与 1× 像素倍率，支持减少动作，进入后台停止渲染和轮询。原画及拆分为神宫凉子，Live2D 建模为霓虹猫_NeonNeko。
- 在隔离 DSH `0.2.1-rc.5` 安装候选，通过模拟 Serve 转发头的回环 HTTPS 反代访问。390 × 844 Chromium 加载实际私有模型，368 × 754 Canvas 的非有限参数数为零。手机跟随脸红动作和主舞台播放已归档歌曲时的口型，歌曲结束后归零。脸红完成由主舞台回报一次。同步核对减少动作、票据重用拒绝、Secure Cookie、未认证拒绝、管理路由隔离和撤销后失效。
- 31 项宿主及渲染定向检查和 `pnpm pack` 通过。候选包 SHA-256 为 `994e180d59543ed33de810a2f515e4e31f5c70d95201b74ae24a62699316640f`。Android 定向 Flutter 检查通过 18 项，包含 7 项手机舞台检查。Dart 分析、双语文案校验与 Companion ARM64 Kotlin 编译通过。正式 Mac mini、Tailscale、安卓真机及签名 APK 留待集中联调。

## 87. Companion 0.58.0 Minecraft 衣柜实装

- 多个 DSH profile 可以各自配置 `minecraftWorkerPort`、`minecraftConsoleFifo` 和 `minecraftGamePort`，原有默认值继续适用。`minecraftServerRoot` 应提供实际服务端的 `logs/latest.log`，`minecraftConsoleFifo` 使用指向该服务端标准输入的本地具名管道。Worker HTTP 绑定 `127.0.0.1`，复用各自的数据目录和凭据。游戏端口用于报告和配置地址；CBI 通过控制台及日志执行和回读。
- Carpet／CBI 模式可直接从 Companion 包启动，账号版客户端依赖只在相应模式加载。控制台写入以非阻塞方式打开已有路径，拒绝符号链接。缺少管道或读取方时及时失败。实测读取方回来后可继续发命令，已取消的命令在写入前拦截。
- 实装验证使用 Minecraft 1.21.1 Fabric、Carpet、CBI 和官方 YSM 2.6.5 原包。Linux AMD64/glibc 服务端在专用内部网络通过 QEMU 启动，模型原件只用于隔离测试。YSM 批准 ID 来自实际服务端识别，带 `.ysm` 后缀的样本应保留后缀。候选包包含插件和 Worker，模型与 YSM JAR 由各自的私有部署提供。 [YSM 固定版本](https://modrinth.com/mod/yes-steve-model/version/eGOUtHWJ) · [模型及同步方式](https://yesstevemodel.github.io/wiki/type/)
- 真实服务端端到端通过 12 项。工作台选普通蓝装，随后 Minecraft 根会话通过 `mc_change_appearance` 选蓝色冬装。两次都有 YSM 反馈、实体 NBT 和独立任务。隔离模型驱动 DSH 实际工具调用，配对手机在不同 Session 召回冬装回执，手机上下文只有命中的共享记忆。无 YSM 的原生 Fabric 对照服通过 10 项，包括真实进出服及无换装成功记录。
- 同一隔离服重载其余五份 1.2 原件后，白、紫、橙、黄、黑五款也分别获得 YSM 设置反馈及同一探针角色的 NBT 回读。加上普通蓝装和蓝色冬装，共七款。每份测试文件的 SHA-256 均与原件一致。服务器已保存三个维度并正常退出。
- 图形客户端已通过 AMD64 Xvfb 与 Mesa OpenGL 预检，YSM 2.6.5 在游戏初始化时拒绝虚拟机环境。最终换装画面待官方支持的实体客户端验收。正式 Coopcraft 的 Apple Silicon macOS 仍需有兼容服务端环境。 [官方虚拟机说明](https://ysm.cfpa.team/wiki/log/252/) · [支持平台](https://yesstevemodel.github.io/wiki/intro/)
- 170 项 Minecraft 定向检查及 `pnpm pack` 通过。实装后只同步了包内 README，逐文件核对其余 36 项完全相同。候选包 SHA-256 为 `cb6e1f356ac4bf3dbc3175c136ce58354edd8ae2c8ee0f443b0fd2951da8cf23`。SQLite 保持 v23。正式服务、安卓真机及签名 APK 留待集中联调。

## 88. Companion 0.59.0 歌唱动态

- 在独立歌唱会话发送 `发布歌唱动态：曲名`，由大肥鱼写一条短配文并发布到私有动态。曲名需在当前会话精确匹配一首已完成作品，重名时可用歌唱任务 ID。宿主从本轮主人消息读取作品标识，核对会话、归档大小和 SHA-256。只保留归档的宿主仍可使用已有歌唱会话发布。
- 工作台和 DSH Go 打开动态播放器后按需读取原归档 WAV。手机时间线和动态详情复用原生播放能力，可读取较早的作品。发布进入配对设备收件箱。发送 `撤下歌唱动态：曲名` 会移除动态及对应提醒，原歌曲留在归档中。同一作品最多关联一条动态，重试复用原记录，撤下后的旧请求不能让动态重新出现。
- SQLite v24 为动态增加唯一的歌唱任务关联。两份 v23 隔离数据库迁移通过，原配对、会话绑定、动态、收件箱和归档均保留。回退旧版时使用升级前快照。
- 隔离 DSH 实装候选包，以本地确定性模型响应驱动真实工具调用。用真实 SoulX-Singer 与肥鱼 RVC 先前生成的 70 秒《微光照小河》通过发布、去重、撤下和设备撤销共 10 项链路检查。完整下载和 Range 请求沿用同一份 5,600,044 字节归档，原 SHA-256 一致。
- 30 项宿主定向检查与 `pnpm pack` 通过。390px Chromium 工作台通过 7 项检查，覆盖真实 WAV 播放、暂停、离开释放、错误恢复以及既有图文与回复。Android 通过 31 项定向 Flutter 检查、Dart 分析和双语文案校验，一项既有 `WHALE_LOCAL_QA` 检查留到集中验收。候选包 SHA-256 为 `3ca57e8f447d706ba58b2e9c211f04b9f0195067c5c8442bd9a67de74b4cd72b`。正式服务、安卓真机及签名 APK 留待集中联调。

## 89. Companion 0.60.0 每日自主活动

- 在工作台「Minecraft → 定时营地勘察」授权时，可勾选「允许她从营地勘察和 B 站阅读中选择」，默认关闭。沿用原营地区域、宿主本地时间、单日 30–180 分钟和 1–7 天授权。勘察需要她已进服且 Worker 通过预检，B 站阅读仍需单独开启并有已保留的候选。原先的单独定时勘察授权仍可使用。
- 评估放在独立的新系统 Session `autonomy.daily`，没有工具和旧会话历史。宿主最多提供 3 条阅读候选，选择后核对本轮消息、授权、静音、候选和路线，再执行一项。她也可以跳过。每天使用一个持久日期键，开窗前开始的普通 B 站评估在开窗后不能启动额外阅读。普通 B 站调度在窗口外照常。
- 选中后才创建对应的执行任务。勘察沿用 Worker 的出发、检查点和回程确认，并进入营地日记。B 站只在取得字幕摘录后计为成功，只有标题或简介时不会生成读过字幕的经历。实际阅读或游戏驱动小家的活动和最近记录。分享仍走原有独立授权和冷却，已确认经历经中央记忆供手机独立会话按需召回。
- 授权撤回、营地暂停、B 站开关关闭和免打扰会拦截对应的新执行或中断在途任务。重启先核对已完成的子任务，已经消耗的日常机会不自动重跑。SQLite v25 只提高旧宿主打开数据库的版本门槛，保留原表。用真实 `0.59.0` 旧包验证迁移及回退保护，原动态、设备、未读、绑定及旧勘察授权均保留。日常决策与原始会话对配对客户端不可见。
- 用当前宿主和 Worker 源码连接真实隔离 Fabric 1.21.1、Carpet 与 CBI。通过管理接口授权后，本地会话事件样本选了东转南路线，游戏确认两个检查点并回到距营地中心约 0.065 格的位置。小家状态、营地日记、手机场景共享记忆检索及单条回执动态均核对。同日撤销重授未重复执行，未选中的 B 站候选仍在队列。隔离服已正常保存三个维度并退出。
- 隔离 DSH 实装最终候选包通过 12 项检查。B 站连接器使用回环视频元数据和自制 WebVTT，模型用确定性本地响应。读取时小家进入手机阅读角，单独授权的私有动态通过配对详情、收件箱及 WebSocket。重启后，新的手机会话可以召回阅读经历，配对设备看不到日常评估原文或字幕。加入同日新候选并等待下一次调度也未重跑。实际调用两次回环元数据接口，日常选择和动态评估均没有工具。
- 241 项宿主定向回归通过，含 42 项新增日常检查。390px Chromium 通过 9 项工作台交互检查，覆盖旧宿主、默认关闭、三种选择状态、撤销及异常轮询。`pnpm pack` 通过，候选包 SHA-256 为 `55ede722e613f588d7f9c052c5f147dae7dbe412d5b7216681ec1dcf7a923cd3`。正式服务、安卓真机及签名 APK 留待集中联调。

## 90. Companion 0.61.0 自主经历与自我笔记

- 工作台「自主」新增默认关闭的自主经历复盘，需要后台自主和记忆整理同时开启。开关生效后，每个新确认的日常活动至多排一次。距活动回执和最近一次前台对话均满 30 分钟，且小家没有实际聊天、游戏、阅读或音频活动时才开始。免打扰期间等待，回执满 48 小时后到期，用户先发起的前台对话会中止已开始的复盘。
- 复盘使用独立的新系统 Session，无工具。Minecraft 只提供已确认的路线和回程结果。B 站只提供经核对的字幕阅读出处，原文留在原连接器。执行前和写入前分别重验来源，失效或撤回的材料不能生成新笔记。
- 大肥鱼可跳过、写一条自我推断，或用新经历接续本次可见的旧观察。笔记同时保存真实活动回执与本轮角色消息编号，接续保留前条及其历史。仍最多 40 条有效角色笔记，可归档。主人可以查看来源和历史，主人反馈仍独立编辑。固定人设不受复盘改写，其他场景只带入有限的行为标签。
- 工作台在成功复盘任务中打开只读笔记，并在记忆页分别呈现自我推断、原话和活动回执。配对客户端不读取复盘会话或笔记正文。SQLite v26 只提高版本门槛，沿用既有表；用实际 `0.60.0` 包创建的 v25 迁移，确认原人设、主人反馈、归档笔记及历史、活动、动态、未读和配对保留，旧包拒绝打开 v26。
- 最终候选在真实隔离 DSH 通过 16 项链路检查。使用回环 B 站元数据、自制 WebVTT 和确定性模型响应，隔离宿主测试时钟推进 31 分钟后实际写入笔记。核对回执 ID、DSH 助手消息 ID、固定人设、归档恢复和设备隐私；重启后新手机 Session 获得「先核对证据再作判断」行为标签。同日没有重复读、发帖或复盘，SQLite 完整性与外键通过。
- 223 项宿主定向回归通过。调度验证包含前台优先、来源撤回、关闭后旧请求无法发送、归档后同源去重、两类来源及跨日接续。使用上一轮真实 Fabric 和隔离 DSH 的数据库副本验证了两种来源。390px Chromium 通过 11 项工作台交互检查。`pnpm pack` 通过，候选包 SHA-256 为 `539bf84fd6e52254385169e3b2c760d660abf2e8efb1a876e52b82fe7d4fa0d7`。正式服务、安卓真机及签名 APK 留待集中联调。

## 91. Companion 0.62.0 Minecraft 自主短访

- 工作台「Minecraft → 定时营地勘察」可单独开启自主进服。授权默认关闭，可与 B 站阅读分别选择。离线且窗口、营地和 Worker 满足条件时，大肥鱼可决定短访或跳过。已经在线时可沿用原勘察规则，已有人工会话的进服和下线仍由主人控制。
- 模型只选择是否进服。Worker 从服务器玩家列表核对角色不存在，确认营地区块已加载、脚下为允许地面且两格空间安全，再以 Carpet 在授权营地中心生成假人。它核对实际位置、维度、状态和威胁，随后宿主选择通过实际预检的一条路线，优先最短直线。租约只允许一次往返，动作时间受授权、免打扰和最长 5 分钟上限约束。
- Worker 在发送进服命令前持久保存租约并核对登录日志。结束时停止动作，退出本次创建的假人并回读玩家列表。进服失败、停服、暂停和撤回也会清理本次租约。宿主重启可按原租约补核对；没有完整回程与下线证据时，短访不会显示完成。工作台可区分进服中、已进服、已确认下线和待核对。
- 实际隔离 Fabric 1.21.1、Carpet、CBI 和 Worker HTTP 使用本地单轮模型响应。假人从离线开始，完成向东 4 格往返并由真实玩家列表确认离线。营地日记、手机独立场景记忆和工作台状态都能对应同一次短访。后续人工上线时，错租约或旧租约均未结束人工会话。
- 最终 Worker 另通过真实东转南路线与两个检查点，核对无有效租约时拒绝动作、同租约最多一次勘察、实际离开、空玩家列表和结束请求幂等。隔离服也验证了宿主未发结束请求时，20 秒测试租约到期后 Worker 自行清理。两套隔离服均正常保存并退出。
- SQLite v27 提高旧宿主打开库的版本门槛。用 `0.61.0` 实际隔离库迁移保留了人物设定、动态、配对、手机会话和角色自我笔记历史，旧 B 站授权没有取得进服权限。回退旧版使用升级前快照。
- 232 项综合定向回归和 1 项新增 Carpet 离线回执回归通过，390px Chromium 通过 10 项工作台检查。打包宿主在隔离 DSH 核对了 0.62.0、未授权状态和 SQLite v27。候选包 SHA-256 为 `8b09a54fd37a2570ad39f3b136a8fe1a01b581b68e8bd3119e93ab0e91ddc887`。正式 Mac mini、Coopcraft、安卓真机及签名 APK 留待集中联调。

## 92. Companion 0.63.0 Minecraft 短访补给

- 在每日活动授权中先允许自主进服，再单独勾选「允许短访时限量合成木板」。默认关闭，旧授权继续沿用原规则。只有进服后真实回读到可用配方才发起一次最多 30 秒的现场评估。大肥鱼可以补给、选一条已经预检的勘察路线或直接下线。背包没有合格配方时沿用原短访勘察逻辑。
- Worker 核对营地、租约、健康、威胁和背包。补给只使用已持有的同种原木，每次一批。勘察和补给共用一次动作额度。真实配方须消耗一根原木，背包对应木板须增加四块，并保留至少两根同种原木。至少已有八块木板、只剩两根原木，或同种剥皮原木等可能干扰配方核验时，不提供补给。
- 成功的游戏任务与精确背包回执同事务写入。宿主重启可从原回执恢复日记与共享记忆，短访还须有同一租约的下线回执才算完成。现场判断会话与精确背包计数留在宿主，手机只收到有限活动和记忆摘要。有回执的短访补给可作为后续自主复盘的来源。
- 真实隔离 Fabric、Carpet、CBI 和 Worker HTTP 使用本地确定性模型响应完成两轮决定。隔离假人的真实背包从 3 根橡木原木、0 块木板变为 2 根、4 块，服务端确认下线。营地日记、共享记忆和复盘来源对账通过，后来人工进服仍读到同一背包。另用真实 Worker 验证缺/错租约、混有剥皮原木、只剩两根或已足八块的拒绝分支。
- SQLite v28 保留既有表结构，使用真实 `0.62.0` 短访数据库迁移，保留授权、任务、动态、配对、活动和共享记忆。迁移不会自动获得补给权限，回退旧版使用升级前快照。
- 307 项综合定向回归和 1 项新增手机隐私检查通过，390px Chromium 通过 9 项工作台检查。最终候选包实装到隔离 DSH，核对了权限默认关闭、必须先授权进服、撤销、伪造回执拒绝及 SQLite v28。候选包 SHA-256 为 `0a0bf249124189276aed93db3546b16978aacb899558a642156ebbc334de84d7`。正式 Mac mini、Coopcraft、安卓真机和签名 APK 留到集中联调。

## 93. Companion 0.64.0 Minecraft 短访建造

- 工作台的每日活动窗口先授权自主进服，再可单独开启短访建造。旧规则默认没有建造权限，补给仍可单独授权。现场评估只列出已核验的选择，模型只决定做哪一项。建造、勘察和补给共用一次动作额度，也可以直接下线。
- Worker 使用同一营地租约，核对生存模式、站位、健康与背包，再检查营地北侧 3×3 施工位的已加载区块、地基、三层净空及实体。施工前重新检查，只用已有的八块同种木板和一个工作台。CBI 施工范围收紧到已核验位置，完成后逐块回读并核对实际扣料。
- 游戏任务与私有回执同事务保存。宿主重启可复用已经提交的回执，避免重新施工。日记与共享记忆展示已核验的事实，只有取得同一短访的下线回执后才把活动标为完成并纳入空闲复盘。手机状态不包含现场决策会话和详细库存回执。
- 隔离 Fabric 1.21.1、Carpet、CBI 和真实 Worker HTTP 通过正向及阻挡场地验收。遮挡时预览不提供建造，直接请求也被拒绝，地块和背包保持原样。移除遮挡后，以两条确定性模型响应驱动实地验收。服务端独立回读八块橡木木板和一个工作台，背包从 8 块和 1 个变为 0 块和 0 个，随后确认下线。手机场景记忆召回、日记、反思来源以及后续人工进服均通过。
- SQLite v28 → v29 用 `0.63.0` 实包的隔离补给数据库验证。既有表、索引、补给授权和历史数据保留，建造需要重新授权，旧宿主拒绝打开 v29。389 项定向回归、390px Chromium 的 8 项交互、`pnpm pack` 及实装候选包的权限与数据库检查通过。包 SHA-256 为 `92140bbd8dac10851114b3ef3ce6727f36c585a24cf5d65d739adfb686cb4fc0`。正式 Coopcraft、真机及签名 APK 留到集中验收。

## 94. Companion 0.65.0 Minecraft 跨日营地任务

- 工作台可额外开启跨日营地项目，前提是当前窗口同时允许自主进服、补给和建造。旧授权默认关闭项目。宿主按同一规则、营地和每日任务读取已确认的回执，每天仍最多一次短访行动。备料阶段每次读取实时背包和施工位，符合条件才会把补给或建造列为现场选项。
- 确认施工和下线后进入待复访。下一次获授权进服可只读核对原来的八块木板和一个工作台，复访和勘察共用一次额度。九处一致且下线已确认后显示完成。方块有变化或上次已派发施工但回执不完整时显示待确认，之后仅沿用普通勘察选项。
- 复访结果和游戏任务同事务保存，重启可以从已提交的回执恢复进度。取消当前营地任务会中止短访动作并核对下线。复访事实可从手机会话召回，详细回执和原施工任务关联留在宿主。更换授权窗口会从新的项目进度开始。
- 同一隔离 Fabric 1.21.1 存档和授权完成四个模拟日。前两日各消耗一根原木、得到四块橡木木板。第三日放置八块木板和一个工作台，第四日逐块复访读回 9/9，每日均确认下线。另移除一块后实读 8/9，地块和库存维持复访前的状态。手机召回已核对。Host 和 Worker 使用同步的日历夹具，模型由八条预设选择驱动，Fabric、Carpet、CBI 与 Worker HTTP 实际执行。
- SQLite v29 → v30 使用真实 `0.64.0` 包和隔离建造数据备份验证，保留既有授权、回执、自我笔记、表及索引。旧宿主拒绝打开 v30。430 项定向回归、390px Chromium 的 9 项工作台检查、`pnpm pack` 与候选包实装通过。包 SHA-256 为 `e4a3111b86e9aa3f841bdbf855b4d04b14c37dc29e99c094e87ee384259e5ef7`。正式 Coopcraft、真机和签名 APK 留到集中验收。

## 95. Companion 0.66.0 手机营地进度

- 小家、社区营地和联络站沿用现有配对接口。宿主为两个入口计算同一份有限摘要，包含阶段、授权状态、确认的补给次数及建造和复访时间。授权到期仍可回看进度，撤销窗口或区域后隐藏摘要。Minecraft 离线时仍可读取已确认进度。
- 联络站显示正在复访的真实动作。配对暂停的回复即时更新页面，返回小家后按现有机制刷新。状态失效时标明上次确认的阶段，隐藏实时授权提示。旧宿主和不完整的项目字段沿用既有营地状态和日记。
- 从上一轮真实 Fabric 数据库复制隔离验收用数据库并实装候选包。真实配对 HTTP 在两个入口核对完成、暂停、重启、到期、撤销和设备撤销，Dart 解析器读取了四种实际响应样本。隔离宿主使用日历夹具核对到期，原隔离服数据库指纹一致。配对快照和实时活动流均过滤建区与撤区的内部日志，并去除记忆记录的内部作者会话标识。原始证据在宿主持久保留。
- 135 项宿主定向测试、22 项 Flutter 定向测试、Dart 静态分析、双语文案检查和 `pnpm pack` 通过。SQLite 保持 v30，候选包实装后的完整性与外键检查通过。包 SHA-256 为 `a327d200e01246eede353865b2c0cc8d340f1948937506fc4918a2948bf23d9f`。正式 Coopcraft、真机和签名 APK 留到集中验收。

## 96. Companion 0.67.0 Minecraft 营地巡视

- 工作台在每日窗口内单独授权营地巡视，先开启自主进服。巡视可与短访项目和 B 站选项并列，仍共用一次每日机会。一次巡视最多 15 分钟、两条不同方向的往返路线，租约只允许巡视。普通短访仍使用原有授权和行动额度。
- 每段从实时预检选择可走的路线，下一段须等服务端确认上一段回到营地。Worker 出发前写入日志，按顺序放行，重启后只核对已经执行的动作。地形变化导致提前折返、缺少回执、授权到期或暂停时结束巡视，保留已核验段数并核对下线。
- 工作台和配对联络站分别显示巡视段数、运行或结束状态以及下线确认。手机沿用原有配对暂停授权，停稳与下线分别展示。撤销巡视授权仍可查看最近一次结果。精确路线、内部任务和回执留在宿主，已确认段落按日期保存来源，可从手机聊天召回。
- 在隔离 Fabric 1.21.1 用 Carpet、CBI 和真实 Worker HTTP 验证两个模拟日。第一次向北、向东各走 7 步并回营，确认 2/2 和下线。第二次在第二段真实出发后通过配对 HTTP 暂停，CBI 确认取消和停稳，最终显示已取消、1/2 和已下线。手机召回核对了两天共三条独立来源。日期和模型选择使用夹具。
- 用 `0.66.0` 实包和上一轮营地数据验证 SQLite v30 → v31，旧授权保持默认关闭巡视，既有历史保留。466 项宿主定向回归、9 项 Flutter 测试、390px Chromium 的 9 项工作台检查、`pnpm pack` 及用真实巡视数据库副本实装候选包均通过。包 SHA-256 为 `cc0138ea731a6e7d6987bfa1b9ae529bf318ea10d03053ede6c1f9de9a716e31`。正式 Coopcraft、真机和签名 APK 留到集中验收。

## 97. Companion 0.68.0 Minecraft 营地采集与回营

- 工作台为每日窗口单独授权采集，需先开启自主进服。采集与巡视、跨日项目和阅读并列，共用一次每日机会。采集租约最多 15 分钟、一次行动。只有取得实时路线和资源预检结果才出发。
- 新 CBI 命令沿经过预检的直线走廊往返，在外端停稳后只处理一块低处橡木。识别依据是营地权限、土壤、竖直树干和非持久橡木树叶等方块状态，人工也能布置出同样的形态。Worker 核对实际背包恰好增加一根、回到原营地、同一角色会话仍有效，随后取得下线回执。
- Worker 在出发前持久记录行动额度。暂停、异常和重启后仍会核对下线，已提交的有效回执可恢复为经历。联络站显示核验原木数量、停稳和下线状态。精确路线、位置与库存留在宿主，手机聊天可以召回已经核验的采集。
- 隔离 Fabric 使用对应 CBI JAR 验证三条路径。带持久树叶的人工树形保持原状。符合采集规则的树形经北向 4 步出发、砍下根部一块并拾取、原路回营和下线。独立复登确认库存从 2 根增至 3 根。另一次在出发后、破坏前通过配对 HTTP 暂停，服务端确认停稳和下线，树木和库存保持不变。日期、模型选择与树形布局使用夹具，Fabric 游戏行为实际执行。
- `0.67.0` 发布包与真实巡视数据库的副本通过 SQLite v31 → v32 迁移。原授权和历史保留，采集默认关闭。508 项宿主定向回归、11 项 Java 定向测试、11 项 Flutter 测试、390px Chromium 的 8 项工作台检查、Gradle 离线构建、`pnpm pack` 与候选包实装通过。宿主包 SHA-256 为 `d2545131704d1e905241cb86955ef9ef2d8fb2e4c754762802b30ec03ae2549c`。
- 采集需要对应 CBI JAR。实测 JAR SHA-256 为 `31a35b27c70107e396f54b21c4b9a551ab2a578e6b55615d6c6b5639670f6c5e`，对应源码归档 SHA-256 为 `0ce0964cfc19e5216417084eb6e03003fa767f49e580c8511d5e6129e8d884db`。正式 Coopcraft、真机和签名 APK 留到集中验收。 [CBI JAR](../.work/minecraft-gather-cbi-0.68.LThGn2/carpetbaritoneintegration-v1.7.1+260820-campgather-0.68.jar) · [完整对应源码](../.work/minecraft-gather-cbi-0.68.LThGn2/CarpetBaritoneIntegration-campgather-0.68-20261110.tar.gz)

## 98. Companion 0.69.0 Minecraft 采集接入跨日营地

- 工作台可将采集加入跨日营地项目。前提是当前窗口已授权跨日项目和短访采集，再单独打开联动。原来可分别授权的采集、跨日项目和巡视继续保留。SQLite v32 → v33 已用 0.68 实包和真实隔离采集库副本验证，24 张表的既有数据保留，旧授权不会开启联动，回退使用升级前快照。
- 备料阶段由大肥鱼先决定是否短访，进服后从实际背包和现场决定做什么。持有工作台、总木板少于 8 块、橡木原木少于 3 根且没有可用的精确合成配方时，才提供采集。Worker 在出发前重新核对库存和路线。采集、补给、建造及勘察共用一次持久行动额度，跨日项目每天最多一次短访。施工后沿用后续复访，待核对阶段沿用普通勘察。
- 采集累计只计同一授权、同一营地且已确认下线的真实回执。工作台和配对手机分别显示采集原木数与补给次数。小家、社区营地和联络站共用摘要，缺省时沿用旧界面，异常计数不影响其他项目进度。精确库存、执行租约、现场提示和私有回执留在宿主。
- 首轮隔离服暴露旧 CBI 的拾取问题。第二天东向采集砍下根部原木后，掉落物在原版拾取延迟内弹出旧范围，宿主判为未核验。修复版只接触本次破坏后唯一锁定的单件掉落物，检查根部距离、玩家距离、区块、边界、原版交互权限与拾取延迟，再核对实体消失和背包恰好增加一根。26 项 Java 定向测试与离线 Gradle 构建通过。
- 修复后用同一隔离 Fabric 1.21.1 存档和七日授权验收。开局只投放一根原木和一个工作台，后续背包从三次真实采集和两次真实合成获得施工材料。确认每次回营下线，第六天搭建，第七天复访匹配 9/9。用实际树路线验证配方已可用及木板已足八块时拒绝项目采集。配对手机汇总三根、两次补给和项目完成，独立手机场景可召回相关事实。日历加速和模型决定使用夹具，Fabric、Carpet、CBI、Worker HTTP 与库存变动实际执行。 [七日证据](../.work/camp-project-gather-final-0.69.1ysj0v_y/evidence.json)
- 525 项宿主定向回归、16 项 Flutter 测试、390px Chromium 的 7 项工作台检查及 `pnpm pack` 通过。用真实七日数据库副本实装候选包，配对两个入口结果一致，到期可查、撤销后隐藏，私有回执不可见，SQLite v33 完整性和外键检查通过。候选包 SHA-256 为 `85fd5f4a3ccd047e6d02d50c4e9b226797e3cf74492fd031163f9c0976f9c62c`。正式 Coopcraft、安卓真机及签名 APK 留到集中验收。 [候选包验收](../.work/camp-project-gather-bundle-0.69.exo3mdmm/evidence.json)
- 复验使用的 CBI JAR SHA-256 为 `159d8b2e2f6b9795c4a04a226d4207abd53efc3cd1ed5735fc214f504d7df7df`，对应源码归档 SHA-256 为 `1dc2f53f9c90b70758441fdfbbd12f13f565acf10e7b308327e204eac964e2d1`。 [CBI JAR](../.work/minecraft-gather-pickup-0.69.6Hrf6C/carpetbaritoneintegration-v1.7.1+260820-campgather-pickup-0.69.jar) · [完整对应源码](../.work/minecraft-gather-pickup-0.69.6Hrf6C/CarpetBaritoneIntegration-campgather-pickup-0.69-20261110.tar.gz)

## 99. Companion 0.70.0 Minecraft 参考图小屋

- 在普通聊天的当前主人消息可说「帮我盖一间小屋」，或附一张图说「照这张图盖一间小屋」。工具使用消息本身的图片引用，只保存一份私有草案。图片请求要求解释可见设计和补设计部分。原图沿用聊天附件归档，SQLite 只保存引用。建造不会从聊天工具直接启动。
- 工作台可逐层查看北向方块图、材料清单和补设计。现场预检需要角色已在合适位置和有效授权区。开工确认绑定草案、地块和两分钟预检。配对设备可发送参考图，现场预检和开工保留本机工作台权限。重复确认同一已完成草案只返回已保存的回执。
- 当前蓝图每轴最多 5 格、最多 100 个实体方块。材料可用橡木木板、云杉木板、圆石和玻璃。地块与角色需要满足生存施工条件。CBI 复核实际支撑、视距和退路，通过原版交互放置，从已有背包逐格扣料。Worker 在执行前后独立检查目标方块、留空位及真实库存。撤区、暂停、连接丢失或现场变化会停止或标记待确认，保留实际施工。恢复需在原区重新预检，已相符方块不重复消耗。
- 已确认的工作同时保存任务、可核验回执与共享经历，供其他场景召回。SQLite v33 → v34 已使用 `0.69.0` 真实七日营地库副本，旧数据与授权保留，升级不会生成小屋草案，旧宿主拒绝直接打开 v34。回退使用升级前快照。 [迁移证据](../.work/house-migration-0.70.MMIBDX/evidence.json)
- 隔离 DSH 实装候选后，配对上传 PNG，确认模型入参中的图片像素与原图相同。回环模型返回 5×5×5 方块方案，真实 DSH 工具绑定当轮附件、持久保存草案，重启后恢复。草案阶段没有产生施工任务，设备凭据也不能读取管理草案。模型使用确定性夹具。 [图片链路证据](../.work/house-reference-dsh-0.70.55ciHy/evidence.json)
- 隔离 Fabric 使用上述图片草案的独立副本。箱子占用蓝图空位时预检拒绝，原方块保留。早期版本放到 39 块时因上方承托面不可见而停止。修复后先完成墙和屋顶，保留室内通道，再补地板。向上叠放时复核目标格可见、下方承托和操作距离。最终放置 62 块橡木木板、24 块圆石和 8 块玻璃，125 个目标及留空位置与蓝图相符，真实背包扣料一致，角色回到屋外起点。
- 隔离服用控制台设置初始站位，施工开始后角色实际行走和返回。同图复核新增零块、零耗料。另一隔离地块施工放下四块时，经配对接口暂停，服务端确认停稳，草案保持中断，未记为完工。手机独立场景的记忆钩子能召回已确认的小屋。 [隔离服证据](../.work/minecraft-house-final-0.70.6elnvl1o/evidence.json)
- 556 项宿主与 Worker 定向回归、32 项 Java 定向回归、390px Chromium 的 9 项交互检查、离线 Gradle 构建与 `pnpm pack` 通过。宿主包 SHA-256 为 `1643f36f95fef67f9593dcf012dbbaa14c5757677d4070e05c0fda58950b3ee8`。实测 CBI JAR SHA-256 为 `db7f814a64b81d94ed27799035582cce80ed70878641db48e21572e2d32b10bc`，对应源码归档为 `8d0987847ffa0254b946c63a0a5aefd092d9d31cf76f0193ba9d41823c96aae9`。真实视觉模型对不同图片的出图质量、正式 Coopcraft、安卓真机与签名 APK 留到集中验收。 [CBI JAR](../.work/minecraft-homebuild-cbi-0.70.v9xRhM/carpetbaritoneintegration-v1.7.1+260820-homebuild-0.70-v3.jar) · [完整对应源码](../.work/minecraft-homebuild-cbi-0.70.v9xRhM/CarpetBaritoneIntegration-homebuild-0.70-v3-20261110.tar.gz)

## 100. Companion 0.71.0 Minecraft 成果复盘与私有动态

- 自主工作台可单独开启「已验收的 Minecraft 成果」来源，默认关闭。写自我笔记还要允许后台、记忆整理和经历复盘。发私有动态还要允许后台、自主动态与 Minecraft 分享。既有单次活动的复盘流程继续运行。
- 营地成果要有同一授权中的搭建、完好 9/9 复访及下线证据。小屋成果要有真实完工任务、蓝图对照、放置回执与匹配的完工活动，零新增复核不另计。历史小屋活动独立保存的数字为核验和实放总数，材料由施工回执与蓝图交叉核对。来源进入模型前只提供固定的事实和计数，省去地块、坐标、参考图、名称及内部编号。 [真实来源回放](../.work/minecraft-milestones-real-0.71.p3xYefGy/evidence.json)
- 每项成果各有一次复盘和一次分享机会，角色可以分别跳过。复盘沿用至少 30 分钟空闲、免打扰、前台优先和 48 小时时限。笔记关联真实回执及当次模型原话，仍可接续旧笔记，其他场景只继承有限的行为标签。分享沿用 24 小时时限和全局动态间隔，正文由核验事实与角色短感想组成。两个决策都使用独立的无工具会话。
- 调度和写入前重验回执与授权，停用来源或撤区会结束相应未完成工作。原授权到期仍可在有效期内回看，撤销或替换授权会撤回该营地的待处理来源。配对手机可以读已发布动态。分享决策会话及动态附带的来源编号和作者会话编号只保留在管理端。
- SQLite v34 → v35 以真实小屋和营地数据库副本验证。25 张既有表内容不变，旧授权不会打开新来源。旧包拒绝直接打开 v35，回退用升级前快照。 [迁移证据](../.work/minecraft-milestone-migration-0.71.JPONVB/evidence.json)
- 最终候选包分别装入两个隔离 DSH，读取实际 Fabric 七日营地和实际小屋数据库的副本。每套各生成一条自我观察和一条可由配对端读取的私有文字动态，原回执和助手原话分别保留。重启后任务和动态各保留一份，新手机场景收到「先核对证据再作判断」标签，固定人设数据保持一致。使用加速时钟和确定性模型响应，原始 Fabric 库的指纹保持一致。 [营地 DSH 验收](../.work/minecraft-milestones-dsh-0.71.avA7yJ/camp-project-m27qdyrz/evidence.json) · [小屋 DSH 验收](../.work/minecraft-milestones-dsh-0.71.avA7yJ/house-vehyhd5i/evidence.json)
- 593 项综合回归、最终相关的 133 项定向回归、390px Chromium 的 7 项检查、SQLite 完整性与外键检查及 `pnpm pack` 通过。宿主包 SHA-256 为 `2eef95b297cc8bf01745d7892e7d2b1767201da0399491775146b376cdc661b4`。正式 Coopcraft、安卓真机和签名 APK 留到集中验收。 [浏览器检查](../.work/minecraft-milestone-note-ui-0.71.25HUR9/browser-result.json)

## 101. Companion 0.72.0 自我观察修订与小家笔记

- 自主复盘保存当前来源的核验时间和限长事实。下一次最多带入四条较早的相关观察，同类活动优先，跨世界只带入有相似内容的候选。模型仍可以跳过或另记一条观察。新来源和旧笔记均沿用既有复盘权限。
- 修订需要明确引用本轮给出的旧观察，并用同一条助手回复写下新观察和改变原因。来源有快照时必须严格更新，只有空白、全半角或句末标点变化不能替换旧内容。成功时旧笔记归档，两代出处与原话均保留，管理端可展开查看。没有快照的旧笔记仍可作为历史前件。
- 已经在用的聊天和游戏会话，在下一次合格输入时收到修订后的简短行为标签。注入记录沿用持久活动日志，避免无关后续输入重复注入，完整笔记和回执仍留在复盘与管理场景。
- 小家增加可选笔记状态，既有活动和位置字段继续兼容。实际复盘轮次接收对应输入且小家空闲时，Web 和新版安卓显示书桌笔记状态。真修订仅投影状态与时间，最多保留 24 小时。聊天、语音、游戏、阅读和休息仍有各自的状态，手机不读取私有复盘内容或编号。
- SQLite v35 → v36 使用 0.71 实装后的实际成果笔记和动态副本验证。25 张表的数据、旧笔记和授权保留，旧宿主拒绝直接打开 v36。 [迁移证据](../.work/growth-migration-0.72.cunwce/evidence.json)
- 隔离 DSH 按顺序读取真实 Fabric 的小屋和营地复访回执。确定性模型先写「先检查施工结果」，后根据复访写下「给做完的事留一次回访」，说明改变的原因。旧笔记和两代依据可查。同一个配对聊天会话、同一个实际连接 Fabric 的游戏会话在后续输入中收到新的行为标签，提示词未泄露完整笔记。固定人设与原始数据库指纹一致。 [隔离验收](../.work/growth-dsh-0.72.qjFj1v/run-7vcv0zd5/evidence.json)
- 绑定到实际游戏事件的回复到达后，无需执行动作的任务即时收尾。仅本次事件开始至结算之间的动作参与统计，普通游戏聊天和未来时间戳的动作不会记入。加速时钟下，两次复盘均可在配对小家观察，修订状态跨重启保留并在 24 小时后消失。
- 综合回归 633 项通过，游戏事件收尾修复后定向回归 127 项通过。工作台和小家窄屏 Chromium 共 13 项检查通过。候选包 SHA-256 为 `06331e723ce35e8ec114bc9a73e1308a7f1b51d626331f54fac618708199c846`。真实模型的自主复盘表现、正式 Coopcraft、安卓真机和签名 APK 留到集中验收。 [观察工作台](../.work/self-note-journal-ui-0.72.cmu9UP/browser-result.json) · [小家状态](../.work/home-journal-ui-0.72.LXQgCNto/browser-result.json)

## 102. Companion 0.73.0 参考图设计与蓝图对照

- 主人在支持图片输入的聊天会话发送一张图和建房委托。DSH 内置的 DeepSeek API 路线可选择 `deepseek-flash`。如果当前路线明确仅支持文字，工具拒绝将图片标记成设计依据，并提示切换模型后重发。实际模型由会话选择，Companion 不加载视觉模型权重。 [DeepSeek 视觉接口](https://api-docs.deepseek.com/guides/vision/)
- 平顶小屋可提交地板、墙、屋顶的材质以及门、窗和装饰列的坐标。宿主生成有进门通道、封顶与留空室内的蓝图。分层或旧字符串格式仍可提交其他形状。三种输入互斥，最终只保存统一方块蓝图。紧凑方案若没有模型说明，宿主根据已提交的坐标与实际补齐策略生成说明，提示与原图对照。SQLite 沿用 v36。
- 工作台点击「对照参考图」时从当时聊天附件读取图片。接口仅接受已有草案编号，并沿用本机管理校验。换草案释放已打开的图片。原图不可用时保留蓝图、材料和预检。390px 与 1000px Chromium 均核对了图片显示、切层无需重取、切换草案以及原图不可用的行为。 [窄屏对照](../.work/house-vision-ui-0.73/compare-390.png)
- 以三张方块参考图测试本机 Qwen3-VL-8B 4-bit。旧版直接输出完整方块串时，三个请求都出现重复并耗尽输出预算。新版取得真实模型的紧凑方案，回放原始工具输出到最终候选的 DSH 内置 DeepSeek Messages 适配器。三张图的原像素、附件归属、工作台原图字节、草案跨重启与无隐式施工全部核对。`deepseek-v4-pro` 的回环探针只发送文字，草案工具明确拒绝把图片记作来源。此处使用回环推理和回放，实际 DeepSeek API 的画图理解质量仍待验证。 [旧版对照](../.work/house-vision-dsh-0.73/dsh-run-wn5szsh3/evidence.json) · [新版回放](../.work/house-vision-dsh-0.73/dsh-run-jxeyhbcz/evidence.json) · [仅文字拒绝](../.work/house-vision-dsh-0.73/dsh-run-o7qyyqcs/evidence.json)
- 三份蓝图都有可支撑的结构，但门窗或材质偏差导致三份都未通过严格外观标准。验收图是三张规则方块图，真实照片和非平顶造型仍需另测。同一块转角玻璃可同时在正面和左侧出现，最终只放置一块，同一面的重复与遮门仍拒绝。 [外观测量](../.work/house-vision-dsh-0.73/dsh-run-jxeyhbcz/resemblance-evidence.json)
- 从最终候选保存的草案中选橡木屋和云杉工坊，在两套隔离 Fabric 实际建成。每间放置 95 块并核对全部 125 格、建筑边界、实际扣料、退回原地、持久回执和重复确认。两份草案均拒绝占位箱子和库存不足的现场。早一版还有一间从实时 Qwen 直接保存并建成的圆石屋，实放 95 块，正面横窗与屋顶符合参考，门洞仍有偏差。该实测圆石屋与最终候选回放中的圆石方案为不同草案。 [橡木屋施工](../.work/minecraft-vision-build-parallel-0.73.cq0Og2Ze/evidence-oak-cabin.json) · [云杉工坊施工](../.work/minecraft-vision-build-final-0.73.in3UK4or/evidence-spruce-workshop.json) · [独立圆石屋施工](../.work/minecraft-vision-build-0.73.EvpanFl4/evidence-stone-shelter.json)
- 宿主、Worker、图片路由与语料评估共 41 项定向检查通过。类型检查、构建与 `pnpm pack` 通过。候选包 SHA-256 为 `92d19ce0c465dfc6f6c2a2178a120b62f0ef9708d40b585aa5cea9ccbfc5739f`。正式 Coopcraft、安卓真机和签名 APK 留到集中验收。

## 103. Companion 0.74.0 小屋蓝图修改与重新预检

- 「参考图小屋」的待施工草案可以打开编辑器。对照原图在北墙或逐层视图点击方块，选择留空、橡木、云杉、圆石或玻璃。编辑时用料实时更新，可撤销、还原到开始编辑时的版本或取消。原模型的设计说明单独标记，原始蓝图和历次版本只读可查。暂时保存失败会保留修改，其他标签页抢先提交时需要显式重新加载。 [390px 编辑截图](../.work/house-revision-ui-0.74/edit-front-390.png) · [浏览器验收](../.work/house-revision-ui-0.74/browser-result.json)
- 保存只允许更新待施工草案的方块。原图、来源会话、尺寸和地块保持原样。施工中的草案、已经完工的草案及中断后保留部分方块的草案都锁定在实际施工版本。相同内容不新增版本，恢复旧内容作为一次新保存保留历史。配对手机凭据不能编辑或读取私有版本历史。原图通过归档消息和附件读取，管理端无需恢复来源 Agent。
- 预检确认绑定当前版本、授权地块和两分钟时限。修改成功会作废旧确认。即使旧预检迟到，也不能覆盖新版本的有效确认。等待 Worker 状态期间遇到修订时，旧施工请求会在创建任务前失效。SQLite v36 → v37 用真实 DSH 草案库和真实 Fabric 完工库的副本验收，原记录、原图引用和回执保留，旧包拒绝直接打开 v37。回退使用升级前备份。 [两份旧库升级](../.work/house-revision-migration-0.74.4mXWSc/evidence.json)
- 原模型生成的石屋北面可见投影一致率为 52%。只改北面 12 格，移正门洞、抬高横窗并修正材质，北面一致率达到 100%，原有左侧和屋顶保持原样，整份草案通过同一组预先确定的可见特征检查。参考图为规则方块图。 [修改前后对照](../.work/minecraft-house-revision-0.74.fdGrO9/front-comparison.png) · [投影测量](../.work/minecraft-house-revision-0.74.fdGrO9/projection-evidence.json)
- 原 CBI 在两次施工中分别停于 36 块和累计 37 块。新 CBI 到达后若真实眼位无法命中，排除该目标与站位的组合，继续搜索可撤回的安全位置，成功放置并核对库存后重新计算。实际距离、方块、支撑、实体和退路检查继续生效。隔离服保留原地块、同一修订和前 37 块，重启后预检并补完 58 块，核对全部 125 格和边界、总计 95 块扣料及回到本次开工位置。重复确认无新施工或成功回执，旧失败任务与完成结果均留存。地形、材料和开工站位由验收夹具准备。 [隔离服验收](../.work/minecraft-house-revision-0.74.fdGrO9/evidence.json) · [CBI 候选 JAR](../.work/minecraft-homebuild-cbi-0.74.I3NDE6/carpetbaritoneintegration-v1.7.1+260820-homebuild-0.74.jar) · [对应源码](../.work/minecraft-homebuild-cbi-0.74.I3NDE6/CarpetBaritoneIntegration-homebuild-0.74-source.tar.gz)
- 最终包安装到隔离 DSH，迁入三份原草案。离线修订时两个并发写入只有一个成功，恢复原版新增一条历史，无改动的保存不新增。解绑原聊天并重启后仍可读取同一原图字节，三代记录保留，另外两份草案保持原样。过程未触发模型调用或 Minecraft 动作，配对权限无法读取私有历史或保存修订。 [实装验收](../.work/house-revision-dsh-0.74/dsh-run-zbg3udgr/evidence.json)
- 宿主定向回归 132 项，归档读取调整后的相关回归 40 项，CBI Java 21 离线构建及 171 项测试，窄屏 Chromium 11 项交互检查通过。宿主包 SHA-256 为 `5c3af8178e83afbc082a059d8c4342a977d1d488d544528e28ff41cd27e211d5`，CBI JAR SHA-256 为 `adb156f6fb8ca9c753c1a870a1db89af7f1f2d089a02e96a5eb3576f36d0fed9`。正式 Coopcraft、安卓真机和签名 APK 留到集中验收。

## 104. Companion 0.75.0 小屋材料缺口

- CBI 对整份蓝图完成缺料预检后，Worker 只读复核现场和角色背包。匹配蓝图的现有方块会从用料扣除，留空位置继续检查遮挡。每项只返回待放置、现有背包可覆盖及仍缺的数量。过量库存和与该蓝图无关的物品不会出现在清单。未核实的现场、背包数据或旧 Worker 继续只显示缺料提示。
- 宿主校验清单对应当前草案版本、授权地块和完整预检，并限制每项数量在蓝图用料范围。缺料预检会作废此前的开工确认，补齐后重新预检。暂时中断或已有部分施工的草案同样按现场剩余量计算。SQLite 沿用 v37。
- 工作台可复制仍缺的条目。切换草案、地块、开始编辑或再次预检时清除旧清单。320px 和 390px Chromium 共 11 项交互检查通过。 [窄屏缺料清单](../.work/house-material-ui-0.75/output/playwright/shortage-320.png) · [界面验收](../.work/house-material-ui-0.75/browser-result.json)
- 在真实隔离 Fabric 中沿用 0.74 CBI。现场先放好 11 块匹配圆石，125 格缺料预检用时约 17.3 秒。待放置为 74 块圆石、6 块橡木木板和 4 块玻璃。真实背包覆盖 50、2 和 1 块，确认为缺 24、4 和 3 块。背包中的火把未出现在报告。旧确认被拒绝且没有任务、移动或扣料。遇到占位箱子优先报告遮挡。隔离夹具按清单补齐后获得新的开工确认。 [真实缺料预检](../.work/minecraft-house-materials-0.75.FK8S00/preflight-evidence.json)
- 新确认后的施工实放 72 块，连同已放的 11 块共核实 83 块，30 处留空均匹配。固定高度的路线无法越过门内已存在的一级地板，当前还差 5 块地板和 7 块屋顶圆石。存档回读核对了实际扣料、剩余的 12 块圆石和未变的火把。草案保留中断状态，数据库没有成功回执或完工活动，隔离服各维度已正常保存。 [施工中断与现场回读](../.work/minecraft-house-materials-0.75.FK8S00/partial-construction-evidence.json)
- 62 项宿主、Worker、契约及相关场景定向回归和 `pnpm pack` 通过。实际包读取了 0.74 的 DSH 修订库和隔离服完工库副本，保留原图引用、版本、失败尝试和完成回执。候选包 SHA-256 为 `9c4a585112a3a52bc25bd7343cf9199abafb652d40c7052c85d1a21c094a4ea6`。正式 Coopcraft、安卓真机和签名 APK 留到集中验收。 [包内与数据库验证](../.work/house-materials-0.75/package-evidence.json)

## 105. Companion 0.76.0 小屋施工恢复

- 同一授权下遇到普通失败，宿主按原草案只读复查一次，再从材料、现场、施工路线和安全状态中选择下一步。未识别的失败也走现场复查，保留原始任务原因，面板只显示归类后的提示。主人暂停、撤销、角色归属不明或其他安全中断时，原来的停止条件生效。复查不会产生开工确认，下一次修改世界仍沿用预检及现有授权。
- 复查结果关联真实失败任务并进入持久活动。工作台分别显示失败原因、已执行的复查与建议；旧版中断记录没有复查回执时，只显示可得原因和建议。320px Chromium 9 项交互通过。SQLite 沿用 v37。 [恢复界面](../.work/house-recovery-ui-0.75/output/playwright/recovery-320.png) · [界面验收](../.work/house-recovery-ui-0.75/browser-result.json)
- CBI 先搜索原同高度路线。原路线找不到施工站位时，尝试已存在、能往返且上下各限一格的台阶。每次实际移动仍检查方块支撑、上方净空、实体、边界、位置和退路，落地后再校验视线和扣料。Java 21 离线构建和 174 项测试通过。 [CBI JAR](../.work/minecraft-homebuild-cbi-0.76.Qqkd1c/carpetbaritoneintegration-v1.7.1+260820-homebuild-0.76.jar) · [对应源码](../.work/minecraft-homebuild-cbi-0.76.Qqkd1c/CarpetBaritoneIntegration-homebuild-0.76-source.tar.gz)
- 在上一版中断存档的隔离副本上，沿用同一草案、授权、83 块现成方块与剩余 12 块圆石。新的现场预检和开工确认后，角色从门外自行上升一格进入屋内，补完 5 块地板和 7 块屋顶，再退回门外原高度。39 次独立位置采样中有 17 次位于屋内 y≈81，全部 125 格及 5 个边界探针匹配，12 块圆石扣减一致，原有火把不变。期间未通过控制台修改地形或补充材料。旧失败任务保留，新成功回执唯一，数据库关闭重开后仍可读。约 30.2 秒包含预检、实际放置、回读和退回。 [续建验收](../.work/minecraft-house-recovery-0.76.OG18li/evidence.json) · [位置采样](../.work/minecraft-house-recovery-0.76.OG18li/attempt-evidence.json)
- 宿主、Worker 及相关场景 68 项定向回归和 `pnpm pack` 通过。宿主包 SHA-256 为 `79e5fbfae0bfe535253afaea8a97802d879abc8c8f0ffb51e5575a7549decc3d`，CBI JAR SHA-256 为 `5ab32f544d03ceee45f0f509809855ff681217110b1cc55ecbc8416a566dc040`。恢复选择由受控策略执行。正式 Coopcraft、安卓真机和签名 APK 留到集中验收。

## 106. Companion 0.77.0 角色调用施工恢复工具

- 工作台的施工恢复决策默认关闭，需要开启全局自主节律并单独授权。一次真实中断须有原任务、有效施工区和现场复查回执。后台优先让出前台对话和免打扰时段，每个中断最多一轮，过期、暂停或授权变化即结束。
- 私有 DSH 回合通过原生工具协议提供 `mc_recovery_observe` 和 `mc_recovery_plan`。大肥鱼可自行决定是否调用、先用哪个、是否写下一步，也可结束本轮。观察取当前工地和缺料，计划为角色自己写的一句话。两者分别保存。普通回复和未完整结束的回合不会生成计划记录。
- 复查不移动角色，也不生成开工许可。工作台分别展示旧复查、系统建议和角色本轮记录，配对手机仍不能进入私有恢复会话。开工沿用施工预检及确认。举盾等需要立即响应的动作沿用 CBI 的本地反射。
- 使用最终候选包打开两份真实 SQLite v37 数据库副本，迁移到 v38 后 26 张表的结构和已有数据一致，原件未改变，旧版拒绝直接打开新库。 [数据库迁移](../.work/house-recovery-migration-0.77/evidence.json)
- 最终候选实装到隔离 DSH，并连接 Fabric、Carpet 和 CBI。测试用上轮中断存档及真实预检生成旧回执，再将剩余圆石从 12 块调整为 9 块。角色工具实际核对 125 格并返回缺 3 块，测试模型收到回执后才提交自由文本方案。独立轮次验证了只写方案和纯文字不写方案。配对隔离、拒绝伪造事件及换绑、重启去重、背包与工地保持不变均通过。模型响应使用确定性夹具。 [隔离验收](../.work/house-recovery-dsh-0.77/run-g4c7o_pp/acceptance.json) · [原生工具回执](../.work/house-recovery-dsh-0.77/run-g4c7o_pp/native-tool-evidence.json)
- 287 项定向回归、17 组窄屏 Chromium 检查和 `pnpm pack` 通过。候选包 SHA-256 为 `ca12a43bc52f31e001e5e565710d90b8b3800d01ed06a8011a6330c597e02739`。正式 Mac mini、Coopcraft、安卓真机及签名 APK 留到集中验收。

## 107. Companion 0.78.0 小屋单格放置与改选

- 工作台新增独立放置授权，默认关闭。只有中断前已经确认开工、施工区有效、角色在线且 Worker 与 CBI 都支持 `homebuildone` 时，私有恢复回合才提供 `mc_recovery_candidates` 和 `mc_recovery_place`。旧 CBI 仍可使用 0.77 的只读工具和计划。
- 候选工具返回至多 12 个实际为空的蓝图格和相对位置。放置工具只接受蓝图非留空格的索引，材料和坐标由宿主从原草案确定。角色可直接选格，或者先观察。每回合最多尝试三个不同格，确认放置一块即用完额度。已占用、已相符或其他明确未写入的回执允许改选，不能确认结果时关闭本轮放置。
- CBI 使用已有背包、原版交互和受控退路放置。Worker 另行核对目标方块、恰好一块的材料扣减和回到原站位。暂停、撤区、前台对话、超时及断线仍约束执行。宿主仅在本回合判断是否让出前台时忽略其自己的单格施工，小家照常显示正在玩 Minecraft。
- 已核验的放置立即写入实际活动和跨场景共享记忆。工作台把单格回执和后续计划分开，保留中断状态和原失败任务。配对端只能看到可共享的成果，内部格索引、施工任务和计划留在宿主。完整续建仍需现场预检和确认。
- 最终包在两份真实 0.77 数据库副本上通过 SQLite v38 → v39，26 张表的原有数据保留，旧恢复授权不会启用写入。355 项定向回归、8 组窄屏 Chromium 检查、Java 21 离线构建和 `pnpm pack` 通过。 [迁移](../.work/house-placement-migration-0.78/evidence.json) · [界面](../.work/house-placement-ui-0.78/evidence.json) · [回归](../.work/house-placement-0.78-regression.log)
- 最终包通过真实 DSH 和隔离 Fabric 联测。确定性模型夹具读取 12 个候选，等第一格实际被测试玻璃占用后收到零扣料回执，继而改选并放置一块圆石。独立读取存档 125 格与 5 个边界，只有测试玻璃和本次放置两处变化，角色回到原站位。后续调用被额度挡住，独立配对聊天召回核验经历，重启没有重复施工。首轮暴露的自身活动误判已修复，真实前台优先继续生效。 [隔离联测](../.work/house-placement-dsh-0.78/run-l_znw0oo/acceptance.json)
- 最终宿主包 SHA-256 为 `15479c8aa229cd4df819187fe945a6986fec210f88ab3e608c7cf4cf167d725d`。正式 Mac mini、Coopcraft、安卓真机、签名 APK 和真实模型的决策质量留到集中验收。
- 对应 CBI JAR SHA-256 为 `afaef5a1f60c4db9ea646442465da553e79221d5e67de9cc3155f1948095a5c1`，源码归档 SHA-256 为 `90ffaca4949944fe3ca60209f7410eb2631286a3a3619b04b0a8aca0a01bb230`。 [CBI JAR](../.work/minecraft-homebuild-cbi-0.78/carpetbaritoneintegration-v1.7.1+260820-homebuild-0.78.jar) · [对应源码](../.work/minecraft-homebuild-cbi-0.78/CarpetBaritoneIntegration-homebuild-0.78-source.tar.gz)

## 108. Companion 0.79.0 小屋连续施工恢复

- 自主节律可为已确认过开工的中断小屋单独授权连续放置，默认关闭。原单格授权保持一次成功、三次尝试。连续回合最多四分钟、六个不同格和三次确认成功，仍受施工区、前台、免打扰和暂停限制。
- 同一回合可以再读一次候选，Worker 提供可核对的候选材料数量。库存为零和库存读数无法确认分别表达。每次放置读取实际方块、扣料和退路，返回剩余尝试和放置次数，由模型决定继续、改选或结束。已尝试位置和无法确认的写入都会约束后续调用。
- SQLite v40 新增逐格回执表，先持久登记尝试再写世界。明确未放置、已相符、成功和结果不明分开保存。宿主重启时把尚未结算的尝试标为待核对，并保留已核验成果。工作台可展示多块实际成果和独立计划，手机继续只召回公开可用的施工事实。完整小屋仍单独核验完工。
- 使用原 0.78 CBI JAR，无需更换服务端动作实现。两份真实 0.78 数据库副本迁移后，已有 26 张表和旧权限保留，新回执表为空，旧包拒绝直接打开新库。 [SQLite 迁移证据](../.work/house-continuous-migration-0.79/evidence.json)
- 真实 DSH 和隔离 Fabric 验证正常和暂停两条链路。正常分支中，测试夹具先后引入玻璃遮挡和暂时缺料，模型在收到两个零扣料回执后改选，完成三块圆石。独立复核 125 格和 5 个边界，排除夹具玻璃后只有三块被改动，圆石从 12 块减到 9 块。配对聊天召回已确认的经历，重启未重放。 [连续施工验收](../.work/house-continuous-dsh-0.79/run-8jgbdf_i/acceptance.json)
- 暂停分支从配对 API 让第二次实际 `runone` 停稳，服务端确认取消且无第二块，背包只少第一块的用料。第一次结果继续可查，第二次在宿主标记为待核对，重启仍保持暂停。两条游戏验收的模型均为确定性本地夹具。 [暂停验收](../.work/house-continuous-dsh-0.79/run-b40g7i3d/acceptance.json)
- 370 项定向回归、25 项最终宿主定向检查、13 组窄屏 Chromium 检查和 `pnpm pack` 通过。正式 Mac mini、Coopcraft、真实模型决策质量、安卓真机和签名 APK 留到集中验收。 [回归日志](../.work/house-continuous-0.79-regression.log) · [宿主复验](../.work/house-continuous-0.79-final-host.log) · [界面证据](../.work/house-continuous-ui-0.79/evidence.json)
- 完整游戏联测包 SHA-256 为 `cd5279cde2698a721ba47bcab2efee8fb6276660823b21fc4d552f0ab8dbf107`。最终包 SHA-256 为 `a1240e1168aa61dcc15cf89db004f166bdc743a035f6fa03773dc2a4707af609`。最终包只调整宿主启动恢复，客户端和 Worker 字节一致。实际 DSH 冷启动复验在数据库副本模拟中断于第二格已登记时，启动后取消未确认任务、保留第一格和暂停标记，且未重放。 [包间差异](../.work/house-continuous-package-0.79/host-startup.diff) · [最终包启动复验](../.work/house-continuous-dsh-0.79/final-restart-eyfhfud8/acceptance.json)

## 109. Companion 0.80.0 小屋完工核验

- 连续施工已取得至少一次真实放置回执后，私有回合可调用 `mc_recovery_verify`。宿主核对原施工授权、当前草案、角色会话、连续施工开关和逐格账本。每轮最多两次现场检查，成功后重复查询复用已核验结果。单格授权与普通对话保留原有工具范围。
- Worker 只读核对全部蓝图位置，包括实体材料、门洞和室内留空位。部分匹配返回缺块、受阻数量及至多 12 个相对格索引，大肥鱼可根据回执继续或结束。读取失败、现场变化、权限失效或存在未结算放置都会阻止登记完工。
- 完整匹配后，Worker 在 CBI 预检之外，通过一条原版只读指令同时核对所有位置。先前查过的格子若在最后核对时已不相符，就不会取得成功回执。普通空气和洞穴空气按现场实际类型校验。
- 完整结果以独立成功任务登记，保留原失败任务和每格施工回执。完工回执记录整体核验数和本轮实放材料，核验过程不扣料。工作台分别呈现放置、整体验收和计划。已核验完工可沿用 Minecraft 共享记忆，私有计划与内部关联继续留在宿主。
- SQLite 沿用 v40，继续使用 0.78 的 CBI JAR。正式 Mac mini、Coopcraft、真实模型选策、安卓真机和签名 APK 留到集中验收。
- 最终包使用真实 DSH 与隔离 Fabric。确定性模型在首轮核对 125 格时取得 123 格匹配、一个缺块和一个被玻璃挡住的留空位。夹具移除测试玻璃后，角色补最后一块并获得 125 格完整回执。独立读回存档，确认整轮只比原克隆多两块圆石，核验和重复查询均无新增放置。 [最终包隔离联测](../.work/house-completion-dsh-0.80/run-810uwht5/acceptance.json)
- 402 项定向回归、最终 Worker 67 项专测、16 项窄屏 Chromium 检查和 `pnpm pack` 通过。最终包读取三份 0.79 实际数据库副本，保留 27 张表、原开关、暂停和逐格账本。没有生成完工任务或活动。候选包 SHA-256 为 `cd05264c6e6763d6d1aa9a4ec2b4344b7c14da1ccb592a5f87bab7ea27fbc378`。 [回归](../.work/house-completion-0.80-regression.log) · [Worker](../.work/house-completion-0.80-worker.log) · [浏览器](../.work/house-completion-ui-0.80/evidence.json) · [数据库兼容](../.work/house-completion-compat-0.80/evidence.json)

## 110. Companion 0.81.0 主动小目标

- 工作台可单独允许大肥鱼在已有每日授权时段内自己提出目标，默认关闭。需要后台自主开启、前台连续空闲至少 20 分钟，且处于非免打扰时段。沿用原每日机会，窗口和动作权限不会随开关扩大。前台对话、暂停或撤销可以结束本次主动活动。
- 私有 DSH 会话通过 `daily_initiative_observe` 读取当下可用机会、最多四条近期真实经历与一个可核验的角色行为标签。`daily_initiative_propose` 允许她写一个自己想做的具体目标，引用本轮读到的依据，再决定做哪项已授权动作或留待以后。她也可以直接休息。
- 宿主核对准确的私有会话、接收回执、证据和动作选项。仅发送文字或 JSON 不会提交目标。目标在本轮完整结束后单独保存，现有营地和阅读流程重新验证权限和实际回执。工作台区分意愿、留待以后和已取得行动回执。配对聊天可召回实际经历，私有目标仍留在宿主。
- SQLite v41 无新增表。两份 0.80 与 0.79 实际数据库副本保留 27 张表、任务、回执、原授权和暂停状态，升级未自动打开主动目标。291 项定向回归、18 项窄屏 Chromium 检查和 `pnpm pack` 通过。 [数据库迁移](../.work/daily-initiative-migration-0.81/evidence.json) · [工作台](../.work/daily-initiative-ui-0.81/evidence.json) · [回归](../.work/daily-initiative-0.81-regression.log)
- 最终包在真实隔离 DSH、Fabric、Carpet 与 CBI 上验收。确定性模型调用原生工具，引用上轮小屋完工回执提出目标，真实角色向东走了 7 格后原路返回。配对会话可召回这次真实经历，私有目标留在宿主。同日重启没有重放，普通文字模拟工具调用也未执行。候选包 SHA-256 为 `3719d4ca9dbc48cf9d1c28e7b051e8c8d0b5f934246384341975c37f45b11027`。 [隔离验收](../.work/daily-initiative-dsh-0.81/run-ze1oxc66/acceptance.json)

## 111. Companion 0.82.0 模型请求与阅读预算

- 已有固定名称的后台会话在发送第一条任务前固定标题，避免 DSH 再请求一次模型。用户会话继续沿用 DSH 自己的标题策略。
- B 站后台评估和反思各用新的私有会话。原会话日志、候选、阅读回执和字幕归档保留，模型只收到本轮选项或经核验的本段摘录。由 Companion 创建或恢复的浏览、歌唱和动态专用会话把工具范围收紧为对应能力，普通聊天和游戏继续沿用原工具策略。
- 自动召回复用近 24 条模型可见消息里已经出现的同一份事实。内容修订或 DSH 压缩使原文退出该范围后，仍可重新召回。后台整理从同一会话上次确认的回合往后读，限制文本、已有记忆与笔记片段的输入，原始聊天和附件继续从日志读取。空增量可推进整理位置而无需请求模型。
- 工作台汇总近 24 小时主模型回报的未缓存输入、缓存读取、缓存写入和输出，另列后台用量及缺失统计次数。常规活动 API 不能写入模型用量事件。独立标题、原生压缩、未绑定场景的请求不在该面板统计范围内。SQLite 沿用 v41。
- 隔离 DSH 使用相同的两轮聊天、两条视频和两段本地字幕，对比 0.81.0 与 0.82.0。整个样本的模型请求由 9 次降至 7 次。B 站部分由 6 次降至 4 次，请求中的消息与工具 schema 共由 21,336 字节降至 17,016 字节。第二次阅读和反思只携带当前材料，第二次聊天中的同一条记忆由两份降为一份。模型由确定性回环夹具提供，字节量不等同于商业模型的 token 用量。 [请求对照](../.work/token-efficiency-0.82/comparison.json)
- 最终包对请求联测版的唯一宿主差异是修正 SQLite 用量查询的原生日志来源。最终包在原隔离数据库副本上读取 6 次模型用量，正确区分未缓存输入 156、缓存读取 480、输出 60，以及其中 4 次后台调用。专用 B 站和歌唱会话的真实模型请求只提供各自已注册的工具。250 项定向回归、TypeScript 检查、构建和 `pnpm pack` 通过。最终包 SHA-256 为 `09f4ebfab31a908715b7c0f6f76d73f88c28b5e937e7020fb0c03642eeb127a7`。正式 Mac mini、Coopcraft、安卓真机及签名 APK 留到集中验收。 [最终包计量与工具复验](../.work/token-efficiency-0.82/0.82.0-1amrc3ke/metering.json) · [定向回归](../.work/token-0.82-regression.log)

## 112. Companion 0.83.0 聊天工具按需加载

- 已绑定的根聊天会话只常驻记忆搜索和 `companion_open_capability` 两个 Companion 工具。其他 DSH 插件原有的工具仍由各自策略控制。入口可以为本轮打开单个记忆写入、修订、遗忘、Live2D 动作或停止工具。入口本身不执行动作。已打开的工具沿用 DSH 的注册、调用、结果与原权限，回合结束后收回。游戏、歌唱、B 站和后台决策沿用各自的工具策略。
- 明确的建房请求沿用原语句和附件规则，在第一次模型请求就带上蓝图工具。宿主核对同一根会话的真实收件箱原文、已接纳消息和当前绑定。改写、歧义、取消、换绑及失效会话不能激活或执行已打开的工具。蓝图仍是私有草案，开工沿用原预检和确认流程。
- 最终包在真实隔离 DSH 上分别通过 Native 与 PTC。两种模式都用配对 API 验证连续聊天、按需保存记忆、文本和单图蓝图、舞台停止请求以及下一轮工具收回。带图草案的附件与实际消息对应，未启动建造或 Live2D 渲染。决策由确定性回环模型提供。 [Native 验收](../.work/chat-capabilities-0.83/0.83.0-native-l19aqejw/evidence.json) · [PTC 验收](../.work/chat-capabilities-0.83/0.83.0-ptc-pzzjepl2/evidence.json)
- 同样两次闲聊与 0.82.0 对照。Native 工具定义由 8 份缩至 3 份，定义字节由 7,936 降至 1,601，完整输入约减少 53%。PTC 仍使用一份传输工具，随提示发送的 SDK 变短，完整输入约减少 35%。这些是发送给回环模型的请求字节，正式模型的 token 与费用另行测量。 [请求对照](../.work/chat-capabilities-0.83/comparison.json)
- SQLite 沿用 v41。最终包用真实 0.82.0 数据库和会话日志副本打开原聊天，保留四条消息并追加新一轮，完整性与外键检查通过。332 项定向回归、TypeScript 检查、构建和 `pnpm pack` 通过。候选包 SHA-256 为 `49d4795809d49b89e21f9088b953277981eb11266c9a2089ec2b03f4037db36d`。正式 Mac mini、Coopcraft、安卓真机及签名 APK 留到集中验收。 [会话升级](../.work/chat-capabilities-0.83/0.83.0-native-0ul0jahe/upgrade.json) · [定向回归](../.work/chat-capabilities-0.83-regression.log)

## 113. Companion 0.84.0 B 站画面与声音

- 在 `world.bilibili` 专用浏览话题发送「看这段 BV1dLx46TEhw 00:12 6秒 画面和声音」。支持 1–12 秒、BV 号或完整链接的分 P，以及单选画面或声音。每个当前配对或主人回合最多一次。工具以本轮实际收件箱和 DSH 日志为准，模型没有自填视频、时间或 CDN 的参数。后台自主浏览继续走资料和字幕。
- 按 BV 与分 P 的公开资料匹配 CID，匿名请求 WBI 播放信息，只在可用的 DASH 轨道上读取初始化、索引和相关字节段。拒绝不匹配的地址与区间、整文件响应和预算之外的数据。临时传输故障只重试一次同一区间，站点限制会暂停读取。 [DASH 轨道参考实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py) · [FFmpeg 过滤器文档](https://ffmpeg.org/ffmpeg-filters.html)
- FFmpeg 只接收已取回的内存片段，产生一张最多三格的抽样图和定长单声道 WAV。支持图片的当前会话模型接收画面，已配置的 `asrEndpoint` 生成声音转写。可用的单项仍可返回。转写最多 900 UTF-8 字节，图片最多 160 KiB。FFmpeg 默认从 PATH 读取，也可配置绝对路径 `bilibiliFfmpegPath`。宿主留存必要的 DSH 附件和原日志，后续主人回合的模型上下文只保留来源和时间。
- 小家在实际材料被接纳到 DSH 会话后才记录本次浏览。配对状态仅显示浏览与范围，普通聊天历史省略内部素材和转写。通用活动接口不能伪造片段回执。SQLite 沿用 v41。
- 使用最终包、真实隔离 DSH、B 站匿名公开样片、FFmpeg 与已有本地 Qwen3-ASR。配对会话取样第 12 至 18 秒，四个成功的媒体范围共 257,514 字节。实际模型输入包含一张 37,017 字节 JPEG 和本地转写。视觉端用确定性回环模型核对图片交付。使用该会话副本冷启动后，下一轮只收到来源说明，模型尝试自行重读时无新增网络请求。 [联测证据](../.work/bilibili-clip-0.84/resume-dsh-oux6qtdd/evidence.json)
- 256 项定向回归、宿主与移动端 TypeScript 检查、构建和 `pnpm pack` 通过。最终包 SHA-256 为 `198b74feef376674d2aa0fdd16a0c0db2ea0ac43d0ec66d800336f45fd662c76`。正式 Mac mini、真机和签名 APK 留到集中验收。 [定向回归](../.work/bilibili-clip-0.84-regression.log)

## 114. Companion 0.85.0 B 站自主短片段

- 在「自主节律 → B 站自主浏览」单独开启短片段权限，旧配置和新安装均默认关闭。她可以从主人加入或授权合集发现的候选里选一个分 P，自行确定开始秒数、1–8 秒长度和画面／声音模式，也可以继续只读资料、读字幕、略过或等待。每日 Minecraft 授权窗口中的 B 站选择沿用原有字幕规则。
- 每 24 小时最多尝试一次。限额与候选状态一起写入本地，失败、取消、暂停及重启都不会退回已使用的名额。候选、合集、总开关和免打扰时段在取样、提交素材和写回执前重新核对。新前台回合会打断在途取样或理解。
- 取样复用 0.84 的匿名字节范围、FFmpeg 和已配置的本地 ASR。成功素材送入新的无工具私有理解会话，必须核对完整输入、实际图片、有效回复及已完成回合才登记。原始素材和观察留在宿主。配对端的小家和共享记忆只得到核验事实，片段本身不触发字幕反思或动态发布。SQLite 沿用 v41。
- 最终包使用真实隔离 DSH、公开 B 站视频、FFmpeg 和本地 Qwen3-ASR。两次模型请求分别完成选段和理解。分析回合实际收到第 12–18 秒的画面与声音转写，4 个媒体范围共 257,514 字节。模型决策与视觉响应由确定性回环夹具提供。私有会话已释放并阻止配对访问，工作台回执、小家浏览和事实记忆均已核对。 [真实链路](../.work/autonomous-bili-0.85/real-dsh-nxm_quju/evidence.json)
- 从包括已提交 WAL 数据的 SQLite 副本冷启动后，配对手机的模型输入只获得核验过的浏览事实。另一个候选的评估仍处于片段冷却，期间没有外部网络请求。 [冷启动与跨场景召回](../.work/autonomous-bili-0.85/resume-6w683lvo/resume.json)
- 435 项定向回归、宿主和移动端 TypeScript 检查、构建及 `pnpm pack` 通过。最终包 SHA-256 为 `c7633eea3132087a53f7dbd9103bb40b61aaf01fca2758eae3ca226ae1a11c2d`。正式 Mac mini、真机和签名 APK 留到集中验收。 [定向回归](../.work/autonomous-bili-0.85-regression.log)

## 115. Companion 0.86.0 单次请求看片与用量归因

- 在专用 B 站浏览话题提交明确的 BV、分 P、开始时间和片段长度时，宿主直接取样，第一条模型请求就携带可用画面和转写。沿用 1–12 秒、一次请求一次取样，以及匿名媒体字节限额。原取样工具不再随会话工具定义发送。公开资料和按需字幕仍通过原浏览工具读取。
- 取样只认本轮唯一、未经改写的主人或配对设备纯文本输入。在网络和附件异步阶段再次核对活动会话。无可用素材时向本轮提供短错误原因，不登记浏览成功。小家状态基于 DSH 实际接纳的材料。后续会话只带来源与时间，完整材料仍留在原日志中。新建浏览话题使用已有场景名称，避免额外自动标题请求。
- 自主评估仍由大肥鱼决定看、略过或等待。只有宿主的私有选片会话应用短 JSON 输出预算，最多 192 token，沿用模型更低的既定上限。仅精确路线声明支持 `off` 时关闭推理。已知需要推理且没有 `off` 的路线沿用原设置。内容理解、聊天、游戏及人格复盘仍沿用各自的模型设置。
- 工作台在 24 小时汇总下按场景列出用量。最多展示未缓存输入、缓存写入与输出合计最高的八个场景，并单列缓存读取、缺统计的调用和供应商已报告的推理量。推理量不重复加入输出。手机继续收到原汇总，分场景明细留在宿主。原生压缩、独立标题及绑定外请求仍不在统计范围。SQLite 沿用 v41。
- 同一公开视频第 12–18 秒，实际 B 站、FFmpeg、本地 Qwen3-ASR 和隔离 DSH 跑通。旧取样流程需要两个主模型请求，本候选只需一个。两版送达模型的 JPEG 与转写哈希一致，四个成功的媒体范围合计 257,514 字节。新话题无标题模型调用。真实视觉理解及供应商实际节省的 token 尚未测量。 [请求与材料对照](../.work/bili-fast-path-0.86/acceptance.json)
- 隔离 DSH 的自主选片使用无工具的单次请求，OpenAI 兼容夹具在 HTTP 请求收到 192 的上限，核对未缓存、缓存读取、输出的统计归因以及等待时零外部访问。0.84 原日志和数据库副本升级后没有重发旧图或转写，也未再次访问 B 站。 [选片与计量](../.work/bili-fast-path-0.86/real-dsh-7xdclkaq/choice-evidence.json) · [冷启动升级](../.work/bili-fast-path-0.86/resume-dsh-i6ospvfu/evidence.json)
- 352 项定向回归、宿主和移动端 TypeScript 检查、构建及 `pnpm pack` 通过。候选包 SHA-256 为 `d866df02b0977858a419f4ca1d8c704e77882734f43bda7c3d135ba8c6b8a245`。正式 Mac mini、真机和签名 APK 留到集中验收。 [定向回归](../.work/bili-fast-path-0.86/regression.log) · [清理记录](../.work/bili-fast-path-0.86/cleanup.json)

## 116. Companion 0.87.0 跨日自主目标

- 保留原先的主动目标开关、每日一次机会、空闲门槛和授权窗口。大肥鱼调用 `daily_initiative_observe` 后可见最多三个先前暂存的目标，按近到远排序。目标单独列为意图，模型只见本轮编号和短文本，原任务编号留在宿主。
- 她可以继续原目标、改写后接续、再次暂存、明确放下或直接休息。继续和改写仍引用本次观察提供的证据和选项，实际行动重新检查当天许可。放下只提交本轮观察得到的待续编号。当天没有通过检查的世界行动时，待续目标仍可在原有授权窗口内被放下或保留。
- 一份原目标及其修订共用首次暂存起七天的期限。再次暂存替代前一份。只有后续行动获得核验回执，或主动放下的模型轮完整提交，才结束待续目标。中断、前台对话抢占及行动缺回执保留原目标。任务历史原文仍可在工作台回看。配对端和共享记忆仅得到经核验的实际经历。
- 继续读取 SQLite v41 的现有任务载荷，旧版暂存记录可直接接续。每天沿用独立私有会话，无需把过去的整段聊天带进当前模型请求。
- 最终候选用真实隔离 DSH、Fabric、Carpet、CBI 和 Minecraft Worker 验收。第一天的模型轮只暂存目标，角色位置与施工指令数保持不变。跨日冷启动后，第二天模型看到旧目标并选择调整，用当天现场证据确认向东走 7 格并原路回营。配对聊天召回的是实际勘察，共享记忆与配对状态未带入两天的私有目标。两个模型决定由确定性回环夹具给出。 [跨日隔离验收](../.work/daily-pending-0.87/run-5i_vh82k/acceptance.json)
- 599 项定向回归覆盖授权、原始期限、接续、主动放下、失败保留、跨场景隐私和相邻世界能力。宿主及移动端 TypeScript 检查、构建与 `pnpm pack` 通过。候选包 SHA-256 为 `e23821b9938a7886953f071805c6631ddcb381edf576287f06e74cdc3be96bb8`。正式 Coopcraft、Mac mini、安卓真机与签名 APK 留到集中验收。 [回归日志](../.work/daily-pending-0.87-regression.log) · [临时文件清理](../.work/daily-pending-0.87/cleanup.json)

## 117. Companion 0.88.0 手机一起看 B 站

- DSH Go 开发版的小家提供「一起看 B 站」。新宿主通过配对状态公布专用话题和片段上限，旧宿主隐藏入口。复用原流式聊天、发送、历史、配对和撤销处理，单独绑定 `world.bilibili`，主聊天继续使用 `chat.mobile`。
- 手机表单接受 BV 号或完整 B 站视频链接，可沿用分 P 和链接时间，也可指定开始时间、片段长度及画面／声音模式。默认最多 12 秒并尊重宿主的更低上限。表单只生成可编辑草稿，发送才触发取样，已有草稿保留。短链接须先展开成完整链接。
- 小家区分片段取样与字幕阅读。主人请求的核验回执可显示分 P、时间、长度和实际取得的素材类型，并在浏览器或 B 站应用打开出处。自主浏览继续只投影类型和时间。原图、转写、私有会话编号及候选资料均不通过回执传给配对端。旧版只带时间的回执仍可显示。
- 用最终包、真实隔离 DSH、匿名 B 站和 FFmpeg 验证第 12–18 秒的画面请求。两个媒体范围共 173,170 字节，模型首个请求收到抽样图，回执标记只取得画面。手机主聊天历史为空且隔离。后续追问没有重复取图或重发图像。理解回复使用确定性回环模型。 [隔离验收](../.work/bili-mobile-0.88/real-dsh-az6qxfbd/evidence.json)
- 63 项 Flutter 定向检查、303 项宿主检查、双语文案生成、TypeScript 检查与 `pnpm pack` 通过。候选包 SHA-256 为 `7bfeeb4e5af9659408626c48454550d2a934bf179d9f80f404d75dedb67b3df9`。SQLite 沿用 v41。正式宿主、安卓真机及签名 APK 留到集中验收。 [Flutter 检查](../.work/bili-mobile-0.88-flutter.log) · [宿主检查](../.work/bili-mobile-0.88-host.log)

## 118. Companion 0.89.0 Minecraft 游戏聊天上下文

- 游戏会话把通用操作规则放在当前 Minecraft 根会话的系统提示。每条游戏事件输入保留按顺序接收的主人消息。背包、现场、授权区、衣柜和经验不随普通私聊自动读取。旧会话的原始日志和现有历史保留。
- `mc_observe` 仍读真实现场。`mc_status` 默认只查连接与当前动作，可单独请求 `build_zones`、`wardrobe` 或 `lessons`。授权区一次最多八条，可用 `nextOffset` 翻页。模型用 `mc_chat` 发出经 CBI 确认的私聊后只收到送达回执。Worker 可跳过发信后的现场回读。工作台的完整状态和聊天接口沿用原数据。
- 游戏检索以主人原话触发。每批仍最多六条。用 Worker 来源和事件序号区分新消息，缓冲轮换不会把到达较晚的消息误算成已处理。重启 Worker 时重置读取游标，旧 Worker 的迟到结果不能推进新游标。SQLite 沿用 v41。
- 以同一隔离 Fabric、Carpet 和 CBI 服务、同一个真实 Mineflayer 测试玩家、同两条游戏私聊对照 0.88.0 与 0.89.0。两版各发五次主模型请求，均完成两条实际私聊回复。模型请求体合计从 112,549 字节降至 71,586 字节，下降 36.4%。查授权区的工具结果从 5,129 字节降到 151 字节，两份私聊结果合计从 2,815 字节降到 182 字节。模型选择用确定性回环夹具，真实供应商 token 和费用待计量。隔离服 CBI 仍会显示自己的自然语言控制关闭提示，随后可收到大肥鱼的私聊。 [隔离新旧对照](../.work/minecraft-chat-0.89/run-3sczxi6f/evidence.json)
- 937 项宿主与 Worker 定向检查通过，覆盖缓冲轮换、旧来源回包、权限、记忆查询及送达核验。宿主和移动端 TypeScript 检查、构建与 `pnpm pack` 通过。最终候选包 SHA-256 为 `9528e76b4b5c4f007acc1d361caf3a5d931f4b69a678b5f4d7a4fa175458f6a6`。正式 Coopcraft、Mac mini、安卓真机和签名 APK 留到集中验收。 [回归日志](../.work/minecraft-chat-0.89-regression.log) · [清理记录](../.work/minecraft-chat-0.89/cleanup.json)

## 119. Companion 0.90.0 Minecraft 私聊接管

- 搭配支持此能力的 CBI，工作中的 Companion 通过 Worker 接收配置主人发给大肥鱼的普通私聊。服务端仍显示玩家发出的私聊确认，由 Companion 独立决定是否回复或调用工具。访客私聊与 `cbi` 前缀命令沿用原行为。旧 CBI 可继续使用原来的游戏聊天路径。
- 接管只对当前 Carpet 假人和配置的主人有效，服务端在内存中保留 15 秒。启用游戏聊天、会话已绑定且营地允许时，宿主在已鉴权的事件轮询中请求续租。Worker 每 6 秒至多申请一次续租。停止接收时发起清除，控制台或宿主异常时以服务端到期为准。Worker 连接变更后丢弃待发旧续租，玩家退出或服务端重启清除对应记录。
- 仅服务端控制台可以变更接管。解析和实际执行分别验证命令来源，避免外层 `execute as` 改变执行身份。CBI 内置自然语言开启时继续拥有自己的路径。旧版普通私聊、接管私聊、CBI 指令及内置自然语言使用不同路由标识，Companion 保持原私聊脱敏和送达校验。SQLite 沿用 v41。
- 用最终宿主包和配套 JAR 在隔离 DSH、Fabric、Carpet 以及两个真实 Minecraft 客户端中验证。两条主人私聊均收到实际回复，客户端没有收到原关闭提示。访客继续收到 CBI 提示，`cbi status` 正常返回。玩家执行、控制台切换成玩家执行、真人目标和未鉴权的 Worker 请求均未获得接管权限。关闭自主后收到清除回执，重新打开可以续租，随后冻结宿主而保留 Worker 与游戏服在线，16.17 秒后的主人私聊恢复 CBI 提示。模型回复使用确定性回环夹具。 [隔离验收](../.work/minecraft-chat-relay-0.90/run-41sbic4r/evidence.json)
- 569 项宿主与 Worker 定向测试、182 项 CBI 测试、33 项裁剪 SDK 兼容性测试通过。宿主和移动端 TypeScript 检查、构建及 `pnpm pack` 通过。正式 Coopcraft、Mac mini、安卓真机和签名 APK 留到集中验收。 [宿主回归](../.work/minecraft-chat-relay-0.90/regression.log) · [Java 测试](../.work/minecraft-chat-relay-0.90/java-tests.json) · [清理记录](../.work/minecraft-chat-relay-0.90/cleanup.json)
- 宿主候选包 SHA-256 为 `2bd2360e87002f776e356e2de80abb4fc69a2cc0159e8cb4ff1045099a2bf3be`。CBI JAR 为 `38c39622dee9edc9c860f16aae14789455ba4b4283d41e236c2dcd79715810fd`。对应源码归档为 `5d20c35eb81db08238ce0d1f22e61bf7fd3fafa7e249b8f5e77b57596bec3168`。 [宿主候选包](../dsh-companion-bot-0.90.0.tgz) · [CBI JAR](../.work/minecraft-chat-relay-0.90/carpetbaritoneintegration-v1.7.1+260820-chat-relay-0.90.jar) · [对应源码](../.work/minecraft-chat-relay-0.90/CarpetBaritoneIntegration-chat-relay-0.90-source.tar.gz)

## 120. Companion 0.91.0 跨场景记忆纠正

- 既有手机、Minecraft 和其他已绑定场景会话在模型步骤前复查已注入的自动召回。遗忘、归档、降回候选、共享收回、正文变化和取消锚点均可撤回旧片段。同段有效条目继续保留。当前问题仍按既有相关度与预算读取有效版本。
- 宿主沿用 DSH 的位置替换记录，原始日志可用于追溯，普通消息及其顺序继续独立。旧多行片段按当前可见条目重建。混有旧记忆的历史附带文字留在原日志中，角色身份按当前设置恢复。新的片段把条目正文换行显示为单行标记，以便逐条撤回。
- Companion 主动调用闲置压缩前使用同一检查。模型执行遗忘工具只收到编号与遗忘状态，下一工具步骤也适用撤回。已写进原始聊天、旧工具结果或先前生成的摘要的内容，各自仍有独立的历史生命周期。SQLite 沿用 v41。
- 使用实际配对设备 API、隔离 DSH、Fabric、Carpet、CBI 与真实 Minecraft 私聊完成双向写入及召回。手机写入的约定可由游戏按需召回，游戏写入的约定可由手机召回，两条原始对话和对方的私有记忆均未串场。0.90.0 在同一模型请求中保留了新旧暗号，原会话冷升级到 0.91.0 后只发送正确版本，同时保留同段的另一条事实。两端 Session ID 和原始历史一致。 [双向验收与模型输入证据](../.work/cross-scene-memory-0.91/run-h26sa02c/evidence.json)
- 手机调用遗忘工具后，同回合的下一次模型请求已去除自动召回原文。之后核对可恢复、撤回共享后游戏不再收到该记录、修订历史及 SQLite 完整性。20 个模型请求使用确定性回环夹具。旧版冲突轮与升级后核对轮的自动召回文本分别为 1,012 和 882 字节，两轮的普通历史长度不同，不由此推算整轮 token 或费用。 [请求记录](../.work/cross-scene-memory-0.91/run-h26sa02c/model-requests.json)
- 86 项定向测试、宿主与移动端 TypeScript 检查、构建及 `pnpm pack` 通过。候选包 SHA-256 为 `5159cf0e02643cc38fe5fc71f452302607e1fd193ef402f5ba4b4d8ab825032b`。正式 Coopcraft、Mac mini、真机和签名 APK 留到集中验收。 [宿主回归](../.work/cross-scene-memory-0.91/regression.log) · [候选包](../dsh-companion-bot-0.91.0.tgz) · [清理记录](../.work/cross-scene-memory-0.91/cleanup.json)

## 121. Companion 0.92.0 角色档案版本

- 「角色设置」可以编辑固定档案、保存修改说明、分页查看历史和预览完整快照。恢复使用旧快照生成新版本。已存在相同内容时维持当前版本。新工作台用版本号防止旧草稿覆盖另一处已保存的档案，原管理端保存接口沿用原字段。历史和恢复通过同源管理接口开放。
- 当前固定档案以单一系统提示段进入已绑定聊天、游戏和话题根会话。摘要前 900 个字符纳入提示，完整档案留在工作台。旧版自动注入的档案从模型历史撤回。同一片段里仍可用的记忆保留，私有决策沿用各自的短提示。自我笔记、主人观察和档案编辑说明按各自的数据边界保存。
- SQLite v41 的已保存档案导入第 1 版，保留原时间。版本内容及对应活动在同一事务提交。升级到 SQLite v42 前备份数据库与会话文件，回退插件时使用升级前的副本。正式 Mac mini、Coopcraft、安卓真机和签名 APK 留到集中验收。
- 隔离 DSH 以 0.91.0 建立的独立配对聊天和 Minecraft 私聊会话原地升级。编辑到第 2 版、从第 1 版恢复为第 3 版后，两端后续模型请求各只含当前档案，旧自动注入档案退出。原聊天、自我笔记、共享记忆和升级前 SQLite 副本经核对。实际配对接口、Fabric、Carpet 与 CBI 参与验收，模型回复使用确定性回环夹具。 [迁移与请求验收](../.work/persona-0.92/run-qlry989v/evidence.json)
- 230 项定向检查、TypeScript 检查、构建及 `pnpm pack` 通过。390 像素 Chromium 工作台完成保存、预览和恢复，页面没有横向溢出。最终候选包 SHA-256 为 `323bcc12bbcc19e21a1b3d76a848c33f77987eca5ab6b5edcf985f3b73df72ea`，宿主 bundle 与隔离端到端验收时一致。 [定向检查](../.work/persona-0.92/regression.log) · [窄屏工作台](../.work/persona-0.92/output/playwright/persona-history.png) · [候选包](../dsh-companion-bot-0.92.0.tgz)

## 122. Companion 0.93.0 跨场景行为修订

- 自主复盘最多带入三条同一世界的旧观察与一条其他世界的旧观察。有文字相关的回执优先。没有词语重叠时，其他世界的候选需要已确认回执、行为标签和助手证据。早期自主活动的旧笔记可从精确匹配的原回执临时补齐复盘材料，SQLite 原记录与历史快照保留原样。
- 聊天、Minecraft 和话题根会话在现有系统提示中读取一条当前行为倾向。相关的其他观察按需召回，跨场景只显示预定义标签。旧版已经进入模型历史的行为标签及无出处观察会被撤回，带编号的相关观察归档后也会撤回。原始日志、普通消息和仍有效的事实保持可追溯。
- 隔离 DSH 从 0.92.0 升级时保留同一对配对手机及 Fabric 私聊会话。复盘用旧的 B 站字幕回执及已放置 94 块、核验 125 处的小屋回执完成一次修订。两端后续请求只收到新的行为提示，归档并重启后也撤回了新提示。B 站回执来自更早的回环元数据与主人提供的 WebVTT 夹具，Minecraft 回执来自隔离世界施工，决策使用确定性回环模型。 [隔离证据](../.work/growth-world-0.93/run-ktf_xxsx/evidence.json) · [模型请求](../.work/growth-world-0.93/run-ktf_xxsx/model-requests.json)
- SQLite 保持 v42。248 项定向检查、宿主与移动端 TypeScript 检查、构建及打包通过。候选包 SHA-256 为 `b46a7ebede2487495b216461a5692294893bfc12772da58ed5a10d2b63f84e7d`，与隔离验证包仅 README 不同。正式 Coopcraft、Mac mini、安卓真机和签名 APK 留到集中验收。 [定向检查](../.work/growth-world-0.93/regression.log) · [候选包](../dsh-companion-bot-0.93.0.tgz) · [清理记录](../.work/growth-world-0.93/cleanup.json)

## 123. Companion 0.94.0 每日窗口看片

- 在工作台「自主」开启 B 站浏览和短片段，再在每日活动授权中允许 B 站浏览。大肥鱼可从已授权候选中选择字幕或抽样，按可用能力自己填写起点、时长和画面／声音模式。普通每日选择和启用主动目标工具的模式均支持。与普通自主浏览共用每 24 小时一次的尝试预算，每段至多 8 秒。前台开始、授权撤回、免打扰或窗口结束会阻止未完成的取样落账。
- 取样结束后核对候选、已选区间、实际模态、私有理解回合及子任务回执。每日机会只接受匹配的回执，已完成的子任务可在重启后用于结算父任务。小家显示已核验的活动，配对聊天可以按需召回共享事实。后续复盘只读取片段回执，次日自主目标使用不带视频编号的简短事实。抽样画面、原始转写和私有观察留在隔离的理解会话。此链路不自动发布片段动态。
- 隔离 DSH 经两项原生主动工具选中真实 B 站视频第 12 秒起的 6 秒，公开接口只请求了必要媒体范围，共 257,514 字节。最终一轮用实际 FFmpeg 生成抽样画面，用本机 Qwen3-ASR 转写。首轮只得到画面，验收重试得到了两种材料。观察和复盘由确定性测试模型输出。推进隔离时钟至次日并保留冷却后，下一次决策读到先前经历且没有下载媒体。手机配对接口读取小家并按需召回，私有上下文不可访问。 [完整链路证据](../.work/daily-bili-clips-0.94/real-dsh-rkbnof6_/evidence.json)
- 407 项定向检查、TypeScript 检查、构建和打包通过。SQLite 保持 v42。候选包 SHA-256 为 `0430d3303eea2d93071132f3aefbe17b44db851f66a587f99a64bc446846c3fb`。正式环境、安卓真机与签名 APK 留到集中验收。 [定向检查](../.work/daily-bili-clips-0.94/regression.log) · [候选包](../dsh-companion-bot-0.94.0.tgz)

## 124. Companion 0.95.0 短片段动态

- 工作台新增独立的短片段分享开关，默认关闭。符合动态冷却条件时，大肥鱼在理解片段的同一模型回合决定是否附上一句感受。宿主核对实际模态、片段起点、候选、任务、来源和当前授权，然后写入原有私有动态。同一分 P 沿用既有分享去重。撤回、冷却和无有效感受时只保留看片经历。
- 动态正文由角色感受与已核验模态组成，出处使用原有的分 P 和时间点格式。抽样画面、转写和私有观察留在理解会话。配对端的动态、实时事件与状态视图过滤私有发布和理解会话标识，收件箱与动态回复沿用现有入口。
- 隔离 DSH 经每日自主工具选中真实 B 站第 12 秒起的 6 秒画面。FFmpeg 实际生成抽样图，媒体范围合计 173,170 字节。确定性测试模型在同一轮选择分享，随后用原生动态工具回复了配对端留言。动态和回复均到达收件箱及 WebSocket，另一个手机聊天 Session 只召回公开给配对端的经历。 [隔离证据](../.work/bili-clip-share-0.95/real-dsh-fkgw2i0p/evidence.json)
- 421 项宿主定向检查、13 项 DSH Go 动态及收件箱测试、类型检查、构建和打包通过。SQLite 保持 v42。最终候选包 SHA-256 为 `a3c2347982138814230e5dc0b2dd340193537424380508441a77adbd5abb85c7`。实测包之后仅调整了纯音频感受的前缀，使其明确说明使用转写。正式环境、安卓真机与签名 APK 留到集中验收。 [宿主检查](../.work/bili-clip-share-0.95/regression.log) · [DSH Go 检查](../.work/bili-clip-share-0.95/flutter.log) · [宿主候选包](../dsh-companion-bot-0.95.0.tgz)

## 125. Companion 0.96.0 小家实时活动

- 配对事件接口增加只读的 `view=home`。连接后立即取当前投影，活动或复盘状态改变时推送，稳定时每 10 秒发送心跳快照。有订阅时每 250 毫秒检查一次变化。该流不回放历史，只携带房间活动、锚点、街区位置、观察时间和可选的复盘状态。撤销配对关闭该设备的连接。
- DSH Go 在小家前台且宿主声明支持时订阅，切页、退后台或撤销后关闭。已有状态接口继续负责最近活动、能力和营地进度。收到实时帧时，定期完整刷新间隔由约 5 秒降至约 20 秒。旧宿主、短时断线和超时回退到原轮询。最近记录和历史笔记保持原有刷新范围，较旧的 HTTP 响应不会盖掉新实时状态。
- B 站实际取样后，宿主核对同一理解会话已收到的消息和图片，在真实理解回合期间继续显示阅读角。回合完成、取消、超时、换绑或输入失配后退出。隔离 DSH 对真实 B 站画面进行 FFmpeg 取样，确定性测试模型在收到片段后暂缓回复，配对流与完整状态都保持阅读中。放行后本机单次测得 30 毫秒回到窗前，随后真实配对聊天移到沙发，进入免打扰移到床边。最大实时帧 267 字节，撤销后连接关闭且 HTTP 拒绝访问。 [隔离验收](../.work/home-live-0.96/real-dsh-7tesmhqn/evidence.json)
- 402 项宿主定向检查、19 项 Flutter 小家与状态测试、TypeScript 检查、构建和打包通过。SQLite 保持 v42。候选包 SHA-256 为 `731148d108935ddad8e02e852caf9a179f3a8b3a8ad6965f5230e3ac22d35217`。正式环境、安卓真机和签名 APK 留到集中验收。 [宿主检查](../.work/home-live-0.96/host.log) · [Flutter 检查](../.work/home-live-0.96/flutter.log) · [宿主候选包](../dsh-companion-bot-0.96.0.tgz)

## 126. Companion 0.97.0 手机播放回执

- DSH Go 在配对音频请求中携带本次启动生成的标识。宿主为已鉴权的首块 PCM、从文件起点请求的语音 WAV 或归档歌曲 WAV 返回短期使用的播放标识。旧宿主返回原有音频，旧客户端仍可播放。HEAD、失败请求和非起点范围不会签发标识。
- 手机原生播放器确认起播或恢复后才上报，每 2 秒续报。暂停、结束、替换、失败和释放播放器时终止。宿主从音频来源决定说话或唱歌，按同一手机的原生起播顺序合并。终止状态覆盖同一轮迟到的心跳。撤销配对立即清理，断线时从最后一次续报起 6.5 秒到期。
- 小家和街区沿用既有实时帧，同时参与前台活动判断。Minecraft 优先于语音活动。舞台口型继续由舞台自身音频驱动。播放标识和续报保留在宿主内存，实时帧不带消息、任务或设备标识。
- 隔离真实 DSH 从已保存的助手消息走完 24 kHz PCM 与归档 WAV 路径，音频由确定性回环服务提供，播放回执用配对 HTTP 模拟。第二个配对客户端通过 WebSocket 观察到起播、暂停、恢复、结束、断线到期和撤销。单次 PCM 回执至小家更新 233 毫秒，断线到期 6.737 秒，最大实时帧 266 字节。Flutter 另行验证原生回调。 [隔离验收](../.work/mobile-playback-0.97/evidence.json)
- 124 项宿主定向检查、58 项 Flutter 检查、TypeScript 检查、构建与打包通过。正式服务、安卓真机和签名 APK 留到集中验收。 [宿主检查](../.work/mobile-playback-0.97/host.log) · [Flutter 检查](../.work/mobile-playback-0.97/flutter.log) · [宿主候选包](../dsh-companion-bot-0.97.0.tgz)

## 127. Companion 0.98.0 动态单次回复

- 主人发动态或评论时，原有延迟、冷却和免打扰规则继续生效。每次评估新建独立私有 Session，保留之前的日志。模型看当前互动全文、原动态摘要和最多三条近期互动，图片仅标记存在。模型可以回复或沉默，无工具续轮。支持普通输出的模型上限为 512 token，沿用已有更低限制，需强制推理的模型保留原配置。
- 宿主只发布通过本轮证据核验的文字。更新的主人评论会淘汰旧草稿，删除原动态、停用开关、会话换绑或到期时停止旧评估的发布。每条回复关联一个已授权的任务来源，同一个任务只能留下一个发布回执。原有可选记忆整理仍独立进行。
- 已发布内容仍进入配对线程、活动页、收件箱、实时流和小家最近记录。评估内容和任务来源留在宿主。SQLite 仍用既有 v42 格式。
- 隔离 DSH 用相同原动态、评论和确定性模型结果比较最终候选与 0.97.0。两次回复从四个主模型请求减为两个，实际传输的消息与工具定义 JSON 从 30,584 字节减到 8,811 字节，约减少 71%。字节量用于比较这组样本，实际 token 取决于模型和缓存。联测另核对新评论替换、删除、主动沉默及配对输出。 [0.97.0 对照](../.work/feed-reply-0.98/evidence-0.97.0.json) · [0.98.0 验收](../.work/feed-reply-0.98/evidence-0.98.0.json)
- 宿主定向回归、Flutter 动态与收件箱检查、TypeScript 检查、构建与打包通过。正式服务、安卓真机和签名 APK 留到集中验收。 [宿主检查](../.work/feed-reply-0.98/regression.log) · [Flutter 检查](../.work/feed-reply-0.98/flutter.log) · [宿主候选包](../dsh-companion-bot-0.98.0.tgz)

## 128. Companion 0.99.0 Minecraft 短时举盾

- 游戏根会话可调用 `mc_shield`，限 1–5 个整秒，默认 2 秒。工作台也可举盾两秒，动作进行时可按停止。Worker 通过实际 CBI 能力探测启用，旧 CBI 返回明确的不可用状态。短访已有动作和营地暂停继续约束新操作。
- 配套 CBI 复用已有盾牌和副手交换，保留原副手物品。服务端用原版格挡状态累计 tick，并在结束时核验释放。TNT 或苦力怕避险、停止、请求取消、死亡、换维度和超时可中断。请求标识只用于 Worker 核对同一假人的服务端回执，配对端收到紧凑状态。手机联络站使用可选字段，原有动作枚举兼容旧客户端。
- 隔离 Fabric 1.21.1 实测同方向的原版伤害。未举盾掉 6 点血，举盾时掉 0 点，盾牌扣了耐久。两次完整动作分别回读 20 tick 中格挡 15 tick、60 tick 中格挡 55 tick，均确认结束时放下。另验证缺盾、忙碌、未认证请求、原始 CBI 指令绕过、TNT 中断、手机暂停和下线。
- 真实游戏客户端私聊触发独立游戏会话，确定性回环模型调用 `mc_shield` 和 `mc_chat`，按工具回执私聊回应。配对手机的另一 Session 随后召回已验收经历，工具权限仍留在游戏侧。隔离世界副本已清理，原模板区块哈希一致。 [隔离验收](../.work/minecraft-shield-0.99/evidence.json)
- 363 项宿主和 Worker 定向回归通过，最终投影及启动处理的 53 项定向回归通过。CBI 217 项 Java 检查、27 项 Flutter 检查、构建和打包通过。正式 Coopcraft、真机和签名 APK 留到集中验收。 [宿主检查](../.work/minecraft-shield-0.99/regression.log) · [CBI 检查](../.work/minecraft-shield-0.99/java-tests.json) · [Flutter 检查](../.work/minecraft-shield-0.99/flutter.log)
- 使用短时举盾需搭配本候选的 Companion 包与 CBI JAR。 [宿主候选包](../dsh-companion-bot-0.99.0.tgz) · [CBI JAR](../.work/minecraft-shield-0.99/carpetbaritoneintegration-v1.7.1+260820-shield-0.99.jar) · [配套源码](../.work/minecraft-shield-0.99/CarpetBaritoneIntegration-shield-0.99-source.tar.gz)

## 129. Companion 0.100.0 按需情绪配音

DSH Go 开发版可在已完成的助手消息下选择参考音色、开心或低落。每段最多 480 个 UTF-16 代码单元，宿主从当前场景的已保存回复读取原文。合成使用预设语气和预计算的大肥鱼参考音色，全程本地执行。手机沿用 WAV 下载、暂停、继续和重播，宿主沿用可清理的语音媒体缓存。日常文字回复、普通朗读和实时流式语音保留原入口。

宿主默认关闭情绪配音。Apple Silicon 上可用 Python 3.12 专用环境安装实测的 [MLX IndexTTS 实现](https://github.com/vanch007/mlx-indextts2/tree/a7666367b8551656a2029ad75f259cb5e4936b3b) 的 `v2` 依赖，实测使用 MLX 0.32.4、Torch 和 TorchAudio 2.10.0、Transformers 4.57.6。将 V4 的 `IndexTTS2.0_v4/checkpoints` 所需文件按原目录提取，再运行准备脚本。文件清单和缺失提示均由脚本检查。输出使用媒体目录之外的私有路径。

```sh
"$voice_python" scripts/prepare-indextts2.py \
  --checkpoints "$extracted_checkpoints" \
  --reference "$whale_reference_wav" \
  --output-dir "$prepared_model"
```

在 Companion 配置中同时填入 `ttsExpressivePythonPath` 和 `ttsExpressiveModelDir` 的绝对路径。准备目录约 2.74 GB，包含约 4.19 MB 的音色缓存。准备完成后，正常合成使用这一目录和 Python 环境。状态接口只在必需文件齐备时公布支持的预设和上限。请求共享现有语音队列，同一时间只运行一个 WAV 任务。相同会话、原文、语气及模型版本的结果可重用。排队或合成中可以停止，取消和失败的结果可重试。

实际 DSH 隔离宿主以 Apple M5、24 GiB 运行真实 IndexTTS。同一句中文生成三份完整 PCM WAV，从请求至宿主可下载分别用时 8.90 秒（参考音色）、8.45 秒（开心）、10.91 秒（低落），这组时间以完整文件就绪为准。通过了 52 项隔离检查、93 项宿主回归、61 项 Flutter 检查和构建打包。实时 PCM 和默认 WAV 接口用确定性音频夹具核对了兼容性。正式 16 GiB Mac mini 的同机占用、真机和签名 APK 留到集中验收。 [隔离验收](../.work/expressive-tts-0.100/evidence.json) · [宿主回归](../.work/expressive-tts-0.100/regression.log) · [Flutter 检查](../.work/expressive-tts-0.100/flutter.log) · [候选包](../dsh-companion-bot-0.100.0.tgz)

[参考音色](../.work/expressive-tts-0.100/audio/reference.wav) · [开心](../.work/expressive-tts-0.100/audio/happy.wav) · [低落](../.work/expressive-tts-0.100/audio/sad.wav)

## 130. Companion 0.101.0 World 接入与状态

- Minecraft、B 站与歌唱沿用原执行适配器，通过同一接入点装配启动、工具、状态与退出。动作按场景 ID 和会话类型限制可见性与执行。新建和换绑时校验保留场景类型。普通聊天与其他游戏继续使用自己的工具策略。各 World 保留已有的主人授权、急停、音频校验和真实回执流程。
- DSH Go 状态页显示 Minecraft、B 站和歌唱工作室。Minecraft 读取现有 Worker 回传并遵循营地暂停，旧观测到期后显示不可用。B 站显示实际读取、近期成功或上游冷却，歌唱区分配置状态和正在合成。清单只携带显示所需字段。旧宿主继续使用原有能力状态。
- 用最终候选包启动隔离 DSH 和 Fabric。B 站工具读取匿名公开视频资料，游戏私聊触发真实 CBI 举盾和释放，手机随后跨会话召回该回执。配对暂停只改变 Minecraft，随后恢复并确认实际下线。歌唱通过确定性回环 Provider 验证忙碌、WAV 归档和逐字节配对下载。模型决策使用确定性回环模型。五个用户场景保持独立，状态清单测得 189 字节。 [34 项隔离验收](../.work/world-connectors-0.101/evidence.json)
- 265 项宿主定向回归、70 项 Flutter 检查、TypeScript 检查、构建与打包通过。验证还覆盖未配置与故障状态、工具声明与实际注册一致、额外测试连接器的接入和释放。隔离服副本已清理，模板区域哈希一致。正式服务、真机和签名 APK 留到集中验收。 [宿主检查](../.work/world-connectors-0.101/regression-final.log) · [Flutter 检查](../.work/world-connectors-0.101/flutter.log) · [宿主候选包](../dsh-companion-bot-0.101.0.tgz)

## 131. Companion 0.102.0 自主行动未确认后的接续

- 主动目标进入授权行动流程后，若结果未取得完成回执，可在原有效期内进入待续列表。已提交目标但未通过执行准入的情况沿用原流程。对已有目标的未确认尝试保留原意图及到期时间，更新上次未确认的世界。新目标首次进入待续后最多保留七天，同日重启继续遵循一次机会限制。
- 下一次授权窗口由大肥鱼读取实时选项，再决定接续、改写、暂存或放下。接续时可以沿用目标原文，只填本轮待续编号、证据和动作。把视频参数传给游戏动作会收到具体的改正提示。宿主继续按现有权限和完成回执核对执行，配对端与共享记忆只读取经核验的实际经历。
- 隔离 DSH 与 Fabric 用推进时钟模拟跨日。首日用确定性工具调用选东路，测试在提交后放置障碍。复查拒绝出发，冷启动后没有同日重跑。次日本机 Qwen3-4B Q4_K_M 自行从新选项选择南路，经参数修正后走了 7 格并返回。手机在原会话召回南路回执。模型最后的私有文字仍误述方向和参数，工作台行动结果及共享记忆取自工具和游戏回执。 [隔离验收](../.work/initiative-recovery-0.102/evidence.json) · [实际模型工具调用](../.work/initiative-recovery-0.102/model-trace.json) · [Qwen GGUF](https://www.modelscope.cn/models/Qwen/Qwen3-4B-GGUF) · [llama.cpp 函数调用](https://github.com/ggml-org/llama.cpp/blob/v0.9.0/docs/function-calling.md)
- 这组本地对照中，修正参数前后模型请求从 8 次降至 4 次，累计输入从 16,409 降至 6,970 token，均含缓存读取。改动前模型在反复拒绝后放下目标，修正后完成了勘察。通过 40 项隔离验收、462 项定向回归、TypeScript 检查、构建和打包。SQLite 保持 v42。正式 Mac mini、Coopcraft、安卓真机和签名 APK 留到集中验收。 [回归](../.work/initiative-recovery-0.102/regression-final.log) · [候选包](../dsh-companion-bot-0.102.0.tgz)

## 132. Companion 0.103.0 主动提案回执

- 私有每日会话提交有效目标、暂存或放下时，工具用 DSH 原生结束标记收束当前轮次。参数错误仍可在轮内修正，模型也可以直接选择休息。宿主将提案绑定到当前会话、轮次、步骤及工具调用，要求该调用的成功回执进入会话记录、轮次正常结束且现行授权仍有效，才接受提案进入执行流程。
- 工作台分别显示原目标、本轮所选动作和实际结果。所选动作来自宿主预检提供的选项说明，选定的路线、完成结果及共享记忆分别有对应记录。成功提案的会话与回执序号留在宿主。SQLite 继续使用 v42，旧提案记录可照常查看。
- 最终候选与 0.102.0 使用真实隔离 DSH、Fabric、Carpet 和 CBI 做同一路线对照。确定性模型在旧版成功提案后再发一条错误方向的文字，新版在工具回执结束，模型请求从 3 次降至 2 次，完整请求正文从 22,299 降至 14,125 字节。两个版本均确认向东走 7 格并回营。新版另通过参数错误后修正、向南实走、暂存、次日放下、主动休息和配对召回。 [对照与落盘回执](../.work/initiative-terminal-0.103/comparison.json) · [隔离验收](../.work/initiative-terminal-0.103/evidence-0.103.0.json)
- 51 项候选隔离验收、19 项旧版对照、479 项定向回归、TypeScript 检查、构建和打包通过。读取实际 DSH 压缩会话日志，核对四次提案均依序保存调用、成功回执和正常轮次结束。正式服务、安卓真机和签名 APK 留到集中验收。 [定向回归](../.work/initiative-terminal-0.103/regression.log) · [候选包](../dsh-companion-bot-0.103.0.tgz)

## 133. Companion 0.104.0 图文动态断线重试

- DSH Go 根据配对健康接口公布的能力选择一次提交入口。草稿打开期间，原样重试使用同一请求编号。宿主按设备区分请求，首次创建返回 201，内容一致的重试返回原回执。正文、图片或评论目标不同则返回冲突，已删除的帖子不会被重试恢复。旧宿主仍可使用原上传、发布和回复接口。
- 图片先写入私有文件，随后与动态及活动记录一起提交到现有 SQLite v42。并发重试会移除多余暂存文件。宿主媒体扫描保留已发布图片，将超过一小时且没有动态引用的中断暂存文件纳入常规缓存清理。
- 最终包安装到隔离 DSH。模拟提交后断线、六个并发重试及宿主冷重启，核对原回执、图片字节、活动和自主回复排程均未重复。另核对上传途中撤销配对、已删除线程、旧版上传和发帖接口，以及孤立图片的预览与清理。52 项隔离验收、160 项宿主回归、34 项 Flutter 检查、Dart 与 TypeScript 分析、构建和打包通过。正式宿主、真机和签名 APK 留到集中验收。 [隔离验收](../.work/feed-publish-0.104/evidence.json) · [宿主检查](../.work/feed-publish-0.104/regression.log) · [Flutter 检查](../.work/feed-publish-0.104/flutter.log) · [宿主候选包](../dsh-companion-bot-0.104.0.tgz)

## 134. Companion 0.105.0 聊天断线重试

- 新版手机和宿主都支持时，文字、转写和附件发送沿用当前草稿的请求编号，并携带开始发送时的会话。宿主从 DSH 的待处理消息和原始会话事件查回执，对文字、语音回复选择、附件顺序、名称及上传内容做指纹核对。重复确认复用原消息编号，冲突或换绑会保留手机草稿并提示。既有配对客户端和宿主继续走各自支持的入口。
- 已接收回执沿用 DSH 队列含义。已进入原始会话日志的消息可在冷重启后确认，压缩模型上下文不影响回执查找。DSH Go 收到旧回执后读取当前运行状态，使已完成的旧回复恢复到可输入状态。
- 在两个版本的真实隔离 DSH 上，用同一条手机消息模拟发出请求后未读取响应。0.104.0 在重试时再次送入模型，0.105.0 只返回原回执。主模型请求由两次降为一次，实际请求正文由 11,653 字节降为 5,759 字节。这是回环模型夹具的 HTTP 正文计量。新版还核对六路并发、附件逐字节下载、撤销、场景换绑、冷重启和 SQLite v42 完整性。 [0.104.0 对照](../.work/chat-retry-0.105/evidence-0.104.0.json) · [0.105.0 隔离验收](../.work/chat-retry-0.105/evidence-0.105.0.json)
- 44 项候选隔离检查、221 项宿主回归、补充的入队与落盘时序检查、52 项 Flutter 检查，以及 Dart、TypeScript、构建与打包通过。正式宿主、真机和签名 APK 留到集中验收。 [宿主回归](../.work/chat-retry-0.105/regression.log) · [时序回归](../.work/chat-retry-0.105/focused.log) · [Flutter 检查](../.work/chat-retry-0.105/flutter.log) · [候选包](../dsh-companion-bot-0.105.0.tgz)

## 135. Companion 0.106.0 自主行动与自我观察依据

- 自主复盘保留原始回执和实际模型原话。给模型的 B 站材料省略视频编号，小屋回执概述核对与放置结果。角色可跳过、写下新观察或在有新依据时修订旧观察。重复原观察的输出结束本次复盘，保留旧笔记。
- 主动计划仍只从观察工具收到有限的行为标签。选用标签时，宿主核对本轮实际提供的笔记及版本，防止归档、重新启用或替换后的同名标签沿用旧提案。验收通过后，任务记录笔记 ID 和版本。管理工作台可打开该历史快照，配对端不接收这一内部关联。SQLite 保持 v42。
- 最终候选在隔离 DSH 推进三个模拟日。真实本地 Qwen3-4B 跳过旧字幕回执，随后从此前真实 Fabric 的小屋验收回执写出一条核对习惯。配对聊天收到标签，笔记正文和私有来源留在宿主。第三日的确定性测试决策引用此标签，原生工具提交并完成 B 站阅读连接器，元数据使用回环夹具，字幕由验收程序提供。归档后仍可打开行动当时的版本。 [30 项隔离验收](../.work/growth-real-0.106/evidence-0.106.0.json) · [实际模型输出](../.work/growth-real-0.106/model-trace-0.106.0.json) · [模型权重说明](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit)
- 311 项定向回归、TypeScript 检查、构建和打包通过。窄屏 Chromium 验证了历史版本请求、笔记来源显示和关闭后的键盘焦点。临时模型和下载缓存已清理。正式宿主、真机和签名 APK 留到集中验收。 [宿主回归](../.work/growth-real-0.106/regression-final.log) · [浏览器检查](../.work/growth-real-0.106/browser/after.log) · [清理记录](../.work/growth-real-0.106/cleanup.json) · [宿主候选包](../dsh-companion-bot-0.106.0.tgz)

## 136. Companion 0.107.0 参考图屋顶轮廓

- 紧凑小屋草案可按宽度或进深指定两档屋顶高度，用同材质檐层承托较高位置。工作台增加西墙左侧图，可与原图一起看，并沿用既有编辑、撤销和版本记录。普通平顶和逐层蓝图兼容原入口。明确建房请求可在房屋名称前带尺寸和 Minecraft 字样。
- 台阶屋顶使用五格高度，门洞保留三格，墙窗留在屋檐以下。当前整份小屋的宽、深、高仍各最多五格，实体方块最多 100 个，开工继续绑定授权区域、草案版本和本次预检。
- 隔离 DSH 用本地 Qwen3-VL-8B 读两张方块参考图并保存草案。居中屋脊读对，左窗偏一格。另一张图的沿进深抬高屋顶被读成居中屋脊。施工前在工作台修正了两份原草案，分别改动 2 和 49 格，保留原图关联与历史版本。窄屏 Chromium 核对了左视图的进深列数、原图对照和编辑撤销。 [模型与草案验收](../.work/roof-profile-0.107/vision-evidence.json) · [工作台检查](../.work/roof-profile-0.107/browser/undone.log)
- 旧 CBI 实放到 72 和 79 块后，因封檐造成剩余位置不可达而停止。新 CBI 优先寻找高处和直接承托的可达位置，之后才封闭剩余檐层。两份草案在隔离 Fabric 分别实放 84 和 94 块，每栋独立回读 125 格及边界，核对实际耗材、返回起点和重试回执。缺料、占用预留空气格和未经预检均未派发建造。 [旧版对照](../.work/roof-profile-0.107/evidence-stepped.json) · [居中屋脊](../.work/roof-profile-0.107/fixed-center-ridge/evidence-roof-fixed.json) · [沿进深抬高](../.work/roof-profile-0.107/fixed-rear-step/evidence-roof-fixed.json)
- 313 项宿主定向回归、218 项 Java 检查、TypeScript 检查、构建和打包通过。SQLite 保持 v42。使用台阶屋顶的施工候选需配套 CBI。临时视觉模型、下载缓存及本轮隔离服副本已清理，隔离世界模板区域哈希一致。正式服务、真机和签名 APK 留到集中验收。 [宿主回归](../.work/roof-profile-0.107/regression-final.log) · [Java 检查](../.work/roof-profile-0.107/cbi-test-summary.json) · [宿主候选包](../dsh-companion-bot-0.107.0.tgz) · [CBI JAR](../.work/roof-profile-0.107/carpetbaritoneintegration-v1.7.1+260820-stepped-roof-0.107.jar) · [配套源码](../.work/roof-profile-0.107/CarpetBaritoneIntegration-stepped-roof-0.107-source.tar.gz) · [清理记录](../.work/roof-profile-0.107/cleanup.json)

## 137. Companion 0.108.0 Minecraft 分区施工

- 本机 Minecraft 工作台可导入包含 2 到 6 个分区、总计超过 100 个实体方块的工程。每个分区沿用小屋布局限制，整份蓝图要覆盖一个连续长方体，留空也写入蓝图，各区互不重叠。宿主从同一有效授权区推导每段施工范围，站位范围也必须包含在原授权区内。
- 主人选择分区并预检、确认开工。缺料按该段背包实际数量返回。开工确认绑定该区和当次预检，重启及开工后要重新预检后续分区。分区蓝图、施工回执和中断原因写入 SQLite v43，既有小屋数据不重写。重复提交同一工程蓝图复用原工程，已验收分区的重试复用原回执。
- 全部分区有施工回执后，可请求整栋复查。成功结果来自游戏服一条命令中的全体方块和留空条件，同时检查维度、加载状态及角色连接。不能复核的分区单独列出。首次整栋确认后写一条可跨场景召回的共享经历，后续复查保留各分区历史回执。
- 可用组合沿用 0.107 的 CBI。双翼样例宽 10、深 5、高 4，实放 156 块。东翼完成后冷重启宿主，缺料补齐并重新确认西翼。西翼放到 76 块时因封顶挡住上台阶净空而中断。测试把角色移到已建成的连廊站位，重新预检后只补了 2 块，复查全 200 格通过。取走西翼一块地板并在东翼留空放置箱子可定位到两个分区，恢复后再次核对通过。 [中断对照](../.work/house-project-0.108/fabric-acceptance.wfUsDNgx/evidence.json) · [真实续建](../.work/house-project-0.108/fabric-acceptance.mLZoRWxY/evidence.json) · [共享记忆核对](../.work/house-project-0.108/fabric-acceptance.mLZoRWxY/receipt-audit.json) · [配套 CBI](../.work/roof-profile-0.107/carpetbaritoneintegration-v1.7.1+260820-stepped-roof-0.107.jar)
- 两次施工顺序实验分别在东翼中央屋顶不可达和最后一块前触发走位保护时中断。最后一次实验只缺连廊入口上方一块圆石。保留实际存档差异和错误回执，后续可据此验证角色自行换站位。 [存档差异](../.work/house-project-0.108/saved-world-placement-diff.json) · [入口净空实验](../.work/house-project-0.108/fabric-acceptance.OyEJdP58/evidence.json)
- 37 项隔离施工验收、4 项落盘核对、12 项真实 Worker 检查、28 项窄屏 Chromium 检查和 416 项定向回归通过。真实 Worker 通过预置 750 格的整体验收检查，包括正常空气、洞穴空气和虚空空气。TypeScript、构建和打包通过。正式服务、安卓真机和签名 APK 留到集中验收。 [宿主候选包](../dsh-companion-bot-0.108.0.tgz) · [Worker 证据](../.work/house-project-worker-0.108/worker-evidence.json) · [浏览器证据](../.work/house-project-ui-0.108/evidence.json) · [回归](../.work/house-project-0.108/regression-final.log)

## 138. Companion 0.109.0 Minecraft 施工决策

- 在已绑定的主人聊天中说「请帮我选 Minecraft 建筑工程的下一段」，或使用工作台生成的指定项目请求。当前轮次才会加载施工规划工具。模型只读取未完工区的预检、实际缺料和上次中断原因，分段蓝图、世界坐标和开工凭据留在宿主。多个未完项目需要主人明确指定。
- 大肥鱼可建议先建已通过预检的分区、为实际缺料的分区备料，或暂缓施工。建议只能引用本轮实际观察过的分区，并核对会话、地块、观察时效和施工状态。最新建议持久保存，开工后清掉旧建议。工作台选中建议分段后，仍由主人重新预检并确认开工。SQLite 保持 v43。
- 初次真实模型试验读对了预检却只在聊天中回答。修改工具说明和观察回执后，同一句请求下模型先提出开建缺料西翼，宿主拒绝。模型改为给西翼备 1 块橡木木板，建议成功落盘。 [初次试验](../.work/house-project-planning-0.109/run-0.109.0-cr1b4lv0/model-trace.json) · [实际备料建议](../.work/house-project-planning-0.109/run-0.109.0-dp3g2fen/evidence.json)
- 最终候选用真实 DSH、配对聊天、Fabric、Carpet 和 Qwen3-4B。在一翼就绪的场景，主人只给出就绪优先，模型选了东翼。两翼都缺料后，模型决定给西翼备 26 块橡木木板。观察和参数拒绝回执都列出可选分段，避免再次读取现场。两轮分别用 3 和 4 次模型请求，累计输入 5,632 和 7,550 token。这是本地模型实测值。 [真实隔离验收](../.work/house-project-planning-0.109/run-0.109.0-497exb1n/evidence.json) · [真实模型工具轨迹](../.work/house-project-planning-0.109/run-0.109.0-497exb1n/model-trace.json)
- 35 项真实隔离验收、30 项窄屏浏览器检查、206 项定向回归及 TypeScript、构建和打包通过。确认 200 个现场位置、角色站位和背包均未被规划工具改动，假开工凭据被拒绝，主人可另行取得预检，建议在真实 DSH 冷重启后仍可读取。正式服务、真机及签名 APK 留到集中验收。 [浏览器验收](../.work/house-project-plan-ui-0.109/evidence.json) · [定向回归](../.work/house-project-planning-0.109/regression-final.log) · [候选包](../dsh-companion-bot-0.109.0.tgz)

## 139. Companion 0.110.0 Minecraft 施工站位恢复

- 分区上次因站位、视线或走位中断时，已声明恢复能力的 CBI 可以预检可施工且可撤回的位置。预检确认至少一处当前可达的放置位置，执行过程中再逐步核对后续站位。规划工具能据此建议换站位续建。主人在工作台拿到新预检后确认，开工凭据绑定分区和恢复模式，失效后重新预检。普通施工与旧 CBI 路径保留。
- 恢复先用普通路线，再尝试有支撑且可往返的一格台阶。低门洞采用生存模式下的蹲跳，下降时降低向前速度。游戏服逐步检查净空、实体、位置和退路，Worker 独立核对分区、扣料和角色返回原站位。施工回执标记恢复模式，SQLite 保持 v43。
- 隔离服用上次中断的数据库和存档差异重建 154 块现场。旧 CBI 从原起点返回不可达，实放 0 块。第一次恢复试验放了两块后在下台阶时偏离走位范围，未记完工。减速版从同一起点自行跨上 y81，补两块云杉木板并返回距起点 0.086 格处。86 组独立位置采样均在授权内，施工开始后没有传送、现场修改或补料。整栋复核 156 个实体方块及 44 个留空，冷重启保留原失败任务和唯一共享经历。 [旧版对照](../.work/house-project-recovery-0.110/baseline.aGHS0oN4/evidence.json) · [走位保护对照](../.work/house-project-recovery-0.110/java.z2Hgmf04/evidence.json) · [新版实地验收](../.work/house-project-recovery-0.110/candidate.0m02ZsnL/evidence.json)
- 25 项新版真实隔离验收、7 项旧版对照、37 项窄屏浏览器检查、219 项宿主及 Worker 定向回归和 219 项 Java 检查通过。宿主通过 TypeScript、构建和打包。最终 Worker 收紧了位置和库存的日志识别，并用隔离服真实记录交错回放通过。正式服、真机和签名 APK 留到集中验收。 [候选包](../dsh-companion-bot-0.110.0.tgz) · [配套 CBI](../.work/house-project-recovery-0.110/carpetbaritoneintegration-v1.7.1+260820-stance-recovery-0.110.jar) · [对应源码与许可](../.work/house-project-recovery-0.110/CarpetBaritoneIntegration-stance-recovery-0.110-source.tar.gz) · [浏览器验收](../.work/house-project-recovery-0.110/browser/evidence.json) · [宿主与 Worker 回归](../.work/house-project-recovery-0.110/regression-final.log) · [实际日志回放](../.work/house-project-recovery-0.110/live-nbt-replay.log) · [Java 检查](../.work/house-project-recovery-0.110/cbi-test-summary.json) · [隔离副本清理](../.work/house-project-recovery-0.110/fixture-cleanup.json)

## 140. Companion 0.111.0 Minecraft 授权自主施工

- 主人在每日时段内额外授权一个同地块、未完工的已保存建筑工程，并开启主动目标。角色已在线且空闲时，大肥鱼可用原生提案从实际可施工的分区中选择一段，也可休息。建筑授权独立于登录、补给和营地权限。建筑选项只携带分区名称、编号和是否需要站位恢复。
- 每日最多消耗一次主动机会。执行前对相同分区和模式重新预检。施工任务在任何游戏派发前就与每日提案绑定，任务结束前持续检查前台、免打扰、撤权、暂停和到期。确认分区后可写入实际施工经历。整栋完成继续由原有整体验收确认。SQLite 保持 v43。
- 隔离 DSH、Fabric、Carpet 和 CBI 使用确定性的原生模型协议夹具推进三个测试日。首日选择休息。第二日观察后加箱子，执行前复查拒绝派发，恢复现场后同日机会也不重开。第三日选择西翼，实际补两块云杉木板，核对分区 100 格、扣料及返回起点，偏差 0.086 格。主人另行确认整栋 200 格。冷重启保留分区和整栋回执，同日没有重跑。施工选择用了两次模型请求，HTTP 正文累计 13,027 字节。 [隔离验收](../.work/daily-house-project-0.111/run-_plvpptj/evidence.json) · [提案轨迹](../.work/daily-house-project-0.111/run-_plvpptj/model-trace.json)
- 验收发现手机状态可见后台父任务关联。最终包在同一保存世界与数据库上冷升级，配对状态及实时活动仅保留已核验分区结果和扣料，私有任务关联留在宿主。包内 Worker、施工与调度逻辑与实地施工版本相同。46 项隔离验收、29 项浏览器检查、499 项定向回归、8 项配对投影检查及 TypeScript、构建和打包通过。正式服、真机和签名 APK 留到集中验收。 [包内差异](../.work/daily-house-project-0.111/run-_plvpptj/candidate-host.diff) · [浏览器验收](../.work/daily-house-project-0.111/browser/evidence.json) · [定向回归](../.work/daily-house-project-0.111/regression-final.log) · [配对检查](../.work/daily-house-project-0.111/paired-projection.log) · [候选包](../dsh-companion-bot-0.111.0.tgz) · [清理记录](../.work/daily-house-project-0.111/final-cleanup.json)

## 141. Companion 0.112.0 自主施工复盘

- 自主分区施工和复盘共用一套来源核对。每日提案、施工子任务、分区回执和游戏活动必须相符。回执概述仅写分区、站位恢复、核对格数和实际放置数。整栋验收仍是独立事实，项目名称、内部编号和蓝图留在宿主。
- 开启后台任务、记忆整理和自主经历复盘后，完成的实际放置在空闲 30 分钟后可复盘。启动或开启时会补查近期已经完成的分区施工，仍受 48 小时有效期和原有去重约束。仅核对现状、零放置的施工不会启动新复盘。自我观察由大肥鱼选择写下或跳过，宿主写入前再次核对回执与作者会话。SQLite 保持 v43。
- 工作台的自我观察可打开对应分区回执。跨场景共享的施工经历与私有笔记分别保留，归档自我观察也保留已经确认的实际施工事实。后续主动提案可引用分区事实及有来源的行为标签。
- 隔离 DSH 与真实 Qwen 验证了已核验分区触发复盘。两次推理均选择略过，重启未重复推理。配对聊天可回忆核对 100 处、实放 2 块，私有复盘访问返回 403。模型答复还生成了无来源的图片与日志链接，验收覆盖数字回忆和场景隔离。旧版、篡改和过期对照各通过 9 项，宿主定向回归 459 项通过。测试下载的 Qwen 模型及其元数据已清理，释放约 2.28 GB。 [隔离验收](../.work/construction-reflection-0.112/acceptance.json) · [定向回归](../.work/construction-reflection-0.112/regression-final.log)

## 142. Companion 0.113.0 Minecraft 整栋蓝图导入

- Minecraft 工作台的「分段建筑」可以粘贴整栋 JSON，含 `width`、`depth`、`height` 和 `blocks`。整栋以授权区中心为水平参考，底层与授权区中心同高。方块从底层开始，每层从北到南、每行从西到东。留空用 `.`，橡木木板、云杉木板、圆石、玻璃分别用 `o`、`s`、`c`、`g`。工作台附四合院示例并保留手动分段入口。
- 蓝图输入上限为 750 格，其中 101～600 个实体方块。宿主搜索最少的有效轴向分段，保留所有方块与留空，最多 6 段，每段最多 5×5×5 格、100 个实体方块。分段放置和走位区域都必须处于同一授权区内。无法满足这些条件的蓝图会返回原因。分段与用料统计在宿主本地完成，无模型调用。
- 「预览自动分段」只检查蓝图和当前授权，可离线使用。预览后保存精确的分段结果，保存时重新检查授权。开工继续走各段的现场预检及确认，最后独立验收整栋。SQLite 保持 v43，Worker、CBI、安卓及配对协议沿用现有版本。
- 48 项导入检查和 251 项相关回归通过。15×10×4 混合材料蓝图拆为六段，重组后保留 600 个实体方块。对 1,250 个有效随机输入进行压力检查，357 份有效分段逐格重组一致。390px 和 320px Chromium 通过 57 项检查，包括四合院四段预览、精确保存和撤权处理。最终候选通过 TypeScript、构建、打包及 11 项真实 DSH 安装检查。 [导入检查](../.work/house-import-checks-0.113/regression.log) · [相关回归](../.work/house-import-0.113/regression.log) · [压力检查](../.work/house-import-checks-0.113/stress.json) · [浏览器验收](../.work/house-import-ui-0.113/evidence.json) · [候选包验收](../.work/house-import-0.113/package-smoke.json) · [宿主候选包](../dsh-companion-bot-0.113.0.tgz)
- 隔离 Fabric、Carpet 和 CBI 将 15×5×4 的整栋院落导入成三段。在生存模式每段实放 54 块，三段均在返程触发 `homebuild-off-course`。测试在预检前为角色定位，按中断恢复流程复查原有方块，每段以 100 格、零新增和零耗材确认。整栋独立回读与宿主验收均核对 300 格，包括 162 个实体方块和 138 处留空。向留空放入箱子可定位到对应分区，移除后再次通过。初次与接续分别通过 18 项和 14 项现场检查，重启后旧开工凭据失效。持续自行返程及跨区就位仍待验收。隔离副本已清理约 252 MB，原始输入哈希一致。 [初次实放](../.work/house-import-fabric-0.113/run.n5vUdojp/acceptance.log) · [接续与整体验收](../.work/house-import-fabric-0.113/run.n5vUdojp/resume-evidence.json) · [清理记录](../.work/house-import-fabric-0.113/run.n5vUdojp/cleanup.json)

## 143. Companion 0.114.0 Minecraft 施工返程

- CBI 将低门洞下降的减速沿用到普通一格下降。落脚区、空间净空、走位边界和授权范围继续逐步检查。诊断日志默认关闭，隔离验收可临时记录步长、地面高度和横向偏差。
- Worker 为普通施工增加与续建相同的独立起点和返程读取。无法确认位置时不记完工，分区仍可经重新预检恢复。方块、留空和材料继续独立核对，SQLite 保持 v43。
- 旧逻辑在同一隔离院落的中段实放 54 块后，从 y=81 跨到 y=80 的普通台阶时走到 1.256 格，超过该步 1.22 格的前向边界。独立回读确认 100 格和扣料，宿主没有记录完工。 [旧版诊断](../.work/house-retreat-live-0.114/run.baseline.ugOwisy2/fabric.log)
- 新版在隔离 Fabric 完成同一座三段院落。三次普通施工各实放 54 块并返程，终点距各自起点 0.085、0.095 和 0.057 格。测试提供材料、选择并确认工段，通过原有 CBI 导航指令完成两次跨段走位，初始定位后无传送。整栋独立回读和宿主验收核对 300 格，现场改动能定位到对应分区。宿主冷重启保留回执，旧开工凭据被拒绝。 [完整隔离验收](../.work/house-retreat-live-0.114/run.candidate.3Txjjk7b/evidence.json)
- 43 项整栋现场验收、21 项旧版对照、19 项独立导航检查、191 项宿主和 Worker 回归及 220 项 Java 检查通过。通过 TypeScript、构建和打包。清理约 1.12 GB 的测试副本及构建缓存，原始世界和种子库哈希一致。正式服、真机和签名 APK 留到集中验收。 [验收与清理汇总](../.work/house-retreat-live-0.114/summary.json) · [宿主候选包](../dsh-companion-bot-0.114.0.tgz) · [配套 CBI](../.work/house-retreat-0.114/carpetbaritoneintegration-v1.7.1+260820-retreat-0.114.jar) · [CBI 源码与许可](../.work/house-retreat-0.114/CarpetBaritoneIntegration-retreat-0.114-source.tar.gz) · [定向回归](../.work/house-retreat-0.114/host-regression.log) · [Java 检查](../.work/house-retreat-0.114/java-tests.json)

## 144. Companion 0.115.0 Minecraft 建筑备料

- 主人在每日建筑授权中选择具体项目后，还需另行勾选备料许可，默认不授予。换项目、改时间、撤权或状态重新读取失败时，旧勾选不沿用。大肥鱼在有效窗口内从实际选项中选择为缺料分段备料、施工一个分段或休息；每日主动机会仍只消耗一次。SQLite 保持 v43，沿用 `0.114.0` 的 CBI。
- 只读预检绑定项目、地块、分区、橡木或云杉木板及精确缺口，不消耗材料，也不占用动作。Worker 要求生存状态安全、角色在分区内静止站稳、库存与缺料一致，并排除树皮、去皮原木等共用配方的竞争材料。每次只消耗一根同种自然原木，合成四块同种木板，至少保留两根同种原木；不会自动采集，也不会批量清空木材。
- 备料使用独立 `minecraft.house-project.supply` 子任务，在派发前绑定每日父任务并持续核对授权、前台状态、暂停和截止时间。合成回执必须属于当前角色及配方，前后库存差须精确为一根原木和四块木板，同时复核地块、站位与角色会话。归属无法确认时返回 `house-ownership-unconfirmed`。确认后写共享备料事实，分区完工由施工回执确认。取消、失败和冷重启沿用每日去重。配对活动公开分区序号、材料、产量与一根原木消耗。
- 54 项新增备料测试、544 项相关宿主与 Worker 回归通过，覆盖独立同意、精确缺料、失效提案、同树种合成、站位、库存、取消、回执归属和冷重启。`pnpm check` 与文档检查通过。此前 Codex 的 Chromium 流程已通过 49 项检查，含 390/320px 布局、撤权和私有字段隐藏；本轮另用内置 Chromium 复核旧版兼容、独立勾选、换项目清除、精确提交、完成回执与重新授权。设备尺寸接口本轮未能执行，未重新声明窄屏测量。 [回归记录](../.work/house-supply-0.115/regression.log) · [此前浏览器流程](../.work/house-supply-ui-0.115/flow.log) · [本轮浏览器复核](../.work/house-supply-0.115/browser.json)
- 本候选未在真实 Fabric／Coopcraft 执行建筑备料，也未部署或替换正式宿主、CBI、手机应用；真机与正式服验收仍需另行进行。补充回归发现 `scripts/minecraft-milestones.test.mjs:97` 仍以旧数组方式读取 `recentDailyInitiativeEvidence()`，而 `0.114.0` 包内实现已返回 `{ evidence, selfNote }`。这是既有的测试与接口不一致，未借本版本改写旧测试或公共接口。
- 最终候选包为 `dsh-companion-bot-0.115.0.tgz`，SHA-256：`706ee06b6d74e7ef0ec87d917c96ac937b1b911937992a69c7f37cc3de388035`。已核对包内版本、备料 Worker 路由、归属错误、宿主能力声明与安装说明。 [候选包](../dsh-companion-bot-0.115.0.tgz) · [打包记录](../.work/house-supply-0.115/pack.log)

## 145. Companion 0.116.0 Minecraft 建筑地点簿

- 参考用户提供的 DeepseekOVO 公开版 `memory_bank.js` 与建筑锚点思路，为已整栋验收的工程增加长期地点记忆。没有复制其实现代码或引入 Mindcraft 运行时；现有 Carpet＋CBI、单角色核心、SQLite 和中央记忆保持不变。参考项目的通用采集、无限续跑和语音命令拼接不属于本次交付。
- 工作台在整栋验收通过且授权有效时开放命名与改名。大肥鱼在当前 Minecraft 根会话可用 `mc_status(section=places)` 查看已验收工程和有效地点，以 `mc_name_place` 保存名称。聊天、子代理和其他场景不能冒用此工具。名称限 1～40 个字符并规范化，重名拒绝，未验收、验收差异和撤权项目不能命名。命名使用原授权区中心，不声称入口、当前站位或实时世界核验。
- SQLite 升级至 v44，新增 `minecraft_place`，原工程、授权和中央记忆保留。命名与改名在同一事务写入任务、地点、活动和共享事实，保留地点 ID、记忆 ID、来源及修订；同名重试不重复创建任务。已归档记忆和撤权退出可用清单，历史仍可追溯。配对活动只提供维度、坐标、验收时间与动作来源，过滤项目内部 ID、游戏 Session 和记忆关联。
- 4 组端到端测试通过，覆盖 v43 升级、验收前拒绝、命名冲突、同名去重、改名修订、冷重启、归档、撤权、游戏根会话、真实 HTTP 管理鉴权和另一聊天场景的中央记忆注入。145 项相关宿主、Worker、建筑、World、记忆与配对回归通过。 [测试](../scripts/minecraft-places.test.mjs) · [回归记录](../.work/minecraft-place-ui-0.116/regression.log)
- 内置 Chromium 实际操作了命名、改名和重名提示，并检查未完工项目无表单、撤权项目只读，以及 Worker 离线时仍可保存已验收工程的元数据。未重新测量窄屏布局。 [浏览器记录](../.work/minecraft-place-ui-0.116/browser.json)
- 本轮未在真实 Fabric／Coopcraft 执行命名，未部署正式宿主、替换 CBI 或验收手机应用。`scripts/minecraft-milestones.test.mjs:97` 的旧数组断言与现有对象返回接口不一致，沿用上版记录，未纳入本功能改动。
- 最终候选包为 `dsh-companion-bot-0.116.0.tgz`，SHA-256：`f9ed18c2e5b888e2bc09020cc79dec6154553980c6486bdb020dd6a8ac959faf`。`pnpm pack` 的宿主类型检查、构建、移动端类型检查及包内版本、地点迁移、工具与说明核对通过。 [候选包](../dsh-companion-bot-0.116.0.tgz) · [打包记录](../.work/minecraft-place-ui-0.116/pack.log)

## 146. Companion 0.117.0 OVO 生存技能

- 直接加载用户本地 DeepseekOVO 的 `putInChest / takeFromChest / startSmelt / collectSmelted`，不启动其 Agent 或第二套模型运行时。`minecraftOvoRoot` 默认为空；只有显式设置绝对路径时才启用账号型 Mineflayer Worker，默认 CBI 不变。账号、会话与模型仍由 Companion 现有体系管理。
- `mc_storage` 限一次存取 1～16 个白名单物品，`mc_smelt` 限一次 1～4 个沙子、生铁、牛肉或圆石，使用已有箱子和熔炉及煤／木炭。技能查询限定在授权区，拦截破坏、放置和 `/give`、`/tp` 等命令回退。背包与箱内数量分别核对；熔炉记录准确目标，取成品前检查输出物及背包增量，不能用“开始投料”冒充已烧好。
- 固定上游 [Mineflayer v4.39.0-allprs.3](https://github.com/u9g/mineflayer/releases/tag/v4.39.0-allprs.3) 及 `minecraft-data` v3.116.0-allprs.2，发布包 SHA-256 为 `0d914789eb8849edba26f2946c202457e41d0e652d37e6db334840617aae1753`。这组依赖消除了实测中的配方协议 `PartialReadError`。上层仓库保持锁文件与 `minecraft-data` override，不能只替换 `mineflayer` 而混用不匹配的数据版本。
- 宿主独立校验物品、数量、授权坐标和回执差值，统一 `overworld` 与 `minecraft:overworld` 命名。仅当前 Minecraft 根会话可调用；子代理、普通聊天和撤权区域不能使用。实际成功动作写入共享记忆，投料与取出分别记录，配对端不接触 Worker 令牌、微软会话或原始凭据。SQLite 保持 v44。
- 隔离原版 1.21.1 平坦生存服完成存 4 取 2 木板、投入 1 份沙子并取出 1 块玻璃，覆盖背包和箱子双向差值、未投料不能取成品、区外容器与命令拦截，协议错误数组为空。636 项相关回归通过，包含宿主、Worker、World、记忆、建筑、迁移与配对检查。 [实测证据](../.work/ovo-live-0.117/evidence.json) · [回归记录](../.work/ovo-live-0.117/regression.log) · [定向测试](../scripts/minecraft-ovo.test.mjs)
- 本候选未在正式 Coopcraft 验收，未替换正式宿主或手机应用，未启用自动采集、无限续跑或完整生存模式。启用时需要独立正版账号及白名单，不将 `online-mode` 改为 false，不绕过正版验证。Worker 与生产依赖需一起更新，可在隔离目标目录运行 `pnpm --filter @companion/minecraft-worker deploy --legacy --prod <private-worker-dir>`，不要只替换旧 JS。实际账号与正式服联调仍未进行。
- 最终候选包为 `dsh-companion-bot-0.117.0.tgz`，SHA-256：`0f869c05823a712445c6aa85f7c56a97dbbc5bf72b0ef874f6bc4a61d25db7de`。`pnpm pack` 的类型检查、构建、移动端检查及包内工具、Worker 路由、版本核对通过。隔离 Worker 部署目录使用 `mineflayer 4.39.0` 与 `minecraft-data 3.116.0`，编译后 Worker 语法检查通过。 [候选包](../dsh-companion-bot-0.117.0.tgz) · [打包记录](../.work/ovo-live-0.117/pack.log)

## 147. Companion 0.118.0 正式联调与回环测试支持

- `minecraftOffline` 默认关闭，供启用 OVO 的回环隔离服使用。正式 Coopcraft 的 0.118.0 状态快照记录了 Carpet＋CBI 上线、受控移动和实际回复生成的语音。正式状态以集中联调期间的留存结果为准。 [候选包](../dsh-companion-bot-0.118.0.tgz)
- 使用同一份 0.118.0 安装包和 0.114 配套 CBI，在独立 DSH、Fabric 和 Carpet 上验收三个模拟日。首日观察后少一根原木，重新预检取消行动。次日消耗 1 根云杉原木，产出 4 块云杉木板，保留 2 根原木，工程回执仍为待续建。第三日从已核验的备料事实继续原目标，实际消耗其中 2 块木板，恢复西翼并回到距起点 0.086 格的位置。整栋独立核对 200 格，另由主人确认验收。决策采用确定性回环夹具，游戏动作和库存为实测。 [35 项隔离验收](../.work/house-supply-live-0.118/run-ea1b0lc9/evidence.json)
- 配对状态核对了简短的备料回执，私有日常会话请求返回 403。冷重启后备料和续建回执保留，SQLite v44 完整性检查通过。365 项定向回归通过，包括按当前返回结构核对自主证据列表。隔离副本和临时配置清理约 247 MB。 [定向回归](../.work/house-supply-live-0.118/regression.log) · [清理记录](../.work/house-supply-live-0.118/run-ea1b0lc9/cleanup.json)

## 148. Companion 0.119.0 Coopcraft 联机语音

- Coopcraft 继续使用 Minecraft 1.21.1 Fabric、Carpet 假人和现有 CBI。测试用方块皮肤来自本地 DeepseekOVO 公开版。Windows 实例使用 CustomSkinLoader，从 `CustomSkinLoader/LocalSkin/skins/dafeiyu.png` 加载。3D YSM 模型仍需兼容环境。 [CustomSkinLoader](https://modrinth.com/mod/customskinloader)
- 服务端安装 Simple Voice Chat 2.6.22 和 `apps/minecraft-voice` 的 Companion 转发模组。语音仅绑定 Mac mini 的 Tailscale 地址和 UDP 24454，游戏仍走 TCP 25565。模组使用私有 `~/.local/share/companion/minecraft/voice/owner` 内的白名单主人 UUID，检测主人进服后请求现有本地 Companion 接口，由 CBI 在主人附近进服。主人退出时，模组请求让它启动的会话离服。 [Simple Voice Chat 服务端设置](https://modrepo.de/minecraft/voicechat/wiki/server_setup)
- 游戏私聊确认送达、且主人客户端连接了语音时，复用现有 GPT-SoVITS 和归档。服务端以当前连接的短时租约匹配语音片段，只向主人发送，片段在读取后清除。未启用转发时，仍可使用游戏私聊文字。短时间内有多条回复时，正在合成的语音与文字回复独立。
- Mac mini 装入 0.119.0 后验证了真实生存模式进出服、无在线主人时拒绝在其身边生成、语音模组加载和跨 Tailscale 的 Simple Voice Chat UDP 应答。Windows 客户端当时离线，皮肤渲染、随主人进服和实际听音仍待该客户端确认。客户端安装包包含 1.21.1 Fabric 兼容模组、方块皮肤与操作说明。

## 149. Companion 0.121.0 生存反馈与平原小屋

- 移动遇到快速掉气或明显偏离时结束当前工具，回传实际状态。采集遇到低血量、持续受伤或缺氧时同样交还控制。游戏场景可以自己查询附近地形和原木、上浮，或依据一次新死亡回执复活。主人可以把一份现有草案绑定到具体施工区，角色随后可清理占地内的短草，并按真实预检和背包材料执行该草案。
- 死亡回执从真实的服务端断线原因和死亡提示采集。游戏轮次会带上近期失败、死亡和角色自己保存的少量观察。正常记忆整理可保留她自己形成的做事习惯，证据仍来自真实交互。实服观察到她在寻路失败后改查原木和地形，自己调用上浮与复活。之前由主人明确要求复盘后产生的笔记单独看待。
- 参考 DeepseekOVO 公开版的缺氧保护和撤退落脚检查，在既有 CBI 反射层加入换气、短距离寻找岸边和避开水面及陡落差的检查。低血量时允许撤退反射接手短时输入。建造、资源和走法继续由游戏会话选择。 [CBI 源码补丁](../patches/carpetbaritone-survival-reflex.patch)
- CBI 187 项 Java 检查通过。隔离 Fabric 用实际生存假人在水下复现缺氧，空气量从 149 恢复至 296，Y 从 62.0 上升到 64.95。补丁 JAR `2d683e447d3f83c04a6a2a2252687ddeb33089df98c17c7ab6332897f4c9e856` 已装入 Coopcraft 测试服。宿主 74 项定向检查通过。 [水下实测回执](../.work/coopcraft-plains-house/native-water-evidence.json)

## 150. Companion 0.124.0 Minecraft 过夜

- 主人要求缺乏战斗能力时入夜停止露天活动。有可用房屋时进入避险，有可用床时可以睡觉，条件允许也可以在工作台用 3 个白色羊毛和 3 块木板合成白床。模型根据现场选择地点和动作。找床按已加载区块和实际床头回读，放置需消耗背包中的床，入睡由原版规则判定。
- `mc_night_cover` 可以查找附近干燥土层，验证三层泥土、周围支撑和白天出口。进入时正常破坏脚下方块、回收掉落物并消耗一块泥土封顶。天亮后打开封顶，复用已验证的垫脚回程。工具回执写入 Minecraft 活动和共享经历。
- 隔离 Fabric 从非正中心位置落到三格深，封顶后氧气 300、生命值 20。夜间出洞请求被拒绝，天亮后回收封顶泥土，垫三块回到地面，原木库存保留。白床合成、放置、检索、白天拒睡、夜间实际入睡均通过。187 项 Java、67 项宿主与 Worker 定向检查通过。 [隔离回执](../.work/coopcraft-plains-house/night-shelter-evidence.json) · [CBI 补丁](../patches/carpetbaritone-night-shelter.patch)
- Coopcraft 测试服已装入 CBI 候选 `02b89de539647d114fea883460bb7b657abef3d47e92f82078458cf2f3c2e7f4`。原世界正常启动，语音端口恢复，Mac mini 健康接口报告 Companion 0.124.0。两份隔离服副本已清理，保留验收回执。
- 大肥鱼在 Coopcraft 的白天生存回合中自行查找床和掩体。出生点附近没有通过地形预检的位置，稍后她在西北侧找到了六处符合条件的土层。该回合的寻路失败由采集工具即时交回明确的目标不可达回执。

## 151. Companion 0.126.0 手机建筑审批与一起看 B 站

Android 的「活动 → 建筑审批」从已配对宿主读待审小屋及最近施工状态。旧草案也会进入列表。展开同一张卡可看分层方块、用料和授权地块，预检通过后原按钮变为「确认开工」。预检绑定草案版本和地块，旧版预检失效时须重新核对。没有待审草案时，设备状态不返回授权地块坐标。确认仍调用现有 worker 施工并核验回执。

「保存 Litematica 投影」下载所看版本的 `.litematic`。Coopcraft 使用 Fabric 1.21.1，Windows 客户端可装 [Litematica 0.19.51](https://modrinth.com/mod/litematica/version/0.19.51) 和 MaLiLib 0.21.1，把文件放入对应实例的 `.minecraft/schematics`。命令行从已构建的 npm 包提供同一编码器。离线操作，无需凭据，`--json` 成功返回 `ok: true` 和用料信息，失败返回 `ok: false` 与错误码，退出码 1。导出要求新文件名。

```sh
dsh-litematica --json doctor
dsh-litematica --json inspect blueprint.json
dsh-litematica --json export blueprint.json --out house.litematic
```

`blueprint.json` 可是小屋草案，也可是含 `width`、`height`、`depth` 和 `blocks` 的布局。配对 App 直接从宿主读取已保存草案，同一编码器生成投影。

「一起看 B 站」按所选画面、声音或两者采集短片段，千问 AI 平台的 `qwen3.8-omni-flash` 用一条请求完成理解和角色回复。宿主进程从环境读取 `QWENCLOUD_API_KEY`，默认使用 `https://maas.qianwenaiapi.com/compatible-mode/v1`。片段留在有限的进程内存缓存，供追问复用，每个会话携带最近两轮文本。首轮完成后活动页显示观看回执。

手机聊天的 DeepSeek 模型若支持 `low`，该场景默认使用 `low`。通知收件箱在五分钟内合并同一手机会话或动态帖的提醒，打开通知时只确认已显示的通知 ID。头像与音乐各保留一个主入口。按需朗读在聊天气泡下显示圆角播放控件。

## 152. Companion 0.127.0 DeepSeek 云端 TTS 默认化

- 默认 `ttsProvider=deepseek`：整段 `POST https://api.deepseek.com/v1/tools/tts`（stella 官方音色，与鲸鱼娘形象同源），密钥从宿主环境 `DEEPSEEK_API_KEY` 读取；Companion 继续负责队列、真实任务状态、超时、WAV 校验与缓存。官方工具 API 含 Search/Fetch/OCR/ASR/TTS，但**没有歌唱能力**，歌唱管线（Seed-VC/RVC/SoulX）保持本地不变。
- 云端流式 WAV 的 RIFF 与 data 长度为 `0xFFFFFFFF` 占位；provider 在校验前回填真实长度（首轮部署曾因此合成失败，已加回归）。表情风格（happy/sad）仅本地 Provider 声明，云端默认不 advertise；`ttsProvider=gpt-sovits` 可完整回退本地声线与表情。
- 7 项 provider/service 新测试、48 项语音与歌唱回归、`pnpm typecheck` 通过。正式 Mac mini 已替换 bundle（旧包备份于 `backups/bundle-0.126.0-*`），plist 环境注入密钥（launchd 需 bootout+bootstrap 才加载新环境）；能力视图报告 `DeepSeek 云端 TTS · stella 官方音色`。模拟器端到端：聊天页 Listen → 云端合成 → Pause audio 播放态，宿主 `media/voice` 新增真实 WAV。
- 资源清理：`ai.companion.bot.gsv` 服务 bootout、plist 移入 backups 禁用备份；删除 `gsv/GPT-SoVITS`、`.venv`、`nltk_data`、日志与测试音频（4.3G→324K），保留 `gsv/voice/` 参考音频供歌唱与回退；成功语音缓存（8.6MB）保留可重播，无孤儿临时文件。mini 未配置 ASR，无本地识别模型可删。
- 未验：真机听感；WebSocket 实时流式接入（当前为整段流式收集）；云端下表情风格不可用属预期。

## 153. Companion 0.128.0 云端 ASR 与 WebSocket 实时语音

- 默认 `asrProvider=deepseek`：`POST https://api.deepseek.com/v1/tools/asr` multipart `file`（16 位 PCM WAV/Ogg Opus、≤8MiB、≤120s），密钥同 `DEEPSEEK_API_KEY`；错误映射为稳定设备码（413/429/503/422 等）。WAV 校验采样率白名单扩到官方七档（8000/16000/22050/24000/32000/44100/48000）——修复云端 TTS 的 24k WAV 被旧白名单拒收的往返断点。`asrProvider=local` + `asrEndpoint` 回退本地 loopback 转写。
- 默认 `ttsStreamProtocol=deepseek`：`wss://api.deepseek.com/v1/tools/tts?voice_id=stella&format=pcm`，文本事件 + `finish_text`、二进制 24k PCM 帧、`finish` 错误码 surfaced；首句预warm与前缀接管复用现有管线；无密钥时实时语音优雅降级为整段 WAV。
- 5 项 ASR、2 项实时协议新测试，合计 16 项定向 + 45 项语音/歌唱回归 + `pnpm typecheck` 通过。正式 Mac mini 部署 0.128.0 后验收：`transcribe` 能力 available；云端 TTS 音频→云端 ASR 往返，中文句子逐字正确（代码式 token `WHALE_UPGRADE_OK` 被误听，属识别质量而非管线缺陷）；`voice-stream` 200、318720 字节 = 6.64 秒 24k PCM；验收临时设备已撤销。模拟器聊天页“Transcription unavailable”横幅消失、麦克风与「Start voice conversation」入口可用。
- 未验：真机真实录音输入（模拟器麦克风未接真实声源）；实时首句起播延迟未量化。

## 154. Companion 0.128.0 App 侧：音乐页 MyGo 舞台化（仅 App，无需宿主 redeploy）

- 音乐页改为 MyGo 设计语言的暗色曲库（#141416 / 胶囊搜索 / 封面行），Now Playing 从底部弹层改为全屏舞台（`music_stage.dart`）：封面色晕染背景（专辑图平均色 → accent 混白 45%）、胶囊页签「歌词 / 封面 / 播放队列」、整屏歌词面板（LRC 解析 + 位置驱动高亮与滚动）、队列点播、毫秒刻度进度滑条（沿用旧 NP 的 onChangeEnd 毫秒契约）、shuffle/prev/白色圆形播放/next/repeat。
- 归档曲目暂不含歌词文本（宿主歌唱任务不存 lyrics），歌词面板保留 MyGo 空态；解析与高亮机制已就绪，歌词下发随源插件片（任务 #7）接入。
- 测试：新增 `music_stage_test.dart` 3 项（队列点播/面板切换、shuffle 保持当前首置 + repeat 三态、LRC 解析与活跃行），`songs_test.dart` 改指新舞台并保持原行为断言；whale 全套 143 过 + 1 跳过。`WHALE_MUSIC_PREVIEW_DIR` 渲染捕获见 `.work/music-preview/`。
- 模拟器实测：暗色曲库与空态正确（正式 mini 歌唱归档当前为空，她唱完归档后才会列歌）；带数据舞台见渲染捕获。未验：真机听感与触控手感。
- App 改动位于 `apps/dsh-go` 子仓库，按该仓库协作规则未提交；宿主 bundle 无变更，不需要 redeploy。

## 155. Companion 0.128.0 正式机歌唱链路跑通与音乐页真实歌单

- 正式 Mac mini 首次跑通源翻唱：`POST /companion/api/singing/source-covers` 上传授权音源（JaCRC 田昊《空城计》16.8s）→ MLX Demucs 分离 → Applio RVC（肥鱼 v1 权重，RVC v2/40kHz/F0）换声 → 混音 → 归档。任务 `019213fb` succeeded，归档 18.04 秒；音乐页出现第一首真实歌「空城计（大肥鱼翻唱）」并可播放（模拟器截图 `.work/app-preview/music-library-real.png`）。
- 配置：`singingCoverEngine=applio-rvc` + `rvcPythonPath/rvcApplioDir/rvcModelPath/rvcIndexPath` + `coverSeparatorPythonPath/coverSeparatorCacheDir`，资产位于 `~/.local/share/companion/singing/`（Applio 固定版 `6d5d9511`、肥鱼权重/index、htdemucs 缓存、授权音源），自本机 `.work/feiyu-rvc-0.49.*` 与 `.work/song-cover-0.43` 迁移。
- 环境偏差（如实记录）：mini 无 brew/Python 3.12，改用 npmmirror 的 python-build-standalone 3.12.16（与测试同大版本），依赖 pins 保持 Applio 原样；mini 外网带宽慢导致在线 pip 卡死/极慢，改为本机清华源下载 115 个 wheel（449MB）经 Tailscale 传输后 `--no-index` 离线安装；openrsync 目录语义造成 demucs 缓存嵌套一层，已修正并校验关键文件路径。torch 2.11.0 MPS 可用、demucs-mlx 1.6.1 自检通过。
- 音乐页主题修复：曲库整页改用统一暗色 theme 对象（此前搜索框/专辑标题误用外层浅色 theme，暗底上出现白底搜索框与深色标题）。
- 未验：真机听感（翻唱音色主观验收）；长按/队列等触控手感；SoulX 按谱合成仍未在正式机配置（独立推进）。
