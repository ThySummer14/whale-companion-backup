import { useState, type FormEvent } from 'react'
import type { ContextKind } from '../core/model.ts'
import type { WorkbenchView } from '../protocol/api.ts'
import { bindContext, createSession, unbindContext } from './api.ts'

const KINDS: Record<ContextKind, string> = { chat: '聊天', game: '游戏', task: '任务', topic: '话题', system: '系统' }

export function Scenes({ data, reload, openSession, notify }: {
  data: WorkbenchView
  reload: () => Promise<void>
  openSession: (id: string) => Promise<void>
  notify: (error: unknown) => void
}) {
  const [draft, setDraft] = useState<{ contextId: string; sessionId: string; kind: ContextKind; label: string }>({ contextId: 'chat.main', sessionId: '', kind: 'chat', label: '主聊天' })
  const [busy, setBusy] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try { await bindContext(draft); await reload() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const create = async (resume: boolean) => {
    setBusy(true)
    try { await createSession({ ...draft, resume }); await reload() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const resume = async (binding: WorkbenchView['bindings'][number]) => {
    setBusy(true)
    try { await createSession({ ...binding, resume: true }); await reload() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const remove = async (contextId: string) => {
    setBusy(true)
    try { await unbindContext(contextId); await reload() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const edit = (binding: WorkbenchView['bindings'][number]) => setDraft({ contextId: binding.contextId, sessionId: binding.sessionId, kind: binding.kind, label: binding.label })
  return <>
    <section className="cp-card">
      <div className="cp-row cp-between"><h2>场景与会话</h2><span className="cp-label">{data.bindings.length} 个长期场景</span></div>
      <p className="cp-hint">每个场景有独立 Session 上下文，活动和中央记忆按 contextId 归属。重开 Session 不会抹掉场景身份。</p>
      {data.bindings.length ? data.bindings.map(binding => {
        const live = data.sessions.find(session => session.id === binding.sessionId)
        return <div className="cp-session" key={binding.contextId}>
          <div className="cp-row cp-between">
            <div><strong>{binding.label}</strong><span className="cp-status" style={{ marginLeft: 8 }}>{KINDS[binding.kind]}</span><div className="cp-code">{binding.contextId} → {binding.sessionId}</div></div>
            <span className="cp-presence"><span className="cp-dot" data-state={live?.status ?? 'offline'} />{live?.status === 'running' ? '运行中' : live ? '空闲' : '离线'}</span>
          </div>
          <div className="cp-actions">
            <button className="cp-button" disabled={busy} onClick={() => void openSession(binding.sessionId).catch(notify)}>打开会话</button>
            <button className="cp-button" disabled={busy} onClick={() => void resume(binding)}>恢复</button>
            <button className="cp-button" disabled={busy} onClick={() => edit(binding)}>编辑绑定</button>
            <button className="cp-button" disabled={busy} onClick={() => void remove(binding.contextId)}>移除场景</button>
          </div>
        </div>
      }) : <div className="cp-empty">还没有场景。先绑定一个聊天、游戏或任务 Session。</div>}
    </section>
    <form className="cp-card" onSubmit={event => void save(event)}>
      <h2>新增或更新场景绑定</h2>
      <div className="cp-grid">
        <div className="cp-field"><label className="cp-label" htmlFor="cp-context-id">长期场景 ID</label><input id="cp-context-id" className="cp-input" required pattern="[a-z][a-z0-9._-]{0,63}" value={draft.contextId} onChange={event => setDraft(current => ({ ...current, contextId: event.target.value }))} /><span className="cp-label">例如 chat.main、game.survival、task.build-house</span></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-context-label">显示名称</label><input id="cp-context-label" className="cp-input" required maxLength={80} value={draft.label} onChange={event => setDraft(current => ({ ...current, label: event.target.value }))} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-context-kind">场景类型</label><select id="cp-context-kind" className="cp-select" value={draft.kind} onChange={event => setDraft(current => ({ ...current, kind: event.target.value as ContextKind }))}>{Object.entries(KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-context-session">当前 DSH Session</label><select id="cp-context-session" className="cp-select" value={draft.sessionId} onChange={event => setDraft(current => ({ ...current, sessionId: event.target.value }))}><option value="">选择在线根会话，或留空新建</option>{data.sessions.map(session => <option key={session.id} value={session.id}>{session.id}{session.status === 'running' ? '（运行中）' : ''}</option>)}{draft.sessionId && !data.sessions.some(session => session.id === draft.sessionId) && <option value={draft.sessionId}>{draft.sessionId}（当前离线）</option>}</select></div>
      </div>
      <div className="cp-actions">
        <button className="cp-button" data-primary type="submit" disabled={busy || !draft.sessionId || !draft.contextId || !draft.label}>绑定现有 Session</button>
        <button className="cp-button" type="button" disabled={busy || !draft.contextId || !draft.label} onClick={() => void create(false)}>新建专用 Session</button>
        <button className="cp-button" type="button" disabled={busy || !draft.sessionId || !draft.contextId || !draft.label} onClick={() => void create(true)}>恢复所选 Session</button>
      </div>
      <p className="cp-hint cp-small">新建时会为 contextId 创建独立 Agent，不复用其他场景的空白 Session。一个 DSH Session 只能属于一个场景。</p>
    </form>
  </>
}
