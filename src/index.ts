import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CompanionStore } from './core/store.ts'
import { DeviceService } from './host/devices.ts'
import { DeviceAvatarViewer } from './host/device-avatar-http.ts'
import { deviceActivity, deviceContextAllowed, registerDeviceHttp } from './host/device-http.ts'
import { EventHub } from './host/events.ts'
import { registerHttp } from './host/http.ts'
import { registerMemoryTools } from './host/memory-tools.ts'
import { registerChatCapabilities } from './host/chat-capabilities.ts'
import { registerFeedTools } from './host/feed-tools.ts'
import { CompanionRuntime } from './host/runtime.ts'
import { registerAvatarHttp } from './host/avatar-http.ts'
import { registerMinecraftChatPrompt } from './host/minecraft-chat-prompt.ts'
import { registerPersonaPrompt } from './host/persona-prompt.ts'
import { registerMinecraftHouseTool } from './host/minecraft-house-tool.ts'
import { isMinecraftRecoveryTool, registerMinecraftRecoveryTools } from './host/minecraft-recovery-tools.ts'
import { DAILY_AUTONOMY_CONTEXT, MINECRAFT_RECOVERY_CONTEXT } from './core/model.ts'
import { isDailyInitiativeTool, registerDailyInitiativeTools } from './host/daily-initiative-tools.ts'
import { registerAvatarTools } from './host/avatar-tools.ts'
import { registerBilibiliClipInput } from './host/bilibili-clip-input.ts'
import { registerBilibiliChoiceBudget, registerFeedReplyBudget } from './host/bilibili-choice-budget.ts'
import { RealtimePcmProvider, type RealtimePcmOptions } from './host/realtime-pcm.ts'
import { LocalAsrProvider } from './host/asr.ts'
import { AceStepSingingProvider } from './host/singing-provider.ts'
import { ApplioRvcCoverProvider, SeedVcCoverProvider } from './host/singing-cover.ts'
import { MlxDemucsSeparator } from './host/singing-separation.ts'
import { SoulXScoreProvider } from './host/singing-score.ts'
import { isCompanionDecisionContext } from './host/tool-policy.ts'

export const name = 'companion'
export const inject = ['agents', 'webServer', 'tools', 'sessionPersistence', 'sessions', 'agentDefaultModel', 'llm', 'systemPrompt']
export const Config = s.object({
  dataDir: s.string().default('').description('Companion data directory. Empty uses $DSH_HOME/companion.'),
  activityRetention: s.number().min(100).max(100_000).step(1).default(10_000).description('Maximum retained Companion activity rows.'),
  ttsProvider: s.string().default('gpt-sovits').description('Speech provider: gpt-sovits or legacy piper.'),
  ttsEndpoint: s.string().default('http://127.0.0.1:9881/').description('Loopback GPT-SoVITS API endpoint.'),
  ttsReferenceAudio: s.string().default('').description('Absolute path to the fixed whale reference WAV.'),
  ttsReferenceText: s.string().default('听好啦，这不是胡话，这是尾鳍拍碎镜子以后，每一块碎片都学会游泳的抽象报告。').description('Transcript of the fixed reference audio.'),
  ttsReferenceLanguage: s.string().default('zh').description('Language of the fixed reference audio.'),
  ttsPythonPath: s.string().default('').description('Legacy Piper virtualenv Python.'),
  ttsModelPath: s.string().default('').description('Legacy Piper ONNX model.'),
  ttsTimeoutMs: s.number().min(5000).max(60_000).step(1).default(60_000).description('Maximum milliseconds for one speech provider request.'),
  ttsExpressivePythonPath: s.string().default('').description('Optional MLX IndexTTS virtualenv Python.'),
  ttsExpressiveModelDir: s.string().default('').description('Optional private prepared MLX IndexTTS model and speaker directory.'),
  ttsExpressiveTimeoutMs: s.number().min(15_000).max(240_000).step(1).default(180_000).description('Maximum milliseconds per expressive clip.'),
  ttsStreamEndpoint: s.string().default('').description('Exact loopback HTTP PCM endpoint for live speech. Empty keeps WAV clips.'),
  ttsStreamProtocol: s.union(['openai', 'voxweft', 'gpt-sovits-v2']).default('openai').description('Request protocol for the live PCM endpoint.'),
  ttsStreamModel: s.string().default('').description('Fixed model ID for the OpenAI-compatible PCM endpoint.'),
  ttsStreamVoice: s.string().default('').description('Fixed clone voice ID for OpenAI-compatible and VoxWeft PCM endpoints.'),
  ttsStreamSampleRate: s.number().min(8000).max(48_000).step(1).description('Override PCM sample rate. Defaults to 24000 for OpenAI and 48000 for VoxWeft or GPT-SoVITS v5.'),
  ttsStreamTimeoutMs: s.number().min(1000).max(60_000).step(1).default(30_000).description('Maximum milliseconds for each PCM stream.'),
  asrEndpoint: s.string().default('').description('Exact loopback HTTP endpoint for WAV transcription. Empty disables device transcription.'),
  asrTimeoutMs: s.number().min(1000).max(60_000).step(1).default(15_000).description('Maximum milliseconds for a device recording upload and transcription.'),
  bilibiliFfmpegPath: s.string().default('').description('Absolute FFmpeg executable for Bilibili clip sampling. Empty uses ffmpeg on PATH.'),
  singingApiOrigin: s.string().default('').description('Local ACE-Step 1.5 HTTP origin, such as http://127.0.0.1:8001. Empty disables song generation.'),
  singingTimeoutMs: s.number().min(15_000).max(300_000).step(1).default(180_000).description('Maximum milliseconds for a song generation and download.'),
  singingCoverEngine: s.union(['seed-vc', 'applio-rvc']).default('seed-vc').description('Local converter for singing covers.'),
  seedVcPythonPath: s.string().default('').description('Absolute path to the prepared Seed-VC Python executable.'),
  seedVcRepoDir: s.string().default('').description('Absolute path to a prepared offline Seed-VC v1 checkout.'),
  seedVcReferenceAudio: s.string().default('').description('Absolute path to the authorized local reference WAV for singing covers.'),
  rvcPythonPath: s.string().default('').description('Absolute path to the prepared Applio Python executable.'),
  rvcApplioDir: s.string().default('').description('Absolute path to the offline Applio checkout with ContentVec and RMVPE.'),
  rvcModelPath: s.string().default('').description('Absolute path to the authorized local RVC .pth inference weight.'),
  rvcIndexPath: s.string().default('').description('Absolute path to the matching local RVC .index file.'),
  scorePythonPath: s.string().default('').description('Absolute path to the prepared SoulX-Singer Python executable.'),
  scoreSoulXDir: s.string().default('').description('Absolute path to the offline SoulX-Singer checkout.'),
  scoreModelPath: s.string().default('').description('Absolute path to the prepared SoulX-Singer model checkpoint.'),
  scorePromptAudio: s.string().default('').description('Absolute path to a permitted SoulX-Singer reference audio file.'),
  scorePromptMetadata: s.string().default('').description('Absolute path to metadata aligned with the SoulX-Singer reference.'),
  scoreDevice: s.union(['mps', 'cpu']).default('mps').description('Device for local SoulX-Singer inference.'),
  coverSeparatorPythonPath: s.string().default('').description('Absolute path to the prepared MLX Demucs Python executable.'),
  coverSeparatorCacheDir: s.string().default('').description('Absolute path to the prepared offline MLX Demucs model cache.'),
  coverSeparatorTimeoutMs: s.number().min(5_000).max(120_000).step(1).default(60_000).description('Maximum milliseconds for cover source separation.'),
  avatarDir: s.string().default('').description('Private Live2D model and official Core directory. Empty uses the Companion avatar directory.'),
  avatarDeviceViewer: s.boolean().default(false).description('Allow paired devices to privately view the Live2D model and read-only stage cues.'),
  minecraftServerRoot: s.string().default('').description('Absolute path to the private Coopcraft server directory.'),
  minecraftConsoleFifo: s.string().default('').description('Absolute path to the local Carpet console FIFO. Empty uses the existing Companion console.'),
  minecraftWorkerPort: s.number().min(1024).max(65_535).step(1).default(18789).description('Loopback HTTP port of the spawned Minecraft worker.'),
  minecraftGamePort: s.number().min(1).max(65_535).step(1).default(25565).description('Loopback port reported for the local Minecraft server.'),
  minecraftOwner: s.string().default('thyysummer').description('The owner player that the companion may follow. The bot is a separate Carpet fake player.'),
  minecraftWardrobeFile: s.string().default('').description('Optional absolute path to a private allowlist of YSM model choices for the companion.'),
  minecraftOvoRoot: s.string().default('').description('Optional absolute path to the local DeepseekOVO skill library for the account-backed worker.'),
  minecraftOffline: s.boolean().default(false).description('Local test servers only: use the dafeiyu offline identity with OVO on a loopback address. Never enable for Coopcraft.'),
})

type CompanionConfig = ReturnType<typeof Config>
const packageJson = createRequire(import.meta.url)('../package.json') as { version: string }

export function apply(ctx: Context, config: CompanionConfig): void {
  if (config.dataDir && !isAbsolute(config.dataDir)) throw new Error('Companion dataDir must be absolute or empty')
  if (config.ttsProvider !== 'piper' && config.ttsProvider !== 'gpt-sovits') throw new Error('Unsupported Companion TTS provider')
  for (const path of [config.ttsPythonPath, config.ttsModelPath, config.ttsReferenceAudio, config.ttsExpressivePythonPath, config.ttsExpressiveModelDir, config.avatarDir, config.minecraftServerRoot, config.minecraftConsoleFifo, config.bilibiliFfmpegPath, config.minecraftOvoRoot]) if (path && !isAbsolute(path)) throw new Error('Companion executable and asset paths must be absolute or empty')
  if (Boolean(config.ttsExpressivePythonPath) !== Boolean(config.ttsExpressiveModelDir)) throw new Error('Expressive TTS requires both Python and model paths')
  const dataDir = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'companion')
  const ttsDir = join(homedir(), '.local', 'share', 'companion', 'tts')
  const gsvDir = join(homedir(), '.local', 'share', 'companion', 'gsv')
  const referenceAudio = config.ttsReferenceAudio || join(gsvDir, 'voice', 'deepseek_ref_b_7s.wav')
  let realtimePcm: RealtimePcmProvider | undefined
  if (config.ttsStreamEndpoint) {
    const base = { endpoint: config.ttsStreamEndpoint, sampleRate: config.ttsStreamSampleRate, timeoutMs: config.ttsStreamTimeoutMs }
    const protocol = config.ttsStreamProtocol
    let options: RealtimePcmOptions
    if (protocol === 'gpt-sovits-v2') {
      options = { ...base, protocol, referenceAudio, referenceText: config.ttsReferenceText, referenceLanguage: config.ttsReferenceLanguage }
    } else if (protocol === 'voxweft') {
      options = { ...base, protocol, voice: config.ttsStreamVoice }
    } else {
      options = { ...base, protocol, model: config.ttsStreamModel, voice: config.ttsStreamVoice }
    }
    realtimePcm = new RealtimePcmProvider(options)
  }
  const asr = config.asrEndpoint ? new LocalAsrProvider(config.asrEndpoint, config.asrTimeoutMs) : undefined
  const singing = config.singingApiOrigin ? new AceStepSingingProvider(config.singingApiOrigin, config.singingTimeoutMs) : undefined
  const seedVcPaths = [config.seedVcPythonPath, config.seedVcRepoDir, config.seedVcReferenceAudio]
  if (seedVcPaths.some(Boolean) && !seedVcPaths.every(path => !!path && isAbsolute(path))) throw new Error('Configure all Seed-VC paths as absolute paths')
  const rvcPaths = [config.rvcPythonPath, config.rvcApplioDir, config.rvcModelPath, config.rvcIndexPath]
  if (config.singingCoverEngine === 'applio-rvc' && !rvcPaths.every(path => !!path && isAbsolute(path))) {
    throw new Error('Applio RVC requires absolute Python, checkout, model and index paths')
  }
  const coverOptions = { scratchRoot: join(dataDir, 'singing-temp'), timeoutMs: config.singingTimeoutMs }
  const cover = config.singingCoverEngine === 'applio-rvc'
    ? new ApplioRvcCoverProvider({ ...coverOptions, pythonPath: config.rvcPythonPath, repoDir: config.rvcApplioDir, modelPath: config.rvcModelPath, indexPath: config.rvcIndexPath })
    : config.seedVcPythonPath
      ? new SeedVcCoverProvider({ ...coverOptions, pythonPath: config.seedVcPythonPath, repoDir: config.seedVcRepoDir, referenceAudio: config.seedVcReferenceAudio })
      : undefined
  const separatorPaths = [config.coverSeparatorPythonPath, config.coverSeparatorCacheDir]
  if (separatorPaths.some(Boolean) && (!cover || !separatorPaths.every(path => !!path && isAbsolute(path)))) {
    throw new Error('Cover source separation requires a cover converter and both absolute separator paths')
  }
  const separator = config.coverSeparatorPythonPath ? new MlxDemucsSeparator({
    pythonPath: config.coverSeparatorPythonPath, cacheDir: config.coverSeparatorCacheDir,
    scratchRoot: join(dataDir, 'singing-temp'), timeoutMs: config.coverSeparatorTimeoutMs,
  }) : undefined
  const scorePaths = [config.scorePythonPath, config.scoreSoulXDir, config.scoreModelPath, config.scorePromptAudio, config.scorePromptMetadata]
  if (scorePaths.some(Boolean) && (!cover || !scorePaths.every(path => !!path && isAbsolute(path)))) {
    throw new Error('Score singing requires a cover converter and all five absolute SoulX-Singer paths')
  }
  const score = config.scorePythonPath ? new SoulXScoreProvider({
    ...coverOptions, pythonPath: config.scorePythonPath, repoDir: config.scoreSoulXDir, modelPath: config.scoreModelPath,
    promptAudio: config.scorePromptAudio, promptMetadata: config.scorePromptMetadata, device: config.scoreDevice,
  }) : undefined
  const store = new CompanionStore(join(dataDir, 'companion.db'), config.activityRetention)
  const runtime = new CompanionRuntime(ctx, store, packageJson.version, {
    provider: config.ttsProvider,
    pythonPath: config.ttsPythonPath || join(ttsDir, 'venv', 'bin', 'python'),
    modelPath: config.ttsModelPath || join(ttsDir, 'models', 'zh_CN-huayan-medium.onnx'),
    mediaDir: join(dataDir, 'media', 'voice'),
    timeoutMs: config.ttsTimeoutMs,
    expressive: config.ttsExpressivePythonPath ? {
      pythonPath: config.ttsExpressivePythonPath,
      modelDir: config.ttsExpressiveModelDir,
      timeoutMs: config.ttsExpressiveTimeoutMs,
    } : undefined,
    gpt: {
      endpoint: config.ttsEndpoint,
      referenceAudio,
      referenceText: config.ttsReferenceText,
      referenceLanguage: config.ttsReferenceLanguage,
      timeoutMs: config.ttsTimeoutMs,
    },
  }, join(dataDir, 'media'), dataDir, config.avatarDir || join(homedir(), '.local', 'share', 'companion', 'avatar'), config.minecraftServerRoot || join(homedir(), '工作', '会话', 'coopcraft', 'server'), config.minecraftOwner, realtimePcm, asr, singing, cover, separator, score, config.minecraftWardrobeFile, {
    workerPort: config.minecraftWorkerPort, gamePort: config.minecraftGamePort, consoleFifo: config.minecraftConsoleFifo, offline: config.minecraftOffline,
  }, config.bilibiliFfmpegPath || 'ffmpeg', config.minecraftOvoRoot)
  const devices = new DeviceService(ctx, store, id => runtime.devicePlayback.revoke(id))
  runtime.attachEvents(new EventHub(ctx, store))
  runtime.attachEvents(new EventHub(ctx, store, {
    path: '/companion-device/api/events',
    authorize: req => devices.authorize(req),
    onConnection: (socket, req) => devices.track(req, socket),
    contextAllowed: deviceContextAllowed,
    projectActivity: deviceActivity,
    homeLive: () => runtime.homeLive(),
  }))
  ctx.effect(() => ctx.tools.guard(({ agent, name }) => {
    const caller = agent ?? ctx.agents.currentInitiator()
    const binding = caller && store.bindingBySession(caller.id)
    const denied = runtime.worlds.denied(name, binding)
    if (denied) return denied
    if (isDailyInitiativeTool(name)) {
      if (agent && binding?.contextId === DAILY_AUTONOMY_CONTEXT && binding.kind === 'system') return
      return 'Daily initiative tools require a private daily session'
    }
    if (binding?.contextId === MINECRAFT_RECOVERY_CONTEXT && agent && isMinecraftRecoveryTool(name)) return
    if (binding && isCompanionDecisionContext(binding.contextId)) return 'Companion decision review cannot execute tools'
  }))
  ctx.effect(() => registerMinecraftRecoveryTools(ctx, runtime))
  ctx.effect(() => registerDailyInitiativeTools(ctx, runtime))
  runtime.start()
  const avatarViewer = config.avatarDeviceViewer ? new DeviceAvatarViewer(ctx, runtime.avatar, runtime.presenter, id => {
    const device = store.deviceById(id)
    return !!device && !device.revokedAt
  }) : undefined
  if (avatarViewer) ctx.effect(() => avatarViewer.register())
  ctx.effect(() => registerMemoryTools(ctx, store))
  ctx.effect(() => registerFeedTools(ctx, runtime))
  ctx.effect(() => registerPersonaPrompt(ctx, store))
  ctx.effect(() => registerMinecraftChatPrompt(ctx, store))
  ctx.effect(() => registerMinecraftHouseTool(ctx, runtime))
  ctx.effect(() => registerAvatarTools(ctx, runtime))
  ctx.effect(() => registerBilibiliClipInput(ctx, runtime))
  ctx.effect(() => registerBilibiliChoiceBudget(ctx, store))
  ctx.effect(() => registerFeedReplyBudget(ctx, store))
  ctx.effect(() => registerChatCapabilities(ctx, store, runtime.minecraft))
  ctx.effect(() => () => devices.close())
  ctx.effect(() => () => runtime.close())
  ctx.effect(() => registerHttp(ctx, runtime))
  ctx.effect(() => registerDeviceHttp(ctx, runtime, devices, avatarViewer))
  ctx.effect(() => registerAvatarHttp(ctx, runtime.avatar, runtime.realtimeVoice, () => runtime.homeActivity()))
  ctx.logger.info('Companion workbench ready at /companion/api/state')
}

export { CompanionStore } from './core/store.ts'
export { CompanionRuntime } from './host/runtime.ts'
export { DeviceService } from './host/devices.ts'
export * from './core/model.ts'
export * from './protocol/api.ts'
export * from './protocol/chat.ts'
export * from './protocol/events.ts'
export * from './protocol/bilibili.ts'
export * from './protocol/singing.ts'
export * from './protocol/worlds.ts'
