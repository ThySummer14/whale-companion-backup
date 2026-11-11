import { useEffect, useRef, useState, type FormEvent } from 'react'
import { SINGING_CONTEXT, type TaskStatus } from '../core/model.ts'
import type { WorkbenchView } from '../protocol/api.ts'
import { MAX_SINGING_WAV_BYTES, type SingingCoverEngine, type SingingTaskView } from '../protocol/singing.ts'
import { parseScoreDraft } from '../protocol/singing-score.ts'
import { cancelSong, createSession, getSongAudio, submitCover, submitScoreSong, submitSong, submitSourceCover } from './api.ts'
import { SingingMidiImport } from './singing-midi.tsx'

const TASK: Record<TaskStatus, string> = { accepted: '已接收', running: '正在生成', succeeded: '已归档', failed: '失败', cancelled: '已取消' }
const COVER_PHASE: Record<NonNullable<SingingTaskView['coverPhase']>, string> = {
  synthesizing: '正在按谱生成人声', separating: '正在分离人声和伴奏', converting: '正在转换人声', mixing: '正在混音', archiving: '正在归档',
}
const COVER_ENGINE: Record<SingingCoverEngine, string> = { 'seed-vc': 'Seed-VC', 'applio-rvc': 'Applio RVC' }
const SCORE_EXAMPLE = 'C4 1 海\nD4 1 风\nE4 1 轻\nG4 1 轻\nR 0.5\nE4 1 吹\nD4 2 来\nC4 2 _'
const ERRORS: Readonly<Record<string, string>> = {
  'singing-unavailable': '宿主尚未配置本地歌唱引擎。',
  'singing-busy': '已经有一首歌在生成中。',
  'singing-provider-busy': '歌唱引擎还在处理上一项请求。',
  'singing-audio-unavailable': '归档音频暂不可播放，请查看任务和媒体记录。',
  'singing-cover-unavailable': '宿主尚未配置本地换声引擎。',
  'singing-rvc-assets-unavailable': '本地 RVC 引擎或模型文件缺失，请检查宿主的换声配置。',
  'singing-reference-unavailable': 'Seed-VC 参考音频不可用，请检查宿主配置。',
  'singing-cover-timeout': '换声超时，可用较短的音源重试。',
  'singing-cover-failed': '本地换声失败，请检查宿主的换声配置。',
  'singing-cover-output-invalid': '换声引擎未返回有效的 WAV 文件。',
  'singing-guide-too-large': '导唱超过 24 MiB。',
  'singing-accompaniment-too-large': '伴奏超过 24 MiB。',
  'singing-cover-too-large': '导唱和伴奏超过本次上传上限。',
  'singing-invalid-accompaniment': '伴奏需为非静音的 PCM16 WAV。',
  'singing-invalid-gain': '音量须在 −30 到 +6 dB 之间。',
  'singing-invalid-guide': '请选择 3–60 秒的非静音 PCM16 WAV 人声导唱。',
  'singing-source-cover-unavailable': '宿主需要同时配置本地分轨和换声引擎。',
  'singing-invalid-source': '请填写作品名并选择 3–60 秒的非静音 PCM16 WAV 音源。',
  'singing-source-too-large': '音源超过 24 MiB。',
  'singing-separator-unavailable': '本地分轨模型不可用，请检查宿主配置。',
  'singing-separation-timeout': '分轨超时，可用更短的音源重试。',
  'singing-separation-failed': '本地分轨失败，请检查音源或宿主分轨配置。',
  'singing-separation-output-invalid': '本地分轨引擎未返回有效的 WAV 音轨。',
  'singing-invalid-stems': '分轨结果缺少有效的人声或伴奏，或与音源时长不符。请更换音源后重试。',
  'singing-score-invalid': '请检查短谱的音高、拍数、歌词和总时长。',
  'singing-score-unsegmentable': '曲谱无法按音节完整分段。请缩短过长的延音或连续休止。',
  'singing-score-unavailable': '宿主尚未配置本地按谱唱引擎和换声引擎。',
  'singing-score-assets-unavailable': '按谱唱所需的模型或参考人声不可用，请检查宿主配置。',
  'singing-score-output-invalid': '引擎生成的人声无法验证，请检查任务和谱面。',
  'singing-score-failed': '按谱唱失败，请检查谱面或宿主的引擎配置。',
  'singing-score-timeout': '按谱唱超时，可尝试缩短谱面。',
}

export function SingingPage({ data, reload, openSession, openStage }: {
  data: WorkbenchView
  reload: () => Promise<void>
  openSession: (id: string) => Promise<void>
  openStage: (songTaskId: string) => void
}) {
  const [title, setTitle] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [style, setStyle] = useState('中文演唱，轻柔的流行短歌')
  const [duration, setDuration] = useState('20')
  const [scoreTitle, setScoreTitle] = useState('')
  const [scoreBpm, setScoreBpm] = useState('90')
  const [scoreText, setScoreText] = useState('')
  const [sourceTitle, setSourceTitle] = useState('')
  const [sourceFile, setSourceFile] = useState<File>()
  const [sourceAuthorized, setSourceAuthorized] = useState(false)
  const sourcePicker = useRef<HTMLInputElement>(null)
  const [coverTitle, setCoverTitle] = useState('')
  const [guide, setGuide] = useState<File>()
  const [backing, setBacking] = useState<File>()
  const [vocalGain, setVocalGain] = useState('-2')
  const [backingGain, setBackingGain] = useState('-10')
  const guidePicker = useRef<HTMLInputElement>(null)
  const backingPicker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState<{ id: string; url: string }>()
  const pendingAudio = useRef<AbortController>()
  useEffect(() => () => pendingAudio.current?.abort(), [])
  useEffect(() => { if (preview) return () => URL.revokeObjectURL(preview.url) }, [preview])

  const view = data.singing
  const coverEngine = view?.coverEngine && COVER_ENGINE[view.coverEngine]
  const queued = view?.tasks.some(({ task }) => task.status === 'accepted' || task.status === 'running')
  const scoreMax = view?.scoreMaxSeconds ?? 24
  const draft = scoreText.trim() ? parseScoreDraft(scoreText, Number(scoreBpm)) : undefined
  const parsedScore = draft && 'duration' in draft && (draft.duration > scoreMax || (scoreMax <= 24 && draft.phrases.length > 1))
    ? { error: `当前宿主只支持一段最多 ${scoreMax} 秒的短谱。` } : draft
  const scoreHint = !parsedScore ? '可先填入示例试唱。'
    : 'error' in parsedScore ? parsedScore.error
      : `${parsedScore.notes.length} 个音符与休止，预计 ${parsedScore.duration.toFixed(1)} 秒，共 ${parsedScore.phrases.length} 段合成。`
  const sourceError = sourceFile && (sourceFile.size > MAX_SINGING_WAV_BYTES ? ERRORS['singing-source-too-large'] : sourceFile.size === 0 ? ERRORS['singing-invalid-source'] : undefined)
  const binding = data.bindings.find(item => item.contextId === SINGING_CONTEXT)
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try { await action() }
    catch (failure) {
      const code = failure instanceof Error ? failure.message : ''
      setError(Object.hasOwn(ERRORS, code) ? ERRORS[code] : '操作未完成，请查看歌唱任务状态。')
    } finally { setBusy(false) }
  }
  const start = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      await submitSong({ title: title.trim(), lyrics: lyrics.trim(), style: style.trim(), durationSeconds: Number(duration) })
      await reload()
    })
  }
  const singScore = (event: FormEvent) => {
    event.preventDefault()
    if (!view?.scoreAvailable || queued || !parsedScore || 'error' in parsedScore || !scoreTitle.trim()) return
    void run(async () => {
      await submitScoreSong({ title: scoreTitle.trim(), bpm: Number(scoreBpm), notes: parsedScore.notes })
      await reload()
    })
  }
  const coverSource = (event: FormEvent) => {
    event.preventDefault()
    if (!view?.sourceCoverAvailable || queued || !sourceFile || sourceError || !sourceTitle.trim() || !sourceAuthorized) return
    void run(async () => {
      await submitSourceCover(sourceTitle.trim(), sourceFile)
      setSourceFile(undefined)
      setSourceAuthorized(false)
      if (sourcePicker.current) sourcePicker.current.value = ''
      await reload()
    })
  }
  const convert = (event: FormEvent) => {
    event.preventDefault()
    if (!guide || !coverTitle.trim()) return
    void run(async () => {
      if (guide.size > MAX_SINGING_WAV_BYTES) throw new Error('singing-guide-too-large')
      if (backing && backing.size > MAX_SINGING_WAV_BYTES) throw new Error('singing-accompaniment-too-large')
      await submitCover(coverTitle.trim(), guide, backing && { accompaniment: backing, vocalGainDb: Number(vocalGain), backingGainDb: Number(backingGain) })
      setGuide(undefined)
      setBacking(undefined)
      if (guidePicker.current) guidePicker.current.value = ''
      if (backingPicker.current) backingPicker.current.value = ''
      await reload()
    })
  }
  const listen = ({ task, audio }: SingingTaskView) => {
    if (!audio) return
    void run(async () => {
      pendingAudio.current?.abort()
      const controller = new AbortController()
      pendingAudio.current = controller
      const blob = await getSongAudio(task.id, audio.bytes, controller.signal)
      if (!controller.signal.aborted) setPreview({ id: task.id, url: URL.createObjectURL(blob) })
    })
  }
  const open = () => void run(async () => {
    let session = binding?.sessionId
    if (!binding || !data.sessions.some(item => item.id === session)) {
      const { binding: ready } = await createSession(binding ? { ...binding, resume: true } : { contextId: SINGING_CONTEXT, kind: 'topic', label: '歌唱' })
      session = ready.sessionId
      await reload()
    }
    if (session) await openSession(session)
  })

  return <>
    <section className="cp-card">
      <div className="cp-row cp-between"><h2>歌唱</h2><span className="cp-status">{view?.available || view?.coverAvailable || view?.scoreAvailable ? '已配置本地引擎' : '等待配置本地引擎'}</span></div>
      <p className="cp-hint">填写歌词和风格，或在专用会话请大肥鱼提交短歌。可播放结果以已归档的 WAV 为准，声线由本地引擎提供。</p>
      {data.singingConversation && data.singingConversation.wavAvailable !== false && <p className="cp-hint">也可以在歌唱会话附上一份有权使用的 WAV，并发送「帮我翻唱这段，歌名叫……」。会话附件最多 8 MiB，提交后可继续问大肥鱼进度。</p>}
      {data.singingConversation?.midiMaxBytes && <p className="cp-hint">也可以在歌唱会话附上一份 MIDI，用「按谱唱 MIDI」开头，分行填写曲名、轨道、通道、起始和音符数。歌词可选。</p>}
      {view?.scoreAvailable && <p className="cp-hint">也可以在歌唱会话以「按谱唱」开头，给出曲名、速度和带歌词的音符。</p>}
      {data.singingConversation?.shareAvailable && <p className="cp-hint">在歌唱会话发送「发布歌唱动态：曲名」，即可分享该会话已归档的歌曲。发送「撤下歌唱动态：曲名」可撤下动态并保留歌唱归档。</p>}
      <button className="cp-button" type="button" disabled={busy || !(view?.available || data.singingConversation || view?.scoreAvailable) || !!binding && binding.kind !== 'topic'} onClick={open}>{binding ? '打开歌唱会话' : '创建歌唱会话'}</button>
      {binding && binding.kind !== 'topic' && <p className="cp-hint">请在场景页将 {SINGING_CONTEXT} 设为话题场景。</p>}
    </section>
    {error && <div className="cp-error" role="alert">{error}</div>}
    {view?.scoreAvailable !== undefined && <section className="cp-card cp-stack">
      <div className="cp-row cp-between">
        <h2>按谱唱</h2>
        <span className="cp-status">{view.scoreAvailable ? '按谱唱已启用' : '等待配置本地引擎'}</span>
      </div>
      <p className="cp-hint">输入 4–{scoreMax} 秒的中文单声部曲谱。大肥鱼按音高和时值生成清唱，再换成配置的声线。</p>
      {view.scoreAvailable && <>
        <SingingMidiImport disabled={busy} hasDraft={!!scoreText.trim()} apply={({ bpm, text }, filename) => {
          setScoreTitle(current => current || Array.from(filename.replace(/\.midi?$/iu, '').trim()).slice(0, 40).join(''))
          setScoreBpm(String(bpm))
          setScoreText(text)
        }} />
        <form className="cp-stack" onSubmit={singScore}>
          <div className="cp-grid">
            <label className="cp-field">
              <span className="cp-label">曲名</span>
              <input className="cp-input" maxLength={80} required disabled={busy} value={scoreTitle} onChange={event => setScoreTitle(event.target.value)} />
            </label>
            <label className="cp-field">
              <span className="cp-label">速度（BPM）</span>
              <input className="cp-input" type="number" min={60} max={180} step={1} required disabled={busy} value={scoreBpm} onChange={event => setScoreBpm(event.target.value)} />
            </label>
          </div>
          <label className="cp-field">
            <span className="cp-label">音符与歌词</span>
            <textarea className="cp-textarea" maxLength={8192} required disabled={busy} value={scoreText}
              placeholder={'C4 1 海\n62 1 风\nR 0.5'} spellCheck={false} aria-describedby="cp-score-format cp-score-preview"
              onChange={event => setScoreText(event.target.value)} />
          </label>
          <p className="cp-hint cp-small" id="cp-score-format">每行用空格分开音高、拍数和一个汉字。音高可写 C4 或数字 60，R 表示休止，_ 延续前一个音节。拍数以 0.25 拍递增。</p>
          <p className="cp-hint cp-small" id="cp-score-preview" aria-live="polite">{scoreHint}</p>
          <div className="cp-row">
            <button className="cp-button" data-primary type="submit" disabled={busy || queued || !parsedScore || 'error' in parsedScore || !scoreTitle.trim()}>{queued ? '已有歌曲正在处理' : '按谱演唱'}</button>
            <button className="cp-button" type="button" disabled={busy || !!scoreText.trim()} onClick={() => {
              setScoreTitle(current => current || '海风练习')
              setScoreBpm('90')
              setScoreText(SCORE_EXAMPLE)
            }}>填入示例</button>
          </div>
        </form>
      </>}
    </section>}
    <form className="cp-card cp-stack" onSubmit={start}>
      <div className="cp-grid">
        <label className="cp-field"><span className="cp-label">歌名</span><input className="cp-input" maxLength={80} required value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label className="cp-field"><span className="cp-label">风格</span><input className="cp-input" maxLength={200} required value={style} onChange={event => setStyle(event.target.value)} /></label>
        <label className="cp-field"><span className="cp-label">时长（10–60 秒）</span><input className="cp-input" type="number" min={10} max={60} step={1} required value={duration} onChange={event => setDuration(event.target.value)} /></label>
      </div>
      <label className="cp-field"><span className="cp-label">歌词</span><textarea className="cp-textarea" maxLength={1200} required value={lyrics} onChange={event => setLyrics(event.target.value)} /></label>
      <div><button className="cp-button" data-primary type="submit" disabled={busy || queued || !view?.available || !title.trim() || !lyrics.trim() || !style.trim()}>{queued ? '已有歌曲正在处理' : '生成短歌'}</button></div>
    </form>
    <form className="cp-card cp-stack" onSubmit={coverSource}>
      <div className="cp-row cp-between"><h2>单文件翻唱</h2><span className="cp-status">{view?.sourceCoverAvailable ? '本地分轨和换声已启用' : '等待配置分轨和换声'}</span></div>
      <p className="cp-hint">选择一段包含人声和伴奏的 PCM16 WAV。宿主自动分轨、转换人声并重新混音，成品归档后可试听和上台播放。音源须为 3–60 秒，最多 24 MiB。</p>
      {view?.sourceCoverAvailable && <>
        {coverEngine && <p className="cp-hint">换声引擎为 {coverEngine}</p>}
        <div className="cp-grid">
          <label className="cp-field"><span className="cp-label">作品名</span><input className="cp-input" maxLength={80} required disabled={busy} value={sourceTitle} onChange={event => setSourceTitle(event.target.value)} /></label>
          <label className="cp-field"><span className="cp-label">原曲 WAV</span><input className="cp-input" type="file" ref={sourcePicker} accept=".wav,audio/wav,audio/x-wav" required disabled={busy} aria-invalid={!!sourceError} onChange={event => {
            setSourceFile(event.target.files?.[0])
            setSourceAuthorized(false)
          }} /></label>
        </div>
        {sourceError && <p className="cp-hint" role="alert">{sourceError}</p>}
        <label className="cp-row"><input type="checkbox" required disabled={busy || !sourceFile || !!sourceError} checked={sourceAuthorized} onChange={event => setSourceAuthorized(event.target.checked)} />我有权使用这个音源，并同意由宿主分轨和换声</label>
        <div><button className="cp-button" data-primary type="submit" disabled={busy || queued || !sourceFile || !!sourceError || !sourceTitle.trim() || !sourceAuthorized}>{queued ? '已有歌曲正在处理' : '分轨并翻唱'}</button></div>
      </>}
    </form>
    <form className="cp-card cp-stack" onSubmit={convert}>
      <div className="cp-row cp-between"><h2>转换导唱声线</h2><span className="cp-status">{view?.coverAvailable ? `已配置 ${coverEngine ?? '本地换声引擎'}` : '等待配置换声引擎'}</span></div>
      <p className="cp-hint">上传独立人声导唱，可同时提供单独的伴奏。引擎先转换导唱声线，再按同一起点混合，输出时长以转换后的人声为准。每轨最多 24 MiB，导唱为 3–60 秒的 PCM16 WAV。</p>
      <div className="cp-grid">
        <label className="cp-field"><span className="cp-label">作品名</span><input className="cp-input" maxLength={80} required value={coverTitle} onChange={event => setCoverTitle(event.target.value)} /></label>
        <label className="cp-field"><span className="cp-label">导唱 WAV</span><input className="cp-input" type="file" ref={guidePicker} accept=".wav,audio/wav,audio/x-wav" required onChange={event => setGuide(event.target.files?.[0])} /></label>
        <label className="cp-field"><span className="cp-label">伴奏 WAV（可选）</span><input className="cp-input" type="file" ref={backingPicker} accept=".wav,audio/wav,audio/x-wav" onChange={event => setBacking(event.target.files?.[0])} /></label>
        {backing && <>
          <label className="cp-field"><span className="cp-label">人声音量（dB）</span><input className="cp-input" type="number" min={-30} max={6} step={0.1} required value={vocalGain} onChange={event => setVocalGain(event.target.value)} /></label>
          <label className="cp-field"><span className="cp-label">伴奏音量（dB）</span><input className="cp-input" type="number" min={-30} max={6} step={0.1} required value={backingGain} onChange={event => setBackingGain(event.target.value)} /></label>
        </>}
      </div>
      <div><button className="cp-button" type="submit" disabled={busy || queued || !view?.coverAvailable || !guide || !coverTitle.trim()}>{backing ? '转换并混合' : '转换声线'}</button></div>
    </form>
    <section className="cp-card">
      <h2>歌唱任务与归档</h2>
      {view?.tasks.length ? view.tasks.map(item => <div className="cp-session" key={item.task.id}>
        <div className="cp-row cp-between"><strong>{item.task.title}</strong><span className="cp-status" aria-live="polite" data-state={item.task.status}>{item.task.status === 'running' && item.coverPhase ? COVER_PHASE[item.coverPhase] ?? TASK.running : TASK[item.task.status]}</span></div>
        {item.scoreProgress && <p className="cp-hint cp-small" aria-live="polite">换声进度 {item.scoreProgress.completed}/{item.scoreProgress.total}</p>}
        <p className="cp-meta">{new Date(item.task.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>
        {item.task.error && <p className="cp-hint">{Object.hasOwn(ERRORS, item.task.error) ? ERRORS[item.task.error] : item.task.error}</p>}
        {(item.task.status === 'accepted' || item.task.status === 'running') && <button className="cp-button" type="button" disabled={busy} onClick={() => void run(async () => { await cancelSong(item.task.id); await reload() })}>取消</button>}
        {item.audio && <div className="cp-row">
          <button className="cp-button" type="button" disabled={busy} onClick={() => listen(item)}>载入试听</button>
          <button className="cp-button" type="button" disabled={busy} onClick={() => openStage(item.task.id)}>在舞台选中</button>
          <span className="cp-label">WAV · {(item.audio.bytes / 1024 / 1024).toFixed(1)} MiB{item.audio.durationSeconds ? ` · ${item.audio.durationSeconds.toFixed(1)} 秒` : ''}</span>
          {item.coverEngine && COVER_ENGINE[item.coverEngine] && <span className="cp-label">换声 · {COVER_ENGINE[item.coverEngine]}</span>}
        </div>}
        {item.task.status === 'succeeded' && !item.audio && <p className="cp-hint">任务已完成，归档音频当前不可用。</p>}
        {preview?.id === item.task.id && <div className="cp-actions"><audio controls src={preview.url} /><a href={preview.url} download={`song-${item.task.id}.wav`}>下载 WAV</a></div>}
      </div>) : <p className="cp-empty">生成后在这里查看任务、试听和下载。</p>}
    </section>
  </>
}
