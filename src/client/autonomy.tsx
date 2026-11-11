import { useEffect, useRef, useState } from 'react'
import { DailyInitiativeRecord, DailyInitiativeSelectionReceipt } from '../core/daily-initiative.ts'
import { HouseRecoveryAgentDecision } from '../core/minecraft-recovery.ts'
import { CONTEXT_COMPACTION_CAPABILITY, IDLE_COMPACTION_MINUTES, IDLE_COMPACTION_PERCENT, type AutonomousJob, type AutonomousJobKind, type AutonomySettings, type MemoryRecord, type SelfNote, type TaskStatus } from '../core/model.ts'
import type { WorkbenchView } from '../protocol/api.ts'
import { enqueueAutonomy, getMemoryHistory, getSelfNoteHistory, updateAutonomy } from './api.ts'
import { MinecraftRecoveryOutcome } from './minecraft-recovery.tsx'
import { SELF_NOTE_BASIS_LABELS, SelfNoteEvidence } from './self-notes.tsx'
import { ToolPolicyPanel } from './tools.tsx'

const TASK: Record<TaskStatus, string> = { accepted: '已接收', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const JOB: Record<AutonomousJobKind, string> = {
  'memory.review': '记忆整理',
  'feed.review': '自主动态',
  'feed.reply': '动态回应',
  'minecraft.event': 'Minecraft 互动',
  'minecraft.share': 'Minecraft 经历分享',
  'minecraft.supply': 'Minecraft 授权补给',
  'minecraft.recovery': 'Minecraft 施工恢复评估',
  'bilibili.review': 'B 站自主浏览评估',
  'bilibili.reflect': 'B 站阅读反思',
  'bilibili.share': 'B 站阅读分享',
  'daily.choice': '每日活动选择',
  'daily.reflect': '自主经历复盘',
}

function time(value: string | number | undefined): string {
  if (value === undefined) return '尚未执行'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function MinecraftRecoveryJobOutcome({ job }: { job: AutonomousJob }) {
  if (job.kind !== 'minecraft.recovery' || job.task.status !== 'succeeded') return null
  const { plan, observation, placed, placements, verification } = job.payload
  const observed = observation && typeof observation === 'object' && 'state' in observation ? observation.state : undefined
  const decision = HouseRecoveryAgentDecision.safeParse({ plan, observed, placed, placements, verification, at: job.task.updatedAt }).data
  return decision ? <MinecraftRecoveryOutcome decision={decision} /> : null
}

const INITIATIVE_BASIS = { current: '现场观察', experience: '已核验经历', 'self-note': '自我观察' }

function DailyInitiativeOutcome({ job, openNote, openingNote }: { job: AutonomousJob;
  openNote: (id: string, trigger: HTMLButtonElement, revision?: number) => Promise<void>; openingNote: boolean }) {
  const initiative = DailyInitiativeRecord.safeParse(job.payload.initiative).data
  if (!initiative) return null
  const selection = DailyInitiativeSelectionReceipt.safeParse(job.payload.initiativeReceipt).data
  const selfNote = selection?.selfNote
  const result = initiative.option === 'abandon' ? '已主动放下' : initiative.option === 'defer' ? '留待以后'
    : job.task.status === 'succeeded' ? '已取得行动回执'
      : job.task.status === 'failed' || job.task.status === 'cancelled'
        ? job.payload.initiativeAttempt ? '行动未确认，保留目标供以后评估' : '未取得完成回执'
        : '等待行动回执'
  return <div style={{ overflowWrap: 'anywhere' }}>
    <p><strong>{initiative.option === 'abandon' ? '她放下的目标' : initiative.previous ? '她接续的目标' : '她提出的目标'}</strong> {initiative.goal}</p>
    {initiative.previous && initiative.previous.goal !== initiative.goal && <p className="cp-hint">原先想做 · {initiative.previous.goal}</p>}
    {selection && <p><strong>本轮所选动作</strong> {selection.optionLabel}</p>}
    {'evidence' in initiative && <p className="cp-hint">{INITIATIVE_BASIS[initiative.evidence.kind]} · {initiative.evidence.text}</p>}
    {selfNote && <button className="cp-button" type="button" disabled={openingNote}
      onClick={event => void openNote(selfNote.noteId, event.currentTarget, selfNote.revision)}>查看行动依据 · 自我观察第 {selfNote.revision} 版</button>}
    <p><strong>实际结果</strong> {result}</p>
  </div>
}

export function AutonomyPage({ data, reload, notify }: { data: WorkbenchView; reload: () => Promise<void>; notify: (error: unknown) => void }) {
  const [draft, setDraft] = useState<AutonomySettings>(data.autonomy.settings)
  const [busy, setBusy] = useState(false)
  const [bilibiliIntervalInput, setBilibiliIntervalInput] = useState<string>()
  const [reflection, setReflection] = useState<MemoryRecord>()
  const [dailyNote, setDailyNote] = useState<SelfNote>()
  const [dailyNoteRevision, setDailyNoteRevision] = useState<number>()
  const [openingNote, setOpeningNote] = useState(false)
  const dailyNoteTitle = useRef<HTMLHeadingElement>(null)
  const dailyNoteTrigger = useRef<HTMLButtonElement>()
  const dirty = useRef(false)
  useEffect(() => { if (!dirty.current) setDraft(data.autonomy.settings) }, [data.autonomy.settings])
  useEffect(() => { if (dailyNote) dailyNoteTitle.current?.focus() }, [dailyNote])
  const save = async (next: AutonomySettings, patch: Partial<AutonomySettings> = next) => {
    setBusy(true)
    setDraft(next)
    try {
      const result = await updateAutonomy(patch)
      setDraft(result.settings)
      await reload()
      return true
    } catch (error) {
      setDraft(data.autonomy.settings)
      notify(error)
      return false
    }
    finally { setBusy(false) }
  }
  const enqueue = async () => {
    setBusy(true)
    try {
      await enqueueAutonomy('memory.review', 'chat.mobile')
      await reload()
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const openReflection = async (id: string) => {
    try { setReflection((await getMemoryHistory(id)).memory) }
    catch (error) { notify(error) }
  }
  const openDailyNote = async (id: string, trigger: HTMLButtonElement, revision?: number) => {
    dailyNoteTrigger.current = trigger
    setOpeningNote(true)
    try {
      const history = await getSelfNoteHistory(id, revision)
      const note = revision === undefined ? history.note : history.revisions.find(item => item.revision === revision)?.snapshot
      if (!note) throw new Error('未找到行动时的自我观察版本')
      setDailyNoteRevision(revision)
      setDailyNote(note)
    }
    catch (error) { notify(error) }
    finally { setOpeningNote(false) }
  }
  const canReflect = draft.enabled && draft.memoryReview
  const canAuthorizeContinuousRecovery = draft.enabled && draft.minecraftRecoveryEnabled && draft.minecraftRecoveryPlacementEnabled
  const bilibiliInterval = draft.bilibiliIntervalMinutes ?? 240
  const bilibiliIntervalValue = bilibiliIntervalInput ?? String(bilibiliInterval)
  const parsedBilibiliInterval = Number(bilibiliIntervalValue)
  const validBilibiliInterval = Number.isInteger(parsedBilibiliInterval) && parsedBilibiliInterval >= 30 && parsedBilibiliInterval <= 1440
  const saveBilibiliInterval = async () => {
    if (!validBilibiliInterval || busy || parsedBilibiliInterval === bilibiliInterval) return
    const patch = { bilibiliIntervalMinutes: parsedBilibiliInterval }
    if (await save({ ...draft, ...patch }, patch)) setBilibiliIntervalInput(undefined)
  }
  const maintenance = data.tasks.filter(task => task.capabilityId === CONTEXT_COMPACTION_CAPABILITY).slice(0, 4)
  const lastCompaction = data.activities.find(item => item.source === CONTEXT_COMPACTION_CAPABILITY && item.kind === 'session.compaction.completed')
  return <>
    <div className="cp-grid">
      <section className="cp-card"><div className="cp-label">等待中的自主任务</div><div className="cp-metric">{data.autonomy.pending}</div><div className="cp-label">正在执行 {data.autonomy.running} 个</div></section>
      <section className="cp-card"><div className="cp-label">内核心跳</div><p>{time(data.autonomy.lastTickAt)}</p><div className="cp-label">不是定时刷消息</div></section>
      <section className="cp-card"><div className="cp-label">最近决策</div><p>{data.autonomy.lastDecision ?? '尚无自主决策'}</p>{data.autonomy.lastError && <div className="cp-error">{data.autonomy.lastError}</div>}</section>
    </div>
    <section className="cp-card">
      <div className="cp-row cp-between"><h2>自主节律</h2><span className="cp-label">设置保存在 Mac mini，重启后保留</span></div>
      <div className="cp-stack">
        <label className="cp-row"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => void save({ ...draft, enabled: event.target.checked })} />允许后台自主任务</label>
        <label className="cp-row"><input type="checkbox" checked={draft.memoryReview} disabled={busy} onChange={event => void save({ ...draft, memoryReview: event.target.checked })} />聊天结束后异步整理候选记忆</label>
        <label className="cp-row"><input type="checkbox" checked={draft.feedRepliesEnabled} disabled={busy} onChange={event => void save({ ...draft, feedRepliesEnabled: event.target.checked })} />用户发帖或评论后，允许角色评估回应</label>
        <label className="cp-row"><input type="checkbox" checked={draft.feedEnabled} disabled={busy} onChange={event => void save({ ...draft, feedEnabled: event.target.checked })} />允许角色评估并发布自主动态（默认关闭）</label>
        <label className="cp-row"><input type="checkbox" checked={draft.minecraftShareEnabled} disabled={busy || !draft.feedEnabled} onChange={event => void save({ ...draft, minecraftShareEnabled: event.target.checked })} />让角色决定是否分享有真实回执的 Minecraft 经历</label>
        {typeof draft.minecraftShareImagesEnabled === 'boolean' && <label className="cp-row"><input type="checkbox" checked={draft.minecraftShareImagesEnabled} disabled={busy || !draft.feedEnabled || !draft.minecraftShareEnabled} onChange={event => void save({ ...draft, minecraftShareImagesEnabled: event.target.checked }, { minecraftShareImagesEnabled: event.target.checked })} />允许角色为已确认的勘察动态附一张路线图</label>}
        {typeof draft.minecraftMilestonesEnabled === 'boolean' && <div className="cp-field">
          <label className="cp-row"><input type="checkbox" checked={draft.minecraftMilestonesEnabled} disabled={busy} onChange={event => {
            const patch = { minecraftMilestonesEnabled: event.target.checked }
            void save({ ...draft, ...patch }, patch)
          }} />允许已验收的营地项目和小屋作为自主经历来源（默认关闭）</label>
          <span className="cp-hint cp-small">写自我笔记仍需开启自主经历复盘。发布动态仍需开启自主动态与 Minecraft 经历分享。</span>
        </div>}
        {typeof draft.minecraftRecoveryEnabled === 'boolean' && <div className="cp-field">
          <label className="cp-row"><input type="checkbox" checked={draft.minecraftRecoveryEnabled}
            disabled={busy || !draft.enabled && !draft.minecraftRecoveryEnabled} onChange={event => {
              const patch = { minecraftRecoveryEnabled: event.target.checked }
              void save({ ...draft, ...patch }, patch)
            }} />允许大肥鱼判断小屋施工中断后的下一步（默认关闭）</label>
          <span className="cp-hint cp-small">她可以查看现场，决定是否记录后续计划。开工仍沿用主人确认。</span>
          {!draft.enabled && <span className="cp-hint cp-small">后台自主任务已暂停。</span>}
        </div>}
        {typeof draft.minecraftRecoveryPlacementEnabled === 'boolean' && <div className="cp-field">
          <label className="cp-row"><input type="checkbox" checked={draft.minecraftRecoveryPlacementEnabled}
            disabled={busy || (!draft.enabled || !draft.minecraftRecoveryEnabled) && !draft.minecraftRecoveryPlacementEnabled} onChange={event => {
              const patch = { minecraftRecoveryPlacementEnabled: event.target.checked }
              void save({ ...draft, ...patch }, patch)
            }} />允许大肥鱼在已确认施工的中断小屋中放一块蓝图方块（默认关闭）</label>
          <span className="cp-hint cp-small">单格授权下，每次中断最多成功放置一块。她自己选格，游戏端重新核对材料、权限和安全。关闭可中止尚未完成的操作。</span>
        </div>}
        {typeof draft.minecraftRecoveryContinuousEnabled === 'boolean' && <div className="cp-field">
          <label className="cp-row"><input type="checkbox" checked={draft.minecraftRecoveryContinuousEnabled}
            disabled={busy || !canAuthorizeContinuousRecovery && !draft.minecraftRecoveryContinuousEnabled} onChange={event => {
              const patch = { minecraftRecoveryContinuousEnabled: event.target.checked }
              void save({ ...draft, ...patch }, patch)
            }} />允许大肥鱼在同一次施工恢复中连续放置（默认关闭）</label>
          <span className="cp-hint cp-small">需先开启后台任务、施工恢复和单格放置。每次中断最多放置三块，最多尝试六个不同格。她可以根据每次回执继续、改选或停下。</span>
          {!canAuthorizeContinuousRecovery && draft.minecraftRecoveryContinuousEnabled && <span className="cp-hint cp-small">连续放置已暂停，仍可撤回这项授权。</span>}
        </div>}
        <div className="cp-field"><label className="cp-label" htmlFor="cp-review-delay">记忆整理延迟（30～600 秒）</label><input id="cp-review-delay" className="cp-input" type="number" min={30} max={600} value={draft.reviewDelaySec} disabled={busy} onChange={event => { dirty.current = true; setDraft({ ...draft, reviewDelaySec: Number(event.target.value) }) }} onBlur={() => { dirty.current = false; void save(draft) }} /></div>
        <div className="cp-row">
          <div className="cp-field"><label className="cp-label" htmlFor="cp-reply-delay">动态回应延迟（5～120 秒）</label><input id="cp-reply-delay" className="cp-input" type="number" min={5} max={120} value={draft.replyDelaySec} disabled={busy} onChange={event => { dirty.current = true; setDraft({ ...draft, replyDelaySec: Number(event.target.value) }) }} onBlur={() => { dirty.current = false; void save(draft) }} /></div>
          <div className="cp-field"><label className="cp-label" htmlFor="cp-reply-cooldown">同线程回应冷却（30～3600 秒）</label><input id="cp-reply-cooldown" className="cp-input" type="number" min={30} max={3600} value={draft.replyCooldownSec} disabled={busy} onChange={event => { dirty.current = true; setDraft({ ...draft, replyCooldownSec: Number(event.target.value) }) }} onBlur={() => { dirty.current = false; void save(draft) }} /></div>
        </div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-feed-interval">自主动态最小间隔（分钟）</label><input id="cp-feed-interval" className="cp-input" type="number" min={60} max={1440} value={draft.feedIntervalMinutes} disabled={busy} onChange={event => { dirty.current = true; setDraft({ ...draft, feedIntervalMinutes: Number(event.target.value) }) }} onBlur={() => { dirty.current = false; void save(draft) }} /></div>
        <div className="cp-row">
          <div className="cp-field"><label className="cp-label" htmlFor="cp-quiet-start">免打扰开始</label><input id="cp-quiet-start" className="cp-input" type="time" value={draft.quietStart} disabled={busy} onChange={event => { dirty.current = true; setDraft({ ...draft, quietStart: event.target.value }) }} onBlur={() => { dirty.current = false; void save(draft) }} /></div>
          <div className="cp-field"><label className="cp-label" htmlFor="cp-quiet-end">免打扰结束</label><input id="cp-quiet-end" className="cp-input" type="time" value={draft.quietEnd} disabled={busy} onChange={event => { dirty.current = true; setDraft({ ...draft, quietEnd: event.target.value }) }} onBlur={() => { dirty.current = false; void save(draft) }} /></div>
        </div>
      </div>
      <p className="cp-hint cp-small">回应用户互动与主动发帖是两个开关。角色可以沉默；回应按线程排队，受冷却与免打扰约束。暂停不会删除已有记忆，正在执行的轮次会记录真实结果。</p>
      <div className="cp-actions"><button className="cp-button" disabled={busy} onClick={() => void enqueue()}>整理主聊天记忆</button></div>
      <p className="cp-hint cp-small">点击只表示加入队列，实际完成以任务状态和真实 Agent 输出为准。</p>
    </section>
    {typeof draft.dailyReflectionEnabled === 'boolean' && <section className="cp-card" aria-label="自主经历复盘">
      <h2>自主经历复盘</h2>
      <label className="cp-row"><input type="checkbox" checked={draft.dailyReflectionEnabled} disabled={busy || !canReflect && !draft.dailyReflectionEnabled} onChange={event => {
        const patch = { dailyReflectionEnabled: event.target.checked }
        void save({ ...draft, ...patch }, patch)
      }} />允许她在空闲时复盘已确认的自主经历（默认关闭）</label>
      <p className="cp-hint">她可以从已确认的营地勘察或字幕阅读回执出发，自行决定跳过、写一条自我观察或接续旧笔记。笔记可在「记忆」页查看。</p>
      {!canReflect && <p className="cp-hint">{draft.dailyReflectionEnabled ? '复盘已暂停，启用后台任务和记忆整理后恢复。' : '启用后台任务和记忆整理后可开启。'}</p>}
    </section>}
    {typeof draft.dailyInitiativeEnabled === 'boolean' && <section className="cp-card" aria-label="自主提出小目标">
      <h2>自主提出小目标</h2>
      <label className="cp-row"><input type="checkbox" checked={draft.dailyInitiativeEnabled}
        disabled={busy || !draft.enabled && !draft.dailyInitiativeEnabled} onChange={event => {
          const patch = { dailyInitiativeEnabled: event.target.checked }
          void save({ ...draft, ...patch }, patch)
        }} />允许她在空闲时自己提出小目标（默认关闭）</label>
      <p className="cp-hint">在已授权的每日活动时段，她可以参考当前观察与已核验的经历，提出一个自己的目标、决定行动或留待以后。目标与行动回执分别显示。</p>
      {!draft.enabled && <p className="cp-hint">{draft.dailyInitiativeEnabled ? '后台已暂停，仍可撤回这项授权。' : '启用后台任务后可开启。'}</p>}
    </section>}
    <section className="cp-card">
      <div className="cp-row cp-between"><h2>闲置会话压缩</h2><span className="cp-label">使用 DSH 原生压缩</span></div>
      <label className="cp-row"><input type="checkbox" checked={draft.idleCompactionEnabled ?? false} disabled={busy || !draft.enabled || !draft.memoryReview} onChange={event => {
        const patch = { idleCompactionEnabled: event.target.checked }
        void save({ ...draft, ...patch }, patch)
      }} />允许后台压缩（默认关闭）</label>
      <p className="cp-hint">各场景空闲满 {IDLE_COMPACTION_MINUTES} 分钟、最近一次模型输入达到窗口的 {IDLE_COMPACTION_PERCENT}% 且记忆整理已完成时才检查。新消息会取消当前压缩，历史原文仍可查看。</p>
      {(!draft.enabled || !draft.memoryReview) && <p className="cp-hint">启用后台任务和记忆整理后可开启。</p>}
      {lastCompaction && <p className="cp-hint">最近完成 {time(lastCompaction.occurredAt)} · {lastCompaction.contextId}{typeof lastCompaction.data.shadowedTokenCount === 'number' && ` · 被替换范围约 ${lastCompaction.data.shadowedTokenCount.toLocaleString('zh-CN')} Token`}</p>}
      {maintenance.map(task => <div className="cp-row cp-between" key={task.id}>
        <div><span>{task.contextId} · {time(task.updatedAt)}</span>{task.error && <div className="cp-hint">{task.error}</div>}</div>
        <span className="cp-status" data-state={task.status}>{TASK[task.status]}</span>
      </div>)}
    </section>
    {data.bilibiliQueue && <section className="cp-card">
      <h2>B 站自主浏览</h2>
      <div className="cp-stack">
        <label className="cp-row"><input type="checkbox" checked={draft.bilibiliEnabled ?? false} disabled={busy} onChange={event => {
          const patch = { bilibiliEnabled: event.target.checked }
          void save({ ...draft, ...patch }, patch)
        }} />允许 B 站自主浏览（默认关闭）</label>
        {typeof draft.bilibiliClipsEnabled === 'boolean' && <label className="cp-row">
          <input type="checkbox" checked={draft.bilibiliClipsEnabled} disabled={busy || !draft.enabled || !draft.bilibiliEnabled} onChange={event => {
            const patch = { bilibiliClipsEnabled: event.target.checked }
            void save({ ...draft, ...patch }, patch)
          }} />允许她从已授权候选中自己选 8 秒以内的画面或声音（默认关闭）
        </label>}
        {draft.bilibiliClipsEnabled && <p className="cp-hint">每 24 小时最多尝试一次，优先让出前台。原始画面和转写保留在宿主。
          {data.bilibiliQueue.nextClipAt && <> 下次可尝试时间 {time(data.bilibiliQueue.nextClipAt)}。</>}</p>}
        <label className="cp-row"><input type="checkbox" checked={draft.bilibiliReflectionEnabled ?? false} disabled={busy || !draft.bilibiliEnabled} onChange={event => {
          const patch = { bilibiliReflectionEnabled: event.target.checked }
          void save({ ...draft, ...patch }, patch)
        }} />允许基于实际字幕片段整理私人阅读反思（默认关闭）</label>
        {typeof draft.bilibiliShareEnabled === 'boolean' && <label className="cp-row">
          <input type="checkbox" checked={draft.bilibiliShareEnabled} disabled={busy || !draft.enabled || !draft.feedEnabled || !draft.bilibiliEnabled}
            onChange={event => {
              const patch = { bilibiliShareEnabled: event.target.checked }
              void save({ ...draft, ...patch }, patch)
            }} />允许角色分享有出处的阅读感受到私有动态（默认关闭）
        </label>}
        {typeof draft.bilibiliClipShareEnabled === 'boolean' && <label className="cp-row">
          <input type="checkbox" checked={draft.bilibiliClipShareEnabled} disabled={busy || !draft.enabled || !draft.feedEnabled || !draft.bilibiliEnabled || !draft.bilibiliClipsEnabled}
            onChange={event => {
              const patch = { bilibiliClipShareEnabled: event.target.checked }
              void save({ ...draft, ...patch }, patch)
            }} />允许她把短片段感受与出处分享至私有动态（默认关闭）
        </label>}
        <form onSubmit={event => { event.preventDefault(); void saveBilibiliInterval() }}>
          <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-interval">最小评估间隔（30～1440 分钟）</label><input id="cp-bili-interval" className="cp-input" type="number" min={30} max={1440} step={1} required value={bilibiliIntervalValue} disabled={busy} onChange={event => setBilibiliIntervalInput(event.target.value)} /></div>
          <div className="cp-actions"><button className="cp-button" type="submit" disabled={busy || !validBilibiliInterval || parsedBilibiliInterval === bilibiliInterval}>保存间隔</button></div>
        </form>
      </div>
      <p className="cp-hint cp-small">浏览遵守免打扰时段和后台任务总开关。阅读分享也受自主动态间隔限制。请在「B 站」页加入视频候选。</p>
    </section>}
    {reflection && <section className="cp-card" aria-live="polite">
      <div className="cp-row cp-between"><h2>阅读反思</h2><button className="cp-button" type="button" onClick={() => setReflection(undefined)}>收起</button></div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{reflection.content}</p>
      <p className="cp-label">关联活动 {reflection.sourceRefs.find(ref => ref.activityId)?.activityId ?? '不可用'}</p>
    </section>}
    {dailyNote && <section className="cp-card" aria-label="本次自我笔记" aria-live="polite">
      <div className="cp-row cp-between"><h2 ref={dailyNoteTitle} tabIndex={-1}>本次自我笔记</h2><button className="cp-button" type="button" disabled={openingNote} onClick={() => { setDailyNote(undefined); dailyNoteTrigger.current?.focus() }}>收起笔记</button></div>
      <div className="cp-label">{SELF_NOTE_BASIS_LABELS[dailyNote.basis]} · {dailyNoteRevision === undefined
        ? (dailyNote.status === 'active' ? '有效' : '已归档') : `行动时的第 ${dailyNoteRevision} 版`}</div>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{dailyNote.content}</p>
      <SelfNoteEvidence note={dailyNote} />
    </section>}
    <section className="cp-card"><div className="cp-row cp-between"><h2>自主任务队列</h2><span className="cp-label">延迟、租约、尝试次数与恢复状态</span></div>
      {data.autonomy.jobs.length ? <div className="cp-table-wrap"><table className="cp-table"><thead><tr><th>类型</th><th>场景</th><th>状态</th><th>计划执行</th><th>尝试</th></tr></thead><tbody>
        {data.autonomy.jobs.map(job => <tr key={job.id}>
          <td><strong>{job.kind === 'minecraft.supply'
            ? job.payload.goal === 'prepare' ? 'Minecraft 授权备料并搭建' : job.payload.goal === 'camp' ? 'Minecraft 授权搭建' : JOB[job.kind]
            : JOB[job.kind]}</strong><div className="cp-code">{job.id}</div>{(job.task.error || job.lastError) && <div className="cp-error">{job.task.error ?? job.lastError}</div>}
            {job.kind === 'minecraft.recovery' && <MinecraftRecoveryJobOutcome job={job} />}
            {job.kind === 'daily.choice' && <DailyInitiativeOutcome job={job} openNote={openDailyNote} openingNote={openingNote} />}
            {job.kind === 'bilibili.reflect' && typeof job.payload.memoryId === 'string' && <button className="cp-button" type="button" onClick={() => void openReflection(String(job.payload.memoryId))}>查看反思</button>}
            {job.kind === 'daily.reflect' && job.task.status === 'succeeded' && typeof job.payload.noteId === 'string' &&
              <button className="cp-button" type="button" disabled={openingNote} aria-expanded={dailyNote?.id === job.payload.noteId}
                onClick={event => void openDailyNote(String(job.payload.noteId), event.currentTarget)}>查看自我笔记</button>}
          </td>
          <td className="cp-code">{job.contextId}</td>
          <td>{TASK[job.task.status]}</td>
          <td className="cp-meta">{time(job.runAfter)}</td>
          <td>{job.attempts} / {job.maxAttempts}</td>
        </tr>)}
      </tbody></table></div> : <div className="cp-empty">尚无自主任务。完成一段聊天后，会在这里出现延迟记忆整理任务。</div>}
    </section>
    <ToolPolicyPanel bindings={data.bindings} notify={notify} />
  </>
}
