import { useCallback, useEffect, useRef, useState } from 'react'
import type { AvatarView, RealtimeVoiceView, TaskStatus } from '../core/model.ts'
import type { PresenterView } from '../protocol/presenter.ts'
import type { SingingTaskView } from '../protocol/singing.ts'
import { getAvatarState, getPresenterState, getRealtimeVoice, setPresenterRunning, startRealtimeVoice, startRealtimeSong, cancelRealtimeVoice } from './api.ts'

const TASK: Record<TaskStatus, string> = { accepted: '已接收', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const COUNTS: Record<string, string> = { parameters: '参数', parts: '部件', drawables: '画元', physics: '物理组', motions: '动作', expressions: '表情' }

function presenterAddress(value: string | undefined, mode: 'obs' | 'desktop'): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/' &&
        url.search === `?mode=${mode}` && !url.hash && !url.username && !url.password) return url.href
  } catch { /* The presenter may be absent or unavailable. */ }
  return undefined
}

function PresenterCard() {
  const [view, setView] = useState<PresenterView | null>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const request = useRef<{ controller: AbortController; mutation: boolean }>()
  const unsupported = useRef(false)
  const obsField = useRef<HTMLInputElement>(null)
  const sync = useCallback(async (running?: boolean) => {
    const mutation = running !== undefined
    if (request.current) {
      if (!mutation || request.current.mutation) return
      request.current.controller.abort()
    }
    const controller = new AbortController()
    request.current = { controller, mutation }
    if (mutation) {
      setBusy(true)
      setCopyNotice('')
    }
    try {
      const next = mutation ? await setPresenterRunning(running, controller.signal) : await getPresenterState(controller.signal)
      if (controller.signal.aborted) return
      if (next && typeof next.running !== 'boolean') throw new Error('invalid-presenter-state')
      unsupported.current = next === undefined
      setView(next ?? null)
      setError('')
    } catch {
      if (!controller.signal.aborted) setError(mutation ? (running ? '无法开启本机输出，请检查回环端口占用后重试。' : '停止请求未确认，请刷新状态后重试。') : '暂时无法读取本机输出状态。')
    } finally {
      if (request.current?.controller === controller) {
        request.current = undefined
        if (mutation) setBusy(false)
      }
    }
  }, [])
  useEffect(() => {
    void sync()
    const timer = setInterval(() => { if (!unsupported.current && !document.hidden) void sync() }, 5000)
    return () => {
      clearInterval(timer)
      request.current?.controller.abort()
      request.current = undefined
    }
  }, [sync])
  const obsUrl = view?.running ? presenterAddress(view.obsUrl, 'obs') : undefined
  const desktopUrl = view?.running ? presenterAddress(view.desktopUrl, 'desktop') : undefined
  const localBrowser = typeof window !== 'undefined' && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
  const copyObs = async () => {
    if (!obsUrl) return
    try {
      await navigator.clipboard.writeText(obsUrl)
      setCopyNotice('已复制 OBS 地址。')
    } catch {
      obsField.current?.focus()
      obsField.current?.select()
      setCopyNotice('已选中 OBS 地址，可手动复制。')
    }
  }
  const status = busy ? '正在处理' : error ? '需要检查' : view === null ? '宿主暂不支持' : view?.running ? '本机输出已开启' : view ? '未开启' : '正在读取'
  return <section className="cp-card" aria-busy={busy}>
    <div className="cp-row cp-between">
      <div><h2>桌面与 OBS 输出</h2><p className="cp-hint">复用现有 Live2D 舞台状态，独立呈现静音画面。</p></div>
      <span className="cp-status" role="status" data-state={view?.running && !error && !busy ? 'ready' : 'planned'}>{status}</span>
    </div>
    <p className="cp-hint">地址只在运行 Companion 的电脑上可用。远程访问工作台时，请在那台电脑打开桌面页或配置 OBS 浏览器源。</p>
    <div className="cp-actions">
      {view && <button type="button" className="cp-button" data-primary={!view.running} disabled={busy} onClick={() => void sync(!view.running)}>{view.running ? '关闭本机输出' : '开启本机输出'}</button>}
      <button type="button" className="cp-button" disabled={busy} onClick={() => void sync()}>刷新输出状态</button>
      {desktopUrl && localBrowser && <button type="button" className="cp-button" disabled={busy} onClick={() => window.open(desktopUrl, '_blank', 'popup,width=440,height=620,noopener,noreferrer')}>打开桌面窗口</button>}
    </div>
    {error && <p className="cp-error" role="alert">{error}</p>}
    {obsUrl && <div className="cp-field">
      <label className="cp-field"><span className="cp-label">OBS 浏览器源地址</span><input ref={obsField} className="cp-input" readOnly value={obsUrl} /></label>
      <div className="cp-row"><button type="button" className="cp-button" disabled={busy} onClick={() => void copyObs()}>复制 OBS 地址</button>{copyNotice && <span className="cp-hint" role="status">{copyNotice}</span>}</div>
      <p className="cp-hint cp-small">在 OBS 的「来源」添加「浏览器」，粘贴地址。可从 1280 × 720、30 FPS 开始，画面背景透明。</p>
    </div>}
    {desktopUrl && <label className="cp-field"><span className="cp-label">桌面窗口地址</span><input className="cp-input" readOnly value={desktopUrl} /></label>}
  </section>
}

export function AvatarPanel({ notify, songs, initialSong }: { notify: (error: unknown) => void; songs?: SingingTaskView[]; initialSong?: string }) {
  const [view, setView] = useState<AvatarView>()
  const [voice, setVoice] = useState<RealtimeVoiceView>()
  const [contextId, setContextId] = useState('chat.mobile')
  const [songId, setSongId] = useState(initialSong ?? '')
  const [songStage, setSongStage] = useState<{ id: string; unlocked: boolean; seenAt: number }>()
  const [busy, setBusy] = useState(false)
  const stage = useRef<HTMLIFrameElement>(null)
  const wakeStage = () => {
    if (window.location.origin !== 'null') stage.current?.contentWindow?.postMessage('companion:voice-state', window.location.origin)
  }
  const load = async () => {
    const [avatar, realtime] = await Promise.all([getAvatarState(), getRealtimeVoice()])
    setView(avatar)
    setVoice(realtime)
  }
  useEffect(() => {
    void load().catch(notify)
    const timer = setInterval(() => { if (!document.hidden) void load().catch(notify) }, 1000)
    const stageReady = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== stage.current?.contentWindow) return
      const message = event.data
      if (message?.type !== 'companion:stage-ready' || typeof message.stageId !== 'string' || typeof message.audioUnlocked !== 'boolean') return
      setSongStage({ id: message.stageId, unlocked: message.audioUnlocked, seenAt: Date.now() })
    }
    window.addEventListener('message', stageReady)
    return () => { clearInterval(timer); window.removeEventListener('message', stageReady) }
  }, [])
  const start = async (streaming?: boolean) => {
    setBusy(true)
    try {
      setVoice(await startRealtimeVoice(contextId.trim(), undefined, streaming))
      wakeStage()
    }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const cancel = async () => {
    setBusy(true)
    try {
      setVoice(await cancelRealtimeVoice(voice?.session?.id))
      wakeStage()
    }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const playSong = async () => {
    if (!songStage) return
    setBusy(true)
    try {
      setVoice(await startRealtimeSong(songId, songStage.id))
      wakeStage()
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const activeVoice = voice?.session && ['preparing', 'playing', 'cancelling'].includes(voice.session.status)
  const cannotStart = busy || activeVoice || !view?.presentation?.ready || !contextId.trim()
  const canPlaySong = !busy && !activeVoice && !!songStage?.unlocked && Date.now() - songStage.seenAt < 5000 && songs?.some(item => item.task.id === songId && item.audio)
  return <>
    <section className="cp-card">
      <div className="cp-row cp-between"><div><h2>她的 Live2D 形象</h2><p className="cp-hint">{view?.detail ?? '正在读取形象状态…'}</p></div><span className="cp-status" data-state={view?.presentation?.ready ? 'ready' : 'planned'}>{view?.presentation?.ready ? '真实渲染在线' : '等待舞台'}</span></div>
      {view?.model && <div className="cp-row" style={{ flexWrap: 'wrap', gap: 16 }}>{Object.entries(view.model.counts).map(([key, value]) => <span className="cp-label" key={key}>{COUNTS[key] ?? key} {value}</span>)}{view.presentation?.parameterCount && <span className="cp-label">运行时参数 {view.presentation.parameterCount}</span>}</div>}
      {view?.presentation && <p className="cp-hint cp-small">实际渲染帧 {view.presentation.frames} · 异常参数 {view.presentation.nonFinite} · {view.presentation.renderer ?? 'WebGL'}</p>}
    </section>
    <PresenterCard />
    {view?.available ? <iframe ref={stage} title="大肥鱼 Live2D 舞台" src="/companion/avatar/" onLoad={() => { setSongStage(undefined); void load().catch(notify) }} sandbox="allow-scripts allow-same-origin" style={{ display: 'block', width: '100%', minHeight: 650, border: 0, borderRadius: 14, background: '#f4f8fc' }} /> : <section className="cp-empty">{view?.detail ?? '正在检查私有模型与 Core。'} 形象不可用不会阻塞聊天。</section>}
    <section className="cp-card"><div className="cp-row cp-between"><div><h2>分段语音与真实口型</h2><p className="cp-hint">从场景的真实助手消息生成；合成完成不等于播放完成。</p></div><span className="cp-status" data-state={activeVoice ? 'running' : voice?.session?.status === 'succeeded' ? 'ready' : 'planned'}>{voice?.session?.status ?? '待播放'}</span></div>
      <div className="cp-row" style={{ flexWrap: 'wrap' }}>
        <input className="cp-input" style={{ flex: 1 }} value={contextId} onChange={event => setContextId(event.target.value)} placeholder="场景 ID，例如 chat.mobile" />
        <button className="cp-button" data-primary disabled={cannotStart} onClick={() => void start()}>播放最近回复</button>
        {voice?.streamingAvailable && <button className="cp-button" disabled={cannotStart} onClick={() => void start(false)}>用 WAV 播放</button>}
        <button className="cp-button" disabled={busy || !activeVoice} onClick={() => void cancel()}>停止舞台音频</button>
      </div>
      {voice?.session && <><p className="cp-hint">{voice.session.kind === 'song' ? `${voice.session.title ?? '归档歌曲'} · 舞台歌唱` : `${voice.session.contextId} · ${voice.session.streaming ? 'PCM 流式' : 'WAV 分段'} · ${voice.session.segments.length} 段`}{voice.session.error ? ` · ${voice.session.error}` : ''}</p>{voice.session.segments.map(segment => <div className="cp-row cp-between" key={segment.index}><span>第 {segment.index + 1} 段 · {segment.status}{segment.positionMs !== undefined ? ` · ${segment.positionMs}ms` : ''}</span><span className="cp-label">{segment.energy !== undefined ? `能量 ${segment.energy.toFixed(3)}` : segment.status}</span></div>)}</>}
      {view?.presentation?.voice && <p className="cp-hint">舞台 {view.presentation.voice.audioContextState} · 播放 {view.presentation.voice.positionMs}ms · 实测口型能量 {view.presentation.voice.energy.toFixed(3)}{view.presentation.voice.error ? ` · ${view.presentation.voice.error}` : ''}</p>}
      <p className="cp-hint cp-small">手动播放前请在上方舞台点击“启用声音”。也可在舞台选择场景并开启自动朗读，停止语音会同时关闭自动朗读。</p>
    </section>
    <section className="cp-card">
      <h2>归档歌曲</h2>
      <p className="cp-hint">在上方舞台启用声音，再选择已归档的歌曲。舞台按实际播放音量驱动口型。</p>
      <div className="cp-row">
        <select className="cp-select" aria-label="选择舞台歌曲" style={{ flex: 1 }} value={songId} onChange={event => setSongId(event.target.value)}>
          <option value="">选择歌曲</option>
          {songs?.filter(item => item.audio).map(({ task }) => <option value={task.id} key={task.id}>{task.title}</option>)}
        </select>
        <button className="cp-button" type="button" disabled={!canPlaySong} onClick={() => void playSong()}>在舞台播放</button>
      </div>
    </section>
    <section className="cp-card"><div className="cp-row cp-between"><h2>动作回执</h2><span className="cp-label">只有舞台完成才成功</span></div>{view?.tasks.length ? view.tasks.map(task => <div className="cp-row cp-between" key={task.id}><div><strong>{task.title}</strong><div className="cp-code">{task.id}</div>{task.error && <div className="cp-error">{task.error}</div>}</div><span className="cp-status" data-state={task.status}>{TASK[task.status]}</span></div>) : <div className="cp-empty">尚无动作任务。可在上方舞台尝试一个基础表情或动作。</div>}<p className="cp-hint cp-small">{view?.credits ?? '原画及拆分：神宫凉子 · Live2D 建模：霓虹猫_NeonNeko'}。模型与 Core 不随插件重新分发。</p></section>
  </>
}
