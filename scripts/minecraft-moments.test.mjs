import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { MinecraftService } from '../src/host/minecraft.ts'
import { minecraftMoment } from '../src/host/minecraft-moments.ts'

const task = (kind, status = 'succeeded') => ({
  id: 'game-task', contextId: 'game.minecraft', capabilityId: `minecraft.${kind}`, status,
})
const sensitive = { zoneId: 'private-base', target: { x: 1938, y: 72, z: -13 }, observation: { players: ['private-owner'], message: 'private-chat' } }
const dig = { ...sensitive, changed: true, pickedUp: true, block: 'cherry_log', inventoryDelta: 1 }
const craft = { ...sensitive, crafted: true, name: 'shield', count: 1 }
const returned = { ...sensitive, returned: true, placedBlocks: 4 }
const build = { ...sensitive, built: true, material: 'oak_planks', placedFloor: 8, placedTable: 1 }

test('share evidence only includes verified structured Minecraft facts', () => {
  const results = [
    ['dig', dig, '采集并拾取了自然生长的樱花木原木，背包增加了 1 根。'],
    ['craft', craft, '合成了盾牌 ×1，并核对了背包。'],
    ['return', returned, '从短竖井安全回到出口，实际放置 4 块垫脚方块。'],
    ['build', build, '完成了一处小营地，核对了 8 块橡木木板地板和 1 个工作台。'],
    ['prepare', { ...sensitive, prepared: true, build, gathered: 2, crafted: 4 }, '完成了橡木木板小营地的备料和建造。途中采集 2 次、合成 4 次。'],
  ]
  for (const [kind, receipt, summary] of results) {
    assert.deepEqual(minecraftMoment(task(kind), receipt), { taskId: 'game-task', kind, summary })
    assert.equal(minecraftMoment(task(kind, 'cancelled'), receipt), undefined)
  }
  for (const kind of ['chat', 'follow', 'move', 'death']) assert.equal(minecraftMoment(task(kind), dig), undefined)
  assert.equal(minecraftMoment(task('dig'), { ...dig, pickedUp: false }), undefined)
  assert.equal(minecraftMoment(task('dig'), { ...dig, block: 'private-name_log' }), undefined)
  assert.equal(minecraftMoment(task('craft'), { ...craft, count: 8 }), undefined)
  assert.equal(minecraftMoment(task('return'), { ...returned, placedBlocks: 17 }), undefined)
  assert.equal(minecraftMoment(task('build'), { ...build, placedFloor: 7 }), undefined)
  assert.equal(minecraftMoment(task('prepare'), { prepared: true, build: { ...build, built: false }, gathered: 2, crafted: 4 }), undefined)
  assert.equal(minecraftMoment({ ...task('dig'), contextId: 'chat.mobile' }, dig), undefined)
})

test('camp preparation emits one parent receipt and a failed share enqueue preserves gameplay success', async t => {
  mkdirSync('.work', { recursive: true })
  const dir = mkdtempSync('.work/minecraft-moments-')
  const store = new CompanionStore(join(dir, 'store.sqlite'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const zone = store.createBuildZone({ name: 'private-base', dimension: 'minecraft:overworld', x: 1938, y: 72, z: -13, radius: 4 })
  const moments = []
  let failEnqueue = false
  const service = new MinecraftService(store, {}, { dataDir: dir, serverRoot: dir, owner: 'private-owner' }, undefined, moment => {
    assert.equal(store.taskById(moment.taskId)?.status, 'succeeded')
    moments.push(moment)
    if (failEnqueue) throw new Error('private-enqueue-error')
  })
  const items = new Map([['oak_log', 3], ['oak_planks', 0], ['crafting_table', 0]])
  const change = (name, delta) => items.set(name, items.get(name) + delta)
  t.mock.method(service, 'request', async (path, _method, input) => {
    switch (path) {
      case '': return { online: true, capabilities: { crafting: true, campBuilding: true } }
      case '/observe': return { inventory: [...items].map(([name, count]) => ({ name, count })) }
      case '/lessons': return {}
      case '/dig':
        change(input.name, 1)
        return { ...dig, block: input.name }
      case '/craft':
        if (input.name === 'oak_planks') {
          change('oak_log', -1)
          change('oak_planks', 4)
          return { ...craft, name: 'oak_planks', count: 4 }
        }
        assert.equal(input.name, 'crafting_table')
        change('oak_planks', -4)
        change('crafting_table', 1)
        return { ...craft, name: 'crafting_table' }
      case '/build': return build
      default: assert.fail(`Unexpected worker request: ${path}`)
    }
  })
  const preparation = await service.prepareCamp(zone.id, 'oak_planks')
  assert.deepEqual(moments, [{
    taskId: preparation.task.id, kind: 'prepare', summary: '完成了橡木木板小营地的备料和建造。途中采集 2 次、合成 4 次。',
  }])
  failEnqueue = true
  const gathering = await service.dig('oak_log')
  assert.equal(gathering.task.status, 'succeeded')
  assert.equal(moments[1].taskId, gathering.task.id)
  const warning = store.activities().find(activity => activity.kind === 'world.share-queue-failed')
  assert.equal(warning.taskId, gathering.task.id)
  assert.doesNotMatch(JSON.stringify(warning), /private-enqueue-error/u)
})
