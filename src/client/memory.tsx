import { useEffect, useState, type FormEvent } from 'react'
import type { MemoryKind, MemoryRecord, MemoryRevision, MemoryStatus } from '../core/model.ts'
import type { MemoryArchivePreviewEntry, WorkbenchView } from '../protocol/api.ts'
import { applyMemoryArchive, createMemory, getMemories, getMemoryHistory, maintainMemory, memoryAction, previewMemoryArchive, updateAutonomy, updateMemory } from './api.ts'
import { SelfNotesPanel } from './self-notes.tsx'
import { MediaPanel } from './media.tsx'

const STATUS: Record<MemoryStatus | 'all', string> = { all: '全部', active: '活跃', candidate: '候选', archived: '已归档', forgotten: '已遗忘' }
const KINDS: Record<MemoryKind, string> = { 'user-fact': '用户事实', preference: '偏好', experience: '她的经历', event: '共同事件', goal: '目标', relationship: '关系', other: '其他' }
const dateLabel = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false })
const retentionLabel = (retention: number) => `${Math.round(retention * 100)}%`

function MemoryRow({ memory, bindings, archiveAvailable, changed, notify }: {
  memory: MemoryRecord
  bindings: WorkbenchView['bindings']
  archiveAvailable: boolean
  changed: () => Promise<void>
  notify: (error: unknown) => void
}) {
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState(memory.content)
  const [revisions, setRevisions] = useState<MemoryRevision[]>()
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try { await action(); await changed() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const history = async () => {
    if (revisions) { setRevisions(undefined); return }
    setBusy(true)
    try { const value = await getMemoryHistory(memory.id); setRevisions(value.revisions) }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const scope = memory.scope === 'shared' ? '共享' : `场景：${memory.contextId ?? '未归属'}`
  const archived = memory.status === 'archived'
  const archiveLabel = memory.archivedFrom ? `恢复为${STATUS[memory.archivedFrom]}` : '恢复归档'
  return <article className="cp-card" aria-busy={busy}>
    <div className="cp-row cp-between">
      <div><strong>{KINDS[memory.kind]}</strong><span className="cp-status" data-state={memory.status} style={{ marginLeft: 8 }}>{STATUS[memory.status]}</span>{memory.pinned && <span className="cp-status" style={{ marginLeft: 6 }}>长期锚点</span>}</div>
      <span className="cp-label">{scope} · 召回 {memory.recallCount} 次</span>
    </div>
    {editing ? <div className="cp-stack" style={{ marginTop: 12 }}><textarea className="cp-textarea" aria-label="修订记忆正文" maxLength={4000} value={content} disabled={busy} onChange={event => setContent(event.target.value)} /><div className="cp-actions"><button className="cp-button" data-primary disabled={busy || !content.trim()} onClick={() => void run(async () => { await updateMemory(memory.id, { content, reason: '面板修订' }); setEditing(false) })}>保存修订</button><button className="cp-button" disabled={busy} onClick={() => { setContent(memory.content); setEditing(false) }}>取消</button></div></div> : <p style={{ whiteSpace: 'pre-wrap' }}>{memory.content}</p>}
    <div className="cp-label">重要度 {memory.importance.toFixed(2)} · 置信度 {memory.confidence.toFixed(2)} · 更新于 {dateLabel(memory.updatedAt)}</div>
    {typeof memory.retention === 'number' && <div className="cp-label">长期权重 {retentionLabel(memory.retention)} · 对话强化 {memory.reinforcementCount ?? 0} 次{memory.lastReinforcedAt && ` · 最近强化 ${dateLabel(memory.lastReinforcedAt)}`}</div>}
    <div className="cp-code">{memory.id}</div>
    {memory.forgetReason && <div className="cp-hint cp-small">遗忘原因：{memory.forgetReason}</div>}
    {archived && memory.archiveReason && <div className="cp-hint cp-small">归档原因 · {memory.archiveReason}</div>}
    <div className="cp-actions">
      <button className="cp-button" disabled={busy} onClick={() => setEditing(!editing)}>纠正</button>
      {!archived && <button className="cp-button" disabled={busy} onClick={() => void run(() => updateMemory(memory.id, { pinned: !memory.pinned, reason: memory.pinned ? '取消长期锚点' : '设为长期锚点' }))}>{memory.pinned ? '取消锚点' : '设为锚点'}</button>}
      {memory.status === 'candidate' && <button className="cp-button" disabled={busy} onClick={() => void run(() => updateMemory(memory.id, { status: 'active', reason: '确认候选记忆' }))}>确认</button>}
      {archiveAvailable && (memory.status === 'active' || memory.status === 'candidate') && <button className="cp-button" disabled={busy || memory.pinned} title={memory.pinned ? '取消长期锚点后可归档' : undefined} onClick={() => void run(() => memoryAction(memory.id, 'archive', '工作台手动归档'))}>归档</button>}
      {archived || memory.status === 'forgotten'
        ? <button className="cp-button" disabled={busy} onClick={() => void run(() => memoryAction(memory.id, 'restore', '面板恢复'))}>{archived ? archiveLabel : '恢复遗忘记忆'}</button>
        : <button className="cp-button" disabled={busy} onClick={() => void run(() => memoryAction(memory.id, 'forget', '面板遗忘'))}>遗忘</button>}
      <button className="cp-button" disabled={busy} aria-expanded={!!revisions} onClick={() => void history()}>{revisions ? '收起历史' : '修订历史'}</button>
    </div>
    {revisions && <div className="cp-session"><strong>修订历史（最新在前）</strong>{revisions.map(revision => <div key={revision.id} style={{ marginTop: 10 }}><div className="cp-label">r{revision.revision} · {revision.reason} · {new Date(revision.createdAt).toLocaleString('zh-CN', { hour12: false })}{revision.actorSessionId ? ` · ${revision.actorSessionId}` : ''}</div><div style={{ whiteSpace: 'pre-wrap' }}>{revision.snapshot.content}</div><div className="cp-label">{STATUS[revision.snapshot.status]} · {revision.snapshot.scope === 'shared' ? '共享' : revision.snapshot.contextId}</div></div>)}</div>}
    <div className="cp-label">来源：{memory.sourceRefs.length ? memory.sourceRefs.map(ref => ref.contextId ?? ref.sessionId ?? ref.taskId ?? ref.activityId ?? '外部').join('、') : '手动创建'}</div>
    {bindings.length > 0 && memory.scope === 'context' && <div className="cp-label">可见场景：{bindings.find(binding => binding.contextId === memory.contextId)?.label ?? memory.contextId}</div>}
  </article>
}

function MemoryArchivePanel({ data, changed, notify }: {
  data: WorkbenchView
  changed: () => Promise<void>
  notify: (error: unknown) => void
}) {
  const [preview, setPreview] = useState<MemoryArchivePreviewEntry[]>()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [archiveOverride, setArchiveOverride] = useState<boolean>()
  const settings = data.autonomy.settings
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const review = async () => {
    const { items } = await previewMemoryArchive()
    setSelected(new Set(items.map(item => item.id)))
    setPreview(items)
    setNotice('')
  }
  const apply = async () => {
    const items = preview?.filter(item => selected.has(item.id))
    if (!items?.length) return
    const result = await applyMemoryArchive(items)
    setPreview(undefined)
    setNotice(`已归档 ${result.archived} 条${result.skipped ? `，跳过 ${result.skipped} 条已变化或不符合条件的记忆` : ''}。`)
    await changed()
  }
  const setBackgroundArchive = async (memoryArchiveEnabled: boolean) => {
    setArchiveOverride(memoryArchiveEnabled)
    try {
      await updateAutonomy({ memoryArchiveEnabled })
      await changed()
    } finally { setArchiveOverride(undefined) }
  }
  return <section className="cp-card" aria-busy={busy}>
    <div className="cp-row cp-between"><h2>长期记忆归档</h2><span className="cp-label">保留正文、来源和修订历史</span></div>
    <p className="cp-hint">低重要度且长期未使用的记忆可以移出日常召回。归档项可搜索并恢复为原来的活跃记忆或候选，长期锚点受保护。</p>
    <div className="cp-actions">
      <button type="button" className="cp-button" disabled={busy} onClick={() => void run(review)}>预览可归档记忆</button>
      <label className="cp-row"><input type="checkbox" checked={archiveOverride ?? (settings.memoryArchiveEnabled === true)} disabled={busy} onChange={event => {
        const memoryArchiveEnabled = event.target.checked
        void run(() => setBackgroundArchive(memoryArchiveEnabled))
      }} />允许后台归档</label>
    </div>
    <p className="cp-label">后台归档默认关闭。启用自主任务后，宿主最多每天检查一次。</p>
    {notice && <p role="status">{notice}</p>}
    {preview && <div className="cp-session">
      <strong>归档预览 · {preview.length} 条符合条件</strong>
      {preview.length ? <>
        <p className="cp-hint">请核对并勾选要归档的记忆。提交时宿主会重新检查每一条。</p>
        <ul>{preview.map(item => <li key={item.id}>
          <label className="cp-row">
            <input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={event => {
              const checked = event.target.checked
              setSelected(current => {
                const next = new Set(current)
                if (checked) next.add(item.id)
                else next.delete(item.id)
                return next
              })
            }} />
            <span>{item.excerpt || item.id}</span>
          </label>
          <div className="cp-label">{item.scope === 'shared' ? '共享' : data.bindings.find(binding => binding.contextId === item.contextId)?.label ?? item.contextId ?? '场景私有'} · 长期权重 {retentionLabel(item.retention)} · 更新于 {dateLabel(item.updatedAt)}</div>
        </li>)}</ul>
        <button type="button" className="cp-button" data-primary disabled={busy || !selected.size} onClick={() => void run(apply)}>确认归档已选 {selected.size} 条</button>
      </> : <p role="status" className="cp-hint">当前没有符合条件的记忆。</p>}
      <button type="button" className="cp-button" disabled={busy} onClick={() => setPreview(undefined)}>关闭预览</button>
    </div>}
  </section>
}

export function MemoryPage({ data, reload, notify }: { data: WorkbenchView; reload: () => Promise<void>; notify: (error: unknown) => void }) {
  const [filter, setFilter] = useState<MemoryStatus | 'all'>('all')
  const [archiveSearchInput, setArchiveSearchInput] = useState('')
  const [archiveSearch, setArchiveSearch] = useState('')
  const [listVersion, setListVersion] = useState(0)
  const [list, setList] = useState<{ key: string; items?: MemoryRecord[] }>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState({ kind: 'preference' as MemoryKind, content: '', scope: 'shared' as 'shared' | 'context', contextId: data.bindings[0]?.contextId ?? '', importance: 0.6, confidence: 0.9 })
  const archiveAvailable = typeof data.memory.archived === 'number'
  const activeFilter = filter === 'archived' && !archiveAvailable ? 'all' : filter
  const query = activeFilter === 'archived' ? archiveSearch : undefined
  const listKey = JSON.stringify([activeFilter, query, listVersion])
  const activeList = list?.key === listKey ? list : undefined
  useEffect(() => {
    const controller = new AbortController()
    void getMemories(activeFilter, query, controller.signal).then(value => {
      if (!controller.signal.aborted) setList({ key: listKey, items: value.items })
    }).catch(error => {
      if (!controller.signal.aborted) {
        setList({ key: listKey })
        notify(error)
      }
    })
    return () => controller.abort()
  }, [activeFilter, query, listKey, notify])
  const changed = async () => {
    setListVersion(current => current + 1)
    await reload()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await createMemory({ ...draft, contextId: draft.scope === 'context' ? draft.contextId : undefined })
      setDraft(current => ({ ...current, content: '' }))
      await changed()
      setNotice('记忆已保存')
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const maintain = async () => {
    setBusy(true)
    try { const result = await maintainMemory(); await changed(); setNotice(`整理完成，遗忘 ${result.forgotten} 条低重要度且长期未召回的记忆`) }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  return <>
    <div className="cp-grid">
      <section className="cp-card"><div className="cp-label">活跃记忆</div><div className="cp-metric">{data.memory.active}</div></section>
      <section className="cp-card"><div className="cp-label">待确认候选</div><div className="cp-metric">{data.memory.candidate}</div></section>
      {archiveAvailable && <section className="cp-card"><div className="cp-label">已归档</div><div className="cp-metric">{data.memory.archived}</div></section>}
      <section className="cp-card"><div className="cp-label">已遗忘</div><div className="cp-metric">{data.memory.forgotten}</div>{!archiveAvailable && <button className="cp-button" style={{ marginTop: 8 }} disabled={busy} onClick={() => void maintain()}>整理记忆</button>}</section>
    </div>
    {notice && <div className="cp-card" role="status">{notice}</div>}
    {archiveAvailable && <MemoryArchivePanel data={data} changed={changed} notify={notify} />}
    <form className="cp-card" onSubmit={event => void submit(event)}>
      <h2>新增中央记忆</h2>
      <div className="cp-stack">
        <div className="cp-row">
          <select className="cp-select" style={{ maxWidth: 180 }} value={draft.kind} onChange={event => setDraft(current => ({ ...current, kind: event.target.value as MemoryKind }))}>{Object.entries(KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
          <select className="cp-select" style={{ maxWidth: 220 }} value={draft.scope} onChange={event => setDraft(current => ({ ...current, scope: event.target.value as 'shared' | 'context' }))}><option value="shared">跨场景共享</option><option value="context">仅当前场景</option></select>
          {draft.scope === 'context' && <select className="cp-select" style={{ maxWidth: 240 }} required value={draft.contextId} onChange={event => setDraft(current => ({ ...current, contextId: event.target.value }))}><option value="">选择归属场景</option>{data.bindings.map(binding => <option key={binding.contextId} value={binding.contextId}>{binding.label}（{binding.contextId}）</option>)}</select>}
        </div>
        <textarea className="cp-textarea" style={{ minHeight: 90 }} required maxLength={4000} placeholder="只记录以后仍有用的紧凑事实，不复制整段聊天，也不保存密钥" value={draft.content} onChange={event => setDraft(current => ({ ...current, content: event.target.value }))} />
        <div className="cp-row"><label className="cp-label">重要度 <input className="cp-input" style={{ width: 90 }} type="number" min={0} max={1} step={0.1} value={draft.importance} onChange={event => setDraft(current => ({ ...current, importance: Number(event.target.value) }))} /></label><label className="cp-label">置信度 <input className="cp-input" style={{ width: 90 }} type="number" min={0} max={1} step={0.1} value={draft.confidence} onChange={event => setDraft(current => ({ ...current, confidence: Number(event.target.value) }))} /></label><button className="cp-button" data-primary type="submit" disabled={busy || !draft.content.trim()}>保存记忆</button></div>
      </div>
    </form>
    <nav className="cp-tabs" aria-label="按状态筛选记忆">{(['all', 'active', 'candidate', 'archived', 'forgotten'] as const).filter(status => archiveAvailable || status !== 'archived').map(status => <button type="button" key={status} className="cp-tab" data-active={activeFilter === status} aria-pressed={activeFilter === status} onClick={() => setFilter(status)}>{STATUS[status]}</button>)}</nav>
    {activeFilter === 'archived' && <form className="cp-actions" onSubmit={event => { event.preventDefault(); setArchiveSearch(archiveSearchInput.trim()) }}>
      <label className="cp-row">搜索归档 <input className="cp-input" type="search" maxLength={240} value={archiveSearchInput} onChange={event => setArchiveSearchInput(event.target.value)} /></label>
      <button type="submit" className="cp-button">搜索</button>
      {archiveSearch && <button type="button" className="cp-button" onClick={() => { setArchiveSearchInput(''); setArchiveSearch('') }}>清除搜索</button>}
    </form>}
    <p className="cp-hint">共享记忆可跨场景召回。场景私有记忆只在同一 contextId 内召回。{archiveAvailable ? '归档和遗忘都会退出日常召回，修订历史保留。' : '遗忘会退出日常召回，修订历史保留。'}</p>
    {!activeList ? <div className="cp-empty" role="status">正在读取记忆。</div>
      : !activeList.items ? <div className="cp-empty" role="status">暂时无法读取记忆。</div>
        : activeList.items.length ? activeList.items.map(memory => <MemoryRow key={`${memory.id}-${memory.updatedAt}`} memory={memory} bindings={data.bindings} archiveAvailable={archiveAvailable} changed={changed} notify={notify} />)
          : <div className="cp-empty" role="status">{query ? '没有匹配的归档记忆。' : '这个状态下还没有记忆。'}</div>}
    <SelfNotesPanel notify={notify} />
    <MediaPanel notify={notify} />
  </>
}
