import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'
import { createAvatarRenderer } from '../src/avatar/renderer.mjs'

const scope = '/companion-device/avatar'
const parameters = [{ id: 'ParamMouthOpenY', default: 0, min: 0, max: 1 }]
const profile = { allParameters: parameters, parameters, idleMotion: { Meta: { Duration: 1 }, Curves: [] } }

function override(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name] })
}

function fakePixi(t) {
  const created = [], sources = [], values = new Map()
  let disconnects = 0
  class App {
    constructor(options) {
      this.options = options
      created.push(this)
      this.stage = { addChild: model => { this.model = model } }
      this.ticker = { started: options.autoStart !== false, deltaMS: 34, add: callback => { this.update = callback } }
      this.renderer = {
        gl: { getExtension: () => undefined, getParameter: () => 'TestRenderer' },
        resize: () => {}, render: () => { this.model.internalModel.updateNaturalMovements(); this.model.mouth?.() },
      }
    }
    start() { this.ticker.started = true }
    stop() { this.ticker.started = false }
    destroy() { this.destroyed = true; this.stop() }
    draw() { if (this.ticker.started) { this.update?.(); this.renderer.render() } }
  }
  const makeModel = (source, options) => {
    sources.push({ source, options })
    const renderer = { _clippingManager: { getClippingMaskBufferSize: () => 2048, setClippingMaskBufferSize() {} } }
    const coreModel = { getParameterValueById: key => values.get(key) ?? 0, setParameterValueById: (key, value) => values.set(key, value) }
    return {
      update: () => {}, position: { set() {} }, scale: { set() {} }, anchor: { set() {} },
      internalModel: { originalWidth: 192, originalHeight: 300, renderer, coreModel, on(_event, callback) { this.owner.mouth = callback } },
    }
  }
  override(t, 'PIXI', { Application: App, live2d: { Live2DModel: { registerTicker() {}, async from(...args) {
    const model = makeModel(...args)
    model.internalModel.owner = model
    return model
  } } } })
  override(t, 'ResizeObserver', class { observe() {} disconnect() { disconnects++ } })
  override(t, 'devicePixelRatio', 3)
  return { created, sources, values, disconnects: () => disconnects }
}

function fakePage(t) {
  const nodes = { status: {}, 'reduce-motion': { checked: false }, 'reduce-motion-label': {} }
  const makeCanvas = () => ({
    parentElement: { clientWidth: 390, clientHeight: 590 },
    setAttribute() {}, cloneNode: makeCanvas, replaceWith(next) { nodes.canvas = next },
  })
  nodes.canvas = makeCanvas()
  const document = Object.assign(new EventTarget(), {
    hidden: false, body: { dataset: {} }, documentElement: { dataset: { mode: 'device' } }, getElementById: id => nodes[id],
  })
  const window = new EventTarget()
  const events = []
  override(t, 'document', document)
  override(t, 'window', window)
  override(t, 'navigator', { language: 'zh-CN' })
  override(t, 'matchMedia', () => ({ matches: false }))
  override(t, 'WhaleAvatarViewer', { postMessage: value => events.push(value) })
  return { document, window, events, nodes }
}

test('mobile Cubism and drawing share the capped private ticker, while desktop keeps its defaults', async t => {
  const { created, sources, disconnects } = fakePixi(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async path => { requests.push(path); return Response.json(profile) })
  const canvas = { parentElement: { clientWidth: 390, clientHeight: 590 } }
  const mobile = await createAvatarRenderer(canvas, { basePath: scope, maxFps: 30 })
  assert.equal(created[0].options.resolution, 1)
  assert.equal(created[0].ticker.maxFPS, 30)
  assert.equal(created[0].ticker.started, false)
  assert.equal(sources[0].options.autoUpdate, false)
  mobile.setRunning(true)
  const before = mobile.engine.frames
  created[0].draw()
  assert.equal(mobile.engine.frames, before + 1)
  mobile.setRunning(false)
  created[0].draw()
  assert.equal(mobile.engine.frames, before + 1)
  mobile.destroy()
  assert.equal(disconnects(), 1)
  assert.equal(created[0].destroyed, true)
  const desktop = await createAvatarRenderer(canvas)
  assert.equal(created[1].options.resolution, 1.5)
  assert.equal(created[1].ticker.started, true)
  assert.equal(sources[1].options.autoUpdate, true)
  assert.deepEqual(requests, [`${scope}/data/model-profile.json`, '/data/model-profile.json'])
  assert.deepEqual(sources.map(entry => entry.source), [`${scope}/model/大肥鱼.model3.json`, '/model/大肥鱼.model3.json'])
  desktop.destroy()
})

test('private viewer pauses while hidden, resumes from fresh cues and releases access on a terminal response', async t => {
  const { created } = fakePixi(t)
  const { document, window, events, nodes } = fakePage(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  override(t, 'performance', { now: () => now })
  const requests = []
  let status = 200
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.ok(path.startsWith(`${scope}/`))
    assert.equal(options.method, undefined)
    assert.equal(options.headers, undefined)
    requests.push(path)
    if (path.endsWith('/state')) return Response.json({ available: true, activity: 'singing', voiceEnergy: 0.7 }, { status })
    return Response.json(profile)
  })
  await import('../src/avatar/presenter.mjs?mobile-lifecycle')
  await flush()
  const stage = created[0]
  assert.equal(document.body.dataset.ready, 'true')
  assert.deepEqual(events, ['ready'])
  assert.equal(stage.ticker.started, true)
  now += 34
  stage.draw()
  t.mock.timers.tick(350)
  await flush()
  assert.ok(Number(document.body.dataset.mouth) > 0)
  nodes['reduce-motion'].checked = true
  for (let i = 0; i < 12; i++) { now += 34; stage.draw() }
  t.mock.timers.tick(350)
  await flush()
  assert.ok(Number(document.body.dataset.mouth) < 0.001)
  const requestsBeforePause = requests.length
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(10_000)
  await flush()
  assert.equal(requests.length, requestsBeforePause)
  assert.equal(stage.ticker.started, false)
  assert.equal(document.body.dataset.ready, 'false')
  assert.equal(document.body.dataset.mouth, '0')
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(stage.ticker.started, true)
  assert.equal(requests.length, requestsBeforePause + 1)
  status = 401
  t.mock.timers.tick(350)
  await flush()
  assert.equal(stage.destroyed, true)
  assert.equal(document.body.dataset.status, 'expired')
  assert.deepEqual(events, ['ready', 'ready', 'expired'])
  window.dispatchEvent(new Event('pageshow'))
  t.mock.timers.tick(10_000)
  assert.equal(requests.length, requestsBeforePause + 2)
})
