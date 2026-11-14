import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomInt } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { MinecraftAuthorizedZone } from '../../src/core/minecraft-supply.ts'
import { CAMP_GATHER_MAX_MS, MinecraftCampGatherOffer, MinecraftCampGatherReceipt, MinecraftCampGatherRequest, minecraftProjectGatherEligible } from '../../src/core/minecraft-gather.ts'
import { MINECRAFT_HOUSE_CANDIDATE_LIMIT, MinecraftHouseCellBlockedReason, MinecraftHouseCellCandidates, MinecraftHouseCellReceipt, MinecraftHouseCellRequest, minecraftHouseCellTarget } from '../../src/core/minecraft-house-cell.ts'
import { MINECRAFT_HOUSE_BLOCKS, MinecraftHousePreview, MinecraftHouseReceipt, MinecraftHouseRequest, minecraftHouseCells, minecraftHouseReceiptMatches, type MinecraftHouseMaterial } from '../../src/core/minecraft-house.ts'
import { MinecraftHouseProjectVerification, MinecraftHouseProjectVerifyRequest } from '../../src/core/minecraft-house-project.ts'
import { MinecraftHouseSupplyReceipt, MinecraftHouseSupplyRequest, type MinecraftHouseSupplyPreview } from '../../src/core/minecraft-house-supply.ts'
import { HOUSE_VERIFICATION_ISSUE_LIMIT, MinecraftHouseVerification } from '../../src/core/minecraft-house-verification.ts'
import { CAMP_WOODS, MinecraftAuthorizedCampRequest, MinecraftSupplyRequest, MinecraftVisitBuildOffer, MinecraftVisitBuildReceipt, MinecraftVisitBuildRequest, MinecraftVisitRevisitReceipt, MinecraftVisitRevisitRequest, MinecraftVisitSupplyOffer, MinecraftVisitSupplyReceipt, authorizedInventory, minecraftCampOffer, minecraftPrepareOffer, minecraftSupplyOffer, minecraftVisitSupplyOffer } from '../../src/core/minecraft-supply.ts'
import { CAMP_PATROL_MAX_MS, MinecraftPatrolSegmentReceipt, MinecraftPatrolSegmentRequest, MinecraftSurveyPreview, MinecraftSurveyPreviewRequest, MinecraftSurveyReceipt, MinecraftSurveyRequest, MinecraftTrailReceipt, SURVEY_DISTANCE, SURVEY_TRAIL_IDS } from '../../src/core/minecraft-survey.ts'
import type { MinecraftWardrobeView } from '../../src/protocol/minecraft-wardrobe.ts'
import { MinecraftShieldReceipt, type MinecraftShieldRequest } from '../../src/protocol/minecraft-shield.ts'
import { configuredWardrobe, YSM_MODEL_NBT, ysmWardrobeAvailable, ysmWardrobeReceipt, ysmWardrobeStateLine } from './wardrobe.ts'

const LOGS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'] as const
const LEAVES = ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves'] as const
const HAZARDS = ['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow'] as const
const CAMP_VISIT_FLOORS = ['grass_block', 'dirt', 'stone', 'cobblestone', ...CAMP_WOODS.map(wood => wood.planks),
  'deepslate', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'bricks', 'stone_bricks', 'netherrack', 'end_stone'] as const
const SURVEY_TIMEOUT_MS = 35_000
const TRAIL_TIMEOUT_MS = 45_000
const CAMP_GATHER_TIMEOUT_MS = 70_000
const HOUSE_BUILD_TIMEOUT_MS = 420_000
const HOUSE_CELL_TIMEOUT_MS = 45_000
const HOUSE_CANDIDATES_TIMEOUT_MS = 30_000
const HOUSE_VERIFICATION_TIMEOUT_MS = 45_000
const CAMP_VISIT_MAX_MS = 5 * 60_000
const CAMP_VISIT_RETRY_MS = 5000
const CHAT_RELAY_POLL_FRESH_MS = 3000
const CHAT_RELAY_RENEW_MS = 6000
const CAMP_VISIT_LOG_LIMIT = 1024 * 1024
const CAMP_VISIT_BLOCK_CHECK = /^\[[^\]\r\n]+\] \[Server thread\/INFO\]: Test (passed|failed)\r?\n/mu
const SURVEY_RETREAT_REASON = 'survey-terrain-changed'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Position = { x: number; y: number; z: number }
type HouseMaterials = Partial<Record<MinecraftHouseMaterial, number>>
type HouseSession = { epoch: number; dev: number; ino: number; offset: number }
type HouseProgress = { phase: string; checked: number; placed: number; reason: string }
const HOUSE_MATERIALS = Object.values(MINECRAFT_HOUSE_BLOCKS).filter(block => block !== 'air')
type EntityData = Record<string, unknown> | unknown[] | string | number
type Action = { kind: string; controller: AbortController; digTarget?: Position; unreachable?: true }
type WardrobeModelState = { modelId: string; texture: string; mandatory: boolean; disabled: boolean }
const campAdmission = new AsyncLocalStorage<{ world: CbiWorld; epoch: number; visitId?: string }>()
const CampVisitStart = MinecraftSurveyPreviewRequest.extend({
  id: z.uuid(), expiresAt: z.int().positive(), allowSupply: z.literal(true).optional(), allowBuild: z.literal(true).optional(),
  allowRevisit: z.literal(true).optional(), patrol: z.literal(true).optional(), gather: z.literal(true).optional(), projectGather: z.literal(true).optional(),
}).refine(visit => {
  if (visit.projectGather) return visit.gather && visit.allowSupply && visit.allowBuild && !visit.patrol && !visit.allowRevisit
  if (visit.patrol || visit.gather) return !visit.allowSupply && !visit.allowBuild && !visit.allowRevisit && !(visit.patrol && visit.gather)
  return !visit.allowRevisit || visit.allowBuild === true && !visit.allowSupply
})
const CampVisitEnd = z.strictObject({ id: z.uuid() })
const CampVisitJournal = z.strictObject({
  active: CampVisitStart.safeExtend({
    dispatch: z.strictObject({ dev: z.int(), ino: z.int(), offset: z.int().nonnegative() }).optional(),
    surveyUsed: z.literal(true).optional(),
    supplyUsed: z.literal(true).optional(),
    buildUsed: z.literal(true).optional(),
    revisitUsed: z.literal(true).optional(),
    gatherUsed: z.literal(true).optional(),
    patrolSegment: z.strictObject({
      index: MinecraftPatrolSegmentRequest.shape.index,
      direction: MinecraftPatrolSegmentRequest.shape.direction,
      state: z.enum(['dispatched', 'completed', 'recovered']),
    }).optional(),
  }).optional(),
  ended: z.uuid().optional(),
})
type CampVisit = NonNullable<z.infer<typeof CampVisitJournal>['active']>
type CampVisitAction = 'survey' | 'supply' | 'build' | 'revisit' | 'gather'
type CampVisitEndReceipt = { visitId: string; online: false; confirmed: true }
type SurveyCommand = 'survey' | 'surveyroute' | 'surveytrail'
type SurveyProgress = { phase: string; checkpoints: number; returned: boolean; reason: string }
type CampGatherProgress = { phase: string; changed: boolean; picked: boolean; returned: boolean; reason: string }
const CAMP_GATHER_ACTIVE_PHASES = ['outbound', 'gathering', 'returning']
const CampGatherInventory = z.array(z.object({ id: z.string().min(1), count: z.int().positive() })).max(256)

function campBuildFootprint(center: Position, material: string): { target: Position; block: string }[] {
  const blocks: { target: Position; block: string }[] = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue
    blocks.push({ target: { x: center.x + dx, y: center.y + 1, z: center.z + dz }, block: `minecraft:${material}` })
  }
  blocks.push({ target: { ...center, y: center.y + 2 }, block: 'minecraft:crafting_table' })
  return blocks
}

function validCampGatherProgress({ phase, changed, picked, returned, reason }: CampGatherProgress): boolean {
  if (picked && !changed) return false
  switch (phase) {
    case 'outbound': return !changed && !returned && reason === '-'
    case 'gathering': return !returned && reason === '-'
    case 'returning': return !returned
    case 'succeeded': return changed && picked && returned && reason === '-'
    case 'recovered': return !picked && returned && reason !== '-'
    case 'failed':
    case 'cancelled': return !returned
    default: return false
  }
}

function validSurveyProgress({ phase, checkpoints, returned, reason }: SurveyProgress, command: SurveyCommand): boolean {
  const reached = checkpoints === (command === 'surveytrail' ? 2 : 1)
  const extended = command !== 'survey'
  switch (phase) {
    case 'outbound': return !reached && !returned && reason === '-'
    case 'returning': return !returned && (reached ? reason === '-' : extended && reason === SURVEY_RETREAT_REASON)
    case 'succeeded': return reached && returned && reason === '-'
    case 'recovered': return extended && !reached && returned && reason === SURVEY_RETREAT_REASON
    case 'failed':
    case 'cancelled': return !returned && (!extended || reason.startsWith('survey-'))
    default: return false
  }
}

function parseSnbt(source: string): unknown {
  let index = 0
  const next = () => source[index++]
  const space = () => { while (/\s/u.test(source[index] ?? '')) index++ }
  function value(depth = 0): unknown {
    if (depth > 16 || index > 65_536) throw new Error('invalid-snbt')
    space()
    const char = source[index]
    if (char === '{') {
      index++
      const result: Record<string, unknown> = {}
      while (space(), source[index] !== '}') {
        if (index >= source.length) throw new Error('invalid-snbt')
        const key = String(value(depth + 1))
        space()
        if (next() !== ':') throw new Error('invalid-snbt')
        result[key] = value(depth + 1)
        space()
        if (source[index] === ',') index++
        else if (source[index] !== '}') throw new Error('invalid-snbt')
      }
      index++
      return result
    }
    if (char === '[') {
      index++
      if (/^[BIL];/u.test(source.slice(index, index + 2))) index += 2
      const result: unknown[] = []
      while (space(), source[index] !== ']') {
        if (index >= source.length) throw new Error('invalid-snbt')
        result.push(value(depth + 1))
        space()
        if (source[index] === ',') index++
        else if (source[index] !== ']') throw new Error('invalid-snbt')
      }
      index++
      return result
    }
    if (char === '"' || char === "'") {
      const quote = next()
      let text = ''
      while (index < source.length) {
        const char = next()
        if (char === quote) return text
        if (char === '\\') {
          const escaped = next()
          if (escaped === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(index, index + 4), 16))
            index += 4
          } else text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
        } else text += char
      }
      throw new Error('invalid-snbt')
    }
    const match = /^[^\s,\]:{}]+/u.exec(source.slice(index))
    if (!match) throw new Error('invalid-snbt')
    index += match[0].length
    const token = match[0]
    if (/^-?\d+[bsl]$/iu.test(token)) return Number(token.slice(0, -1))
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[fd]?$/iu.test(token)) return Number(token.replace(/[fd]$/iu, ''))
    if (token === 'true') return true
    if (token === 'false') return false
    return token
  }
  return value()
}

function numeric(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(String(value).replace(/[a-z]$/iu, ''))
  return Number.isFinite(number) ? number : undefined
}

function position(value: unknown): Position | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const numbers = value.map(numeric)
  return numbers.every(number => number !== undefined) ? { x: numbers[0]!, y: numbers[1]!, z: numbers[2]! } : undefined
}

export class CbiWorld extends EventEmitter {
  readonly botName: string
  private readonly serverRoot: string
  private readonly owner: string
  private readonly fifo: string
  private readonly logPath: string
  private online = false
  private creative = false
  private connecting = false
  private features?: { survival: boolean; safeReturn: boolean; crafting: boolean; shield: boolean; nightShelter: boolean; campBuilding: boolean; houseBuilding: boolean; houseRecovery: boolean; houseCellPlacement: boolean; campSurvey: boolean; campSurveyRoutes: boolean; campSurveyTrails: boolean; campGather: boolean; chatRelay: boolean }
  private chatRelayDemandUntil = 0
  private chatRelayRenewAt = 0
  private chatRelayMayBeActive = false
  private chatRelayChange?: Promise<void>
  private campPaused = process.env.COMPANION_MC_CAMP_PAUSED === '1'
  private campEpoch = 0
  private campStopping?: Promise<unknown>
  private visit?: CampVisit
  private visitEnded?: string
  private visitJournalInvalid = false
  private visitStart?: { id: string; controller: AbortController; promise?: Promise<unknown> }
  private visitEnd?: Promise<CampVisitEndReceipt>
  private visitStop?: Promise<unknown>
  private visitEnding = false
  private visitRetryAt = 0
  private visitLastCleanupError?: string
  private readonly visitPath: string
  private readonly wardrobeModels = configuredWardrobe(process.env.COMPANION_MC_YSM_MODELS)
  private wardrobeSupport?: { available: boolean; expiresAt: number }
  private wardrobeProbe?: Promise<boolean>
  private wardrobePending = false
  private wardrobeLast?: MinecraftWardrobeView['last']
  private connectionEpoch = 0
  private pendingDeath?: string
  private reflexEnabled = !this.campPaused
  private action?: Action
  private avoidTargets = new Set<string>()
  private lastError?: string
  private observation?: Record<string, unknown>
  private observing?: Promise<Record<string, unknown>>
  private commandQueue: Promise<unknown> = Promise.resolve()
  private incompleteConsoleRead = false
  private sequence = 0
  private readonly cursorPath: string
  private readonly events: Record<string, unknown>[] = []
  private logOffset = 0
  private pumping = false
  private remainder = ''
  private closing = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor() {
    super()
    this.botName = (process.env.COMPANION_MC_BOT_NAME || 'dafeiyu').toLowerCase()
    this.owner = process.env.COMPANION_MC_OWNER || 'thyysummer'
    if (!/^[a-z0-9_]{3,16}$/u.test(this.botName) || !/^[a-z0-9_]{3,16}$/iu.test(this.owner) || this.botName === this.owner.toLowerCase()) throw new Error('invalid-minecraft-player-name')
    this.serverRoot = process.env.COMPANION_MC_SERVER_ROOT || join(homedir(), '工作', '会话', 'coopcraft', 'server')
    const dataDir = process.env.COMPANION_MC_DATA_DIR || join(homedir(), '.local', 'share', 'companion', 'minecraft')
    this.fifo = process.env.COMPANION_MC_FIFO || join(dataDir, 'console.in')
    this.cursorPath = join(dataDir, 'cbi-events.cursor')
    this.visitPath = join(dataDir, 'camp-visit.json')
    this.logPath = join(this.serverRoot, 'logs', 'latest.log')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    try { this.logOffset = statSync(this.logPath).size } catch {}
    try {
      const cursor = Number(readFileSync(this.cursorPath, 'utf8'))
      if (Number.isSafeInteger(cursor) && cursor >= 0) this.sequence = cursor
    } catch {}
    try {
      const journal = CampVisitJournal.parse(JSON.parse(readFileSync(this.visitPath, 'utf8')))
      this.visit = journal.active
      this.visitEnded = journal.ended
      this.visitEnding = !!this.visit
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') this.visitJournalInvalid = true
    }
    this.timer = setInterval(() => { void this.pump(); this.reapCampVisit() }, 500)
    this.timer.unref()
  }

  private record(kind: string, data: Record<string, unknown> = {}): void {
    this.sequence++
    writeFileSync(this.cursorPath, String(this.sequence), { mode: 0o600 })
    const { kind: action, ...details } = data
    this.events.push({ seq: this.sequence, at: new Date().toISOString(), ...details, ...(action === undefined ? {} : { action }), kind })
    if (this.events.length > 100) this.events.shift()
  }

  eventsAfter(cursor: number): Record<string, unknown>[] {
    return this.events.filter(event => Number(event.seq) > cursor).slice(-50)
  }

  refreshChatRelay(wanted: boolean): void {
    const now = performance.now()
    this.chatRelayDemandUntil = wanted ? now + CHAT_RELAY_POLL_FRESH_MS : 0
    if (!this.features?.chatRelay || !this.online || this.closing || this.chatRelayChange) return
    const renew = this.chatRelayRequested()
    if (renew ? now < this.chatRelayRenewAt : !this.chatRelayMayBeActive) return
    const epoch = this.connectionEpoch
    const command = `cbi_chat_relay ${this.botName} ${renew ? `renew ${this.owner}` : 'clear'}`
    const receipt = `CBI chat relay bot=${this.botName} ${renew ? `renewed owner=${this.owner}` : 'cleared'}`
    if (renew) this.chatRelayRenewAt = now + CHAT_RELAY_RENEW_MS
    this.chatRelayChange = this.send(command, log => log.split('\n').some(line => /^\[[^\]]+\] \[Server thread\/INFO\]: (.*)$/u.exec(line)?.[1] === receipt),
      2000, 0, undefined, () => {
        if (epoch !== this.connectionEpoch || this.closing || renew !== this.chatRelayRequested()) throw new Error('minecraft-chat-relay-stale')
        if (renew) this.chatRelayMayBeActive = true
      }).then(() => {
        if (!renew && epoch === this.connectionEpoch) {
          this.chatRelayMayBeActive = false
          this.chatRelayRenewAt = 0
        }
      }).catch(() => {}).finally(() => { this.chatRelayChange = undefined })
  }

  private chatRelayRequested(): boolean {
    return performance.now() < this.chatRelayDemandUntil && !this.campPaused && !this.connecting &&
      !this.visit && !this.visitStart && this.action?.kind !== 'house-build' && this.action?.kind !== 'house-cell' &&
      this.action?.kind !== 'house-supply'
  }

  updateLessons(input: unknown): Record<string, unknown> {
    const targets = z.array(z.object({
      x: z.number().int().min(-30_000_000).max(30_000_000),
      y: z.number().int().min(-2048).max(2032),
      z: z.number().int().min(-30_000_000).max(30_000_000),
      block: z.string().regex(/^[a-z_]+$/u).optional(),
    })).max(64).parse(input)
    this.avoidTargets = new Set(targets.map(target => `${target.x},${target.y},${target.z}`))
    this.record('learning.updated', { avoidedTargets: this.avoidTargets.size })
    return { avoidedTargets: this.avoidTargets.size }
  }

  activityPresence(): { online: boolean; action?: string; campSurveyReady: boolean; campVisitReady: boolean } {
    const action = this.action
    return { online: this.online, action: action && !action.controller.signal.aborted ? action.kind : undefined,
      campSurveyReady: this.online && !this.campPaused && !this.connecting && !action && !this.visitEnding && this.features?.campSurvey === true,
      campVisitReady: !this.online && !this.campPaused && !this.connecting && !action && !this.visit && !this.visitStart && !this.visitJournalInvalid }
  }

  view(): Record<string, unknown> {
    return {
      online: this.online,
      connecting: this.connecting,
      action: this.action?.kind,
      profile: { name: this.botName, uuid: 'carpet-fake-player' },
      auth: { state: 'ready', mode: 'cbi' },
      lastError: this.lastError,
      observation: this.observation,
      learning: { avoidedTargets: this.avoidTargets.size },
      capabilities: {
        pathfinder: true, pickup: true, follow: true, navigation: true, gather: true, driver: 'carpet-cbi',
        safeReturn: this.features?.safeReturn ?? false,
        crafting: this.features?.crafting ?? false,
        shield: this.features?.shield ?? false,
        nightShelter: this.features?.nightShelter ?? false,
        campBuilding: this.features?.campBuilding ?? false,
        houseBuilding: this.features?.houseBuilding ?? false,
        houseProjects: this.online && this.features?.houseBuilding === true,
        houseRecovery: this.online && this.features?.houseBuilding === true && this.features.houseRecovery === true,
        houseCellPlacement: this.features?.houseCellPlacement ?? false,
        campSurvey: this.features?.campSurvey ?? false,
        campVisit: !this.visitJournalInvalid,
        campVisitSupply: !this.visitJournalInvalid,
        campVisitBuild: !this.visitJournalInvalid,
        campVisitRevisit: !this.visitJournalInvalid,
        campVisitPatrol: !this.visitJournalInvalid,
        campVisitGather: !this.visitJournalInvalid,
        campGather: this.features?.campGather ?? false,
        ...(this.features?.campSurveyRoutes && { campSurveyRoutes: true }),
        ...(this.features?.campSurveyTrails && { campSurveyTrails: true }),
      },
    }
  }

  private async readLog(offset: number, maxBytes = 131_072): Promise<{ offset: number; text: string }> {
    const info = await stat(this.logPath)
    const start = Math.max(info.size < offset ? 0 : offset, info.size - maxBytes)
    const length = info.size - start
    if (!length) return { offset: info.size, text: '' }
    const file = await open(this.logPath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, start)
      return { offset: info.size, text: buffer.toString('utf8') }
    } finally { await file.close() }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closing) return
    this.pumping = true
    try {
      const chunk = await this.readLog(this.logOffset)
      if (chunk.text.length > 262_144) {
        this.logOffset = chunk.offset
        return
      }
      this.logOffset = chunk.offset
      const lines = (this.remainder + chunk.text).split('\n')
      this.remainder = lines.pop() ?? ''
      for (const line of lines) {
        const message = /^\[[^\]]+\] \[Server thread\/INFO\]: (.*)$/u.exec(line)?.[1]
        if (!message) continue
        if (message.startsWith('Starting minecraft server version ')) {
          this.markOffline('server-restart')
          this.record('server.restarting')
        }
        if (message === 'Stopping server') this.markOffline('server-stop')
        const chat = /^(?:\[Not Secure\] )?<([a-zA-Z0-9_]{3,16})> (.*)$/u.exec(message)
        if (chat && chat[1] && chat[1].toLowerCase() !== this.botName && !chat[2]?.startsWith('[CBI]')) {
          this.record('chat.received', { username: chat[1], message: chat[2]?.slice(0, 256) ?? '' })
        }
        const whisper = /^Intercepted \/tell sender=([a-zA-Z0-9_]{3,16}) target=([a-zA-Z0-9_]{3,16}) route=(?:companion|llm) message=(.+)$/u.exec(message)
        if (whisper?.[1]?.toLowerCase() === this.owner.toLowerCase() && whisper[2]?.toLowerCase() === this.botName) {
          this.record('chat.received', { username: whisper[1], message: whisper[3]?.slice(0, 256) ?? '', delivery: 'private' })
        }
        const presence = /^([a-zA-Z0-9_]{3,16}) (joined|left) the game$/u.exec(message)
        const player = presence?.[1]?.toLowerCase()
        if (player === this.botName && presence?.[2] === 'joined' && !this.online) {
          this.pendingDeath = undefined
          this.online = true
          if (this.campPaused) void this.pauseCamp().catch(() => {})
          else if (!this.connecting && !this.visit && !this.visitStart) void this.withCampAction(() => this.connect()).catch(() => {})
        }
        const deathDisconnect = `${this.botName} lost connection: ${this.botName} died`
        const deathText = message.startsWith(`${this.botName} `) ? message.slice(this.botName.length + 1) : ''
        if (/^(?:drowned|died|was (?:slain|shot|killed|blown up|pricked|impaled)|fell|hit the ground|tried to swim|went up in flames|burned|starved|suffocated)\b/u.test(deathText)) {
          this.pendingDeath = message.slice(0, 240)
        }
        if (message === deathDisconnect) {
          this.record('player.death', { message: this.pendingDeath ?? `${this.botName} died`,
            position: this.observation?.position, oxygen: this.observation?.oxygen })
          this.pendingDeath = undefined
        }
        if (player === this.botName && presence?.[2] === 'left') {
          this.markOffline()
        }
        if (new RegExp(`<${this.botName}> (?:任务失败|没有食物|缺少工具|找不到可行路径|卡住|目标不可用)`, 'iu').test(line)) {
          this.record('world.alert', { message: line.slice(-300) })
          const action = this.action
          const target = action?.digTarget
          if (action?.kind === 'dig' && target &&
              message === `<${this.botName}> 任务失败：无法到达目标方块: ${target.x} ${target.y} ${target.z}`) {
            action.unreachable = true
          }
        }
        if (new RegExp(`<${this.owner}> .*?\\[CBI\\]`, 'iu').test(line)) this.record('owner.feedback', { message: line.slice(-300) })
        if (player === this.owner.toLowerCase()) {
          const joined = presence?.[2] === 'joined'
          this.record(joined ? 'owner.online' : 'owner.offline')
          const action = this.action
          if (!joined && action?.kind === 'follow' && !action.controller.signal.aborted) void this.stopFollowing(action)
        }
      }
    } catch {} finally { this.pumping = false }
  }

  private markOffline(reason?: string): void {
    const wasOnline = this.online
    this.connectionEpoch++
    this.wardrobeSupport = undefined
    this.pendingDeath = undefined
    this.action?.controller.abort()
    this.online = false
    this.features = undefined
    this.chatRelayDemandUntil = 0
    this.chatRelayRenewAt = 0
    this.chatRelayMayBeActive = false
    this.observation = undefined
    this.action = undefined
    if (wasOnline) this.record('connection.offline', reason ? { reason } : {})
  }

  private async stopFollowing(action: Action): Promise<void> {
    action.controller.abort()
    try {
      const completion = new RegExp(`CBI feedback sender=${this.botName} target=${this.botName} message="?\\[CBI\\] 已停止当前 cbi 任务`, 'u')
      await this.cbi('stop', this.botName, 0, completion)
      if (this.action !== action) return
      this.action = undefined
      if (this.observation) this.observation.action = undefined
      this.record('follow.ended', { reason: 'owner-offline' })
    } catch (error) {
      if (this.action === action) this.record('stop.unconfirmed', { reason: 'owner-offline', message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async send(command: string, accept: RegExp | ((text: string) => boolean), timeout = 6000, settleMs = 0, signal?: AbortSignal, onDispatch?: () => void, longRead = false): Promise<string> {
    if (this.closing) throw new Error('minecraft-worker-closing')
    if (/\r|\n|[\u0000-\u001f\u007f]/u.test(command)) throw new Error('invalid-console-command')
    const result = this.commandQueue.then(async () => {
      this.assertCampAdmission()
      signal?.throwIfAborted()
      const offset = (await stat(this.logPath)).size
      const discarding = this.incompleteConsoleRead
      await this.writeConsole(command, () => {
        this.assertCampAdmission()
        signal?.throwIfAborted()
        onDispatch?.()
      }, longRead)
      const deadline = Date.now() + timeout
      let matchedAt: number | undefined
      let latest = ''
      while (Date.now() < deadline) {
        if (onDispatch) signal?.throwIfAborted()
        const chunk = await this.readLog(offset)
        latest += chunk.text
        if (accept instanceof RegExp ? accept.test(latest) : accept(latest)) {
          matchedAt ??= Date.now()
          if (Date.now() - matchedAt >= settleMs) return latest.slice(-131_072)
        }
        if (!discarding && /Unknown (?:or incomplete )?command|Incorrect argument for command|Permission denied|unknown or incomplete command/iu.test(latest)) throw new Error('console-command-rejected')
        if (Date.now() >= deadline) break
        await delay(80)
      }
      throw new Error(`console-receipt-timeout:${command.split(' ')[0]}`)
    })
    this.commandQueue = result.catch(() => {})
    return result
  }

  private async writeConsole(command: string, guard = () => {}, longRead = false): Promise<void> {
    // A missing console must not turn into a file, and a stopped reader must not stall the worker.
    const pipe = await open(this.fifo, constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      guard()
      if (this.incompleteConsoleRead) {
        // Invalidate the partial read before writing another command on this console.
        await pipe.writeFile(' !companion-incomplete-read!\n', 'utf8')
        this.incompleteConsoleRead = false
        guard()
      }
      if (!longRead) {
        await pipe.writeFile(`${command}\n`, 'utf8')
        return
      }
      const frame = Buffer.from(`${command}\n`)
      const tail = command.lastIndexOf(' run data get entity ')
      const prefixBytes = Buffer.byteLength(command.slice(0, tail))
      // Keep the executable read clause and newline together in one portable PIPE_BUF write.
      if (tail < 1 || frame.length - prefixBytes > 512) throw new Error('invalid-console-read-frame')
      const deadline = Date.now() + 2000
      let offset = 0
      try {
        // Compound read-only snapshots can exceed the capacity of the nonblocking FIFO.
        while (offset < frame.length) {
          guard()
          if (Date.now() >= deadline) throw new Error('console-write-timeout')
          try {
            const end = offset < prefixBytes ? prefixBytes : frame.length
            const { bytesWritten } = await pipe.write(frame, offset, end - offset)
            if (bytesWritten) { offset += bytesWritten; continue }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') throw error
          }
          await delay(5)
        }
      } catch (error) {
        this.incompleteConsoleRead = offset > 0
        throw error
      }
    } finally { await pipe.close() }
  }

  private async hasWardrobeSupport(): Promise<boolean> {
    if (!this.wardrobeModels.length || !this.online || this.closing) return false
    if (this.wardrobeSupport && Date.now() < this.wardrobeSupport.expiresAt) return this.wardrobeSupport.available
    const epoch = this.connectionEpoch
    this.wardrobeProbe ??= (async () => {
      let available = false
      try {
        await this.send('help ysm model set', ysmWardrobeAvailable, 1500)
        const state = await this.wardrobeState()
        available = typeof state === 'object' && !state.disabled
      } catch { /* Unsupported, offline or unverified. */ }
      if (epoch !== this.connectionEpoch || !this.online) return false
      this.wardrobeSupport = { available, expiresAt: Date.now() + 30_000 }
      return available
    })().finally(() => { this.wardrobeProbe = undefined })
    return this.wardrobeProbe
  }

  private wardrobeView(available: boolean): MinecraftWardrobeView {
    return { available, options: this.wardrobeModels.map(({ id, label }) => ({ id, label })),
      ...(this.wardrobeLast && { last: this.wardrobeLast }) }
  }

  async wardrobe(): Promise<MinecraftWardrobeView> {
    return this.wardrobeView(await this.hasWardrobeSupport())
  }

  private async wardrobeState(signal?: AbortSignal): Promise<WardrobeModelState | 'absent' | 'offline'> {
    // YSM 2.6.5 adds this appearance attachment to vanilla Entity.writeNbt.
    // Data commands can read it even when server logs use untranslated YSM keys.
    const read = (log: string) => ysmWardrobeStateLine(log, this.botName)
    const line = read(await this.send(`data get entity ${this.botName} ${YSM_MODEL_NBT}`, log => read(log) !== undefined,
      2000, 0, signal, signal && (() => {})))
    if (!line || line.kind === 'absent') return 'absent'
    if (line.kind === 'offline') return 'offline'
    if (line.kind !== 'data') return 'absent'
    const nbt = parseSnbt(line.snbt) as Record<string, unknown> | undefined
    if (typeof nbt?.model_id !== 'string' || typeof nbt.select_texture !== 'string' ||
      ![true, false, 1, 0].includes(nbt.mandatory as boolean | number) ||
      ![true, false, 1, 0].includes(nbt.disabled as boolean | number)) return 'absent'
    return { modelId: nbt.model_id, texture: nbt.select_texture, mandatory: Boolean(nbt.mandatory), disabled: Boolean(nbt.disabled) }
  }

  async changeAppearance(id: string, signal: AbortSignal): Promise<MinecraftWardrobeView> {
    this.assertCampAdmission()
    if (this.campPaused) throw new Error('minecraft-camp-paused')
    if (!this.wardrobeModels.length) throw new Error('minecraft-wardrobe-unavailable')
    const model = this.wardrobeModels.find(entry => entry.id === id)
    if (!model) throw new Error('minecraft-wardrobe-option-not-found')
    if (!this.online || this.connecting) throw new Error('minecraft-wardrobe-offline')
    if (this.wardrobePending) throw new Error('minecraft-wardrobe-busy')
    const epoch = this.connectionEpoch
    this.wardrobePending = true
    const guard = () => {
      this.assertCampAdmission()
      if (this.campPaused) throw new Error('minecraft-camp-paused')
      if (signal.aborted) throw new Error('minecraft-wardrobe-cancelled')
      if (!this.online || epoch !== this.connectionEpoch) throw new Error('minecraft-wardrobe-offline')
    }
    try {
      guard()
      const available = await this.hasWardrobeSupport()
      guard()
      if (!available) throw new Error('minecraft-wardrobe-unavailable')
      const readState = () => this.wardrobeState(signal).catch(() => {
        guard()
        throw new Error('minecraft-wardrobe-unconfirmed')
      })
      const before = await readState()
      guard()
      if (before === 'offline') throw new Error('minecraft-wardrobe-offline')
      if (before === 'absent' || before.disabled) {
        this.wardrobeSupport = undefined
        throw new Error('minecraft-wardrobe-unavailable')
      }
      const command = `ysm model set ${this.botName} ${JSON.stringify(model.modelId)} -`
      const resultOf = (log: string) => ysmWardrobeReceipt(log, this.botName, model.modelId)
      let receipt: ReturnType<typeof resultOf>
      try {
        receipt = resultOf(await this.send(command, log => resultOf(log) !== undefined, 4000, 0, signal, guard))
      } catch (error) {
        guard()
        if (error instanceof Error && error.message === 'console-command-rejected') {
          this.wardrobeSupport = undefined
          throw new Error('minecraft-wardrobe-unavailable')
        }
        throw new Error('minecraft-wardrobe-unconfirmed')
      }
      guard()
      if (receipt !== 'accepted' && receipt !== 'raw-accepted') throw new Error(`minecraft-wardrobe-${receipt ?? 'unconfirmed'}`)
      const after = await readState()
      guard()
      if (after === 'offline') throw new Error('minecraft-wardrobe-offline')
      if (after === 'absent' || after.disabled || after.modelId !== model.modelId || !after.mandatory || !after.texture ||
        (receipt === 'raw-accepted' && before.modelId === model.modelId && before.mandatory)) {
        throw new Error('minecraft-wardrobe-unconfirmed')
      }
      this.wardrobeLast = { id, confirmedAt: new Date().toISOString() }
      return this.wardrobeView(true)
    } finally { this.wardrobePending = false }
  }

  private async data(player: string, path: string, signal?: AbortSignal): Promise<EntityData | undefined> {
    const output = await this.send(`data get entity ${player} ${path}`, new RegExp(`${player} has the following entity data:|No entity was found`, 'iu'), 6000, 0, signal, signal && (() => {}))
    if (/No entity was found/iu.test(output)) return undefined
    const marker = /has the following entity data:\s*/iu.exec(output)
    if (!marker || marker.index === undefined) throw new Error('entity-data-unconfirmed')
    const raw = output.slice(marker.index + marker[0].length).trim().split('\n')[0] ?? ''
    if (path === 'Pos') {
      const values = [...raw.matchAll(/(-?\d+(?:\.\d+)?)[dD]?/gu)].map(match => Number(match[1]))
      if (values.length >= 3) return values.slice(0, 3)
    }
    if (path === 'Dimension' || path === 'Inventory') return parseSnbt(raw) as EntityData
    return numeric(raw) ?? raw.replace(/^"|"$/gu, '')
  }

  private async block(position: Position, expected: string, dimension?: string, signal?: AbortSignal, guard?: () => void): Promise<boolean> {
    if (!/^[#a-z0-9_:.\-[\],=]+$/u.test(expected)) throw new Error('invalid-block-id')
    const scope = dimension ? ` in ${dimension}` : ''
    const receipt = signal ? CAMP_VISIT_BLOCK_CHECK : /Test (?:passed|failed)/iu
    const output = await this.send(`execute${scope} if block ${position.x} ${position.y} ${position.z} ${expected}`, receipt, 6000, 0, signal, guard ?? (signal && (() => {})))
    if (!signal) return /Test passed/iu.test(output)
    const result = CAMP_VISIT_BLOCK_CHECK.exec(output)?.[1]
    if (!result) throw new Error('block-check-unconfirmed')
    return result === 'passed'
  }

  private async cbi(command: string, sender = this.botName, settleMs = 0, completion: RegExp = /\[CBI\] /u, signal?: AbortSignal, onDispatch?: () => void, camp?: CampVisit['zone']): Promise<string> {
    const guard = camp ? ` at @s if dimension ${camp.dimension} positioned ${camp.x + 0.5} ${camp.y} ${camp.z + 0.5} if entity @s[distance=..0.35]` : ''
    const output = await this.send(`execute as ${sender}${guard} run tell ${this.botName} cbi ${command}`, completion, 8000, settleMs, signal, onDispatch)
    if (/\[CBI\] .*?(?:错误|未知指令|寻路执行失败|找不到)/u.test(output)) throw new Error(output.slice(output.lastIndexOf('[CBI]'), output.lastIndexOf('[CBI]') + 240))
    return output
  }

  private async survivalStatus(): Promise<string | undefined> {
    const receipt = new RegExp(`CBI feedback sender=${this.botName} target=${this.botName} message="?\\[CBI\\] (threat=[^"\\r\\n]+|错误: 未知指令。发送 cbi help 查看帮助)`, 'u')
    const output = await this.send(`execute as ${this.botName} run tell ${this.botName} cbi survival`, receipt, 8000)
    const status = receipt.exec(output)?.[1]
    return status?.startsWith('threat=') ? status : undefined
  }

  private async configure() {
    if (this.features) return this.features
    const navigation = new RegExp(`CBI feedback sender=${this.botName} target=${this.botName} message="?\\[CBI\\] 导航: ([^"\\r\\n]+)`, 'u')
    const help = await this.cbi('help', this.botName, 0, navigation)
    const commands = navigation.exec(help)?.[1]?.split(',').map(command => command.trim()) ?? []
    const survival = (await this.survivalStatus()) !== undefined
    for (const [name, value] of [
      ['llmEnabled', 'false'],
      ['diagnosticLogging', 'false'],
      ['autoCombat', String(this.reflexEnabled)],
      ['emergencyAvoidance', String(this.reflexEnabled)],
      ['autoEat', String(this.reflexEnabled)],
      ...(survival ? [['survivalAutoCraft', String(this.reflexEnabled)], ['survivalResourceReserve', '16']] : []),
      ['itemSaver', 'true'],
      ['itemSaverThreshold', '5'],
      ['allowPlace', 'false'],
      ['allowBreak', 'false'],
      ['allowBreakAnyway', LOGS.join(',')],
      ['fakePlayerCompletionMessageMinTicks', '0'],
    ]) {
      const output = await this.cbi(`set ${name} ${value}`)
      if (!output.includes(`[CBI] ${name} =`)) throw new Error(`cbi-setting-unconfirmed:${name}`)
    }
    const campSurvey = survival && commands.includes('survey')
    const campSurveyRoutes = campSurvey && commands.includes('surveyroute')
    const houseBuilding = (survival || this.creative) && commands.includes('homebuild')
    this.features = {
      survival,
      safeReturn: survival && commands.includes('return'),
      crafting: survival && commands.includes('craft'),
      shield: survival && commands.includes('shield'),
      nightShelter: commands.includes('nightbed') && commands.includes('nightshelter'),
      campBuilding: survival && commands.includes('buildcamp'),
      houseBuilding,
      houseRecovery: houseBuilding && commands.includes('homebuildrecover'),
      houseCellPlacement: houseBuilding && commands.includes('homebuildone'),
      campSurvey,
      campSurveyRoutes,
      campSurveyTrails: campSurveyRoutes && commands.includes('surveytrail'),
      campGather: campSurvey && commands.includes('campgather'),
      chatRelay: help.includes(`CBI feedback sender=${this.botName} target=${this.botName} message="[CBI] Companion 私聊转接: v1`),
    }
    this.record('safety.configured', { llm: false, place: false, generalBreak: false, reflex: this.reflexEnabled, ...(survival && { resourceReserve: 16 }) })
    return this.features
  }

  private async setReflex(enabled: boolean): Promise<void> {
    const settings = ['autoCombat', 'emergencyAvoidance', 'autoEat']
    if (this.features?.survival) settings.push('survivalAutoCraft')
    for (const name of settings) {
      const output = await this.cbi(`set ${name} ${enabled}`)
      if (!output.includes(`[CBI] ${name} = ${enabled}`)) throw new Error(`cbi-setting-unconfirmed:${name}`)
    }
    this.reflexEnabled = enabled
    this.record('reflex.changed', { enabled })
  }

  private async setActionAutoCraft(enabled: boolean, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    const command = `set survivalAutoCraft ${enabled}`
    const output = signal || onDispatch ? await this.cbi(command, this.botName, 0, /\[CBI\] /u, signal, onDispatch) : await this.cbi(command)
    if (!output.includes(`[CBI] survivalAutoCraft = ${enabled}`)) throw new Error('autocraft-setting-unconfirmed')
  }

  private async restoreActionAutoCraft(): Promise<void> {
    await this.setActionAutoCraft(this.reflexEnabled).catch(error => {
      this.record('safety.restore-failed', { setting: 'survivalAutoCraft', message: error instanceof Error ? error.message : String(error) })
    })
  }

  private async positionOf(player: string, signal?: AbortSignal): Promise<Position | undefined> {
    return position(await this.data(player, 'Pos', signal))
  }

  async observe(): Promise<Record<string, unknown>> {
    this.observing ??= this.observeInternal().finally(() => { this.observing = undefined })
    return this.observing
  }

  private async observeInternal(): Promise<Record<string, unknown>> {
    const current = await this.positionOf(this.botName)
    if (!current) {
      this.markOffline()
      throw new Error('minecraft-offline')
    }
    const dimension = String(await this.data(this.botName, 'Dimension') ?? '')
    const health = numeric(await this.data(this.botName, 'Health'))
    const food = numeric(await this.data(this.botName, 'foodLevel'))
    const saturation = numeric(await this.data(this.botName, 'foodSaturationLevel'))
    const oxygen = numeric(await this.data(this.botName, 'Air'))
    const mode = numeric(await this.data(this.botName, 'playerGameType'))
    const inventoryData = await this.data(this.botName, 'Inventory')
    const inventory = Array.isArray(inventoryData) ? inventoryData.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const value = item as Record<string, unknown>
      return typeof value.id === 'string' && numeric(value.count) !== undefined ? [{ name: value.id.replace(/^minecraft:/u, ''), count: numeric(value.count)! }] : []
    }) : []
    const timeOutput = await this.send('time query daytime', /The time is -?\d+/iu)
    const timeOfDay = numeric(/The time is (-?\d+)/iu.exec(timeOutput)?.[1])
    const listOutput = await this.send('list', /players online:/iu)
    const playerNames = (listOutput.split('players online:').at(-1)?.trim().split('\n')[0] ?? '').split(',').map(name => name.trim()).filter(name => /^[a-z0-9_]{3,16}$/iu.test(name) && name.toLowerCase() !== this.botName)
    const ownerPosition = playerNames.some(name => name.toLowerCase() === this.owner.toLowerCase()) ? await this.positionOf(this.owner) : undefined
    const distance = ownerPosition ? Math.hypot(ownerPosition.x - current.x, ownerPosition.y - current.y, ownerPosition.z - current.z) : undefined
    let cbiStatus: string | undefined
    let survival: Record<string, unknown> | undefined
    if (this.features) {
      const status = await this.cbi('status')
      cbiStatus = status.slice(status.lastIndexOf('[CBI] ') + 6).trim().split('\n')[0]?.replace(/"$/u, '')
    }
    if (this.features?.survival) {
      const line = await this.survivalStatus()
      if (!line) throw new Error('survival-status-unconfirmed')
      survival = {}
      for (const match of line.matchAll(/([a-zA-Z]+)=([^\s"]+)/gu)) {
        const value = match[2] ?? ''
        survival[match[1]!] = value === 'true' ? true : value === 'false' ? false : /^-?\d+$/u.test(value) ? Number(value) : value
      }
    }
    this.online = true
    this.observation = {
      online: true, username: this.botName, version: '1.21.1',
      position: { x: Number(current.x.toFixed(3)), y: Number(current.y.toFixed(3)), z: Number(current.z.toFixed(3)) },
      dimension, gameMode: ['survival', 'creative', 'adventure', 'spectator'][mode ?? -1] ?? 'unknown',
      health, food, saturation, oxygen, timeOfDay,
      players: playerNames.map(name => ({ name, ...(name.toLowerCase() === this.owner.toLowerCase() ? { distance, position: ownerPosition } : {}) })),
      inventory, action: this.action?.kind, cbiStatus, survival, observedAt: new Date().toISOString(),
    }
    return this.observation
  }

  login(): unknown {
    return { auth: { state: 'ready', mode: 'cbi' }, profile: { name: this.botName }, accountRequired: false }
  }

  withCampAction<T>(run: () => T, visitId?: string): T {
    if (this.campPaused) throw new Error('minecraft-camp-paused')
    if (this.action?.kind === 'house-build' || this.action?.kind === 'house-cell' || this.action?.kind === 'house-supply') throw new Error('action-busy')
    if (visitId !== undefined) {
      if (this.visit?.id !== visitId || this.visitEnding || Date.now() >= this.visit.expiresAt) throw new Error('minecraft-camp-visit-refused')
    } else if (this.visit || this.visitStart) throw new Error('minecraft-camp-visit-busy')
    return campAdmission.run({ world: this, epoch: this.campEpoch, visitId }, run)
  }

  private assertCampAdmission(): void {
    const admission = campAdmission.getStore()
    if (admission?.world === this && (this.campPaused || admission.epoch !== this.campEpoch)) throw new Error('minecraft-camp-paused')
    if (admission?.world !== this) return
    if (admission.visitId !== undefined) {
      if (this.visitEnding || (this.visit?.id ?? this.visitStart?.id) !== admission.visitId ||
        (this.visit && Date.now() >= this.visit.expiresAt) || this.visitStart?.controller.signal.aborted) {
        throw new Error('minecraft-camp-visit-cancelled')
      }
    } else if (this.visit || this.visitStart) throw new Error('minecraft-camp-visit-busy')
  }

  private saveCampVisit(active?: CampVisit, ended = this.visitEnded): void {
    const temp = `${this.visitPath}.${randomBytes(8).toString('hex')}`
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ active, ended }))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temp, this.visitPath)
    this.visit = active
    this.visitEnded = ended
  }

  private async visitPresence(): Promise<boolean> {
    const receipt = /^\[[^\]\r\n]+\] \[Server thread\/INFO\]: There are (\d+) of a max of \d+ players online:[ \t]*([^\r\n]*)\r?\n/mu
    const match = receipt.exec(await this.send('list', receipt))
    const names = match?.[2]?.trim() ? match[2].split(',').map(name => name.trim()) : []
    if (!match || Number(match[1]) !== names.length || names.some(name => !/^[a-z0-9_]{3,16}$/iu.test(name))) {
      throw new Error('minecraft-camp-visit-presence-unconfirmed')
    }
    return names.some(name => name.toLowerCase() === this.botName)
  }

  private visitLogin(): RegExp {
    return new RegExp(`^\\[[^\\]\\r\\n]+\\] \\[Server thread/INFO\\]: ${this.botName}\\[local\\] logged in with entity id [0-9]+ at \\(`, 'mu')
  }

  private visitDenial(): RegExp {
    return new RegExp(`^\\[[^\\]\\r\\n]+\\] \\[Server thread/INFO\\]: Player ${this.botName} (?:is already (?:logged on|logged in|online)|is banned on this server|is either banned by Mojang|cannot be placed outside of the world|doesn't exist and cannot spawn in online mode)`, 'imu')
  }

  private async visitLogState(visit: CampVisit): Promise<'pending' | 'owned' | 'left' | 'denied' | 'unknown'> {
    const start = visit.dispatch
    if (!start) return 'left'
    const same = (info: Stats) => info.dev === start.dev && info.ino === start.ino &&
      info.size >= start.offset && info.size - start.offset <= CAMP_VISIT_LOG_LIMIT
    if (!same(await stat(this.logPath))) {
      const { text } = await this.readLog(0, CAMP_VISIT_LOG_LIMIT)
      return /^\[[^\]\r\n]+\] \[Server thread\/INFO\]: Starting minecraft server version /mu.test(text) ? 'left' : 'unknown'
    }
    const { text } = await this.readLog(start.offset, CAMP_VISIT_LOG_LIMIT)
    if (!same(await stat(this.logPath))) return 'unknown'
    const login = this.visitLogin().exec(text)
    const denial = this.visitDenial().exec(text)
    if (denial && (!login || denial.index < login.index)) return 'denied'
    if (!login) return 'pending'
    const left = new RegExp(`^\\[[^\\]\\r\\n]+\\] \\[Server thread/INFO\\]: (?:${this.botName} left the game|Stopping server)\\r?$`, 'mu')
    return left.test(text.slice(login.index)) ? 'left' : 'owned'
  }

  private async verifyCampVisitSpawn(zone: CampVisit['zone'], signal: AbortSignal): Promise<void> {
    const { dimension, x, y, z } = zone
    const loaded = await this.send(`execute in ${dimension} if loaded ${x} ${y} ${z}`, /Test (?:passed|failed)/iu, 4000, 0, signal, () => {})
    if (!/Test passed/iu.test(loaded)) throw new Error('minecraft-camp-visit-spawn-unsafe')
    for (const airY of [y, y + 1]) {
      signal.throwIfAborted()
      const point = { x, y: airY, z }
      if (!await this.block(point, 'minecraft:air', dimension) && !await this.block(point, 'minecraft:cave_air', dimension)) {
        throw new Error('minecraft-camp-visit-spawn-unsafe')
      }
    }
    for (const floor of CAMP_VISIT_FLOORS) {
      signal.throwIfAborted()
      if (await this.block({ x, y: y - 1, z }, `minecraft:${floor}`, dimension)) return
    }
    throw new Error('minecraft-camp-visit-spawn-unsafe')
  }

  startCampVisit(input: unknown, signal: AbortSignal): Promise<unknown> {
    const parsed = CampVisitStart.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const visit = parsed.data
    const now = Date.now()
    const max = visit.gather ? CAMP_GATHER_MAX_MS : visit.patrol ? CAMP_PATROL_MAX_MS : CAMP_VISIT_MAX_MS
    if (visit.expiresAt <= now || visit.expiresAt > now + max) throw new Error('minecraft-camp-visit-invalid-request')
    if (this.campPaused) throw new Error('minecraft-camp-paused')
    if (!this.activityPresence().campVisitReady || this.closing || this.visitEnded === visit.id) throw new Error('minecraft-camp-visit-busy')
    signal.throwIfAborted()
    const start = { id: visit.id, controller: new AbortController(), promise: undefined as Promise<unknown> | undefined }
    this.visitEnding = false
    this.visitLastCleanupError = undefined
    this.visitStart = start
    this.connecting = true
    const guarded = AbortSignal.any([start.controller.signal, signal, AbortSignal.timeout(visit.expiresAt - now)])
    start.promise = campAdmission.run({ world: this, epoch: this.campEpoch, visitId: visit.id }, async () => {
      try {
        if (await this.visitPresence()) throw new Error('minecraft-camp-visit-already-online')
        guarded.throwIfAborted()
        this.assertCampAdmission()
        this.saveCampVisit(visit)
        await this.verifyCampVisitSpawn(visit.zone, guarded)
        guarded.throwIfAborted()
        this.assertCampAdmission()
        if (await this.visitPresence()) throw new Error('minecraft-camp-visit-already-online')
        const login = this.visitLogin()
        const deny = this.visitDenial()
        const { x, y, z, dimension } = visit.zone
        const spawn = `player ${this.botName} spawn at ${x + 0.5} ${y} ${z + 0.5} facing 0 0 in ${dimension} in survival`
        const result = await this.send(spawn, text => login.test(text) || deny.test(text), 15_000, 0, undefined, () => {
          guarded.throwIfAborted()
          const info = statSync(this.logPath)
          this.saveCampVisit({ ...visit, dispatch: { dev: info.dev, ino: info.ino, offset: info.size } })
        })
        if (!login.test(result) || await this.visitLogState(this.visit!) !== 'owned') throw new Error('minecraft-camp-visit-spawn-refused')
        guarded.throwIfAborted()
        this.reflexEnabled = false
        this.features = undefined
        const observation = await this.observeInternal()
        const position = observation.position as Position
        const camp = visit.zone
        if (observation.dimension !== camp.dimension || observation.gameMode !== 'survival' ||
          Math.hypot(position.x - camp.x - 0.5, position.y - camp.y, position.z - camp.z - 0.5) > 0.35 ||
          !(Number(observation.health) >= 8 && Number(observation.food) >= 6 && Number(observation.oxygen) >= 200)) {
          throw new Error('minecraft-camp-visit-spawn-unsafe')
        }
        guarded.throwIfAborted()
        const features = await this.configure()
        if (visit.gather && !features.campGather) throw new Error('minecraft-camp-visit-gather-unavailable')
        const status = await this.survivalStatus()
        const onGround = numeric(await this.data(this.botName, 'OnGround'))
        guarded.throwIfAborted()
        this.assertCampAdmission()
        if (!features.campSurvey || visit.patrol && !features.campSurveyRoutes || !/^threat=NONE\b/u.test(status ?? '') || onGround !== 1 ||
          await this.visitLogState(this.visit!) !== 'owned') throw new Error('minecraft-camp-visit-spawn-unsafe')
        guarded.throwIfAborted()
        this.record('connection.online', { observation })
        this.record('camp-visit.started', { visitId: visit.id })
        return { visitId: visit.id, online: true as const, atCamp: true as const }
      } catch (error) {
        if (this.visit?.id === visit.id) this.visitEnding = true
        throw error
      } finally {
        this.connecting = false
        this.visitStart = undefined
        this.reapCampVisit()
      }
    })
    return start.promise
  }

  interruptCampVisit(): void {
    if (!this.visit && !this.visitStart) return
    this.visitEnding = true
    this.visitStart?.controller.abort()
    this.action?.controller.abort()
  }

  stopFromOwner(): Promise<unknown> {
    if (!this.visit && !this.visitStart) return this.stop()
    if (this.visitEnd) return this.visitEnd.then(() => ({ stopped: true, online: false }))
    if (this.visitStop) return this.visitStop
    this.interruptCampVisit()
    this.visitStop = this.stop().finally(() => {
      this.visitStop = undefined
      this.reapCampVisit()
    })
    return this.visitStop
  }

  private reapCampVisit(): void {
    const visit = this.visit
    const now = Date.now()
    if (!visit || this.closing || this.visitStart || this.visitEnd || this.visitStop || this.campStopping || now < this.visitRetryAt ||
      (!this.visitEnding && now < visit.expiresAt)) return
    this.visitRetryAt = now + CAMP_VISIT_RETRY_MS
    void this.endCampVisit({ id: visit.id }).catch(error => {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'minecraft-camp-visit-end-unconfirmed'
      if (this.visitLastCleanupError !== code) {
        this.visitLastCleanupError = code
        this.record('camp-visit.end-unconfirmed', { visitId: visit.id, reason: code })
      }
    })
  }

  endCampVisit(input: unknown): Promise<CampVisitEndReceipt> {
    const parsed = CampVisitEnd.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { id } = parsed.data
    if (this.visitEnded === id && this.visit?.id !== id && this.visitStart?.id !== id) return Promise.resolve({ visitId: id, online: false, confirmed: true })
    if (this.visit?.id !== id && this.visitStart?.id !== id) throw new Error('minecraft-camp-visit-not-found')
    if (this.visitEnd) return this.visitEnd
    this.interruptCampVisit()
    const starting = this.visitStart?.promise
    const stopping = this.campStopping ?? this.visitStop
    this.visitEnd = campAdmission.exit(async () => {
      await starting?.catch(() => {})
      await stopping?.catch(() => {})
      const visit = this.visit
      if (!visit || visit.id !== id) {
        if (await this.visitPresence()) throw new Error('minecraft-camp-visit-ownership-lost')
      } else {
        const state = await this.visitLogState(visit)
        const online = await this.visitPresence()
        if ((state === 'denied' || state === 'left') && online) {
          this.saveCampVisit()
          this.visitEnding = false
          throw new Error('minecraft-camp-visit-ownership-lost')
        }
        if (state === 'pending' || state === 'unknown') throw new Error('minecraft-camp-visit-end-unconfirmed')
        if (state === 'owned' && online) {
          if (await this.visitLogState(visit) === 'owned') {
            this.online = true
            await this.stop().catch(() => this.record('stop.unconfirmed', { reason: 'camp-visit' }))
            if (await this.visitLogState(visit) === 'owned') {
              const left = new RegExp(`^\\[[^\\]\\r\\n]+\\] \\[Server thread/INFO\\]: (?:${this.botName} left the game|Only fake players can be moved or killed|Can only manipulate existing players)\\r?$`, 'mu')
              await this.send(`player ${this.botName} kill`, left, 6000)
            }
          }
          if (await this.visitPresence()) throw new Error('minecraft-camp-visit-end-unconfirmed')
        }
      }
      this.markOffline()
      this.saveCampVisit(undefined, id)
      this.visitEnding = false
      this.record('camp-visit.ended', { visitId: id, online: false })
      return { visitId: id, online: false as const, confirmed: true as const }
    }).finally(() => { this.visitEnd = undefined })
    return this.visitEnd
  }

  private assertCampVisitZone(zone: z.infer<typeof MinecraftSurveyPreviewRequest>['zone']): void {
    const visit = this.visit
    if (visit && (campAdmission.getStore()?.visitId !== visit.id || visit.zone.id !== zone.id ||
      visit.zone.dimension !== zone.dimension || visit.zone.x !== zone.x || visit.zone.y !== zone.y ||
      visit.zone.z !== zone.z || visit.zone.radius !== zone.radius)) throw new Error('minecraft-camp-visit-refused')
  }

  private assertCampVisitActionUnused(action: CampVisitAction): void {
    this.assertCampAdmission()
    const visit = this.visit
    const gatherOnly = visit?.gather && !visit.projectGather
    if (visit?.patrol || gatherOnly && action !== 'gather' || visit?.surveyUsed || visit?.supplyUsed || visit?.buildUsed || visit?.revisitUsed || visit?.gatherUsed) {
      throw new Error(`minecraft-camp-visit-${action}-refused`)
    }
  }

  private claimCampVisitAction(action: CampVisitAction): void {
    this.assertCampVisitActionUnused(action)
    if (this.visit) this.saveCampVisit({ ...this.visit, [`${action}Used`]: true })
  }

  pauseCamp(): Promise<unknown> {
    if (this.campStopping) return this.campStopping
    this.campPaused = true
    this.refreshChatRelay(false)
    this.interruptCampVisit()
    this.campEpoch++
    this.reflexEnabled = false
    this.action?.controller.abort()
    this.campStopping = (async () => {
      if (!this.online) this.online = !!(await this.positionOf(this.botName))
      return this.stop()
    })().finally(() => { this.campStopping = undefined })
    return this.campStopping
  }

  resumeCamp(): { resumed: true } {
    if (this.campStopping) throw new Error('minecraft-camp-pause-busy')
    this.campPaused = false
    return { resumed: true }
  }

  async connect(atOwner = false): Promise<unknown> {
    if (this.visit || this.visitStart) throw new Error('minecraft-camp-visit-busy')
    if (this.connecting) throw new Error('connection-busy')
    this.connecting = true
    try {
      if (this.online) return await this.connectReady()
      try { return await this.connectReady() } catch (error) {
        if (!(error instanceof Error) || error.message !== 'minecraft-offline') throw error
      }
      if (atOwner && !await this.positionOf(this.owner)) throw new Error('owner-not-visible')
      const spawn = `${atOwner ? `execute at ${this.owner} run ` : ''}player ${this.botName} spawn`
      await this.send(spawn, new RegExp(`${this.botName}(?:\\[local\\])? (?:logged in with entity id|joined the game)|already (?:logged in|online)`, 'iu'), 15_000)
      return await this.connectReady()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.record('connection.failed', { message: this.lastError.slice(0, 240) })
      throw error
    } finally { this.connecting = false }
  }

  private async connectReady(): Promise<Record<string, unknown>> {
    this.assertCampAdmission()
    this.reflexEnabled = true
    this.features = undefined
    const current = await this.observe()
    if (current.gameMode !== 'survival') {
      await this.send(`gamemode survival ${this.botName}`, /game mode.*survival/iu)
      if (numeric(await this.data(this.botName, 'playerGameType')) !== 0) throw new Error('survival-mode-unconfirmed')
      this.record('player.survival')
    }
    await this.configure()
    const observation = await this.observe()
    this.assertCampAdmission()
    this.lastError = undefined
    this.record('connection.online', { observation })
    return { ...this.view(), connecting: false }
  }

  async disconnect(): Promise<unknown> {
    const visit = this.visit?.id ?? this.visitStart?.id
    if (visit) {
      await this.endCampVisit({ id: visit })
      return this.view()
    }
    if (this.online) {
      await this.stop().catch(error => { this.record('stop.unconfirmed', { reason: 'disconnect', message: error instanceof Error ? error.message : String(error) }) })
      const receipt = await this.send(`player ${this.botName} kill`, new RegExp(`${this.botName} (?:left the game|was (?:slain|killed)|died)|Killed ${this.botName}|Can only manipulate existing players`, 'iu'))
      if (/Can only manipulate existing players/iu.test(receipt) && await this.positionOf(this.botName)) throw new Error('minecraft-disconnect-unconfirmed')
      this.markOffline()
    }
    return this.view()
  }

  private async startAction(kind: string, enableReflex = true): Promise<Action> {
    this.assertCampAdmission()
    if (!this.online) throw new Error('minecraft-offline')
    if (!this.features) throw new Error('minecraft-not-ready')
    if (this.action) throw new Error('action-busy')
    const action = { kind, controller: new AbortController() }
    this.action = action
    try {
      if (enableReflex) await this.setReflex(true)
      action.controller.signal.throwIfAborted()
    } catch (error) {
      if (this.action === action) this.action = undefined
      throw error
    }
    this.record('action.started', { kind })
    return action
  }

  async stop(): Promise<unknown> {
    this.action?.controller.abort()
    const previous = this.action?.kind
    if (!this.online) return { stopped: true, online: false }
    await this.configure()
    await this.setReflex(false)
    await this.cbi('stop')
    const before = await this.observe()
    await delay(1200)
    const observation = await this.observe()
    const a = before.position as Position
    const b = observation.position as Position
    const displacement = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    if (displacement > 0.3) {
      this.lastError = 'stop-unconfirmed'
      this.record('stop.unconfirmed', { displacement })
      throw new Error('stop-unconfirmed')
    }
    this.action = undefined
    observation.action = undefined
    this.observation = observation
    this.record('action.stopped', { kind: previous, displacement })
    return { stopped: true, displacement, observation }
  }

  async chat(text: string, receiptOnly = false): Promise<unknown> {
    const message = z.string().trim().min(1).max(256).parse(text)
    if (message.startsWith('/')) throw new Error('chat-commands-forbidden')
    if (!this.online) throw new Error('minecraft-offline')
    const ownerPosition = await this.positionOf(this.owner)
    if (!ownerPosition) throw new Error('owner-not-visible')
    const label = '[CBI] 大肥鱼：'
    const feedback = new RegExp(`^\\[[^\\]]+\\] \\[Server thread/INFO\\]: CBI feedback sender=${this.botName} target=${this.owner} message="?\\[CBI\\] 大肥鱼：`, 'imu')
    const completion = new RegExp(`${feedback.source}|No player was found`, 'imu')
    // Minecraft counts UTF-16 units and limits each private message to 256.
    const limit = 256 - label.length
    const boundary = /[\uD800-\uDBFF]/u.test(message[limit - 1] ?? '') ? limit - 1 : limit
    const parts = message.length <= limit ? [message] : [message.slice(0, boundary), message.slice(boundary)]
    const receipts = []
    for (const part of parts) {
      const receipt = await this.send(`execute as ${this.botName} run tell ${this.owner} ${label}${part}`, completion)
      if (!feedback.test(receipt)) throw new Error('owner-not-visible')
      receipts.push(receipt.slice(-600))
    }
    this.record('chat.sent', { message, delivery: 'private', username: this.owner })
    return { delivery: 'private', recipient: this.owner, receipt: receipts.join('\n'),
      ...(!receiptOnly && { observation: await this.observe().catch(() => this.observation) }) }
  }

  async follow(): Promise<unknown> {
    if (!this.online) throw new Error('minecraft-offline')
    const ownerPosition = await this.positionOf(this.owner)
    if (!ownerPosition) throw new Error('owner-not-visible')
    const current = await this.positionOf(this.botName)
    if (!current) throw new Error('minecraft-offline')
    const action = await this.startAction('follow')
    try {
      const receipt = await this.cbi(`follow ${this.owner}`, this.owner)
      if (!receipt.includes(`开始持续跟随 ${this.owner}`)) throw new Error('follow-unconfirmed')
      const observation = await this.observe()
      if (action.controller.signal.aborted) throw new Error('follow-cancelled')
      this.record('follow.started', { target: this.owner })
      return { following: true, observation }
    } catch (error) {
      if (this.action === action && !action.controller.signal.aborted) {
        action.controller.abort()
        await this.cbi('stop').catch(() => {})
        if (this.action === action) this.action = undefined
      }
      throw error
    }
  }

  private async waitForArrival(target: Position, action: Action, origin: Position): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 45_000
    const notBefore = Date.now() + 1500
    while (Date.now() < deadline) {
      action.controller.signal.throwIfAborted()
      const observation = await this.observe()
      const current = observation.position as Position | undefined
      if (typeof observation.oxygen === 'number' && observation.oxygen < 280) throw new Error('move-air-falling')
      if (current && Math.hypot(current.x - origin.x, current.z - origin.z) >
        Math.hypot(target.x - origin.x, target.z - origin.z) + 8) throw new Error('move-route-diverged')
      if (current && Math.floor(current.x) === target.x && Math.floor(current.y) === target.y && Math.floor(current.z) === target.z) return observation
      const status = typeof observation.cbiStatus === 'string' ? observation.cbiStatus : ''
      if (Date.now() >= notBefore && (status.includes('没有执行中的') || /无法|失败/iu.test(status))) {
        const settled = await this.stop() as { observation?: Record<string, unknown> }
        const actual = settled.observation?.position as Position | undefined
        if (actual && Math.floor(actual.x) === target.x && Math.floor(actual.y) === target.y && Math.floor(actual.z) === target.z) return settled.observation!
        throw new Error('move-ended-without-arrival')
      }
      await delay(600)
    }
    throw new Error('move-timeout')
  }

  async move(input: Position): Promise<unknown> {
    const target = z.object({ x: z.number().int().min(-30_000_000).max(30_000_000), y: z.number().int().min(-2048).max(2032), z: z.number().int().min(-30_000_000).max(30_000_000) }).parse(input)
    if (!this.online) throw new Error('minecraft-offline')
    const current = await this.positionOf(this.botName)
    if (!current) throw new Error('minecraft-offline')
    if (Math.hypot(target.x - current.x, target.z - current.z) > 32 || Math.abs(target.y - current.y) > 8) throw new Error('move-out-of-range')
    const below = { x: target.x, y: target.y - 1, z: target.z }
    for (const hazard of HAZARDS) if (await this.block(target, hazard) || await this.block(below, hazard)) throw new Error('unsafe-target')
    const action = await this.startAction('move')
    try {
      const receipt = await this.cbi(`goto ${target.x} ${target.y} ${target.z}`)
      if (!receipt.includes('正在计算到')) throw new Error('move-unconfirmed')
      const observation = await this.waitForArrival(target, action, current)
      this.action = undefined
      this.record('action.finished', { kind: 'move', target })
      return { moved: true, target, observation }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.action = undefined
      this.record('action.failed', { kind: 'move', target, error: message })
      if (this.online) await this.cbi('stop').catch(() => {})
      if (action.controller.signal.aborted) throw new Error('move-cancelled')
      throw error
    }
  }

  async teleport(input: Position): Promise<unknown> {
    const target = z.object({ x: z.number().int().min(-30_000_000).max(30_000_000), y: z.number().int().min(-64).max(320), z: z.number().int().min(-30_000_000).max(30_000_000) }).parse(input)
    if (!this.online) throw new Error('minecraft-offline')
    const dimension = await this.data(this.botName, 'Dimension')
    if (dimension !== 'minecraft:overworld') throw new Error('teleport-dimension-refused')
    const action = await this.startAction('teleport')
    try {
      await this.writeConsole(`tp ${this.botName} ${target.x} ${target.y} ${target.z}`)
      const deadline = Date.now() + 8000
      let current: Position | undefined
      while (Date.now() < deadline) {
        current = await this.positionOf(this.botName)
        if (current && Math.abs(current.x - target.x) <= 0.5 && Math.abs(current.y - target.y) <= 0.5 && Math.abs(current.z - target.z) <= 0.5) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!current || Math.abs(current.x - target.x) > 0.5 || Math.abs(current.y - target.y) > 0.5 || Math.abs(current.z - target.z) > 0.5) throw new Error('teleport-unconfirmed')
      this.action = undefined
      this.record('action.finished', { kind: 'teleport', target })
      return { teleported: true, target, position: current }
    } catch (error) {
      this.action = undefined
      this.record('action.failed', { kind: 'teleport', target, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async setGameMode(mode: 'creative' | 'survival'): Promise<unknown> {
    if (!this.online) throw new Error('minecraft-offline')
    await this.writeConsole(`gamemode ${mode} ${this.botName}`)
    const expected = mode === 'creative' ? 1 : 0
    const deadline = Date.now() + 8000
    let actual: number | undefined
    while (Date.now() < deadline) {
      actual = numeric(await this.data(this.botName, 'playerGameType'))
      if (actual === expected) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (actual !== expected) throw new Error('gamemode-unconfirmed')
    this.creative = mode === 'creative'
    this.record('gamemode.changed', { mode })
    return { mode }
  }

  async inspectTerrain(targets: Position[], signal: AbortSignal): Promise<unknown> {
    const origin = await this.positionOf(this.botName, signal)
    if (!this.online || !origin) throw new Error('minecraft-offline')
    const dimension = await this.data(this.botName, 'Dimension', signal)
    if (typeof dimension !== 'string' || !/^[a-z0-9_:.-]{1,64}$/u.test(dimension)) throw new Error('terrain-dimension-unconfirmed')
    if (targets.some(p => Math.hypot(p.x - origin.x, p.z - origin.z) > 32 || Math.abs(p.y - origin.y) > 12)) {
      throw new Error('terrain-out-of-range')
    }
    const epoch = this.connectionEpoch
    const test = async (condition: string) => {
      signal.throwIfAborted()
      if (!this.online || this.connectionEpoch !== epoch) throw new Error('minecraft-offline')
      const output = await this.send(`execute in ${dimension} ${condition}`, CAMP_VISIT_BLOCK_CHECK, 4000, 0, signal, () => {})
      return CAMP_VISIT_BLOCK_CHECK.exec(output)?.[1] === 'passed'
    }
    const readings = []
    for (const p of targets) {
      const at = `${p.x} ${p.y} ${p.z}`
      const below = `${p.x} ${p.y - 1} ${p.z}`
      const head = `${p.x} ${p.y + 1} ${p.z}`
      if (!await test(`if loaded ${at}`)) {
        readings.push({ ...p, loaded: false })
        continue
      }
      const headClear = await test(`if block ${head} minecraft:air`)
      const air = headClear && await test(`if block ${at} minecraft:air`)
      const dryGround = await test(`if block ${below} #minecraft:dirt`) || await test(`if block ${below} minecraft:stone`)
      const water = await test(`if block ${at} minecraft:water`) || await test(`if block ${below} minecraft:water`)
      const plains = await test(`if biome ${at} minecraft:plains`)
      const shortGrass = !air && headClear && await test(`if block ${at} minecraft:short_grass`)
      readings.push({ ...p, loaded: true, clear: air, dryGround, water, plains, shortGrass })
    }
    return { origin, readings }
  }

  async surface(signal: AbortSignal): Promise<unknown> {
    this.assertCampAdmission()
    if (!this.online) throw new Error('minecraft-offline')
    const before = numeric(await this.data(this.botName, 'Air', signal))
    if (before === undefined) throw new Error('surface-air-unconfirmed')
    if (before >= 300) return { surfaced: false, reason: 'air-already-full', oxygen: before }
    const action = await this.startAction('surface', false)
    const guard = AbortSignal.any([signal, action.controller.signal])
    const epoch = this.connectionEpoch
    try {
      await this.writeConsole(`player ${this.botName} jump continuous`, () => {
        guard.throwIfAborted()
        this.assertCampAdmission()
      })
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const oxygen = numeric(await this.data(this.botName, 'Air', guard))
        if (oxygen === undefined) throw new Error('surface-air-unconfirmed')
        if (oxygen >= 280 && oxygen > before) {
          this.record('action.finished', { kind: 'surface', oxygenBefore: before, oxygen })
          return { surfaced: true, oxygenBefore: before, oxygen, position: await this.positionOf(this.botName, guard) }
        }
        await delay(200)
      }
      throw new Error('surface-timeout')
    } finally {
      if (this.online && this.connectionEpoch === epoch && this.action === action) {
        await this.writeConsole(`player ${this.botName} stop`).catch(() => {})
        this.action = undefined
      }
    }
  }

  private async cachedPositions(blocks: readonly string[]): Promise<Position[]> {
    const output = await this.cbi(`find ${blocks.join(' ')}`, this.botName, 250, /\[CBI\] (?:查找完成 \d+|.*?(?:错误|未知指令|找不到))/u)
    const results: Position[] = []
    for (const match of output.matchAll(/\[CBI\] (-?\d+) (-?\d+) (-?\d+)/gu)) results.push({ x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) })
    return results.filter((item, index) => results.findIndex(other => other.x === item.x && other.y === item.y && other.z === item.z) === index)
  }

  async findBeds(signal: AbortSignal): Promise<unknown> {
    const origin = await this.positionOf(this.botName, signal)
    if (!this.online || !origin) throw new Error('minecraft-offline')
    const beds = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
      'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(color => `${color}_bed`)
    const distance = (p: Position) => Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z)
    const dimension = await this.data(this.botName, 'Dimension', signal)
    if (dimension !== 'minecraft:overworld') throw new Error('night-bed-overworld-required')
    const nearby = (await this.cachedPositions(beds)).filter(p => distance(p) <= 32).sort((a, b) => distance(a) - distance(b))
    const found = []
    for (const p of nearby.slice(0, 12)) {
      if (await this.block(p, '#minecraft:beds[part=head]', dimension, signal)) found.push(p)
      if (found.length >= 4) break
    }
    return { origin, found }
  }

  private async nightCommand(command: string, terminal: string, signal: AbortSignal): Promise<string> {
    const prefix = `^\\[[^\\r\\n\\]]+\\] \\[Server thread/INFO\\]: CBI feedback sender=${this.botName} target=${this.botName} message="\\[CBI\\] `
    const line = new RegExp(prefix + `(${terminal}|错误: night-[a-z-]+)"\\r?$`, 'mu')
    const receipt = await this.send(`execute as ${this.botName} run tell ${this.botName} cbi ${command}`, line, 15_000, 0, signal, () => {})
    const message = line.exec(receipt)?.[1]
    if (!message) throw new Error('night-receipt-unconfirmed')
    if (message.startsWith('错误: ')) throw new Error(message.slice('错误: '.length))
    return message
  }

  async useNightBed(target: Position, place: boolean, signal: AbortSignal): Promise<unknown> {
    if (!this.features?.nightShelter) throw new Error('night-shelter-unavailable')
    const action = await this.startAction('night-bed', false)
    const abort = AbortSignal.any([signal, action.controller.signal])
    try {
      const command = `nightbed ${place ? 'place ' : ''}${target.x} ${target.y} ${target.z}`
      const result = await this.nightCommand(command, 'nightbed (?:sleeping|refused|placed -?\\d+ -?\\d+ -?\\d+)', abort)
      if (place) {
        const [, outcome, x, y, z] = result.split(' ')
        const placed = outcome === 'placed'
        const head = placed ? { x: Number(x), y: Number(y), z: Number(z) } : undefined
        this.record('night.bed-placed', { target, placed, head })
        return { placed, target, head, ...(!placed && { reason: 'bed-placement-refused' }) }
      }
      const sleeping = result === 'nightbed sleeping'
      this.record('night.bed', { target, sleeping })
      return { sleeping, target, ...(!sleeping && { reason: 'bed-use-refused' }) }
    } finally {
      if (this.action === action) this.action = undefined
    }
  }

  async nightCover(phase: 'sites' | 'status' | 'enter' | 'leave', signal: AbortSignal): Promise<unknown> {
    if (!this.features?.nightShelter) throw new Error('night-shelter-unavailable')
    const coordinates = '-?\\d+ -?\\d+ -?\\d+'
    if (phase === 'sites') {
      const result = await this.nightCommand('nightshelter sites', `nightshelter sites (?:none|${coordinates}(?:,${coordinates}){0,5})`, signal)
      const values = result.slice('nightshelter sites '.length)
      const found = values === 'none' ? [] : values.split(',').map(value => {
        const [x, y, z] = value.split(' ').map(Number)
        return { x, y, z }
      })
      return { found }
    }
    if (phase === 'status') {
      const result = await this.nightCommand('nightshelter status', `nightshelter (?:none|(?:covered|shaft) ${coordinates})`, signal)
      const [, status, x, y, z] = result.split(' ')
      return { status, ...(x !== undefined && { surface: { x: Number(x), y: Number(y), z: Number(z) } }) }
    }
    const action = await this.startAction('night-shelter', false)
    const abort = AbortSignal.any([signal, action.controller.signal])
    try {
      const verb = phase === 'enter' ? 'enter' : 'open'
      const result = await this.nightCommand(`nightshelter ${verb}`, `nightshelter (?:(?:covered|opened) ${coordinates}|failed [a-z-]+)`, abort)
      const [, status, x, y, z] = result.split(' ')
      if (status === 'failed') throw new Error(`night-shelter-${x}`)
      const surface = { x: Number(x), y: Number(y), z: Number(z) }
      this.record('night.shelter', { status, surface })
      if (phase === 'enter') return { status, surface }
      this.action = undefined
      return { status, surface, exit: await this.returnToSafety(signal) }
    } catch (error) {
      this.record('night.shelter-failed', { phase, error: error instanceof Error ? error.message : String(error) })
      if (this.online && this.action === action) await this.cbi('stop').catch(() => {})
      throw error
    } finally {
      if (this.action === action) this.action = undefined
    }
  }

  async findWood(name: string, signal: AbortSignal, maxAbove = 12): Promise<unknown> {
    if (!(LOGS as readonly string[]).includes(name)) throw new Error('unsupported-gather-target')
    const origin = await this.positionOf(this.botName, signal)
    if (!this.online || !origin) throw new Error('minecraft-offline')
    const distance = (p: Position) => Math.hypot(p.x - origin.x, p.z - origin.z)
    const reachDistance = (p: Position) => Math.hypot(distance(p), p.y - origin.y - 1.62)
    const candidates = (await this.cachedPositions([name])).filter(p => distance(p) <= 48 && p.y - origin.y <= maxAbove && origin.y - p.y <= 12)
      .sort((a, b) => reachDistance(a) - reachDistance(b)).slice(0, 12)
    const found = []
    for (const candidate of candidates) {
      signal.throwIfAborted()
      if (await this.block(candidate, `minecraft:${name}`, undefined, signal)) found.push(candidate)
    }
    return { origin, block: name, found }
  }

  async clearGrass(zone: z.infer<typeof MinecraftAuthorizedZone>, target: Position, signal: AbortSignal): Promise<unknown> {
    const current = await this.positionOf(this.botName, signal)
    if (!this.online || !current) throw new Error('minecraft-offline')
    if (target.y !== zone.y || Math.abs(target.x - zone.x) > zone.radius || Math.abs(target.z - zone.z) > zone.radius ||
        Math.hypot(current.x - target.x, current.y - target.y, current.z - target.z) > 12 ||
        await this.data(this.botName, 'Dimension', signal) !== zone.dimension) throw new Error('grass-out-of-range')
    if (!await this.block(target, 'minecraft:short_grass', zone.dimension, signal)) return { cleared: false, reason: 'not-short-grass' }
    const action = await this.startAction('clear-grass')
    const guard = AbortSignal.any([action.controller.signal, signal])
    try {
      if (!await this.block(target, 'minecraft:short_grass', zone.dimension, guard)) return { cleared: false, reason: 'not-short-grass' }
      const receipt = await this.cbi(`break ${target.x} ${target.y} ${target.z}`, this.botName, 0, /开始破坏/u, guard, () => {})
      if (!receipt.includes(`开始破坏 ${target.x} ${target.y} ${target.z}`)) throw new Error('grass-break-unconfirmed')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        guard.throwIfAborted()
        if (await this.block(target, 'minecraft:air', zone.dimension, guard)) return { cleared: true, target }
        await delay(300)
      }
      throw new Error('grass-break-unconfirmed')
    } finally {
      if (this.action === action) {
        await this.cbi('stop').catch(() => {})
        this.action = undefined
      }
    }
  }

  async dig(name = 'oak_log', selected?: Position): Promise<unknown> {
    if (!(LOGS as readonly string[]).includes(name)) throw new Error('unsupported-gather-target')
    if (!this.online) throw new Error('minecraft-offline')
    const current = await this.positionOf(this.botName)
    if (!current) throw new Error('minecraft-offline')
    const candidates = (selected ? [selected] : await this.cachedPositions([name])).filter(target => Math.hypot(target.x + 0.5 - current.x, target.z + 0.5 - current.z) <= 24 && Math.abs(target.y - current.y) <= 8 && !this.avoidTargets.has(`${target.x},${target.y},${target.z}`))
    const leafCandidates = await this.cachedPositions(LEAVES)
    candidates.sort((a, b) => {
      const vertical = Math.abs(a.y - current.y) - Math.abs(b.y - current.y)
      if (vertical !== 0) return vertical
      return Math.hypot(a.x + 0.5 - current.x, a.z + 0.5 - current.z) - Math.hypot(b.x + 0.5 - current.x, b.z + 0.5 - current.z)
    })
    let target: Position | undefined
    let evidence: Position | undefined
    const leafName = name.replace(/_log$/u, '_leaves')
    this.record('gather.candidates', { current, candidates: candidates.slice(0, 8), indexedLeaves: leafCandidates.length })
    for (const candidate of candidates.slice(0, 8)) {
      const leaves = leafCandidates.filter(leaf => Math.abs(leaf.x - candidate.x) <= 6 && Math.abs(leaf.y - candidate.y) <= 6 && Math.abs(leaf.z - candidate.z) <= 6).slice(0, 6)
      if (!leaves.length) {
        this.record('gather.rejected', { candidate, reason: 'no-indexed-leaves' })
        continue
      }
      if (!(await this.block(candidate, `minecraft:${name}`))) {
        this.record('gather.rejected', { candidate, reason: 'log-mismatch', leaves })
        continue
      }
      for (const leaf of leaves) {
        if (await this.block(leaf, `minecraft:${leafName}[persistent=false]`)) {
          target = candidate
          evidence = leaf
          break
        }
      }
      if (target) break
      this.record('gather.rejected', { candidate, reason: 'no-natural-leaf', leaves })
    }
    if (!target) {
      this.record('action.failed', { kind: 'dig', error: 'safe-natural-log-not-found', candidates: candidates.slice(0, 4) })
      throw new Error('safe-natural-log-not-found')
    }
    this.record('gather.selected', { target, naturalLeaf: evidence })
    const before = await this.observe()
    if (typeof before.health === 'number' && before.health <= 6) throw new Error('dig-health-low')
    const count = (before.inventory as { name: string; count: number }[]).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
    const action = await this.startAction('dig')
    action.digTarget = target
    try {
      const checkCondition = async () => {
        action.controller.signal.throwIfAborted()
        if (action.unreachable) throw new Error('dig-target-unreachable')
        const health = numeric(await this.data(this.botName, 'Health', action.controller.signal))
        if (health === undefined) throw new Error('minecraft-offline')
        if (health <= 6 || typeof before.health === 'number' && before.health - health >= 4) throw new Error('dig-health-falling')
        const oxygen = numeric(await this.data(this.botName, 'Air', action.controller.signal))
        if (oxygen !== undefined && oxygen < 280) throw new Error('dig-air-falling')
      }
      const receipt = await this.cbi(`break ${target.x} ${target.y} ${target.z}`)
      if (!receipt.includes(`开始破坏 ${target.x} ${target.y} ${target.z}`)) throw new Error('dig-unconfirmed')
      const deadline = Date.now() + 60_000
      let changed = false
      while (Date.now() < deadline) {
        await checkCondition()
        changed = await this.block(target, 'minecraft:air')
        if (changed) break
        const status = await this.cbi('status')
        if (/无法|失败/iu.test(status)) throw new Error('dig-failed')
        await delay(700)
      }
      if (!changed) throw new Error('dig-timeout')
      await this.cbi(`pickup ${name}`)
      const pickupDeadline = Date.now() + 12_000
      let after = count
      while (Date.now() < pickupDeadline) {
        await checkCondition()
        const state = await this.observe()
        after = (state.inventory as { name: string; count: number }[]).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
        if (after > count) break
        await delay(700)
      }
      if (after <= count) {
        this.record('action.incomplete', { kind: 'dig', changed: true, pickedUp: false, block: name, target, inventoryDelta: after - count })
        throw new Error('dig-pickup-unconfirmed')
      }
      await this.cbi('stop')
      this.action = undefined
      const observation = await this.observe()
      const result = { changed: true, pickedUp: true, block: name, target, inventoryDelta: after - count, observation }
      this.record('action.finished', { kind: 'dig', ...result })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.action = undefined
      this.record('action.failed', { kind: 'dig', target, error: message })
      if (this.online) await this.cbi('stop').catch(() => {})
      if (action.controller.signal.aborted) throw new Error('dig-cancelled')
      throw error
    }
  }

  async returnToSafety(signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (!this.online) throw new Error('minecraft-offline')
    if (!this.features?.safeReturn) throw new Error('return-unavailable')
    const action = await this.startAction('return')
    let target: Position | undefined
    try {
      signal?.throwIfAborted()
      const receipt = await this.cbi('return')
      const match = /开始安全回程，出口 (-?\d+), (-?\d+), (-?\d+)，预计放置 (\d+) 个方块/u.exec(receipt)
      if (!match) throw new Error('return-unconfirmed')
      const exit = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
      target = exit
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        action.controller.signal.throwIfAborted()
        const observation = await this.observe()
        const current = observation.position as Position | undefined
        const survival = observation.survival as Record<string, unknown> | undefined
        const phase = String(survival?.return ?? '')
        const atExit = current && Math.floor(current.x) === exit.x && Math.floor(current.y) === exit.y && Math.floor(current.z) === exit.z
        if (atExit && phase === 'SUCCEEDED') {
          const placedBlocks = Number(survival?.returnPlaced ?? 0)
          this.action = undefined
          observation.action = undefined
          this.observation = observation
          const result = { returned: true, target: exit, placedBlocks, observation }
          this.record('action.finished', { kind: 'return', ...result })
          return result
        }
        if (phase === 'FAILED') throw new Error(String(survival?.returnError ?? 'return-failed'))
        if (phase === 'CANCELLED') throw new Error('return-cancelled')
        await delay(600)
      }
      throw new Error('return-timeout')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = action.controller.signal.aborted ? 'return-cancelled' : /return-[a-z-]+/u.exec(message)?.[0] ?? message
      this.action = undefined
      this.record('action.failed', { kind: 'return', target, error: code })
      if (this.online) await this.cbi('stop').catch(() => {})
      throw new Error(code)
    }
  }

  async holdShield({ seconds }: MinecraftShieldRequest, signal: AbortSignal): Promise<MinecraftShieldReceipt> {
    signal.throwIfAborted()
    if (!this.online) throw new Error('minecraft-offline')
    if (!this.features?.shield) throw new Error('shield-unavailable')
    const action = await this.startAction('shield', false)
    const abort = AbortSignal.any([signal, action.controller.signal])
    const epoch = this.connectionEpoch
    const nonce = randomBytes(16).toString('hex')
    const prefix = `^\\[[^\\r\\n\\]]+\\] \\[Server thread/INFO\\]: CBI feedback sender=${this.botName} target=${this.botName} message="\\[CBI\\] shield ${nonce} `
    const terminalLine = new RegExp(prefix + '(?:done requested=(\\d+) blocked=(\\d+) released=(true|false)|failed reason=(shield-[a-z-]+))"\\r?$', 'mu')
    const requested = seconds * 20
    let dispatched = false
    let settled = false
    try {
      const output = await this.cbi(`shield hold ${nonce} ${requested}`, this.botName, 0, terminalLine, abort, () => { dispatched = true })
      const result = terminalLine.exec(output)
      if (!result) throw new Error('shield-unconfirmed')
      settled = true
      abort.throwIfAborted()
      if (result[4]) throw new Error(result[4])
      const receipt = MinecraftShieldReceipt.safeParse({
        raised: true, released: result[3] === 'true', requestedTicks: Number(result[1]), blockingTicks: Number(result[2]),
      })
      if (!receipt.success || receipt.data.requestedTicks !== requested) throw new Error('shield-unconfirmed')
      this.record('action.finished', { kind: 'shield', ...receipt.data })
      return receipt.data
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const reason = abort.aborted ? 'shield-cancelled' : /^shield-[a-z-]+$/u.test(message) ? message : 'shield-unconfirmed'
      this.record('action.failed', { kind: 'shield', error: reason })
      throw new Error(reason)
    } finally {
      if (dispatched && !settled && this.online && this.connectionEpoch === epoch) {
        const ack = new RegExp(prefix + 'cancel-ack"\\r?$', 'mu')
        await campAdmission.exit(() => this.cbi(`shield cancel ${nonce}`, this.botName, 0, ack)).catch(() => {})
      }
      if (this.action === action) this.action = undefined
    }
  }

  private surveyFeedback(command: SurveyCommand | 'campgather' | 'homebuild', message: string): RegExp {
    return new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: CBI feedback sender=${this.botName} target=${this.botName} message="?\[CBI\] ${command} ${message}"?\r?\n`, 'mu')
  }

  async surveyPreview(input: unknown, signal: AbortSignal): Promise<z.infer<typeof MinecraftSurveyPreview>> {
    const { zone } = MinecraftSurveyPreviewRequest.parse(input)
    this.assertCampVisitZone(zone)
    if (this.visit?.gather && !this.visit.projectGather) throw new Error('minecraft-camp-visit-survey-refused')
    signal.throwIfAborted()
    if (!this.online) throw new Error('minecraft-offline')
    if (!this.features?.campSurvey) throw new Error('survey-unavailable')
    if (this.connecting || this.action) throw new Error('action-busy')
    const extended = this.features.campSurveyRoutes
    const command = extended ? 'surveyroute' : 'survey'
    const zoneArgs = `${zone.dimension} ${zone.x} ${zone.y} ${zone.z} ${zone.radius}`
    const query = async (command: SurveyCommand, pattern: string): Promise<string[]> => {
      const completion = this.surveyFeedback(command, pattern)
      const response = await this.cbi(`${command} preview ${zoneArgs}`, this.botName, 0, completion, signal, () => {})
      signal.throwIfAborted()
      if (!this.online || this.connecting || this.action) throw new Error('survey-preconditions-changed')
      const offered = completion.exec(response)?.[1]
      if (!offered) throw new Error('survey-preview-unconfirmed')
      return offered === '-' ? [] : offered.split(',')
    }
    const entries = await query(command, extended
      ? String.raw`preview routes=(-|[a-z]+:[0-9](?:,[a-z]+:[0-9]){0,3})`
      : String.raw`preview directions=(-|[a-z]+(?:,[a-z]+){0,3})`)
    const routes = extended ? entries.map(entry => {
      const [direction, steps] = entry.split(':')
      return { direction, steps: Number(steps) }
    }) : undefined
    const straight = MinecraftSurveyPreview.safeParse(routes
      ? { directions: routes.map(route => route.direction), routes }
      : { directions: entries })
    if (!straight.success || straight.data.routes?.some(route => route.steps >= zone.radius)) throw new Error('survey-preview-unconfirmed')
    if (!this.features?.campSurveyTrails) return straight.data
    const trails = await query('surveytrail', `preview trails=(-|[a-z]+-[a-z]+(?:,[a-z]+-[a-z]+){0,${SURVEY_TRAIL_IDS.length - 1}})`)
    const result = MinecraftSurveyPreview.safeParse({ ...straight.data, trails })
    if (!result.success) throw new Error('survey-preview-unconfirmed')
    return result.data
  }

  async survey(input: unknown, signal: AbortSignal): Promise<z.infer<typeof MinecraftSurveyReceipt> | z.infer<typeof MinecraftTrailReceipt>> {
    return this.runSurvey(MinecraftSurveyRequest.parse(input), signal)
  }

  async campVisitPatrolSegment(input: unknown, signal: AbortSignal): Promise<MinecraftPatrolSegmentReceipt> {
    const parsed = MinecraftPatrolSegmentRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const request = parsed.data
    const result = await this.runSurvey(request, signal, request)
    return MinecraftPatrolSegmentReceipt.parse({ ...result, index: request.index })
  }

  private requirePatrolSegment({ zone, index, direction }: MinecraftPatrolSegmentRequest): CampVisit {
    this.assertCampVisitZone(zone)
    this.assertCampAdmission()
    const visit = this.visit
    const previous = visit?.patrolSegment
    const next = index === 1 ? !previous : previous?.index === 1 && previous.state === 'completed' && previous.direction !== direction
    if (!visit?.patrol || !next) throw new Error('minecraft-camp-visit-patrol-refused')
    return visit
  }

  private async runSurvey(plan: z.infer<typeof MinecraftSurveyRequest>, signal: AbortSignal, patrol?: MinecraftPatrolSegmentRequest):
  Promise<z.infer<typeof MinecraftSurveyReceipt> | z.infer<typeof MinecraftTrailReceipt>> {
    const { zone } = plan
    if (patrol) this.requirePatrolSegment(patrol)
    else {
      this.assertCampVisitZone(zone)
      this.assertCampVisitActionUnused('survey')
    }
    signal.throwIfAborted()
    if (this.connecting) throw new Error('connection-busy')
    if (!this.online) throw new Error('minecraft-offline')
    const trail = 'trail' in plan ? plan.trail : undefined
    const steps = 'steps' in plan ? plan.steps : undefined
    const command = trail ? 'surveytrail' : steps === undefined ? 'survey' : 'surveyroute'
    const extended = command !== 'survey'
    if (!this.features?.campSurvey || (extended && !this.features.campSurveyRoutes) || (trail && !this.features.campSurveyTrails)) {
      throw new Error('survey-unavailable')
    }
    const kind = patrol ? 'patrol' : 'survey'
    const action = await this.startAction(kind, false)
    const timeout = AbortSignal.timeout(trail ? TRAIL_TIMEOUT_MS : SURVEY_TIMEOUT_MS)
    const guarded = AbortSignal.any([signal, action.controller.signal, timeout])
    const id = randomBytes(12).toString('hex')
    const phases = extended ? 'outbound|returning|succeeded|recovered|failed|cancelled' : 'outbound|returning|succeeded|failed|cancelled'
    const progressPattern = trail ? 'trail=(?<trail>[a-z]+-[a-z]+|-) checkpoints=(?<checkpoints>[0-2])' : 'reached=(?<reached>true|false)'
    const lengthPattern = command === 'surveyroute' ? ' steps=(?<steps>[4-7])' : ''
    const completion = this.surveyFeedback(command, `id=${id} phase=(?<phase>${phases}) ${progressPattern} returned=(?<returned>true|false) reason=(?<reason>-|[a-z][a-z0-9-]{0,63})${lengthPattern}`)
    let dispatched = false
    let terminal = false
    let stopping: Promise<void> | undefined
    const query = async (operation: string, requestSignal?: AbortSignal, onDispatch?: () => void): Promise<SurveyProgress> => {
      const response = await this.cbi(`${command} ${operation}`, this.botName, 0, completion, requestSignal, onDispatch)
      const fields = completion.exec(response)?.groups
      if (!fields || (command === 'surveyroute' && Number(fields.steps) !== steps) || (trail && fields.trail !== trail)) {
        throw new Error('survey-receipt-unconfirmed')
      }
      const progress = { phase: fields.phase!, checkpoints: trail ? Number(fields.checkpoints) : Number(fields.reached === 'true'),
        returned: fields.returned === 'true', reason: fields.reason! }
      if (!validSurveyProgress(progress, command)) throw new Error('survey-receipt-unconfirmed')
      return progress
    }
    const cancelSurvey = () => {
      if (dispatched && !terminal && !stopping && this.action === action && this.online) {
        stopping = (async () => {
          if (patrol) {
            const visit = this.visit
            if (!visit || await this.visitLogState(visit) !== 'owned') return
          }
          const result = await query(`cancel ${id}`)
          if (result.phase === 'outbound' || result.phase === 'returning') throw new Error('survey-stop-unconfirmed')
        })().catch(() => { this.record('stop.unconfirmed', { reason: kind }) })
      }
    }
    guarded.addEventListener('abort', cancelSurvey, { once: true })
    try {
      if (patrol) {
        const visit = this.requirePatrolSegment(patrol)
        const observation = await this.observeInternal()
        if (this.reflexEnabled || !this.safeCampVisitPosition(observation, zone) || numeric(await this.data(this.botName, 'OnGround', guarded)) !== 1 ||
          await this.visitLogState(visit) !== 'owned') throw new Error('minecraft-camp-visit-patrol-unsafe')
      } else this.claimCampVisitAction('survey')
      guarded.throwIfAborted()
      const routeArgs = 'trail' in plan ? plan.trail : `${plan.direction}${steps !== undefined ? ` ${steps}` : ''}`
      let progress = await query(`run ${id} ${zone.dimension} ${zone.x} ${zone.y} ${zone.z} ${zone.radius} ${routeArgs}`, guarded, () => {
        if (patrol) {
          const visit = this.requirePatrolSegment(patrol)
          this.saveCampVisit({ ...visit, patrolSegment: { index: patrol.index, direction: patrol.direction, state: 'dispatched' } })
        }
        dispatched = true
      })
      if ((progress.phase !== 'outbound' && progress.phase !== 'failed' && progress.phase !== 'cancelled') || (trail && progress.checkpoints !== 0)) {
        throw new Error('survey-receipt-unconfirmed')
      }
      while (progress.phase === 'outbound' || progress.phase === 'returning') {
        await delay(500)
        guarded.throwIfAborted()
        const next = await query(`status ${id}`, guarded, () => {})
        if (next.checkpoints < progress.checkpoints ||
          (progress.phase === 'returning' && (next.phase === 'outbound' || next.checkpoints !== progress.checkpoints))) {
          throw new Error('survey-receipt-unconfirmed')
        }
        progress = next
      }
      guarded.throwIfAborted()
      terminal = true
      if (progress.phase === 'cancelled') throw new Error('survey-cancelled')
      if (progress.phase === 'failed') throw new Error(progress.reason && progress.reason !== '-' ? progress.reason : 'survey-failed')

      const current = await this.positionOf(this.botName, guarded)
      const dimension = await this.data(this.botName, 'Dimension', guarded)
      guarded.throwIfAborted()
      if (!current || dimension !== zone.dimension || Math.floor(current.x) !== zone.x || Math.floor(current.y) !== zone.y || Math.floor(current.z) !== zone.z) {
        throw new Error('survey-return-unconfirmed')
      }
      if (extended && (Math.abs(current.x - zone.x - 0.5) > 0.2 || Math.abs(current.z - zone.z - 0.5) > 0.2 || Math.abs(current.y - zone.y) > 0.02)) {
        throw new Error('survey-return-unconfirmed')
      }
      const returned = { zoneId: zone.id, returned: true }
      const recovered = progress.phase === 'recovered'
      const result = 'trail' in plan
        ? MinecraftTrailReceipt.parse({ ...returned, trail: plan.trail, checkpoints: progress.checkpoints,
          outcome: recovered ? 'recovered' : 'completed', ...(recovered && { reason: SURVEY_RETREAT_REASON }) })
        : MinecraftSurveyReceipt.parse({ ...returned, direction: plan.direction, steps: steps ?? SURVEY_DISTANCE,
          surveyed: !recovered, reached: !recovered, ...(recovered && { reason: SURVEY_RETREAT_REASON }) })
      if (patrol) {
        const visit = this.visit
        const segment = visit?.patrolSegment
        if (!visit?.patrol || segment?.index !== patrol.index || segment.direction !== patrol.direction || segment.state !== 'dispatched' ||
          numeric(await this.data(this.botName, 'OnGround', guarded)) !== 1 || await this.visitLogState(visit) !== 'owned') {
          throw new Error('survey-return-unconfirmed')
        }
        guarded.throwIfAborted()
        this.assertCampVisitZone(zone)
        this.assertCampAdmission()
        this.saveCampVisit({ ...visit, patrolSegment: { ...segment, state: recovered ? 'recovered' : 'completed' } })
      }
      this.record('action.finished', { kind, ...result, ...(patrol && { index: patrol.index }) })
      return result
    } catch (error) {
      const code = signal.aborted || action.controller.signal.aborted ? 'survey-cancelled' : timeout.aborted ? 'survey-timeout' : error instanceof Error ? error.message : 'survey-failed'
      cancelSurvey()
      await stopping
      const route = 'trail' in plan ? { trail: plan.trail } : { direction: plan.direction }
      this.record('action.failed', { kind, zoneId: zone.id, ...route, error: code, ...(patrol && { index: patrol.index }) })
      throw new Error(code)
    } finally {
      guarded.removeEventListener('abort', cancelSurvey)
      if (this.action === action) {
        this.action = undefined
        if (this.observation?.action === kind) this.observation.action = undefined
      }
    }
  }

  async supply(input: unknown, signal: AbortSignal, prepare = false): Promise<unknown> {
    const { zone, recipe } = MinecraftSupplyRequest.parse(input)
    signal.throwIfAborted()
    if (this.connecting) throw new Error('connection-busy')
    return this.craft(recipe, { zone, signal, prepare })
  }

  private async requireCampVisitSupply(zone: CampVisit['zone'], signal: AbortSignal): Promise<void> {
    this.assertCampVisitZone(zone)
    this.assertCampVisitActionUnused('supply')
    const visit = this.visit
    if (!visit?.allowSupply || visit.allowRevisit || !this.online || this.connecting || this.action || !this.features?.crafting ||
      await this.visitLogState(visit) !== 'owned') throw new Error('minecraft-camp-visit-supply-unavailable')
    signal.throwIfAborted()
    this.assertCampVisitZone(zone)
    this.assertCampVisitActionUnused('supply')
  }

  private safeCampVisitPosition(observation: Record<string, unknown>, zone: CampVisit['zone']): boolean {
    const point = observation.position as Partial<Position> | undefined
    return !!point && typeof point.x === 'number' && typeof point.y === 'number' && typeof point.z === 'number' &&
      observation.online === true && observation.gameMode === 'survival' && observation.dimension === zone.dimension &&
      Number(observation.health) >= 16 && Number(observation.food) >= 12 && Number(observation.oxygen) >= 200 &&
      (observation.survival as { threat?: unknown } | undefined)?.threat === 'NONE' &&
      Math.hypot(point.x - zone.x - 0.5, point.y - zone.y, point.z - zone.z - 0.5) <= 0.35
  }

  private requireGatherLease(zone: CampVisit['zone']): CampVisit {
    this.assertCampVisitZone(zone)
    this.assertCampVisitActionUnused('gather')
    const visit = this.visit
    if (!visit?.gather) throw new Error('minecraft-camp-visit-gather-refused')
    return visit
  }

  private async requireCampVisitGather(zone: CampVisit['zone'], signal: AbortSignal, action?: Action): Promise<void> {
    signal.throwIfAborted()
    const visit = this.requireGatherLease(zone)
    if (!this.online || this.connecting || this.reflexEnabled || this.action !== action || !this.features?.campGather ||
      await this.visitLogState(visit) !== 'owned') throw new Error('minecraft-camp-visit-gather-unavailable')
    signal.throwIfAborted()
    this.requireGatherLease(zone)
    if (this.action !== action) throw new Error('action-busy')
  }

  private async campGatherOffer(zone: CampVisit['zone'], signal: AbortSignal): Promise<MinecraftCampGatherOffer | null> {
    const completion = this.surveyFeedback('campgather', String.raw`preview routes=(-|[a-z]+:[0-9](?:,[a-z]+:[0-9]){0,3})`)
    const result = await this.cbi(`campgather preview ${zone.dimension} ${zone.x} ${zone.y} ${zone.z} ${zone.radius}`, this.botName, 0, completion, signal, () => {})
    const routes = completion.exec(result)?.[1]
    if (routes === '-') return null
    if (!routes) throw new Error('gather-preview-unconfirmed')
    const checked = routes.split(',').map(entry => {
      const [direction, steps] = entry.split(':')
      return MinecraftCampGatherRequest.safeParse({ zone, direction, steps: Number(steps) }).data
    })
    const first = checked[0]
    if (!first || checked.some(route => !route) || new Set(checked.map(route => route?.direction)).size !== checked.length) {
      throw new Error('gather-preview-unconfirmed')
    }
    return MinecraftCampGatherOffer.parse({ direction: first.direction, steps: first.steps, log: 'oak_log' })
  }

  async campVisitGatherPreview(input: unknown, signal: AbortSignal): Promise<MinecraftCampGatherOffer | null> {
    const parsed = MinecraftSurveyPreviewRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone } = parsed.data
    await this.requireCampVisitGather(zone, signal)
    const observation = await this.observeInternal()
    if (!this.safeCampVisitPosition(observation, zone) || numeric(await this.data(this.botName, 'OnGround', signal)) !== 1) return null
    if (this.requireGatherLease(zone).projectGather) {
      const { inventory } = await this.campGatherStock(signal)
      if (!minecraftProjectGatherEligible({ ...observation, inventory }, zone)) return null
    }
    const offer = await this.campGatherOffer(zone, signal)
    await this.requireCampVisitGather(zone, signal)
    return offer
  }

  private async campGatherStock(signal: AbortSignal): Promise<{ oakLogs: number; inventory: { name: string; count: number }[] }> {
    const parsed = CampGatherInventory.safeParse(await this.data(this.botName, 'Inventory', signal))
    if (!parsed.success) throw new Error('gather-inventory-unconfirmed')
    const oakLogs = parsed.data.filter(item => item.id === 'minecraft:oak_log').reduce((sum, item) => sum + item.count, 0)
    if (!Number.isSafeInteger(oakLogs)) throw new Error('gather-inventory-unconfirmed')
    return { oakLogs, inventory: parsed.data.map(({ id, count }) => ({ name: id.replace(/^minecraft:/u, ''), count })) }
  }

  async campVisitGather(input: unknown, signal: AbortSignal): Promise<MinecraftCampGatherReceipt> {
    const parsed = MinecraftCampGatherRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone, direction, steps } = parsed.data
    await this.requireCampVisitGather(zone, signal)
    const action = await this.startAction('gather', false)
    const timeout = AbortSignal.timeout(CAMP_GATHER_TIMEOUT_MS)
    const guarded = AbortSignal.any([signal, action.controller.signal, timeout])
    const id = randomBytes(12).toString('hex')
    const completion = this.surveyFeedback('campgather', `id=${id} phase=(?<phase>outbound|gathering|returning|succeeded|recovered|failed|cancelled) changed=(?<changed>true|false) picked=(?<picked>true|false) returned=(?<returned>true|false) reason=(?<reason>-|[a-z][a-z0-9-]{0,63})`)
    let dispatched = false
    let terminal = false
    let stopping: Promise<void> | undefined
    const query = async (operation: string, requestSignal?: AbortSignal, onDispatch?: () => void): Promise<CampGatherProgress> => {
      const output = await this.cbi(`campgather ${operation}`, this.botName, 0, completion, requestSignal, onDispatch)
      const fields = completion.exec(output)?.groups
      if (!fields) throw new Error('gather-receipt-unconfirmed')
      const progress = { phase: fields.phase!, changed: fields.changed === 'true', picked: fields.picked === 'true',
        returned: fields.returned === 'true', reason: fields.reason! }
      if (!validCampGatherProgress(progress)) throw new Error('gather-receipt-unconfirmed')
      return progress
    }
    const cancel = () => {
      if (dispatched && !terminal && !stopping && this.action === action && this.online) {
        stopping = (async () => {
          const visit = this.visit
          if (!visit || await this.visitLogState(visit) !== 'owned') return
          const result = await query(`cancel ${id}`)
          if (CAMP_GATHER_ACTIVE_PHASES.includes(result.phase)) throw new Error('gather-stop-unconfirmed')
        })().catch(() => { this.record('stop.unconfirmed', { reason: 'gather' }) })
      }
    }
    guarded.addEventListener('abort', cancel, { once: true })
    try {
      guarded.throwIfAborted()
      const observation = await this.observeInternal()
      if (!this.safeCampVisitPosition(observation, zone) || numeric(await this.data(this.botName, 'OnGround', guarded)) !== 1) {
        throw new Error('gather-preconditions-changed')
      }
      const offer = await this.campGatherOffer(zone, guarded)
      if (!offer || offer.direction !== direction || offer.steps !== steps) throw new Error('gather-preconditions-changed')
      const { oakLogs: inventoryBefore, inventory } = await this.campGatherStock(guarded)
      if (this.requireGatherLease(zone).projectGather && !minecraftProjectGatherEligible({ ...observation, inventory }, zone, 'gather')) {
        throw new Error('gather-preconditions-changed')
      }
      await this.requireCampVisitGather(zone, guarded, action)
      let progress = await query(`run ${id} ${zone.dimension} ${zone.x} ${zone.y} ${zone.z} ${zone.radius} ${direction} ${steps}`, guarded, () => {
        this.requireGatherLease(zone)
        this.claimCampVisitAction('gather')
        dispatched = true
      })
      if (progress.phase !== 'outbound' && progress.phase !== 'failed' && progress.phase !== 'cancelled') throw new Error('gather-receipt-unconfirmed')
      while (CAMP_GATHER_ACTIVE_PHASES.includes(progress.phase)) {
        await delay(500)
        guarded.throwIfAborted()
        const next = await query(`status ${id}`, guarded, () => {})
        if (progress.changed && !next.changed || progress.picked && !next.picked || CAMP_GATHER_ACTIVE_PHASES.includes(next.phase) &&
          CAMP_GATHER_ACTIVE_PHASES.indexOf(next.phase) < CAMP_GATHER_ACTIVE_PHASES.indexOf(progress.phase)) throw new Error('gather-receipt-unconfirmed')
        progress = next
      }
      guarded.throwIfAborted()
      terminal = true
      if (progress.phase !== 'succeeded') throw new Error(progress.phase === 'cancelled' ? 'gather-cancelled'
        : progress.phase === 'recovered' ? 'gather-recovered' : progress.reason !== '-' ? progress.reason : 'gather-failed')
      const { oakLogs: inventoryAfter } = await this.campGatherStock(guarded)
      const current = await this.positionOf(this.botName, guarded)
      const dimension = await this.data(this.botName, 'Dimension', guarded)
      const onGround = numeric(await this.data(this.botName, 'OnGround', guarded)) === 1
      const visit = this.visit
      if (!current || dimension !== zone.dimension || !onGround || Math.abs(current.x - zone.x - 0.5) > 0.2 ||
        Math.abs(current.y - zone.y) > 0.02 || Math.abs(current.z - zone.z - 0.5) > 0.2 || !visit || await this.visitLogState(visit) !== 'owned') {
        throw new Error('gather-return-unconfirmed')
      }
      guarded.throwIfAborted()
      this.assertCampVisitZone(zone)
      this.assertCampAdmission()
      const receipt = MinecraftCampGatherReceipt.safeParse({ zoneId: zone.id, direction, steps, log: 'oak_log', collected: 1, returned: true, inventoryBefore, inventoryAfter })
      if (!receipt.success) throw new Error('gather-inventory-unconfirmed')
      this.record('action.finished', { kind: 'gather', ...receipt.data })
      return receipt.data
    } catch (error) {
      const code = signal.aborted || action.controller.signal.aborted ? 'gather-cancelled' : timeout.aborted ? 'gather-timeout'
        : error instanceof Error ? error.message : 'gather-failed'
      cancel()
      await stopping
      this.record('action.failed', { kind: 'gather', zoneId: zone.id, direction, steps, error: code })
      throw new Error(code)
    } finally {
      guarded.removeEventListener('abort', cancel)
      if (this.action === action) {
        this.action = undefined
        if (this.observation?.action === 'gather') this.observation.action = undefined
      }
    }
  }

  async campVisitSupplyPreview(input: unknown, signal: AbortSignal): Promise<z.infer<typeof MinecraftVisitSupplyOffer> | null> {
    const parsed = MinecraftSurveyPreviewRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone } = parsed.data
    await this.requireCampVisitSupply(zone, signal)
    const observation = await this.observeInternal()
    const onGround = numeric(await this.data(this.botName, 'OnGround')) === 1
    await this.requireCampVisitSupply(zone, signal)
    if (!onGround || !this.safeCampVisitPosition(observation, zone)) return null
    const offer = MinecraftVisitSupplyOffer.safeParse(minecraftVisitSupplyOffer(observation, zone))
    return offer.data ?? null
  }

  async campVisitSupply(input: unknown, signal: AbortSignal): Promise<unknown> {
    const parsed = MinecraftSupplyRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone, recipe } = parsed.data
    await this.requireCampVisitSupply(zone, signal)
    return this.craft(recipe, { zone, signal, prepare: false, visit: true })
  }

  private async requireCampVisitStructure(zone: CampVisit['zone'], signal: AbortSignal, operation: 'build' | 'revisit', action?: Action): Promise<void> {
    signal.throwIfAborted()
    this.assertCampVisitZone(zone)
    this.assertCampVisitActionUnused(operation)
    const visit = this.visit
    const supported = operation === 'build' ? !visit?.allowRevisit && this.features?.campBuilding : visit?.allowRevisit
    if (!visit?.allowBuild || !supported || !this.online || this.connecting || this.action !== action || this.reflexEnabled ||
      await this.visitLogState(visit) !== 'owned') throw new Error(`minecraft-camp-visit-${operation}-unavailable`)
    signal.throwIfAborted()
    this.assertCampVisitZone(zone)
    this.assertCampVisitActionUnused(operation)
    if (this.action !== action) throw new Error('action-busy')
  }

  private campVisitBuildCenter(zone: CampVisit['zone']): Position | undefined {
    // CBI tries the four sites two blocks from the player. Only the north site
    // fits in its radius-two command box when the player stands at the grant center.
    if (zone.radius < 4 || Math.abs(zone.x) + 2 > 30_000_000 || Math.abs(zone.z - 2) + 2 > 30_000_000) return undefined
    return { x: zone.x, y: zone.y - 1, z: zone.z - 2 }
  }

  private async campVisitChunksLoaded(points: Position[], dimension: string, signal: AbortSignal): Promise<boolean> {
    const chunks = new Set<string>()
    for (const { x, y, z } of points) {
      const chunk = `${Math.floor(x / 16)},${Math.floor(z / 16)}`
      if (chunks.has(chunk)) continue
      const output = await this.send(`execute in ${dimension} if loaded ${x} ${y} ${z}`, CAMP_VISIT_BLOCK_CHECK, 4000, 0, signal, () => {})
      if (CAMP_VISIT_BLOCK_CHECK.exec(output)?.[1] !== 'passed') return false
      chunks.add(chunk)
    }
    return true
  }

  private async campVisitBuildSiteReady(center: Position, dimension: string, signal: AbortSignal): Promise<boolean> {
    const columns: Position[] = []
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      columns.push({ x: center.x + dx, y: center.y, z: center.z + dz })
    }
    if (!await this.campVisitChunksLoaded(columns, dimension, signal)) return false
    const empty = await this.send(`execute in ${dimension} unless entity @e[x=${center.x - 1},y=${center.y + 1},z=${center.z - 1},dx=2,dy=2,dz=2]`,
      /Test (?:passed|failed)/iu, 4000, 0, signal, () => {})
    if (!/Test passed/iu.test(empty)) return false
    let lastFloor: typeof CAMP_VISIT_FLOORS[number] | undefined
    for (const point of columns) {
      for (const height of [1, 2, 3]) {
        const air = { ...point, y: point.y + height }
        if (!await this.block(air, 'minecraft:air', dimension, signal) && !await this.block(air, 'minecraft:cave_air', dimension, signal)) return false
      }
      if (lastFloor && await this.block(point, `minecraft:${lastFloor}`, dimension, signal)) continue
      const priorFloor = lastFloor
      lastFloor = undefined
      for (const floor of CAMP_VISIT_FLOORS) {
        if (floor !== priorFloor && await this.block(point, `minecraft:${floor}`, dimension, signal)) {
          lastFloor = floor
          break
        }
      }
      if (!lastFloor) return false
    }
    return true
  }

  async campVisitBuildPreview(input: unknown, signal: AbortSignal): Promise<MinecraftVisitBuildOffer | null> {
    const parsed = MinecraftSurveyPreviewRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone } = parsed.data
    await this.requireCampVisitStructure(zone, signal, 'build')
    const center = this.campVisitBuildCenter(zone)
    if (!center) return null
    const observation = await this.observeInternal()
    if (!this.safeCampVisitPosition(observation, zone) || numeric(await this.data(this.botName, 'OnGround', signal)) !== 1) return null
    const offer = MinecraftVisitBuildOffer.safeParse(minecraftCampOffer(observation, zone))
    if (!offer.success || !await this.campVisitBuildSiteReady(center, zone.dimension, signal)) return null
    await this.requireCampVisitStructure(zone, signal, 'build')
    return offer.data
  }

  async campVisitBuild(input: unknown, signal: AbortSignal): Promise<unknown> {
    const parsed = MinecraftVisitBuildRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone } = parsed.data
    await this.requireCampVisitStructure(zone, signal, 'build')
    const center = this.campVisitBuildCenter(zone)
    if (!center) throw new Error('build-preconditions-changed')
    return this.buildCamp(parsed.data, signal, center)
  }

  async campVisitRevisit(input: unknown, signal: AbortSignal): Promise<MinecraftVisitRevisitReceipt> {
    const parsed = MinecraftVisitRevisitRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-camp-visit-invalid-request')
    const { zone, material } = parsed.data
    await this.requireCampVisitStructure(zone, signal, 'revisit')
    const center = this.campVisitBuildCenter(zone)
    if (!center) throw new Error('minecraft-camp-visit-revisit-unsafe')
    const action = await this.startAction('revisit', false)
    const guarded = AbortSignal.any([signal, action.controller.signal])
    try {
      const before = await this.observeInternal()
      if (!this.safeCampVisitPosition(before, zone) || numeric(await this.data(this.botName, 'OnGround', guarded)) !== 1) {
        throw new Error('minecraft-camp-visit-revisit-unsafe')
      }
      await this.requireCampVisitStructure(zone, guarded, 'revisit', action)
      this.claimCampVisitAction('revisit')

      const footprint = campBuildFootprint(center, material)
      if (!await this.campVisitChunksLoaded(footprint.map(({ target }) => target), zone.dimension, guarded)) {
        throw new Error('minecraft-camp-visit-revisit-unconfirmed')
      }
      let matchedBlocks = 0
      for (const { target, block } of footprint) {
        if (await this.block(target, block, zone.dimension, guarded)) matchedBlocks++
      }

      const after = await this.observeInternal()
      const visit = this.visit
      if (!this.safeCampVisitPosition(after, zone) || numeric(await this.data(this.botName, 'OnGround', guarded)) !== 1 ||
        !visit || await this.visitLogState(visit) !== 'owned') throw new Error('minecraft-camp-visit-revisit-unconfirmed')
      guarded.throwIfAborted()
      this.assertCampVisitZone(zone)
      this.assertCampAdmission()
      const receipt = MinecraftVisitRevisitReceipt.parse({ zoneId: zone.id, material, checkedBlocks: footprint.length, matchedBlocks })
      this.record('action.finished', { kind: 'revisit', ...receipt })
      return receipt
    } catch (error) {
      const code = guarded.aborted ? 'minecraft-camp-visit-revisit-cancelled'
        : error instanceof Error && error.message.startsWith('minecraft-camp-') ? error.message : 'minecraft-camp-visit-revisit-unconfirmed'
      this.record('action.failed', { kind: 'revisit', zoneId: zone.id, error: code })
      throw new Error(code)
    } finally {
      if (this.action === action) {
        this.action = undefined
        if (this.observation?.action === 'revisit') this.observation.action = undefined
      }
    }
  }

  async craft(name: string, supply?: { zone: ReturnType<typeof MinecraftSupplyRequest.parse>['zone']; signal: AbortSignal; prepare: boolean; visit?: true }): Promise<unknown> {
    const allowed = [...LOGS.map(log => log.replace(/_log$/u, '_planks')), 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'shield', 'white_bed']
    if (!allowed.includes(name)) throw new Error('craft-unsupported')
    if (!this.online) throw new Error('minecraft-offline')
    if (!this.features?.crafting) throw new Error('craft-unavailable')
    const action = await this.startAction(supply ? 'supply' : 'craft', !supply)
    const guarded = supply && AbortSignal.any([supply.signal, action.controller.signal])
    let restoreAutoCraft = false
    try {
      guarded?.throwIfAborted()
      if (!supply || this.reflexEnabled) {
        restoreAutoCraft = true
        await this.setActionAutoCraft(false)
      }
      const before = supply ? await this.observeInternal() : await this.observe()
      const prepareWood = supply?.prepare && CAMP_WOODS.find(wood => wood.planks === name)
      const visitWood = supply?.visit && CAMP_WOODS.find(wood => wood.planks === name)
      if (supply?.prepare) {
        const offer = minecraftPrepareOffer(before, supply.zone, name, 'supply')
        if (!prepareWood || !offer?.batches) throw new Error('supply-preconditions-changed')
      } else if (supply && (supply.visit ? minecraftVisitSupplyOffer : minecraftSupplyOffer)(before, supply.zone, 'supply')?.recipe !== name) {
        throw new Error('supply-preconditions-changed')
      }
      if (supply?.visit) {
        const visit = this.visit
        if (!visitWood || !this.safeCampVisitPosition(before, supply.zone) || !visit?.allowSupply ||
          numeric(await this.data(this.botName, 'OnGround')) !== 1 ||
          await this.visitLogState(visit) !== 'owned') throw new Error('supply-preconditions-changed')
        guarded?.throwIfAborted()
        this.assertCampVisitZone(supply.zone)
        this.claimCampVisitAction('supply')
      }
      const countStock = (state: Record<string, unknown>, itemName: string) => (state.inventory as { name: string; count: number }[])
        .filter(item => item.name === itemName).reduce((sum, item) => sum + item.count, 0)
      const countBefore = countStock(before, name)
      const { count, recipe, consumed } = await this.craftOnce(name, guarded, visitWood || undefined)
      if (!supply) action.controller.signal.throwIfAborted()
      if (supply && count !== 4) throw new Error('supply-receipt-unconfirmed')
      const observation = supply ? await this.observeInternal() : await this.observe()
      const countAfter = countStock(observation, name)
      if (countAfter - countBefore !== count) throw new Error('craft-inventory-unconfirmed')
      if (prepareWood && countStock(before, prepareWood.log) - countStock(observation, prepareWood.log) !== 1) {
        throw new Error('craft-log-inventory-unconfirmed')
      }
      if (supply?.visit && visitWood) {
        const visit = this.visit
        if (!this.safeCampVisitPosition(observation, supply.zone) || !visit || await this.visitLogState(visit) !== 'owned') {
          throw new Error('minecraft-camp-visit-supply-unconfirmed')
        }
        guarded?.throwIfAborted()
        this.assertCampVisitZone(supply.zone)
        this.assertCampAdmission()
        const verified = MinecraftVisitSupplyReceipt.safeParse({ crafted: true, name, count, consumedLogs: 1,
          inventory: { logsBefore: countStock(before, visitWood.log), logsAfter: countStock(observation, visitWood.log),
            planksBefore: countBefore, planksAfter: countAfter } })
        if (!verified.success) throw new Error('minecraft-camp-visit-supply-unconfirmed')
        this.observation = observation
        this.record('action.finished', { kind: 'craft', ...verified.data })
        return verified.data
      }
      if (!supply) {
        this.action = undefined
        observation.action = undefined
      }
      this.observation = observation
      const result = { crafted: true, name, count, recipe, consumed, observation,
        ...(prepareWood && { consumedLogs: 1 }),
      }
      this.record('action.finished', { kind: 'craft', ...result })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = guarded?.aborted ? 'supply-cancelled-or-unconfirmed' : action.controller.signal.aborted ? 'craft-cancelled' : /craft-[a-z-]+/u.exec(message)?.[0] ?? message
      if (!supply) this.action = undefined
      this.record('action.failed', { kind: 'craft', error: code, item: name })
      if (!supply && this.online) await this.cbi('stop').catch(() => {})
      throw new Error(code)
    } finally {
      if (restoreAutoCraft && (!supply || this.action === action && !action.controller.signal.aborted)) {
        await this.restoreActionAutoCraft()
      }
      if (supply && this.action === action) {
        this.action = undefined
        if (this.observation?.action === 'supply') this.observation.action = undefined
      }
    }
  }

  private async craftOnce(name: string, signal?: AbortSignal, exact?: { log: string },
    guard?: () => void, anchor?: CampVisit['zone']) {
    const completed = String.raw`合成完成 ([a-z_]+)×(\d+)，配方 (minecraft:[a-z_]+)，材料 `
    const completion = exact
      ? new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: CBI feedback sender=${this.botName} target=${this.botName} message="?\[CBI\] (?:${completed}([^"\r\n]+)|(?:错误: )?craft-[a-z-]+)"?\r?\n`, 'mu')
      : new RegExp(`(?:${completed}|craft-[a-z-]+)`, 'u')
    const receipt = await this.cbi(`craft ${name}`, this.botName, 0, completion, signal, guard ?? (exact && (() => {})), anchor)
    const match = exact ? completion.exec(receipt) : new RegExp(`${completed}(.+)`, 'u').exec(receipt)
    if (!match || match[1] !== name || (exact &&
      (match[3] !== `minecraft:${name}` || match[4]?.replace(/^minecraft:/u, '') !== `${exact.log}×1`))) {
      throw new Error('craft-unconfirmed')
    }
    return { count: Number(match[2]), recipe: match[3], consumed: match[4] }
  }

  private assertHouseReady(epoch: number, action?: Action, recovery = false): void {
    this.assertCampAdmission()
    if (this.visit || this.visitStart || campAdmission.getStore()?.visitId) throw new Error('minecraft-camp-visit-busy')
    if (!this.online || this.connecting || !this.features?.houseBuilding || this.connectionEpoch !== epoch) {
      throw new Error('house-unavailable')
    }
    if (recovery && !this.features.houseRecovery) throw new Error('house-recovery-unavailable')
    if (this.action !== action) throw new Error('action-busy')
  }

  private async captureHouseSession(): Promise<HouseSession> {
    const epoch = this.connectionEpoch
    const { dev, ino, size } = await stat(this.logPath)
    return { epoch, dev, ino, offset: size }
  }

  private async verifyHouseSession(session: HouseSession): Promise<void> {
    const same = (info: Stats) => this.online && session.epoch === this.connectionEpoch &&
      info.dev === session.dev && info.ino === session.ino && info.size >= session.offset && info.size - session.offset <= CAMP_VISIT_LOG_LIMIT
    if (!same(await stat(this.logPath))) throw new Error('house-ownership-unconfirmed')
    const { text } = await this.readLog(session.offset, CAMP_VISIT_LOG_LIMIT)
    const changed = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: (?:${this.botName}(?:\[[^\]\r\n]+\])? logged in with entity id |${this.botName} (?:joined|left) the game|Starting minecraft server version |Stopping server)`, 'mu')
    if (!same(await stat(this.logPath)) || changed.test(text)) throw new Error('house-ownership-unconfirmed')
  }

  private houseCommand(phase: 'preview' | 'run' | 'runone' | 'recover-preview' | 'recover', id: string, { zone, layout }: MinecraftHouseRequest): string {
    return `${phase} ${id} ${zone.id} ${zone.dimension} ${zone.x} ${zone.y} ${zone.z} ${zone.radius} ${layout.width} ${layout.height} ${layout.depth} ${layout.blocks}`
  }

  private async queryHouse(id: string, operation: string, signal?: AbortSignal, guard?: () => void): Promise<HouseProgress> {
    const completion = this.surveyFeedback('homebuild', `id=${id} phase=(?<phase>ready|building|succeeded|failed|cancelled) checked=(?<checked>0|[1-9][0-9]{0,2}) placed=(?<placed>0|[1-9][0-9]{0,2}) reason=(?<reason>-|[a-z][a-z0-9-]{0,63})`)
    const output = await this.cbi(`homebuild ${operation}`, this.botName, 0, completion, signal, guard)
    const fields = completion.exec(output)?.groups
    if (!fields) throw new Error('house-receipt-unconfirmed')
    const { phase, checked, placed, reason } = fields as Record<keyof HouseProgress, string>
    const progress = { phase, checked: Number(checked), placed: Number(placed), reason }
    const successfulPhase = ['ready', 'building', 'succeeded'].includes(phase)
    if (progress.checked > 125 || progress.placed > 100 || progress.placed > progress.checked ||
      (successfulPhase ? reason !== '-' : reason === '-')) throw new Error('house-receipt-unconfirmed')
    return progress
  }

  private validateHousePreview(progress: HouseProgress, volume: number): MinecraftHousePreview {
    if (progress.placed !== 0 || progress.checked > volume ||
      (progress.phase !== 'failed' && (progress.phase !== 'ready' || progress.checked !== volume))) {
      throw new Error('house-preview-unconfirmed')
    }
    return MinecraftHousePreview.parse(progress.phase === 'ready' ? { ready: true, checked: progress.checked }
      : { ready: false, checked: progress.checked, reason: progress.reason })
  }

  async previewHouse(input: unknown, signal: AbortSignal, recovery = false): Promise<MinecraftHousePreview> {
    const request = MinecraftHouseRequest.safeParse(input)
    if (!request.success) throw new Error('minecraft-house-invalid-request')
    signal.throwIfAborted()
    this.assertHouseReady(this.connectionEpoch, undefined, recovery)
    const session = await this.captureHouseSession()
    const guard = () => this.assertHouseReady(session.epoch, undefined, recovery)
    return this.readHousePreview(request.data, signal, recovery, session, guard)
  }

  private async readHousePreview(request: MinecraftHouseRequest, signal: AbortSignal, recovery: boolean, session: HouseSession,
    guard: () => void): Promise<MinecraftHousePreview> {
    guard()
    const id = randomBytes(12).toString('hex')
    const progress = await this.queryHouse(id, this.houseCommand(recovery ? 'recover-preview' : 'preview', id, request), signal, guard)
    await this.verifyHouseSession(session)
    signal.throwIfAborted()
    guard()
    const volume = request.layout.blocks.length
    const preview = this.validateHousePreview(progress, volume)
    if (preview.reason !== 'homebuild-materials' || preview.checked !== volume) return preview

    const missing = await this.readHouseLayout(request, true, signal, guard).catch(() => undefined)
    signal.throwIfAborted()
    guard()
    const inventory = missing && await this.readHouseInventory(signal, guard).catch(() => undefined)
    await this.verifyHouseSession(session)
    signal.throwIfAborted()
    guard()
    if (!missing || !inventory) return preview

    const materials = HOUSE_MATERIALS.flatMap(material => {
      const needed = missing[material] ?? 0
      if (!needed) return []
      const carried = Math.min(needed, inventory[material] ?? 0)
      return [{ material, needed, carried, missing: needed - carried }]
    })
    return materials.some(row => row.missing > 0) ? MinecraftHousePreview.parse({ ...preview, materials }) : preview
  }

  private assertHouseSupplyReady(epoch: number, recovery: boolean, action?: Action) {
    if (this.campPaused) throw new Error('minecraft-camp-paused')
    this.assertHouseReady(epoch, action, recovery)
    if (!this.features?.crafting) throw new Error('house-supply-unavailable')
  }

  private async houseSupplyStock({ zone, recipe }: MinecraftHouseSupplyRequest, signal: AbortSignal, guard: () => void,
    active?: 'house-supply') {
    const observation = await this.observeInternal()
    signal.throwIfAborted()
    guard()
    const inventory = authorizedInventory(observation, zone, active)
    if (!inventory || !(Number(observation.oxygen) >= 200)) return
    const log = recipe.replace(/_planks$/u, '_log')
    const bark = log.replace(/_log$/u, '_wood')
    // All these variants share the plank recipe; CBI can pick any matching slot.
    if (inventory.some(({ name }) => name === bark || name === `stripped_${log}` || name === `stripped_${bark}`)) return
    if (numeric(await this.data(this.botName, 'OnGround', signal)) !== 1) return
    const rawMotion = await this.data(this.botName, 'Motion', signal)
    const motion = position(typeof rawMotion === 'string' ? parseSnbt(rawMotion) : rawMotion)
    if (!motion || Math.hypot(motion.x, motion.z) > 0.02) return
    const stance = await this.readHouseStance(zone.dimension, signal, guard)
    const x = Math.floor(stance.x), y = Math.floor(stance.y), z = Math.floor(stance.z)
    if (Math.abs(stance.x - x - 0.5) > 0.22 || Math.abs(stance.z - z - 0.5) > 0.22 || Math.abs(stance.y - y) > 0.025 ||
      Math.abs(x - zone.x) > zone.radius || Math.abs(y - zone.y) > zone.radius || Math.abs(z - zone.z) > zone.radius) return
    const count = (item: string) => inventory.reduce((total, { name, count }) => total + (name === item ? count : 0), 0)
    return { log, logs: count(log), planks: count(recipe), stance }
  }

  private async houseSupplyOffer(request: MinecraftHouseSupplyRequest, signal: AbortSignal, session: HouseSession, guard: () => void,
    active?: 'house-supply') {
    const preview = await this.readHousePreview(request, signal, request.recovery === true, session, guard)
    const material = preview.materials?.find(row => row.material === request.recipe)
    if (preview.reason !== 'homebuild-materials' || material?.missing !== request.missing) return
    const stock = await this.houseSupplyStock(request, signal, guard, active)
    if (stock && stock.logs >= 3 && stock.planks === material.carried) return stock
  }

  async houseSupplyPreview(input: unknown, signal: AbortSignal): Promise<MinecraftHouseSupplyPreview> {
    const parsed = MinecraftHouseSupplyRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-house-invalid-request')
    const request = parsed.data
    signal.throwIfAborted()
    this.assertHouseSupplyReady(this.connectionEpoch, request.recovery === true)
    const session = await this.captureHouseSession()
    const guard = () => this.assertHouseSupplyReady(session.epoch, request.recovery === true)
    const offer = await this.houseSupplyOffer(request, signal, session, guard)
    await this.verifyHouseSession(session)
    signal.throwIfAborted()
    guard()
    return { ready: !!offer }
  }

  async houseSupply(input: unknown, signal: AbortSignal): Promise<MinecraftHouseSupplyReceipt> {
    const parsed = MinecraftHouseSupplyRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-house-invalid-request')
    const request = parsed.data
    const { recipe, zone } = request
    const recovery = request.recovery === true
    signal.throwIfAborted()
    this.assertHouseSupplyReady(this.connectionEpoch, recovery)
    const session = await this.captureHouseSession()
    this.assertHouseSupplyReady(session.epoch, recovery)
    const action = await this.startAction('house-supply', false)
    const guarded = AbortSignal.any([signal, action.controller.signal, AbortSignal.timeout(HOUSE_VERIFICATION_TIMEOUT_MS)])
    const guard = () => this.assertHouseSupplyReady(session.epoch, recovery, action)
    const restoreAutoCraft = this.reflexEnabled
    try {
      if (restoreAutoCraft) await this.setActionAutoCraft(false, guarded, guard)
      const before = await this.houseSupplyOffer(request, guarded, session, guard, 'house-supply')
      if (!before) throw new Error('house-supply-preconditions-changed')
      await this.verifyHouseSession(session)
      guarded.throwIfAborted()
      const anchor = { ...zone, x: Math.floor(before.stance.x), y: Math.floor(before.stance.y), z: Math.floor(before.stance.z) }
      const { count } = await this.craftOnce(recipe, guarded, before, guard, anchor)
      const after = await this.houseSupplyStock(request, guarded, guard, 'house-supply')
      await this.verifyHouseSession(session)
      guarded.throwIfAborted()
      guard()
      const receipt = after && MinecraftHouseSupplyReceipt.safeParse({ crafted: true, name: recipe, count, consumedLogs: 1,
        inventory: { logsBefore: before.logs, logsAfter: after.logs, planksBefore: before.planks, planksAfter: after.planks } }).data
      if (!receipt) throw new Error('house-supply-receipt-unconfirmed')
      await this.verifyHouseReturn(zone.dimension, before.stance, guarded, guard)
      await this.verifyHouseSession(session)
      guarded.throwIfAborted()
      guard()
      this.record('action.finished', { kind: action.kind, name: recipe, count })
      return receipt
    } catch (error) {
      const code = guarded.aborted ? 'house-supply-cancelled' : error instanceof Error && error.message === 'house-unavailable' && session.epoch !== this.connectionEpoch
        ? 'house-ownership-unconfirmed' : error instanceof Error && error.message.startsWith('house-')
        ? error.message : 'house-supply-receipt-unconfirmed'
      this.record('action.failed', { kind: action.kind, error: code })
      throw new Error(code)
    } finally {
      if (restoreAutoCraft && this.action === action && session.epoch === this.connectionEpoch && !this.campPaused && !action.controller.signal.aborted) {
        await this.setActionAutoCraft(this.reflexEnabled, action.controller.signal, guard).catch(() => {
          this.record('safety.restore-failed', { setting: 'survivalAutoCraft', reason: action.kind })
        })
      }
      if (this.action === action) {
        this.action = undefined
        if (this.observation?.action === action.kind) this.observation.action = undefined
      }
    }
  }

  async houseCandidates(input: unknown, signal: AbortSignal): Promise<MinecraftHouseCellCandidates> {
    const parsed = MinecraftHouseRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-house-invalid-request')
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(HOUSE_CANDIDATES_TIMEOUT_MS)])
    readSignal.throwIfAborted()
    this.assertHouseCellReady(this.connectionEpoch)
    const session = await this.captureHouseSession()
    const guard = () => this.assertHouseCellReady(session.epoch)
    const request = parsed.data
    const candidates: MinecraftHouseCellCandidates['candidates'] = []
    let checked = 0
    let blocked = 0
    for (const [index, { x, y, z, block }] of minecraftHouseCells(request.layout).entries()) {
      if (block === 'air') continue
      readSignal.throwIfAborted()
      guard()
      const cell = { index, x, y, z, material: block }
      const state = await this.readHouseCell(request, cell, readSignal, guard)
      checked++
      if (state === 'blocked') blocked++
      if (state === 'empty' && candidates.length < MINECRAFT_HOUSE_CANDIDATE_LIMIT) candidates.push(cell)
    }
    const inventory = candidates.length ? await this.readHouseInventory(readSignal, guard).catch(() => undefined) : undefined
    await this.verifyHouseSession(session)
    readSignal.throwIfAborted()
    guard()
    const stock = inventory && Object.fromEntries([...new Set(candidates.map(cell => cell.material))]
      .map(material => [material, inventory[material] ?? 0]))
    return MinecraftHouseCellCandidates.parse({ checked, blocked, candidates, ...(stock && { stock }) })
  }

  async verifyHouse(input: unknown, signal: AbortSignal): Promise<MinecraftHouseVerification> {
    const parsed = MinecraftHouseRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-house-invalid-request')
    const timeout = AbortSignal.timeout(HOUSE_VERIFICATION_TIMEOUT_MS)
    const readSignal = AbortSignal.any([signal, timeout])
    readSignal.throwIfAborted()
    this.assertHouseReady(this.connectionEpoch)
    const session = await this.captureHouseSession()
    const guard = () => this.assertHouseReady(session.epoch)
    const { zone, layout } = parsed.data
    const checked = layout.blocks.length
    const origin = { x: zone.x - Math.floor(layout.width / 2), y: zone.y, z: zone.z - Math.floor(layout.depth / 2) }
    const preview = async () => {
      guard()
      const id = randomBytes(12).toString('hex')
      const progress = await this.queryHouse(id, this.houseCommand('preview', id, parsed.data), readSignal, guard)
      await this.verifyHouseSession(session)
      readSignal.throwIfAborted()
      guard()
      return this.validateHousePreview(progress, checked)
    }
    try {
      const initial = await preview()
      const mismatchAllowed = initial.reason === 'homebuild-obstructed' && initial.checked > 0 ||
        ['homebuild-materials', 'homebuild-unsupported'].includes(initial.reason ?? '') && initial.checked === checked
      if (!initial.ready && !mismatchAllowed) {
        throw new Error(initial.reason ?? 'house-verification-unconfirmed')
      }
      const issues: MinecraftHouseVerification['issues'] = []
      const matchingCells: { x: number; y: number; z: number; block: string }[] = []
      let missing = 0
      let blocked = 0
      for (const [index, { x, y, z, block }] of minecraftHouseCells(layout).entries()) {
        readSignal.throwIfAborted()
        guard()
        const target = { x: origin.x + x, y: origin.y + y, z: origin.z + z }
        if (await this.block(target, `minecraft:${block}`, zone.dimension, readSignal, guard)) {
          matchingCells.push({ x, y, z, block })
          continue
        }
        const empty = (block !== 'air' && await this.block(target, 'minecraft:air', zone.dimension, readSignal, guard)) ||
          await this.block(target, 'minecraft:cave_air', zone.dimension, readSignal, guard)
        if (empty && block === 'air') {
          matchingCells.push({ x, y, z, block: 'cave_air' })
          continue
        }
        const reason = empty ? 'missing' : 'blocked'
        if (reason === 'missing') missing++
        else blocked++
        if (issues.length < HOUSE_VERIFICATION_ISSUE_LIMIT) issues.push({ index, reason })
      }
      const matched = checked - missing - blocked
      if (matched === checked) {
        if (!initial.ready || !(await preview()).ready) throw new Error('house-verification-unconfirmed')
        const offset = (value: number) => value ? `~${value}` : '~'
        const matches = matchingCells.map(({ x, y, z, block }) => `if block ${offset(x)} ${offset(y)} ${offset(z)} ${block}`).join(' ')
        const command = `execute in ${zone.dimension} positioned ${origin.x} ${origin.y} ${origin.z} ${matches} run data get entity ${this.botName} UUID`
        const receipt = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: ${this.botName} has the following entity data: \[I;\s*-?\d+(?:,\s*-?\d+){3}\]\r?\n`, 'mu')
        // A ready preview also permits repairable gaps. Confirm all surveyed blocks in one server command.
        const output = await this.send(command, receipt, 6000, 0, readSignal, guard, true).catch(error => {
          readSignal.throwIfAborted()
          guard()
          if (error instanceof Error && error.message === 'console-receipt-timeout:execute') throw new Error('house-verification-unconfirmed')
          throw error
        })
        if (!receipt.test(output)) throw new Error('house-verification-unconfirmed')
      }
      await this.verifyHouseSession(session)
      readSignal.throwIfAborted()
      guard()
      return MinecraftHouseVerification.parse({ checked, matched, missing, blocked, issues })
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new Error('house-timeout')
      throw error
    }
  }

  async verifyHouseProject(input: unknown, signal: AbortSignal): Promise<MinecraftHouseProjectVerification> {
    const parsed = MinecraftHouseProjectVerifyRequest.safeParse(input)
    if (!parsed.success) throw new Error('minecraft-house-invalid-request')
    const timeout = AbortSignal.timeout(HOUSE_VERIFICATION_TIMEOUT_MS)
    const readSignal = AbortSignal.any([signal, timeout])
    readSignal.throwIfAborted()
    this.assertHouseReady(this.connectionEpoch)
    const session = await this.captureHouseSession()
    const guard = () => this.assertHouseReady(session.epoch)
    const { sections } = parsed.data
    const { x, y, z, dimension } = sections[0]!.zone
    const command = `execute as ${this.botName} at @s if dimension ${dimension} positioned ${x} ${y} ${z}`
    const offset = (value: number) => value ? `~${value}` : '~'
    const chunks = new Map<string, string>()
    const conditions = sections.map(({ zone, layout }) => minecraftHouseCells(layout).map(cell => {
      const atX = zone.x - Math.floor(layout.width / 2) + cell.x
      const atY = zone.y + cell.y
      const atZ = zone.z - Math.floor(layout.depth / 2) + cell.z
      const position = `${offset(atX - x)} ${offset(atY - y)} ${offset(atZ - z)}`
      chunks.set(`${Math.floor(atX / 16)},${Math.floor(atZ / 16)}`, `if loaded ${position}`)
      const block = cell.block === 'air' ? '#minecraft:air' : `minecraft:${cell.block}`
      return `if block ${position} ${block}`
    }))
    const loaded = [...chunks.values()].join(' ')
    const checked = conditions.reduce((total, section) => total + section.length, 0)
    const identity = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: ${this.botName} has the following entity data: \[I;\s*(-?\d{1,10}),\s*(-?\d{1,10}),\s*(-?\d{1,10}),\s*(-?\d{1,10})\]\r?\n`, 'mu')

    try {
      guard()
      const idLine = await this.send(`${command} ${loaded} run data get entity @s UUID`, identity, 4000, 0, readSignal, guard)
      const id = identity.exec(idLine)?.slice(1).map(Number)
      if (!id || id.some(value => value < -0x80000000 || value > 0x7fffffff)) throw new Error('house-project-verification-unconfirmed')
      const index = id.reduce((best, value, i) => Math.abs(value) > Math.abs(id[best]!) ? i : best, 0)
      if (!id[index]) throw new Error('house-project-verification-unconfirmed')

      const snapshot = async (blocks: string[]): Promise<boolean> => {
        const nonce = randomInt(1, 1_000_000_000)
        // The scaled UUID read yields a unique positive receipt without writing to the world.
        const scale = ((nonce + 0.5) / id[index]!).toFixed(12)
        const proof = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: UUID\[${index}\] on ${this.botName} after scale factor of -?\d+\.\d{2} is ${nonce}\r?\n`, 'mu')
        try {
          const query = [command, loaded, ...blocks, `run data get entity @s UUID[${index}] ${scale}`].join(' ')
          const output = await this.send(query, proof, 4000, 0, readSignal, guard, true)
          if (!proof.test(output)) throw new Error('house-project-verification-unconfirmed')
          return true
        } catch (error) {
          // Vanilla emits no output when a chained block condition fails.
          if (error instanceof Error && error.message === 'console-receipt-timeout:execute') return false
          throw error
        }
      }
      const matched = await snapshot(conditions.flat())
      const unmatchedSections: number[] = []
      if (!matched) {
        for (const [index, section] of conditions.entries()) {
          if (!await snapshot(section)) unmatchedSections.push(index)
        }
        // Separate successful reads do not prove that the entire structure matched at once.
        if (!unmatchedSections.length || !await snapshot([])) throw new Error('house-project-verification-unconfirmed')
      }
      await this.verifyHouseSession(session)
      readSignal.throwIfAborted()
      guard()
      return MinecraftHouseProjectVerification.parse({ matched, checked, unmatchedSections })
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new Error('house-timeout')
      if (error instanceof Error && ['console-receipt-timeout:execute', 'console-command-rejected'].includes(error.message)) {
        throw new Error('house-project-verification-unconfirmed')
      }
      throw error
    }
  }

  private assertHouseCellReady(epoch: number, action?: Action): void {
    this.assertHouseReady(epoch, action)
    if (!this.features?.houseCellPlacement) throw new Error('house-cell-unavailable')
  }

  private async readHouseCell({ zone, layout }: MinecraftHouseRequest, cell: Position & { material: MinecraftHouseMaterial }, signal: AbortSignal, guard: () => void) {
    const target = { x: zone.x - Math.floor(layout.width / 2) + cell.x, y: zone.y + cell.y, z: zone.z - Math.floor(layout.depth / 2) + cell.z }
    if (await this.block(target, `minecraft:${cell.material}`, zone.dimension, signal, guard)) return 'matching'
    if (await this.block(target, 'minecraft:air', zone.dimension, signal, guard) ||
      await this.block(target, 'minecraft:cave_air', zone.dimension, signal, guard)) return 'empty'
    return 'blocked'
  }

  private async readHouseStance(dimension: string, signal: AbortSignal, guard: () => void): Promise<Position> {
    const coordinate = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?d`
    const completion = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: ${this.botName} has the following entity data: (\[${coordinate},\s*${coordinate},\s*${coordinate}\])\r?\n`, 'mu')
    const output = await this.send(`execute as ${this.botName} at @s if dimension ${dimension} run data get entity @s Pos`, completion, 6000, 0, signal, guard).catch(error => {
      signal.throwIfAborted()
      if (error instanceof Error && error.message === 'console-receipt-timeout:execute') throw new Error('house-stance-unconfirmed')
      throw error
    })
    const raw = completion.exec(output)?.[1]
    const stance = raw && position(parseSnbt(raw))
    if (!stance) throw new Error('house-stance-unconfirmed')
    return stance
  }

  private async readHouseLayout({ zone, layout }: MinecraftHouseRequest, allowMissing: boolean, signal: AbortSignal, guard?: () => void): Promise<HouseMaterials> {
    const origin = { x: zone.x - Math.floor(layout.width / 2), y: zone.y, z: zone.z - Math.floor(layout.depth / 2) }
    const missing: HouseMaterials = {}
    for (const cell of minecraftHouseCells(layout)) {
      signal.throwIfAborted()
      const target = { x: origin.x + cell.x, y: origin.y + cell.y, z: origin.z + cell.z }
      if (await this.block(target, `minecraft:${cell.block}`, zone.dimension, signal, guard)) continue
      if (cell.block === 'air' || allowMissing) {
        const air = cell.block !== 'air' && await this.block(target, 'minecraft:air', zone.dimension, signal, guard) ||
          await this.block(target, 'minecraft:cave_air', zone.dimension, signal, guard)
        if (air) {
          if (cell.block !== 'air') missing[cell.block] = (missing[cell.block] ?? 0) + 1
          continue
        }
      }
      throw new Error(allowMissing ? 'house-preconditions-changed' : 'house-world-unconfirmed')
    }
    return missing
  }

  private async readHouseInventory(signal: AbortSignal, guard?: () => void): Promise<HouseMaterials> {
    const completion = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: ${this.botName} has the following entity data: (\[(?:\s*\{[^\r\n]*\})?\s*\])\r?\n`, 'mu')
    const output = await this.send(`data get entity ${this.botName} Inventory`, completion, 6000, 0, signal, guard ?? (() => {}))
    const raw = completion.exec(output)?.[1]
    if (!raw) throw new Error('house-inventory-unconfirmed')
    const parsed = CampGatherInventory.safeParse(parseSnbt(raw))
    if (!parsed.success) throw new Error('house-inventory-unconfirmed')
    const stock: HouseMaterials = {}
    for (const material of HOUSE_MATERIALS) {
      const count = parsed.data.filter(item => item.id === `minecraft:${material}`).reduce((sum, item) => sum + item.count, 0)
      if (!Number.isSafeInteger(count)) throw new Error('house-inventory-unconfirmed')
      stock[material] = count
    }
    return stock
  }

  async buildHouse(input: unknown, signal: AbortSignal, recovery = false): Promise<MinecraftHouseReceipt> {
    const request = MinecraftHouseRequest.safeParse(input)
    if (!request.success) throw new Error('minecraft-house-invalid-request')
    return this.executeHouse(request.data, signal, recovery ? 'recover' : undefined)
  }

  async placeHouseCell(input: unknown, signal: AbortSignal): Promise<MinecraftHouseCellReceipt> {
    const request = MinecraftHouseCellRequest.safeParse(input)
    if (!request.success) throw new Error('minecraft-house-invalid-request')
    return this.executeHouse(request.data, signal, request.data.index)
  }

  private executeHouse(request: MinecraftHouseRequest, signal: AbortSignal, mode?: 'recover'): Promise<MinecraftHouseReceipt>
  private executeHouse(request: MinecraftHouseRequest, signal: AbortSignal, index: number): Promise<MinecraftHouseCellReceipt>
  private async executeHouse(request: MinecraftHouseRequest, signal: AbortSignal, mode?: number | 'recover'): Promise<MinecraftHouseReceipt | MinecraftHouseCellReceipt> {
    signal.throwIfAborted()
    const recovery = mode === 'recover'
    const index = typeof mode === 'number' ? mode : undefined
    const cell = index === undefined ? undefined : minecraftHouseCellTarget(request.layout, index)
    if (index !== undefined && !cell) throw new Error('minecraft-house-invalid-request')
    const assertReady = (epoch: number, action?: Action) => cell ? this.assertHouseCellReady(epoch, action) : this.assertHouseReady(epoch, action, recovery)
    assertReady(this.connectionEpoch)
    const session = await this.captureHouseSession()
    assertReady(session.epoch)
    const kind = cell ? 'house-cell' : 'house-build'
    const action = await this.startAction(kind, false)
    const timeout = AbortSignal.timeout(cell ? HOUSE_CELL_TIMEOUT_MS : HOUSE_BUILD_TIMEOUT_MS)
    const guarded = AbortSignal.any([signal, action.controller.signal, timeout])
    const guard = () => assertReady(session.epoch, action)
    const id = randomBytes(12).toString('hex')
    const volume = cell ? 1 : request.layout.blocks.length
    let dispatched = false
    let terminal = false
    let restoreAutoCraft = false
    let stopping: Promise<void> | undefined
    const cancel = () => {
      if (!dispatched || terminal || stopping || this.action !== action || session.epoch !== this.connectionEpoch) return
      stopping = campAdmission.exit(async () => {
        await this.verifyHouseSession(session)
        const stillOwnAction = () => {
          if (this.action !== action || session.epoch !== this.connectionEpoch) throw new Error('house-ownership-unconfirmed')
        }
        const result = await this.queryHouse(id, `cancel ${id}`, undefined, stillOwnAction)
        if (result.phase === 'building' || result.phase === 'ready') throw new Error('house-stop-unconfirmed')
      }).catch(() => { this.record('stop.unconfirmed', { reason: kind }) })
    }
    guarded.addEventListener('abort', cancel, { once: true })
    try {
      guarded.throwIfAborted()
      const verifyOwnership = async () => {
        await this.verifyHouseSession(session)
        guarded.throwIfAborted()
        guard()
      }
      const beforeCell = cell && await this.readHouseCell(request, cell, guarded, guard)
      if (cell && beforeCell === 'blocked') {
        await verifyOwnership()
        return { outcome: 'blocked', index: cell.index, material: cell.material, consumed: 0, reason: 'homebuild-obstructed' }
      }
      if (!cell) {
        const preview = this.validateHousePreview(await this.queryHouse(id, this.houseCommand(recovery ? 'recover-preview' : 'preview', id, request), guarded, guard), volume)
        if (!preview.ready) throw new Error(preview.reason?.startsWith('homebuild-') ? preview.reason : 'house-preconditions-changed')
      }
      if (this.reflexEnabled) {
        restoreAutoCraft = true
        await this.setActionAutoCraft(false, guarded, guard)
      }
      const missing: HouseMaterials = cell ? beforeCell === 'empty' ? { [cell.material]: 1 } : {} : await this.readHouseLayout(request, true, guarded, guard)
      const expectedPlacements = Object.values(missing).reduce((sum, count) => sum + count, 0)
      const before = await this.readHouseInventory(guarded, guard)
      if (cell && beforeCell === 'matching') {
        if (await this.readHouseCell(request, cell, guarded, guard) !== 'matching') throw new Error('house-world-unconfirmed')
        const after = await this.readHouseInventory(guarded, guard)
        if (!this.houseInventoryMatches(before, after, missing)) throw new Error('house-inventory-unconfirmed')
        await verifyOwnership()
        return { outcome: 'already-present', index: cell.index, material: cell.material, consumed: 0 }
      }
      if (HOUSE_MATERIALS.some(material => (before[material] ?? 0) < (missing[material] ?? 0))) {
        if (cell) {
          await verifyOwnership()
          return { outcome: 'blocked', index: cell.index, material: cell.material, consumed: 0, reason: 'homebuild-materials' }
        }
        throw new Error('house-preconditions-changed')
      }
      const start = await this.readHouseStance(request.zone.dimension, guarded, guard)
      await verifyOwnership()
      const command = cell ? `${this.houseCommand('runone', id, request)} ${cell.index}` : this.houseCommand(recovery ? 'recover' : 'run', id, request)
      let progress = await this.queryHouse(id, command, guarded, () => {
        guard()
        dispatched = true
      })
      if (progress.phase === 'ready' || progress.phase === 'building' && (progress.checked !== volume || progress.placed !== 0)) {
        throw new Error('house-receipt-unconfirmed')
      }
      while (progress.phase === 'building') {
        await delay(400)
        guarded.throwIfAborted()
        const next = await this.queryHouse(id, `status ${id}`, guarded, guard)
        if (next.phase === 'ready' || next.placed < progress.placed || next.placed > expectedPlacements ||
          (next.phase === 'building' && next.checked !== volume)) throw new Error('house-receipt-unconfirmed')
        progress = next
      }
      guarded.throwIfAborted()
      terminal = true
      if (cell) {
        const receipt = await this.confirmHouseCell(request, cell, start, progress, before, guarded, guard)
        await verifyOwnership()
        this.record('action.finished', { kind, ...receipt })
        return receipt
      }
      if (progress.phase !== 'succeeded') {
        throw new Error(progress.phase === 'cancelled' ? 'house-cancelled'
          : progress.reason.startsWith('homebuild-') ? progress.reason : 'house-preconditions-changed')
      }
      if (progress.checked !== volume || progress.placed !== expectedPlacements) throw new Error('house-receipt-unconfirmed')
      await this.readHouseLayout(request, false, guarded, guard)
      const after = await this.readHouseInventory(guarded, guard)
      if (!this.houseInventoryMatches(before, after, missing)) throw new Error('house-inventory-unconfirmed')
      await this.verifyHouseReturn(request.zone.dimension, start, guarded, guard)
      await verifyOwnership()
      const receipt = MinecraftHouseReceipt.parse({ built: true, zoneId: request.zone.id, checked: volume, placed: expectedPlacements, consumed: missing })
      if (!minecraftHouseReceiptMatches(receipt, request)) throw new Error('house-receipt-unconfirmed')
      this.record('action.finished', { kind, ...receipt })
      return receipt
    } catch (error) {
      const code = signal.aborted || action.controller.signal.aborted ? 'house-cancelled' : timeout.aborted ? 'house-timeout'
        : error instanceof Error ? error.message : 'house-receipt-unconfirmed'
      cancel()
      await stopping
      this.record('action.failed', { kind, error: code })
      throw new Error(code)
    } finally {
      guarded.removeEventListener('abort', cancel)
      if (restoreAutoCraft && this.action === action && session.epoch === this.connectionEpoch && !this.campPaused && !action.controller.signal.aborted) {
        await this.setActionAutoCraft(this.reflexEnabled, action.controller.signal, guard).catch(() => {
          this.record('safety.restore-failed', { setting: 'survivalAutoCraft', reason: kind })
        })
      }
      if (this.action === action) {
        this.action = undefined
        if (this.observation?.action === kind) this.observation.action = undefined
      }
    }
  }

  private houseInventoryMatches(before: HouseMaterials, after: HouseMaterials, expected: HouseMaterials): boolean {
    return HOUSE_MATERIALS.every(material => (before[material] ?? 0) - (after[material] ?? 0) === (expected[material] ?? 0))
  }

  private async verifyHouseReturn(dimension: string, start: Position, signal: AbortSignal, guard: () => void): Promise<void> {
    const end = await this.readHouseStance(dimension, signal, guard)
    if (Math.floor(start.x) !== Math.floor(end.x) || Math.floor(start.z) !== Math.floor(end.z) ||
      Math.abs(start.y - end.y) > 0.25 || Math.hypot(start.x - end.x, start.z - end.z) > 0.5) throw new Error('house-stance-unconfirmed')
  }

  private async confirmHouseCell(request: MinecraftHouseRequest, cell: NonNullable<ReturnType<typeof minecraftHouseCellTarget>>,
    start: Position, progress: HouseProgress, before: HouseMaterials, signal: AbortSignal, guard: () => void): Promise<MinecraftHouseCellReceipt> {
    const reason = progress.phase === 'failed' && progress.placed === 0 ? MinecraftHouseCellBlockedReason.safeParse(progress.reason).data : undefined
    if (!reason && progress.phase !== 'succeeded') {
      throw new Error(progress.phase === 'cancelled' ? 'house-cancelled' : 'house-cell-unconfirmed')
    }
    if (progress.checked !== (reason === 'homebuild-unavailable-cell' ? 0 : 1) || progress.placed > 1) throw new Error('house-receipt-unconfirmed')
    const target = await this.readHouseCell(request, cell, signal, guard)
    if (reason ? target === 'matching' || target === 'blocked' && reason !== 'homebuild-obstructed' : target !== 'matching') {
      throw new Error('house-world-unconfirmed')
    }
    const after = await this.readHouseInventory(signal, guard)
    if (!this.houseInventoryMatches(before, after, progress.placed ? { [cell.material]: progress.placed } : {})) {
      throw new Error('house-inventory-unconfirmed')
    }
    await this.verifyHouseReturn(request.zone.dimension, start, signal, guard)
    const { index, material } = cell
    if (reason) return { outcome: 'blocked', index, material, consumed: 0, reason }
    return progress.placed ? { outcome: 'placed', index, material, consumed: 1 } : { outcome: 'already-present', index, material, consumed: 0 }
  }

  async buildCamp(input: unknown, signal?: AbortSignal, visitCenter?: Position): Promise<unknown> {
    const authorized = signal && MinecraftAuthorizedCampRequest.parse(input)
    const { zone, material } = authorized || z.object({
      zone: z.object({
        id: z.string().regex(/^[a-z0-9-]{1,64}$/u),
        dimension: z.string().regex(/^[a-z0-9_:.-]{1,64}$/u),
        x: z.number().int().min(-30_000_000).max(30_000_000),
        y: z.number().int().min(-2048).max(2032),
        z: z.number().int().min(-30_000_000).max(30_000_000),
        radius: z.number().int().min(2).max(8),
      }),
      material: z.string().regex(/^[a-z_]+$/u),
    }).parse(input)
    const allowed = [...LOGS.map(log => log.replace(/_log$/u, '_planks')), 'cobblestone', 'dirt', 'stone']
    if (!allowed.includes(material)) throw new Error('build-material')
    signal?.throwIfAborted()
    if (signal && this.connecting) throw new Error('connection-busy')
    if (!this.online) throw new Error('minecraft-offline')
    if (!this.features?.campBuilding) throw new Error('build-unavailable')
    const action = await this.startAction(signal ? 'build-authorized' : 'build', !signal)
    const guarded = signal && AbortSignal.any([signal, action.controller.signal])
    const activeSignal = guarded ?? action.controller.signal
    const commandZone = visitCenter ? { ...zone, x: visitCenter.x, z: visitCenter.z, radius: 2 } : zone
    let center: Position | undefined
    let restoreAutoCraft = false
    let dispatched = false
    let stopping: Promise<unknown> | undefined
    const stopBuild = () => {
      if (dispatched && this.action === action && this.online) {
        stopping ??= (async () => {
          if (visitCenter) {
            const visit = this.visit
            if (!visit || await this.visitLogState(visit) !== 'owned') return
          }
          await this.cbi('stop', this.botName, 0, /\[CBI\] 已停止当前 cbi 任务/u)
        })().catch(() => {
          this.record('stop.unconfirmed', { reason: 'build-authorized' })
        })
      }
    }
    guarded?.addEventListener('abort', stopBuild, { once: true })
    try {
      guarded?.throwIfAborted()
      if (visitCenter && !await this.campVisitBuildSiteReady(visitCenter, zone.dimension, activeSignal)) throw new Error('build-preconditions-changed')
      if (!guarded || this.reflexEnabled) {
        restoreAutoCraft = true
        await this.setActionAutoCraft(false)
      }
      const before = guarded ? await this.observeInternal() : await this.observe()
      const eligible = authorized?.prepare
        ? minecraftPrepareOffer(before, zone, material, 'build-authorized')?.batches === 0
        : !guarded || minecraftCampOffer(before, zone, 'build-authorized')?.material === material
      if (!eligible) {
        throw new Error('build-preconditions-changed')
      }
      if (visitCenter) {
        if (!this.safeCampVisitPosition(before, zone) || numeric(await this.data(this.botName, 'OnGround', activeSignal)) !== 1) {
          throw new Error('build-preconditions-changed')
        }
        await this.requireCampVisitStructure(zone, activeSignal, 'build', action)
      }
      const count = (state: Record<string, unknown>, name: string) => (state.inventory as { name: string; count: number }[]).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
      const beforeFloor = count(before, material)
      const beforeTable = count(before, 'crafting_table')
      const confirmation = /开始营地建造，区域 ([a-z0-9-]+)，中心 (-?\d+), (-?\d+), (-?\d+)，材料 ([a-z_]+)/u
      const completion = visitCenter
        ? new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: CBI feedback sender=${this.botName} target=${this.botName} message="?(?:\[CBI\] ${confirmation.source}|\[CBI\] (?:错误: )?build-[a-z-]+)"?\r?\n`, 'mu')
        : /(?:开始营地建造，区域 [a-z0-9-]+，中心 |build-[a-z-]+)/u
      const dispatch = guarded ? () => {
        if (visitCenter) {
          this.assertCampVisitZone(zone)
          this.claimCampVisitAction('build')
        }
        dispatched = true
      } : undefined
      const receipt = await this.cbi(`buildcamp ${commandZone.id} ${commandZone.dimension} ${commandZone.x} ${commandZone.y} ${commandZone.z} ${commandZone.radius} ${material}`,
        this.botName, 0, completion, guarded, dispatch, visitCenter ? zone : undefined)
      const match = (visitCenter ? completion : confirmation).exec(receipt)
      if (!match || match[1] !== zone.id || match[5] !== material) throw new Error('build-unconfirmed')
      center = { x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) }
      if (visitCenter && (center.x !== visitCenter.x || center.y !== visitCenter.y || center.z !== visitCenter.z)) throw new Error('build-zone-unconfirmed')
      if (guarded && (Math.abs(center.x - zone.x) >= zone.radius || Math.abs(center.z - zone.z) >= zone.radius ||
        center.y < zone.y - zone.radius || center.y + 2 > zone.y + zone.radius)) throw new Error('build-zone-unconfirmed')
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        activeSignal.throwIfAborted()
        const observation = guarded ? await this.observeInternal() : await this.observe()
        guarded?.throwIfAborted()
        const survival = observation.survival as Record<string, unknown> | undefined
        const phase = String(survival?.build ?? '')
        if (phase === 'SUCCEEDED') {
          const placedFloor = Number(survival?.buildFloor ?? 0)
          const placedTable = Number(survival?.buildTable ?? 0)
          if (guarded && (observation.dimension !== zone.dimension || survival?.buildZone !== zone.id ||
            survival.buildCenter !== `${center.x},${center.y},${center.z}` || placedFloor !== 8 || placedTable !== 1)) {
            throw new Error('build-receipt-unconfirmed')
          }
          const dimension = guarded ? zone.dimension : undefined
          const readbackSignal: [AbortSignal?] = visitCenter ? [activeSignal] : []
          for (const { target, block } of campBuildFootprint(center, material)) {
            guarded?.throwIfAborted()
            if (!await this.block(target, block, dimension, ...readbackSignal)) throw new Error('build-world-unconfirmed')
          }
          guarded?.throwIfAborted()
          const afterFloor = count(observation, material)
          const afterTable = count(observation, 'crafting_table')
          if (beforeFloor - afterFloor !== placedFloor || beforeTable - afterTable !== placedTable) throw new Error('build-inventory-unconfirmed')
          if (visitCenter) {
            const visit = this.visit
            if (!visit || await this.visitLogState(visit) !== 'owned' || !this.safeCampVisitPosition(observation, zone)) throw new Error('build-ownership-unconfirmed')
            activeSignal.throwIfAborted()
            this.assertCampVisitZone(zone)
            this.assertCampAdmission()
            const verified = MinecraftVisitBuildReceipt.parse({ built: true, zoneId: zone.id, material, placedFloor, placedTable,
              inventory: { floorBefore: beforeFloor, floorAfter: afterFloor, tablesBefore: beforeTable, tablesAfter: afterTable } })
            this.observation = observation
            this.record('action.finished', { kind: 'build', ...verified })
            return verified
          }
          if (!guarded) {
            this.action = undefined
            observation.action = undefined
          }
          this.observation = observation
          const result = { built: true, zoneId: zone.id, target: center, material, placedFloor, placedTable, observation }
          this.record('action.finished', { kind: 'build', ...result })
          return result
        }
        if (phase === 'FAILED') throw new Error(String(survival?.buildError ?? 'build-failed'))
        if (phase === 'CANCELLED') throw new Error('build-cancelled')
        await delay(500)
      }
      throw new Error('build-timeout')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = activeSignal.aborted ? 'build-cancelled' : /build-[a-z-]+/u.exec(message)?.[0] ?? message
      if (!guarded) this.action = undefined
      this.record('action.failed', { kind: 'build', target: center, zoneId: zone.id, error: code })
      if (guarded) {
        stopBuild()
        await stopping
      } else if (this.online) await this.cbi('stop').catch(() => {})
      throw new Error(code)
    } finally {
      guarded?.removeEventListener('abort', stopBuild)
      if (restoreAutoCraft && (!guarded || this.action === action && !action.controller.signal.aborted)) {
        await this.restoreActionAutoCraft()
      }
      if (guarded && this.action === action) {
        this.action = undefined
        if (this.observation?.action === 'build-authorized') this.observation.action = undefined
      }
    }
  }

  async close(): Promise<void> {
    this.refreshChatRelay(false)
    this.action?.controller.abort()
    const visit = this.visit?.id ?? this.visitStart?.id
    if (visit) {
      await this.endCampVisit({ id: visit }).catch(() => this.record('camp-visit.end-unconfirmed', { visitId: visit }))
    } else if (this.online) {
      await this.disconnect().catch(async () => {
        const request = this.commandQueue.then(() => this.writeConsole(`player ${this.botName} kill`)).catch(() => {})
        this.commandQueue = request
        await request
        this.record('connection.offline.requested', { reason: 'worker-closing' })
      })
    }
    this.closing = true
    clearInterval(this.timer)
    this.removeAllListeners()
  }
}
