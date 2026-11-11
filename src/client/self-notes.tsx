import { useEffect, useRef, useState, type FormEvent } from 'react'
import { SELF_NOTE_TRAIT_LABELS, type SelfNote, type SelfNoteCounts, type SelfNoteExperienceReceipt, type SelfNoteRevision } from '../core/model.ts'
import { createSelfNote, getSelfNoteHistory, getSelfNotes, rollbackSelfNote, selfNoteAction, updateSelfNote } from './api.ts'

export const SELF_NOTE_BASIS_LABELS = { observation: '真实行为', 'user-feedback': '主人反馈', inference: '自我推断' }
const EXPERIENCE_LABELS = { survey: 'Minecraft 营地勘察', supply: 'Minecraft 营地补给', build: 'Minecraft 营地建造',
  bilibili: 'B 站字幕阅读', 'camp-project': 'Minecraft 营地项目验收', house: 'Minecraft 小屋验收', 'house-project': 'Minecraft 自主分区施工' }

function ReceiptFact({ receipt }: { receipt: SelfNoteExperienceReceipt }) {
  return <div style={{ overflowWrap: 'anywhere' }}>
    <time className="cp-label" dateTime={receipt.at}>{new Date(receipt.at).toLocaleString('zh-CN', { hour12: false })}</time>
    <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{receipt.fact}</p>
  </div>
}

function ExperienceDetails({ note, showReceipt = true }: { note: SelfNote; showReceipt?: boolean }) {
  const experience = note.experience
  if (!experience) return null
  return <details className="cp-session">
      <summary>活动回执 · {EXPERIENCE_LABELS[experience.kind]}</summary>
      <div className="cp-label" style={{ overflowWrap: 'anywhere' }}>
        {experience.kind === 'camp-project' ? <>
          <div>营地复访任务 {experience.taskId}</div>
          <div>建造回执任务 {experience.constructionTaskId}</div>
          <div>复查回执任务 {experience.receiptTaskId}</div>
        </> : experience.kind === 'house' ? <>
          <div>小屋施工回执任务 {experience.taskId}</div>
          <div>小屋草案 {experience.draftId}</div>
        </> : <>
          <div>每日活动任务 {experience.dailyTaskId}</div>
          <div>执行任务 {experience.activityTaskId}</div>
          {experience.kind === 'bilibili' ? <div>字幕阅读回执 #{experience.activityId}</div>
            : experience.kind === 'house-project' ? <div>分区施工回执 #{experience.activityId}</div>
              : <div>游戏回执任务 {experience.receiptTaskId}</div>}
        </>}
      </div>
      {showReceipt && note.experienceReceipt && <ReceiptFact receipt={note.experienceReceipt} />}
    </details>
}

function ObservationRevision({ note, predecessorId, reason }: { note: SelfNote; predecessorId: string; reason: string }) {
  const [previous, setPrevious] = useState<SelfNote>()
  const [readState, setReadState] = useState<'loading' | 'failed'>()
  const pending = useRef(false)
  const load = async () => {
    if (previous || pending.current) return
    pending.current = true
    setReadState('loading')
    try {
      const result = await getSelfNoteHistory(predecessorId)
      if (result.note.id !== predecessorId) throw new Error('self-note-predecessor-mismatch')
      setPrevious(result.note)
      setReadState(undefined)
    } catch { setReadState('failed') }
    finally { pending.current = false }
  }
  return <details className="cp-session" onToggle={event => { if (event.currentTarget.open) void load() }}>
    <summary>观察修订 · 此前 → 当前</summary>
    <p style={{ overflowWrap: 'anywhere' }}><strong>修订原因</strong> · {reason}</p>
    <div className="cp-stack">
      <section aria-label="此前观察">
        <h3>此前观察</h3>
        {previous ? <>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{previous.content}</p>
          {previous.experienceReceipt && <ReceiptFact receipt={previous.experienceReceipt} />}
          <ExperienceDetails note={previous} showReceipt={false} />
        </> : <p className="cp-hint" role="status">{readState === 'failed' ? '暂时读不到此前观察。合上后可重新展开。' : '正在读取此前观察。'}</p>}
      </section>
      <section aria-label="当前观察">
        <h3>当前观察</h3>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.content}</p>
        {note.experienceReceipt && <ReceiptFact receipt={note.experienceReceipt} />}
      </section>
    </div>
  </details>
}

export function SelfNoteEvidence({ note }: { note: SelfNote }) {
  if (!note.experience && !note.evidence.length && !note.counterEvidence.length) return null
  return <div className="cp-stack">
    <ExperienceDetails note={note} />
    {note.supersedes && note.revisionReason && <ObservationRevision key={note.id} note={note} predecessorId={note.supersedes} reason={note.revisionReason} />}
    {note.evidence.map((quote, index) => {
      const ref = note.evidenceRefs?.find(item => item.quoteIndex === index)
      return <div key={index}>
        <div className="cp-label" style={{ overflowWrap: 'anywhere' }}>
          {ref ? `${ref.role === 'assistant' ? '角色原话' : '用户原话'} · 消息 ${ref.messageId}` : '历史引文 · 未记录消息编号'}
        </div>
        <blockquote style={{ margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{quote}</blockquote>
      </div>
    })}
    {note.counterEvidence.length > 0 && <div className="cp-label">反证 · {note.counterEvidence.join('；')}</div>}
  </div>
}

export function SelfNotesPanel({ notify }: { notify: (error: unknown) => void }) {
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active')
  const [items, setItems] = useState<SelfNote[]>([])
  const [counts, setCounts] = useState<SelfNoteCounts>({ active: 0, archived: 0 })
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string>()
  const [content, setContent] = useState('')
  const [history, setHistory] = useState<{ id: string; items: SelfNoteRevision[] }>()
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const value = await getSelfNotes(filter)
    setItems(value.items)
    setCounts(value.counts)
  }
  useEffect(() => { void load().catch(notify) }, [filter])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try { await action(); await load() }
    catch (error) {
      notify(error instanceof Error && error.message === 'self-note-superseded'
        ? new Error('这条笔记已有接续记录，可以在历史中查看。') : error)
    }
    finally { setBusy(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await run(async () => { await createSelfNote(draft); setDraft('') })
  }
  const showHistory = async (id: string) => {
    if (history?.id === id) { setHistory(undefined); return }
    try { const value = await getSelfNoteHistory(id); setHistory({ id, items: value.revisions }) }
    catch (error) { notify(error) }
  }
  const predecessors = new Set(items.filter(note => note.createdBy === 'companion').map(note => note.supersedes))
  const renderNote = (note: SelfNote) => {
    const owner = note.createdBy === 'owner'
    const trait = note.trait && Object.hasOwn(SELF_NOTE_TRAIT_LABELS, note.trait) ? SELF_NOTE_TRAIT_LABELS[note.trait] : undefined
    return <article key={note.id} className="cp-session">
      <div className="cp-row cp-between"><strong>{SELF_NOTE_BASIS_LABELS[note.basis]}</strong><span className="cp-label">置信度 {note.confidence.toFixed(2)} · {note.status === 'active' ? '有效' : '已归档'}</span></div>
      {owner && editing === note.id ? <div className="cp-stack">
        <textarea className="cp-textarea" maxLength={500} aria-label="修改主人反馈" value={content} onChange={event => setContent(event.target.value)} />
        <div className="cp-actions">
          <button className="cp-button" data-primary disabled={busy || !content.trim()} onClick={() => void run(async () => {
            await updateSelfNote(note.id, { content, reason: '主人修订反馈' })
            setEditing(undefined)
          })}>保存反馈</button>
          <button className="cp-button" onClick={() => setEditing(undefined)}>取消</button>
        </div>
      </div> : <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.content}</p>}
      {!owner && trait && <span className="cp-status">跨场景倾向 · {trait}</span>}
      <SelfNoteEvidence note={note} />
      {!owner && note.supersedes && !note.revisionReason && <div className="cp-label" style={{ overflowWrap: 'anywhere' }}>接续笔记 · {note.supersedes}</div>}
      <div className="cp-label" style={{ overflowWrap: 'anywhere' }}>{owner ? '主人' : '角色整理'} · {note.sourceRefs.map(ref => ref.contextId ?? ref.taskId ?? ref.sessionId).filter(Boolean).join('、') || '工作台'} · {new Date(note.updatedAt).toLocaleString('zh-CN', { hour12: false })}</div>
      <div className="cp-actions">
        {owner && <button className="cp-button" disabled={busy} onClick={() => { setEditing(note.id); setContent(note.content) }}>修改反馈</button>}
        {note.status === 'archived' && predecessors.has(note.id) ? <span className="cp-label">已有接续笔记</span>
          : <button className="cp-button" disabled={busy} onClick={() => void run(() => selfNoteAction(note.id, note.status === 'active' ? 'archive' : 'restore'))}>{note.status === 'active' ? '归档' : '恢复'}</button>}
        <button className="cp-button" aria-expanded={history?.id === note.id} onClick={() => void showHistory(note.id)}>{history?.id === note.id ? '收起历史' : owner ? '历史与回滚' : '查看历史'}</button>
      </div>
      {history?.id === note.id && <div>{history.items.map(revision => <div key={revision.id} style={{ marginTop: 10 }}>
        <div className="cp-label" style={{ overflowWrap: 'anywhere' }}>r{revision.revision} · {revision.reason} · {new Date(revision.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
        <p style={{ overflowWrap: 'anywhere' }}>{revision.snapshot.content}</p>
        {revision.snapshot.experienceReceipt && <ReceiptFact receipt={revision.snapshot.experienceReceipt} />}
        {revision.snapshot.revisionReason && <p className="cp-hint" style={{ overflowWrap: 'anywhere' }}>修订原因 · {revision.snapshot.revisionReason}</p>}
        {owner && <button className="cp-button" disabled={busy} onClick={() => void run(async () => {
          await rollbackSelfNote(note.id, revision.revision)
          const value = await getSelfNoteHistory(note.id)
          setHistory({ id: note.id, items: value.revisions })
        })}>回滚到此版本</button>}
      </div>)}</div>}
    </article>
  }
  const notes = items.filter(item => item.createdBy === 'companion')
  const feedback = items.filter(item => item.createdBy === 'owner')

  return <section className="cp-card cp-stack">
    <div className="cp-row cp-between"><h2>自我笔记与反馈</h2><span className="cp-label">有效 {counts.active} · 已归档 {counts.archived}</span></div>
    <nav className="cp-tabs" aria-label="筛选笔记状态">{(['active', 'archived', 'all'] as const).map(status => <button type="button" key={status} className="cp-tab" data-active={filter === status} onClick={() => setFilter(status)}>{status === 'active' ? '有效记录' : status === 'archived' ? '已归档' : '全部'}</button>)}</nav>
    <section aria-label="角色自我笔记">
      <div className="cp-row cp-between"><h3>角色自我笔记</h3>{typeof counts.companionActive === 'number' && <span className="cp-label">有效 {counts.companionActive} / 40</span>}</div>
      <p className="cp-hint">大肥鱼可以依据真实对话或有回执的自主经历写下对自己的观察，也能用新证据接续旧笔记。主人可查看历史、归档或恢复。进入其他场景时，只携带适用的行为标签。</p>
      {notes.length ? notes.map(renderNote) : <div className="cp-empty">这个状态下还没有角色自我笔记。</div>}
    </section>
    <section aria-label="主人反馈">
      <div className="cp-row cp-between"><h3>主人反馈</h3>{typeof counts.ownerActive === 'number' && <span className="cp-label">有效 {counts.ownerActive} / 40</span>}</div>
      <p className="cp-hint">单独记录你的建议。反馈可以编辑、归档和回滚。</p>
      <form className="cp-stack" onSubmit={event => void submit(event)}>
        <textarea className="cp-textarea" style={{ minHeight: 70 }} aria-label="新增主人反馈" maxLength={500} required placeholder="例如：解释技术问题时，先告诉我结论。" value={draft} onChange={event => setDraft(event.target.value)} />
        <div className="cp-actions"><button className="cp-button" type="submit" disabled={busy || !draft.trim()}>记录主人反馈</button></div>
      </form>
      {feedback.length ? feedback.map(renderNote) : <div className="cp-empty">这个状态下还没有主人反馈。</div>}
    </section>
  </section>
}
