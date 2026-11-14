import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MINECRAFT_OWNER_MESSAGES, minecraftOwnerEventKey, minecraftOwnerEvents, type MinecraftOwnerEvent } from '../core/minecraft-chat.ts'
import { CAMP_GATHER_MAX_MS, CAMP_VISIT_GATHER_TASK_PREFIX, MinecraftCampGatherOffer, MinecraftCampGatherReceipt, MinecraftCampGatherRequest } from '../core/minecraft-gather.ts'
import { MinecraftHouseLayout, MinecraftHousePreview, MinecraftHouseReceipt, MinecraftHouseRecovery, MinecraftHouseRequest,
  minecraftHouseMaterials, minecraftHouseReceiptMatches, minecraftHouseRecoveryDecision,
  type MinecraftHouseDraft, type MinecraftHouseRevisionInput, type MinecraftHouseSitePreview, type MinecraftHousesView } from '../core/minecraft-house.ts'
import { MINECRAFT_HOUSE_CAPABILITY, MINECRAFT_HOUSE_EVENT, MINECRAFT_HOUSE_RECOVERY_EVENT,
  MINECRAFT_HOUSE_RECOVERY_PREFIX, minecraftHouseBuildSummary } from '../core/minecraft-house-repository.ts'
import { DAILY_HOUSE_PROJECT_TASK_PREFIX, HOUSE_PROJECT_SECTION_CAPABILITY, HOUSE_PROJECT_SUPPLY_CAPABILITY, HOUSE_PROJECT_SUPPLY_EVENT,
  HOUSE_PROJECT_VERIFY_CAPABILITY, HouseProjectPlan, HouseProjectPlanInput,
  MinecraftHouseProjectVerification, houseProjectCanRecover, houseProjectPlanMatches, minecraftHouseProjectRequests, type DailyHouseProjectOffer, type HouseProjectPlanObservation,
  type HouseProjectPlanObservationResult, type MinecraftHouseProjectInput, type MinecraftHouseProjectSitePreview,
  type MinecraftHouseProjectsView } from '../core/minecraft-house-project.ts'
import { planMinecraftHouseProjectImport, type MinecraftHouseProjectImportInput } from '../core/minecraft-house-project-import.ts'
import { MinecraftHouseSupplyPreview, MinecraftHouseSupplyReceipt, MinecraftHouseSupplyRecipe, MinecraftHouseSupplyRequest } from '../core/minecraft-house-supply.ts'
import { dailyHouseSupplyFact } from '../core/daily-house-project-proof.ts'
import { MinecraftOvoSmeltRequest, MinecraftOvoStorageRequest, MinecraftOvoSmeltReceipt, MinecraftOvoStorageReceipt, MINECRAFT_OVO_SMELT_RESULTS, minecraftOvoDimension } from '../core/minecraft-ovo.ts'
import { MINECRAFT_PLACE_CAPABILITY, MINECRAFT_PLACE_EVENT, MinecraftPlaceName, minecraftPlaceFact } from '../core/minecraft-place.ts'
import { MinecraftHouseCellCandidates, MinecraftHouseCellReceipt, MinecraftHouseCellRequest, minecraftHouseCandidatesMatch, minecraftHouseCellMatches,
  minecraftHouseCellTarget } from '../core/minecraft-house-cell.ts'
import { HOUSE_COMPLETION_TASK_PREFIX, HouseRecoveryCompletionResult, MinecraftHouseVerification,
  minecraftHouseVerificationMatches } from '../core/minecraft-house-verification.ts'
import { HOUSE_AGENT_RECOVERY_EVENT, HOUSE_AGENT_RECOVERY_PREFIX, HOUSE_CELL_ACTIVITY, HOUSE_CELL_AUDIT_ACTIVITY,
  HOUSE_CELL_AUDIT_PREFIX, HOUSE_CELL_CAPABILITY, HOUSE_CELL_TASK_PREFIX, HOUSE_RECOVERY_PLACEMENT_LIMITS, HOUSE_RECOVERY_TTL_MS,
  HouseRecoveryAgentDecision, HouseRecoveryPlacedCell, type HouseRecoveryObservation, type HouseRecoveryPlacementMode, type HouseRecoverySource } from '../core/minecraft-recovery.ts'
import { DAILY_AUTONOMY_CONTEXT, DAILY_VISIT_CONTEXT, MINECRAFT_RECOVERY_CONTEXT, MINECRAFT_SUPPLY_CONTEXT, type AutonomousJob, type GameLessonTarget, type TaskRecord } from '../core/model.ts'
import { CAMP_VISIT_BUILD_TASK_PREFIX, CAMP_VISIT_REVISIT_TASK_PREFIX, CAMP_VISIT_SUPPLY_TASK_PREFIX, CAMP_WOODS, MinecraftAuthorizedCampRequest, MinecraftSupplyRequest, MinecraftVisitBuildOffer, MinecraftVisitBuildReceipt, MinecraftVisitBuildRequest, MinecraftVisitRevisitReceipt, MinecraftVisitRevisitRequest, MinecraftVisitSupplyOffer, MinecraftVisitSupplyReceipt, minecraftCampOffer, minecraftPrepareOffer, minecraftSupplyOffer, type MinecraftCampOffer, type MinecraftPrepareOffer, type MinecraftSupplyOffer } from '../core/minecraft-supply.ts'
import { CAMP_PATROL_MAX_MS, CAMP_VISIT_PATROL_TASK_PREFIX, CAMP_VISIT_SURVEY_TASK_PREFIX, MinecraftPatrolSegmentReceipt, MinecraftPatrolSegmentRequest, MinecraftSurveyPreview, MinecraftSurveyPreviewRequest, MinecraftSurveyReceipt, MinecraftSurveyRequest, MinecraftTrailReceipt, SURVEY_DISTANCE, type MinecraftSurveyOffer, type SurveyDirection, type SurveyTrailId } from '../core/minecraft-survey.ts'
import type { CompanionStore } from '../core/store.ts'
import { MINECRAFT_CAMP_ACTIONS, type MinecraftCampControl, type MinecraftDeviceCampView, type MinecraftView } from '../protocol/api.ts'
import { MinecraftShieldReceipt, MinecraftShieldRequest } from '../protocol/minecraft-shield.ts'
import { MinecraftWardrobeConfigSchema, MinecraftWardrobeId, MinecraftWardrobeViewSchema, type MinecraftWardrobeView } from '../protocol/minecraft-wardrobe.ts'
import type { SessionService } from './session.ts'
import { DeviceAuthError } from './devices.ts'
import { minecraftMoment, type MinecraftMoment } from './minecraft-moments.ts'
import type { WorldHealth } from '../protocol/worlds.ts'

export type { MinecraftCampOffer, MinecraftPrepareOffer, MinecraftSupplyOffer } from '../core/minecraft-supply.ts'

const HOME_PRESENCE_LEASE_MS = 5000
const CAMP_VISIT_MAX_MS = 5 * 60_000
const HOUSE_PREVIEW_TTL_MS = 2 * 60_000
const HOUSE_PROJECT_PLAN_SWEEP_MS = 90_000
const HOUSE_RECOVERY_PROBE_MS = 25_000
const HOUSE_RECOVERY_VERIFY_MS = 45_000
const HOUSE_CELL_NAMES = { oak_planks: '橡木木板', spruce_planks: '云杉木板', cobblestone: '圆石', glass: '玻璃' } as const
const CampVisitId = z.uuid()
const CampVisitStarted = z.strictObject({ visitId: CampVisitId, online: z.literal(true), atCamp: z.literal(true) })
const CampVisitEnded = z.strictObject({ visitId: CampVisitId, online: z.literal(false), confirmed: z.literal(true) })

type HouseRun = { zoneId: string; controller: AbortController; settled: Promise<void>; dailyTask?: string; dailyAction?: 'house-build' | 'house-supply' }
type DailyHouseProjectLease = { dailyTaskId: string; onStarted: (task: TaskRecord) => void }
type DailyHouseProjectOfferSource = { projectId: string; zoneId: string; section: number; recovery: boolean;
  supply?: DailyHouseProjectOffer['supply']; epoch: number; generation: number; expiresAt: number }

const CAMP_VISIT_ACTIONS = {
  survey: { prefix: CAMP_VISIT_SURVEY_TASK_PREFIX, title: '营地往返勘察' },
  supply: { prefix: CAMP_VISIT_SUPPLY_TASK_PREFIX, title: '营地短访补给',
    event: 'world.visit-supply', summary: '短访补给已取得真实原木和木板回读' },
  build: { prefix: CAMP_VISIT_BUILD_TASK_PREFIX, title: '营地短访建造',
    event: 'world.visit-build', summary: '短访建造已取得真实方块和背包回读' },
  revisit: { prefix: CAMP_VISIT_REVISIT_TASK_PREFIX, title: '营地短访复查',
    event: 'world.visit-revisit', summary: '短访复查已取得九处营地方块回读' },
  patrol: { prefix: CAMP_VISIT_PATROL_TASK_PREFIX, title: '营地巡视路段',
    event: 'world.patrol-segment', summary: '巡视路段已取得实际回营回执' },
  gather: { prefix: CAMP_VISIT_GATHER_TASK_PREFIX, title: '营地短访采集',
    event: 'world.visit-gather', summary: '短访采集已取得原木入包和实际回营回执' },
} as const

export interface MinecraftTransportOptions {
  workerPort?: number
  gamePort?: number
  consoleFifo?: string
  offline?: boolean
  voiceDir?: string
}

interface MinecraftOptions extends MinecraftTransportOptions {
  dataDir: string
  serverRoot: string
  owner: string
  wardrobeFile?: string
  ovoRoot?: string
}

function readWardrobe(path: string) {
  if (!isAbsolute(path)) return
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size < 2 || stat.size > 16_384) return
      const bytes = Buffer.alloc(stat.size)
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fstatSync(fd).size !== stat.size) return
      const parsed = MinecraftWardrobeConfigSchema.safeParse(JSON.parse(bytes.toString('utf8')))
      return parsed.success ? parsed.data : undefined
    } finally { closeSync(fd) }
  } catch { return }
}

type AuthorizedAction =
  | { path: '/supply' | '/camp-supply'; input: ReturnType<typeof MinecraftSupplyRequest.parse> }
  | { path: '/camp/visit/supply'; input: ReturnType<typeof MinecraftSupplyRequest.parse>; visitId: string }
  | { path: '/camp/visit/build'; input: ReturnType<typeof MinecraftVisitBuildRequest.parse>; visitId: string }
  | { path: '/camp/visit/revisit'; input: ReturnType<typeof MinecraftVisitRevisitRequest.parse>; visitId: string }
  | { path: '/camp/visit/patrol-segment'; input: ReturnType<typeof MinecraftPatrolSegmentRequest.parse>; visitId: string }
  | { path: '/camp/visit/gather'; input: MinecraftCampGatherRequest; visitId: string }
  | { path: '/build-authorized'; input: ReturnType<typeof MinecraftAuthorizedCampRequest.parse> }
  | { path: '/survey'; input: ReturnType<typeof MinecraftSurveyRequest.parse>; visitId?: string }
  | { path: '/camp/pause'; input: Record<string, never> }
  | { path: '/storage'; input: ReturnType<typeof MinecraftOvoStorageRequest.parse> }
  | { path: '/smelt'; input: ReturnType<typeof MinecraftOvoSmeltRequest.parse> }

interface AuthorizedPreparationOptions {
  signal: AbortSignal
  checkPermit: () => void
  onStep: (step: { action: 'craft' | 'build'; taskId: string }) => void
}

const ChatDelivery = z.object({ delivery: z.enum(['private', 'sent']) })

function inventoryCount(observation: Record<string, unknown>, name: string): number {
  const inventory = Array.isArray(observation.inventory) ? observation.inventory as { name: string; count: number }[] : []
  return inventory.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
}

function gameActionFact(kind: string, result: any): string {
  if (kind === 'sleep') return '使用了床，服务端确认实际入睡'
  if (kind === 'place-bed') return '用背包中的床完成了放置，服务端确认床头坐标'
  if (kind === 'night-cover') return result?.status === 'covered' ? '挖三填一进入了临时掩体，服务端确认泥土封顶'
    : '在天亮后打开临时掩体，用回收的垫脚材料回到地表'
  if (kind === 'storage') return `在授权区${result?.operation === 'deposit' ? '存入' : '取出'} ${result?.count} 个 ${result?.itemName}，背包与箱内数量已双向核对`
  if (kind === 'smelt' && result?.phase === 'start') return `在授权区向熔炉投入 ${result?.count} 个 ${result?.itemName}，已核对扣料，等待后续取出成品`
  if (kind === 'smelt') return `在授权区从同一熔炉取出 ${result?.count} 个 ${result?.output}，已核对实际背包增量`
  return kind === 'follow' ? '开始跟随主人' : kind === 'move' ? '完成了一次受控移动'
    : kind === 'return' ? '完成了一次经过出口与材料回读的受限垫脚回程' : kind === 'craft' ? '完成了一次经过真实配方与背包回读的生存合成'
    : kind === 'shield' ? '举起盾牌，服务端确认进入格挡并在结束时放下' : kind === 'build' ? '在主人授权区域内完成了一次经过逐块回读的营地建造' : '完成了一次经过验证的自然原木采集'
}

function campStopStatus(result: unknown): 'confirmed' | 'offline' | undefined {
  if (!result || typeof result !== 'object' || !('stopped' in result) || result.stopped !== true) return
  if ('online' in result && result.online === false) return 'offline'
  if ('displacement' in result && typeof result.displacement === 'number' &&
    result.displacement >= 0 && result.displacement <= 0.3) return 'confirmed'
}

export class MinecraftService {
  private child?: ChildProcess
  private restartTimer?: ReturnType<typeof setTimeout>
  private token?: string
  private ready = false
  private starting?: Promise<boolean>
  private closing = false
  private cursor = 0
  private workerEventSource = randomUUID()
  private refreshing?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private lastError?: string
  private lastRespawnDeath?: number
  private recentEvents: Record<string, unknown>[] = []
  private followTaskId?: string
  private currentBuildZoneId?: string
  private readonly housePreviews = new Map<string, { id: string; zoneId: string; epoch: number; revision: number; expiresAt: number }>()
  private readonly houseProjectPreviews = new Map<string, { id: string; epoch: number; expiresAt: number; recovery: boolean }>()
  private readonly houseProjectPlanObservations = new WeakMap<HouseProjectPlanObservation, { id: string; epoch: number; generation: number }>()
  private readonly dailyHouseProjectOffers = new WeakMap<DailyHouseProjectOffer, DailyHouseProjectOfferSource>()
  private houseProjectPlanGeneration = 0
  private houseRun?: HouseRun
  private creativeForBuild = false
  private recoveredHouses = false
  private learningDirty = true
  private syncingLessons?: Promise<void>
  private homeActiveAt?: number
  private worldObservation?: { at: number; status: WorldHealth }
  private homeActiveKind?: string
  private surveyReadyAt?: number
  private campVisitReadyAt?: number
  private visitActionPermit?: { id: string; zoneId: string; expiresAt: number; confirmed: boolean; allowSupply?: true; allowBuild?: true; allowRevisit?: true; patrol?: true; gather?: true; projectGather?: true }
  private homePresenceGeneration = 0
  private campEpoch = 0
  private campPause?: Promise<MinecraftDeviceCampView>
  private campResume?: Promise<MinecraftCampControl>
  private wardrobeModels?: ReturnType<typeof readWardrobe>
  private lastWardrobeReceipt?: string
  private readonly workerPath: string
  private readonly workerRoot: string
  private readonly workerPort: number
  private readonly workerApi: string
  private readonly dataDir: string

  constructor(
    private readonly store: CompanionStore,
    private readonly sessions: SessionService,
    private readonly options: MinecraftOptions,
    private readonly onEvent?: (event: MinecraftOwnerEvent) => AutonomousJob | undefined,
    private readonly onMoment?: (moment: MinecraftMoment) => void,
    private readonly onSupplyStop?: (zoneId?: string, explicit?: boolean) => void,
    private readonly onCampPause?: () => void,
    private readonly canReceiveChat?: () => boolean,
    private readonly onPrivateReply?: (taskId: string, text: string, stillAllowed: () => boolean) => void,
  ) {
    this.workerRoot = join(homedir(), '.local', 'share', 'companion', 'minecraft-worker')
    this.workerPath = join(dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json')), 'lib', 'minecraft-worker.js')
    this.workerPort = options.workerPort ?? 18789
    this.workerApi = `http://127.0.0.1:${this.workerPort}/api`
    this.dataDir = join(options.dataDir, 'minecraft')
  }

  private reconcileHouseRuns(): void {
    if (this.recoveredHouses) return
    this.store.transaction(() => {
      for (const { id, attempt_task_id: taskId } of this.store.minecraftHouses.running()) {
        if (this.store.taskById(taskId)?.status === 'running') this.store.transitionTask(taskId, 'cancelled', 'house-result-unconfirmed-after-restart')
        this.store.minecraftHouses.finish(id, taskId)
      }
      for (const { project_id, section_index, task_id } of this.store.minecraftHouseProjects.running()) {
        const reason = 'house-result-unconfirmed-after-restart'
        if (this.store.taskById(task_id)?.status === 'running') this.store.transitionTask(task_id, 'cancelled', reason)
        this.store.minecraftHouseProjects.finish(project_id, section_index, task_id, { reason })
      }
      for (const task of this.store.runningTasksByCapability(HOUSE_PROJECT_VERIFY_CAPABILITY)) {
        this.store.transitionTask(task.id, 'cancelled', 'minecraft-house-project-verification-unconfirmed')
      }
      for (const task of this.store.runningTasksByCapability(HOUSE_PROJECT_SUPPLY_CAPABILITY)) {
        this.store.transitionTask(task.id, 'cancelled', 'minecraft-house-project-supply-unconfirmed-after-restart')
      }
      for (const task of this.store.runningTasksByCapability(HOUSE_CELL_CAPABILITY)) {
        this.store.transitionTask(task.id, 'cancelled', 'minecraft-house-cell-unconfirmed-after-restart')
      }
      this.store.minecraftHouses.markStartedRecoveryCellsUnconfirmed()
    })
    this.recoveredHouses = true
  }

  start(): void {
    if (this.closing || this.child) return
    this.reconcileHouseRuns()
    for (const task of this.store.runningTasksByCapability('minecraft.shield')) {
      this.store.transitionTask(task.id, 'cancelled', 'shield-result-unconfirmed-after-restart')
    }
    for (const kind of ['sleep', 'place-bed', 'night-cover']) {
      for (const task of this.store.runningTasksByCapability(`minecraft.${kind}`)) {
        this.store.transitionTask(task.id, 'cancelled', 'night-action-unconfirmed-after-restart')
      }
    }
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const tokenPath = join(this.dataDir, 'worker.token')
    if (existsSync(tokenPath)) {
      this.token = readFileSync(tokenPath, 'utf8').trim()
      chmodSync(tokenPath, 0o600)
    } else {
      this.token = randomBytes(32).toString('base64url')
      writeFileSync(tokenPath, this.token, { mode: 0o600, flag: 'wx' })
    }
    this.wardrobeModels = this.options.wardrobeFile ? readWardrobe(this.options.wardrobeFile) : undefined
    const child = spawn(process.execPath, [this.workerPath], {
      cwd: existsSync(this.workerRoot) ? this.workerRoot : dirname(this.workerPath),
      env: {
        HOME: homedir(), PATH: '/usr/local/bin:/usr/bin:/bin',
        NODE_PATH: join(this.workerRoot, 'node_modules'),
        COMPANION_MC_DATA_DIR: this.dataDir,
        COMPANION_MC_TOKEN_FILE: tokenPath,
        COMPANION_MC_API_PORT: String(this.workerPort),
        COMPANION_MC_GAME_HOST: '127.0.0.1',
        COMPANION_MC_GAME_PORT: String(this.options.gamePort ?? 25565),
        COMPANION_MC_SERVER_ROOT: this.options.serverRoot,
        COMPANION_MC_OWNER: this.options.owner,
        COMPANION_MC_AUTH_MODE: this.options.ovoRoot ? this.options.offline ? 'offline' : 'mineflayer' : 'cbi',
        COMPANION_MC_BOT_NAME: 'dafeiyu',
        COMPANION_MC_FIFO: this.options.consoleFifo || join(homedir(), '.local', 'share', 'companion', 'minecraft', 'console.in'),
        COMPANION_MC_OVO_ROOT: this.options.ovoRoot ?? '',
        ...(this.campControl().pausedAt && { COMPANION_MC_CAMP_PAUSED: '1' }),
        ...(this.wardrobeModels && { COMPANION_MC_YSM_MODELS: JSON.stringify(this.wardrobeModels) }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.child = child
    this.cursor = 0
    this.workerEventSource = randomUUID()
    child.stderr.on('data', chunk => { this.lastError = String(chunk).replace(/[A-Za-z0-9_-]{80,}/g, '[redacted]').slice(-240) })
    child.once('error', error => { this.lastError = error.message })
    child.once('exit', code => {
      if (this.child === child) this.child = undefined
      this.ready = false
      this.houseProjectPlanGeneration++
      this.worldObservation = undefined
      this.homeActiveAt = undefined
      this.surveyReadyAt = undefined
      this.campVisitReadyAt = undefined
      this.visitActionPermit = undefined
      if (!this.closing) {
        this.cancelSupply()
        this.endFollow('Minecraft worker 已停止')
        this.lastError ??= `Minecraft worker 退出（${code ?? 'unknown'}）`
        this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'worker.stopped', summary: this.lastError, status: 'error' })
        this.restartTimer = setTimeout(() => { this.start() }, 3000)
      }
    })
    this.starting = this.waitReady()
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.refreshEvents() }, 1000)
    this.store.updateCapability('game.minecraft', 'planned', 'Carpet＋CBI 就绪，等待生成 dafeiyu')
  }

  private async waitReady(): Promise<boolean> {
    for (let index = 0; index < 80; index++) {
      if (this.closing) return false
      try {
        const response = await fetch(this.workerApi, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          this.ready = true
          this.lastError = undefined
          return true
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    this.lastError ??= 'Minecraft worker 未能启动'
    return false
  }

  private async request(path: string, method = 'GET', input?: unknown, signal?: AbortSignal, campEpoch?: number, visitId?: string): Promise<any> {
    if (this.closing) throw new Error('Minecraft worker 正在停止')
    if (!this.ready && !(await this.starting)) throw new Error(this.lastError ?? 'Minecraft worker 尚未就绪')
    if (campEpoch !== undefined) this.assertCampOpen(campEpoch)
    const building = path === '/build' || path === '/build-authorized' || path === '/camp/visit/build'
    const timeout = AbortSignal.timeout(path === '/dig' || path === '/camp/visit/gather' ? 100_000
      : path === '/house/build' || path === '/house/recover' ? 450_000
        : path === '/return' || path === '/night-cover' ? 120_000 : path === '/shield' ? 18_000 : building ? 90_000 : 60_000)
    const response = await fetch(`${this.workerApi}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(input === undefined ? {} : { 'content-type': 'application/json' }),
        ...(visitId === undefined ? {} : { 'x-companion-camp-visit': CampVisitId.parse(visitId) }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const value = await response.json()
    if (!response.ok) throw new DeviceAuthError(response.status, value.error ?? 'minecraft-request-failed')
    return value
  }

  private assertCampOpen(epoch = this.campEpoch): void {
    if (epoch !== this.campEpoch || this.campControl().pausedAt) throw new DeviceAuthError(409, 'minecraft-camp-paused')
  }

  private async campRequest(path: string, input: unknown, epoch: number, signal?: AbortSignal, visitId?: string): Promise<any> {
    this.assertCampOpen(epoch)
    const value = await this.request(path, 'POST', input, signal, epoch, visitId)
    this.assertCampOpen(epoch)
    return value
  }

  get wardrobeConfigured(): boolean { return !!this.options.wardrobeFile }

  async wardrobe(signal?: AbortSignal): Promise<MinecraftWardrobeView> {
    signal?.throwIfAborted()
    const options = this.wardrobeModels?.map(({ id, label }) => ({ id, label })) ?? []
    if (options.length && this.ready) {
      try {
        const parsed = MinecraftWardrobeViewSchema.safeParse(await this.request('/wardrobe', 'GET', undefined, signal))
        if (parsed.success) {
          const { available, last } = parsed.data
          return { available: available && !this.campControl().pausedAt, options,
            ...(last && options.some(option => option.id === last.id) && { last }) }
        }
      } catch {
        signal?.throwIfAborted()
        // Older workers or unsupported servers keep the local choices visible.
      }
    }
    return { available: false, options }
  }

  async changeAppearance(id: string, signal?: AbortSignal): Promise<MinecraftWardrobeView> {
    const epoch = this.campEpoch
    this.assertCampOpen(epoch)
    if (!this.wardrobeModels?.length) throw new DeviceAuthError(409, 'minecraft-wardrobe-unavailable')
    const model = MinecraftWardrobeId.safeParse(id).success && this.wardrobeModels.find(option => option.id === id)
    if (!model) throw new DeviceAuthError(404, 'minecraft-wardrobe-option-not-found')
    const parsed = MinecraftWardrobeViewSchema.safeParse(await this.campRequest('/wardrobe', { id }, epoch, signal))
    const last = parsed.success ? parsed.data.last : undefined
    if (!parsed.success || !last || last.id !== id || !parsed.data.available) throw new DeviceAuthError(502, 'minecraft-wardrobe-unconfirmed')
    const receipt = `${id}:${last.confirmedAt}`
    if (this.lastWardrobeReceipt !== receipt) {
      const sessionId = this.store.bindingByContext('game.minecraft')?.sessionId
      const summary = `游戏服务端已接受「${model.label}」外观设置`
      this.store.transaction(() => {
        const task = this.store.createTask({ contextId: 'game.minecraft', sessionId, capabilityId: 'minecraft.appearance', title: `Minecraft：${model.label}` })
        this.store.transitionTask(task.id, 'running')
        this.store.transitionTask(task.id, 'succeeded')
        this.store.recordActivity({ contextId: 'game.minecraft', sessionId, taskId: task.id, source: 'game.minecraft', kind: 'wardrobe.accepted',
          status: 'success', summary, data: { appearanceId: id, confirmedAt: last.confirmedAt } })
        this.store.memory.create({ kind: 'experience', scope: 'shared', contextId: 'game.minecraft', status: 'active',
          content: `在 Coopcraft 中，${summary}。`, importance: 0.35, confidence: 1, actorSessionId: sessionId,
          sourceRefs: [{ contextId: 'game.minecraft', sessionId, taskId: task.id }], reason: 'minecraft-appearance-accepted' })
      })
      this.lastWardrobeReceipt = receipt
    }
    return { available: true, options: this.wardrobeModels.map(({ id, label }) => ({ id, label })), last }
  }

  campControl(): MinecraftCampControl {
    const control = this.store.minecraftCampControl()
    return control.stopStatus === 'pending' && !this.campPause
      ? { ...control, stopStatus: 'unconfirmed' }
      : control
  }

  setPairedCampPause(enabled: boolean): MinecraftCampControl {
    const previous = this.campControl()
    if (previous.pairedPauseEnabled === enabled) return previous
    const control = { ...previous, pairedPauseEnabled: enabled }
    this.store.transaction(() => {
      this.store.saveMinecraftCampControl(control)
      this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'camp.paired-pause-changed',
        summary: enabled ? '主人允许配对手机暂停 Minecraft' : '主人撤回了配对手机暂停权限' })
    })
    return control
  }

  async resumeCamp(): Promise<MinecraftCampControl> {
    if (this.campPause) throw new DeviceAuthError(409, 'minecraft-camp-pause-busy')
    if (this.campResume) return this.campResume
    const previous = this.campControl()
    if (!previous.pausedAt) return previous
    this.campResume = this.finishCampResume().finally(() => { this.campResume = undefined })
    return this.campResume
  }

  private async finishCampResume(): Promise<MinecraftCampControl> {
    if (!this.ready && this.starting) await this.starting
    if (this.closing || this.child && !this.ready) throw new DeviceAuthError(502, 'minecraft-camp-resume-unconfirmed')
    if (this.ready) {
      try {
        const result = await this.request('/camp/resume', 'POST', {}, AbortSignal.timeout(2500))
        if (result?.resumed !== true) throw new Error('Unexpected resume receipt')
      } catch { throw new DeviceAuthError(502, 'minecraft-camp-resume-unconfirmed') }
    }
    if (this.closing) throw new DeviceAuthError(502, 'minecraft-camp-resume-unconfirmed')
    const control = { pairedPauseEnabled: this.campControl().pairedPauseEnabled }
    this.store.transaction(() => {
      this.store.saveMinecraftCampControl(control)
      this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'camp.resumed', summary: '主人在本机解除 Minecraft 暂停' })
    })
    return control
  }

  async campView(): Promise<MinecraftDeviceCampView> {
    let connection: MinecraftDeviceCampView['connection'] = 'unavailable'
    let action: MinecraftDeviceCampView['action']
    let shieldHold = false
    if (this.ready && !this.closing) {
      try {
        const worker = await this.request('', 'GET', undefined, AbortSignal.timeout(2500))
        if (worker?.auth?.mode === 'cbi' && typeof worker.online === 'boolean' && worker.connecting !== true) {
          connection = worker.online ? 'online' : 'offline'
          shieldHold = worker.online && worker.action === 'shield'
          if (worker.online) action = worker.action === 'supply' ? 'craft' : ['build-authorized', 'house-build', 'house-cell'].includes(worker.action) ? 'build'
            : MINECRAFT_CAMP_ACTIONS.find(value => value === worker.action)
        }
      } catch { /* A status check is not a stop receipt. */ }
    }
    return { version: 1, connection, ...(action && { action }), ...(shieldHold && { shieldHold: true }), observedAt: new Date().toISOString(), control: this.campControl() }
  }

  async pauseCamp(): Promise<MinecraftDeviceCampView> {
    const previous = this.campControl()
    if (!previous.pairedPauseEnabled) throw new DeviceAuthError(403, 'minecraft-camp-pause-disabled')
    if (this.campPause) return this.campPause
    if (this.campResume) throw new DeviceAuthError(409, 'minecraft-camp-pause-busy')
    const pausedAt = previous.pausedAt ?? new Date().toISOString()
    this.store.transaction(() => {
      this.store.saveMinecraftCampControl({ pairedPauseEnabled: true, pausedAt, stopStatus: 'pending' })
      if (!previous.pausedAt) this.store.recordActivity({
        contextId: 'game.minecraft', source: 'game.minecraft', kind: 'camp.paused', summary: '配对手机暂停了新的 Minecraft 动作',
      })
    })
    this.campEpoch++
    this.visitActionPermit = undefined
    this.campPause = Promise.resolve().then(() => this.finishCampPause(pausedAt)).finally(() => { this.campPause = undefined })
    try { this.onCampPause?.() } catch {}
    return this.campPause
  }

  private async finishCampPause(pausedAt: string): Promise<MinecraftDeviceCampView> {
    let status: NonNullable<MinecraftCampControl['stopStatus']> = 'unconfirmed'
    try {
      const { result } = await this.stop(true, true)
      status = campStopStatus(result) ?? 'unconfirmed'
    } catch { /* Keep the durable admission hold when worker stop is unconfirmed. */ }
    const stopAt = new Date().toISOString()
    this.store.transaction(() => {
      const control = this.campControl()
      this.store.saveMinecraftCampControl({ ...control, pausedAt, stopStatus: status, stopAt })
      this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'camp.stop-receipt',
        summary: status === 'confirmed' ? 'Minecraft Worker 确认已停稳' : status === 'offline' ? 'Minecraft Worker 确认角色离线' : 'Minecraft 动作已暂停，Worker 停止未确认',
        status: status === 'unconfirmed' ? 'warning' : 'success', data: { outcome: status } })
    })
    return this.campView()
  }

  private targetOf(value: unknown): GameLessonTarget | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const input = value as Record<string, unknown>
    const x = Number(input.x), y = Number(input.y), z = Number(input.z)
    if (![x, y, z].every(Number.isSafeInteger)) return undefined
    return { x, y, z, ...(typeof input.block === 'string' && /^[a-z_]+$/u.test(input.block) ? { block: input.block } : {}) }
  }

  private learnFailure(action: string, error: unknown, target?: GameLessonTarget, sourceRefs: { contextId: string; sessionId?: string; taskId?: string; eventSeq?: number }[] = []): void {
    const errorCode = error instanceof Error ? error.message : String(error)
    this.store.gameLearning.recordFailure({ action, errorCode, target, sourceRefs })
    this.learningDirty = true
  }

  private learnSuccess(action: string, target?: GameLessonTarget, sourceRefs: { contextId: string; sessionId?: string; taskId?: string }[] = []): void {
    this.store.gameLearning.recordSuccess({ action, target, sourceRefs })
    this.learningDirty = true
  }

  private async syncLessons(): Promise<void> {
    if (!this.learningDirty || this.syncingLessons) return
    this.syncingLessons = (async () => {
      const targets = this.store.gameLearning.avoidTargets('dig')
      await this.request('/lessons', 'PUT', targets)
      this.learningDirty = false
    })().catch((error: unknown) => {
      this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.learning', kind: 'learning.sync-failed', summary: '经验同步失败，已降级为普通动作流程', status: 'warning', data: { message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) } })
    }).finally(() => { this.syncingLessons = undefined })
    return this.syncingLessons
  }

  async view(): Promise<Record<string, unknown>> {
    await this.refreshEvents()
    let worker: Record<string, unknown> = { online: false, lastError: this.lastError }
    let workerOnline = false
    if (this.ready) {
      try {
        worker = await this.request('')
        workerOnline = true
        if (worker.online) worker = { ...worker, observation: await this.observe() }
      } catch (error) {
        worker = { ...worker, observation: undefined, lastError: error instanceof Error ? error.message : String(error) }
      }
    }
    const pendingSupply = this.store.autonomy.pending('minecraft.supply', MINECRAFT_SUPPLY_CONTEXT)
    const jobs = this.store.autonomy.list().filter(job =>
      (job.kind === 'minecraft.event' || job.kind === 'minecraft.supply') && job.id !== pendingSupply?.id)
    if (pendingSupply) jobs.unshift(pendingSupply)
    return {
      ...worker,
      workerOnline,
      campControl: this.campControl(),
      ...(this.wardrobeConfigured && { wardrobe: await this.wardrobe() }),
      server: { host: '127.0.0.1', port: this.options.gamePort ?? 25565, version: '1.21.1', onlineMode: true },
      recentEvents: this.recentEvents.slice(-12),
      tasks: this.store.tasks().filter(task => task.capabilityId.startsWith('minecraft.')).slice(0, 20),
      jobs: jobs.slice(0, 10),
      lessons: this.store.gameLearning.list({ limit: 12 }),
      buildZones: this.store.buildZones(),
    }
  }

  observe(): Promise<Record<string, unknown>> {
    return this.request('/observe')
  }

  worldHealth(now = Date.now()): WorldHealth {
    if (this.closing || !this.ready) return 'unavailable'
    if (this.campControl().pausedAt) return 'paused'
    const observation = this.worldObservation
    if (!observation || now < observation.at || now - observation.at >= HOME_PRESENCE_LEASE_MS) return 'unavailable'
    return observation.status
  }

  homeActive(now: number, ignoreRecoveryPlacement = false, ignoreHouseProjectTaskId?: string): boolean {
    return this.ready && !this.closing && this.homeActiveAt !== undefined &&
      !(ignoreRecoveryPlacement && this.homeActiveKind === 'house-cell') &&
      !(ignoreHouseProjectTaskId && this.houseRun?.dailyTask === ignoreHouseProjectTaskId &&
        this.homeActiveKind === this.houseRun.dailyAction) &&
      now >= this.homeActiveAt && now - this.homeActiveAt < HOME_PRESENCE_LEASE_MS
  }

  surveyWindowReady(now: number): boolean {
    return this.ready && !this.closing && this.surveyReadyAt !== undefined &&
      now >= this.surveyReadyAt && now - this.surveyReadyAt < HOME_PRESENCE_LEASE_MS && !this.worldBusy()
  }

  campVisitReady(now: number): boolean {
    return this.ready && !this.closing && this.campVisitReadyAt !== undefined &&
      now >= this.campVisitReadyAt && now - this.campVisitReadyAt < HOME_PRESENCE_LEASE_MS && !this.worldBusy()
  }

  private clearCampVisitReady(): void {
    this.homePresenceGeneration++
    this.campVisitReadyAt = undefined
  }

  private async refreshEvents(): Promise<void> {
    if (!this.ready || this.closing || this.refreshing) return
    const worker = this.child
    const generation = this.homePresenceGeneration
    const observedAt = Date.now()
    const isCurrent = () => this.ready && !this.closing && this.child === worker && this.homePresenceGeneration === generation
    const sourceId = this.workerEventSource
    this.refreshing = (async () => {
      const chatRelay = this.canReceiveChat?.() === true && !this.campControl().pausedAt
      const value = await this.request(`/events?after=${this.cursor}${chatRelay ? '&chatRelay=1' : ''}`)
      if (!isCurrent()) return
      for (const event of value.items as { seq: number; kind: string; username?: string; message?: string; delivery?: string; action?: string; error?: string; target?: GameLessonTarget; position?: unknown; oxygen?: unknown }[]) {
        this.cursor = Math.max(this.cursor, event.seq)
        const privateChat = event.delivery === 'private'
        this.recentEvents.push(privateChat ? { ...event, message: undefined } : event)
        if (this.recentEvents.length > 40) this.recentEvents.shift()
        if (event.kind === 'connection.online') {
          void this.ensureGameSession()
          this.store.updateCapability('game.minecraft', 'ready', 'dafeiyu 已通过 Carpet＋CBI 进入真实 Coopcraft')
        }
        if (event.kind === 'connection.offline') {
          this.cancelSupply()
          this.store.updateCapability('game.minecraft', 'planned', 'Minecraft 已离线')
          this.endFollow('Minecraft 已离线')
        }
        if (event.kind === 'follow.ended') this.endFollow('跟随目标已离线')
        if (event.kind === 'chat.received' && event.username?.toLowerCase() === this.options.owner.toLowerCase() && event.message) {
          this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'world.chat', summary: privateChat ? '收到一条 Minecraft 私聊' : event.message.slice(0, 240), data: { seq: event.seq, ...(privateChat ? { delivery: 'private' } : {}) } })
          if (!this.campControl().pausedAt) this.onEvent?.({ seq: event.seq, sourceId, username: this.options.owner, message: event.message })
        }
        if (event.kind === 'action.failed' && event.action && event.error !== 'minecraft-camp-paused') {
          const binding = this.store.bindingByContext('game.minecraft')
          this.learnFailure(event.action, event.error ?? 'unknown', this.targetOf(event.target), [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, eventSeq: event.seq }])
        }
        if (event.kind === 'world.alert') this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'world.alert', summary: String(event.message ?? '').slice(0, 240), status: 'warning', data: { seq: event.seq } })
        if (event.kind === 'player.death') {
          const position = this.targetOf(event.position && typeof event.position === 'object'
            ? Object.fromEntries(Object.entries(event.position).map(([key, value]) => [key, Math.floor(Number(value))])) : undefined)
          const oxygen = typeof event.oxygen === 'number' && Number.isFinite(event.oxygen) ? event.oxygen : undefined
          this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'player.death', summary: String(event.message ?? '').slice(0, 240), status: 'warning',
            data: { seq: event.seq, ...(position && { position: { ...position } }), ...(oxygen !== undefined && { oxygen }) } })
          const binding = this.store.bindingByContext('game.minecraft')
          if (binding) this.store.memory.create({
            kind: 'event', scope: 'shared', contextId: 'game.minecraft', status: 'active', confidence: 1, importance: 0.7,
            content: `在 Coopcraft 中发生了真实死亡事件：${String(event.message ?? '').slice(0, 240)}`,
            sourceRefs: [{ contextId: binding.contextId, sessionId: binding.sessionId, eventSeq: event.seq }],
            actorSessionId: binding.sessionId, reason: 'minecraft-player-death',
          })
        }
      }
      if (isCurrent()) {
        const presence = value.presence
        this.worldObservation = { at: observedAt, status: presence?.online === true
          ? typeof presence.action === 'string' && presence.action ? 'busy' : 'ready'
          : presence?.online === false ? 'standby' : 'unavailable' }
        this.homeActiveKind = presence?.online === true && typeof presence.action === 'string' && presence.action.length > 0 ? presence.action : undefined
        this.homeActiveAt = this.homeActiveKind ? observedAt : undefined
        this.surveyReadyAt = presence?.online === true && !presence.action && presence.campSurveyReady === true ? observedAt : undefined
        this.campVisitReadyAt = presence?.online === false && !presence.action && presence.campVisitReady === true ? observedAt : undefined
      }
    })().catch((error: unknown) => {
      if (isCurrent()) {
        this.worldObservation = undefined
        this.homeActiveAt = undefined
        this.surveyReadyAt = undefined
        this.campVisitReadyAt = undefined
      }
      this.lastError = error instanceof Error ? error.message : String(error)
    }).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async ensureGameSession(): Promise<void> {
    if (this.closing) return
    const existing = this.store.bindingByContext('game.minecraft')
    if (existing) return
    await this.sessions.create({ contextId: 'game.minecraft', kind: 'game', label: 'Minecraft 世界' }).catch(() => {})
  }

  async login(): Promise<unknown> {
    await this.request('/login', 'POST', {})
    return this.view()
  }

  async connect(atOwner = false): Promise<unknown> {
    this.clearCampVisitReady()
    const value = await this.campRequest('/connect', atOwner ? { atOwner: true } : {}, this.campEpoch)
    this.clearCampVisitReady()
    await this.ensureGameSession()
    return value
  }

  async startCampVisit(id: string, zoneId: string, expiresAt: number, signal: AbortSignal, allowSupply?: true, allowBuild?: true,
    allowRevisit?: true, mode?: true | 'gather' | 'project-gather'): Promise<z.infer<typeof CampVisitStarted>> {
    const epoch = this.campEpoch
    this.assertCampOpen(epoch)
    signal.throwIfAborted()
    const now = Date.now()
    const zone = this.store.buildZoneById(zoneId)
    if (!zone || !this.campVisitReady(now)) throw new DeviceAuthError(409, 'minecraft-camp-visit-unavailable')
    const { id: zoneKey, dimension, x, y, z, radius } = zone
    const permit = MinecraftSurveyPreviewRequest.safeParse({ zone: { id: zoneKey, dimension, x, y, z, radius } })
    const patrol: true | undefined = mode === true ? true : undefined
    const projectGather: true | undefined = mode === 'project-gather' ? true : undefined
    const gather: true | undefined = mode === 'gather' || projectGather ? true : undefined
    const duration = patrol ? CAMP_PATROL_MAX_MS : gather ? CAMP_GATHER_MAX_MS : CAMP_VISIT_MAX_MS
    if (!CampVisitId.safeParse(id).success || !permit.success || !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
      expiresAt > now + duration ||
      (allowRevisit === true && (allowBuild !== true || allowSupply === true)) ||
      (projectGather && (allowSupply !== true || allowBuild !== true || allowRevisit === true)) ||
      ((patrol || (gather && !projectGather)) && (allowSupply === true || allowBuild === true || allowRevisit === true))) {
      throw new DeviceAuthError(400, 'minecraft-camp-visit-invalid-permit')
    }
    if (gather) {
      const worker = await this.request('', 'GET', undefined, signal, epoch)
      signal.throwIfAborted()
      this.assertCampOpen(epoch)
      if (worker?.auth?.mode !== 'cbi' || worker.online !== false || worker.connecting || worker.capabilities?.campVisitGather !== true ||
        !this.campVisitReady(Date.now()) || !this.store.buildZoneById(zoneId)) {
        throw new DeviceAuthError(409, 'minecraft-camp-visit-gather-unavailable')
      }
      if (Date.now() >= expiresAt) throw new DeviceAuthError(409, 'minecraft-camp-visit-permit-ended')
    }
    this.clearCampVisitReady()
    const actionPermit = allowSupply === true || allowBuild === true || patrol || gather
      ? { id, zoneId, expiresAt, confirmed: false, allowSupply, allowBuild, allowRevisit, patrol, gather, projectGather } : undefined
    this.visitActionPermit = actionPermit
    try {
      const result = CampVisitStarted.safeParse(await this.campRequest('/camp/visit/start', {
        id, zone: permit.data.zone, expiresAt,
        ...(allowSupply === true && { allowSupply }), ...(allowBuild === true && { allowBuild }), ...(allowRevisit === true && { allowRevisit }),
        ...(patrol && { patrol }), ...(gather && { gather }), ...(projectGather && { projectGather }),
      }, epoch, signal))
      signal.throwIfAborted()
      if (!this.store.buildZoneById(zoneId) || Date.now() >= expiresAt) throw new DeviceAuthError(409, 'minecraft-camp-visit-permit-ended')
      if (!result.success || result.data.visitId !== id) throw new DeviceAuthError(502, 'minecraft-camp-visit-start-unconfirmed')
      if (actionPermit) {
        if (this.visitActionPermit !== actionPermit) throw new DeviceAuthError(409, 'minecraft-camp-visit-permit-ended')
        actionPermit.confirmed = true
      }
      void this.ensureGameSession()
      return result.data
    } finally {
      if (actionPermit && !actionPermit.confirmed && this.visitActionPermit === actionPermit) this.visitActionPermit = undefined
      this.clearCampVisitReady()
    }
  }

  async endCampVisit(id: string): Promise<z.infer<typeof CampVisitEnded>> {
    if (!CampVisitId.safeParse(id).success) throw new DeviceAuthError(400, 'minecraft-camp-visit-invalid-permit')
    if (this.visitActionPermit?.id === id) this.visitActionPermit = undefined
    this.clearCampVisitReady()
    try {
      const result = CampVisitEnded.safeParse(await this.request('/camp/visit/end', 'POST', { id }, AbortSignal.timeout(20_000)))
      if (!result.success || result.data.visitId !== id) throw new DeviceAuthError(502, 'minecraft-camp-visit-end-unconfirmed')
      return result.data
    } finally {
      this.clearCampVisitReady()
    }
  }

  async disconnect(): Promise<unknown> {
    this.houseProjectPlanGeneration++
    this.visitActionPermit = undefined
    this.cancelSupply(undefined, true)
    this.clearCampVisitReady()
    this.surveyReadyAt = undefined
    const value = await this.request('/disconnect', 'POST', {})
    this.clearCampVisitReady()
    this.homeActiveAt = undefined
    this.store.updateCapability('game.minecraft', 'planned', 'Minecraft 已下线')
    this.endFollow('Minecraft 已下线')
    return value
  }

  private endFollow(reason: string): void {
    const taskId = this.followTaskId
    this.followTaskId = undefined
    if (taskId && this.store.taskById(taskId)?.status === 'running') this.store.transitionTask(taskId, 'cancelled', reason)
  }

  private emitMoment(task: TaskRecord | undefined, result: unknown): void {
    if (!this.onMoment || !task) return
    const moment = minecraftMoment(task, result)
    if (!moment) return
    try {
      this.onMoment(moment)
    } catch {
      // The world action is already complete. A failed enqueue cannot change its receipt.
      try {
        this.store.recordActivity({ contextId: task.contextId, sessionId: task.sessionId, taskId: task.id, source: 'game.minecraft', kind: 'world.share-queue-failed', summary: '未能将游戏成果加入分享评估队列', status: 'warning' })
      } catch {}
    }
  }

  private usedSingleCampVisit(visitId: string): boolean {
    const { patrol: _, ...actions } = CAMP_VISIT_ACTIONS
    return Object.values(actions).some(({ prefix }) => this.store.taskByExternalId(`${prefix}${visitId}`))
  }

  private usedCampVisit(visitId: string): boolean {
    return this.usedSingleCampVisit(visitId) || [1, 2].some(index => this.store.taskByExternalId(`${CAMP_VISIT_PATROL_TASK_PREFIX}${visitId}:${index}`))
  }

  private assertPatrolSegment(input: ReturnType<typeof MinecraftPatrolSegmentRequest.parse>, visitId: string): void {
    const firstId = `${CAMP_VISIT_PATROL_TASK_PREFIX}${visitId}:1`
    const first = this.store.taskByExternalId(firstId)
    if (this.usedSingleCampVisit(visitId) || this.store.taskByExternalId(`${CAMP_VISIT_PATROL_TASK_PREFIX}${visitId}:2`) || (input.index === 1 && first)) {
      throw new DeviceAuthError(409, 'minecraft-camp-visit-patrol-used')
    }
    if (input.index === 1) return
    const evidence = this.store.activityByEventId(`${firstId}:receipt`)
    const receipt = MinecraftPatrolSegmentReceipt.safeParse(evidence?.data.receipt).data
    if (first?.status !== 'succeeded' || first.contextId !== 'game.minecraft' || first.capabilityId !== 'minecraft.survey' ||
      evidence?.contextId !== DAILY_VISIT_CONTEXT || evidence.source !== 'game.minecraft' || evidence.kind !== CAMP_VISIT_ACTIONS.patrol.event ||
      evidence.taskId !== first.id || evidence.status !== 'success' || evidence.sessionId !== undefined ||
      receipt?.index !== 1 || !receipt.surveyed || receipt.zoneId !== input.zone.id) {
      throw new DeviceAuthError(409, 'minecraft-camp-visit-patrol-order')
    }
    if (receipt.direction === input.direction) throw new DeviceAuthError(409, 'minecraft-camp-visit-patrol-direction-used')
  }

  private async action(kind: 'chat' | 'follow' | 'move' | 'dig' | 'return' | 'craft' | 'shield' | 'build' | 'survey' | 'stop' | 'storage' | 'smelt' | 'sleep' | 'place-bed' | 'night-cover', input: unknown, keepRunning = false, signal?: AbortSignal, parentTaskId?: string, authorized?: AuthorizedAction): Promise<{ task: TaskRecord; result: unknown }> {
    const epoch = this.campEpoch
    if (kind !== 'stop') this.assertCampOpen(epoch)
    const binding = this.store.bindingByContext('game.minecraft')
    const visitId = authorized && 'visitId' in authorized ? authorized.visitId : undefined
    const visitSupply = authorized?.path === '/camp/visit/supply' ? authorized : undefined
    const visitBuild = authorized?.path === '/camp/visit/build' ? authorized : undefined
    const visitRevisit = authorized?.path === '/camp/visit/revisit' ? authorized : undefined
    const visitPatrol = authorized?.path === '/camp/visit/patrol-segment' ? authorized : undefined
    const visitGather = authorized?.path === '/camp/visit/gather' ? authorized : undefined
    const visitAction = visitGather ? 'gather' : visitPatrol ? 'patrol' : visitSupply ? 'supply' : visitBuild ? 'build' : visitRevisit ? 'revisit' : 'survey'
    const visitInfo = CAMP_VISIT_ACTIONS[visitAction]
    const externalId = visitId ? `${visitInfo.prefix}${visitId}${visitPatrol ? `:${visitPatrol.input.index}` : ''}` : undefined
    const taskInput = { capabilityId: `minecraft.${kind}`, contextId: 'game.minecraft', sessionId: binding?.sessionId,
      title: `Minecraft：${kind === 'survey' || visitId ? visitInfo.title : kind}`, externalId }
    const task = visitId ? this.store.transaction(() => {
      if (visitPatrol) this.assertPatrolSegment(visitPatrol.input, visitId)
      else if (visitAction === 'survey') this.assertSurveyVisit(visitId)
      else if (this.usedCampVisit(visitId)) {
        throw new DeviceAuthError(409, `minecraft-camp-visit-${visitAction}-used`)
      }
      const scopedTask = this.store.createTask(taskInput)
      return this.store.transitionTask(scopedTask.id, 'running')
    }) : this.store.createTask(taskInput)
    if (kind === 'follow') this.followTaskId = task.id
    if (!visitId) this.store.transitionTask(task.id, 'running')
    try {
      if (kind === 'dig' && !visitGather) await this.syncLessons()
      let result = kind === 'stop' ? await this.request(authorized?.path ?? '/stop', 'POST', input, signal)
        : await this.campRequest(authorized?.path ?? `/${kind}`, authorized?.input ?? input, epoch, signal, visitId)
      if (kind === 'chat' && !ChatDelivery.safeParse(result).success) throw new DeviceAuthError(502, 'minecraft-chat-receipt-unconfirmed')
      if (kind === 'sleep' && result?.sleeping !== true) throw new DeviceAuthError(409, 'night-bed-use-refused')
      if (kind === 'place-bed' && (result?.placed !== true || !this.targetOf(result.head))) throw new DeviceAuthError(409, 'night-bed-placement-refused')
      if (kind === 'night-cover' && (!this.targetOf(result?.surface) ||
          (result?.status !== 'covered' && (result?.status !== 'opened' || result.exit?.returned !== true)))) {
        throw new DeviceAuthError(502, 'night-shelter-receipt-unconfirmed')
      }
      if (kind === 'shield') {
        signal?.throwIfAborted()
        if (this.store.taskById(task.id)?.status !== 'running') throw new DeviceAuthError(409, 'shield-cancelled')
        const receipt = MinecraftShieldReceipt.safeParse(result)
        if (!receipt.success || receipt.data.requestedTicks !== MinecraftShieldRequest.parse(input).seconds * 20) {
          throw new DeviceAuthError(502, 'shield-unconfirmed')
        }
        result = receipt.data
      }
      if (authorized?.path === '/storage') {
        const input = authorized.input
        const receipt = MinecraftOvoStorageReceipt.safeParse(result)
        const position = receipt.data?.position
        if (!receipt.success || receipt.data.zoneId !== input.zone.id || receipt.data.operation !== input.operation ||
          receipt.data.itemName !== input.itemName || receipt.data.count !== input.count ||
          Math.abs(receipt.data.inventoryDelta) !== input.count || receipt.data.inventoryDelta + receipt.data.chestDelta !== 0 ||
          !position || (['x', 'y', 'z'] as const).some(axis => Math.abs(position[axis] - input.zone[axis]) > input.zone.radius)) {
          throw new DeviceAuthError(502, 'minecraft-storage-receipt-unconfirmed')
        }
        result = receipt.data
      }
      if (authorized?.path === '/smelt') {
        const input = authorized.input
        const receipt = MinecraftOvoSmeltReceipt.safeParse(result)
        const position = receipt.data?.position
        if (!receipt.success || receipt.data.zoneId !== input.zone.id || receipt.data.phase !== input.phase ||
          receipt.data.itemName !== input.itemName || receipt.data.count !== input.count || receipt.data.output !== MINECRAFT_OVO_SMELT_RESULTS[input.itemName] ||
          receipt.data.inventoryDelta !== (input.phase === 'start' ? -input.count : input.count) ||
          !position || (['x', 'y', 'z'] as const).some(axis => Math.abs(position[axis] - input.zone[axis]) > input.zone.radius)) {
          throw new DeviceAuthError(502, 'minecraft-smelt-output-unconfirmed')
        }
        result = receipt.data
      }
      if (authorized?.path === '/camp/pause' && !campStopStatus(result)) throw new DeviceAuthError(502, 'minecraft-camp-stop-unconfirmed')
      if ((authorized?.path === '/supply' || authorized?.path === '/camp-supply') &&
        (result?.crafted !== true || result.name !== authorized.input.recipe || result.count !== 4 ||
          (authorized.path === '/camp-supply' && result.consumedLogs !== 1))) {
        throw new Error('supply-receipt-unconfirmed')
      }
      if (authorized?.path === '/build-authorized' && (result?.built !== true ||
        result.zoneId !== authorized.input.zone.id || result.material !== authorized.input.material ||
        result.placedFloor !== 8 || result.placedTable !== 1)) throw new Error('build-receipt-unconfirmed')
      const supplyReceipt = visitSupply ? MinecraftVisitSupplyReceipt.safeParse(result).data : undefined
      if (visitSupply) {
        signal?.throwIfAborted()
        if (!this.authorizedVisitZone(visitSupply.input.zone.id, visitSupply.visitId, 'allowSupply') || this.store.taskById(task.id)?.status !== 'running') {
          throw new DeviceAuthError(409, 'minecraft-camp-visit-supply-cancelled')
        }
        if (!supplyReceipt || supplyReceipt.name !== visitSupply.input.recipe) throw new DeviceAuthError(502, 'minecraft-camp-visit-supply-unconfirmed')
        result = supplyReceipt
      }
      const buildReceipt = visitBuild ? MinecraftVisitBuildReceipt.safeParse(result).data : undefined
      if (visitBuild) {
        signal?.throwIfAborted()
        if (!this.authorizedVisitZone(visitBuild.input.zone.id, visitBuild.visitId, 'allowBuild') || this.store.taskById(task.id)?.status !== 'running') {
          throw new DeviceAuthError(409, 'minecraft-camp-visit-build-cancelled')
        }
        if (!buildReceipt || buildReceipt.zoneId !== visitBuild.input.zone.id || buildReceipt.material !== visitBuild.input.material) {
          throw new DeviceAuthError(502, 'minecraft-camp-visit-build-unconfirmed')
        }
        result = buildReceipt
      }
      const revisitReceipt = visitRevisit ? MinecraftVisitRevisitReceipt.safeParse(result).data : undefined
      if (visitRevisit) {
        signal?.throwIfAborted()
        if (!this.authorizedVisitZone(visitRevisit.input.zone.id, visitRevisit.visitId, 'allowRevisit') || this.store.taskById(task.id)?.status !== 'running') {
          throw new DeviceAuthError(409, 'minecraft-camp-visit-revisit-cancelled')
        }
        if (!revisitReceipt || revisitReceipt.zoneId !== visitRevisit.input.zone.id || revisitReceipt.material !== visitRevisit.input.material) {
          throw new DeviceAuthError(502, 'minecraft-camp-visit-revisit-unconfirmed')
        }
        result = revisitReceipt
      }
      let recovered = false
      const patrolReceipt = visitPatrol ? MinecraftPatrolSegmentReceipt.safeParse(result).data : undefined
      if (visitPatrol) {
        signal?.throwIfAborted()
        const { index, zone, direction, steps } = visitPatrol.input
        if (!this.authorizedVisitZone(zone.id, visitPatrol.visitId, 'patrol') || this.store.taskById(task.id)?.status !== 'running') {
          throw new DeviceAuthError(409, 'minecraft-camp-visit-patrol-cancelled')
        }
        if (!patrolReceipt || patrolReceipt.index !== index || patrolReceipt.zoneId !== zone.id ||
          patrolReceipt.direction !== direction || patrolReceipt.steps !== steps) {
          throw new DeviceAuthError(502, 'minecraft-camp-visit-patrol-unconfirmed')
        }
        result = patrolReceipt
        recovered = !patrolReceipt.surveyed
      }
      const gatherReceipt = visitGather ? MinecraftCampGatherReceipt.safeParse(result).data : undefined
      if (visitGather) {
        signal?.throwIfAborted()
        const { zone, direction, steps } = visitGather.input
        if (!this.authorizedVisitZone(zone.id, visitGather.visitId, 'gather') || this.store.taskById(task.id)?.status !== 'running') {
          throw new DeviceAuthError(409, 'minecraft-camp-visit-gather-cancelled')
        }
        if (!gatherReceipt || gatherReceipt.zoneId !== zone.id || gatherReceipt.direction !== direction || gatherReceipt.steps !== steps) {
          throw new DeviceAuthError(502, 'minecraft-camp-visit-gather-unconfirmed')
        }
        result = gatherReceipt
      }
      if (authorized?.path === '/survey') {
        signal?.throwIfAborted()
        const survey = authorized.input
        if (!this.store.buildZoneById(survey.zone.id) || this.store.taskById(task.id)?.status !== 'running') throw new Error('survey-cancelled')
        if ('trail' in survey) {
          const receipt = MinecraftTrailReceipt.safeParse(result)
          if (!receipt.success || receipt.data.zoneId !== survey.zone.id || receipt.data.trail !== survey.trail) throw new Error('survey-receipt-unconfirmed')
          recovered = receipt.data.outcome === 'recovered'
        } else {
          const receipt = MinecraftSurveyReceipt.safeParse(result)
          if (!receipt.success || receipt.data.zoneId !== survey.zone.id || receipt.data.direction !== survey.direction ||
            receipt.data.steps !== (survey.steps ?? SURVEY_DISTANCE) || (!receipt.data.surveyed && survey.steps === undefined)) {
            throw new Error('survey-receipt-unconfirmed')
          }
          recovered = !receipt.data.surveyed
        }
      }
      if (kind === 'follow' && this.store.taskById(task.id)?.status === 'cancelled') throw new Error('follow-cancelled')
      const target = this.targetOf((result as { target?: unknown }).target ?? (kind === 'move' ? input : undefined))
      if (!recovered) this.learnSuccess(kind, target, [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id }])
      const visitReceipt = gatherReceipt ?? patrolReceipt ?? revisitReceipt ?? buildReceipt ?? supplyReceipt
      if (!keepRunning) this.store.transitionTask(task.id, 'succeeded', undefined, visitReceipt && 'event' in visitInfo ? () => {
        this.store.recordActivity({ eventId: `${externalId}:receipt`, contextId: DAILY_VISIT_CONTEXT,
          taskId: task.id, source: 'game.minecraft', kind: visitInfo.event, status: 'success', summary: visitInfo.summary,
          data: { receipt: visitReceipt } })
      } : undefined)
      if (kind !== 'stop') {
        this.store.recordActivity({ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id, source: 'game.minecraft', kind: 'world.action',
          summary: recovered ? '勘察途中地形变化，已确认提前返回营地'
            : visitGather ? CAMP_VISIT_ACTIONS.gather.summary : visitPatrol ? CAMP_VISIT_ACTIONS.patrol.summary
              : visitRevisit ? CAMP_VISIT_ACTIONS.revisit.summary : `${kind} 已取得真实执行回执`,
          status: recovered ? 'warning' : 'success',
          ...(kind === 'shield' && { data: { shield: MinecraftShieldReceipt.parse(result) } }) })
        if (kind !== 'chat' && (!authorized || authorized.path === '/storage' || authorized.path === '/smelt')) {
          this.store.memory.create({
            kind: 'experience', scope: 'shared', contextId: 'game.minecraft', status: 'active', confidence: 1, importance: 0.6,
            content: `在 Coopcraft 中${gameActionFact(kind, result)}。真实结果：${JSON.stringify(result).slice(0, 400)}`,
            sourceRefs: [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id }],
            actorSessionId: binding?.sessionId, reason: 'minecraft-executed-action',
          })
        }
      }
      const receipt = this.store.taskById(task.id)!
      if (!parentTaskId && authorized?.path !== '/camp-supply' && !visitReceipt) this.emitMoment(receipt, result)
      return { task: receipt, result }
    } catch (error) {
      if (kind === 'follow' && this.followTaskId === task.id) this.followTaskId = undefined
      const current = this.store.taskById(task.id)
      if (kind !== 'stop' && (epoch !== this.campEpoch || this.campControl().pausedAt)) {
        if (current && ['accepted', 'running'].includes(current.status)) this.store.transitionTask(task.id, 'cancelled', 'minecraft-camp-paused')
        throw new DeviceAuthError(409, 'minecraft-camp-paused')
      }
      if (authorized && signal?.aborted) {
        const reason = visitGather ? 'gather-result-unconfirmed-after-cancel' : visitPatrol ? 'patrol-result-unconfirmed-after-cancel'
          : visitRevisit ? 'revisit-result-unconfirmed-after-cancel' : authorized.path === '/survey' ? 'survey-result-unconfirmed-after-cancel'
          : authorized.path === '/build-authorized' || authorized.path === '/camp/visit/build'
            ? 'build-result-unconfirmed-after-cancel' : 'supply-result-unconfirmed-after-cancel'
        if (current && ['accepted', 'running'].includes(current.status)) this.store.transitionTask(task.id, 'cancelled', reason)
        throw error
      }
      this.learnFailure(kind, error, this.targetOf(input), [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id }])
      if (current && ['accepted', 'running'].includes(current.status)) this.store.transitionTask(task.id, signal?.aborted || (error instanceof Error && error.message.includes('cancelled')) ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
      if (signal?.aborted && kind !== 'shield') await this.request('/stop', 'POST', {}).catch(() => {})
      throw error
    }
  }

  chat(text: string, signal?: AbortSignal): Promise<unknown> {
    return this.action('chat', { text }, false, signal)
  }

  async modelChat(text: string, signal: AbortSignal): Promise<unknown> {
    const { task, result } = await this.action('chat', { text, receiptOnly: true }, false, signal)
    const delivery = ChatDelivery.parse(result)
    if (task.status === 'succeeded' && delivery.delivery === 'private') {
      const epoch = this.campEpoch
      this.onPrivateReply?.(task.id, text, () => !this.closing && this.campEpoch === epoch && !this.campControl().pausedAt)
    }
    return { taskId: task.id, status: task.status, ...delivery }
  }

  async follow(): Promise<unknown> {
    this.assertCampOpen()
    if (this.followTaskId && this.store.taskById(this.followTaskId)?.status === 'running') return this.view()
    return this.action('follow', {}, true)
  }

  move(input: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<unknown> {
    return this.action('move', input, false, signal)
  }

  async modelMove(input: { x: number; y: number; z: number }, signal: AbortSignal): Promise<unknown> {
    try {
      return await this.move(input, signal)
    } catch (error) {
      if (!(error instanceof DeviceAuthError) || !['move-air-falling', 'move-route-diverged', 'move-ended-without-arrival', 'move-timeout', 'unsafe-target'].includes(error.code)) throw error
      const observation = await this.observe().catch(() => undefined)
      signal.throwIfAborted()
      return { moved: false, reason: error.code, target: input, observation }
    }
  }

  async modelRespawn(signal: AbortSignal): Promise<unknown> {
    this.assertCampOpen()
    const worker = await this.request('', 'GET', undefined, signal)
    signal.throwIfAborted()
    if (worker.online === true) return { respawned: false, reason: 'already-online' }
    const death = this.store.activities(150).find(event => event.contextId === 'game.minecraft' && event.kind === 'player.death')
    if (!death || death.id === this.lastRespawnDeath || Date.now() - Date.parse(death.occurredAt) > 30 * 60_000) {
      return { respawned: false, reason: 'no-new-death-receipt' }
    }
    this.lastRespawnDeath = death.id
    const result = await this.connect()
    return { respawned: true, result }
  }

  inspectTerrain(targets: { x: number; y: number; z: number }[], signal: AbortSignal): Promise<unknown> {
    return this.campRequest('/terrain', targets, this.campEpoch, signal)
  }

  findWood(name: string, maxAbove: number | undefined, signal: AbortSignal): Promise<unknown> {
    return this.campRequest('/wood', { name, maxAbove }, this.campEpoch, signal)
  }

  async clearGrass(zoneId: string, target: { x: number; y: number; z: number }, signal: AbortSignal): Promise<unknown> {
    const epoch = this.campEpoch
    const zone = await this.authorizedZone(zoneId, signal, 'houseBuilding')
    if (!zone || !this.store.minecraftHouses.list().some(draft => {
      if (draft.zoneId !== zoneId || draft.status !== 'draft') return false
      const minX = zone.x - Math.floor(draft.layout.width / 2)
      const minZ = zone.z - Math.floor(draft.layout.depth / 2)
      return target.y === zone.y && target.x >= minX && target.x < minX + draft.layout.width &&
        target.z >= minZ && target.z < minZ + draft.layout.depth
    })) {
      throw new DeviceAuthError(409, 'minecraft-house-site-not-authorized')
    }
    const { id, dimension, x, y, z, radius } = zone
    return this.campRequest('/clear-grass', { zone: { id, dimension, x, y, z, radius }, target }, epoch, signal)
  }

  surface(signal: AbortSignal): Promise<unknown> {
    return this.campRequest('/surface', {}, this.campEpoch, signal)
  }

  findBeds(signal: AbortSignal): Promise<unknown> {
    return this.campRequest('/find-beds', {}, this.campEpoch, signal)
  }

  sleepInBed(target: { x: number; y: number; z: number }, signal: AbortSignal): Promise<unknown> {
    return this.modelNightAction('sleep', target, signal)
  }

  placeBed(target: { x: number; y: number; z: number }, signal: AbortSignal): Promise<unknown> {
    return this.modelNightAction('place-bed', target, signal)
  }

  nightCover(phase: 'sites' | 'status' | 'enter' | 'leave', signal: AbortSignal): Promise<unknown> {
    return phase === 'sites' || phase === 'status' ? this.campRequest('/night-cover', { phase }, this.campEpoch, signal)
      : this.modelNightAction('night-cover', { phase }, signal)
  }

  private async modelNightAction(kind: 'sleep' | 'place-bed' | 'night-cover', input: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const { task, result } = await this.action(kind, input, false, signal)
      return { taskId: task.id, ...(result as Record<string, unknown>) }
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof DeviceAuthError) || !/^night-[a-z-]+$/u.test(error.code)) throw error
      return { status: 'refused', reason: error.code }
    }
  }

  dig(name: string | undefined, signal?: AbortSignal, parentTaskId?: string, target?: { x: number; y: number; z: number }): Promise<unknown> {
    return this.action('dig', { name, target }, false, signal, parentTaskId)
  }

  async modelDig(name: string | undefined, target: { x: number; y: number; z: number } | undefined, signal: AbortSignal): Promise<unknown> {
    try {
      return await this.dig(name, signal, undefined, target)
    } catch (error) {
      if (!(error instanceof DeviceAuthError) || !['dig-air-falling', 'dig-health-low', 'dig-health-falling', 'dig-target-unreachable'].includes(error.code)) throw error
      const observation = await this.observe().catch(() => undefined)
      signal.throwIfAborted()
      return { gathered: false, reason: error.code, target, observation }
    }
  }

  returnToSafety(signal?: AbortSignal): Promise<unknown> {
    return this.action('return', {}, false, signal)
  }

  craft(name: string, signal?: AbortSignal, parentTaskId?: string): Promise<unknown> {
    return this.action('craft', { name }, false, signal, parentTaskId)
  }

  async modelCraft(name: string, batches: number, signal: AbortSignal): Promise<unknown> {
    if (!Number.isSafeInteger(batches) || batches < 1 || batches > 6) throw new DeviceAuthError(400, 'craft-batches-invalid')
    if (batches === 1) return this.craft(name, signal)
    if (!name.endsWith('_planks')) throw new DeviceAuthError(400, 'craft-batches-planks-only')
    const tasks: string[] = []
    let produced = 0
    let reason: string | undefined
    for (let index = 0; index < batches; index++) {
      signal.throwIfAborted()
      try {
        const { task, result } = await this.action('craft', { name }, false, signal)
        const receipt = z.object({ crafted: z.literal(true), name: z.literal(name), count: z.literal(4) }).parse(result)
        tasks.push(task.id)
        produced += receipt.count
      } catch (error) {
        signal.throwIfAborted()
        if (!tasks.length || !(error instanceof DeviceAuthError)) throw error
        reason = error.code
        break
      }
    }
    return { name, requested: batches, completed: tasks.length, produced, tasks, ...(reason && { reason }) }
  }

  holdShield(input: unknown, signal?: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    signal?.throwIfAborted()
    return this.action('shield', MinecraftShieldRequest.parse(input), false, signal)
  }

  private cancelSupply(zoneId?: string, explicit?: boolean): void {
    try { this.onSupplyStop?.(zoneId, explicit) } catch {}
  }

  private worldBusy(ownHouseRun?: HouseRun): boolean {
    return !!this.campControl().pausedAt || !!this.currentBuildZoneId || !!this.houseRun && this.houseRun !== ownHouseRun || this.store.tasks().some(task =>
      task.capabilityId.startsWith('minecraft.') && task.status === 'running')
  }

  private async authorizedZone(zoneId: string, signal: AbortSignal, ...capabilities: ('crafting' | 'campBuilding' | 'campSurvey' | 'houseBuilding' | 'houseCellPlacement' | 'houseProjects' | 'houseRecovery')[]) {
    signal.throwIfAborted()
    if (!this.store.buildZoneById(zoneId) || this.worldBusy()) return undefined
    const worker = await this.request('', 'GET', undefined, signal)
    if (worker?.online !== true || worker.connecting || worker.action || worker.auth?.mode !== 'cbi' ||
      !capabilities.every(capability => worker.capabilities?.[capability] === true)) return undefined
    return !this.worldBusy() ? this.store.buildZoneById(zoneId) : undefined
  }

  private async inspectAuthorizedZone(zoneId: string, signal: AbortSignal, ...capabilities: ('crafting' | 'campBuilding')[]) {
    if (!await this.authorizedZone(zoneId, signal, ...capabilities)) return undefined
    const observation = await this.request('/observe', 'GET', undefined, signal)
    signal.throwIfAborted()
    const zone = this.store.buildZoneById(zoneId)
    if (zone && !this.worldBusy()) return { zone, observation }
  }

  async inspectCampSurvey(zoneId: string, signal: AbortSignal, visitId?: string): Promise<MinecraftSurveyOffer | undefined> {
    const permit = this.visitActionPermit
    if (permit?.gather && !permit.projectGather && (visitId === undefined || permit.id === visitId)) return
    const patrol = !!visitId && permit?.patrol === true && permit.id === visitId
    if (patrol && !this.authorizedVisitZone(zoneId, visitId, 'patrol')) return
    const zone = await this.authorizedZone(zoneId, signal, 'campSurvey')
    if (!zone) return undefined
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSurveyPreviewRequest.safeParse({ zone: { id, dimension, x, y, z, radius } })
    if (!input.success) return undefined
    const offer = MinecraftSurveyPreview.safeParse(await this.request('/survey-preview', 'POST', input.data, signal, undefined, visitId))
    signal.throwIfAborted()
    if (offer.success && (offer.data.directions.length || offer.data.trails?.length) && !offer.data.routes?.some(route => route.steps >= radius) &&
      this.store.buildZoneById(zoneId) && !this.worldBusy() && (!patrol || this.authorizedVisitZone(zoneId, visitId, 'patrol'))) return offer.data
  }

  private assertSurveyVisit(visitId: string | undefined): void {
    const permit = this.visitActionPermit
    if (permit?.gather && !permit.projectGather && (visitId === undefined || permit.id === visitId)) {
      throw new DeviceAuthError(409, 'minecraft-camp-visit-gather-exclusive')
    }
    if (!visitId) return
    if (permit?.patrol && permit.id === visitId) {
      throw new DeviceAuthError(409, 'minecraft-camp-visit-patrol-exclusive')
    }
    if (this.usedCampVisit(visitId)) throw new DeviceAuthError(409, 'minecraft-camp-visit-survey-used')
  }

  async surveyCamp(zoneId: string, direction: SurveyDirection, signal: AbortSignal, steps?: number, visitId?: string): Promise<{ task: TaskRecord; result: unknown }> {
    this.assertSurveyVisit(visitId)
    const epoch = this.campEpoch
    const offer = await this.inspectCampSurvey(zoneId, signal, visitId)
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const zone = this.store.buildZoneById(zoneId)
    if (!zone || !offer?.directions.includes(direction) || this.worldBusy()) throw new DeviceAuthError(409, 'survey-preconditions-changed')
    if (steps !== undefined && !offer.routes?.some(route => route.direction === direction && route.steps >= steps)) {
      throw new DeviceAuthError(409, 'survey-preconditions-changed')
    }
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSurveyRequest.parse({ zone: { id, dimension, x, y, z, radius }, direction, ...(steps !== undefined && { steps }) })
    return this.action('survey', {}, false, signal, undefined, { path: '/survey', input, visitId })
  }

  async surveyTrail(zoneId: string, trail: SurveyTrailId, signal: AbortSignal, visitId?: string): Promise<{ task: TaskRecord; result: unknown }> {
    this.assertSurveyVisit(visitId)
    const epoch = this.campEpoch
    const offer = await this.inspectCampSurvey(zoneId, signal, visitId)
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const zone = this.store.buildZoneById(zoneId)
    if (!zone || !offer?.trails?.includes(trail) || this.worldBusy()) throw new DeviceAuthError(409, 'survey-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSurveyRequest.parse({ zone: { id, dimension, x, y, z, radius }, trail })
    return this.action('survey', {}, false, signal, undefined, { path: '/survey', input, visitId })
  }

  private async inspectOvoZone(zoneId: string, signal: AbortSignal, capability: 'ovoStorage' | 'ovoSmelting') {
    signal.throwIfAborted()
    const zone = this.store.buildZoneById(zoneId)
    if (!zone || this.worldBusy()) return undefined
    const worker = await this.request('', 'GET', undefined, signal)
    if (worker?.online !== true || worker.connecting || worker.action || worker.capabilities?.[capability] !== true) return undefined
    const observation = await this.request('/observe', 'GET', undefined, signal)
    signal.throwIfAborted()
    const position = observation?.position
    if (observation?.online !== true || observation.gameMode !== 'survival' || minecraftOvoDimension(observation.dimension) !== minecraftOvoDimension(zone.dimension) ||
      typeof position?.x !== 'number' || Math.abs(position.x - zone.x) > zone.radius ||
      Math.abs(position.y - zone.y) > zone.radius || Math.abs(position.z - zone.z) > zone.radius ||
      !(observation.health >= 16) || !(observation.food >= 12) || !(observation.oxygen >= 200)) return undefined
    return zone
  }

  async ovoStorage(zoneId: string, operation: 'deposit' | 'withdraw', itemName: string, count: number, signal: AbortSignal) {
    const zone = await this.inspectOvoZone(zoneId, signal, 'ovoStorage')
    if (!zone) throw new DeviceAuthError(409, 'minecraft-ovo-unavailable')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftOvoStorageRequest.parse({ zone: { id, dimension, x, y, z, radius }, operation, itemName, count })
    return this.action('storage', {}, false, signal, undefined, { path: '/storage', input })
  }

  async ovoSmelt(zoneId: string, phase: 'start' | 'collect', itemName: string, count: number, signal: AbortSignal) {
    const zone = await this.inspectOvoZone(zoneId, signal, 'ovoSmelting')
    if (!zone) throw new DeviceAuthError(409, 'minecraft-ovo-unavailable')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftOvoSmeltRequest.parse({ zone: { id, dimension, x, y, z, radius }, phase, itemName, count })
    return this.action('smelt', {}, false, signal, undefined, { path: '/smelt', input })
  }

  async inspectSupply(zoneId: string, signal: AbortSignal): Promise<MinecraftSupplyOffer | undefined> {
    const available = await this.inspectAuthorizedZone(zoneId, signal, 'crafting')
    if (available) return minecraftSupplyOffer(available.observation, available.zone)
  }

  async supply(zoneId: string, recipe: string, signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    const epoch = this.campEpoch
    const offer = await this.inspectSupply(zoneId, signal)
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const zone = this.store.buildZoneById(zoneId)
    if (!zone || offer?.recipe !== recipe) throw new DeviceAuthError(409, 'supply-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSupplyRequest.parse({ recipe, zone: { id, dimension, x, y, z, radius } })
    return this.action('craft', {}, false, signal, undefined, { path: '/supply', input })
  }

  private authorizedVisitZone(zoneId: string, visitId: string, action: 'allowSupply' | 'allowBuild' | 'allowRevisit' | 'patrol' | 'gather') {
    const permit = this.visitActionPermit
    if (this.closing || !permit?.confirmed || !permit[action] || (permit.allowRevisit && action !== 'allowRevisit') ||
      permit.id !== visitId || permit.zoneId !== zoneId || Date.now() >= permit.expiresAt) return
    return this.store.buildZoneById(zoneId)
  }

  async inspectVisitSupply(zoneId: string, visitId: string, signal: AbortSignal): Promise<MinecraftSupplyOffer | undefined> {
    const epoch = this.campEpoch
    this.assertCampOpen(epoch)
    signal.throwIfAborted()
    const zone = this.authorizedVisitZone(zoneId, visitId, 'allowSupply')
    if (!zone || this.worldBusy() || this.usedCampVisit(visitId)) return
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSurveyPreviewRequest.parse({ zone: { id, dimension, x, y, z, radius } })
    const value = await this.campRequest('/camp/visit/supply-preview', input, epoch, signal, visitId)
    signal.throwIfAborted()
    if (!this.authorizedVisitZone(zoneId, visitId, 'allowSupply') || this.worldBusy() || this.usedCampVisit(visitId) || value === null) return
    const offer = MinecraftVisitSupplyOffer.safeParse(value)
    if (!offer.success) throw new DeviceAuthError(502, 'minecraft-camp-visit-supply-offer-unconfirmed')
    return offer.data
  }

  async supplyOnVisit(zoneId: string, recipe: string, visitId: string, signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    if (this.usedCampVisit(visitId)) throw new DeviceAuthError(409, 'minecraft-camp-visit-supply-used')
    const epoch = this.campEpoch
    const offer = await this.inspectVisitSupply(zoneId, visitId, signal)
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const zone = this.authorizedVisitZone(zoneId, visitId, 'allowSupply')
    if (!zone || offer?.recipe !== recipe || this.worldBusy()) throw new DeviceAuthError(409, 'minecraft-camp-visit-supply-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSupplyRequest.parse({ recipe, zone: { id, dimension, x, y, z, radius } })
    return this.action('craft', {}, false, signal, undefined, { path: '/camp/visit/supply', input, visitId })
  }

  async inspectVisitBuild(zoneId: string, visitId: string, signal: AbortSignal): Promise<MinecraftCampOffer | undefined> {
    const epoch = this.campEpoch
    this.assertCampOpen(epoch)
    signal.throwIfAborted()
    const zone = this.authorizedVisitZone(zoneId, visitId, 'allowBuild')
    if (!zone || this.worldBusy() || this.usedCampVisit(visitId)) return
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSurveyPreviewRequest.parse({ zone: { id, dimension, x, y, z, radius } })
    const value = await this.campRequest('/camp/visit/build-preview', input, epoch, signal, visitId)
    signal.throwIfAborted()
    if (!this.authorizedVisitZone(zoneId, visitId, 'allowBuild') || this.worldBusy() || this.usedCampVisit(visitId) || value === null) return
    const offer = MinecraftVisitBuildOffer.safeParse(value)
    if (!offer.success) throw new DeviceAuthError(502, 'minecraft-camp-visit-build-offer-unconfirmed')
    return offer.data
  }

  async buildOnVisit(zoneId: string, material: string, visitId: string, signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    if (this.usedCampVisit(visitId)) throw new DeviceAuthError(409, 'minecraft-camp-visit-build-used')
    const epoch = this.campEpoch
    const offer = await this.inspectVisitBuild(zoneId, visitId, signal)
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const zone = this.authorizedVisitZone(zoneId, visitId, 'allowBuild')
    if (!zone || offer?.material !== material || this.worldBusy()) throw new DeviceAuthError(409, 'minecraft-camp-visit-build-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftVisitBuildRequest.parse({ material, zone: { id, dimension, x, y, z, radius } })
    return this.action('build', {}, false, signal, undefined, { path: '/camp/visit/build', input, visitId })
  }

  async revisitOnVisit(zoneId: string, material: string, visitId: string, signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    signal.throwIfAborted()
    this.assertCampOpen()
    if (this.usedCampVisit(visitId)) throw new DeviceAuthError(409, 'minecraft-camp-visit-revisit-used')
    const zone = this.authorizedVisitZone(zoneId, visitId, 'allowRevisit')
    if (!zone || this.worldBusy()) throw new DeviceAuthError(409, 'minecraft-camp-visit-revisit-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftVisitRevisitRequest.parse({ material, zone: { id, dimension, x, y, z, radius } })
    return this.action('survey', {}, false, signal, undefined, { path: '/camp/visit/revisit', input, visitId })
  }

  async patrolSegment(zoneId: string, direction: SurveyDirection, steps: number, index: 1 | 2, visitId: string,
    signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    signal.throwIfAborted()
    this.assertCampOpen()
    const zone = this.authorizedVisitZone(zoneId, visitId, 'patrol')
    if (!zone || this.worldBusy()) throw new DeviceAuthError(409, 'minecraft-camp-visit-patrol-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const request = MinecraftPatrolSegmentRequest.safeParse({ zone: { id, dimension, x, y, z, radius }, direction, steps, index })
    if (!request.success) throw new DeviceAuthError(400, 'minecraft-camp-visit-invalid-request')
    return this.action('survey', {}, false, signal, undefined, { path: '/camp/visit/patrol-segment', input: request.data, visitId })
  }

  async inspectVisitGather(zoneId: string, visitId: string, signal: AbortSignal): Promise<MinecraftCampGatherOffer | undefined> {
    const epoch = this.campEpoch
    this.assertCampOpen(epoch)
    signal.throwIfAborted()
    const zone = this.authorizedVisitZone(zoneId, visitId, 'gather')
    if (!zone || this.worldBusy() || this.usedCampVisit(visitId)) return
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftSurveyPreviewRequest.parse({ zone: { id, dimension, x, y, z, radius } })
    const value = await this.campRequest('/camp/visit/gather-preview', input, epoch, signal, visitId)
    signal.throwIfAborted()
    if (!this.authorizedVisitZone(zoneId, visitId, 'gather') || this.worldBusy() || this.usedCampVisit(visitId) || value === null) return
    const offer = MinecraftCampGatherOffer.safeParse(value)
    if (!offer.success || offer.data.steps >= radius) throw new DeviceAuthError(502, 'minecraft-camp-visit-gather-offer-unconfirmed')
    return offer.data
  }

  async gatherOnVisit(zoneId: string, offer: MinecraftCampGatherOffer, visitId: string, signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    signal.throwIfAborted()
    this.assertCampOpen()
    if (this.usedCampVisit(visitId)) throw new DeviceAuthError(409, 'minecraft-camp-visit-gather-used')
    const zone = this.authorizedVisitZone(zoneId, visitId, 'gather')
    if (!zone || this.worldBusy()) throw new DeviceAuthError(409, 'minecraft-camp-visit-gather-preconditions-changed')
    const parsed = MinecraftCampGatherOffer.safeParse(offer)
    if (!parsed.success) throw new DeviceAuthError(400, 'minecraft-camp-visit-invalid-request')
    const { id, dimension, x, y, z, radius } = zone
    const { direction, steps } = parsed.data
    const request = MinecraftCampGatherRequest.safeParse({ zone: { id, dimension, x, y, z, radius }, direction, steps })
    if (!request.success) throw new DeviceAuthError(400, 'minecraft-camp-visit-invalid-request')
    return this.action('dig', {}, false, signal, undefined, { path: '/camp/visit/gather', input: request.data, visitId })
  }

  async inspectCampBuild(zoneId: string, signal: AbortSignal): Promise<MinecraftCampOffer | undefined> {
    const available = await this.inspectAuthorizedZone(zoneId, signal, 'campBuilding')
    if (available) return minecraftCampOffer(available.observation, available.zone)
  }

  async buildAutonomousCamp(zoneId: string, material: string, signal: AbortSignal): Promise<{ task: TaskRecord; result: unknown }> {
    const epoch = this.campEpoch
    const offer = await this.inspectCampBuild(zoneId, signal)
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const zone = this.store.buildZoneById(zoneId)
    if (!zone || offer?.material !== material) throw new DeviceAuthError(409, 'build-preconditions-changed')
    const { id, dimension, x, y, z, radius } = zone
    const input = MinecraftAuthorizedCampRequest.parse({ material, zone: { id, dimension, x, y, z, radius } })
    return this.action('build', {}, false, signal, undefined, { path: '/build-authorized', input })
  }

  async inspectCampPreparation(zoneId: string, signal: AbortSignal): Promise<MinecraftPrepareOffer | undefined> {
    const available = await this.inspectAuthorizedZone(zoneId, signal, 'crafting', 'campBuilding')
    if (available) return minecraftPrepareOffer(available.observation, available.zone)
  }

  async prepareAutonomousCamp(zoneId: string, offer: MinecraftPrepareOffer, options: AuthorizedPreparationOptions): Promise<{ task: TaskRecord; result: unknown }> {
    const epoch = this.campEpoch
    const { material, batches } = offer
    const { signal, checkPermit, onStep } = options
    if (!Number.isInteger(batches) || batches < 0 || batches > 2) throw new DeviceAuthError(409, 'prepare-budget-invalid')

    for (let completedBatches = 0; ; completedBatches++) {
      signal.throwIfAborted()
      this.assertCampOpen(epoch)
      checkPermit()
      const available = await this.inspectAuthorizedZone(zoneId, signal, 'crafting', 'campBuilding')
      signal.throwIfAborted()
      this.assertCampOpen(epoch)
      checkPermit()
      const next = available && minecraftPrepareOffer(available.observation, available.zone, material)
      if (!available || !next || next.batches > batches - completedBatches) throw new DeviceAuthError(409, 'prepare-preconditions-changed')
      const { id, dimension, x, y, z, radius } = available.zone
      const zone = { id, dimension, x, y, z, radius }

      if (next.batches === 0) {
        const input = MinecraftAuthorizedCampRequest.parse({ zone, material, prepare: true })
        const receipt = await this.action('build', {}, false, signal, undefined, { path: '/build-authorized', input })
        onStep({ action: 'build', taskId: receipt.task.id })
        return receipt
      }

      const input = MinecraftSupplyRequest.parse({ zone, recipe: material })
      const receipt = await this.action('craft', {}, false, signal, undefined, { path: '/camp-supply', input })
      onStep({ action: 'craft', taskId: receipt.task.id })
    }
  }

  buildZones() {
    return this.store.buildZones()
  }

  createBuildZone(input: Parameters<CompanionStore['createBuildZone']>[0]) {
    return this.store.createBuildZone(input)
  }

  async revokeBuildZone(id: string): Promise<boolean> {
    const revoked = this.store.revokeBuildZone(id)
    if (revoked) this.cancelSupply(id, true)
    if (revoked && (this.currentBuildZoneId === id || this.houseRun?.zoneId === id)) await this.stop(false)
    return revoked
  }

  async houses(): Promise<MinecraftHousesView> {
    const worker = await this.request('').catch(() => undefined)
    return { drafts: this.store.minecraftHouses.list().map(draft => this.projectHouseRecovery(draft)),
      available: worker?.capabilities?.houseBuilding === true, revisionsAvailable: true }
  }

  private projectHouseRecovery(draft: MinecraftHouseDraft): MinecraftHouseDraft {
    if (draft.status !== 'interrupted') return draft
    const attemptId = this.store.minecraftHouses.latestAttempt(draft.id)
    const task = attemptId && this.store.taskById(attemptId)
    if (!task || task.capabilityId !== MINECRAFT_HOUSE_CAPABILITY || (task.status !== 'failed' && task.status !== 'cancelled')) return draft
    const decision = minecraftHouseRecoveryDecision(task.status === 'cancelled' ? 'minecraft-house-cancelled' : task.error)
    const saved = this.store.activityByEventId(`${MINECRAFT_HOUSE_RECOVERY_PREFIX}${task.id}`)
    const recovery = saved?.kind === MINECRAFT_HOUSE_RECOVERY_EVENT && saved.taskId === task.id
      ? MinecraftHouseRecovery.safeParse(saved.data).data : undefined
    const agentDecision = this.houseAgentDecision(task.id, draft.layout)
    const previous = recovery?.reason === decision.reason ? recovery : { ...decision, at: task.updatedAt }
    return { ...draft, recovery: agentDecision ? { ...previous, agentDecision } : previous }
  }

  private verifiesRecoveryCell(sourceTaskId: string, layout: MinecraftHouseLayout, childId: string, placed: HouseRecoveryPlacedCell): boolean {
    const child = this.store.taskById(childId)
    return child?.status === 'succeeded' && child.capabilityId === HOUSE_CELL_CAPABILITY && child.contextId === MINECRAFT_RECOVERY_CONTEXT &&
      child.externalId === `${HOUSE_CELL_TASK_PREFIX}${sourceTaskId}:${placed.index}` && minecraftHouseCellTarget(layout, placed.index)?.material === placed.material
  }

  private houseAgentDecision(taskId: string, layout: MinecraftHouseLayout) {
    const event = this.store.activityByEventId(`${HOUSE_AGENT_RECOVERY_PREFIX}${taskId}`)
    const job = event?.taskId && this.store.autonomy.get(event.taskId)
    const decision = event?.kind === HOUSE_AGENT_RECOVERY_EVENT && event.contextId === MINECRAFT_RECOVERY_CONTEXT && job &&
      job.kind === 'minecraft.recovery' && job.contextId === MINECRAFT_RECOVERY_CONTEXT && job.dedupeKey === taskId && job.task.status === 'succeeded' ? event : undefined
    const observed = z.object({ state: z.enum(['ready', 'blocked', 'unavailable']) }).safeParse(decision?.data.observation).data?.state
    const journal = this.store.minecraftHouses.recoveryCells(taskId)
    const confirmed = journal.filter(cell => cell.outcome === 'placed' && this.verifiesRecoveryCell(taskId, layout, cell.taskId, cell))
    const placements = confirmed.map(({ index, material }) => ({ index, material }))
    const latestPlacement = confirmed.at(-1)?.settledAt
    const audit = !journal.length ? this.store.activityByEventId(HOUSE_CELL_AUDIT_PREFIX + taskId) : undefined
    const historicalCell = audit?.kind === HOUSE_CELL_AUDIT_ACTIVITY && audit.contextId === MINECRAFT_RECOVERY_CONTEXT
      ? HouseRecoveryPlacedCell.safeParse(audit.data).data : undefined
    const historical = historicalCell && audit?.taskId && this.verifiesRecoveryCell(taskId, layout, audit.taskId, historicalCell) ? historicalCell : undefined
    const placementAt = historical ? audit?.occurredAt : latestPlacement ?? undefined
    const at = [decision?.occurredAt, placementAt].filter(value => value !== undefined).sort().at(-1)
    const multiple = confirmed[0]?.mode === 'continuous'
    const checked = HouseRecoveryCompletionResult.safeParse(decision?.data.verification).data
    const verification = multiple && checked?.outcome === 'incomplete' && minecraftHouseVerificationMatches(checked.verification, { layout }) ? checked : undefined
    return HouseRecoveryAgentDecision.safeParse({ at, plan: decision?.data.plan, observed,
      ...(multiple ? { placements, verification } : { placed: historical ?? placements[0] }) }).data
  }

  private async probeHouseRecovery(input: MinecraftHouseRequest, task: TaskRecord, reason: string, epoch: number, signal: AbortSignal): Promise<void> {
    const decision = minecraftHouseRecoveryDecision(reason)
    const permitted = () => !signal.aborted && this.campEpoch === epoch && !this.campControl().pausedAt &&
      !this.visitActionPermit && this.store.taskById(task.id)?.status === 'failed' && !!this.store.buildZoneById(input.zone.id)
    if (decision.next === 'check-safety' || !permitted()) return
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(HOUSE_RECOVERY_PROBE_MS)])
    const result = await this.campRequest('/house/preview', input, epoch, probeSignal).catch(() => undefined)
    if (!permitted()) return
    const preview = MinecraftHousePreview.safeParse(result).data
    const verified = preview && (!preview.ready || preview.checked === input.layout.blocks.length) ? preview : undefined
    const next = verified && !verified.ready && verified.reason ? minecraftHouseRecoveryDecision(verified.reason).next : decision.next
    const recovery: MinecraftHouseRecovery = { ...decision, next, at: new Date().toISOString(),
      verification: verified ? (verified.ready ? 'ready' : 'blocked') : 'unavailable' }
    this.store.recordActivity({ eventId: `${MINECRAFT_HOUSE_RECOVERY_PREFIX}${task.id}`, contextId: 'game.minecraft', sessionId: task.sessionId,
      taskId: task.id, source: 'game.minecraft', kind: MINECRAFT_HOUSE_RECOVERY_EVENT, summary: '小屋中断后已尝试重新核对现场', status: 'info', data: recovery })
  }

  recoverySources(now: number): HouseRecoverySource[] {
    return this.store.minecraftHouses.recentInterruptedAttempts(new Date(now - HOUSE_RECOVERY_TTL_MS).toISOString())
      .flatMap(taskId => {
        const source = this.recoverySource(taskId)
        return source ? [source] : []
      })
  }

  recoverySource(taskId: string): HouseRecoverySource | undefined {
    const draft = this.store.minecraftHouses.interruptedByAttempt(taskId)
    const task = this.store.taskById(taskId)
    if (!draft?.zoneId || !this.store.buildZoneById(draft.zoneId) || task?.status !== 'failed' ||
      task.capabilityId !== MINECRAFT_HOUSE_CAPABILITY || task.contextId !== 'game.minecraft' || this.campControl().pausedAt) return
    const event = this.store.activityByEventId(`${MINECRAFT_HOUSE_RECOVERY_PREFIX}${taskId}`)
    if (event?.kind !== MINECRAFT_HOUSE_RECOVERY_EVENT || event.taskId !== taskId || event.contextId !== 'game.minecraft') return
    const recovery = MinecraftHouseRecovery.safeParse(event.data).data
    if (!recovery?.verification || recovery.reason !== minecraftHouseRecoveryDecision(task.error).reason) return
    const at = Date.parse(recovery.at)
    const age = Date.now() - at
    if (!Number.isFinite(age) || age < 0 || age >= HOUSE_RECOVERY_TTL_MS || at < Date.parse(task.updatedAt)) return
    return { taskId, at: recovery.at, reason: recovery.reason, verification: recovery.verification }
  }

  async resurveyRecovery(taskId: string, signal: AbortSignal): Promise<HouseRecoveryObservation> {
    const source = this.recoverySource(taskId)
    const draft = this.store.minecraftHouses.interruptedByAttempt(taskId)
    const zoneId = draft?.zoneId
    if (!source || !draft || !zoneId) throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
    const epoch = this.campEpoch
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(HOUSE_RECOVERY_PROBE_MS)])
    const preview = await (async () => {
      const { input } = await this.houseInput(draft.id, zoneId, readSignal)
      return MinecraftHousePreview.safeParse(await this.campRequest('/house/preview', input, epoch, readSignal)).data
    })().catch(() => undefined)
    signal.throwIfAborted()
    if (!this.recoverySource(taskId) || this.campEpoch !== epoch) throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
    if (!preview || this.worldBusy() || this.visitActionPermit || preview.checked > draft.layout.blocks.length ||
      (preview.ready && preview.checked !== draft.layout.blocks.length)) return { state: 'unavailable' }
    if (preview.ready) return { state: 'ready', checked: preview.checked }
    const planned = minecraftHouseMaterials(draft.layout)
    const materials = preview.checked === draft.layout.blocks.length && preview.materials?.every(row => row.needed <= (planned[row.material] ?? 0))
      ? preview.materials : undefined
    return { state: 'blocked', checked: preview.checked, ...(materials && { materials }),
      ...(preview.reason && { reason: minecraftHouseRecoveryDecision(preview.reason).reason }) }
  }

  async recoveryPlacementAvailable(taskId: string, signal: AbortSignal): Promise<boolean> {
    const zoneId = this.store.minecraftHouses.interruptedByAttempt(taskId)?.zoneId
    if (!zoneId || !this.recoverySource(taskId) || this.visitActionPermit) return false
    const current = await this.authorizedZone(zoneId, AbortSignal.any([signal, AbortSignal.timeout(5000)]), 'houseBuilding', 'houseCellPlacement')
    return !!current && !this.visitActionPermit && !!this.recoverySource(taskId)
  }

  private async recoveryCellInput(taskId: string, signal: AbortSignal) {
    const draft = this.store.minecraftHouses.interruptedByAttempt(taskId)
    if (!draft?.zoneId || !this.recoverySource(taskId)) throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
    return (await this.houseInput(draft.id, draft.zoneId, signal, true)).input
  }

  async recoveryCandidates(taskId: string, signal: AbortSignal): Promise<MinecraftHouseCellCandidates> {
    const epoch = this.campEpoch
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(HOUSE_RECOVERY_PROBE_MS)])
    const input = await this.recoveryCellInput(taskId, readSignal)
    const result = MinecraftHouseCellCandidates.safeParse(await this.campRequest('/house/candidates', input, epoch, readSignal)).data
    readSignal.throwIfAborted()
    if (!this.recoverySource(taskId) || this.worldBusy() || this.visitActionPermit) throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
    if (!result || !minecraftHouseCandidatesMatch(result, input)) throw new DeviceAuthError(502, 'minecraft-house-candidates-unconfirmed')
    return result
  }

  private continuousHouseRecoveryAuthorized(): boolean {
    const settings = this.store.autonomy.settings()
    return settings.enabled === true && settings.minecraftRecoveryEnabled === true &&
      settings.minecraftRecoveryPlacementEnabled === true && settings.minecraftRecoveryContinuousEnabled === true
  }

  private recoveryPlacementReceipt(sourceTaskId: string, request: MinecraftHouseRequest): MinecraftHouseReceipt | undefined {
    const journal = this.store.minecraftHouses.recoveryCells(sourceTaskId)
    const limit = HOUSE_RECOVERY_PLACEMENT_LIMITS.continuous
    if (journal.length > limit.attempts || this.store.minecraftHouses.hasUnjournaledRecoveryCell(sourceTaskId) ||
      journal.some(entry => entry.mode !== 'continuous' || entry.outcome === 'started' || entry.outcome === 'unconfirmed')) return
    const placed = journal.filter(entry => entry.outcome === 'placed')
    if (!placed.length || placed.length > limit.placed || placed.some(entry =>
      !entry.settledAt || !this.verifiesRecoveryCell(sourceTaskId, request.layout, entry.taskId, entry))) return
    const consumed: MinecraftHouseReceipt['consumed'] = {}
    for (const { material } of placed) consumed[material] = (consumed[material] ?? 0) + 1
    return MinecraftHouseReceipt.parse({ built: true, zoneId: request.zone.id, checked: request.layout.blocks.length, placed: placed.length, consumed })
  }

  async verifyRecoveryCompletion(sourceTaskId: string, signal: AbortSignal, assertAuthorized: () => void): Promise<HouseRecoveryCompletionResult> {
    assertAuthorized()
    const source = this.recoverySource(sourceTaskId)
    const draft = this.store.minecraftHouses.interruptedByAttempt(sourceTaskId)
    if (!source || !draft?.zoneId) throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
    const epoch = this.campEpoch
    const controller = new AbortController()
    const readSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(HOUSE_RECOVERY_VERIFY_MS)])
    const { input, revision } = await this.houseInput(draft.id, draft.zoneId, readSignal, true)
    const externalId = `${HOUSE_COMPLETION_TASK_PREFIX}${sourceTaskId}`
    const { promise: settled, resolve } = Promise.withResolvers<void>()
    const run = { zoneId: input.zone.id, controller, settled }
    const confirmAuthority = () => {
      readSignal.throwIfAborted()
      assertAuthorized()
      this.assertCampOpen(epoch)
      if (!this.continuousHouseRecoveryAuthorized()) throw new DeviceAuthError(403, 'minecraft-house-continuous-not-authorized')
      const latest = this.recoverySource(sourceTaskId)
      const current = this.store.minecraftHouses.interruptedByAttempt(sourceTaskId)
      if (latest?.at !== source.at || current?.id !== draft.id || current.zoneId !== input.zone.id || (current.revision ?? 0) !== revision ||
        this.worldBusy(run) || this.visitActionPermit || this.store.taskByExternalId(externalId)) {
        throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
      }
      const receipt = this.recoveryPlacementReceipt(sourceTaskId, input)
      if (!receipt || !minecraftHouseReceiptMatches(receipt, input)) throw new DeviceAuthError(409, 'minecraft-house-recovery-placement-unconfirmed')
      return receipt
    }
    confirmAuthority()
    this.houseRun = run
    try {
      const verification = MinecraftHouseVerification.safeParse(await this.campRequest('/house/verify', input, epoch, readSignal)).data
      const receipt = confirmAuthority()
      if (!verification || !minecraftHouseVerificationMatches(verification, input)) {
        throw new DeviceAuthError(502, 'minecraft-house-verification-unconfirmed')
      }
      if (verification.matched !== verification.checked) return { outcome: 'incomplete', verification }
      this.store.transaction(() => {
        const binding = this.store.bindingByContext('game.minecraft')
        const task = this.store.createTask({ externalId, capabilityId: MINECRAFT_HOUSE_CAPABILITY, contextId: 'game.minecraft',
          sessionId: binding?.sessionId, title: 'Minecraft：小屋完工核验' })
        this.store.transitionTask(task.id, 'running')
        if (!this.store.minecraftHouses.completeRecovery(draft.id, input.zone.id, sourceTaskId, task.id, revision, receipt)) {
          throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
        }
        this.recordHouseCompletion(task, receipt)
      })
      this.housePreviews.delete(draft.id)
      return { outcome: 'completed', verification, placed: receipt.placed }
    } finally {
      this.houseRun = undefined
      if (this.creativeForBuild) {
        this.creativeForBuild = false
        await this.setGameMode('survival').catch(() => {})
      }
      resolve()
    }
  }

  recoveryCompletionValid(sourceTaskId: string, result: HouseRecoveryCompletionResult): boolean {
    if (result.outcome !== 'completed') return false
    const verification = MinecraftHouseVerification.safeParse(result.verification).data
    const source = this.store.taskById(sourceTaskId)
    const task = this.store.taskByExternalId(`${HOUSE_COMPLETION_TASK_PREFIX}${sourceTaskId}`)
    if (!verification || verification.matched !== verification.checked || source?.status !== 'failed' ||
      source.contextId !== 'game.minecraft' || source.capabilityId !== MINECRAFT_HOUSE_CAPABILITY ||
      task?.status !== 'succeeded' || task.contextId !== 'game.minecraft' || task.capabilityId !== MINECRAFT_HOUSE_CAPABILITY) return false
    const draft = this.store.minecraftHouses.byBuildTask(task.id)
    const zone = draft?.zoneId && this.store.buildZoneById(draft.zoneId)
    const saved = draft?.receipt
    if (!saved || !draft || !zone) return false
    const input = { zone, layout: draft.layout }
    const receipt = this.recoveryPlacementReceipt(sourceTaskId, input)
    if (!receipt || receipt.placed !== result.placed || saved.placed !== receipt.placed ||
      !minecraftHouseReceiptMatches(saved, input) || !minecraftHouseVerificationMatches(verification, input) ||
      Object.entries(receipt.consumed).some(([material, count]) => saved.consumed[material as keyof MinecraftHouseReceipt['consumed']] !== count)) return false
    const activity = this.store.activityByTask(task.id, MINECRAFT_HOUSE_EVENT, 'game.minecraft')
    return activity?.source === 'game.minecraft' && activity.status === 'success' && activity.sessionId === task.sessionId &&
      activity.summary === minecraftHouseBuildSummary(receipt) && Object.keys(activity.data).length === 0
  }

  async placeRecoveryCell(taskId: string, index: number, signal: AbortSignal, mode: HouseRecoveryPlacementMode = 'single'): Promise<MinecraftHouseCellReceipt> {
    const epoch = this.campEpoch
    const input = MinecraftHouseCellRequest.safeParse({ ...await this.recoveryCellInput(taskId, signal), index }).data
    const cell = input && minecraftHouseCellTarget(input.layout, index)
    if (!input || !cell) throw new DeviceAuthError(400, 'minecraft-house-cell-invalid')
    signal.throwIfAborted()
    this.assertCampOpen(epoch)
    const draft = this.store.minecraftHouses.interruptedByAttempt(taskId)
    if (!draft || !this.recoverySource(taskId) || this.worldBusy() || this.visitActionPermit) throw new DeviceAuthError(409, 'minecraft-house-recovery-source-changed')
    const externalId = `${HOUSE_CELL_TASK_PREFIX}${taskId}:${index}`
    const { promise: settled, resolve } = Promise.withResolvers<void>()
    const run = { zoneId: input.zone.id, controller: new AbortController(), settled }
    const actionSignal = AbortSignal.any([signal, run.controller.signal])
    const task = this.store.transaction(() => {
      if (mode === 'continuous' && !this.continuousHouseRecoveryAuthorized()) {
        throw new DeviceAuthError(403, 'minecraft-house-continuous-not-authorized')
      }
      const journal = this.store.minecraftHouses.recoveryCells(taskId)
      const limit = HOUSE_RECOVERY_PLACEMENT_LIMITS[mode]
      if (this.store.taskByExternalId(externalId) || this.store.minecraftHouses.hasUnjournaledRecoveryCell(taskId) ||
        journal.some(entry => entry.mode !== mode) || journal.length >= limit.attempts ||
        journal.filter(entry => entry.outcome === 'placed').length >= limit.placed) {
        throw new DeviceAuthError(409, 'minecraft-house-cell-already-attempted')
      }
      if (journal.some(entry => entry.outcome === 'started' || entry.outcome === 'unconfirmed')) {
        throw new DeviceAuthError(409, 'minecraft-house-cell-unconfirmed')
      }
      const accepted = this.store.createTask({ externalId, capabilityId: HOUSE_CELL_CAPABILITY, contextId: MINECRAFT_RECOVERY_CONTEXT,
        title: `Minecraft：小屋蓝图格 ${index + 1}` })
      this.store.minecraftHouses.startRecoveryCell(taskId, accepted.id, cell, mode)
      return this.store.transitionTask(accepted.id, 'running')
    })
    this.housePreviews.delete(draft.id)
    this.houseRun = run
    try {
      // Dispatch checks the current grant. A received physical receipt remains evidence even if the model's turn has ended.
      const receipt = MinecraftHouseCellReceipt.safeParse(await this.request('/house/cell', 'POST', input, actionSignal, epoch)).data
      if (!receipt || !minecraftHouseCellMatches(receipt, input)) throw new DeviceAuthError(502, 'minecraft-house-cell-unconfirmed')
      this.store.transaction(() => {
        if (this.store.taskById(task.id)?.status !== 'running' || !this.store.minecraftHouses.settleRecoveryCell(task.id, receipt.outcome)) {
          throw new DeviceAuthError(409, 'minecraft-house-cell-unconfirmed')
        }
        this.store.transitionTask(task.id, receipt.outcome === 'blocked' ? 'failed' : 'succeeded', receipt.outcome === 'blocked' ? receipt.reason : undefined)
        if (receipt.outcome !== 'placed') return
        const summary = `在 Coopcraft 恢复中断的小屋施工时，实际放置并核对了一块${HOUSE_CELL_NAMES[receipt.material]}。`
        const activityId = this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: HOUSE_CELL_ACTIVITY,
          summary, status: 'success', data: { material: receipt.material, placed: 1 } })
        const auditId = mode === 'continuous' ? `${HOUSE_CELL_AUDIT_PREFIX}${taskId}:${index}` : HOUSE_CELL_AUDIT_PREFIX + taskId
        this.store.recordActivity({ eventId: auditId, contextId: MINECRAFT_RECOVERY_CONTEXT, taskId: task.id,
          source: 'game.minecraft', kind: HOUSE_CELL_AUDIT_ACTIVITY, summary, status: 'success', data: { index, material: receipt.material } })
        const evidence = { contextId: 'game.minecraft', activityId }
        const memory = this.store.memory.create({ kind: 'experience', content: summary, contextId: 'game.minecraft', scope: 'shared', status: 'active',
          confidence: 1, importance: 0.55, sourceRefs: [evidence], reason: 'minecraft-house-cell-verified' })
        if (!memory.sourceRefs.some(ref => ref.activityId === activityId)) {
          this.store.memory.update(memory.id, { sourceRefs: [evidence], reason: 'minecraft-house-cell-verified' })
        }
      })
      return receipt
    } catch (error) {
      this.store.transaction(() => {
        this.store.minecraftHouses.settleRecoveryCell(task.id, 'unconfirmed')
        if (this.store.taskById(task.id)?.status === 'running') {
          this.store.transitionTask(task.id, actionSignal.aborted ? 'cancelled' : 'failed', 'minecraft-house-cell-unconfirmed')
        }
      })
      throw error
    } finally {
      this.houseRun = undefined
      resolve()
    }
  }

  houseHistory(id: string) {
    const history = this.store.minecraftHouses.history(id)
    if (!history) throw new DeviceAuthError(404, 'minecraft-house-not-found')
    return history
  }

  reviseHouse(id: string, input: MinecraftHouseRevisionInput): MinecraftHouseDraft {
    const draft = this.store.minecraftHouses.get(id)
    if (!draft) throw new DeviceAuthError(404, 'minecraft-house-not-found')
    if (draft.status !== 'draft') throw new DeviceAuthError(409, 'minecraft-house-revision-locked')
    if ((draft.revision ?? 0) !== input.expectedRevision) throw new DeviceAuthError(409, 'minecraft-house-revision-stale')
    if (!MinecraftHouseLayout.safeParse({ ...draft.layout, blocks: input.blocks }).success) {
      throw new DeviceAuthError(400, 'minecraft-house-revision-invalid')
    }
    const revised = this.store.minecraftHouses.revise(id, input)
    if (!revised) throw new DeviceAuthError(409, 'minecraft-house-revision-stale')
    if (revised.revision !== draft.revision) this.housePreviews.delete(id)
    return revised
  }

  private editableHouse(id: string, zoneId: string): MinecraftHouseDraft {
    const draft = this.store.minecraftHouses.get(id)
    if (!draft) throw new DeviceAuthError(404, 'minecraft-house-not-found')
    if (draft.zoneId && draft.zoneId !== zoneId) throw new DeviceAuthError(409, 'minecraft-house-zone-mismatch')
    if (draft.status !== 'draft' && draft.status !== 'interrupted') throw new DeviceAuthError(409, 'minecraft-house-not-editable')
    return draft
  }

  private async houseInput(id: string, zoneId: string, signal: AbortSignal, cellPlacement = false) {
    const draft = this.editableHouse(id, zoneId)
    if (!this.store.buildZoneById(zoneId)) throw new DeviceAuthError(404, 'build-zone-not-found')
    if (this.visitActionPermit) throw new DeviceAuthError(409, 'minecraft-house-visit-busy')
    const zone = await this.authorizedZone(zoneId, signal, cellPlacement ? 'houseCellPlacement' : 'houseBuilding')
    if (!zone || this.visitActionPermit) throw new DeviceAuthError(409, 'minecraft-house-unavailable')
    const { id: authorizedId, dimension, x, y, z, radius } = zone
    const input = MinecraftHouseRequest.parse({ zone: { id: authorizedId, dimension, x, y, z, radius }, layout: draft.layout })
    return { input, revision: draft.revision ?? 0 }
  }

  async previewHouse(id: string, zoneId: string, signal: AbortSignal, expectedRevision?: number): Promise<MinecraftHouseSitePreview> {
    const epoch = this.campEpoch
    const { input, revision } = await this.houseInput(id, zoneId, signal)
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new DeviceAuthError(409, 'minecraft-house-revision-stale')
    const checkRevision = () => {
      if ((this.editableHouse(id, zoneId).revision ?? 0) !== revision) throw new DeviceAuthError(409, 'minecraft-house-revision-stale')
    }
    checkRevision()
    this.housePreviews.delete(id)
    const preview = MinecraftHousePreview.safeParse(await this.campRequest('/house/preview', input, epoch, signal)).data
    signal.throwIfAborted()
    checkRevision()
    if (!preview || preview.ready && preview.checked !== input.layout.blocks.length) throw new DeviceAuthError(502, 'minecraft-house-preview-unconfirmed')
    if (!preview.ready && !preview.materials) return preview
    const siteStillAvailable = this.store.buildZoneById(zoneId) && !this.worldBusy() && !this.visitActionPermit
    if (!preview.ready) {
      const { materials, ...failure } = preview
      if (!materials || !siteStillAvailable || preview.checked !== input.layout.blocks.length) return failure
      const planned = minecraftHouseMaterials(input.layout)
      return materials.every(row => row.needed <= (planned[row.material] ?? 0)) ? preview : failure
    }
    if (!siteStillAvailable) return { ready: false, checked: preview.checked, reason: 'minecraft-house-unavailable' }
    for (const [draftId, approval] of this.housePreviews) if (approval.expiresAt <= Date.now()) this.housePreviews.delete(draftId)
    const previewId = randomUUID()
    this.housePreviews.set(id, { id: previewId, zoneId, epoch, revision, expiresAt: Date.now() + HOUSE_PREVIEW_TTL_MS })
    return { ...preview, previewId }
  }

  authorizeHouseSite(id: string, zoneId: string): MinecraftHouseDraft {
    this.assertCampOpen()
    if (!this.store.buildZoneById(zoneId) || !this.store.minecraftHouses.bindDraftZone(id, zoneId)) {
      throw new DeviceAuthError(409, 'minecraft-house-site-not-authorized')
    }
    return this.store.minecraftHouses.get(id)!
  }

  async modelBuildHouse(id: string, signal: AbortSignal): Promise<unknown> {
    const draft = this.store.minecraftHouses.get(id)
    if (!draft?.zoneId || !this.store.buildZoneById(draft.zoneId)) throw new DeviceAuthError(409, 'minecraft-house-site-not-authorized')
    if (draft.status === 'built') return { built: true, house: draft }
    const preview = await this.previewHouse(id, draft.zoneId, signal)
    if (!preview.ready || !preview.previewId) return { built: false, ...preview }
    return { built: true, house: await this.buildHouse(id, draft.zoneId, preview.previewId, signal) }
  }

  async teleport(input: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<unknown> {
    const result = await this.request('/api/teleport', 'POST', input, signal)
    this.store.recordActivity({ contextId: 'game.minecraft', source: 'game.minecraft', kind: 'world.teleport',
      summary: '按主人要求传送到大肥鱼指定坐标', status: 'success', data: { target: input } })
    return result
  }

  async setGameMode(mode: 'creative' | 'survival', signal?: AbortSignal): Promise<unknown> {
    return this.request('/api/gamemode', 'POST', { mode }, signal)
  }

  markCreativeForBuild(): void {
    this.creativeForBuild = true
  }

  creativeBuildAllowed(): boolean {
    return !!this.houseRun || this.store.minecraftHouses.list().some(draft => draft.zoneId !== null && draft.status !== 'built')
  }

  async buildHouse(id: string, zoneId: string, previewId: string, callerSignal?: AbortSignal, assertAuthorized?: () => void): Promise<MinecraftHouseDraft> {
    const existing = this.store.minecraftHouses.get(id)
    if (existing?.status === 'built' && existing.zoneId === zoneId) return existing
    const epoch = this.campEpoch
    const approval = this.housePreviews.get(id)
    const validApproval = () => approval?.id === previewId && approval.zoneId === zoneId && approval.epoch === epoch &&
      this.housePreviews.get(id) === approval && approval.expiresAt > Date.now()
    if (!validApproval()) throw new DeviceAuthError(409, 'minecraft-house-preview-required')
    const { promise: settled, resolve } = Promise.withResolvers<void>()
    const run = { zoneId, controller: new AbortController(), settled }
    const signal = callerSignal ? AbortSignal.any([callerSignal, run.controller.signal]) : run.controller.signal
    const { input, revision } = await this.houseInput(id, zoneId, signal)
    this.assertCampOpen(epoch)
    if (!validApproval() || approval?.revision !== revision || this.worldBusy() || this.visitActionPermit) {
      throw new DeviceAuthError(409, 'minecraft-house-preview-required')
    }
    assertAuthorized?.()
    const binding = this.store.bindingByContext('game.minecraft')
    const task = this.store.transaction(() => {
      const accepted = this.store.createTask({ capabilityId: MINECRAFT_HOUSE_CAPABILITY, contextId: 'game.minecraft',
        sessionId: binding?.sessionId, title: 'Minecraft：小屋建造' })
      if (!this.store.minecraftHouses.start(id, zoneId, accepted.id, revision)) throw new DeviceAuthError(409, 'minecraft-house-not-editable')
      return this.store.transitionTask(accepted.id, 'running')
    })
    this.housePreviews.delete(id)
    this.houseRun = run
    try {
      const receipt = MinecraftHouseReceipt.safeParse(await this.campRequest('/house/build', input, epoch, signal)).data
      signal.throwIfAborted()
      if (!this.store.buildZoneById(zoneId) || this.store.taskById(task.id)?.status !== 'running') throw new DeviceAuthError(409, 'minecraft-house-cancelled')
      if (!receipt || !minecraftHouseReceiptMatches(receipt, input)) throw new DeviceAuthError(502, 'minecraft-house-receipt-unconfirmed')
      this.store.transaction(() => {
        if (!this.store.minecraftHouses.finish(id, task.id, receipt)) throw new DeviceAuthError(409, 'minecraft-house-cancelled')
        this.recordHouseCompletion(task, receipt)
      })
      return this.store.minecraftHouses.get(id)!
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'minecraft-house-unconfirmed'
      this.store.transaction(() => {
        this.store.minecraftHouses.finish(id, task.id)
        if (this.store.taskById(task.id)?.status === 'running') {
          this.store.transitionTask(task.id, signal.aborted ? 'cancelled' : 'failed', reason)
        }
      })
      await this.probeHouseRecovery(input, task, reason, epoch, signal).catch(() => {})
      if (signal.aborted) throw new DeviceAuthError(409, 'minecraft-house-cancelled')
      throw error
    } finally {
      this.houseRun = undefined
      resolve()
    }
  }

  private recordHouseCompletion(task: TaskRecord, receipt: MinecraftHouseReceipt): void {
    this.store.transitionTask(task.id, 'succeeded')
    const summary = minecraftHouseBuildSummary(receipt)
    const activityId = this.store.recordActivity({ contextId: 'game.minecraft', sessionId: task.sessionId,
      taskId: task.id, source: 'game.minecraft', kind: MINECRAFT_HOUSE_EVENT, summary, status: 'success' })
    this.store.memory.create({ kind: 'experience', content: summary, contextId: 'game.minecraft', scope: 'shared',
      status: 'active', confidence: 1, importance: 0.65, sourceRefs: [{ contextId: 'game.minecraft', taskId: task.id, activityId }],
      actorSessionId: task.sessionId, reason: 'minecraft-house-verified' })
  }

  async houseProjects(): Promise<MinecraftHouseProjectsView> {
    this.reconcileHouseRuns()
    const worker = await this.request('').catch(() => undefined)
    return { available: worker?.online === true && worker?.capabilities?.houseProjects === true,
      projects: this.store.minecraftHouseProjects.list() }
  }

  previewHouseProjectImport(input: MinecraftHouseProjectImportInput) {
    const zone = this.store.buildZoneById(input.zoneId)
    if (!zone) throw new DeviceAuthError(404, 'build-zone-not-found')
    const { id, dimension, x, y, z, radius } = zone
    const preview = planMinecraftHouseProjectImport(input, { id, dimension, x, y, z, radius })
    if (typeof preview === 'string') throw new DeviceAuthError(400, preview)
    return preview
  }

  placeStatus() {
    const named = new Set(this.store.minecraftPlaces.list().map(place => place.projectId))
    return {
      places: this.store.minecraftPlaces.list().map(({ memoryId: _memory, ...place }) => place),
      availableProjects: this.store.minecraftHouseProjects.list().filter(project =>
        !named.has(project.id) && this.store.buildZoneById(project.zoneId) &&
        project.sections.every(section => section.status === 'built') && project.verification?.matched === true &&
        project.verification.checked === project.sections.reduce((total, section) => total + section.layout.blocks.length, 0))
        .map(project => ({ id: project.id, name: project.name, verifiedAt: project.verification!.checkedAt })),
    }
  }

  nameHouseProjectPlace(projectId: string, input: string, actor: 'owner' | 'companion' = 'owner', signal?: AbortSignal) {
    const id = z.uuid().parse(projectId)
    const name = MinecraftPlaceName.parse(input)
    const project = this.houseProject(id)
    const verification = project.verification
    if (project.sections.some(section => section.status !== 'built') || verification?.matched !== true ||
      verification.checked !== project.sections.reduce((total, section) => total + section.layout.blocks.length, 0)) {
      throw new DeviceAuthError(409, 'minecraft-place-verification-required')
    }
    const zone = this.store.buildZoneById(project.zoneId)!
    const conflict = this.store.minecraftPlaces.byName(name)
    if (conflict && conflict.projectId !== id) throw new DeviceAuthError(409, 'minecraft-place-name-conflict')
    const previous = this.store.minecraftPlaces.byProject(id)
    if (previous?.name === name) return { place: previous, outcome: 'unchanged' as const, project }
    const sessionId = this.store.bindingByContext('game.minecraft')?.sessionId
    return this.store.transaction(() => {
      signal?.throwIfAborted()
      if (this.store.buildZoneById(project.zoneId)?.updatedAt !== zone.updatedAt) throw new DeviceAuthError(409, 'build-zone-not-found')
      const latest = this.store.minecraftPlaces.byName(name)
      if (latest && latest.projectId !== id) throw new DeviceAuthError(409, 'minecraft-place-name-conflict')
      const location = { dimension: zone.dimension, x: zone.x, y: zone.y, z: zone.z, verifiedAt: verification.checkedAt }
      const task = this.store.createTask({ contextId: 'game.minecraft', sessionId, capabilityId: MINECRAFT_PLACE_CAPABILITY,
        title: `Minecraft 建筑地点命名：${name}` })
      this.store.transitionTask(task.id, 'running')
      const memory = previous
        ? this.store.memory.update(previous.memoryId, { content: minecraftPlaceFact({ ...previous, name }), actorSessionId: sessionId,
          reason: 'minecraft-place-renamed' })
        : this.store.memory.create({ kind: 'event', content: minecraftPlaceFact({ ...location, name }), contextId: 'game.minecraft',
          scope: 'shared', status: 'active', confidence: 1, importance: 0.65, actorSessionId: sessionId,
          sourceRefs: [], reason: 'minecraft-place-named' })
      const { place } = this.store.minecraftPlaces.save(id, name, memory.id, location)
      const summary = previous ? `Minecraft 建筑地点「${previous.name}」改名为「${name}」` : `Minecraft 建筑地点命名为「${name}」`
      const activityId = this.store.recordActivity({ contextId: 'game.minecraft', sessionId, taskId: task.id, source: 'game.minecraft',
        kind: MINECRAFT_PLACE_EVENT, summary, status: 'success', data: { projectId: id, placeId: place.id, actor, ...location } })
      this.store.memory.update(memory.id, { sourceRefs: [{ contextId: 'game.minecraft', sessionId, taskId: task.id, activityId }],
        actorSessionId: sessionId, reason: 'minecraft-place-source-confirmed' })
      this.store.transitionTask(task.id, 'succeeded')
      return { place, outcome: previous ? 'renamed' as const : 'named' as const, taskId: task.id,
        project: this.store.minecraftHouseProjects.get(id)! }
    })
  }

  createHouseProject(input: MinecraftHouseProjectInput) {
    const zone = this.store.buildZoneById(input.zoneId)
    if (!zone) throw new DeviceAuthError(404, 'build-zone-not-found')
    const { id, dimension, x, y, z, radius } = zone
    if (!minecraftHouseProjectRequests(input, { id, dimension, x, y, z, radius })) {
      throw new DeviceAuthError(400, 'minecraft-house-project-zone-invalid')
    }
    return this.store.minecraftHouseProjects.create(input)
  }

  private houseProject(id: string) {
    this.reconcileHouseRuns()
    const project = this.store.minecraftHouseProjects.get(id)
    if (!project) throw new DeviceAuthError(404, 'minecraft-house-project-not-found')
    if (!this.store.buildZoneById(project.zoneId)) throw new DeviceAuthError(404, 'build-zone-not-found')
    return project
  }

  private houseProjectSection(id: string, index: number) {
    const project = this.houseProject(id)
    const section = project.sections[index]
    if (!section) throw new DeviceAuthError(404, 'minecraft-house-project-section-not-found')
    return { project, section }
  }

  private async houseProjectInputs(project: MinecraftHouseProjectInput, signal: AbortSignal, recovery = false, supply = false) {
    if (this.visitActionPermit || this.worldBusy()) throw new DeviceAuthError(409, 'minecraft-house-project-busy')
    const zone = await this.authorizedZone(project.zoneId, signal, 'houseBuilding', 'houseProjects',
      ...(recovery ? ['houseRecovery'] as const : []), ...(supply ? ['crafting'] as const : []))
    if (!zone || this.visitActionPermit) throw new DeviceAuthError(409, 'minecraft-house-project-unavailable')
    const { id, dimension, x, y, z, radius } = zone
    const requests = minecraftHouseProjectRequests(project, { id, dimension, x, y, z, radius })
    if (!requests) throw new DeviceAuthError(409, 'minecraft-house-project-zone-invalid')
    return requests
  }

  private async houseProjectRecoveryAvailable(signal: AbortSignal): Promise<boolean> {
    const worker = await this.request('', 'GET', undefined, signal)
    signal.throwIfAborted()
    return worker?.online === true && worker.auth?.mode === 'cbi' && worker.capabilities?.houseRecovery === true
  }

  async observeHouseProjectPlan(ownerText: string, signal: AbortSignal): Promise<HouseProjectPlanObservationResult> {
    signal.throwIfAborted()
    this.reconcileHouseRuns()
    const unfinished = this.store.minecraftHouseProjects.list().filter(project =>
      this.store.buildZoneById(project.zoneId) && project.sections.some(section => section.status === 'pending' || section.status === 'interrupted'))
    const selector = /(?:建筑工程|建造工程|建筑项目|建造项目)\s*(?:「(?<quoted>[^」\r\n]{1,80})」|《(?<book>[^》\r\n]{1,80})》)(?:\s*#(?<id>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?/iu.exec(ownerText)?.groups
    const name = selector?.quoted ?? selector?.book
    const id = selector?.id?.toLowerCase()
    const matches = name ? unfinished.filter(project => project.name === name && (!id || project.id === id)) : unfinished
    if (!matches.length) return { status: 'no-project' }
    if (matches.length > 1) return { status: 'choose-project', projects: matches.slice(0, 6).map(project =>
      unfinished.some(other => other.id !== project.id && other.name === project.name) ? `「${project.name}」 #${project.id}` : project.name) }

    const project = matches[0]!
    const epoch = this.campEpoch
    const generation = this.houseProjectPlanGeneration
    const observedAt = new Date().toISOString()
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(HOUSE_PROJECT_PLAN_SWEEP_MS)])
    const guard = () => {
      bounded.throwIfAborted()
      this.assertCampOpen(epoch)
      this.houseProject(project.id)
      if (generation !== this.houseProjectPlanGeneration || this.worldBusy() || this.visitActionPermit) {
        throw new DeviceAuthError(409, 'minecraft-house-project-plan-stale')
      }
    }
    const inputs = await this.houseProjectInputs(project, bounded)
    const recoveryAvailable = project.sections.some(houseProjectCanRecover) && await this.houseProjectRecoveryAvailable(bounded)
    const options: HouseProjectPlanObservation['options'] = []
    for (const [section, state] of project.sections.entries()) {
      if (state.status !== 'pending' && state.status !== 'interrupted') continue
      guard()
      const recovery = recoveryAvailable && houseProjectCanRecover(state)
      const { ready, reason, materials } = await this.readHouseProjectSection(inputs[section]!, epoch, bounded, recovery)
      const previousReason = MinecraftHousePreview.shape.reason.safeParse(state.reason).data
      options.push({ section, name: state.name, status: state.status, ready, reason, materials, previousReason,
        ...(recovery && { recovery: true as const }) })
    }
    guard()
    const observation = { projectName: project.name, observedAt, options }
    this.houseProjectPlanObservations.set(observation, { id: project.id, epoch, generation })
    return { status: 'observed', observation }
  }

  async recordHouseProjectPlan(observation: HouseProjectPlanObservation, input: HouseProjectPlanInput, signal: AbortSignal, assertCurrent?: () => void) {
    signal.throwIfAborted()
    const source = this.houseProjectPlanObservations.get(observation)
    const stale = () => new DeviceAuthError(409, 'minecraft-house-project-plan-stale')
    if (!source) throw stale()
    const guard = () => {
      signal.throwIfAborted()
      const age = Date.now() - Date.parse(observation.observedAt)
      this.assertCampOpen(source.epoch)
      if (this.houseProjectPlanObservations.get(observation) !== source || age < 0 || age >= HOUSE_PREVIEW_TTL_MS ||
        source.generation !== this.houseProjectPlanGeneration || this.worldBusy() || this.visitActionPermit) throw stale()
      return this.houseProject(source.id)
    }
    const project = guard()
    const choice = HouseProjectPlanInput.safeParse(input).data
    if (!choice || !houseProjectPlanMatches(choice, observation.options)) throw new DeviceAuthError(400, 'minecraft-house-project-plan-invalid')
    const recovery = choice.action === 'build' && observation.options.find(option => option.section === choice.section)?.recovery === true
    await this.houseProjectInputs(project, AbortSignal.any([signal, AbortSignal.timeout(5000)]), recovery)
    assertCurrent?.()
    const current = guard()
    if (observation.options.some(option => {
      const state = current.sections[option.section]
      return state?.status !== option.status || state.name !== option.name ||
        MinecraftHousePreview.shape.reason.safeParse(state.reason).data !== option.previousReason
    })) throw stale()
    const plan = HouseProjectPlan.parse({ ...choice, observedAt: observation.observedAt, options: observation.options, recordedAt: new Date().toISOString() })
    this.store.minecraftHouseProjects.recordPlan(current.id, plan)
    this.houseProjectPlanObservations.delete(observation)
    this.houseProjectPlanGeneration++
    return plan
  }

  private async readHouseProjectSection(input: MinecraftHouseRequest, epoch: number, signal: AbortSignal, recovery = false): Promise<MinecraftHousePreview> {
    const path = recovery ? '/house/recovery-preview' : '/house/preview'
    const preview = MinecraftHousePreview.safeParse(await this.campRequest(path, input, epoch, signal)).data
    signal.throwIfAborted()
    if (!preview || preview.checked > input.layout.blocks.length || preview.ready && preview.checked !== input.layout.blocks.length) {
      throw new DeviceAuthError(502, 'minecraft-house-preview-unconfirmed')
    }
    if (preview.ready) return preview
    const { materials, ...failure } = preview
    const planned = minecraftHouseMaterials(input.layout)
    return materials && preview.checked === input.layout.blocks.length &&
      materials.every(row => row.needed <= (planned[row.material] ?? 0)) ? preview : failure
  }

  async previewHouseProjectSection(id: string, index: number, signal: AbortSignal): Promise<MinecraftHouseProjectSitePreview> {
    const { project, section } = this.houseProjectSection(id, index)
    if (section.status === 'built' || section.status === 'running') throw new DeviceAuthError(409, 'minecraft-house-project-busy')
    const key = `${id}:${index}`
    const epoch = this.campEpoch
    this.houseProjectPreviews.delete(key)
    const input = (await this.houseProjectInputs(project, signal))[index]!
    const recovery = houseProjectCanRecover(section) && await this.houseProjectRecoveryAvailable(signal)
    const preview = await this.readHouseProjectSection(input, epoch, signal, recovery)
    const current = this.houseProjectSection(id, index).section
    if (current.status !== section.status || current.reason !== section.reason || this.worldBusy() || this.visitActionPermit) {
      throw new DeviceAuthError(409, 'minecraft-house-project-busy')
    }
    const result = { ...preview, ...(recovery && { recovery: true as const }) }
    if (!result.ready) return result
    const now = Date.now()
    for (const [id, approval] of this.houseProjectPreviews) if (approval.expiresAt <= now) this.houseProjectPreviews.delete(id)
    const previewId = randomUUID()
    this.houseProjectPreviews.set(key, { id: previewId, epoch, expiresAt: now + HOUSE_PREVIEW_TTL_MS, recovery })
    return { ...result, previewId }
  }

  async inspectDailyHouseProject(projectId: string, zoneId: string, signal: AbortSignal, allowSupply?: true): Promise<DailyHouseProjectOffer[]> {
    const project = this.houseProject(projectId)
    if (project.zoneId !== zoneId) throw new DeviceAuthError(409, 'minecraft-house-project-zone-invalid')
    const epoch = this.campEpoch
    const generation = this.houseProjectPlanGeneration
    const expiresAt = Date.now() + HOUSE_PREVIEW_TTL_MS
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(HOUSE_PROJECT_PLAN_SWEEP_MS)])
    const inputs = await this.houseProjectInputs(project, bounded)
    const worker = (allowSupply || project.sections.some(houseProjectCanRecover)) && await this.request('', 'GET', undefined, bounded)
    const capabilities = worker?.online === true && worker.auth?.mode === 'cbi' ? worker.capabilities : undefined
    const recoveryAvailable = capabilities?.houseRecovery === true
    const supplyAvailable = allowSupply === true && capabilities?.crafting === true
    const check = () => {
      bounded.throwIfAborted()
      this.assertCampOpen(epoch)
      if (generation !== this.houseProjectPlanGeneration || this.worldBusy() || this.visitActionPermit) {
        throw new DeviceAuthError(409, 'minecraft-house-project-plan-stale')
      }
      this.houseProject(projectId)
    }
    const offers: DailyHouseProjectOffer[] = []
    const shortages: { offer: DailyHouseProjectOffer; request: MinecraftHouseSupplyRequest }[] = []
    const register = (offer: DailyHouseProjectOffer) => {
      this.dailyHouseProjectOffers.set(offer, { projectId, zoneId, section: offer.section, recovery: offer.recovery === true,
        ...(offer.supply && { supply: { ...offer.supply } }), epoch, generation, expiresAt })
      offers.push(offer)
    }
    for (const [section, state] of project.sections.entries()) {
      if (state.status !== 'pending' && state.status !== 'interrupted') continue
      check()
      const recovery = houseProjectCanRecover(state)
      if (recovery && !recoveryAvailable) continue
      const input = inputs[section]!
      const preview = await this.readHouseProjectSection(input, epoch, bounded, recovery)
      check()
      const base = { section, name: state.name, ...(recovery && { recovery: true as const }) }
      if (preview.ready) register(base)
      else if (supplyAvailable && preview.reason === 'homebuild-materials') {
        for (const row of preview.materials ?? []) {
          const recipe = MinecraftHouseSupplyRecipe.safeParse(row.material).data
          if (!recipe || row.missing <= 0) continue
          const supply = { recipe, missing: row.missing }
          const request = MinecraftHouseSupplyRequest.parse({ ...input, ...supply, ...(recovery && { recovery: true }) })
          shortages.push({ offer: { ...base, supply }, request })
        }
      }
    }
    for (const { offer, request } of shortages) {
      const ready = await this.readHouseProjectSupply(request, epoch, bounded).catch(() => false)
      check()
      if (ready) register(offer)
    }
    return offers
  }

  private async readHouseProjectSupply(input: MinecraftHouseSupplyRequest, epoch: number, signal: AbortSignal): Promise<boolean> {
    const result = MinecraftHouseSupplyPreview.safeParse(await this.campRequest('/house/supply-preview', input, epoch, signal)).data
    signal.throwIfAborted()
    if (!result) throw new DeviceAuthError(502, 'minecraft-house-project-supply-preview-unconfirmed')
    return result.ready
  }

  private dailyHouseProjectExecution(projectId: string, zoneId: string, offer: DailyHouseProjectOffer, signal: AbortSignal,
    assertPermit: () => void, lease: DailyHouseProjectLease, supply: boolean) {
    const source = this.dailyHouseProjectOffers.get(offer)
    const stale = () => new DeviceAuthError(409, 'minecraft-house-project-plan-stale')
    if (!source || source.projectId !== projectId || source.zoneId !== zoneId || !!source.supply !== supply) throw stale()
    const externalId = DAILY_HOUSE_PROJECT_TASK_PREFIX + lease.dailyTaskId
    const authorize = () => {
      signal.throwIfAborted()
      const parent = this.store.autonomy.get(lease.dailyTaskId)
      if (parent?.task.status !== 'running' || parent.kind !== 'daily.choice' || parent.contextId !== DAILY_AUTONOMY_CONTEXT) throw stale()
      assertPermit()
    }
    const check = () => {
      authorize()
      this.assertCampOpen(source.epoch)
      if (this.dailyHouseProjectOffers.get(offer) !== source || Date.now() >= source.expiresAt ||
        this.houseProjectPlanGeneration !== source.generation || this.worldBusy() || this.visitActionPermit ||
        this.store.taskByExternalId(externalId) || source.section !== offer.section || source.recovery !== (offer.recovery === true) ||
        source.supply?.recipe !== offer.supply?.recipe || source.supply?.missing !== offer.supply?.missing) throw stale()
      const current = this.houseProjectSection(projectId, source.section)
      if (current.project.zoneId !== zoneId || current.section.name !== offer.name ||
        current.section.status === 'built' || current.section.status === 'running' ||
        source.recovery && !houseProjectCanRecover(current.section)) throw stale()
      return current.project
    }
    return { source, check, daily: { lease, externalId, assertPermit: authorize } }
  }

  async buildDailyHouseProjectSection(projectId: string, zoneId: string, offer: DailyHouseProjectOffer, signal: AbortSignal,
    assertPermit: () => void, lease: DailyHouseProjectLease) {
    const { source, check, daily } = this.dailyHouseProjectExecution(projectId, zoneId, offer, signal, assertPermit, lease, false)
    const project = check()
    const input = (await this.houseProjectInputs(project, signal, source.recovery))[source.section]!
    check()
    const preview = await this.readHouseProjectSection(input, source.epoch, signal, source.recovery)
    check()
    if (!preview.ready) throw new DeviceAuthError(409, preview.reason ?? 'house-preconditions-changed')

    return this.withDailyHouseProjectRun(offer, signal, async controller => {
      const result = await this.performHouseProjectSection(project, source.section, input, source.epoch, controller, source.recovery, daily)
      return { task: result.task, receipt: result.project.sections[source.section]!.receipt! }
    })
  }

  async supplyDailyHouseProjectSection(projectId: string, zoneId: string, offer: DailyHouseProjectOffer, signal: AbortSignal,
    assertPermit: () => void, lease: DailyHouseProjectLease) {
    const { source, check, daily } = this.dailyHouseProjectExecution(projectId, zoneId, offer, signal, assertPermit, lease, true)
    const supply = source.supply!
    const project = check()
    const input = (await this.houseProjectInputs(project, signal, source.recovery, true))[source.section]!
    check()
    const request = MinecraftHouseSupplyRequest.parse({ ...input, ...supply, ...(source.recovery && { recovery: true }) })
    const ready = await this.readHouseProjectSupply(request, source.epoch, signal)
    check()
    if (!ready) throw new DeviceAuthError(409, 'minecraft-house-project-supply-preconditions-changed')

    return this.withDailyHouseProjectRun(offer, signal, async controller => {
      const { task, result: receipt } = await this.runHouseProjectAction(project, controller, HOUSE_PROJECT_SUPPLY_CAPABILITY, `备料第 ${source.section + 1} 区`,
        async task => {
          daily.assertPermit()
          this.assertHouseProjectAction(projectId, controller.signal, task.id)
          const value = MinecraftHouseSupplyReceipt.safeParse(await this.campRequest('/house/supply', request, source.epoch, controller.signal)).data
          if (!value || value.name !== supply.recipe ||
            value.inventory.planksBefore + supply.missing > (minecraftHouseMaterials(input.layout)[supply.recipe] ?? 0)) {
            throw new DeviceAuthError(502, 'minecraft-house-project-supply-receipt-unconfirmed')
          }
          this.store.transaction(() => {
            daily.assertPermit()
            this.assertHouseProjectAction(projectId, controller.signal, task.id)
            this.store.transitionTask(task.id, 'succeeded')
            const summary = dailyHouseSupplyFact(source.section, value.name)
            const activityId = this.store.recordActivity({ contextId: 'game.minecraft', taskId: task.id, source: 'game.minecraft',
              kind: HOUSE_PROJECT_SUPPLY_EVENT, summary, status: 'success',
              data: { projectId, zoneId, index: source.section, dailyTaskId: lease.dailyTaskId, missing: supply.missing, ...value } })
            this.store.memory.create({ kind: 'experience', content: summary, contextId: 'game.minecraft', scope: 'shared',
              status: 'active', confidence: 1, importance: 0.55,
              sourceRefs: [{ contextId: 'game.minecraft', taskId: task.id, activityId }], actorSessionId: task.sessionId,
              reason: 'minecraft-house-project-autonomous-supply' })
          })
          return value
        }, undefined, undefined, daily)
      return { task, receipt }
    })
  }

  private async withDailyHouseProjectRun<T>(offer: DailyHouseProjectOffer, signal: AbortSignal, run: (controller: AbortController) => Promise<T>) {
    signal.throwIfAborted()
    const controller = new AbortController()
    const cancel = () => controller.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    this.dailyHouseProjectOffers.delete(offer)
    this.houseProjectPreviews.clear()
    try {
      return await run(controller)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  async buildHouseProjectSection(id: string, index: number, previewId: string) {
    const { project, section } = this.houseProjectSection(id, index)
    if (section.status === 'built') return project
    const key = `${id}:${index}`
    const epoch = this.campEpoch
    const approval = this.houseProjectPreviews.get(key)
    const validApproval = () => approval?.id === previewId && approval.epoch === epoch &&
      this.houseProjectPreviews.get(key) === approval && approval.expiresAt > Date.now()
    if (!approval || !validApproval()) throw new DeviceAuthError(409, 'minecraft-house-project-preview-required')
    const controller = new AbortController()
    const { recovery } = approval
    const inputs = await this.houseProjectInputs(project, controller.signal, recovery).catch(error => {
      if (recovery && this.houseProjectPreviews.get(key) === approval) this.houseProjectPreviews.delete(key)
      throw error
    })
    const input = inputs[index]!
    this.assertCampOpen(epoch)
    const current = this.houseProjectSection(id, index).section
    if (current.status === 'built') return this.houseProject(id)
    if (!validApproval() || this.worldBusy() || this.visitActionPermit || recovery && !houseProjectCanRecover(current)) {
      throw new DeviceAuthError(409, 'minecraft-house-project-preview-required')
    }
    this.houseProjectPreviews.clear()
    return (await this.performHouseProjectSection(project, index, input, epoch, controller, recovery)).project
  }

  private performHouseProjectSection(project: MinecraftHouseProjectInput & { id: string }, index: number, input: MinecraftHouseRequest,
    epoch: number, controller: AbortController, recovery: boolean,
    daily?: { lease: DailyHouseProjectLease; externalId: string; assertPermit: () => void }) {
    const { id } = project
    const action = recovery ? '站位恢复' : '施工'
    return this.runHouseProjectAction(project, controller, HOUSE_PROJECT_SECTION_CAPABILITY, `${daily ? '自主' : ''}${action}第 ${index + 1} 区`, async task => {
      daily?.assertPermit()
      const path = recovery ? '/house/recover' : '/house/build'
      const receipt = MinecraftHouseReceipt.safeParse(await this.campRequest(path, input, epoch, controller.signal)).data
      if (!receipt || !minecraftHouseReceiptMatches(receipt, input)) {
        throw new DeviceAuthError(502, 'minecraft-house-receipt-unconfirmed')
      }
      this.store.transaction(() => {
        daily?.assertPermit()
        this.assertHouseProjectAction(id, controller.signal, task.id)
        const result = { ...receipt, ...(recovery && { recovery: true as const }) }
        if (!this.store.minecraftHouseProjects.finish(id, index, task.id, { receipt: result })) {
          throw new DeviceAuthError(409, 'minecraft-house-cancelled')
        }
        this.store.transitionTask(task.id, 'succeeded')
        const summary = `${daily ? '自主施工' : '建筑工程'}第 ${index + 1} 区已核对 ${receipt.checked} 处位置，本次放置 ${receipt.placed} 块。`
        const activityId = this.store.recordActivity({ contextId: 'game.minecraft', taskId: task.id, source: 'game.minecraft',
          kind: 'world.house-project-section', summary,
          data: { projectId: id, index, ...result, ...(daily && { dailyTaskId: daily.lease.dailyTaskId }) }, status: 'success' })
        if (daily && receipt.placed > 0) this.store.memory.create({ kind: 'experience', content: summary,
          contextId: 'game.minecraft', scope: 'shared', status: 'active', confidence: 1, importance: 0.65,
          sourceRefs: [{ contextId: 'game.minecraft', taskId: task.id, activityId }], actorSessionId: task.sessionId,
          reason: 'minecraft-house-project-autonomous-section' })
      })
    }, taskId => this.store.minecraftHouseProjects.start(id, index, taskId),
    (taskId, reason) => this.store.minecraftHouseProjects.finish(id, index, taskId, { reason }), daily)
  }

  async verifyHouseProject(id: string) {
    const project = this.houseProject(id)
    if (project.sections.some(section => section.status !== 'built')) throw new DeviceAuthError(409, 'minecraft-house-project-incomplete')
    const epoch = this.campEpoch
    const controller = new AbortController()
    const sections = await this.houseProjectInputs(project, controller.signal)
    this.assertCampOpen(epoch)
    this.houseProject(id)
    if (this.worldBusy() || this.visitActionPermit) throw new DeviceAuthError(409, 'minecraft-house-project-busy')
    const result = await this.runHouseProjectAction(project, controller, HOUSE_PROJECT_VERIFY_CAPABILITY, '整体验收', async task => {
      const result = MinecraftHouseProjectVerification.safeParse(await this.campRequest('/house/project-verify', { sections }, epoch, controller.signal)).data
      if (!result || result.checked !== sections.reduce((total, item) => total + item.layout.blocks.length, 0) ||
        result.unmatchedSections.some(index => index >= sections.length)) {
        throw new DeviceAuthError(502, 'minecraft-house-project-verification-unconfirmed')
      }
      this.store.transaction(() => {
        this.assertHouseProjectAction(id, controller.signal, task.id)
        const first = this.store.minecraftHouseProjects.verify(id, { ...result, checkedAt: new Date().toISOString() })
        this.store.transitionTask(task.id, 'succeeded')
        const summary = result.matched
          ? `在主人授权区完成了 ${sections.length} 区建筑，整体验收核对 ${result.checked} 处方块和留空。`
          : `建筑工程有 ${result.unmatchedSections.length} 个分区与蓝图不符。`
        const activityId = this.store.recordActivity({ contextId: 'game.minecraft', sessionId: task.sessionId, taskId: task.id,
          source: 'game.minecraft', kind: 'world.house-project-verification', summary, data: { projectId: id, ...result },
          status: result.matched ? 'success' : 'warning' })
        if (first) this.store.memory.create({ kind: 'experience', content: summary, contextId: 'game.minecraft', scope: 'shared',
          status: 'active', confidence: 1, importance: 0.7, sourceRefs: [{ contextId: 'game.minecraft', taskId: task.id, activityId }],
          actorSessionId: task.sessionId, reason: 'minecraft-house-project-verified' })
      })
    })
    return result.project
  }

  private assertHouseProjectAction(id: string, signal: AbortSignal, taskId: string) {
    signal.throwIfAborted()
    this.houseProject(id)
    if (this.store.taskById(taskId)?.status !== 'running') throw new DeviceAuthError(409, 'minecraft-house-cancelled')
  }

  private async runHouseProjectAction<Result>(
    project: MinecraftHouseProjectInput & { id: string }, controller: AbortController, capabilityId: string, title: string,
    operation: (task: TaskRecord) => Promise<Result>, start?: (taskId: string) => boolean,
    interrupt?: (taskId: string, reason: string) => void,
    daily?: { lease: DailyHouseProjectLease; externalId: string; assertPermit: () => void },
  ) {
    const { promise: settled, resolve } = Promise.withResolvers<void>()
    const binding = this.store.bindingByContext('game.minecraft')
    const task = this.store.transaction(() => {
      daily?.assertPermit()
      if (daily && this.store.taskByExternalId(daily.externalId)) throw new DeviceAuthError(409, 'minecraft-house-project-plan-stale')
      const accepted = this.store.createTask({ capabilityId, contextId: 'game.minecraft', sessionId: binding?.sessionId,
        title: `Minecraft 建筑工程：${title}`, ...(daily && { externalId: daily.externalId }) })
      if (start && !start(accepted.id)) throw new DeviceAuthError(409, 'minecraft-house-project-busy')
      const running = this.store.transitionTask(accepted.id, 'running')
      daily?.lease.onStarted(running)
      return running
    })
    this.houseRun = { zoneId: project.zoneId, controller, settled, ...(daily && {
      dailyTask: task.id, dailyAction: capabilityId === HOUSE_PROJECT_SUPPLY_CAPABILITY ? 'house-supply' : 'house-build',
    }) }
    this.houseProjectPlanGeneration++
    try {
      const result = await operation(task)
      return { project: this.store.minecraftHouseProjects.get(project.id)!, task: this.store.taskById(task.id)!, result }
    } catch (error) {
      const reason = error instanceof DeviceAuthError ? error.code : 'minecraft-house-project-unconfirmed'
      this.store.transaction(() => {
        interrupt?.(task.id, reason)
        if (this.store.taskById(task.id)?.status === 'running') {
          this.store.transitionTask(task.id, controller.signal.aborted ? 'cancelled' : 'failed', reason)
        }
      })
      if (controller.signal.aborted) throw new DeviceAuthError(409, 'minecraft-house-cancelled')
      throw error
    } finally {
      this.houseRun = undefined
      resolve()
    }
  }

  async buildCamp(zoneId: string, material: string, signal?: AbortSignal, parentTaskId?: string): Promise<unknown> {
    const zone = this.store.buildZoneById(zoneId)
    if (!zone) throw new Error('build-zone-not-found')
    this.currentBuildZoneId = zoneId
    try {
      return await this.action('build', { zone, material }, false, signal, parentTaskId)
    } finally {
      this.currentBuildZoneId = undefined
    }
  }

  async prepareCamp(zoneId: string, material = 'oak_planks', signal?: AbortSignal): Promise<unknown> {
    const epoch = this.campEpoch
    this.assertCampOpen(epoch)
    const zone = this.store.buildZoneById(zoneId)
    if (!zone) throw new Error('build-zone-not-found')
    const wood = CAMP_WOODS.find(item => item.planks === material)
    if (!wood) throw new Error('prepare-unsupported-material')
    const worker = await this.request('', 'GET', undefined, signal)
    this.assertCampOpen(epoch)
    if (!worker.online) throw new DeviceAuthError(409, 'minecraft-offline')
    const capabilities = worker.capabilities as MinecraftView['capabilities']
    if (!capabilities?.crafting || !capabilities.campBuilding) throw new DeviceAuthError(409, 'prepare-unavailable')
    const binding = this.store.bindingByContext('game.minecraft')
    const task = this.store.createTask({ capabilityId: 'minecraft.prepare', contextId: 'game.minecraft', sessionId: binding?.sessionId, title: `Minecraft：准备并搭建 ${material} 营地` })
    this.store.transitionTask(task.id, 'running')
    const steps: { kind: 'dig' | 'craft'; name: string; taskId: string }[] = []
    const deadline = Date.now() + 8 * 60_000
    const checkBudget = () => {
      this.assertCampOpen(epoch)
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw new Error('prepare-timeout')
    }
    this.currentBuildZoneId = zoneId
    try {
      for (let gather = 0; gather < 6; gather++) {
        checkBudget()
        const state = await this.observe()
        checkBudget()
        const required = 8 + (inventoryCount(state, 'crafting_table') < 1 ? 4 : 0)
        const missing = Math.max(0, required - inventoryCount(state, wood.planks))
        const logsNeeded = Math.ceil(missing / 4) - Math.max(0, inventoryCount(state, wood.log) - 2)
        if (missing === 0 || logsNeeded <= 0) break
        const receipt = await this.dig(wood.log, signal, task.id) as { task: TaskRecord }
        steps.push({ kind: 'dig', name: wood.log, taskId: receipt.task.id })
      }
      for (let craft = 0; craft < 5; craft++) {
        checkBudget()
        const state = await this.observe()
        checkBudget()
        const hasTable = inventoryCount(state, 'crafting_table') >= 1
        const planks = inventoryCount(state, wood.planks)
        if (planks >= 8 && hasTable) break
        if (planks < 8 || !hasTable && planks < 4) {
          if (inventoryCount(state, wood.log) <= 2) throw new Error('prepare-materials')
          const receipt = await this.craft(wood.planks, signal, task.id) as { task: TaskRecord }
          steps.push({ kind: 'craft', name: wood.planks, taskId: receipt.task.id })
        } else if (!hasTable) {
          const receipt = await this.craft('crafting_table', signal, task.id) as { task: TaskRecord }
          steps.push({ kind: 'craft', name: 'crafting_table', taskId: receipt.task.id })
        }
      }
      checkBudget()
      const ready = await this.observe()
      checkBudget()
      if (inventoryCount(ready, wood.planks) < 8 || inventoryCount(ready, 'crafting_table') < 1) throw new Error('prepare-materials')
      const build = await this.buildCamp(zoneId, material, signal, task.id) as { result?: { target?: unknown } }
      const receipt = this.store.transitionTask(task.id, 'succeeded')
      const gathered = steps.filter(step => step.kind === 'dig').length
      const crafted = steps.length - gathered
      const target = this.targetOf(build.result?.target) ?? { x: zone.x, y: zone.y, z: zone.z, block: material }
      this.learnSuccess('prepare', target, [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id }])
      this.store.recordActivity({ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id, source: 'game.minecraft', kind: 'world.goal', summary: '采集、合成与授权区营地建造目标已完成', status: 'success' })
      this.store.memory.create({
        kind: 'experience', scope: 'shared', contextId: 'game.minecraft', status: 'active', confidence: 1, importance: 0.7,
        content: `在 Coopcraft 的主人授权区 ${zone.name} 完成了 ${material} 营地目标：实际采集 ${gathered} 根原木，执行 ${crafted} 次配方，再完成逐块建造。`,
        sourceRefs: [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id }],
        actorSessionId: binding?.sessionId, reason: 'minecraft-prepare-camp',
      })
      this.emitMoment(receipt, { prepared: true, build: build.result, gathered, crafted })
      return { task: receipt, result: { prepared: true, zoneId, material, steps, build } }
    } catch (error) {
      const current = this.store.taskById(task.id)
      const message = signal?.aborted ? 'prepare-cancelled' : error instanceof Error ? error.message : String(error)
      const paused = epoch !== this.campEpoch || !!this.campControl().pausedAt
      const cancelled = paused || signal?.aborted || message.includes('cancelled')
      if (!paused) this.learnFailure('prepare', new Error(message), { x: zone.x, y: zone.y, z: zone.z, block: material }, [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: task.id }])
      if (current && ['accepted', 'running'].includes(current.status)) this.store.transitionTask(task.id, cancelled ? 'cancelled' : 'failed', message)
      if (!paused && signal?.aborted) await this.stop(false).catch(() => {})
      throw new Error(message)
    } finally {
      this.currentBuildZoneId = undefined
    }
  }

  async stop(explicit = true, campPause = false): Promise<{ task: TaskRecord; result: unknown }> {
    this.houseProjectPlanGeneration++
    this.houseRun?.controller.abort()
    this.housePreviews.clear()
    this.houseProjectPreviews.clear()
    this.visitActionPermit = undefined
    this.cancelSupply(undefined, explicit)
    this.clearCampVisitReady()
    this.surveyReadyAt = undefined
    const following = this.followTaskId
    const result = await this.action('stop', {}, false, undefined, undefined, campPause ? { path: '/camp/pause', input: {} } : undefined)
    this.currentBuildZoneId = undefined
    for (const task of this.store.tasks().filter(item => item.capabilityId.startsWith('minecraft.') && item.capabilityId !== 'minecraft.stop' && item.status === 'running')) {
      this.store.transitionTask(task.id, 'cancelled', '主人停止了 Minecraft 动作')
    }
    if (following && this.followTaskId === following) {
      const task = this.store.taskById(following)
      const binding = this.store.bindingByContext('game.minecraft')
      this.store.memory.create({
        kind: 'experience', scope: 'shared', contextId: 'game.minecraft', status: 'active', confidence: 1, importance: 0.4,
        content: '在 Coopcraft 中结束了对主人的持续跟随。',
        sourceRefs: [{ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: following }],
        actorSessionId: binding?.sessionId, reason: 'minecraft-follow-stopped',
      })
      this.store.recordActivity({ contextId: 'game.minecraft', sessionId: binding?.sessionId, taskId: following, source: 'game.minecraft', kind: 'world.action', summary: '跟随已由主人停止', status: 'success', data: { taskStatus: task?.status ?? 'cancelled' } })
    }
    this.followTaskId = undefined
    return result
  }

  async modelStatus(section: 'overview' | 'build_zones' | 'wardrobe' | 'lessons' | 'places' | 'houses', offset: number, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (section === 'places') return this.placeStatus()
    if (section === 'wardrobe') return { wardrobe: await this.wardrobe(signal) }
    if (section === 'houses') return { houses: this.store.minecraftHouses.list().filter(draft => draft.zoneId && this.store.buildZoneById(draft.zoneId))
      .slice(0, 8).map(({ id, name, zoneId, layout, status }) => ({ id, name, zoneId, layout, status, materials: minecraftHouseMaterials(layout) })) }
    if (section === 'lessons') return { lessons: this.store.gameLearning.forPrompt(undefined, 3) }
    if (section === 'build_zones') {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new DeviceAuthError(400, 'minecraft-zone-offset-invalid')
      const zones = this.store.buildZones()
      const buildZones = zones.slice(offset, offset + 8).map(({ id, name, dimension, x, y, z, radius }) => ({ id, name, dimension, x, y, z, radius }))
      return { buildZones, ...(offset + 8 < zones.length && { nextOffset: offset + 8 }) }
    }
    const worker = this.ready ? await this.request('', 'GET', undefined, signal).catch(() => undefined) : undefined
    signal.throwIfAborted()
    const action = typeof worker?.action === 'string' && /^[a-z][a-z-]{0,31}$/u.test(worker.action) ? worker.action : undefined
    return { workerOnline: !!worker, online: worker?.online === true, connecting: worker?.connecting === true,
      campPaused: !!this.campControl().pausedAt, ...(worker?.capabilities?.shield === true && { shieldAvailable: true }),
      ...(worker?.capabilities?.nightShelter === true && { nightShelterAvailable: true }),
      ...(worker?.capabilities?.ovoStorage === true && { ovoStorage: true }), ...(worker?.capabilities?.ovoSmelting === true && { ovoSmelting: true }), ...(action && { action }) }
  }

  async eventPrompt(job: AutonomousJob): Promise<string> {
    this.assertCampOpen()
    const messages = minecraftOwnerEvents(job.payload.events).map(event => event.message)
    if (!messages.length) throw new DeviceAuthError(400, 'minecraft-event-messages-invalid')
    const deaths = this.store.activities(150).filter(event => event.contextId === 'game.minecraft' && event.kind === 'player.death').slice(0, 2)
      .map(event => ({ at: event.occurredAt, outcome: event.summary, ...event.data }))
    const actions = this.store.gameLearning.list({ limit: 4 }).map(({ action, errorCode, target, status, occurrences }) => ({ action, errorCode, target, status, occurrences }))
    const observations = this.store.selfNotes.recallCandidates('game.minecraft').filter(note => note.createdBy === 'companion' &&
      note.sourceRefs.length > 0 && note.sourceRefs.every(ref => ref.contextId === 'game.minecraft')).slice(0, 2).map(note => note.content.slice(0, 180))
    return ((deaths.length || actions.length || observations.length)
      ? `Minecraft 服务端回执：${JSON.stringify({ deaths, actions, selfNotes: observations })}\n` : '') + MINECRAFT_OWNER_MESSAGES + JSON.stringify(messages)
  }

  finishEvent(job: AutonomousJob): { acted: boolean; reason: string; remaining?: MinecraftOwnerEvent[] } {
    const started = typeof job.payload.startedAt === 'number' ? job.payload.startedAt : 0
    const now = Date.now()
    const acted = this.store.tasks().some(task => task.contextId === 'game.minecraft' && task.capabilityId.startsWith('minecraft.') &&
      task.capabilityId !== 'minecraft.stop' && Date.parse(task.createdAt) >= started && Date.parse(task.createdAt) <= now && ['running', 'succeeded'].includes(task.status))
    const previous = new Set(minecraftOwnerEvents(job.payload.events).map(minecraftOwnerEventKey))
    const current = minecraftOwnerEvents(this.store.autonomy.get(job.id)?.payload.events)
    return { acted, reason: acted ? '完成了一次受控 Minecraft 动作' : '本轮没有需要执行的游戏动作',
      remaining: current.filter(event => !previous.has(minecraftOwnerEventKey(event))) }
  }

  ask(text: string): AutonomousJob | undefined {
    this.assertCampOpen()
    return this.onEvent?.({ seq: -Date.now(), sourceId: randomUUID(), username: this.options.owner, message: text })
  }

  async close(): Promise<void> {
    this.closing = true
    this.houseProjectPlanGeneration++
    const houseRun = this.houseRun
    houseRun?.controller.abort()
    this.housePreviews.clear()
    this.houseProjectPreviews.clear()
    this.visitActionPermit = undefined
    this.clearCampVisitReady()
    this.homeActiveAt = undefined
    this.surveyReadyAt = undefined
    this.cancelSupply()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.timer) clearInterval(this.timer)
    const child = this.child
    this.child = undefined
    if (child) {
      let exited = false
      const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(true) }))
      child.kill('SIGTERM')
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3000))])
      if (!exited) child.kill('SIGKILL')
    }
    this.ready = false
    await Promise.allSettled([this.campPause, this.campResume, houseRun?.settled])
    this.endFollow('Minecraft worker 已停止')
    this.store.updateCapability('game.minecraft', 'planned', 'Minecraft worker 已停止')
  }
}
