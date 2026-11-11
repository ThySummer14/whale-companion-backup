import { makeActionJob } from './action-job.mjs'
import { createAvatarRenderer } from './renderer.mjs'
import { PresenterAction, PresenterCues, applyPresenterPose } from './presenter-cues.mjs'

const $ = id => document.getElementById(id)
const device = document.documentElement.dataset.mode === 'device'
const mode = device ? 'device' : new URLSearchParams(location.search).get('mode') === 'desktop' ? 'desktop' : 'obs'
document.documentElement.dataset.mode = mode
const basePath = device ? '/companion-device/avatar' : ''
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const cues = new PresenterCues()
const action = new PresenterAction((key, id, params) => makeActionJob(key, id, params, basePath))
const english = device && !navigator.language?.startsWith('zh')
const labels = english ? {
  connecting: 'Connecting to the private stage', reconnecting: 'Waiting for the host to reconnect',
  loading: 'Loading the Live2D model', unavailable: 'Live2D is unavailable on this host',
  failed: 'Model load failed. Retrying…', nonFinite: 'Waiting for the model to recover',
  ready: 'Connected · View only', paused: 'Stage paused', expired: 'Viewer access expired. Reopen the stage.',
} : {
  connecting: '正在连接展示服务', reconnecting: '连接中断，等待重连', loading: '正在加载模型与物理',
  unavailable: '等待配置私有模型与 Core', failed: '模型加载失败，稍后重试', nonFinite: '模型状态异常，等待恢复',
  ready: '已连接 · 只读画面', paused: '舞台已暂停', expired: '观看会话已结束，请重新打开舞台。',
}
let scene, loading = false, loadFailed = false, nextLoadAt = 0, mouth, connectedOnce = false
let active = !device || !document.hidden, polling = false, request, timer, terminal, loadRevision = 0

function mobileBridge(status) {
  if (device) globalThis.WhaleAvatarViewer?.postMessage(status)
}

function paint() {
  const state = cues.current(performance.now())
  const engine = scene?.engine
  const nonFinite = scene?.profile.allParameters.filter(item => !Number.isFinite(engine.core.getParameterValueById(item.id))).length ?? 0
  const ready = !!(active && state?.available && engine?.frames > 0 && nonFinite === 0)
  document.body.dataset.ready = String(ready)
  document.body.dataset.frames = String(engine?.frames ?? 0)
  document.body.dataset.nonFinite = String(nonFinite)
  document.body.dataset.action = ready ? engine.job?.id.split(':', 1)[0] ?? '' : ''
  document.body.dataset.activity = ready ? state.activity ?? '' : ''
  document.body.dataset.mouth = ready && Number.isFinite(mouth) ? mouth.toFixed(3) : '0'
  const status = terminal ?? (device && !active ? 'paused' : !state ? (connectedOnce ? 'reconnecting' : 'connecting')
    : !state.available ? 'unavailable' : loadFailed ? 'failed' : nonFinite ? 'nonFinite' : ready ? 'ready' : 'loading')
  const changed = document.body.dataset.status !== status
  document.body.dataset.status = status
  if (changed) {
    $('status').textContent = labels[status]
    if (status === 'ready' || terminal) mobileBridge(status)
  }
}

async function load() {
  loading = true
  loadFailed = false
  const revision = loadRevision
  try {
    const loaded = await createAvatarRenderer($('canvas'), {
      basePath, ...(device && { maxFps: 30 }),
      scale: () => mode === 'desktop' ? Number($('zoom').value) / 100 : 1,
      beforeTick: (engine, now) => {
        const state = cues.current(now)
        const reduce = mode !== 'obs' && (reduceMotion.matches || (device && $('reduce-motion').checked))
        applyPresenterPose(engine, device && reduce ? undefined : state, reduce)
        action.apply(engine, reduce ? undefined : state?.action)
        if (!state && document.body.dataset.ready === 'true') paint()
      },
      onMouth: value => { mouth = value },
    })
    if (revision !== loadRevision) { loaded.destroy(); return }
    scene = loaded
    if (device) scene.setRunning(active && cues.current(performance.now())?.available)
  } catch (error) {
    if (revision !== loadRevision) return
    if (device && /webgl/i.test(error?.message ?? '')) end('unavailable')
    loadFailed = true
    nextLoadAt = performance.now() + 4000
  } finally {
    loading = false
    paint()
  }
}

async function poll() {
  if (!active || polling) return
  polling = true
  const controller = new AbortController()
  request = controller
  const observedAt = performance.now()
  const timeout = setTimeout(() => controller.abort(), 1200)
  try {
    const response = await fetch(`${basePath}/state`, { cache: 'no-store', signal: controller.signal })
    if (device && !controller.signal.aborted && active) {
      if (response.status === 401 || response.status === 403) { end('expired'); return }
      if (response.status === 404) { end('unavailable'); return }
    }
    if (!response.ok) throw new Error('presenter-state-unavailable')
    const snapshot = await response.json()
    if (controller.signal.aborted || !active) return
    connectedOnce = true
    cues.receive(snapshot, observedAt)
    const available = cues.current(performance.now())?.available
    if (device) scene?.setRunning(available)
    if (available && !scene && !loading && performance.now() >= nextLoadAt) void load()
  } catch {
    cues.clear()
    if (device) scene?.setRunning(false)
  }
  finally {
    clearTimeout(timeout)
    polling = false
    request = undefined
    paint()
    if (active) timer = setTimeout(poll, device ? (cues.current(performance.now()) ? 350 : 800) : 250)
  }
}

function pause(release = false) {
  active = false
  clearTimeout(timer)
  request?.abort()
  cues.clear()
  if (device) {
    scene?.setRunning(false)
    if (release) {
      loadRevision++
      if (scene) action.apply(scene.engine, undefined)
      scene?.destroy()
      scene = undefined
      const canvas = $('canvas')
      canvas.replaceWith(canvas.cloneNode(false))
    }
  }
  paint()
}

function end(status) {
  terminal = status
  pause(true)
}

function resume() {
  if (active || terminal || (device && document.hidden)) return
  active = true
  void poll()
}

if (mode === 'desktop') {
  $('theme').addEventListener('change', () => { document.body.dataset.theme = $('theme').value })
  $('zoom').addEventListener('input', () => scene?.resize())
}
window.addEventListener('offline', () => {
  request?.abort()
  cues.clear()
  if (device) scene?.setRunning(false)
  paint()
})
window.addEventListener('pagehide', () => pause(true))
window.addEventListener('pageshow', resume)
if (device) {
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else resume() })
  if (english) {
    document.documentElement.lang = 'en'
    $('canvas').setAttribute('aria-label', 'Da Fei Yu Live2D stage')
    $('reduce-motion-label').textContent = 'Reduce motion'
  }
  if (!globalThis.PIXI?.live2d || !globalThis.ResizeObserver || !AbortSignal.timeout) end('unavailable')
}
paint()
if (active) void poll()
