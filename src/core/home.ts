import { HOME_JOURNAL_REVISION_MS, type HomeVideoReceipt, type HomeView } from '../protocol/api.ts'
import { MAX_BILIBILI_CLIP_SECONDS } from '../protocol/bilibili.ts'
import { parseBilibiliTarget } from './bilibili.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_CLIP_CONTEXT, BILIBILI_CONTEXT, type ActivityRecord, type Presence, type SessionBinding } from './model.ts'

type HomeRecent = HomeView['recent'][number]

const anchors = {
  offline: 'none',
  idle: 'window',
  resting: 'bed',
  chatting: 'sofa',
  minecraft: 'desk',
  speaking: 'stage',
  browsing: 'phone',
  singing: 'stage',
} as const satisfies Record<HomeView['activity'], HomeView['anchor']>

const minecraftActions = new Map<string, HomeRecent['kind']>([
  ['minecraft.dig', 'gather'],
  ['minecraft.craft', 'craft'],
  ['minecraft.build', 'build'],
  ['minecraft.return', 'return'],
  ['minecraft.survey', 'return'],
])

function isHomeChatBinding(binding: SessionBinding): boolean {
  return (binding.kind === 'chat' || binding.kind === 'topic') &&
    binding.contextId !== 'memory.curator' &&
    !binding.contextId.startsWith('autonomy.') &&
    !binding.contextId.startsWith('feed.reply.')
}

function recentKind(activity: ActivityRecord, chats: ReadonlyMap<string, string>, browseSession?: string, autonomousBrowseSession?: string): HomeRecent['kind'] | undefined {
  if (activity.status !== 'success') return
  if (activity.source === 'media.realtime' && activity.kind === 'song.played') return 'song'
  if (activity.source === 'core.session' && activity.kind === 'assistant.completed' && activity.data.interrupted !== true &&
    activity.contextId && activity.sessionId && chats.get(activity.contextId) === activity.sessionId) return 'chat'
  if (activity.contextId === 'game.minecraft' && activity.kind === 'task.succeeded') return minecraftActions.get(activity.source)
  if (activity.source === 'media.bilibili' && activity.kind === 'video.clip-sampled' && activity.contextId === BILIBILI_CONTEXT &&
      activity.sessionId && browseSession === activity.sessionId && (activity.data.visual === true || activity.data.audio === true)) return 'video'
  if (activity.source === 'media.bilibili' && activity.kind === 'video.clip-sampled' && activity.contextId === BILIBILI_CLIP_CONTEXT &&
      activity.taskId && activity.sessionId && (activity.data.visual === true || activity.data.audio === true)) return 'video'
  if (activity.source === 'media.bilibili' && activity.kind === 'video.subtitle-read' && activity.sessionId && (
    activity.contextId === BILIBILI_CONTEXT && browseSession === activity.sessionId ||
    activity.contextId === BILIBILI_AUTONOMY_CONTEXT && autonomousBrowseSession === activity.sessionId && typeof activity.data.candidateId === 'string'
  )) return 'video'
  if (activity.source === 'core.feed' && activity.data.author === 'companion') {
    if (activity.kind === 'post.created') return 'post'
    if (activity.kind === 'post.replied') return 'reply'
  }
}

function videoReceipt(record: ActivityRecord): HomeVideoReceipt {
  const mode = record.kind === 'video.clip-sampled' ? 'clip' : 'subtitle'
  if (record.contextId !== BILIBILI_CONTEXT) return { mode }
  const { bvid, part, start, seconds, visual, audio } = record.data
  const target = typeof bvid === 'string' && typeof part === 'number' ? parseBilibiliTarget(bvid, part) : undefined
  if (!target || target.bvid !== bvid) return { mode }
  if (mode === 'subtitle') return { mode, source: target }
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > 7 * 86_400 ||
      typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_BILIBILI_CLIP_SECONDS ||
      typeof visual !== 'boolean' || typeof audio !== 'boolean') return { mode }
  return { mode, source: { ...target, startSeconds: start, seconds, visual, audio } }
}

export interface HomeActivityInput {
  presence: Presence
  minecraft: boolean
  speaking: boolean
  singing?: boolean
  browsing?: boolean
  bindings: readonly SessionBinding[]
  runningSessions: ReadonlySet<string>
  quiet: boolean
  reflectionAt?: string
}

export function selectHomeActivity(input: HomeActivityInput): HomeView['activity'] {
  if (input.minecraft) return 'minecraft'
  if (input.singing) return 'singing'
  if (input.speaking) return 'speaking'
  if (input.browsing) return 'browsing'
  if (input.bindings.some(binding => isHomeChatBinding(binding) && input.runningSessions.has(binding.sessionId))) return 'chatting'
  if (input.presence === 'unconfigured' || input.presence === 'offline') return 'offline'
  return input.quiet ? 'resting' : 'idle'
}

function homeJournal(activity: HomeView['activity'], now: number, reflectionAt?: string, revisionAt?: string): HomeView['journal'] {
  const started = reflectionAt === undefined ? NaN : Date.parse(reflectionAt)
  if (activity === 'idle' && Number.isFinite(started) && started <= now) return { state: 'reflecting', at: new Date(started).toISOString() }
  const revised = revisionAt === undefined ? NaN : Date.parse(revisionAt)
  if (revised <= now && revised > now - HOME_JOURNAL_REVISION_MS) return { state: 'revised', at: new Date(revised).toISOString() }
}

export function projectHomeStatus(input: HomeActivityInput & { now: Date; journalRevisionAt?: string }): Omit<HomeView, 'recent'> {
  const activity = selectHomeActivity(input)
  const journal = homeJournal(activity, input.now.getTime(), input.reflectionAt, input.journalRevisionAt)
  return { version: 1, activity, anchor: anchors[activity], observedAt: input.now.toISOString(), ...(journal && { journal }) }
}

export function projectHome(input: HomeActivityInput & { now: Date; activities: readonly ActivityRecord[]; journalRevisionAt?: string }): HomeView {
  const { bindings, activities } = input
  const chatBindings = bindings.filter(isHomeChatBinding)
  const chats = new Map(chatBindings.map(binding => [binding.contextId, binding.sessionId]))
  const browseSession = bindings.find(binding => binding.contextId === BILIBILI_CONTEXT && binding.kind === 'topic')?.sessionId
  const autonomousBrowseSession = bindings.find(binding => binding.contextId === BILIBILI_AUTONOMY_CONTEXT && binding.kind === 'system')?.sessionId

  const recent: HomeView['recent'] = []
  for (const record of activities) {
    const kind = recentKind(record, chats, browseSession, autonomousBrowseSession)
    if (!kind) continue
    const time = Date.parse(record.occurredAt)
    if (!Number.isFinite(time)) continue
    recent.push({ kind, at: new Date(time).toISOString(), ...(kind === 'video' && { video: videoReceipt(record) }) })
    if (recent.length === 4) break
  }
  return { ...projectHomeStatus(input), recent }
}
