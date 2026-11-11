import { useState, type FormEvent } from 'react'
import type { PersonaRevision } from '../core/model.ts'
import type { PersonaHistoryView, SavePersonaInput, WorkbenchView } from '../protocol/api.ts'
import { getPersonaHistory, restorePersona, savePersona } from './api.ts'

const CHANGE_LABEL: Record<PersonaRevision['change'], string> = {
  initial: '初始档案',
  imported: '沿用原档案',
  edit: '主人修改',
  restore: '恢复旧版',
}

export function PersonaSettings({ data, reload, notify }: { data: WorkbenchView; reload: () => Promise<void>; notify: (error: unknown) => void }) {
  const [edit, setEdit] = useState<SavePersonaInput>()
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<PersonaHistoryView>()
  const [selected, setSelected] = useState<PersonaRevision>()
  const current = data.persona
  const draft = edit ?? current
  const stale = edit !== undefined && edit.expectedVersion !== current.version
  const changed = draft.name.trim() !== current.name || draft.tagline.trim() !== current.tagline || draft.description.trim() !== current.description
  const selectedIsCurrent = selected?.name === current.name && selected.tagline === current.tagline && selected.description === current.description
  const update = (key: 'name' | 'tagline' | 'description' | 'reason', value: string) => {
    setEdit(previous => ({
      ...(previous ?? { name: current.name, tagline: current.tagline, description: current.description, expectedVersion: current.version }),
      [key]: value,
    }))
  }

  const change = async (action: () => Promise<WorkbenchView>) => {
    setBusy(true)
    try {
      await action()
      setEdit(undefined)
      setSelected(undefined)
      await reload()
      if (history) setHistory(await getPersonaHistory())
    } catch (error) {
      notify(error)
      if ((error as { status?: number } | undefined)?.status === 409) await reload()
    } finally { setBusy(false) }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!edit || !changed || stale || !edit.name.trim() || busy) return
    void change(() => savePersona({ ...edit, reason: edit.reason?.trim() || undefined }))
  }

  const loadHistory = async (before?: number) => {
    setBusy(true)
    try {
      const page = await getPersonaHistory(before)
      setHistory(previous => before !== undefined && previous ? { ...page, revisions: [...previous.revisions, ...page.revisions] } : page)
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }

  return <div className="cp-stack">
    <form className="cp-card" onSubmit={submit}>
      <div className="cp-row cp-between"><h2>角色档案</h2><span className="cp-code">当前第 {current.version} 版</span></div>
      <div className="cp-stack">
        <div className="cp-field"><label className="cp-label" htmlFor="cp-name">名称</label><input id="cp-name" className="cp-input" required maxLength={80} value={draft.name} onChange={event => update('name', event.target.value)} disabled={busy} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-tagline">一句话设定</label><input id="cp-tagline" className="cp-input" maxLength={160} value={draft.tagline} onChange={event => update('tagline', event.target.value)} disabled={busy} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-description">人设摘要</label><textarea id="cp-description" className="cp-textarea" maxLength={20000} value={draft.description} onChange={event => update('description', event.target.value)} disabled={busy} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-persona-reason">修改说明（可选）</label><input id="cp-persona-reason" className="cp-input" maxLength={240} value={edit?.reason ?? ''} onChange={event => update('reason', event.target.value)} disabled={busy} /></div>
      </div>
      {stale && <p className="cp-hint" role="status">档案已更新到第 {current.version} 版。请载入当前版本，再重新编辑。</p>}
      <div className="cp-actions">
        <button className="cp-button" data-primary type="submit" disabled={busy || !changed || stale || !draft.name.trim()}>保存角色档案</button>
        {edit && <button className="cp-button" type="button" disabled={busy} onClick={() => setEdit(undefined)}>{stale ? '载入当前版本' : '放弃修改'}</button>}
      </div>
      <p className="cp-hint cp-small">保存后，已绑定的聊天和游戏会在下一次模型请求使用当前档案。模型读取摘要的前 900 字，自我笔记有独立记录。</p>
      <div className="cp-code">数据格式 v{data.schemaVersion} · 插件 v{data.pluginVersion}</div>
    </form>
    <section className="cp-card">
      <div className="cp-row cp-between">
        <h2>档案版本历史</h2>
        <button className="cp-button" type="button" disabled={busy} onClick={() => {
          if (history) { setHistory(undefined); setSelected(undefined) }
          else void loadHistory()
        }}>{history ? '收起历史' : '查看历史'}</button>
      </div>
      {history && <div className="cp-stack">
        {history.revisions.map(revision => <div className="cp-row cp-between" key={revision.version}>
          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>第 {revision.version} 版 · {revision.name}</strong><div className="cp-hint">
            {CHANGE_LABEL[revision.change]}{revision.restoredFrom !== undefined ? `第 ${revision.restoredFrom} 版` : ''} · {new Date(revision.updatedAt).toLocaleString('zh-CN')}
          </div></div>
          <button className="cp-button" type="button" aria-label={`预览第 ${revision.version} 版`} aria-pressed={selected?.version === revision.version} disabled={busy}
            onClick={() => setSelected(revision)}>预览</button>
        </div>)}
        {history.nextBefore !== undefined && <button className="cp-button" type="button" disabled={busy} onClick={() => void loadHistory(history.nextBefore)}>加载更早版本</button>}
        {selected && <section className="cp-stack" aria-label="档案预览">
          <h3 style={{ overflowWrap: 'anywhere' }}>第 {selected.version} 版 · {selected.name}</h3>
          {selected.tagline && <div>{selected.tagline}</div>}
          {selected.description && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.description}</div>}
          {selected.reason && <p className="cp-hint" style={{ overflowWrap: 'anywhere' }}>{selected.reason}</p>}
          {selectedIsCurrent ? <span className="cp-hint">这份档案内容当前正在使用。</span> : <div className="cp-actions">
            <button className="cp-button" type="button" disabled={busy || !!edit} onClick={() => void change(() => restorePersona(selected.version, current.version))}>恢复此版本</button>
            <span className="cp-hint">{edit ? '请先保存或放弃当前草稿。' : '恢复会生成一个新版本。'}</span>
          </div>}
        </section>}
      </div>}
    </section>
  </div>
}
