# 参考资料

## 源码基线

本次 dsh 调研基于官方仓库 `master` 分支头：

```text
deepseek-ai/deepseek-harness
fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
2026-11-06
```

以下 dsh 链接尽量固定到该提交，便于在快速迭代中复核原文。

## DeepSeek Harness 官方资料

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方文档](https://deepseek-harness.github.io/deepseek-harness/)
- [README：项目定位、运行方式与开发者预览提示](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.zh.md)
- [安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/SAFETY.zh.md)
- [总体架构：Profile、bundle、Agent、Session 与扩展点](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.zh.md)
- [第一个插件：apply、inject 与 ctx.effect](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/index.zh.md)
- [插件配置：Schemastery 与 HMR](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/config.zh.md)
- [打包与安装：bundle、profile、tarball 与 engines.dsh](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.zh.md)
- [扩展实操手册：UI、外部协议、记忆与定时任务](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cookbook/extension-cookbook.zh.md)
- [API Gateway：Remote、一元调用、流与 HTTP bridge](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/api-gateway.zh.md)
- [新增 Remote API](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cookbook/adding-a-remote-api.zh.md)
- [CLI 参考：plugin、web、headless 与 SDK](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cli-help.zh.md)
- [公开／代理部署：public-url、trusted-host、TLS 与 WebSocket](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/public-deployments.zh.md)
- [Schedule：调度、重启和投递记录语义](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/schedule.zh.md)
- [第三方记忆 MCP 接入](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/mcp-memory.zh.md)
- [SQLite Storage 后端](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/storage/storage-sqlite/README.zh.md)

## Tailscale 官方资料

- [Tailnet 概念](https://tailscale.com/docs/concepts/tailnet)
- [保护 tailnet 的最佳实践：HTTPS 等](https://tailscale.com/docs/reference/best-practices/security)
- [Serve 与 Funnel 的区别及基本用法](https://tailscale.com/blog/reintroducing-serve-funnel)
- [在 tailnet 中发布服务的几种方式](https://tailscale.com/blog/four-ways-tailscale-service)

本项目默认只使用 Serve 的 tailnet 私网能力，不使用 Funnel 的公网暴露能力。实际命令和配置以部署时 Tailscale 官方文档与客户端版本为准。

## 引用原则

- dsh 兼容性与插件 API 以官方源码和文档为准，社区文章仅作线索，不作为最终依据。
- 开始编码时重新记录 Mac mini 实际 dsh 版本和对应提交／发布标签。
- 若官方 master 已变化，应对比差异后更新接入文档，不能只修改版本号。
- 第三方组件进入选型前，需另行核查许可证、维护状态、数据去向和平台限制。

## 当前实现与本地参考基线

`v0.2.0` 的直接验证基线为本机安装的 DSH `0.2.1-rc.5`，其包内类型声明和真实隔离宿主优先于旧参考示例。上面的官方提交仍用于文档调研追溯，不把 master 的新 API 当作 rc.5 已具备能力。

本地参考包位于 `建设bot参考/`，当前采用范围如下：

| 参考 | 当前用途 | 不作为 |
| --- | --- | --- |
| `dsh-superagent-prototype-main.zip` | 单一数据权威、事件与任务模型、同源管理 API、侧栏工作台、TypeScript bundle 构建方式 | 不直接嵌入 GitHub／飞书工作代理 |
| `Cortico-main.zip`、`Coopanion-main.zip` | 产品与角色世界总纲：实际游玩、语音、直播、形象动作、事件节律与 World 分层 | 不把演示当成本项目进度，不引入第二套 Agent、人格或凭据体系 |
| `airi-main.zip` | Live2D 舞台、场景与后台任务独立 Session、记忆索引加单条事实、遗忘 tombstone | 不引入第二套 Agent 或人格核心，不作为唯一总纲 |
| `DeepSeekBot-main.zip`（Tobs） | 小型核心索引、详细记忆按需读取、Git 修订、Expo 配对参考 | 不作为 Companion 核心运行时 |
| `hermes-agent-main.zip` | 有界记忆、冻结快照、写入容量管理、会话检索与定期整理原则 | 不直接引入其 Agent 与 home/profile 隔离方式 |
| `surfcore-main.zip` | 活跃记忆与全量修订分离、清晰度与遗忘、隐私 scope、容量与隐私硬规则 | 不照搬 Windows／QQ／B站运行时 |
| `dsh-agent-soul-main.zip` | 记忆来源、唯一权威、索引指针与可吊销原则 | 不整套安装其专属插件生态 |
| `dsh-fish-buddy-main.zip` | DSH 会话事件、宿主／桌面端边界和面板接入参考 | 不照搬 Windows 挂件与独立人设 |
| `whale-craft-main.zip` | 后续 Minecraft Mineflayer、看门狗与权限设计 | 不在基础阶段接入游戏或第二份记忆 |
| `dsh-bili-humanism-main.zip` | 后续视频来源、媒体预算与证据追踪 | 不提前接入 B站或独立人格存储 |
| `astrbot_plugin_private_companion-main.zip` | 外部记忆 Provider 的 read/write/summary、身份归属、预算与超时边界 | 不直接复用 AstrBot 生命周期或第二 writer |
| `DeepSeek免费公皮.zip`、`大肥鱼合集_1.2.zip` | 后续本地形象验证，遵循各自素材授权 | 不打入公开插件包或重新分发 |

基础代码不依赖这些参考包在目标机器上的安装状态；引入具体代码或素材时必须另行核查并保留许可证与署名。

## 外部记忆方案资料

- [Mem0：How Mem0 Works](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx)：事实提取与检索分离、按 `user_id / agent_id / run_id` 和 metadata 过滤、由应用决定注入哪些记忆。作为后续语义 Provider 候选，不在首版引入向量库。
- [Letta](https://github.com/letta-ai/letta)：持久 Agent 与共享记忆块的思路。当前源码是另一套 Agent harness，本项目只借鉴核心／归档／按需召回分层，不替换 DSH。
- [Graphiti](https://github.com/getzep/graphiti)：时间上下文图、事实有效期与来源追溯。作为未来处理复杂关系与事实失效的参考；当前引入 Neo4j、LLM 与 embedder 的成本过高。
- AIRI 本地 ADR `docs/ai/adr/2026-10-10-skills-automations-and-memory.md`：场景路由、后台任务独立、记忆索引加单条事实、tombstone 与通用记忆，是 `v0.2.0` 最直接的参考。

本版优先复用机制而不是外部服务：DSH 插件内以 SQLite 维护唯一中央记忆，保留 Provider 替换空间，不先承担 Mem0／Graphiti 的模型、数据库和运维依赖。

## 移动端与本机工具链补充

- [Expo：Xcode 27 Device Hub 与 expo-device-hub](https://expo.dev/blog/xcode-27-device-hub-expo-device-hub)：Xcode 27 移除旧 `Simulator.app`，使用 Device Hub；Expo 的本地设备面板与模拟器控制工具可复用。
- [Tailscale Serve 官方文档](https://tailscale.com/kb/1242/tailscale-serve)：Serve 面向 tailnet，Funnel 面向公网；本项目只采用前者。首次使用可能需要管理员为 tailnet 启用 Serve。
- `expo-device-hub` 当前为 `0.21.0`、MIT，仅作为开发依赖，不进入 DSH tarball，也不监听公网接口。
- React Native `0.88.1` 的 Hermes 路径编码问题以本机 CocoaPods 最小复现和完整 Ruby 堆栈为依据，项目补丁只处理两处 Node 路径的 UTF-8 解码，不宣称上游所有版本都有同样问题。

- [react-native-keyboard-controller 官方安装说明](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/installation)：Provider 接入、原生重编译与 Reanimated 依赖。本项目采用 Expo 58 清单中的 `1.22.7`，不自行维护键盘测量实现。

## 视觉参考录屏

- 用户提供的 X 使用录屏：`/Users/thysummer/Downloads/LANDrop/1000035000.mp4`。仅抽取关键画面和短动效分析横向抽屉、底部回复区、导航与操作层级，不复制或分发原视频及其中素材。用户已明确主要界面不要黑色，只希望参考丝滑动效；设计约束见 `docs/product.md` 的“视觉与动效参考”。

## 开源界面参考（2026-11-06）

- [Bluesky 官方 React Native 客户端](https://github.com/bluesky-social/social-app)：实际阅读 [`BottomBar.tsx`](https://raw.githubusercontent.com/bluesky-social/social-app/main/src/view/shell/bottom-bar/BottomBar.tsx)，并在 Pixel 7 尺寸的浏览器视口中查看其公开移动端个人主页，参考一致的图标尺寸、明确的选中态、身份与次级信息层级、原生安全区域和可访问标签。其 README 明确说明品牌、字体和部分图标素材不随 MIT 代码授权；本项目不复制其品牌、定制图标或界面素材，也不引入其账号体系与整套 ALF。
- AIRI 本地参考包中的 `DESIGN.md` 与 `stage-layouts` 聊天组件：参考“角色空间优先于控制”、紧凑输入区、克制的边框和清楚的状态文字；不把桌面舞台或未接入的语音按钮搬到手机上，也不引入 Vue 运行时。
- `@expo/vector-icons` 的 Ionicons：仅作为 Expo 兼容的通用界面图标依赖，按包内许可使用；直接引用单一字体入口，不打包未使用的图标家族。

参考源码不等于已经通过本项目的视觉或可访问性验收；最终仍以 Android 原生页面的实际渲染、交互和网络结果为准。

## 用户提供的角色形象

- 用户明确指定 `/Users/thysummer/Downloads/x_media_downloader/Jacobaaaaa154-2117791442135285863-01.mp4` 作为大肥鱼形象素材。已核对为 H.264、638×644、11fps、6.7 秒、无音轨，文件 296,258 字节。
- `apps/mobile/assets/persona/whale.mp4` 是与原文件 SHA-256 一致的本机素材副本，用于角色区的静音循环播放；`whale.png` 是从原视频首帧生成的 512×516 静态图，用于小头像和减少动态效果模式。
- 视频只在角色区创建一个播放器，离屏与后台暂停，减少动态效果时使用静态图。这里不是 TTS、实时视频通话或 Live2D 驱动，也没有把用户素材放进 DSH 插件包。
- 当前用途是用户个人本机 App。没有从文件中确认原作者及公开分发许可，对外发布素材前仍需确认授权；原始文件保持不修改。

## Cortico 机制参考

- 用户补充的 `建设bot参考/Cortico-main.zip` 采用事件流、Persona／Memory／World 分层，与我们已确定的“单一角色核心、多个独立场景、受控连接器”一致。只参考机制，不引入第二套 Agent、WebUI 或其运行时。
- 实际阅读 `bots/cormini/persona/heartbeat.ts`：连续无外部事件时按倍率退避、活动后恢复基准频率。后续主动行为应采用可暂停、可恢复、有限频率的节律，避免固定间隔刷屏。
- 实际阅读 `bots/corti-soulmate/persona/rhythm.ts`：到期唤醒、事件投递闸门、关键词提前唤醒和溢出批量放行。后续可借鉴“投递不等于完成”的调度与批量处理，不把闹钟直接当成模型已完成任务。
- 实际阅读 `src/web/client/core/stream.ts`：重连退避、连接前发送队列、卸载时取消连接与重连定时器。当前设备客户端已有 generation、健康检查和 watchdog，保留这些已验证约束，不照搬其网络协议。
- 本项目当前选择优先实现真实的动态、记忆与受控工具，不把 Cortico 的 QQ、B站、Minecraft、VTuber 等外部 World 提前接入。

## Piper 技术验证（历史方案，2026-11-07）

- [Piper 官方仓库](https://github.com/OHF-Voice/piper1-gpl)与[PyPI 元数据](https://pypi.org/pypi/piper-tts/json)：曾验证 `piper-tts==1.8.0`、GPL-3.0-or-later，支持 Python 3.12 和 macOS arm64；当前不再作为正式声线。实际调用方式核对自官方[Python API](https://github.com/OHF-Voice/piper1-gpl/blob/master/docs/API_PYTHON.md)的 `PiperVoice.synthesize_wav`。
- [官方声线说明](https://github.com/OHF-Voice/piper1-gpl/blob/master/docs/VOICES.md)：一个声线需要 `.onnx` 与 `.onnx.json`，并应阅读各自的 `MODEL_CARD`。技术验证使用 [`zh_CN-huayan-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium)，22,050Hz、单说话人、eSpeak 中文音素路径，不需要中文 g2pW 扩展；未作为正式角色声线。
- 模型 SHA-256 为 `9929917bf8cabb26fd528ea44d3a6699c11e87317a14765312420be230be0f3d`，与仓库 LFS 元数据一致。官方站点直连超时后，通过 `hf-mirror.com` 对应仓库路径传输模型，在 Mac mini 上再次校验该哈希，不采用未知二进制。
- 华炎 `MODEL_CARD` 明确写有 `License: Unknown`。因此当前仅限用户个人 Bot；公开或商业分发前必须更换许可明确的声线或取得授权，不能把 Piper 引擎的 GPL 许可误当成声线数据的再分发许可。
- 手机播放采用 Expo 58 兼容的 `expo-audio@58.0.11`，以已核对的 `AudioSource.headers` 发送设备 Authorization。当前配置关闭麦克风权限、后台录音和后台播放，不提前申请未来实时通话才需要的权限。

## 用户指定的后续声线方向（2026-11-07）

本节记录模型选型、本地素材和部署依据。GPT-SoVITS 已迁移到 Mac mini 并通过真实大肥鱼语音合成；Companion 接入结果以接入文档为准。聊天、动态与连接修复随同一版本交付，不单独制作无语音版本。

### GPT-SoVITS v5 turbo：优先复用的日常声线

- 视频参考：[GPT-SoVITS-v5 评测](https://www.bilibili.com/video/BV1TEJe6oEvR/)，官方实现：[RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)。本地代码仓库的 LICENSE 为 MIT，但模型权重、其他预训练组件和参考音频的权利仍需分别核对，不能把代码许可等同于全部素材许可。
- 用户已有工程 `/Users/thysummer/工作流/二创/GPT-SoVITS`，其中 `GPT_SoVITS/configs/tts_infer.yaml` 明确配置 `device: mps`、`version: v5turbo`。本地分支与文件有用户修改，不能直接覆盖或重置。
- `s2Gv5turbo.pth` 为 766,406,144 字节，SHA-256 `287b32a06b7d486f5303ec520468b0728fb01aac8b0f5d86fd5455c9a1d3e022`；`vocoder.pth` 为 57,761,163 字节，SHA-256 `b7543c83222aa2105bb4efb56845086bc5f2eeba61243d723ffa062052b3221f`。两者都与 [官方权重目录](https://huggingface.co/lj1995/GPT-SoVITS/tree/main/gsv-v5-pretrained)当前 LFS 元数据一致，不需要因“最新权重”重新下载。
- 目标声音素材位于 `/Users/thysummer/工作流/二创/assets/deepseek-whale-girl/`。`deepseek_ref_b_7s.wav` 为 6.83 秒、24kHz 单声道，已有精确对应的参考文本；另有 7.28 秒短样本、19.5 秒长样本和 9.44 秒的 `test_gsv_v5turbo_mps.wav`。这些是后续声音复用的直接基础，不需要重新配音。
- `workbench/data/samples/DeepSeek-import-fc3685f2.json` 将样本标为 `reviewed: false`，所以这里只确认素材和元数据存在，不宣称已人工试听确认最终音色。
- 本地 `api.py` 支持 v5turbo，但其默认监听 `0.0.0.0`，并暴露模型切换和任意参考路径参数。以后接入时应只监听回环地址，由 Companion 固定参考音频、文本和模型，不允许手机直接调用这些管理接口或传服务器文件路径。
- 英文与混写文本还需要 NLTK `cmudict` 和英文标注器。Mac mini 的官方下载链路被重置后，实际复用原工程 `.venv/nltk_data` 中已有的三份 ZIP，校验并解压到独立 `~/.local/share/companion/gsv/nltk_data/`，LaunchAgent 以 `NLTK_DATA` 指向该目录。`pos_tag(['oak','log'])` 与含 `oak_log` 的真实语音均已通过；原二创工程未修改。

### Fish Audio Drama3：高表现力与编辑能力

- 视频参考：[Drama3 TTS 测评](https://www.bilibili.com/video/BV1Qzxy6yE1e/)。以[官方模型卡](https://huggingface.co/fishaudio/drama-3)、[fish-speech 仓库](https://github.com/fishaudio/fish-speech)和实际许可文本为准，视频中的性能与评价不直接等同于 Mac mini 的结果。
- 官方确认 Drama3 为 35B-A3B、每 token 约 3B 激活，支持多角色、长文本、自然语言情绪控制、多轮修改和局部语音编辑。其默认 SGLang-Omni 性能数据来自 NVIDIA H200，不是 Apple Silicon 的实测成绩。
- [SGLang-Omni](https://github.com/sgl-project/sglang-omni) 的完整模型后端以 NVIDIA CUDA 为主，Apple Silicon 仍属实验路径。新合并的 [#3425](https://github.com/sgl-project/sglang-omni/pull/3425) 为原生 MLX Drama3 提供有界磁盘专家缓存，证明 4bit 量化在 16GB Mac 上具有可实验性，而非不能运行：其公开结果约为 8–9GB 峰值内存、9 秒首音，offload RTF 约 4。不同机器与完整模型对照仍有限，不能承诺本机延迟或音质。
- 因此建议日常低资源声线先用 v5 turbo，Drama3 以后用于离线高表现力、多人场景和音频编辑实验；若需要实时 Drama3，应考虑独立 GPU Provider。不得让 Drama3 的加载或推理阻塞 DSH、文字聊天或未来的游戏服务。
- Drama3 模型卡许可段落及 [fish-speech LICENSE](https://github.com/fishaudio/fish-speech/blob/main/LICENSE) 指向 Fish Audio Community License。文本明确允许个人、研究和非商业用途；商业年收入门槛为 500,000 美元，Hosted Service 需单独授权。自己产品生成并提供角色语音有例外，但向第三方开放自助语音生成不能简单套用该例外，公开服务前必须重新审查。还需保留“Built with Fish Audio”署名，并遵守可识别真人声音的同意要求。

## 自主角色内核机制对照（2026-11-07）

- AIRI `integrations/satori-bot/src/core/loop/scheduler.ts`：按场景维护未读事件与处理锁，有事件才处理，周期性唤醒不强行生成回复。Companion 将完成事件转为持久自主任务，用场景去重键、计划时间和实际 Task 状态实现相同约束，不照搬 Satori 协议。
- AIRI `integrations/minecraft/src/cognitive/event-bus.ts`：事件具有来源、时间和追踪关系，订阅错误彼此隔离。当前 Companion 以 `sessionId:event.seq` 保证事件唯一性，用 `contextId` 关联长期场景，自主任务和 Task Store 保留执行结果，不复制其 AsyncLocalStorage 事件总线。
- AIRI `packages/stage-ui/src/stores/modules/artistry-autonomous.ts`：独立分析任务、有限历史、结构化 JSON、处理锁、频率与错误边界。`memory.curator` 借鉴这种 Director 模式，但输出只能是候选记忆，不能直接生成图片、动态或活跃记忆。
- Cortico 的空闲退避、投递闸门与批量溢出原则继续适用于后续自主动态。当前自主动态默认关闭，启用后仍需最小间隔、免打扰、真实活动门槛和真实工具结果，不以固定时间发帖冒充主动生活。
- DSH 继续负责真实 Agent、Session、模型调用和工具执行。自主内核只负责持久化调度、权限、状态和分析结果校验，不创建第二套 Agent Loop，也不把原生 Schedule 的投递记录当作完成证明。

## 长期角色世界参考与边界（2026-11-07）

### 自治、任务与 World

- `Coopanion-main.zip` 的 LICENSE 为 AGPL-3.0。可参考 `figure.json` 形象包、动作词表、权限与真实回执、桌面互动和 OBS 输出，不直接将其整套运行时或代码并入当前 UNLICENSED 项目；直接复用代码前必须单独评估许可义务，不复制其遥测、凭据或数据布局。
- `Cortico-main/PHILOSOPHY.md` 与 `memoTiers.ts` 提供 Core／Persona／Memory／World 分工和常驻、活跃、归档分层。继续保留 Companion 的 SQLite 中央记忆和修订历史，不为了形似参考项目改成另一套文件真相。
- `dsh-superagent-prototype-main.zip` 的 Trigger／Eval／Mandate／Assignment／Outbox 用于界定事件、评估、有限授权、执行和结果。Mandate 不代表无限权限，订阅与关联不自动扩大可见范围；具体执行复用 Companion Task Store，不另建 Agent。
- `Curio-Observer` 尚未取得可审查源码，`LingChat` 尚未逐文件核实，`my-neuro` 只核实了语音、动作、记忆、游戏和直播等方向，均不列为已采用实现或性能依据。

### Minecraft 实际接入

- [Coopcraft README](https://raw.githubusercontent.com/ThySummer14/coopcraft/main/README.md)、[服务端说明](https://raw.githubusercontent.com/ThySummer14/coopcraft/main/server/README.md) 与 [Fabric 元数据](https://raw.githubusercontent.com/ThySummer14/coopcraft/main/src/main/resources/fabric.mod.json)：已确认其为 MIT 的 Minecraft 1.21.1 Fabric 模组，提供共享进度、坐标、死亡点、路径点与文明机制，**不是现成 Agent API**。服务端以 Java 21、Tailscale、白名单和 `online-mode=true` 为基线；构建工具链要求 JDK 25，不与运行要求混淆。
- 实际接入采用 Carpet fake player＋[CBI / Carpet Baritone Integration](https://github.com/Hikari16665/CarpetBaritoneIntegration)，无需新增微软账号，保留 `online-mode=true` 和原白名单。原版 Carpet `1.4.147` 的 SHA-256 为 `079fc8a4e073eb24b010ffcc588e59f93b984143e17d8ef19fbb0b6aff0f19d9`；原始 CBI `v1.7+260820` 的 SHA-256 为 `e9e7379e60d8c3e9eadfb15ce188ab2b9fc27e89267a6e2638010b4ac59cb3ce`。
- [CBI 1.21.1 说明](https://www.mcmod.cn/class/29195.html)和 `multiver/1.21.1` 源码已核实跟随、坐标寻路、缓存查找、精确破坏、状态、拾取与停止。实测其 `[CBI]`／`[CBI-AI]` 私聊回执会再次进入自己的 AI 处理；独立补丁旁路自动回执、让执行阶段读取权威世界、补全区块边界处理，并为查找增加明确完成回执与有界同步扫描。上游 `LICENSE.md` 与 README 声明 AGPL-3.0，但原包 `fabric.mod.json` 标为 LGPL-3.0-or-later，存在声明差异；按较严格方式保留原 JAR、修改后源码与各项许可，不把源码并入主项目。
- 稳定版修改源码位于 `建设bot参考/CarpetBaritoneIntegration-companion-20261108.tar.gz`，SHA-256 `4327d41d59ae4e611134ef8afbc1949f68cbb954533dbc5015febbfb6445f8ef`；对应 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-companion.jar`，SHA-256 `a0c9fef38595e9799b4b292368467c9e930df983ba0d4e009a84a561033ec73f`。Mac mini 的 `~/.local/share/companion/minecraft/source/` 保存相同归档，服务器 JAR 哈希已核对。
- `0.12.0` 生存反射候选另存为 `建设bot参考/CarpetBaritoneIntegration-survival-20261108.tar.gz`，SHA-256 `0dd32f2411b0cdb0f533d71fdea2b935cd2b2b2bbeb85e8f9c372400673b937a`；候选 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-survival.jar`，SHA-256 `2b3f3e51c2d3d4d2f91f47a7739b11e15b701db813ea3b50e9dd3ae25d409f79`。它扩展 CBI 的 tick 战斗／避险输入与资源策略，尚未部署或实机验收，稳定版归档不覆盖。
- `0.12.2` 受限回程候选完整源码位于 `建设bot参考/CarpetBaritoneIntegration-return-20261108.tar.gz`，SHA-256 `0f4516764991af46f820deff2cef7b28be75e8372cec12c3b0442646bfbbe727`；对应 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-return.jar`，SHA-256 `a3bb0eebc3c8f2248a582488c0ce7390f21bf3ef1ae185cffe254dee2093d7ee`。归档保留上游许可与完整修改源码，不包含构建输出；尚未部署，稳定版与上一候选均不覆盖。
- `0.12.3` 真实配方合成候选完整源码位于 `建设bot参考/CarpetBaritoneIntegration-crafting-20261108.tar.gz`，SHA-256 `3276a816b113e7cb1aa1ac603a543d9720d0d03e505b317b55af77bba87ba64e`；对应 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-crafting.jar`，SHA-256 `5b3477367f169ea09addd432ded343d8a4039d653b6600875050253524eb0b82`。归档保留上游许可、真实配方事务与测试源码，不包含构建输出；尚未部署，既有候选与稳定版均不覆盖。
- `0.12.4` 授权区营地候选完整源码位于 `建设bot参考/CarpetBaritoneIntegration-building-20261108.tar.gz`，SHA-256 `e8ae39bc18cd4df0102603937b8c5b08d2d288bff06c8fc7e22d7a554062e7b6`；对应 JAR 为 `建设bot参考/carpetbaritoneintegration-v1.7.1+260820-building.jar`，SHA-256 `38077d0635b1344cb716187aae467ea8d4a17609ff0bdc22acdf3f14bd4e2b7c`。归档保留上游许可、授权区与逐块建造测试源码，不包含构建输出；尚未部署，既有候选与稳定版均不覆盖。
- 用户提供的 [LSP 自定义局域网联机](https://www.mcmod.cn/class/2754.html)面向局域网在线模式与 UUID 设置，不是本专用服务器的假人控制方案，不采用它绕过正版验证。
- 原版 Mineflayer＋Tailscale 适配器保留给有独立正版账号的服务器，不再要求为 Coopcraft 新增微软账号。RCON 原配置和密码未读取、未使用；世界已有独立备份，安装目录与依赖目录不进入自动清理。
- 本地 `whale-craft-main.zip` 提供 33 个 `mc_*` 工具及实例隔离、超时、取消和回读参考；[blueziii/dsh-mc-agent](https://github.com/blueziii/dsh-mc-agent) 已核实 41 个工具，覆盖采集、合成、建造、导航、战斗、地图和第一人称观察，进入实现时优先评估成熟工具的复用与适配。
- [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) 只作为高层规划参考，默认禁用任意生成代码执行。本地 `jingyu-live2d-agent-main/minecraft/survival-policy.cjs` 的生存依赖和危险策略也必须在本项目真实服务器验证后再使用。
- 用户提供的 [DeepseekOVO 公开版](/Users/thysummer/Downloads/DeepseekOVO-公开版/README.md) 是 Mindcraft＋Mineflayer 路线，README 的广泛能力不等于 Companion 已有能力。其实际 [地点记忆](/Users/thysummer/Downloads/DeepseekOVO-公开版/src/agent/memory_bank.js) 将名称绑定到坐标，[建筑实现](/Users/thysummer/Downloads/DeepseekOVO-公开版/src/agent/library/building.js) 保留续建锚点、朝向与建筑保护范围。`0.116.0` 借鉴“命名地点＋跨场景回忆”与原地续建思路，落为已验收工程的受限地点簿、现有 SQLite 和中央记忆；不复制其进程、通用挖掘、无限自动续跑、命令行拼接语音或临时音频清理方式。参考目录的 MIT 许可已读取；地点簿未复制其实现代码。`0.117.0` 经该目录直接加载 `putInChest / takeFromChest / startSmelt / collectSmelted`，不启动其 Mindcraft Agent。Mineflayer 固定为 [u9g 的 v4.39.0-allprs.3](https://github.com/u9g/mineflayer/releases/tag/v4.39.0-allprs.3)，发布包 SHA-256 `0d914789eb8849edba26f2946c202457e41d0e652d37e6db334840617aae1753`；`minecraft-data` 同时固定为 [v3.116.0-allprs.2](https://github.com/u9g/node-minecraft-data/releases/tag/v3.116.0-allprs.2)，避免只换客户端而混用不兼容的协议数据。

### Live2D、动作与桌面展示

- `DeepSeek免费公皮.zip` 内含 `DeepSeek/大肥鱼.moc3` 与 `DeepSeek/大肥鱼.model3.json`，是标准 Live2D 验证素材。包内须知允许个人直播、视频创作及相应平台收益，但不允许擅自重新分发完整模型、二次销售或未经许可的商业产品化。公开使用需注明“原画及拆分：神宫凉子；Live2D 建模：霓虹猫_NeonNeko”。实际公开范围仍以包内完整须知为准。
- `大肥鱼合集_1.2/ysm-pack.json` 与 `ysm-pack.png` 是 YSM／游戏资源，不是标准 Live2D，两者不混用渲染器；只按用户个人使用范围保留，不写入公开插件包。
- `Aly-Deepseek v1.0.2.ysm` 是新版 Minecraft 形象候选，包内显示名为「希可」，作者为 AnluoSakura。下载目录和「安洛樱的YSM模型」子目录中的同名文件 SHA-256 均为 `0fd50f83eaa0de4a00d375f854d8b28211558e019708291e6d84b9633d3c15db`。包内说明允许免费使用，禁止商业用途与二次分发。保留用户本地原件，不进入插件包或服务器同步目录。[YSM 模型格式](https://yesstevemodel.github.io/wiki/type/)
- YSM 2.6.5 支持 Minecraft 1.21.1 Fabric 和 Carpet 假人。正式 Coopcraft 运行在 Apple Silicon macOS，而官方支持表中该平台的客户端、服务端均不可用。YSM 服务端还会向客户端自动同步模型，模型分发权限需要和平台适配一起核对。[YSM 平台与同步说明](https://yesstevemodel.github.io/wiki/intro/)
- 本地 `jingyu-live2d-agent-main.zip` 的 `web/engine.mjs` 和 `web/community-vendor/motion-intent.mjs` 可作为舞台、动作 intent、优先级、相位仲裁和停止回执的参考；`THIRD-PARTY.txt` 明确 Cubism Core 需按官方许可另行取得，不能因源码可下载就获得再分发权。本项目只复用动作引擎、驱动管线和待机机制，并保留 MIT 许可，不引入整套 Windows 工作台。
- [Cubism SDK for Web 官方下载页](https://www.live2d.com/en/sdk/download/web/)与[官方 Core](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js)：Core 为 207,155 字节，SHA-256 `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f`，与本地鲸语 `vendor-sources.json` 的记录一致。遵循[官方专有许可](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)，仅放私有运行目录，不进入 Companion tarball。
- Mac mini 的 Chrome 已通过实际渲染：Apple M6 Metal、509 个运行时参数、0 个异常参数。正式 DSH 舞台的抬手示意成功、脸红取消成功；截图来自目标机，不把本机渲染或静态图当作 Mac mini 的验收。头显帧率、长期功耗和实时口型不在这次基础验证的承诺内。
- [HoppoChan0721/dsh-desktop-petbox](https://github.com/HoppoChan0721/dsh-desktop-petbox) 主要是 Windows 桌面外壳，依赖鲸语 `1.4.0-beta.2`、用户自己的模型文件和 Cubism Core。其 [`patch/apply-jingyu.mjs`](https://raw.githubusercontent.com/HoppoChan0721/dsh-desktop-petbox/main/patch/apply-jingyu.mjs) 明确将尾巴裁切毛边归因于默认 256 遮罩缓冲，并提供上限 2048 的修复；`0.12.1` 按同一机制适配，保留 whale-pet-shell 的 MIT 署名，不把外壳当成 Mac mini 的 Live2D 运行时，也不把整体分辨率提高当成根因。
- Coopanion `script.ts` 的文本动作解析只作为受控词表参考；模型不支持的词应忽略并回报，自然语言不能直接覆盖任意模型参数。

### 实时语音、歌唱与媒体

- `jingyu-live2d-agent-main/docs/cosyvoice-streaming.md` 的 start／append／done／cancel、增量文本、PCM 队列、播放时钟和取消方式可作为实时链路参考。其 instruct2 双流路径曾把语气指令也朗读出来，不能未经评估直接照搬；优先验证语义短句、音频顺序和实际播放状态。
- GPT-SoVITS v5 turbo 继续服务按需语音，实时语音与歌唱分别选择 Provider。歌唱需另行评估歌声合成或声线转换、音高、节奏、伴奏和授权，不能以普通 TTS 任务冒充。
- ACE-Step 1.5 用于从歌词和风格生成短歌，Companion 使用独立任务和 WAV 回执承接。已有独立人声导唱时，Mac 候选可以用已验证的 Seed-VC 带 F0 歌声转换复用目标参考声线。 [ACE-Step 接口](https://github.com/ace-step/ACE-Step-1.5/blob/ca1e85fe9430179831e6bc6be790c332190a3866/docs/en/API.md) · [Seed-VC 项目](https://github.com/Plachtaa/seed-vc)
- `dsh-cover-pipeline` 1.1.3 提供从分轨、换声到混音与验收的 DSH 调度参考。默认先用 MSST 拆人声和伴奏，再拆主唱与和声，仅给主唱换声，并将技术检查与听审分开。其宿主回归覆盖 Windows／Linux 上的 rc.2／rc.3。DDSP 6.2 路线需要配套的权重、编码器、音高提取和声码器。Companion 复用已有会话和归档，参考上游的主唱／和声分离、混音检查和试听顺序。 [翻唱插件](https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline) · [版本记录](https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline/blob/main/CHANGELOG.md) · [依赖清单](https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline/blob/main/docs/dependencies.md)
- `FeiyuVoice-RVC-v1` 是声库的发布名，实际权重采用 RVC v2、40 kHz、F0 条件，并配独立的 `.index`。配套服务另将 SoulX-Singer 的按谱演唱和 RVC 换声串起来，预设覆盖 CUDA、WSL ROCm 和 Intel XPU。Companion 在 Apple Silicon 上直接使用本机 Applio 载入同一权重。 [声库与兼容说明](https://huggingface.co/Esmerubphire/FeiyuVoice-RVC) · [服务环境](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/main/server/RUNTIME.md) · [素材与分发说明](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/main/NOTICE.md)
- 用户提供的 RVC 训练视频记录了长音发抖和吞字，作者分别观察了气声、软起音和静音洞。把这些问题列入同源片段听审，比单看训练步数更容易发现歌曲换声的瑕疵。 [RVC 训练记录](https://www.bilibili.com/video/BV1pY4P6nEMp/)
- Apple Silicon 的肥鱼换声验证从 Applio 的本机单文件入口开始。准备匹配的 `.pth`、`.index`、ContentVec 和 RMVPE，先核对声库发布校验值。用已验收的《空城计》中文导唱，固定伴奏、响度与剪辑点，对照当前 Seed-VC 和 RVC。RVC 第一组沿用声库基准 `pitch=0`、`index-rate=0.3`、`protect=0.33`、`volume-envelope=1.0`。记录耗时、峰值、时长与人声时序，再听软起音、长音、吞字、换气和角色辨识度。基准通过后再复用 Companion 的换声接口、手机归档和舞台口型。Applio 提供 macOS 安装与 CLI，肥鱼配套 HTTP 服务公布的实测平台目前为 Windows／WSL 和 Linux 的部分显卡。按谱唱另外需要 SoulX-Singer 和已对齐的参考音频。 [Applio macOS 安装](https://docs.applio.org/getting-started/installation/) · [单文件 CLI](https://docs.applio.org/reference/cli/#single-file-conversion) · [肥鱼声库参数](https://huggingface.co/Esmerubphire/FeiyuVoice-RVC) · [肥鱼服务验证范围](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice#当前验证到哪一步)
- 群公告提供的 `rvc_cover_backend_X` 是独立 GPU 主机的部署备选。公告将权重放在 `RVC20260718\assets\weights`，匹配索引放在 `RVC20260718\assets\indeces`，硬件分组和路径拼写按公告记录。镜像文件清单已核对三份文件名与大小，兼容性和包内版本待核验。 [镜像文件清单](https://hf-mirror.com/MercyStar/RVCSVC-API-Pro/tree/main) · [NVIDIA 50 系 10.9 GB](https://hf-mirror.com/MercyStar/RVCSVC-API-Pro/resolve/main/rvc_cover_backend_50.7z?download=true) · [其他 NVIDIA 11.0 GB](https://hf-mirror.com/MercyStar/RVCSVC-API-Pro/resolve/main/rvc_cover_backend_N.7z?download=true) · [AMD 8.82 GB](https://hf-mirror.com/MercyStar/RVCSVC-API-Pro/resolve/main/rvc_cover_backend_A.7z?download=true)
- EasyAIVoice 的声库页和 Hugging Face 账户作为模型发现入口。候选按单个模型核对架构、配套索引、训练素材说明和使用条款，肥鱼同源试听先用上面有独立模型卡的声库。 [EasyAIVoice 音色库](https://easyaivoice.com/app) · [jsnsbsbjwj 的模型页](https://huggingface.co/jsnsbsbjwj)
- Companion 保有自己的导唱输入、分轨、换声、混音、回执和归档接口。Apple M5 的同源测量和隔离会话翻唱通过后，Applio RVC 成为可选的第二个换声 Provider，默认 Seed-VC。只在歌曲确实存在和声串入或混响残留时引入第二级分离，试听确认后再决定换主唱还是整条人声。日常语音继续按首音延迟与可打断性单独选择 TTS。 [肥鱼 RVC 验证](dsh-integration.md#77-companion-0490-肥鱼-rvc-翻唱)
- `demucs-mlx` 将 Demucs 移植至 Apple Silicon 的 MLX，提供本地模型缓存及禁用下载的运行模式。Companion 固定使用 `htdemucs`，将非人声轨合并为伴奏。`vocals` 人声轨可能同时包含和声。 [demucs-mlx 源码](https://github.com/ssmall256/demucs-mlx) · [1.6.1 包信息](https://pypi.org/project/demucs-mlx/1.6.1/)
- 媒体清单统一保存哈希、来源、大小、最近使用时间和保留策略，先统计与预览，再归档或删除可再生产物。模型权重、角色原素材、参考声线、原始聊天、中央记忆和备份不进入自动垃圾清理。

#### IndexTTS 2.0 V4 便携整合包

- 检查了本地三卷完整包、升级包与长文工作台补丁的目录和入口。三卷 ZIP 合计约 12.37 GB，`BUILD_INFO.json` 声明展开内容约 18.07 GB，ZIP 全部文件条目合计约 18.17 GB。内置 `runtime/python.exe`、Windows FFmpeg 与 CUDA 组件，整包目标环境是 Windows 10/11 和 NVIDIA CUDA 12.8。上游 IndexTTS 的 Python 推理入口与此便携运行时分开。
- 将三卷包里的 `gpt.pth` 和 `s2mel.pth` 直接读入 SHA-256，结果与 IndexTeam 发布的 IndexTTS-2 权重完全一致。V4 的版本号属于便携工作台。IndexTeam 后续的 2.5 有独立权重，本次实测使用 2.0。 [GPT 权重](https://huggingface.co/IndexTeam/IndexTTS-2/blob/main/gpt.pth) · [S2Mel 权重](https://huggingface.co/IndexTeam/IndexTTS-2/blob/main/s2mel.pth) · [上游版本记录](https://github.com/index-tts/index-tts#-news)
- V4 的 `POST /api/v1/tts` 接收 multipart 文本、参考音频及可选的情绪音频、向量或文字。SSE 传输排队、生成和取消状态，完成后通过 `GET /api/v1/audio/{name}` 取 WAV。包内推理函数另有逐段输出选项，每段要先完成 GPT、S2Mel 和 BigVGAN，公开 HTTP 合成入口没有调用该选项。若复用此接口，`done.mel_capped` 需要单独核验，避免把截断音频归档成完整成品。长文工作台可参考分段、术语读音、字幕时间轴和成果保留机制。
- 本机 Apple M5（24 GiB）从 V4 三卷包按需取出推理权重与编码器，用 Apple Silicon 原生实现转换后离线合成。GPT 采用 4-bit，S2Mel 保持默认 25 步。已有大肥鱼参考音可预先编码成独立声线缓存，正式合成进程从缓存加载，跳过再次加载三个参考编码器。 [IndexTTS 上游文档](https://github.com/index-tts/index-tts#-getting-started) · [本机验证所用的 MLX 实现](https://github.com/vanch007/mlx-indextts2/tree/a7666367b8551656a2029ad75f259cb5e4936b3b)
- 三条候选的基准复用同一段 6.83 秒参考音和三句中文。IndexTTS 以完整波形就绪时间加片内起声偏移估计热态可播首音，六轮中位数 8.98 秒，最短一句两轮中位数 5.17 秒。六轮完整波形就绪时间中位数 8.91 秒，RTF 中位数 1.67。此前 GPT-SoVITS 本机回环完整 WAV 中位数 4.75 秒，VoxWeft 本机回环首个有声 PCM 中位数约 275 ms。计时点有差异，均未包含真实扬声器起播。 [现有语音基线与计时口径](dsh-integration.md#44-v0170-低延迟-tts-候选)
- 同一句话用参考音语气、开心和低落三档分别生成 6.03、6.75 和 8.00 秒 WAV。旁白分 7 段，52.37 秒生成 29.32 秒音频。11 个样本通过 WAV 格式、帧完整性和信号检查。离线转写覆盖旁白的五句原文，但有同音字及短语差异，低落版差异更多。单进程峰值 RSS 4.88 GiB，MLX 记录的峰值 8.22 GiB，统计范围不同。正式 16 GiB Mac mini 的共存容量仍需验证。
- 隔离验证未接入 Companion 或 Android。转换后的推理文件约 2.74 GB，预计算声线约 4.19 MB。原始 V4 包留在参考目录，试验解包、转换权重、声线缓存及 Python 环境已清理。复核了 11 个试听 WAV 的文件哈希、采样率、单声道 PCM 和帧数。 [原语气](../.work/indextts2-v4-check/audio/emotion-reference.wav) · [开心](../.work/indextts2-v4-check/audio/emotion-happy.wav) · [低落](../.work/indextts2-v4-check/audio/emotion-sad.wav) · [长旁白](../.work/indextts2-v4-check/audio/narration.wav) · [实测数据](../.work/indextts2-v4-check/evidence.json)
- 随后的 0.100.0 候选已接入按需情绪配音。以同一段持久化助手消息实测三种语气、配对下载、取消、重试、缓存复用与媒体归档。正式 Mac mini 的集中验收再检查与 DSH、Minecraft 同机时的内存压力、卸载回收和角色音色。 [接入与验证](dsh-integration.md#129-companion-01000-按需情绪配音)
- 长文工作台 v0.33 将文本分段、分段续渲染和 SRT 导出拆成独立入口。可在大肥鱼的离线旁白任务中复用这个拆分方式，按段记录实际生成时长，最终从成品音轨导出字幕时间轴。

### 视频浏览与 Token 预算

- [InariNGT-Ofiicial/dsh-bili-humanism](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism) 与 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 作为后续 B站 World 候选。前者的 `maxReadTokens=600000` 是单份稿件的 UTF-8 字节估算上限，不是供应商实际 token、账单或推荐默认值，不能直接照搬。
- 视频内容按来源许可去重、分段、按需读取与摘要，不把完整字幕、弹幕或整份媒体灌入模型。常驻工具保持小集合，扩展工具由宿主按场景和意图加载，避免每轮先读工具目录。
- `dsh-bili-humanism` 曾记录旧播放器接口返回字幕错轨。Companion 采用公开 WBI 播放器，核对可得的稿件、分 P 标识及字幕时间轴后才返回片段。 [播放器接口说明](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/blob/main/docs/PLAYER_ENDPOINT.md)
- 视频中的五层记忆思路吸收为“原始日志、空闲摘要、中央记忆、按需检索、自我笔记”，但不机械采用重复即增信、不可纠正的人格或固定 token 节省承诺。人格观察必须有证据、反例、置信度、归档和回滚。

### DSH Go 安卓底座候选

- [DSH Go 源码](https://github.com/ccch1mneyyy/dsh-Go/tree/2432cbdcc92f4a2ced6e8ffeba648af0f832eb98) 已提供 Flutter 会话界面、流式消息、附件、主题与桌宠，可作为安卓客户端底座。大肥鱼的场景路由、动态、语音及设备配对继续使用 Mac mini 的 Companion 插件，客户端适配现有 `/companion-device/api/`。
- [DSH Go 的伙伴小屋接口](https://github.com/ccch1mneyyy/dsh-Go/blob/2432cbdcc92f4a2ced6e8ffeba648af0f832eb98/packages/dsh_client/lib/src/companion_api.dart) 通过 `/dsh-go/v1/companion` 使用上游独立的状态与记忆库。可复用界面与事件表现，将大肥鱼的游戏、休息和语音状态接到当前 Companion 的真实事件，中央记忆仍由现有 SQLite 管理。
- [上游远程连接指南](https://github.com/ccch1mneyyy/dsh-Go/blob/main/docs/guide/zh/03-engine-hosts.md) 使用 SSH 或 DSH Remote。原生插件面板依赖主机侧 dsh-go bridge。候选首轮直接沿用 Companion 的 Tailscale HTTPS/WSS 与设备凭据，验证配对后打开既有聊天场景、流式回复、读写图片动态与重连。[v1.0.13](https://github.com/ccch1mneyyy/dsh-Go/releases/tag/v1.0.13) 内置 DSH `0.2.2-rc.1`，现有 Host 为 `0.2.1-rc.5`，在隔离环境验证双方协议后再决定引入范围。
- [上游源码许可证](https://github.com/ccch1mneyyy/dsh-Go/blob/main/LICENSE) 为 AGPL-3.0，SDK 和示例为 MIT。[素材清单](https://github.com/ccch1mneyyy/dsh-Go/blob/main/ASSETS.md) 单独列出名称、标识和两套吉祥物。衍生版使用自己的名称、图标和大肥鱼形象。

### 小家与社区建筑

- 参数化 Topdown 建筑工坊可用尺寸、楼层、屋顶、窗列和风格生成 2D 建筑，导出多方向 PNG、精灵表和 `recipe.json`。PNG 可带生成配方，后续能从配方重新渲染同一座建筑。 [项目说明](https://github.com/Zengkailin/parametric-topdown-pixel-architecture#三基本使用流程)
- 大肥鱼小家可先把建筑配方、图像和地基原点作为一套资产，再独立登记入口、床、桌椅和互动点。做社区时按同一视角和像素比例生成相邻建筑。Godot 版本可参考它的碰撞和遮挡多边形；Minecraft 营地继续用游戏方块、区域授权和真实施工回执。 [CLI 与 Godot 导出说明](https://github.com/Zengkailin/parametric-topdown-pixel-architecture#七命令行版给-ai-agent--自动化脚本)
