import assert from 'node:assert/strict'
import test from 'node:test'
import { CbiWorld } from './cbi-world.ts'
import { configuredWardrobe, ysmWardrobeAvailable, ysmWardrobeReceipt, ysmWardrobeStateLine } from './wardrobe.ts'

const models = [
  { id: 'blue', label: '蓝色大肥鱼', modelId: 'wardrobe:蓝色大肥鱼' },
  { id: 'winter', label: '蓝色冬装', modelId: 'wardrobe/蓝色大肥鱼(冬装)' },
]
const player = 'qa_fish'
const help = '/ysm model set <targets> <model_id> <texture_id> [<ignore_auth>]'
const readState = `data get entity ${player} ysm.model_id`
const log = (text, source = 'Server thread/INFO') => `[08:00:00] [${source}]: ${text}\n`
const accepted = model => `[YSM] Set '${model}' models for player '${player}'`
const rawAccepted = 'message.yes_steve_model.model.set.success'
const state = ({ modelId = 'default', mandatory = false, disabled = false, texture = 'default' } = {}) =>
  `{disabled: ${Number(disabled)}b, mandatory: ${Number(mandatory)}b, model_id: ${JSON.stringify(modelId)}, select_texture: ${JSON.stringify(texture)}, molang_storage: {}}`
const signal = () => new AbortController().signal

test('wardrobe configuration accepts private quoted provider IDs and rejects the whole malformed list', () => {
  assert.deepEqual(configuredWardrobe(JSON.stringify(models)), models)
  assert.deepEqual(configuredWardrobe(JSON.stringify([models[0], models[0]])), [])
  assert.deepEqual(configuredWardrobe(JSON.stringify([{ ...models[0], modelId: 'blue" true' }])), [])
  assert.deepEqual(configuredWardrobe(JSON.stringify([{ ...models[0], path: '/private/model.ysm' }])), [])
  assert.deepEqual(configuredWardrobe(' '.repeat(16_385)), [])
})

test('wardrobe availability and receipt require trusted complete console lines', () => {
  const { modelId } = models[0]
  assert.equal(ysmWardrobeAvailable(log(help)), true)
  assert.equal(ysmWardrobeAvailable(log(`<someone> ${help}`)), false)
  assert.equal(ysmWardrobeAvailable(log('/ysm model set <targets>')), false)
  assert.equal(ysmWardrobeReceipt(log(`§6§l[§aYSM§6§l] §rSet '${modelId}' models for player '${player}'`), player, modelId), 'accepted')
  assert.equal(ysmWardrobeReceipt(log(`[YSM] 已将玩家 '${player}' 的模型设置为 '${modelId}'`), player, modelId), 'accepted')
  assert.equal(ysmWardrobeReceipt(log(`[YSM] '${modelId}' is not exist`), player, modelId), 'refused')
  assert.equal(ysmWardrobeReceipt(log(`[YSM] Unable set '${modelId}' models for player '${player}', need model auth`), player, modelId), 'refused')
  assert.equal(ysmWardrobeReceipt(log('No player was found'), player, modelId), 'offline')
  assert.equal(ysmWardrobeReceipt(log(rawAccepted), player, modelId), 'raw-accepted')
  assert.equal(ysmWardrobeReceipt(log(`<someone> ${accepted(modelId)}`), player, modelId), undefined)
  assert.equal(ysmWardrobeReceipt(log(accepted(modelId), 'Netty Server IO #1/INFO'), player, modelId), undefined)
  assert.equal(ysmWardrobeReceipt(log(accepted(modelId)).trimEnd(), player, modelId), undefined)
  assert.equal(ysmWardrobeReceipt(log(accepted(modelId)), 'other_fish', modelId), undefined)
  assert.equal(ysmWardrobeReceipt(log(accepted(modelId)), player, 'different-model'), undefined)
  assert.deepEqual(ysmWardrobeStateLine(log(`${player} has the following entity data: ${state()}`), player), { kind: 'data', snbt: state() })
  assert.deepEqual(ysmWardrobeStateLine(log('Found no elements matching ysm.model_id'), player), { kind: 'absent' })
  assert.equal(ysmWardrobeStateLine(log(`<someone> ${player} has the following entity data: ${state()}`), player), undefined)
})

function fixture(t, configured = models) {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    botName: player, online: true, campEpoch: 0, connectionEpoch: 0, campPaused: false, wardrobeModels: configured,
  })
  let appearance = {}
  let respond = async model => {
    appearance = { modelId: model.modelId, mandatory: true }
    return accepted(model.modelId)
  }
  const send = t.mock.method(world, 'send', async (command, accepts, _timeout, _settle, _signal, guard) => {
    guard?.()
    const model = command.includes(models[1].modelId) ? models[1] : models[0]
    const output = log(command === 'help ysm model set' ? help
      : command === readState ? `${player} has the following entity data: ${state(appearance)}` : await respond(model))
    assert.equal(accepts(output), true)
    return output
  })
  return { world, send, change: (id, requestSignal = signal()) => world.withCampAction(() => world.changeAppearance(id, requestSignal)),
    setAppearance: next => { appearance = next }, setResponse: next => { respond = next } }
}

test('online CBI uses one shared probe, hides provider IDs and applies only the chosen fake-player command', async t => {
  const { world, send, change } = fixture(t)
  const options = models.map(({ id, label }) => ({ id, label }))
  assert.deepEqual(await Promise.all([world.wardrobe(), world.wardrobe()]), Array(2).fill({ available: true, options }))
  await assert.rejects(change('some-other-id'), /minecraft-wardrobe-option-not-found/u)
  const selected = await change('winter')
  assert.deepEqual(selected.options, options)
  assert.equal(selected.last.id, 'winter')
  assert.ok(Number.isFinite(Date.parse(selected.last.confirmedAt)))
  assert.deepEqual(await world.wardrobe(), selected)
  await change('blue')
  assert.deepEqual(send.mock.calls.map(call => call.arguments[0]), [
    'help ysm model set', readState,
    readState, `ysm model set ${player} "${models[1].modelId}" -`, readState,
    readState, `ysm model set ${player} "${models[0].modelId}" -`, readState,
  ])
})

test('unconfigured, offline and unsupported servers retain clear bounded views without YSM changes', async t => {
  const unconfigured = fixture(t, [])
  assert.deepEqual(await unconfigured.world.wardrobe(), { available: false, options: [] })
  await assert.rejects(unconfigured.change('blue'), /minecraft-wardrobe-unavailable/u)
  assert.equal(unconfigured.send.mock.callCount(), 0)

  const offline = fixture(t)
  offline.world.online = false
  assert.equal((await offline.world.wardrobe()).available, false)
  await assert.rejects(offline.change('blue'), /minecraft-wardrobe-offline/u)
  assert.equal(offline.send.mock.callCount(), 0)

  const unsupported = fixture(t)
  unsupported.send.mock.mockImplementation(async () => { throw new Error('console-command-rejected') })
  const view = await unsupported.world.wardrobe()
  assert.equal(view.available, false)
  assert.equal(view.options.length, 2)
  await assert.rejects(unsupported.change('blue'), /minecraft-wardrobe-unavailable/u)
  assert.equal(unsupported.send.mock.callCount(), 1)
})

test('a refusal or uncertain response never replaces the last proven receipt', async t => {
  const { world, change, setResponse } = fixture(t)
  const previous = await change('blue')
  setResponse(async () => `[YSM] '${models[1].modelId}' is not exist`)
  await assert.rejects(change('winter'), /minecraft-wardrobe-refused/u)
  setResponse(async () => rawAccepted)
  await assert.rejects(change('winter'), /minecraft-wardrobe-unconfirmed/u)
  assert.deepEqual(await world.wardrobe(), previous)
})

test('untranslated success requires a new exact enabled selection and disabled models remain untouched', async t => {
  const { world, send, change, setAppearance, setResponse } = fixture(t)
  setResponse(async model => {
    setAppearance({ modelId: model.modelId, mandatory: true })
    return rawAccepted
  })
  assert.equal((await change('winter')).last.id, 'winter')
  const last = (await world.wardrobe()).last
  await assert.rejects(change('winter'), /minecraft-wardrobe-unconfirmed/u)
  assert.deepEqual((await world.wardrobe()).last, last)
  const previousSets = send.mock.calls.filter(call => call.arguments[0].startsWith('ysm model set ')).length
  setAppearance({ modelId: models[1].modelId, mandatory: true, disabled: true })
  await assert.rejects(change('blue'), /minecraft-wardrobe-unavailable/u)
  assert.equal((await world.wardrobe()).available, false)
  assert.equal(send.mock.calls.filter(call => call.arguments[0].startsWith('ysm model set ')).length, previousSets)
})

test('in-flight selection is single-flight and stale across pause/resume or requester disconnect', async t => {
  const { world, change, setResponse } = fixture(t)
  await world.wardrobe()
  t.mock.method(world, 'stop', async () => ({ stopped: true, displacement: 0 }))
  const entered = Promise.withResolvers()
  const receipt = Promise.withResolvers()
  setResponse(async () => {
    entered.resolve()
    return receipt.promise
  })
  const selection = assert.rejects(change('blue'), /minecraft-camp-paused/u)
  await entered.promise
  await assert.rejects(change('winter'), /minecraft-wardrobe-busy/u)
  await world.pauseCamp()
  assert.throws(() => change('winter'), /minecraft-camp-paused/u)
  world.resumeCamp()
  receipt.resolve(accepted(models[0].modelId))
  await selection
  assert.equal((await world.wardrobe()).last, undefined)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(change('blue', controller.signal), /minecraft-wardrobe-cancelled/u)
  assert.equal((await world.wardrobe()).last, undefined)
})
