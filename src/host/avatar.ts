import { existsSync, readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AvatarAction, AvatarPresentation, AvatarView } from '../core/model.ts'
import type { CompanionStore } from '../core/store.ts'
import type { PresenterSnapshot } from '../protocol/presenter.ts'

const STAGE_HEARTBEAT_MS = 5000
const MAX_STAGES = 8
const ACTION_START_MS = 8000
const ACTION_END_GRACE_MS = 5000
const ACTION_CLOCK_TOLERANCE_MS = 250
const PRESENTER_SAMPLE_MS = 1500

interface StageAction {
  taskId: string
  action: AvatarAction
  stageId?: string
  deadline: number
  started?: { at: number; frames: number }
  stopRequested: boolean
}

export class AvatarService {
  private available = false
  private detail = '尚未检查私有 Live2D 素材'
  private model?: AvatarView['model']
  private presentation?: AvatarPresentation
  private readonly songStages = new Map<string, number>()
  private readonly actionStages = new Map<string, number>()
  private active?: StageAction
  private actionTimer?: NodeJS.Timeout
  private actionList: AvatarAction[] = []
  private closed = false

  constructor(readonly store: CompanionStore, readonly root: string, readonly stageRoot: string) {
    if (!isAbsolute(root) || !isAbsolute(stageRoot)) throw new Error('Avatar asset paths must be absolute')
  }

  start(): void {
    for (const task of this.store.tasks().filter(task => task.capabilityId === 'media.avatar' && ['accepted', 'running'].includes(task.status))) {
      this.store.transitionTask(task.id, 'cancelled', '形象服务重启，旧动作无法继续核验')
    }
    const required = ['model/大肥鱼.model3.json', 'model/大肥鱼.moc3', 'model/大肥鱼.physics3.json', 'model/Exp3/脸红.exp3.json', 'model/Animation/竖手指切出来动画.motion3.json', 'data/model-profile.json', 'vendor/live2dcubismcore.min.js']
    this.available = required.every(path => existsSync(join(this.root, path))) && existsSync(join(this.stageRoot, 'index.html'))
    this.detail = this.available ? '私有模型与 Core 已就绪，等待真实舞台心跳' : '私有模型、动作配置或官方 Core 尚未配置'
    try {
      if (this.available) {
        const profile = JSON.parse(readFileSync(join(this.root, 'data/model-profile.json'), 'utf8')) as { model?: string; counts?: Record<string, unknown> }
        this.model = { name: typeof profile.model === 'string' ? profile.model : 'DeepSeek-chan · 大肥鱼', counts: Object.fromEntries(Object.entries(profile.counts ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)) as [string, number][]) }
        this.actions()
      }
      this.store.updateCapability('media.avatar', 'planned', this.detail)
    } catch {
      this.available = false
      this.model = undefined
      this.detail = '私有形象配置无法读取，文字聊天与其他能力不受影响'
      this.store.updateCapability('media.avatar', 'error', this.detail)
    }
  }

  view(): AvatarView {
    this.expireAction()
    const presentation = this.presentation && Date.now() - Date.parse(this.presentation.updatedAt) < STAGE_HEARTBEAT_MS ? this.presentation : undefined
    const actions = this.available ? this.actions() : []
    const active = this.active
    return {
      available: this.available,
      detail: presentation?.ready ? '真实 Live2D 舞台在线' : this.detail,
      model: this.model,
      actions,
      presentation,
      pendingActions: active && !active.started ? [{ taskId: active.taskId, action: active.action }] : [],
      stopRequestIds: active?.stopRequested ? [active.taskId] : [],
      tasks: this.store.tasks().filter(task => task.capabilityId === 'media.avatar').slice(0, 5),
      credits: '原画及拆分：神宫凉子 · Live2D 建模：霓虹猫_NeonNeko',
      diagnostics: { root: this.root, stageRoot: this.stageRoot },
    }
  }

  private actions(): AvatarAction[] {
    if (this.actionList.length) return this.actionList
    const motion = JSON.parse(readFileSync(join(this.root, 'model/Animation/竖手指切出来动画.motion3.json'), 'utf8')) as { Meta?: { Duration?: number } }
    const duration = Number(motion.Meta?.Duration)
    if (!Number.isFinite(duration) || duration < 0.2 || duration > 60) throw new Error('Invalid avatar motion duration')
    this.actionList = [
      { id: 'blush', label: '脸红', duration: 2.4 }, { id: 'point', label: '抬手示意', duration },
      { id: 'nod', label: '点头', duration: 1.2 }, { id: 'shake', label: '摇头', duration: 1.2 },
    ]
    return this.actionList
  }

  heartbeat(input: Omit<AvatarPresentation, 'updatedAt'>): AvatarView {
    if (this.closed) throw new Error('Avatar service is stopping')
    const previous = this.presentation
    const now = Date.now()
    this.expireAction(now)
    const rendered = input.ready && input.frames > 0 && input.nonFinite === 0
    const songReady = input.songReady === true && !!input.stageId && rendered && input.voice?.audioContextState === 'running'
    if (input.stageId) {
      for (const [stages, ready] of [[this.songStages, songReady], [this.actionStages, rendered && input.actionReady !== false]] as const) {
        stages.delete(input.stageId)
        if (ready) stages.set(input.stageId, now + STAGE_HEARTBEAT_MS)
        if (stages.size > MAX_STAGES) stages.delete(stages.keys().next().value!)
      }
    }
    this.presentation = { ...input, ...(input.songReady !== undefined && { songReady }), updatedAt: new Date(now).toISOString() }
    if (input.nonFinite > 0 && (previous?.nonFinite ?? 0) === 0) this.store.updateCapability('media.avatar', 'error', '舞台出现非有限模型参数，请停止动作并检查运行时')
    else if (input.ready && !previous?.ready) this.store.updateCapability('media.avatar', 'ready', '网页 Live2D 已收到真实渲染心跳')
    const view = this.view()
    return this.active?.stageId === input.stageId ? view : { ...view, pendingActions: [], stopRequestIds: [] }
  }

  songStage(stageId?: string, now = Date.now()): string | undefined {
    if (stageId) return (this.songStages.get(stageId) ?? 0) > now ? stageId : undefined
    return [...this.songStages].findLast(([, expiresAt]) => expiresAt > now)?.[0]
  }

  private stageLive(stageId: string | undefined, now: number, maxAge = STAGE_HEARTBEAT_MS): boolean {
    if (stageId) return (this.actionStages.get(stageId) ?? 0) > now + STAGE_HEARTBEAT_MS - maxAge
    const stage = this.presentation
    return !!stage && !stage.stageId && stage.ready && stage.actionReady !== false && stage.frames > 0 && stage.nonFinite === 0 && now - Date.parse(stage.updatedAt) < maxAge
  }

  presenterFrame(now: number, playbackConfirmed: boolean): Omit<PresenterSnapshot, 'activity'> {
    const available = this.available && !this.closed
    if (!available) return { available }
    const frame: Omit<PresenterSnapshot, 'activity'> = { available }
    const stage = this.presentation
    if (playbackConfirmed && this.presenterStageReady(now) && stage?.voice?.playing && stage.voice.audioContextState === 'running') {
      frame.voiceEnergy = stage.voice.energy
    }
    const active = this.active
    if (active?.started && !active.stopRequested && this.stageLive(active.stageId, now, PRESENTER_SAMPLE_MS)) {
      const elapsedMs = now - active.started.at
      if (elapsedMs >= 0 && elapsedMs < active.action.duration * 1000) frame.action = { id: active.action.id, startedAt: active.started.at, elapsedMs }
    }
    return frame
  }

  presenterStageReady(now: number): boolean {
    const stage = this.presentation
    if (!stage?.ready || !stage.frames || stage.nonFinite !== 0 || stage.actionReady === false) return false
    const age = now - Date.parse(stage.updatedAt)
    return age >= 0 && age < PRESENTER_SAMPLE_MS
  }

  startAction(actionId: AvatarAction['id'], stageId?: string): { taskId: string; action: AvatarAction } {
    const now = Date.now()
    this.expireAction(now)
    if (!this.available) throw new Error('Avatar assets are not ready')
    if (this.active) throw new Error('Another avatar action is already active')
    const action = this.actions().find(item => item.id === actionId)
    if (!action) throw new Error('Unsupported avatar action')
    const target = stageId ?? [...this.actionStages].findLast(([, expiresAt]) => expiresAt > now)?.[0]
    if (!this.stageLive(target, now) || !target && (actionId === 'nod' || actionId === 'shake')) throw new Error('Avatar stage is not live')
    const task = this.store.createTask({ capabilityId: 'media.avatar', contextId: 'avatar.stage', title: `Live2D：${action.label}` }, created => {
      this.store.recordActivity({ taskId: created.id, contextId: 'avatar.stage', source: 'media.avatar', kind: 'avatar.action.accepted', summary: `已接收动作：${action.label}`, data: { action: action.id } })
    })
    this.active = { taskId: task.id, action, stageId: target, deadline: now + ACTION_START_MS, stopRequested: false }
    this.actionTimer = setInterval(() => { try { this.expireAction() } catch { /* Retry after a transient store failure. */ } }, 1000)
    this.actionTimer.unref()
    return { taskId: task.id, action }
  }

  receipt(input: { taskId: string; stageId?: string; status: 'playing' | 'completed' | 'cancelled' | 'error'; frames: number; error?: string }): AvatarView {
    const now = Date.now()
    this.expireAction(now)
    const active = this.active
    if (!active || active.taskId !== input.taskId || active.stageId !== input.stageId) throw new Error('Avatar action is not active for this stage')
    const status = input.status === 'completed' && active.stopRequested ? 'cancelled' : input.status
    if (status === 'playing') {
      if (active.started || active.stopRequested || input.frames <= 0) throw new Error('Avatar action cannot start from its current state')
    } else if (status === 'completed') {
      if (!active.started || input.frames <= active.started.frames || now - active.started.at < active.action.duration * 1000 - ACTION_CLOCK_TOLERANCE_MS) {
        throw new Error('Avatar action has not finished rendering')
      }
    }
    const error = status === 'error' ? input.error ?? '舞台未完成动作' : input.error
    const state = status === 'playing' ? 'running' : status === 'completed' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed'
    this.store.transitionTask(active.taskId, state, error, () => {
      this.store.recordActivity({ taskId: active.taskId, contextId: 'avatar.stage', source: 'media.avatar', kind: `avatar.action.${status}`, summary: `舞台回执：${active.action.label} · ${status}`, status: status === 'error' ? 'error' : status === 'cancelled' ? 'warning' : status === 'completed' ? 'success' : 'info', data: { action: active.action.id, frames: input.frames } })
    })
    if (status === 'playing') {
      active.started = { at: now, frames: input.frames }
      active.deadline = now + active.action.duration * 1000 + ACTION_END_GRACE_MS
    } else this.clearAction()
    return this.view()
  }

  stop(taskId?: string): AvatarView {
    this.expireAction()
    const active = this.active
    if (active && !active.stopRequested && (!taskId || taskId === active.taskId)) {
      this.store.recordActivity({ taskId: active.taskId, contextId: 'avatar.stage', source: 'media.avatar', kind: 'avatar.action.stop-requested', summary: '已请求舞台停止动作，等待真实停止回执', status: 'info' })
      active.stopRequested = true
      active.deadline = Math.min(active.deadline, Date.now() + STAGE_HEARTBEAT_MS)
    }
    return this.view()
  }

  private expireAction(now = Date.now()): void {
    const active = this.active
    if (!active || (active.deadline > now && this.stageLive(active.stageId, now))) return
    this.store.transitionTask(active.taskId, 'cancelled', '舞台心跳或动作回执超时')
    this.clearAction()
  }

  private clearAction(): void {
    this.active = undefined
    if (this.actionTimer) clearInterval(this.actionTimer)
    this.actionTimer = undefined
  }

  async asset(kind: 'core' | 'profile' | 'model', path = ''): Promise<{ path: string; bytes: number } | undefined> {
    const directory = kind === 'core' ? join(this.root, 'vendor') : kind === 'profile' ? join(this.root, 'data') : join(this.root, 'model')
    const name = kind === 'core' ? 'live2dcubismcore.min.js' : kind === 'profile' ? 'model-profile.json' : path
    if (name.includes('\0')) return undefined
    const candidate = resolve(directory, name)
    if (relative(directory, candidate).startsWith(`..${sep}`) || isAbsolute(relative(directory, candidate))) return undefined
    try {
      const root = await realpath(directory)
      const file = await realpath(candidate)
      const relativePath = relative(root, file)
      if (relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined
      if (kind === 'model' && !/\.(json|moc3|png|txt)$/iu.test(file)) return undefined
      const info = await stat(file)
      return info.isFile() ? { path: file, bytes: info.size } : undefined
    } catch { return undefined }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.active) this.store.transitionTask(this.active.taskId, 'cancelled', '形象服务停止')
    this.clearAction()
    this.actionStages.clear()
    this.songStages.clear()
    this.presentation = undefined
    this.store.updateCapability('media.avatar', 'planned', '形象服务已停止')
  }
}
