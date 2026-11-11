import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BILIBILI_CONTEXT } from '../core/model.ts'
import type { WorkbenchView } from '../protocol/api.ts'
import { MAX_BILIBILI_SUBTITLE_BYTES, type BilibiliQueueItem, type BilibiliQueueView, type BilibiliReadResult, type BilibiliSource, type BilibiliSubtitleDocument, type BilibiliSubtitleFormat } from '../protocol/bilibili.ts'
import { addBilibiliCandidate, addBilibiliSource, createSession, importBilibiliSubtitle, readBilibili, revokeBilibiliSource, revokeBilibiliSubtitle, withdrawBilibiliCandidate } from './api.ts'

function timecode(seconds: number): string {
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const READ_ERRORS: Readonly<Record<string, string>> = {
  'bili-invalid-video': '请输入 BV 号或 www.bilibili.com 的视频链接。',
  'bili-video-unavailable': '这个视频当前无法公开读取。',
  'bili-part-unavailable': '这个视频没有所选分 P。',
  'bili-busy': '正在读取另一个视频，请稍后重试。',
  'bili-budget-exhausted': '已达本分钟的读取上限，请稍后重试。',
  'bili-upstream-paused': 'B 站暂时限制了读取，稍后可重试。',
  'bili-timeout': '读取超时，请稍后重试。',
  'bili-network-error': '暂时连不上 B 站。',
  'bili-subtitle-identity': '字幕轨与当前视频或分 P 无法匹配。',
  'bili-subtitle-timeline': '字幕时间轴与当前分 P 无法匹配。',
}

const QUEUE_ERRORS: Readonly<Record<string, string>> = {
  'bili-invalid-video': READ_ERRORS['bili-invalid-video']!,
  'bili-queue-full': '候选队列已满，请等候处理或撤回一条候选。',
  'bili-candidate-unavailable': '此候选已结束或不存在，队列已重新同步。',
  'invalid-request': '请检查视频链接、分 P 和备注。',
}

const CANDIDATE_STATUS: Record<BilibiliQueueItem['status'], string> = {
  queued: '等待评估', reading: '正在读取', read: '已处理', skipped: '已跳过', failed: '读取失败', cancelled: '已撤回',
}

const SOURCE_ERRORS: Readonly<Record<string, string>> = {
  ...READ_ERRORS,
  'bili-invalid-source': '请复制 B 站个人空间中公开合集的链接。',
  'bili-source-limit': '已达到合集授权上限，撤回一项后可以再添加。',
  'bili-source-unavailable': '这个合集当前无法公开读取，或授权已撤回。',
  'bili-source-identity': 'B 站返回的资料与已授权的合集不匹配。',
  'bili-upstream-invalid': 'B 站返回的合集资料不完整。',
  'bili-upstream-error': 'B 站暂时无法返回合集资料。',
  'bili-discovery-timeout': '本次合集检查超时，将按节律重试。',
  'invalid-request': '请检查合集链接和备注。',
}

const SOURCE_STATUS: Record<BilibiliSource['status'], string> = {
  waiting: '等待检查', added: '已发现候选', unchanged: '没有新增候选', unavailable: '暂不可查',
}

const SUBTITLE_ERRORS: Readonly<Record<string, string>> = {
  ...READ_ERRORS,
  'bili-invalid-subtitle-file': '字幕格式无效。请选择 UTF-8 编码的 SRT 或 WebVTT 文件。',
  'bili-subtitle-too-large': `字幕文件最多 ${MAX_BILIBILI_SUBTITLE_BYTES / 1024} KiB。`,
  'bili-subtitle-limit': '字幕附件已达上限。撤回一份附件后可导入新的分 P。',
  'bili-subtitle-unavailable': '该分 P 的字幕附件已撤回或不存在。',
  'Invalid request': '请检查视频链接、分 P 和字幕文件。',
}

function CandidateTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString('zh-CN', { hour12: false })}</time>
}

function CandidateRow({ item, withdrawing, busy, withdraw }: {
  item: BilibiliQueueItem
  withdrawing: boolean
  busy: boolean
  withdraw?: (id: string) => Promise<void>
}) {
  const receipt = item.status === 'read' ? item.receipt : undefined
  const status = receipt?.kind === 'video.subtitle-read'
    ? receipt.provenance?.kind === 'owner-supplied' ? '已读取主人字幕片段' : '已读取公开字幕片段'
    : receipt?.kind === 'video.clip-sampled' ? '已自主查看短片段'
    : receipt?.kind === 'video.inspected' ? '已读取资料' : CANDIDATE_STATUS[item.status]
  const query = receipt?.clip ? `?p=${item.part}&t=${receipt.clip.start}` : item.part > 1 ? `?p=${item.part}` : ''
  const link = `https://www.bilibili.com/video/${encodeURIComponent(item.bvid)}/${query}`
  return <li className="cp-session">
    <div className="cp-row cp-between">
      <div>
        {item.sourceId && <div className="cp-label">合集自动发现{item.sourceTitle && <> · {item.sourceTitle}</>}</div>}
        {item.label && <div><strong>{item.label}</strong></div>}
        <a href={link} target="_blank" rel="noreferrer">{item.bvid} · 第 {item.part} P</a>
      </div>
      <div className="cp-row">
        <span className="cp-status" data-state={receipt ? 'success' : item.status}>{status}</span>
        {withdraw && <button className="cp-button" type="button" disabled={busy} aria-label={`撤回 ${item.bvid} 第 ${item.part} P`} onClick={() => void withdraw(item.id)}>{withdrawing ? '正在撤回…' : '撤回'}</button>}
      </div>
    </div>
    <div className="cp-label">{withdraw ? '加入于 ' : receipt ? '完成于 ' : '更新于 '}<CandidateTime value={withdraw ? item.createdAt : receipt?.at ?? item.updatedAt} /></div>
    {receipt?.clip && <div className="cp-label">从 {timecode(receipt.clip.start)} 开始 · {receipt.clip.seconds} 秒 · {[receipt.clip.visual && '抽样画面', receipt.clip.audio && '声音转写'].filter(Boolean).join('与')}</div>}
    {item.error && <div className="cp-hint">{Object.hasOwn(READ_ERRORS, item.error) ? READ_ERRORS[item.error] : item.error}</div>}
  </li>
}

function BilibiliQueue({ queue, autonomyEnabled, browsingEnabled, reload }: {
  queue: BilibiliQueueView
  autonomyEnabled: boolean
  browsingEnabled: boolean
  reload: () => Promise<void>
}) {
  const [video, setVideo] = useState('')
  const [part, setPart] = useState('')
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState<string>()
  const [feedback, setFeedback] = useState<{ message: string; error?: true }>()
  const active = queue.items.filter(item => item.status === 'queued' || item.status === 'reading')
  const history = queue.items.filter(item => item.status !== 'queued' && item.status !== 'reading')
  const waiting = active.some(item => item.status === 'queued')

  const mutate = async (id?: string) => {
    const target = video.trim()
    if (pending || (!id && !target)) return
    setPending(id ?? 'add')
    setFeedback(undefined)
    try {
      if (id) {
        await withdrawBilibiliCandidate(id)
        setFeedback({ message: '候选已撤回。' })
      } else {
        await addBilibiliCandidate({ video: target, part: part ? Number(part) : undefined, label: label.trim() || undefined })
        setVideo('')
        setPart('')
        setLabel('')
        setFeedback({ message: '视频已在候选队列中。' })
      }
      await reload()
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setFeedback({ error: true, message: (Object.hasOwn(QUEUE_ERRORS, code) && QUEUE_ERRORS[code]) || '本次操作未完成，请重试。' })
      if (code === 'bili-candidate-unavailable') await reload()
    } finally { setPending(undefined) }
  }

  return <section className="cp-card" aria-labelledby="cp-bili-queue-title">
    <div className="cp-row cp-between"><h2 id="cp-bili-queue-title">自主浏览候选</h2><span className="cp-status">{active.length} 个候选</span></div>
    <p className="cp-hint">加入后，大肥鱼可以选择读取、等待或跳过。撤回会取消这条候选的读取授权，并保留处理记录。</p>
    <p className="cp-label">{!browsingEnabled ? '在「自主节律」中开启 B 站自主浏览。'
      : !autonomyEnabled ? '后台自主任务当前暂停。'
      : waiting && queue.nextDecisionAt ? <>最早评估时间 <CandidateTime value={queue.nextDecisionAt} />，免打扰和其他任务可能使评估延后。</>
      : waiting ? '等待下一次调度。' : 'B 站自主浏览已开启。'}</p>
    <form onSubmit={event => { event.preventDefault(); void mutate() }}>
      <div className="cp-grid">
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-queue-video">BV 号或完整视频链接</label><input id="cp-bili-queue-video" className="cp-input" maxLength={512} required value={video} disabled={!!pending} onChange={event => setVideo(event.target.value)} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-queue-part">分 P（可选）</label><input id="cp-bili-queue-part" className="cp-input" type="number" min="1" max="1000" step="1" placeholder="沿用链接或读取第 1 P" value={part} disabled={!!pending} onChange={event => setPart(event.target.value)} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-queue-label">给大肥鱼的备注（可选）</label><input id="cp-bili-queue-label" className="cp-input" maxLength={80} value={label} disabled={!!pending} onChange={event => setLabel(event.target.value)} /></div>
      </div>
      <button className="cp-button" type="submit" disabled={!!pending || !video.trim()}>{pending === 'add' ? '正在加入…' : '加入候选'}</button>
    </form>
    {feedback && <p className={feedback.error ? 'cp-error' : 'cp-hint'} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    {active.length ? <ul className="cp-bili-candidates">{active.map(item => <CandidateRow key={item.id} item={item} busy={!!pending} withdrawing={pending === item.id} withdraw={mutate} />)}</ul> : <p className="cp-hint">当前没有待处理候选。</p>}
    {!!history.length && <details className="cp-bili-history"><summary>最近处理记录（{history.length}）</summary>
      <ul className="cp-bili-candidates">{history.map(item => <CandidateRow key={item.id} item={item} busy={false} withdrawing={false} />)}</ul>
    </details>}
  </section>
}

function BilibiliSources({ sources, nextDiscoveryAt, enabled, reload }: {
  sources: BilibiliSource[]
  nextDiscoveryAt?: string
  enabled: boolean
  reload: () => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState<string>()
  const [feedback, setFeedback] = useState<{ message: string; error?: true }>()

  const mutate = async (sourceId?: string) => {
    const target = url.trim()
    if (pending || (!sourceId && !target)) return
    setPending(sourceId ?? 'add')
    setFeedback(undefined)
    try {
      if (sourceId) {
        await revokeBilibiliSource(sourceId)
        setFeedback({ message: '已撤回合集授权。' })
      } else {
        await addBilibiliSource({ url: target, label: label.trim() || undefined })
        setUrl('')
        setLabel('')
        setFeedback({ message: '合集已获授权。' })
      }
      await reload()
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setFeedback({ error: true, message: Object.hasOwn(SOURCE_ERRORS, code) ? SOURCE_ERRORS[code]! : '本次授权操作未完成，请重试。' })
      if (code === 'bili-source-unavailable') await reload()
    } finally { setPending(undefined) }
  }

  return <section className="cp-card" aria-labelledby="cp-bili-sources-title">
    <div className="cp-row cp-between"><h2 id="cp-bili-sources-title">授权公开合集</h2><span className="cp-status">{sources.length} 个合集</span></div>
    <p className="cp-hint">大肥鱼可以从你授权的合集发现候选。全局至少间隔 6 小时检查一次，同一个合集至少间隔 24 小时，每次最多加入 3 条候选。</p>
    <p className="cp-hint">撤回合集会停止后续检查，取消该合集尚未处理的候选，并保留历史记录。</p>
    <p className="cp-label">{!enabled ? '在「自主节律」开启后台自主任务和 B 站自主浏览后才会检查。'
      : !sources.length ? '添加合集后按自主节律检查。'
      : nextDiscoveryAt ? <>最早检查时间 <CandidateTime value={nextDiscoveryAt} />，免打扰和队列容量可能使检查延后。</>
      : '等待下一次调度。'}</p>
    <form onSubmit={event => { event.preventDefault(); void mutate() }}>
      <div className="cp-grid">
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-source-url">B 站公开合集链接</label><input id="cp-bili-source-url" className="cp-input" type="url" maxLength={512} placeholder="https://space.bilibili.com/123/lists/456?type=season" required value={url} disabled={!!pending} onChange={event => setUrl(event.target.value)} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-source-label">合集备注（可选）</label><input id="cp-bili-source-label" className="cp-input" maxLength={80} value={label} disabled={!!pending} onChange={event => setLabel(event.target.value)} /></div>
      </div>
      <button className="cp-button" type="submit" disabled={!!pending || !url.trim()}>{pending === 'add' ? '正在授权…' : '授权合集'}</button>
    </form>
    {feedback && <p className={feedback.error ? 'cp-error' : 'cp-hint'} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    {!!sources.length && <ul className="cp-bili-candidates">{sources.map(source => {
      const title = source.label || `合集 ${source.seasonId}`
      const link = `https://space.bilibili.com/${encodeURIComponent(source.mid)}/lists/${encodeURIComponent(source.seasonId)}?type=season`
      return <li className="cp-session" key={source.id}>
        <div className="cp-row cp-between">
          <a href={link} target="_blank" rel="noreferrer">{title}</a>
          <div className="cp-row">
            <span className="cp-status" data-state={source.status === 'unavailable' ? 'error' : source.status === 'waiting' ? undefined : 'success'}>{SOURCE_STATUS[source.status]}</span>
            <button className="cp-button" type="button" disabled={!!pending} aria-label={`撤回 ${title} 的授权`} onClick={() => void mutate(source.id)}>{pending === source.id ? '正在撤回…' : '撤回'}</button>
          </div>
        </div>
        <div className="cp-label">{source.lastCheckedAt ? '上次检查 ' : '授权于 '}<CandidateTime value={source.lastCheckedAt ?? source.createdAt} />{source.status === 'added' && source.lastAdded !== undefined && <> · 加入 {source.lastAdded} 条</>}</div>
        {source.error && <div className="cp-hint">{Object.hasOwn(SOURCE_ERRORS, source.error) ? SOURCE_ERRORS[source.error] : '本次检查未完成，将按节律重试。'}</div>}
      </li>
    })}</ul>}
  </section>
}

function BilibiliSubtitles({ documents, video, part, reading, selectTarget, reload }: {
  documents: BilibiliSubtitleDocument[]
  video: string
  part: string
  reading: boolean
  selectTarget: (document: BilibiliSubtitleDocument) => void
  reload: () => Promise<void>
}) {
  const [file, setFile] = useState<{ file: File; format: BilibiliSubtitleFormat }>()
  const [pending, setPending] = useState<string>()
  const [feedback, setFeedback] = useState<{ message: string; error?: true }>()
  const picker = useRef<HTMLInputElement>(null)
  const target = video.trim()
  const partNumber = part ? Number(part) : undefined
  const busy = reading || !!pending
  const clearPicker = () => {
    if (picker.current) picker.current.value = ''
    setFile(undefined)
  }
  const showError = (code: string) => {
    setFeedback({ error: true, message: Object.hasOwn(SUBTITLE_ERRORS, code) ? SUBTITLE_ERRORS[code]! : '字幕附件操作未完成，请稍后重试。' })
  }

  const mutate = async (document?: BilibiliSubtitleDocument) => {
    if (busy || (!document && (!file || !target))) return
    if (!document && partNumber !== undefined && (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 1000)) {
      showError('Invalid request')
      return
    }
    setPending(document ? `${document.bvid}/${document.part}` : 'upload')
    setFeedback(undefined)
    try {
      if (document) {
        await revokeBilibiliSubtitle(document.bvid, document.part)
        setFeedback({ message: '字幕附件已撤回。' })
      } else if (file) {
        const bytes = await file.file.arrayBuffer()
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
        catch { showError('bili-invalid-subtitle-file'); return }
        await importBilibiliSubtitle({ video: target, part: partNumber, format: file.format, content })
        clearPicker()
        setFeedback({ message: '字幕片段已绑定到所选分 P。' })
      }
      await reload()
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      showError(code)
      if (code === 'bili-subtitle-unavailable') await reload()
    } finally { setPending(undefined) }
  }

  return <section className="cp-card" aria-labelledby="cp-bili-subtitles-title">
    <div className="cp-row cp-between"><h2 id="cp-bili-subtitles-title">主人提供的字幕</h2><span className="cp-status">{documents.length} 份附件</span></div>
    <p className="cp-hint">附件绑定到上面选择的视频与分 P。同一分 P 再次导入会替换旧附件。工作台保存限长片段和来源摘要。撤回后停止使用附件，保留已有阅读回执。</p>
    <p className="cp-label">{target ? <>当前导入目标 <span className="cp-code">{target}</span> · {partNumber === undefined ? '沿用链接中的分 P，未指定时用第 1 P' : `第 ${part} P`}</> : '先在「查阅公开视频」填写 BV 号或视频链接。'}</p>
    <form onSubmit={event => { event.preventDefault(); void mutate() }}>
      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-bili-subtitle-file">字幕文件（SRT 或 WebVTT）</label>
        <input id="cp-bili-subtitle-file" className="cp-input" type="file" accept=".srt,.vtt" ref={picker} disabled={busy} onChange={event => {
          setFeedback(undefined)
          const selected = event.currentTarget.files?.[0]
          const format = /\.(srt|vtt)$/iu.exec(selected?.name ?? '')?.[1]?.toLowerCase()
          if (!selected) { setFile(undefined); return }
          if (format !== 'srt' && format !== 'vtt' || !selected.size || selected.size > MAX_BILIBILI_SUBTITLE_BYTES) {
            clearPicker()
            showError(selected.size > MAX_BILIBILI_SUBTITLE_BYTES ? 'bili-subtitle-too-large' : 'bili-invalid-subtitle-file')
            return
          }
          setFile({ file: selected, format })
        }} />
      </div>
      <div className="cp-actions"><button className="cp-button" type="submit" disabled={busy || !target || !file}>{pending === 'upload' ? '正在导入…' : '导入或替换字幕'}</button></div>
    </form>
    {feedback && <p className={feedback.error ? 'cp-error' : 'cp-hint'} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    {!!documents.length && <ul className="cp-bili-candidates">{documents.map(document => {
      const key = `${document.bvid}/${document.part}`
      const link = `https://www.bilibili.com/video/${encodeURIComponent(document.bvid)}/?p=${document.part}`
      return <li className="cp-session" key={key}>
        <div className="cp-row cp-between">
          <a href={link} target="_blank" rel="noreferrer">{document.bvid} · 第 {document.part} P</a>
          <div className="cp-row">
            <button className="cp-button" type="button" disabled={busy} onClick={() => {
              clearPicker()
              selectTarget(document)
              picker.current?.focus()
            }}>选为替换目标</button>
            <button className="cp-button" type="button" disabled={busy} aria-label={`撤回 ${document.bvid} 第 ${document.part} P 的字幕附件`} onClick={() => void mutate(document)}>{pending === key ? '正在撤回…' : '撤回字幕'}</button>
          </div>
        </div>
        <div className="cp-label">{document.format.toUpperCase()} · 原文件 {document.cueCount} 条 · 保留 {document.excerptCueCount} 条 · <CandidateTime value={document.updatedAt} /></div>
        <div className="cp-code">SHA-256 {document.sha256}</div>
      </li>
    })}</ul>}
  </section>
}

export function BilibiliPage({ data, reload, openSession, notify }: {
  data: WorkbenchView
  reload: () => Promise<void>
  openSession: (id: string) => Promise<void>
  notify: (error: unknown) => void
}) {
  const [video, setVideo] = useState('')
  const [part, setPart] = useState('')
  const [subtitles, setSubtitles] = useState(false)
  const [result, setResult] = useState<BilibiliReadResult>()
  const [readError, setReadError] = useState<string>()
  const [reading, setReading] = useState(false)
  const [opening, setOpening] = useState(false)
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])

  const binding = data.bindings.find(item => item.contextId === BILIBILI_CONTEXT)
  const open = async () => {
    if (opening) return
    setOpening(true)
    try {
      let sessionId = binding?.sessionId
      if (!binding || !data.sessions.some(session => session.id === sessionId)) {
        const scene = await createSession(binding ? { ...binding, resume: true } : { contextId: BILIBILI_CONTEXT, kind: 'topic', label: 'B 站浏览' })
        sessionId = scene.binding.sessionId
        await reload()
      }
      if (sessionId) await openSession(sessionId)
    } catch (error) { notify(error) }
    finally { setOpening(false) }
  }

  const read = async (event: FormEvent) => {
    event.preventDefault()
    if (pending.current || !video.trim()) return
    const controller = new AbortController()
    pending.current = controller
    setReading(true)
    setResult(undefined)
    setReadError(undefined)
    try {
      const next = await readBilibili({ video: video.trim(), part: part ? Number(part) : undefined, subtitles }, controller.signal)
      if (!controller.signal.aborted) setResult(next)
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof Error ? error.message : ''
        setReadError(Object.hasOwn(READ_ERRORS, code) ? READ_ERRORS[code] : '本次读取失败，请稍后重试。')
      }
    }
    finally {
      pending.current = undefined
      if (!controller.signal.aborted) setReading(false)
    }
  }

  return <>
    <section className="cp-card">
      <div className="cp-row cp-between"><h2>B 站浏览</h2><span className="cp-status">公开资料 · 只读</span></div>
      <p className="cp-hint">在专用会话里把 BV 号或视频链接发给大肥鱼，她可以先读资料，再决定是否需要字幕片段。</p>
      <p className="cp-hint">想让她看或听某一段，可以发送「看这段 BV1dLx46TEhw 00:12 6秒 画面和声音」。每次最多 12 秒，也可以只选「画面」或「声音」。画面使用会话的视觉模型，声音使用宿主的本地语音识别。</p>
      <div className="cp-actions">
        <button className="cp-button" data-primary type="button" disabled={opening || !!binding && binding.kind !== 'topic'} onClick={() => void open()}>
          {opening ? '正在打开…' : binding ? '打开浏览会话' : '创建浏览会话'}
        </button>
      </div>
      {binding && binding.kind !== 'topic' && <p className="cp-hint">请在场景页将 {BILIBILI_CONTEXT} 设为话题场景。</p>}
    </section>
    {data.bilibiliQueue?.sources && <BilibiliSources sources={data.bilibiliQueue.sources} nextDiscoveryAt={data.bilibiliQueue.nextDiscoveryAt}
      enabled={data.autonomy.settings.enabled && data.autonomy.settings.bilibiliEnabled === true} reload={reload} />}
    {data.bilibiliQueue && <BilibiliQueue queue={data.bilibiliQueue} autonomyEnabled={data.autonomy.settings.enabled} browsingEnabled={data.autonomy.settings.bilibiliEnabled === true} reload={reload} />}
    <form className="cp-card" onSubmit={event => void read(event)}>
      <h2>查阅公开视频</h2>
      <div className="cp-grid">
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-video">BV 号或完整视频链接</label><input id="cp-bili-video" className="cp-input" maxLength={512} required value={video} onChange={event => setVideo(event.target.value)} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-bili-part">分 P（可选）</label><input id="cp-bili-part" className="cp-input" type="number" min="1" max="1000" step="1" placeholder="沿用链接或读取第 1 P" value={part} onChange={event => setPart(event.target.value)} /></div>
      </div>
      {readError && <p className="cp-error" role="alert">{readError}</p>}
      <div className="cp-actions">
        <label className="cp-row"><input type="checkbox" checked={subtitles} onChange={event => setSubtitles(event.target.checked)} />{data.bilibiliSubtitles ? '同时尝试读取字幕片段' : '同时尝试读取一段公开字幕'}</label>
        <button className="cp-button" type="submit" disabled={reading || !video.trim()}>{reading ? '正在读取…' : '读取'}</button>
      </div>
    </form>
    {result && <section className="cp-card" aria-live="polite">
      <h2>{result.title}</h2>
      <p className="cp-hint">{result.owner} · 第 {result.part} / {result.parts} P · {timecode(result.partDurationSeconds)}</p>
      <p>{result.partTitle}</p>
      {result.description && <p>{result.description}</p>}
      <p><a href={result.url} target="_blank" rel="noreferrer">在 B 站打开原视频</a></p>
      {result.subtitle.status === 'unavailable' && <p className="cp-hint">{data.bilibiliSubtitles
        ? '本次取得了公开资料。当前分 P 暂无可读取的字幕片段。'
        : '本次取得了公开资料，当前分 P 暂无可读取的公开字幕。'}</p>}
      {result.subtitle.status === 'excerpt' && <>
        <h3>{result.subtitle.provenance?.kind === 'owner-supplied' ? '主人提供的字幕片段' : 'B 站公开字幕片段'}{result.subtitle.language !== 'und' && <> · {result.subtitle.language}</>}</h3>
        {result.subtitle.provenance?.kind === 'owner-supplied' && <p className="cp-code">SHA-256 {result.subtitle.provenance.sha256}</p>}
        <ul>{result.subtitle.cues.map((cue, index) => <li key={`${cue.from}:${index}`}><time dateTime={`PT${cue.from}S`}>{timecode(cue.from)}</time> {cue.text}</li>)}</ul>
        {result.subtitle.truncated && <p className="cp-hint">达到片段预算，后续字幕未读取。</p>}
      </>}
    </section>}
    {data.bilibiliSubtitles && <BilibiliSubtitles documents={data.bilibiliSubtitles} video={video} part={part} reading={reading}
      selectTarget={document => { setVideo(document.bvid); setPart(String(document.part)); setSubtitles(true) }} reload={reload} />}
  </>
}
