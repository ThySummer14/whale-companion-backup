import type { BindContextInput, MemoryArchivePreviewEntry, MemoryArchiveResult, MemoryHistoryView, MemoryView, MinecraftCampControl, MinecraftSurveyWindowInput, MinecraftSurveyWindowView, MinecraftView, PersonaHistoryView, SaveMemoryInput, SavePersonaInput, SelfNoteHistoryView, SelfNotesView, ToolPolicyView, WorkbenchView } from '../protocol/api.ts'
import type { CreateSessionInput, SessionLifecycleView } from '../protocol/chat.ts'
import type { BilibiliQueueView, BilibiliReadInput, BilibiliReadResult, BilibiliSubtitleDocument, BilibiliSubtitleUpload } from '../protocol/bilibili.ts'
import type { PresenterView } from '../protocol/presenter.ts'
import { MAX_SINGING_WAV_BYTES, type SingingInput, type SingingScoreInput, type SingingTaskView } from '../protocol/singing.ts'
import type { MinecraftHouseDraft, MinecraftHouseRevisionHistory, MinecraftHouseRevisionInput, MinecraftHousesView, MinecraftHouseSitePreview } from '../core/minecraft-house.ts'
import type { MinecraftHouseProject, MinecraftHouseProjectInput, MinecraftHouseProjectSitePreview, MinecraftHouseProjectsView } from '../core/minecraft-house-project.ts'
import type { MinecraftHouseProjectImportInput, MinecraftHouseProjectImportPreview } from '../core/minecraft-house-project-import.ts'
import type { FeedAuthor, FeedList, FeedPost, FeedThread, MemoryStatus, AutonomySettings, AutonomyView, AvatarView, MediaCleanupPreview, MediaCleanupResult, MediaView, SelfNote, RealtimeVoiceView } from '../core/model.ts'

async function request<T>(path: string, method = 'GET', input?: unknown, base = '/companion/api/', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    signal,
    cache: 'no-store',
    headers: {
      'x-companion-request': '1',
      ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  const value = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw Object.assign(new Error(value.error || `Companion request failed (${response.status})`), { status: response.status })
  return value as T
}

export const getState = () => request<WorkbenchView>('state')
export const savePersona = (input: SavePersonaInput) => request<WorkbenchView>('persona', 'PUT', input)
export const getPersonaHistory = (before?: number) => request<PersonaHistoryView>(`persona/revisions${before === undefined ? '' : `?before=${before}`}`)
export const restorePersona = (version: number, expectedVersion: number) =>
  request<WorkbenchView>(`persona/revisions/${version}/restore`, 'POST', { expectedVersion })
export const bindContext = (input: BindContextInput) => request<WorkbenchView>('bindings', 'PUT', input)
export const createSession = (input: CreateSessionInput) => request<SessionLifecycleView>('sessions', 'POST', input)
export const unbindContext = (contextId: string) => request<WorkbenchView>(`bindings/${encodeURIComponent(contextId)}`, 'DELETE')
export function getMemories(status: MemoryStatus | 'all', query?: string, signal?: AbortSignal): Promise<MemoryView> {
  const params = new URLSearchParams({ status })
  if (query) params.set('q', query)
  return request<MemoryView>(`memories?${params}`, 'GET', undefined, undefined, signal)
}
export const createMemory = (input: SaveMemoryInput) => request<MemoryView['items'][number]>('memories', 'POST', input)
export const updateMemory = (id: string, input: Partial<SaveMemoryInput>) => request<MemoryView['items'][number]>(`memories/${encodeURIComponent(id)}`, 'PATCH', input)
export const memoryAction = (id: string, action: 'forget' | 'restore' | 'archive', reason?: string) => request<MemoryView['items'][number]>(`memories/${encodeURIComponent(id)}/${action}`, 'POST', { reason })
export const maintainMemory = () => request<{ forgotten: number }>('memories/maintain', 'POST', {})
export const previewMemoryArchive = () => request<{ items: MemoryArchivePreviewEntry[] }>('memories/archive-preview')
export const applyMemoryArchive = (entries: readonly Pick<MemoryArchivePreviewEntry, 'id' | 'updatedAt'>[]) => request<MemoryArchiveResult>('memories/archive-stale', 'POST', {
  items: entries.map(({ id, updatedAt }) => ({ id, updatedAt })),
})
export const getMemoryHistory = (id: string) => request<MemoryHistoryView>(`memories/${encodeURIComponent(id)}`)
export const getSelfNotes = (status: 'active' | 'archived' | 'all') => request<SelfNotesView>(`self-notes?status=${status}`)
export const createSelfNote = (content: string) => request<SelfNote>('self-notes', 'POST', { content })
export const updateSelfNote = (id: string, input: Partial<Pick<SelfNote, 'content' | 'confidence' | 'evidence' | 'counterEvidence'>> & { reason?: string }) => request<SelfNote>(`self-notes/${encodeURIComponent(id)}`, 'PATCH', input)
export const getSelfNoteHistory = (id: string, revision?: number) => request<SelfNoteHistoryView>(
  `self-notes/${encodeURIComponent(id)}${revision === undefined ? '' : `?revision=${revision}`}`)
export const selfNoteAction = (id: string, action: 'archive' | 'restore') => request<SelfNote>(`self-notes/${encodeURIComponent(id)}/${action}`, 'POST', { reason: '面板操作' })
export const rollbackSelfNote = (id: string, revision: number) => request<SelfNote>(`self-notes/${encodeURIComponent(id)}/rollback`, 'POST', { revision, reason: '面板回滚' })

export const getMedia = () => request<MediaView>('media')
export const submitSong = (input: SingingInput) => request<SingingTaskView>('singing/tasks', 'POST', input)
export const submitScoreSong = (input: SingingScoreInput) => request<SingingTaskView>('singing/score', 'POST', input)
export const cancelSong = (id: string) => request<SingingTaskView>(`singing/tasks/${encodeURIComponent(id)}/cancel`, 'POST')

export function submitCover(title: string, guide: File, mix?: { accompaniment: File; vocalGainDb: number; backingGainDb: number }): Promise<SingingTaskView> {
  const form = mix && new FormData()
  if (form && mix) {
    form.set('guide', guide)
    form.set('accompaniment', mix.accompaniment)
    form.set('vocalGainDb', String(mix.vocalGainDb))
    form.set('backingGainDb', String(mix.backingGainDb))
  }
  return uploadCover('covers', title, form ?? guide)
}

export const submitSourceCover = (title: string, source: File) => uploadCover('source-covers', title, source)

async function uploadCover(path: 'covers' | 'source-covers', title: string, body: File | FormData): Promise<SingingTaskView> {
  const query = new URLSearchParams({ title })
  const response = await fetch(`/companion/api/singing/${path}?${query}`, {
    method: 'POST', cache: 'no-store', headers: { 'x-companion-request': '1', ...(!(body instanceof FormData) && { 'content-type': 'audio/wav' }) }, body,
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.code || value.error || 'singing-cover-failed')
  return value as SingingTaskView
}

export async function getSongAudio(id: string, expectedBytes: number, signal: AbortSignal): Promise<Blob> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 44 || expectedBytes > MAX_SINGING_WAV_BYTES) {
    throw new Error('singing-audio-unavailable')
  }
  const response = await fetch(`/companion/api/singing/tasks/${encodeURIComponent(id)}/audio`, {
    cache: 'no-store', headers: { 'x-companion-request': '1' }, signal,
  })
  const length = response.headers.get('content-length')
  if (response.status !== 200 || response.headers.get('content-type') !== 'audio/wav' || !response.body ||
    (length !== null && length !== String(expectedBytes))) {
    void response.body?.cancel().catch(() => {})
    throw new Error('singing-audio-unavailable')
  }
  const reader = response.body.getReader()
  const bytes = new Uint8Array(expectedBytes)
  let offset = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > bytes.length) throw new Error('singing-audio-unavailable')
      bytes.set(value, offset)
      offset += value.length
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  if (offset !== expectedBytes) throw new Error('singing-audio-unavailable')
  return new Blob([bytes], { type: 'audio/wav' })
}
export const readBilibili = (input: BilibiliReadInput, signal: AbortSignal) => request<BilibiliReadResult>('bilibili/read', 'POST', input, undefined, signal)
export const addBilibiliCandidate = (input: { video: string; part?: number; label?: string }) => request<BilibiliQueueView>('bilibili/queue', 'POST', input)
export const withdrawBilibiliCandidate = (id: string) => request<BilibiliQueueView>(`bilibili/queue/${encodeURIComponent(id)}`, 'DELETE')
export const addBilibiliSource = (input: { url: string; label?: string }) => request<BilibiliQueueView>('bilibili/sources', 'POST', input)
export const revokeBilibiliSource = (id: string) => request<BilibiliQueueView>(`bilibili/sources/${encodeURIComponent(id)}`, 'DELETE')
export const importBilibiliSubtitle = (input: BilibiliSubtitleUpload) => request<{ items: BilibiliSubtitleDocument[] }>('bilibili/subtitles', 'PUT', input)
export const revokeBilibiliSubtitle = (bvid: string, part: number) => request<{ items: BilibiliSubtitleDocument[] }>(`bilibili/subtitles/${encodeURIComponent(bvid)}/${part}`, 'DELETE')
export const refreshMedia = () => request<MediaView>('media/refresh', 'POST', {})
export const previewMedia = (olderThanDays: number) => request<MediaCleanupPreview>('media/preview', 'POST', { olderThanDays })
export const cleanupMedia = (olderThanDays: number, limit: number) => request<MediaCleanupResult>('media/cleanup', 'POST', { olderThanDays, confirm: true, limit })
export const getToolPolicy = (contextId: string) => request<ToolPolicyView>(`tools?contextId=${encodeURIComponent(contextId)}`)
export const getAvatarState = () => request<AvatarView>('avatar/api', 'GET', undefined, '/companion/')
export async function getPresenterState(signal: AbortSignal): Promise<PresenterView | undefined> {
  try {
    const view = await request<PresenterView>('presenter', 'GET', undefined, undefined, signal)
    return typeof view?.running === 'boolean' ? view : undefined
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) return undefined
    throw error
  }
}
export const setPresenterRunning = (running: boolean, signal: AbortSignal) => request<PresenterView>(`presenter/${running ? 'start' : 'stop'}`, 'POST', {}, undefined, signal)
export const getRealtimeVoice = () => request<RealtimeVoiceView>('avatar/api/realtime', 'GET', undefined, '/companion/')
export const startRealtimeVoice = (contextId: string, messageId?: string, streaming?: boolean) => request<RealtimeVoiceView>('avatar/api/realtime/start', 'POST', { contextId, messageId, streaming }, '/companion/')
export const startRealtimeSong = (taskId: string, stageId: string) => request<RealtimeVoiceView>('avatar/api/realtime/song', 'POST', { taskId, stageId }, '/companion/')
export const cancelRealtimeVoice = (sessionId?: string) => request<RealtimeVoiceView>('avatar/api/realtime/cancel', 'POST', { sessionId }, '/companion/')
export const getMinecraft = () => request<MinecraftView>('minecraft')
export async function getMinecraftSurveyWindow(signal: AbortSignal): Promise<MinecraftSurveyWindowView | undefined> {
  try {
    const view = await request<MinecraftSurveyWindowView>('minecraft/survey-window', 'GET', undefined, undefined, signal)
    return view?.version === 1 ? view : undefined
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) return undefined
    throw error
  }
}
export const saveMinecraftSurveyWindow = (input: MinecraftSurveyWindowInput) => request<MinecraftSurveyWindowView>('minecraft/survey-window', 'PUT', input)
export const revokeMinecraftSurveyWindow = () => request<MinecraftSurveyWindowView>('minecraft/survey-window', 'DELETE')
export async function getMinecraftHouses(signal?: AbortSignal): Promise<MinecraftHousesView | undefined> {
  try {
    const view = await request<MinecraftHousesView>('minecraft/houses', 'GET', undefined, undefined, signal)
    return Array.isArray(view?.drafts) && typeof view.available === 'boolean' ? view : undefined
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) return undefined
    throw error
  }
}
export async function getMinecraftHouseReference(id: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(`/companion/api/minecraft/houses/${encodeURIComponent(id)}/reference`, {
    cache: 'no-store', headers: { 'x-companion-request': '1' }, signal,
  })
  if (!response.ok) throw new Error('minecraft-house-reference-unavailable')
  return response.blob()
}

export const getMinecraftHouseRevisions = (id: string, signal: AbortSignal) =>
  request<MinecraftHouseRevisionHistory>(`minecraft/houses/${encodeURIComponent(id)}/revisions`, 'GET', undefined, undefined, signal)
export const reviseMinecraftHouse = (id: string, input: MinecraftHouseRevisionInput) =>
  request<MinecraftHouseDraft>(`minecraft/houses/${encodeURIComponent(id)}`, 'PATCH', input)
export const previewMinecraftHouse = (id: string, zoneId: string) =>
  request<MinecraftHouseSitePreview>(`minecraft/houses/${encodeURIComponent(id)}/preview`, 'POST', { zoneId })
export const buildMinecraftHouse = (id: string, zoneId: string, previewId: string) =>
  request<MinecraftHouseDraft>(`minecraft/houses/${encodeURIComponent(id)}/build`, 'POST', { zoneId, previewId })
export async function getMinecraftHouseProjects(signal: AbortSignal): Promise<MinecraftHouseProjectsView | undefined> {
  try {
    const view = await request<MinecraftHouseProjectsView>('minecraft/house-projects', 'GET', undefined, undefined, signal)
    return Array.isArray(view?.projects) && typeof view.available === 'boolean' ? view : undefined
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) return undefined
    throw error
  }
}
export const createMinecraftHouseProject = (input: MinecraftHouseProjectInput) =>
  request<MinecraftHouseProject>('minecraft/house-projects', 'POST', input)
export const previewMinecraftHouseProjectImport = (input: MinecraftHouseProjectImportInput) =>
  request<MinecraftHouseProjectImportPreview>('minecraft/house-projects/import-preview', 'POST', input)
export const previewMinecraftHouseProjectSection = (id: string, index: number) =>
  request<MinecraftHouseProjectSitePreview>(`minecraft/house-projects/${encodeURIComponent(id)}/sections/${index}/preview`, 'POST', {})
export const buildMinecraftHouseProjectSection = (id: string, index: number, previewId: string) =>
  request<MinecraftHouseProject>(`minecraft/house-projects/${encodeURIComponent(id)}/sections/${index}/build`, 'POST', { previewId })
export const verifyMinecraftHouseProject = (id: string) =>
  request<MinecraftHouseProject>(`minecraft/house-projects/${encodeURIComponent(id)}/verify`, 'POST', {})
export const nameMinecraftHouseProjectPlace = (id: string, name: string) =>
  request<MinecraftHouseProject>(`minecraft/house-projects/${encodeURIComponent(id)}/place`, 'POST', { name })
export const minecraftAction = (action: string, input?: unknown) => request<unknown>(`minecraft/${action}`, 'POST', input ?? {})
export const setPairedCampPause = (pairedPauseEnabled: boolean) => request<MinecraftCampControl>('minecraft/camp-control', 'PUT', { pairedPauseEnabled })
export const resumeMinecraftCamp = () => request<MinecraftCampControl>('minecraft/camp-resume', 'POST', {})
export const createMinecraftZone = (input: { name: string; dimension: string; x: number; y: number; z: number; radius: number }) => request<unknown>('minecraft/zones', 'POST', input)
export const revokeMinecraftZone = (id: string) => request<unknown>(`minecraft/zones/${encodeURIComponent(id)}`, 'DELETE')
export const minecraftAsk = (text: string) => request<{ id: string }>('minecraft/ask', 'POST', { text })

export const getFeed = () => request<FeedList>('feed')
export const createFeedPost = (body: string) => request<FeedPost>('feed', 'POST', { body, author: 'user' })
export const getFeedThread = (id: string) => request<FeedThread>(`feed/${encodeURIComponent(id)}`)
export const replyFeedPost = (id: string, body: string) => request<FeedPost>(`feed/${encodeURIComponent(id)}/replies`, 'POST', { body })
export const deleteFeedPost = (id: string, author: FeedAuthor) => request<FeedPost>(`feed/${encodeURIComponent(id)}`, 'DELETE', { author })
export const updateAutonomy = (input: Partial<AutonomySettings>) => request<AutonomyView>('autonomy', 'PUT', input)
export const enqueueAutonomy = (kind: 'memory.review' | 'feed.review', contextId?: string) => request<AutonomyView>('autonomy/jobs', 'POST', { kind, contextId })
