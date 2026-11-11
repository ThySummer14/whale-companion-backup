import assert from 'node:assert/strict'
import test from 'node:test'
import { StageActivity, contextOffsets, headGestureJob } from '../src/avatar/context-motion.mjs'
import { MotionEngine } from '../src/avatar/engine.mjs'

function stage(physicsOutputIds = []) {
  const allParameters = ['AngleX', 'AngleY', 'AngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthOpenY', 'ParamMouthForm']
    .map(id => ({ id, default: 0, min: -30, max: 30 }))
  const values = new Map()
  const core = { setParameterValueById: (id, value) => values.set(id, value) }
  const receipts = []
  const engine = new MotionEngine(core, {
    allParameters, parameters: allParameters.filter(item => !physicsOutputIds.includes(item.id)), physicsOutputIds,
    idleMotion: { Meta: { Duration: 1 }, Curves: [] },
  }, (status, job) => receipts.push({ status, id: job.id, frames: engine.frames }))
  engine.idle = false
  return { engine, values, receipts }
}

function render(engine, frames = 40) {
  for (let i = 0; i < frames; i++) engine.tick(20)
}

test('context expires five seconds after its heartbeat request and ignores old responses after a reset', () => {
  const context = new StageActivity()
  const revision = context.revision
  context.receive('chatting', 100, revision)
  assert.equal(context.current(5_099), 'chatting')
  assert.equal(context.current(5_100), undefined)
  context.clear()
  context.receive('resting', 5_200, revision)
  assert.equal(context.current(5_300), undefined)
  context.receive('browsing', 5_400, context.revision)
  assert.equal(context.current(5_500), 'browsing')
  for (const mode of ['idle', 'offline', 'toString', undefined, {}]) {
    context.receive(mode, 5_600, context.revision)
    assert.equal(context.current(5_700), undefined)
  }
})

test('six activity cues have distinct bounded offsets and use only head and gaze parameters', () => {
  const modes = ['chatting', 'minecraft', 'browsing', 'resting', 'speaking', 'singing']
  const offsets = modes.map(mode => contextOffsets(mode, 2))
  assert.equal(new Set(offsets.map(JSON.stringify)).size, modes.length)
  for (const offset of offsets) {
    for (const [id, value] of Object.entries(offset)) {
      assert.match(id, /^(?:Angle[XYZ]|ParamEyeBall[XY])$/u)
      assert.ok(Number.isFinite(value) && Math.abs(value) <= (id.startsWith('Angle') ? 8 : 0.4))
    }
  }
  assert.equal(contextOffsets('idle', 2), undefined)
})

test('contextual offsets release to neutral, avoid physics outputs and never emit action receipts', () => {
  const { engine, values, receipts } = stage(['ParamEyeBallY'])
  engine.homeActivity = 'browsing'
  render(engine)
  assert.ok(values.get('AngleY') < -6)
  assert.equal(values.has('ParamEyeBallY'), false)
  assert.equal(values.get('ParamMouthOpenY'), 0)
  engine.homeActivity = undefined
  render(engine)
  assert.ok(Math.abs(values.get('AngleY')) < 0.001)
  assert.deepEqual(receipts, [])
})

test('live voice keeps the lip parameters and defers a conflicting game or reading cue', () => {
  const { engine, values } = stage()
  engine.homeActivity = 'minecraft'
  render(engine)
  assert.ok(values.get('AngleX') > 6)
  engine.speechReserved = true
  engine.speechPose = { values: { ParamMouthOpenY: 0.55, ParamMouthForm: 0.2 } }
  render(engine)
  assert.ok(values.get('AngleX') < 0.001)
  assert.ok(values.get('ParamMouthOpenY') > 0.54)
  engine.homeActivity = 'singing'
  render(engine)
  assert.ok(values.get('AngleY') > 1.3)
  assert.ok(values.get('ParamMouthOpenY') > 0.54)
})

test('nod and shake render distinct real head tracks and settle once after advancing frames', () => {
  for (const [action, axis, neutralAxis] of [['nod', 'AngleY', 'AngleX'], ['shake', 'AngleX', 'AngleY']]) {
    const { engine, values, receipts } = stage()
    engine.homeActivity = 'browsing'
    const job = headGestureJob(action, action, engine.params)
    assert.equal(job.compiled.duration, 1.2)
    engine.start(job)
    render(engine, 15)
    assert.ok(Math.abs(values.get(axis)) > 3, `${action} visibly changes ${axis}`)
    assert.equal(values.get(neutralAxis), 0)
    assert.deepEqual(receipts.map(item => item.status), ['playing'])
    render(engine, 55)
    assert.deepEqual(receipts.map(item => item.status), ['playing', 'completed'])
    assert.equal(receipts[1].id, action)
    assert.ok(receipts[1].frames - receipts[0].frames >= 60)
  }
})

test('unrecognized actions and unsupported model parameters fail before any playing receipt', () => {
  const { engine, receipts } = stage(['AngleY'])
  assert.throws(() => headGestureJob('unknown', 'constructor', engine.params), /不支持/u)
  assert.throws(() => headGestureJob('missing', 'nod', new Map()), /缺少动作参数/u)
  assert.throws(() => engine.start(headGestureJob('physics', 'nod', engine.params)), /unwritable driver parameter/u)
  assert.deepEqual(receipts, [])
})
