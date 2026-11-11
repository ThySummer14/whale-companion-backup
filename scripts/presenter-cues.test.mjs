import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { MotionEngine } from '../src/avatar/engine.mjs'
import { makeActionJob } from '../src/avatar/action-job.mjs'
import { PresenterAction, PresenterCues, applyPresenterPose } from '../src/avatar/presenter-cues.mjs'

function motion() {
  const parameters = ['AngleX', 'AngleY', 'AngleZ', 'ParamMouthOpenY', 'ParamMouthForm'].map(id => ({ id, default: 0, min: -30, max: 30 }))
  const values = new Map()
  const engine = new MotionEngine({ setParameterValueById: (id, value) => values.set(id, value) }, {
    allParameters: parameters, parameters, idleMotion: { Meta: { Duration: 1 }, Curves: [] },
  }, () => {})
  return { engine, values }
}

test('only bounded display fields are projected, and age is anchored to the state request', () => {
  const cues = new PresenterCues()
  cues.receive({ available: true, activity: 'minecraft', voiceEnergy: 0.75,
    action: { id: 'nod', startedAt: 1234, elapsedMs: 200 }, messages: ['private'] }, 100)
  assert.deepEqual(cues.current(350), {
    available: true, activity: 'minecraft', voiceEnergy: 0.75, action: { id: 'nod', startedAt: 1234, elapsedMs: 450 },
  })
  assert.equal(cues.current(1900), undefined)
  cues.receive({ available: true, activity: 'toString', voiceEnergy: Infinity,
    action: { id: 'constructor', startedAt: 1234, elapsedMs: 200 } }, 1800)
  assert.deepEqual(cues.current(1800), { available: true, activity: undefined, voiceEnergy: 0, action: undefined })
  cues.receive({ available: false, activity: 'chatting', voiceEnergy: 1 }, 1900)
  assert.equal(cues.current(1900).available, false)
  assert.equal(cues.current(1900).voiceEnergy, 0)
  cues.clear()
  assert.equal(cues.current(1900), undefined)
})

test('mouth follows the supplied energy and settles to neutral when the feed goes stale', () => {
  const { engine, values } = motion()
  applyPresenterPose(engine, { activity: 'speaking', voiceEnergy: 0.7 }, false)
  engine.tick(550)
  assert.equal(engine.homeActivity, 'speaking')
  assert.ok(values.get('ParamMouthOpenY') > 0.69)
  assert.ok(values.get('ParamMouthForm') > 0.24)
  applyPresenterPose(engine, undefined, true)
  engine.tick(550)
  assert.equal(engine.idle, false)
  assert.equal(engine.homeActivity, undefined)
  assert.equal(engine.speechReserved, false)
  assert.ok(values.get('ParamMouthOpenY') < 0.001)
})

test('mirrored actions seek to the observed phase and stop at the exact local asset duration', async () => {
  const { engine, values } = motion()
  const mirror = new PresenterAction(makeActionJob)
  const cue = { id: 'nod', startedAt: 10, elapsedMs: 300 }
  mirror.apply(engine, cue)
  await setImmediate()
  mirror.apply(engine, cue)
  engine.tick(300)
  assert.equal(engine.job.id, 'nod:10')
  assert.equal(engine.elapsed, 0.3)
  assert.ok(values.get('AngleY') < -8)
  mirror.apply(engine, { ...cue, elapsedMs: 1200 })
  assert.equal(engine.job, null)
  mirror.apply(engine, { ...cue, elapsedMs: 1300 })
  assert.equal(engine.job, null)
})

test('a pending asset load cannot resurrect an expired or replaced action', async () => {
  const { engine } = motion()
  let releaseOld
  const loadOld = new Promise(resolve => { releaseOld = resolve })
  const mirror = new PresenterAction((key, id, params) => id === 'nod' ? loadOld : makeActionJob(key, id, params))
  const old = { id: 'nod', startedAt: 10, elapsedMs: 300 }
  const next = { id: 'shake', startedAt: 30, elapsedMs: 200 }
  mirror.apply(engine, old)
  await setImmediate()
  mirror.apply(engine, next)
  releaseOld(await makeActionJob('nod:10', 'nod', engine.params))
  await setImmediate()
  mirror.apply(engine, next)
  assert.equal(engine.job.id, 'shake:30')
  mirror.apply(engine, undefined)
  assert.equal(engine.job, null)
})

test('control stage and output reuse the same gesture assets under their distinct read paths', async t => {
  const paths = []
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(url)
    return { ok: true, json: async () => url.endsWith('.exp3.json')
      ? { Parameters: [{ Id: 'AngleY', Value: 1, Blend: 'Add' }] }
      : { Meta: { Duration: 1.5 }, Curves: [{ Target: 'Parameter', Id: 'AngleY', Segments: [0, 0, 0, 1.5, 1] }] } }
  })
  const stage = await makeActionJob('managed-task', 'blush', new Map(), '/companion/avatar')
  const output = await makeActionJob('blush:10', 'blush', new Map())
  const point = await makeActionJob('point:10', 'point', new Map())
  assert.deepEqual(stage.compiled, output.compiled)
  assert.equal(point.compiled.duration, 1.5)
  assert.deepEqual(paths, ['/companion/avatar/model/Exp3/脸红.exp3.json', '/model/Exp3/脸红.exp3.json', '/model/Animation/竖手指切出来动画.motion3.json'])
})
