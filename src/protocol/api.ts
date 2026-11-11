import type { ActivityRecord, AutonomousJob, AutonomyView, CapabilityRecord, GameLesson, MemoryCounts, MemoryKind, MemoryRecord, MemoryRevision, MemoryScope, MemoryStatus, Persona, PersonaRevision, Presence, SelfNote, SelfNoteCounts, SelfNoteRevision, SessionBinding, TaskRecord, TaskStatus, WorkbenchStats } from '../core/model.ts'
import type { BilibiliQueueView, BilibiliSubtitleDocument } from './bilibili.ts'
import type { MinecraftWardrobeView } from './minecraft-wardrobe.ts'
import type { DeviceNoticeSummary } from './notices.ts'
import type { SingingView } from './singing.ts'
import type { WorldsView } from './worlds.ts'

export interface SessionOption {
  id: string
  status: 'idle' | 'running'
}

export const HOME_JOURNAL_REVISION_MS = 24 * 60 * 60_000
export const EXPRESSIVE_TTS_STYLES = ['reference', 'happy', 'sad'] as const
export const EXPRESSIVE_TTS_MAX_CHARS = 480
export type ExpressiveTtsStyle = typeof EXPRESSIVE_TTS_STYLES[number]

export type HomeVideoReceipt =
  | { mode: 'subtitle'; source?: { bvid: string; part: number } }
  | { mode: 'clip'; source?: { bvid: string; part: number; startSeconds: number; seconds: number; visual: boolean; audio: boolean } }

export interface HomeView {
  version: 1
  activity: 'offline' | 'idle' | 'resting' | 'chatting' | 'minecraft' | 'speaking' | 'browsing' | 'singing'
  anchor: 'none' | 'window' | 'bed' | 'sofa' | 'desk' | 'stage' | 'phone'
  observedAt: string
  recent: { kind: 'chat' | 'gather' | 'craft' | 'build' | 'return' | 'post' | 'reply' | 'video' | 'song'; at: string; video?: HomeVideoReceipt }[]
  journal?: { state: 'reflecting' | 'revised'; at: string }
}

export type CommunitySite = 'home' | 'studio' | 'library' | 'camp'

export type CommunityCampReceipt = {
  kind: 'supply' | 'build' | 'prepare'
  at: string
} | {
  kind: 'survey'
  at: string
  outcome: 'completed' | 'recovered'
  route: { kind: 'straight'; direction: 'north' | 'east' | 'south' | 'west'; steps: number } |
    { kind: 'trail'; trail: SurveyTrailId; checkpoints: 0 | 1 | 2 }
}

export interface CommunityView {
  version: 1
  activeSite: CommunitySite | null
  recentCamp: CommunityCampReceipt[]
  campProject?: MinecraftCampProjectSummary
}

export interface WorkbenchView {
  schemaVersion: 2
  pluginVersion: string
  generatedAt: string
  persona: Persona
  presence: Presence
  sessionId: string | null
  bindings: SessionBinding[]
  sessions: SessionOption[]
  stats: WorkbenchStats
  memory: MemoryCounts
  capabilities: CapabilityRecord[]
  activities: ActivityRecord[]
  tasks: TaskRecord[]
  autonomy: AutonomyView
  home?: HomeView
  homeLive?: { version: 1 }
  community?: CommunityView
  bilibiliConversation?: { version: 1; contextId: 'world.bilibili'; maxClipSeconds: number }
  bilibiliQueue?: BilibiliQueueView
  bilibiliSubtitles?: BilibiliSubtitleDocument[]
  singing?: SingingView
  worlds?: WorldsView
  expressiveTts?: { version: 1; styles: readonly ExpressiveTtsStyle[]; maxChars: number }
  notices?: DeviceNoticeSummary
  avatarViewer?: { version: 1 }
  singingConversation?: { contextId: 'world.singing'; maxTotalBytes: number; midiMaxBytes?: number; wavAvailable?: false; scoreMaxSeconds?: number; shareAvailable?: true }
  minecraftCamp?: { version: 1 }
}

export interface HealthView {
  ok: true
  schemaVersion: 2
  pluginVersion: string
  presence: Presence
  sessionId: string | null
  bindings: number
  activities: number
  runningTasks: number
}

export interface MemoryView {
  items: MemoryRecord[]
  counts: MemoryCounts
}

export interface MemoryArchivePreviewEntry {
  id: string
  updatedAt: string
  retention: number
  excerpt: string
  scope: MemoryScope
  contextId?: string
}

export interface MemoryArchiveResult {
  archived: number
  skipped: number
}

export interface MemoryHistoryView {
  memory: MemoryRecord
  revisions: MemoryRevision[]
}

export interface SelfNotesView {
  items: SelfNote[]
  counts: SelfNoteCounts
}

export interface SelfNoteHistoryView {
  note: SelfNote
  revisions: SelfNoteRevision[]
}

export interface ToolPolicyView {
  contextId: string
  profile: string
  allowed: { name: string; summary: string; permission: string }[]
  denied: string[]
}

export const MINECRAFT_PERMIT_GOALS = ['planks', 'camp', 'prepare', 'survey'] as const
export type MinecraftPermitGoal = (typeof MINECRAFT_PERMIT_GOALS)[number]
export const SURVEY_DISTANCE = 4
export const SURVEY_MAX_DISTANCE = 7
export const SURVEY_MIN_RADIUS = SURVEY_DISTANCE + 1
export const SURVEY_TRAIL_LEG = SURVEY_DISTANCE
export const SURVEY_TRAIL_IDS = ['north-east', 'north-west', 'east-north', 'east-south', 'south-east', 'south-west', 'west-north', 'west-south'] as const
export type SurveyTrailId = (typeof SURVEY_TRAIL_IDS)[number]
export const SURVEY_WINDOW_KEY_PREFIX = 'survey-window:'

export interface MinecraftSurveyWindowInput {
  zoneId: string
  start: string
  end: string
  days: number
  allowBilibili?: true
  allowMinecraftLogin?: true
  allowMinecraftSupply?: true
  allowMinecraftBuild?: true
  allowMinecraftProject?: true
  allowMinecraftPatrol?: true
  allowMinecraftGather?: true
  allowMinecraftProjectGather?: true
  houseProjectId?: string
  allowHouseProjectSupply?: true
}

export interface MinecraftSurveyWindowRule extends MinecraftSurveyWindowInput {
  id: string
  timeZone: string
  createdAt: number
  expiresAt: number
  suppressedDate?: string
}

export type MinecraftCampVisitStatus = 'starting' | 'online' | 'offline' | 'unconfirmed'

export interface MinecraftCampPatrolView {
  status: 'running' | 'completed' | 'partial' | 'cancelled' | 'failed'
  completedSegments: number
  totalSegments: 2
  visitStatus: MinecraftCampVisitStatus
}

export interface MinecraftCampGatherView {
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  collected: 0 | 1
  visitStatus: MinecraftCampVisitStatus
}

export interface MinecraftCampProjectView {
  stage: 'gathering' | 'revisit' | 'complete' | 'needs-review'
  supplyVisits: number
  gatheredLogs?: number
  builtAt?: string
  revisitedAt?: string
}

export interface MinecraftCampProjectSummary extends MinecraftCampProjectView {
  availability: 'active' | 'paused' | 'ended'
}

export interface MinecraftSurveyWindowView {
  version: 1
  rule: MinecraftSurveyWindowRule | null
  dailyChoiceAvailable?: true
  campVisitAvailable?: true
  campVisitSupplyAvailable?: true
  campVisitBuildAvailable?: true
  campVisitProjectAvailable?: true
  campVisitProjectGatherAvailable?: true
  campPatrolAvailable?: true
  campGatherAvailable?: true
  houseProjectAvailable?: true
  houseProjectSupplyAvailable?: true
  project?: MinecraftCampProjectView
  patrol?: MinecraftCampPatrolView
  gather?: MinecraftCampGatherView
  lastVisit?: { status: MinecraftCampVisitStatus; at: string }
  today?: {
    date: string
    opensAt: number
    closesAt: number
    status: 'waiting' | 'available' | 'suppressed' | 'ended' | 'used' | 'paused'
    taskId?: string
    choice?: 'survey' | 'supply' | 'build' | 'revisit' | 'patrol' | 'gather' | 'bilibili' | 'house-project' | 'house-project-supply' | 'skip'
    decisionStatus?: TaskStatus
    visitStatus?: MinecraftCampVisitStatus
  }
}

export const MINECRAFT_CAMP_ACTIONS = ['follow', 'move', 'dig', 'return', 'craft', 'build', 'prepare', 'survey', 'revisit', 'patrol', 'gather', 'chat'] as const

export interface MinecraftCampControl {
  pairedPauseEnabled: boolean
  pausedAt?: string
  stopStatus?: 'pending' | 'confirmed' | 'offline' | 'unconfirmed'
  stopAt?: string
}

export interface MinecraftDeviceCampView {
  version: 1
  connection: 'online' | 'offline' | 'unavailable'
  action?: (typeof MINECRAFT_CAMP_ACTIONS)[number]
  shieldHold?: true
  observedAt: string
  control: MinecraftCampControl
  project?: MinecraftCampProjectSummary
  patrol?: MinecraftCampPatrolView
  gather?: MinecraftCampGatherView
}

export interface MinecraftView {
  workerOnline: boolean
  online: boolean
  connecting: boolean
  campControl?: MinecraftCampControl
  wardrobe?: MinecraftWardrobeView
  capabilities?: { safeReturn: boolean; crafting: boolean; shield?: boolean; campBuilding: boolean; houseBuilding?: boolean; houseCellPlacement?: boolean;
    houseProjects?: boolean; houseRecovery?: boolean; campSurvey?: boolean; campSurveyRoutes?: boolean; campSurveyTrails?: boolean }
  action?: string
  profile?: { name: string; uuid: string }
  auth?: { state: string; mode?: string }
  lastError?: string
  observation?: {
    username: string
    position?: { x: number; y: number; z: number }
    dimension?: string
    gameMode?: string
    health?: number
    food?: number
    timeOfDay?: number
    players: { name: string; distance?: number }[]
    inventory: { name: string; count: number }[]
    survival?: {
      threat: string
      shielding: boolean
      autoCombat: boolean
      avoidance: boolean
      autoEat: boolean
      logs: number
      planks: number
      throwaway: number
      food: number
      toolRemaining: number
      weapon: boolean
      shield: boolean
      next: string
      return?: string
      returnError?: string
      returnExit?: string
      returnPlaced?: number
      craft?: string
      craftError?: string
      craftItem?: string
      craftCount?: number
      craftRecipe?: string
      build?: string
      buildError?: string
      buildZone?: string
      buildCenter?: string
      buildFloor?: number
      buildTable?: number
    }
  }
  server: { host: string; port: number; version: string; onlineMode: boolean }
  buildZones: { id: string; name: string; dimension: string; x: number; y: number; z: number; radius: number; createdAt: string; updatedAt: string; revokedAt?: string }[]
  tasks: TaskRecord[]
  jobs: Pick<AutonomousJob, 'id' | 'kind' | 'task' | 'payload' | 'runAfter' | 'lastError'>[]
  lessons: GameLesson[]
  recentEvents: { seq: number; kind: string; at: string; username?: string; message?: string; delivery?: string }[]
}

export interface SavePersonaInput {
  name: string
  tagline: string
  description: string
  expectedVersion?: number
  reason?: string
}

export interface PersonaHistoryView {
  revisions: PersonaRevision[]
  nextBefore?: number
}

export interface BindSessionInput {
  sessionId: string | null
}

export interface BindContextInput {
  contextId: string
  sessionId: string
  kind: SessionBinding['kind']
  label: string
}

export interface SaveMemoryInput {
  kind: MemoryKind
  content: string
  scope: MemoryScope
  contextId?: string
  status?: Exclude<MemoryStatus, 'archived'>
  importance?: number
  confidence?: number
  pinned?: boolean
  sourceRefs?: MemoryRecord['sourceRefs']
  reason?: string
}

export interface CreateTaskInput {
  externalId?: string
  contextId?: string
  sessionId?: string
  capabilityId: string
  title: string
}

export interface UpdateTaskInput {
  status: TaskRecord['status']
  error?: string
}

export interface ErrorView {
  error: string
  code?: string
}
