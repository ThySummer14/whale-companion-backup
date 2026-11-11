export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface Persona {
  version: number
  name: string
  tagline: string
  description: string
  updatedAt: string
}

export interface PersonaRevision extends Persona {
  change: 'initial' | 'imported' | 'edit' | 'restore'
  reason?: string
  restoredFrom?: number
}

export type ContextKind = 'chat' | 'game' | 'task' | 'topic' | 'system'

export interface SessionBinding {
  contextId: string
  sessionId: string
  kind: ContextKind
  label: string
  createdAt: string
  updatedAt: string
}

export type ActivityStatus = 'info' | 'success' | 'warning' | 'error'

export interface ActivityInput {
  eventId?: string
  contextId?: string
  sessionId?: string
  taskId?: string
  source: string
  kind: string
  summary: string
  status?: ActivityStatus
  occurredAt?: string
  data?: Record<string, JsonValue>
}

export interface ActivityRecord extends ActivityInput {
  id: number
  eventId: string
  status: ActivityStatus
  occurredAt: string
  data: Record<string, JsonValue>
}

export type TaskStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: string
  externalId?: string
  contextId?: string
  sessionId?: string
  capabilityId: string
  title: string
  status: TaskStatus
  error?: string
  createdAt: string
  updatedAt: string
}

export type CapabilityStatus = 'ready' | 'planned' | 'unavailable' | 'error'

export interface CapabilityRecord {
  id: string
  displayName: string
  kind: 'core' | 'connector' | 'media' | 'game'
  status: CapabilityStatus
  detail: string
  updatedAt: string
}

export type Presence = 'unconfigured' | 'offline' | 'idle' | 'running'

export interface DeviceRecord {
  id: string
  name: string
  secretHash: string
  createdAt: string
  lastSeenAt?: string
  revokedAt?: string
}

export type MemoryKind = 'user-fact' | 'preference' | 'experience' | 'event' | 'goal' | 'relationship' | 'other'
export type MemoryScope = 'shared' | 'context'
export type MemoryStatus = 'candidate' | 'active' | 'archived' | 'forgotten'

export interface MemorySourceRef {
  contextId?: string
  sessionId?: string
  activityId?: number
  taskId?: string
  eventSeq?: number
}

export interface MemoryRecord {
  id: string
  kind: MemoryKind
  content: string
  scope: MemoryScope
  contextId?: string
  status: MemoryStatus
  importance: number
  confidence: number
  pinned: boolean
  recallCount: number
  reinforcementCount?: number
  lastReinforcedAt?: string
  retention?: number
  sourceRefs: MemorySourceRef[]
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  forgetReason?: string
  archivedFrom?: 'active' | 'candidate'
  archiveReason?: string
}

export interface MemoryRevision {
  id: number
  memoryId: string
  revision: number
  snapshot: MemoryRecord
  actorSessionId?: string
  reason: string
  createdAt: string
}

export interface MemoryCounts {
  active: number
  candidate: number
  forgotten: number
  archived?: number
}

export type SelfNoteBasis = 'observation' | 'user-feedback' | 'inference'
export type SelfNoteStatus = 'active' | 'archived'

export const SELF_NOTE_TRAIT_LABELS = {
  'ask-before-assuming': '信息不足时先问清楚',
  'explain-with-example': '用具体例子帮助说明',
  'state-uncertainty': '坦白说明自己的不确定',
  'check-evidence': '先核对证据再作判断',
  'keep-boundaries': '行动前确认授权和边界',
  'respect-quiet': '尊重对方想安静的节奏',
  'prefer-small-steps': '把复杂问题拆成可核对的小步',
  'follow-through': '说到的事跟进到结果',
} as const
export type SelfNoteTrait = keyof typeof SELF_NOTE_TRAIT_LABELS
export const SELF_NOTE_TRAITS = Object.keys(SELF_NOTE_TRAIT_LABELS) as [SelfNoteTrait, ...SelfNoteTrait[]]

export interface SelfNoteEvidenceRef {
  quoteIndex: number
  messageId: string
  role: 'user' | 'assistant'
}

export type SelfNoteMilestoneExperience =
  | { kind: 'camp-project'; taskId: string; constructionTaskId: string; receiptTaskId: string }
  | { kind: 'house'; taskId: string; draftId: string }

export type SelfNoteMilestoneKind = SelfNoteMilestoneExperience['kind']

export type SelfNoteExperience =
  | { kind: 'survey'; dailyTaskId: string; activityTaskId: string; receiptTaskId: string }
  | { kind: 'supply'; dailyTaskId: string; activityTaskId: string; receiptTaskId: string }
  | { kind: 'build'; dailyTaskId: string; activityTaskId: string; receiptTaskId: string }
  | { kind: 'house-project'; dailyTaskId: string; activityTaskId: string; activityId: number }
  | { kind: 'bilibili'; dailyTaskId: string; activityTaskId: string; activityId: number }
  | SelfNoteMilestoneExperience

export interface SelfNoteExperienceReceipt {
  at: string
  fact: string
}

export interface SelfNote {
  id: string
  content: string
  basis: SelfNoteBasis
  status: SelfNoteStatus
  confidence: number
  evidence: string[]
  counterEvidence: string[]
  sourceRefs: MemorySourceRef[]
  evidenceRefs?: SelfNoteEvidenceRef[]
  experience?: SelfNoteExperience
  experienceReceipt?: SelfNoteExperienceReceipt
  trait?: SelfNoteTrait
  supersedes?: string
  revisionReason?: string
  createdBy: 'companion' | 'owner'
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

export interface SelfNoteRevision {
  id: number
  noteId: string
  revision: number
  snapshot: SelfNote
  actorSessionId?: string
  reason: string
  createdAt: string
}

export interface SelfNoteCounts {
  active: number
  archived: number
  companionActive?: number
  ownerActive?: number
}

export interface WorkbenchStats {
  activities: number
  activities24h: number
  runningTasks: number
  failedTasks: number
  inputTokens: number
  outputTokens: number
  usage24h?: {
    measuredCalls: number
    unmeteredCalls: number
    uncachedInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    backgroundCalls: number
    backgroundUncachedInputTokens: number
    byContext?: {
      contextId: string
      measuredCalls: number
      unmeteredCalls: number
      uncachedInputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      outputTokens: number
      reasoningTokens: number | null
    }[]
  }
}

export const DEFAULT_PERSONA: Persona = {
  version: 1,
  name: '小鲸鱼',
  tagline: '爱吃白饭的蓝色大肥鱼',
  description: '铁盆是吃白饭的重要家伙。角色名称、人设与视觉形象仍在共同塑造中。',
  updatedAt: new Date(0).toISOString(),
}

export const BILIBILI_CONTEXT = 'world.bilibili'
export const BILIBILI_AUTONOMY_CONTEXT = 'autonomy.bilibili'
export const BILIBILI_CLIP_CONTEXT = 'autonomy.bilibili-clip'
export const BILIBILI_REFLECTION_CONTEXT = 'autonomy.bilibili-reflect'
export const BILIBILI_SHARE_CONTEXT = 'autonomy.bilibili-feed'
export const DAILY_AUTONOMY_CONTEXT = 'autonomy.daily'
export const DAILY_VISIT_CONTEXT = 'autonomy.daily-visit'
export const DAILY_REFLECTION_CONTEXT = 'autonomy.daily-reflection'
export const MINECRAFT_RECOVERY_CONTEXT = 'autonomy.minecraft-recovery'
export function milestoneReflectionKey(kind: SelfNoteMilestoneKind, taskId: string): string {
  return `minecraft-milestone-reflection:${kind}:${taskId}`
}
export const BILIBILI_SHARE_TTL_MS = 24 * 60 * 60_000
export const SINGING_CONTEXT = 'world.singing'

export const DEFAULT_CAPABILITIES: readonly Omit<CapabilityRecord, 'updatedAt'>[] = [
  { id: 'core.workbench', displayName: 'Bot 工作台', kind: 'core', status: 'ready', detail: '多场景、中央记忆、活动、任务与数据面板' },
  { id: 'core.memory', displayName: '中央记忆', kind: 'core', status: 'ready', detail: '跨场景记忆检索、修订、来源与遗忘' },
  { id: 'connector.mobile', displayName: '手机 App', kind: 'connector', status: 'ready', detail: 'Android 配对、聊天与动态客户端' },
  { id: 'core.feed', displayName: '动态时间线', kind: 'core', status: 'ready', detail: '真实动态、回复、角色发布工具与手机／工作台页面' },
  { id: 'core.autonomy', displayName: '角色内核', kind: 'core', status: 'ready', detail: '持久自主队列、异步记忆整理与受控节律' },
  { id: 'media.tts', displayName: '语音合成', kind: 'media', status: 'planned', detail: '等待独立 TTS Provider' },
  { id: 'media.avatar', displayName: '虚拟形象', kind: 'media', status: 'planned', detail: 'AIRI / Live2D 能力尚未接入' },
  { id: 'game.minecraft', displayName: 'Minecraft', kind: 'game', status: 'planned', detail: '等待独立游戏适配器与权限策略' },
  { id: 'media.bilibili', displayName: 'B 站', kind: 'connector', status: 'ready', detail: '按视频读取公开资料和可用字幕片段' },
  { id: 'media.singing', displayName: '歌唱', kind: 'media', status: 'planned', detail: '等待配置本地歌唱 Provider' },
]

export type FeedAuthor = 'companion' | 'user'

export const MINECRAFT_SHARE_CONTEXT = 'autonomy.minecraft-feed'
export const MINECRAFT_SUPPLY_CONTEXT = 'autonomy.minecraft-supply'
export const MINECRAFT_SHARE_ACTIONS = ['dig', 'craft', 'return', 'build', 'prepare', 'survey'] as const

export interface BilibiliFeedSource {
  bvid: string
  part: number
  startSeconds: number
}

export interface FeedSongSource {
  id: string
  title: string
  bytes: number
  durationSeconds?: number
}

export interface FeedPost {
  id: string
  parentId?: string
  author: FeedAuthor
  body: string
  mediaId?: string
  contextId?: string
  sourceSessionId?: string
  sourceTaskId?: string
  bilibiliSource?: BilibiliFeedSource
  song?: FeedSongSource
  replyCount: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface FeedCreateInput {
  body: string
  author: FeedAuthor
  mediaId?: string
  parentId?: string
  contextId?: string
  sourceSessionId?: string
  sourceTaskId?: string
  songTaskId?: string
}

export interface FeedList {
  items: FeedPost[]
  nextCursor?: string
}

export interface FeedThread extends FeedPost {
  replies: FeedPost[]
}

export const AVATAR_ACTIONS = ['blush', 'point', 'nod', 'shake'] as const

export interface AvatarAction {
  id: (typeof AVATAR_ACTIONS)[number]
  label: string
  duration: number
}

export interface AvatarVoicePresentation {
  playing: boolean
  segmentIndex?: number
  positionMs: number
  energy: number
  audioContextState: string
  error?: string
}

export interface AvatarPresentation {
  ready: boolean
  frames: number
  nonFinite: number
  stageId?: string
  songReady?: boolean
  actionReady?: boolean
  renderer?: string
  jobId?: string
  parameterCount?: number
  voice?: AvatarVoicePresentation
  updatedAt: string
}

export interface AvatarView {
  available: boolean
  detail: string
  model?: { name: string; counts: Record<string, number> }
  actions: AvatarAction[]
  presentation?: AvatarPresentation
  pendingActions: { taskId: string; action: AvatarAction }[]
  stopRequestIds: string[]
  tasks: TaskRecord[]
  credits: string
  diagnostics?: { root: string; stageRoot: string }
}

export type MediaKind = 'voice' | 'avatar' | 'image' | 'video' | 'song' | 'other'

export interface MediaAsset {
  id: string
  kind: MediaKind
  path: string
  hash?: string
  mimeType: string
  bytes: number
  source: string
  sourceRef?: string
  retention: 'cache' | 'keep'
  createdAt: string
  lastUsedAt: string
  lastVerifiedAt: string
  missingAt?: string
  deletedAt?: string
}

export interface MediaSummary {
  files: number
  bytes: number
  cacheBytes: number
  missingFiles: number
  deletedFiles: number
  deletedBytes: number
  byKind: Partial<Record<MediaKind, { files: number; bytes: number }>>
}

export interface MediaCleanupResult {
  policy: 'delete-verified'
  olderThanDays: number
  deleted: MediaAsset[]
  skipped: { asset: MediaAsset; reason: 'missing' | 'changed' | 'hash-mismatch' | 'io-error' }[]
  bytes: number
}

export interface MediaView {
  items: MediaAsset[]
  summary: MediaSummary
  lastScanAt?: string
  error?: string
  protected: string[]
}

export interface MediaCleanupPreview {
  policy: 'preview-only'
  olderThanDays: number
  candidates: MediaAsset[]
  bytes: number
  duplicateGroups: { hash: string; files: number; bytes: number }[]
}

export interface TtsAsset {
  id: string
  taskId: string
  contextId: string
  sourceMessageId: string
  voice: string
  textHash: string
  filePath: string
  mimeType: 'audio/wav'
  bytes: number
  durationMs: number
  createdAt: string
}

export interface TtsTaskView extends TaskRecord {
  audio?: {
    id: string
    mimeType: 'audio/wav'
    bytes: number
    durationMs: number
  }
}

export type AutonomousJobKind = 'memory.review' | 'feed.review' | 'feed.reply' | 'minecraft.event' | 'minecraft.share' | 'minecraft.supply' | 'minecraft.recovery' | 'bilibili.review' | 'bilibili.reflect' | 'bilibili.share' | 'daily.choice' | 'daily.reflect'

export const CONTEXT_COMPACTION_CAPABILITY = 'core.context.compaction'
export const IDLE_COMPACTION_MINUTES = 30
export const IDLE_COMPACTION_PERCENT = 30

export interface AutonomousJob {
  id: string
  kind: AutonomousJobKind
  contextId: string
  dedupeKey: string
  runAfter: number
  payload: Record<string, JsonValue>
  attempts: number
  maxAttempts: number
  leaseUntil?: number
  lastError?: string
  createdAt: string
  updatedAt: string
  task: TaskRecord
}

export interface AutonomySettings {
  enabled: boolean
  memoryReview: boolean
  dailyReflectionEnabled?: boolean
  dailyInitiativeEnabled?: boolean
  memoryArchiveEnabled?: boolean
  idleCompactionEnabled?: boolean
  feedEnabled: boolean
  feedRepliesEnabled: boolean
  minecraftShareEnabled: boolean
  minecraftShareImagesEnabled?: boolean
  minecraftMilestonesEnabled?: boolean
  minecraftRecoveryEnabled?: boolean
  minecraftRecoveryPlacementEnabled?: boolean
  minecraftRecoveryContinuousEnabled?: boolean
  bilibiliEnabled?: boolean
  bilibiliClipsEnabled?: boolean
  bilibiliReflectionEnabled?: boolean
  bilibiliShareEnabled?: boolean
  bilibiliClipShareEnabled?: boolean
  bilibiliIntervalMinutes?: number
  reviewDelaySec: number
  replyDelaySec: number
  replyCooldownSec: number
  feedIntervalMinutes: number
  quietStart: string
  quietEnd: string
}

export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  enabled: true,
  memoryReview: true,
  dailyReflectionEnabled: false,
  dailyInitiativeEnabled: false,
  memoryArchiveEnabled: false,
  idleCompactionEnabled: false,
  feedEnabled: false,
  feedRepliesEnabled: true,
  minecraftShareEnabled: false,
  minecraftShareImagesEnabled: false,
  minecraftMilestonesEnabled: false,
  minecraftRecoveryEnabled: false,
  minecraftRecoveryPlacementEnabled: false,
  minecraftRecoveryContinuousEnabled: false,
  bilibiliEnabled: false,
  bilibiliClipsEnabled: false,
  bilibiliReflectionEnabled: false,
  bilibiliShareEnabled: false,
  bilibiliClipShareEnabled: false,
  bilibiliIntervalMinutes: 240,
  reviewDelaySec: 90,
  replyDelaySec: 10,
  replyCooldownSec: 120,
  feedIntervalMinutes: 360,
  quietStart: '23:00',
  quietEnd: '08:00',
}

export interface AutonomyView {
  settings: AutonomySettings
  pending: number
  running: number
  lastTickAt?: string
  lastDecision?: string
  lastError?: string
  jobs: AutonomousJob[]
}

export interface GameLessonTarget {
  x: number
  y: number
  z: number
  block?: string
}

export type GameLessonStatus = 'learning' | 'resolved' | 'disabled'

export interface GameLesson {
  signature: string
  action: string
  errorCode: string
  targetKey: string
  target?: GameLessonTarget
  lesson: string
  status: GameLessonStatus
  occurrences: number
  sourceRefs: MemorySourceRef[]
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt?: string
}

export interface MinecraftBuildZone {
  id: string
  name: string
  dimension: string
  x: number
  y: number
  z: number
  radius: number
  createdAt: string
  updatedAt: string
  revokedAt?: string
}

export type RealtimeVoiceSegmentStatus = 'pending' | 'synthesizing' | 'ready' | 'playing' | 'completed' | 'cancelled'

export interface RealtimeVoiceSegment {
  index: number
  taskId?: string
  text: string
  status: RealtimeVoiceSegmentStatus
  positionMs?: number
  energy?: number
}

export type RealtimeVoiceStatus = 'preparing' | 'playing' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'

export interface RealtimeVoiceSession {
  id: string
  taskId: string
  contextId: string
  messageId: string
  kind?: 'song'
  title?: string
  songDurationMs?: number
  streaming?: true
  status: RealtimeVoiceStatus
  segments: RealtimeVoiceSegment[]
  error?: string
  createdAt: string
  updatedAt: string
}

export interface RealtimeVoiceView {
  session?: RealtimeVoiceSession
  streamingAvailable?: true
  playbackStageId?: string
  streamStageId?: string
  songStageId?: string
  tasks: TaskRecord[]
}
