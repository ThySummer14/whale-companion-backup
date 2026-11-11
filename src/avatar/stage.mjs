import { RealtimeVoicePlayer } from './voice.mjs'
import { StageActivity } from './context-motion.mjs'
import { makeActionJob } from './action-job.mjs'
import { createAvatarRenderer } from './renderer.mjs'

const $ = id => document.getElementById(id)
let scene, engine, active, ready = false, renderedMouthOpen, lastError, receiptChain = Promise.resolve(), beating = false
const basePath = '/companion/avatar'
const stageId = window.crypto?.randomUUID?.()
const stageActivity = new StageActivity()
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const activityLabels = { chatting: '情境 · 聊天', minecraft: '情境 · Minecraft', browsing: '情境 · 阅读', resting: '情境 · 安静时段', speaking: '情境 · 舞台朗读', singing: '情境 · 舞台歌唱' }
let pageActive = true, heartbeatError, requestingAction = false
let autoEnabled = false, autoPending = false, autoBusy = false, autoRevision = 0, nextAutoPoll = 0, autoError
const api = async (path, data) => {
  const response = await fetch(`${basePath}/api${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'x-companion-request': '1', ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
  return value
}
const voice = new RealtimeVoicePlayer(api, stageId)
void voice.setSongForeground(!document.hidden)
function actionReady() {
  return pageActive && !document.hidden && navigator.onLine !== false
}

function contextEnabled() {
  return actionReady() && $('context-motion').checked && !reduceMotion.matches
}

function currentActivity(now = performance.now()) {
  return contextEnabled() ? stageActivity.current(now) : undefined
}

function telemetry() {
  if (!engine) return { ready: false, error: lastError }
  const { model, profile, renderer, parameterCount } = scene
  const coreModel = model.internalModel.coreModel
  const nonFinite = profile.allParameters.filter(item => !Number.isFinite(coreModel.getParameterValueById(item.id))).length
  const clippingMaskBufferSize = model.internalModel.renderer?._clippingManager?.getClippingMaskBufferSize?.()
  return { ready, frames: engine.frames, nonFinite, renderer, parameterCount, clippingMaskBufferSize, mouthOpen: renderedMouthOpen, jobId: active?.taskId, status: engine.lastStatus, error: heartbeatError ?? lastError, voice: voice.telemetry(), ...(stageId && { stageId, actionReady: actionReady(), songReady: voice.songReady }) }
}
function update() {
  const state = telemetry()
  const homeActivity = currentActivity()
  const status = state.error ? '需要检查' : state.voice?.playing ? state.voice.kind === 'song' ? '正在演唱' : '正在说话' : active ? '动作中' : ready ? activityLabels[homeActivity] ?? '自然待机' : '正在唤醒'
  if ($('status').textContent !== status) $('status').textContent = status
  $('telemetry').textContent = JSON.stringify({ ...state, homeActivity }, null, 2)
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = !ready || !state.actionReady || !!active || requestingAction })
  $('stop').disabled = !active || active.settling
  $('voice-stop').disabled = !voice.canInterrupt
  $('voice-stop').textContent = voice.session?.kind === 'song' && voice.canInterrupt ? '停止歌曲' : '停止语音'
  $('voice-auto-scene').disabled = autoEnabled || autoBusy || !ready || !stageId
  $('voice-auto').disabled = autoBusy || !ready || !stageId || !$('voice-auto-scene').value
  $('voice-auto').textContent = autoEnabled ? '关闭自动朗读' : '开启自动朗读'
  const autoStatus = autoError ? `自动朗读需要检查：${autoError}` : autoEnabled
    ? autoPending ? '已保留最新的回复，当前播放结束后朗读。' : '正在等待选定场景完成的新回复。'
    : '自动朗读已关闭。开启后仅朗读选定场景的新回复。'
  if ($('voice-auto-status').textContent !== autoStatus) $('voice-auto-status').textContent = autoStatus
  document.body.dataset.ready = String(ready)
  document.body.dataset.frames = String(state.frames ?? 0)
}
async function beat() {
  if (beating || !ready) return
  beating = true
  try {
    const state = telemetry()
    const revision = stageActivity.revision
    const startedAt = performance.now()
    let view
    try { view = await api('/heartbeat', state) }
    catch (error) {
      stageActivity.clear()
      heartbeatError = error.message
      voice.songPlaybackError(error)
      return
    }
    heartbeatError = undefined
    if (contextEnabled() && state.ready && state.frames > 0 && state.nonFinite === 0) stageActivity.receive(view.homeActivity, startedAt, revision)
    else stageActivity.clear()
    if (state.stageId && window.parent !== window && window.location.origin !== 'null') {
      window.parent.postMessage({ type: 'companion:stage-ready', stageId, audioUnlocked: state.songReady }, window.location.origin)
    }
    await voice.tick()
    if (active && !active.settling && view.stopRequestIds.includes(active.taskId)) {
      const taskId = active.taskId
      engine.stop()
      await report('cancelled', { id: taskId })
    }
    if (!active && actionReady()) {
      for (const taskId of view.stopRequestIds) {
        if (view.pendingActions.some(item => item.taskId === taskId)) await report('cancelled', { id: taskId })
      }
      const pending = view.pendingActions.find(item => !view.stopRequestIds.includes(item.taskId))
      if (pending && actionReady()) {
        const action = pending.action.id
        active = { taskId: pending.taskId, action }
        try {
          const job = await makeActionJob(pending.taskId, action, engine.params, basePath)
          if (actionReady()) engine.start(job)
          else active = undefined
        } catch (error) {
          lastError = error.message
          engine.stop()
          await report('error', { id: pending.taskId })
        }
      }
    }
    if (autoEnabled && !autoBusy && performance.now() >= nextAutoPoll) {
      const revision = autoRevision
      nextAutoPoll = performance.now() + 1000
      try {
        const state = await api('/realtime/auto/poll', { stageId })
        if (revision === autoRevision) {
          setAutoReadEnabled(state.enabled)
          autoPending = state.pending === true
          autoError = undefined
          if (state.started === true) await voice.tick()
        }
      } catch (error) {
        if (revision === autoRevision) autoError = error.message
      }
    }
  } catch (error) { lastError = error.message }
  finally { beating = false; update() }
}
function setAutoReadEnabled(enabled) {
  autoEnabled = enabled
  voice.setAutoReadEnabled(enabled)
  if (!enabled) autoPending = false
}
async function loadAutoScenes() {
  if (!stageId || autoEnabled) return
  const select = $('voice-auto-scene')
  try {
    const scenes = await api('/realtime/scenes')
    if (autoEnabled) return
    const previous = select.value
    select.replaceChildren(new Option(scenes.length ? '选择已绑定的场景' : '没有可朗读的场景', ''))
    for (const scene of scenes) select.add(new Option(scene.label || scene.contextId, scene.contextId))
    if (scenes.some(scene => scene.contextId === previous)) select.value = previous
    autoError = undefined
  } catch (error) { autoError = error.message }
  update()
}
async function toggleAutoRead() {
  if (autoBusy || !stageId || !ready) return
  const contextId = $('voice-auto-scene').value
  if (!contextId) return
  const disabling = autoEnabled
  autoBusy = true
  const revision = ++autoRevision
  if (disabling) setAutoReadEnabled(false)
  update()
  try {
    if (disabling) {
      await api('/realtime/auto', { stageId })
      await voice.tick()
    } else {
      if (await voice.unlock() !== 'running') throw new Error('浏览器尚未启用声音')
      if (revision !== autoRevision) return
      $('voice-unlock').textContent = '声音已启用'
      const state = await api('/realtime/auto', { stageId, contextId })
      if (revision !== autoRevision) {
        if (state.enabled) await api('/realtime/auto', { stageId })
        return
      }
      setAutoReadEnabled(state.enabled)
      nextAutoPoll = 0
    }
    if (revision === autoRevision) autoError = undefined
  } catch (error) { if (revision === autoRevision) autoError = error.message }
  finally { autoBusy = false; update() }
}
function report(status, job) {
  const frames = engine.frames
  const error = status === 'error' ? lastError?.slice(0, 300) : undefined
  const terminal = status !== 'playing'
  if (terminal && active?.taskId === job.id) active.settling = true
  receiptChain = receiptChain.then(async () => {
    await api('/receipt', { taskId: job.id, status, frames, stageId, error })
  }).catch(error => { lastError = error.message }).finally(() => {
    if (terminal && active?.taskId === job.id) active = undefined
  })
  return receiptChain
}
async function play(action) {
  if (!ready || !stageId || !actionReady() || active || requestingAction) return
  requestingAction = true
  update()
  try {
    lastError = undefined
    await api('/actions', { action, stageId })
    await beat()
  } catch (error) { lastError = error.message }
  finally { requestingAction = false; update() }
}
async function stop() {
  if (!active || active.settling) return
  try {
    await api('/stop', { taskId: active.taskId })
    await beat()
  } catch (error) { lastError = error.message }
  update()
}
async function load() {
  try {
    const capabilities = await api('')
    if (!capabilities.available) throw new Error(capabilities.detail)
    scene = await createAvatarRenderer($('canvas'), {
      basePath,
      beforeTick: (motion, now) => {
        voice.applyMouth(motion)
        motion.homeActivity = currentActivity(now)
      },
      onAction: (status, job) => { void report(status, job).then(update) },
      onMouth: value => { renderedMouthOpen = value },
    })
    engine = scene.engine
    ready = true
    $('loading').hidden = true
    update()
    await beat()
    void loadAutoScenes()
  } catch (error) {
    lastError = error.message
    $('loading').hidden = true
    $('error').hidden = false
    $('error').textContent = `模型加载失败：${error.message}`
    update()
  }
}
for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => void play(button.dataset.action)
$('stop').onclick = () => void stop()
$('voice-stop').onclick = () => {
  const song = voice.session?.kind === 'song'
  const stopped = voice.interrupt()
  if (!song) {
    autoRevision++
    setAutoReadEnabled(false)
  }
  void stopped.then(update)
  update()
}
$('voice-auto-scene').onchange = update
$('voice-auto-scene').onfocus = () => void loadAutoScenes()
$('voice-auto').onclick = () => void toggleAutoRead()
function refreshContextPreference() {
  $('context-motion').disabled = reduceMotion.matches
  $('context-motion-status').textContent = reduceMotion.matches ? '系统已开启减少动态效果。' : '跟随宿主回传的当前活动。'
  stageActivity.clear()
  update()
  if (contextEnabled()) void beat()
}
$('context-motion').onchange = refreshContextPreference
reduceMotion.addEventListener('change', refreshContextPreference)
async function unlockVoice() {
  const state = await voice.unlock()
  if (state === 'running') {
    $('voice-unlock').textContent = '声音已启用'
    void beat()
  }
  return state
}
$('voice-unlock').onclick = async () => {
  try {
    await unlockVoice()
  } catch (error) { lastError = error.message; update() }
}
window.companionAvatar = { state: telemetry, play, stop, voiceState: () => voice.telemetry(), unlockVoice }
window.addEventListener('message', event => {
  if (window.parent !== window && event.source === window.parent && event.origin === window.location.origin && event.data === 'companion:voice-state') {
    void voice.tick().then(update)
  }
})
const timer = setInterval(() => { void beat(); update() }, 500)
document.addEventListener('visibilitychange', () => {
  stageActivity.clear()
  void voice.setSongForeground(!document.hidden)
  update()
  void beat()
})
window.addEventListener('offline', () => { stageActivity.clear(); update() })
window.addEventListener('online', () => { void beat() })
window.addEventListener('pagehide', () => { pageActive = false; stageActivity.clear(); void voice.setSongForeground(false) })
window.addEventListener('pageshow', () => { pageActive = true; void voice.setSongForeground(!document.hidden); void beat() })
window.addEventListener('beforeunload', () => { void voice.setSongForeground(false); voice.stopLocal(); clearInterval(timer) })
refreshContextPreference()
await load()
