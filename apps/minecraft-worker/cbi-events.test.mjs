import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CbiWorld } from './cbi-world.ts'

test('CBI routes one private owner message and keeps public text separate from presence', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.cbi-events-'))
  const environment = {
    COMPANION_MC_SERVER_ROOT: root,
    COMPANION_MC_DATA_DIR: join(root, 'worker'),
    COMPANION_MC_OWNER: 'Qa_Owner',
    COMPANION_MC_BOT_NAME: 'qa_fish',
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const world = new CbiWorld()
  try {
    await mkdir(join(root, 'logs'))
    await appendFile(join(root, 'logs', 'latest.log'), [
      '[08:00:00] [Server thread/INFO]: [Not Secure] <qa_owner> qa_fish joined the game',
      '[08:00:00] [Server thread/INFO]: [Not Secure] <qa_other> qa_owner left the game',
      '[08:00:00] [Server thread/INFO]: Intercepted /tell sender=qa_owner target=qa_fish route=llm message=owner private',
      '[08:00:00] [Server thread/INFO]: Intercepted /tell sender=qa_other target=qa_fish route=llm message=other private',
      '[08:00:00] [Server thread/INFO]: Intercepted /tell sender=qa_owner target=qa_fish route=cbi message=cbi help',
      '[08:00:00] [Server thread/INFO]: Qa_Owner joined the game',
      '',
    ].join('\n'))
    await world.pump()
    await world.pump()
    const events = world.eventsAfter(0)
    assert.equal(world.view().online, false)
    assert.deepEqual(events.map(event => [event.kind, event.message, event.delivery]), [
      ['chat.received', 'qa_fish joined the game', undefined],
      ['chat.received', 'qa_owner left the game', undefined],
      ['chat.received', 'owner private', 'private'],
      ['owner.online', undefined, undefined],
    ])
  } finally {
    await world.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
