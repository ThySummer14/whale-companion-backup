import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CbiWorld } from '../apps/minecraft-worker/cbi-world.ts'

async function fixture(t) {
  await mkdir('.work', { recursive: true })
  const dir = resolve(await mkdtemp('.work/minecraft-console-'))
  const fifo = join(dir, 'console.in')
  const logPath = join(dir, 'latest.log')
  await writeFile(logPath, '[00:00:00] [Server thread/INFO]: Ready\n')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const world = Object.assign(Object.create(CbiWorld.prototype), { fifo, logPath, commandQueue: Promise.resolve() })
  return { fifo, logPath, world }
}

test('a missing, linked or orphaned console cannot write or block a command', { timeout: 2000 }, async t => {
  const { world, fifo, logPath } = await fixture(t)
  const send = () => world.send('list', /players/u, 400, 0, undefined, () => assert.fail('No command should dispatch'))
  await assert.rejects(send(), { code: 'ENOENT' })
  await assert.rejects(readFile(fifo), { code: 'ENOENT' })
  await symlink(logPath, fifo)
  await assert.rejects(send(), { code: 'ELOOP' })
  assert.equal(await readFile(logPath, 'utf8'), '[00:00:00] [Server thread/INFO]: Ready\n')
  await rm(fifo)
  execFileSync('mkfifo', [fifo])
  await assert.rejects(send(), { code: 'ENXIO' })
})

test('a native console can recover from a missing reader and guard dispatch before writing', { timeout: 4000 }, async t => {
  const { world, fifo, logPath } = await fixture(t)
  execFileSync('mkfifo', [fifo])
  await assert.rejects(world.send('list', /players/u, 400), { code: 'ENXIO' })
  const reader = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
  t.after(() => reader.close())
  const guard = new Error('fixture command cancelled')
  await assert.rejects(world.send('unwanted', /never/u, 400, 0, undefined, () => { throw guard }), guard)
  const confirmed = world.send('list', /online players/u, 2000)
  const bytes = Buffer.alloc(64)
  let received = ''
  for (let attempt = 0; !received && attempt < 100; attempt++) {
    try {
      const { bytesRead } = await reader.read(bytes, 0, bytes.length, null)
      received = bytes.toString('utf8', 0, bytesRead)
    } catch (error) { if (error.code !== 'EAGAIN') throw error }
    if (!received) await delay(10)
  }
  assert.equal(received, 'list\n')
  await appendFile(logPath, '[00:00:01] [Server thread/INFO]: There are no online players\n')
  assert.match(await confirmed, /online players/u)
})

test('Companion refreshes a supported chat claim once, then releases it when paused', async t => {
  const { world } = await fixture(t)
  const commands = []
  Object.assign(world, {
    botName: 'dafeiyu', owner: 'TrailOwner', online: true, connectionEpoch: 1, chatRelayRenewAt: 0,
    features: {},
    send: async (command, receipt, timeout, settle, signal, dispatch) => {
      dispatch()
      commands.push(command)
      const suffix = command.includes(' renew ') ? 'renewed owner=TrailOwner' : 'cleared'
      const message = `CBI chat relay bot=dafeiyu ${suffix}`
      assert.equal(receipt(`[00:00:00] [Server thread/INFO]: <Visitor> ${message}\n`), false)
      assert.equal(receipt(`[00:00:00] [Server thread/INFO]: <Visitor> [Server thread/INFO]: ${message}\n`), false)
      assert.equal(receipt(`[00:00:00] [Server thread/INFO]: ${message}\n`), true)
    },
  })
  world.refreshChatRelay(true)
  assert.deepEqual(commands, [])
  world.features.chatRelay = true
  world.refreshChatRelay(true)
  world.refreshChatRelay(true)
  await world.chatRelayChange
  world.refreshChatRelay(true)
  assert.deepEqual(commands, ['cbi_chat_relay dafeiyu renew TrailOwner'])
  world.campPaused = true
  world.refreshChatRelay(true)
  await world.chatRelayChange
  world.refreshChatRelay(true)
  assert.deepEqual(commands, ['cbi_chat_relay dafeiyu renew TrailOwner', 'cbi_chat_relay dafeiyu clear'])
})

test('a queued relay command cannot renew after readiness expires or connection changes', async t => {
  const { world } = await fixture(t)
  Object.assign(world, {
    botName: 'dafeiyu', owner: 'TrailOwner', online: true, connectionEpoch: 1, chatRelayRenewAt: 0,
    features: { chatRelay: true },
  })
  for (const invalidate of [() => { world.chatRelayDemandUntil = performance.now() - 1 }, () => { world.connectionEpoch++ }]) {
    let release
    world.send = async (command, receipt, timeout, settle, signal, dispatch) => {
      await new Promise(resolve => { release = resolve })
      assert.throws(dispatch, /minecraft-chat-relay-stale/u)
    }
    world.chatRelayRenewAt = 0
    world.refreshChatRelay(true)
    invalidate()
    release()
    await world.chatRelayChange
    assert.equal(world.chatRelayMayBeActive, undefined)
  }
})
