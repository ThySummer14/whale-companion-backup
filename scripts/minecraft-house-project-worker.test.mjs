import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'

const dimension = 'minecraft:overworld'
const zone = { id: 'b6c59b42-a312-4268-b2a0-5bfa4fb02d2f', dimension, y: 70, radius: 6 }
const layout = { width: 5, height: 5, depth: 5, blocks: 'o'.repeat(100) + '.'.repeat(25) }
const sections = [-3, 2].flatMap(z => [-5, 0, 5].map(x => ({ zone: { ...zone, x, z }, layout })))
const signal = new AbortController().signal
const prefix = '[10:00:01] [Server thread/INFO]: '
const id = [-1567494946, -1098630553, -1501317838, 1981986780]

function fixture(t, decide = () => 'match') {
  const world = Object.assign(Object.create(CbiWorld.prototype), {
    botName: 'dafeiyu', online: true, connectionEpoch: 3, campPaused: false, campEpoch: 0, features: { houseBuilding: true },
  })
  const dispatched = []
  t.mock.method(world, 'captureHouseSession', async () => ({ epoch: world.connectionEpoch, dev: 1, ino: 2, offset: 0 }))
  t.mock.method(world, 'verifyHouseSession', async session => {
    if (session.epoch !== world.connectionEpoch) throw new Error('house-ownership-unconfirmed')
  })
  t.mock.method(world, 'send', async (command, proof, _timeout, _settle, readSignal, guard) => {
    readSignal.throwIfAborted()
    guard()
    const frame = /^execute as dafeiyu at @s if dimension minecraft:overworld positioned -5 70 -3 .+ run data get entity @s UUID/u
    assert.match(command, frame)
    assert.doesNotMatch(command, / {2}/u)
    assert.match(command, / if loaded /u)
    dispatched.push(command)
    if (command.endsWith(' UUID')) {
      assert.ok(proof.test(prefix + `dafeiyu has the following entity data: [I; ${id.join(', ')}]\n`))
      return prefix + `dafeiyu has the following entity data: [I; ${id.join(', ')}]\n`
    }
    const count = [...command.matchAll(/ if block /gu)].length
    const action = decide(count, command, world)
    if (action === 'missing') throw new Error('console-receipt-timeout:execute')
    const [, index, textScale] = / UUID\[(\d)\] (-?\d+\.\d+)$/u.exec(command)
    const scale = Number(textScale)
    const receipt = prefix + `UUID[${index}] on dafeiyu after scale factor of ${scale.toFixed(2)} is ${Math.floor(id[index] * scale)}\n`
    assert.ok(proof.test(receipt))
    return action === 'fake' ? receipt.replace('on dafeiyu', 'on wrongbot') : receipt
  })
  return { world, dispatched, run: (input = { sections }, readSignal = signal) =>
    world.withCampAction(() => world.verifyHouseProject(input, readSignal)) }
}

test('whole project completion uses one fresh read of all 750 cells including reserved air', async t => {
  const h = fixture(t)
  assert.deepEqual(await h.run(), { matched: true, checked: 750, unmatchedSections: [] })
  assert.equal(h.dispatched.length, 2)
  const command = h.dispatched[1]
  const blocks = [...command.matchAll(/if block (~-?\d*) (~-?\d*) (~-?\d*) ([#:\w]+) /gu)]
  assert.equal(blocks.length, 750)
  assert.equal(new Set(blocks.map(([, x, y, z]) => [x, y, z].join(','))).size, 750)
  assert.equal(blocks.filter(([, , , , value]) => value === '#minecraft:air').length, 150)
  assert.equal(blocks.filter(([, , , , value]) => value === 'minecraft:oak_planks').length, 600)
})

test('mismatching sections provide bounded diagnostics without a completion', async t => {
  let index = 0
  const h = fixture(t, count => count === 750 || count === 125 && [0, 5].includes(index++) ? 'missing' : 'match')
  assert.deepEqual(await h.run(), { matched: false, checked: 750, unmatchedSections: [0, 5] })
  assert.equal(h.dispatched.length, 9)
})

test('separately passing sections never stand in for simultaneous completion', async t => {
  const h = fixture(t, count => count === 750 ? 'missing' : 'match')
  await assert.rejects(h.run(), { message: 'house-project-verification-unconfirmed' })
})

test('unmatched diagnostics cannot pass after the world or bot changes', async t => {
  const unavailable = fixture(t, () => 'missing')
  await assert.rejects(unavailable.run(), { message: 'house-project-verification-unconfirmed' })
  const changed = fixture(t, (_count, _command, world) => { world.connectionEpoch++; return 'match' })
  await assert.rejects(changed.run(), { message: 'house-ownership-unconfirmed' })
  const bogus = fixture(t, () => 'fake')
  await assert.rejects(bogus.run(), { message: 'house-project-verification-unconfirmed' })
})

test('project verification does not dispatch invalid or cancelled requests', async t => {
  const h = fixture(t)
  for (const invalid of [
    { sections: [] },
    { sections: [sections[0], sections[0]] },
    { sections: [sections[0], sections[2]] },
    { sections: [sections[0], { ...sections[1], zone: { ...sections[1].zone, dimension: 'minecraft:the_nether' } }] },
    { sections: [sections[0], { ...sections[1], zone: { ...sections[1].zone, radius: 2 } }] },
  ]) {
    await assert.rejects(h.run(invalid), { message: 'minecraft-house-invalid-request' })
  }
  await assert.rejects(h.run(undefined, AbortSignal.abort()), { name: 'AbortError' })
  assert.deepEqual(h.dispatched, [])
})

test('aborting a partial FIFO snapshot invalidates its line before the next command', async t => {
  const dir = await mkdtemp(join(import.meta.dirname, '.house-project-pipe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fifo = join(dir, 'console.in')
  execFileSync('mkfifo', [fifo])
  const reader = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK)
  try {
    const world = Object.assign(Object.create(CbiWorld.prototype), { fifo })
    const prefix = 'execute if block ~ ~ ~ #minecraft:air'
    const command = prefix + ' run data get entity @s UUID'
    let guards = 0
    await assert.rejects(world.writeConsole(command, () => {
      if (++guards === 3) throw new DOMException('aborted', 'AbortError')
    }, true), { name: 'AbortError' })
    const buffer = Buffer.alloc(command.length)
    const partial = await reader.read(buffer, 0, buffer.length, null)
    assert.equal(buffer.subarray(0, partial.bytesRead).toString(), prefix)
    await world.writeConsole('list', () => {}, false)
    const tail = await reader.read(buffer, 0, buffer.length, null)
    assert.equal(buffer.subarray(0, tail.bytesRead).toString(), ' !companion-incomplete-read!\nlist\n')
  } finally {
    await reader.close()
  }
})
