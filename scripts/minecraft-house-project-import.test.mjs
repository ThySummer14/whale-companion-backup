import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MinecraftHouseProjectImportInput, planMinecraftHouseProjectImport } from '../src/core/minecraft-house-project-import.ts'
import { MinecraftHouseProjectInput, MinecraftHouseProjectVerifyRequest, minecraftHouseProjectRequests } from '../src/core/minecraft-house-project.ts'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { MinecraftService } from '../src/host/minecraft.ts'

const zone = { id: '2e869bd7-be98-43f5-86c9-dca95cf53b96', dimension: 'minecraft:the_nether', x: -1944, y: 70, z: 3318, radius: 8 }
const filled = () => 'o'
const palette = '.oscg'

function whole(width, depth, height, block = filled, zoneId = zone.id) {
  const blocks = []
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) blocks.push(block(x, y, z))
    }
  }
  return { name: '连廊与天井', zoneId, layout: { width, depth, height, blocks: blocks.join('') } }
}

function verifyRoundTrip(input, area = zone) {
  const result = planMinecraftHouseProjectImport(MinecraftHouseProjectImportInput.parse(input), area)
  assert.equal(typeof result, 'object', JSON.stringify(result))
  assert.equal(result.project.name, input.name.trim())
  assert.equal(result.project.zoneId, area.id)
  assert.ok(MinecraftHouseProjectInput.safeParse(result.project).success)
  const requests = minecraftHouseProjectRequests(result.project, area)
  assert.ok(MinecraftHouseProjectVerifyRequest.safeParse({ sections: requests }).success)
  assert.equal(requests.length, result.project.sections.length)

  const { width, depth, height, blocks } = input.layout
  const west = area.x - Math.floor(width / 2)
  const north = area.z - Math.floor(depth / 2)
  const rebuilt = Array.from({ length: blocks.length })
  for (const { layout, zone: child } of requests) {
    assert.equal(child.dimension, area.dimension)
    assert.equal(child.id, area.id)
    assert.ok(Math.max(Math.abs(child.x - area.x), Math.abs(child.y - area.y), Math.abs(child.z - area.z)) + child.radius <= area.radius)
    assert.ok(layout.width <= 5 && layout.depth <= 5 && layout.height <= 5)
    assert.ok(layout.blocks.replaceAll('.', '').length >= 1 && layout.blocks.replaceAll('.', '').length <= 100)
    const childWest = child.x - Math.floor(layout.width / 2) - west
    const childNorth = child.z - Math.floor(layout.depth / 2) - north
    const childBase = child.y - area.y
    for (const [index, block] of Array.from(layout.blocks).entries()) {
      const x = childWest + index % layout.width
      const z = childNorth + Math.floor(index / layout.width) % layout.depth
      const y = childBase + Math.floor(index / (layout.width * layout.depth))
      assert.ok(x >= 0 && x < width && z >= 0 && z < depth && y >= 0 && y < height, `out-of-bounds cell: ${x},${y},${z}`)
      const wholeIndex = (y * depth + z) * width + x
      assert.equal(rebuilt[wholeIndex], undefined, `overlapping cell: ${x},${y},${z}`)
      rebuilt[wholeIndex] = block
    }
  }
  assert.equal(rebuilt.join(''), blocks)
  const materials = {}
  for (const block of blocks) if (block !== '.') materials[block] = (materials[block] ?? 0) + 1
  assert.deepEqual(result.materials, materials)
  assert.equal(result.checked, blocks.length)
  assert.equal(result.placed, Object.values(materials).reduce((count, value) => count + value, 0))
  return result
}

test('whole blueprint retains asymmetric x/z orientation, multiple layers and each material', () => {
  const input = whole(9, 5, 4, (x, y, z) => palette[(x + 2 * y + 3 * z) % palette.length])
  input.name = '  连廊与天井  '
  const before = structuredClone(input)
  const plan = verifyRoundTrip(input)
  assert.deepEqual(verifyRoundTrip(input), plan)
  assert.deepEqual(input, before)
  assert.equal(plan.checked, 180)
  assert.deepEqual(Object.keys(plan.materials).sort(), ['c', 'g', 'o', 's'])
})

test('minimum dense two-section blueprint uses the existing rectangular section contract', () => {
  const plan = verifyRoundTrip(whole(10, 5, 4))
  assert.equal(plan.project.sections.length, 2)
  assert.equal(plan.placed, 200)
})

test('long wing requiring at least three segments fits the authorized radius', () => {
  const plan = verifyRoundTrip(whole(15, 5, 3, (x, y, z) => y === 0 ? 'c' : palette[(x + y + z) % palette.length]))
  assert.ok(plan.project.sections.length >= 3)
  assert.equal(plan.checked, 225)
})

test('two-axis division preserves four dense quadrants and their shared edges', () => {
  const plan = verifyRoundTrip(whole(10, 10, 4, (x, y, z) => x < 5 ? (z < 5 ? 'o' : 's') : (z < 5 ? 'c' : 'g')))
  assert.ok(plan.project.sections.length >= 4)
  assert.deepEqual(plan.materials, { o: 100, s: 100, c: 100, g: 100 })
})

test('one dense quadrant can be subdivided while keeping adjacent sections intact', () => {
  const plan = verifyRoundTrip(whole(10, 10, 5, (x, y, z) => (x < 5 && z < 5) || y < 2 ? 'c' : '.'))
  assert.ok(plan.project.sections.length >= 5)
  assert.equal(plan.placed, 275)
})

test('six sections retain all 600 solid blocks at the maximum density', () => {
  const plan = verifyRoundTrip(whole(15, 10, 4, (x, y, z) => palette[1 + (x + y + z) % 4]))
  assert.equal(plan.project.sections.length, 6)
  assert.equal(plan.checked, 600)
  assert.equal(plan.placed, 600)
})

test('the 750-position format limit does not override a child section stance limit', () => {
  const input = whole(15, 10, 5, (x, y, z) => y === 4 ? '.' : palette[1 + (x + y + z) % 4])
  const parsed = MinecraftHouseProjectImportInput.parse(input)
  assert.equal(parsed.layout.blocks.length, 750)
  assert.equal(planMinecraftHouseProjectImport(parsed, zone), 'minecraft-house-project-zone-invalid')
})

test('surrounding air, hollow floors and a clear top survive partitioning', () => {
  const plan = verifyRoundTrip(whole(11, 5, 5, (x, y, z) => {
    if (x === 0 || x === 10 || z === 0 || z === 4 || y === 4 || (x === 7 && z === 2 && y < 3)) return '.'
    return y % 2 ? 'g' : 's'
  }))
  assert.equal(plan.placed, 105)
  assert.equal(plan.checked, 275)
})

test('a layout with exactly 101 solid cells still exceeds the single-house threshold', () => {
  const plan = verifyRoundTrip(whole(10, 5, 3, (x, y, z) => y < 2 || (x === 5 && z === 2) ? 's' : '.'))
  assert.equal(plan.placed, 101)
  assert.ok(plan.project.sections.length >= 2)
})

test('a narrow authorization that cannot contain the blueprint rejects all partitions', () => {
  const plan = planMinecraftHouseProjectImport(MinecraftHouseProjectImportInput.parse(whole(10, 5, 4)), { ...zone, radius: 2 })
  assert.equal(plan, 'minecraft-house-project-zone-invalid')
})

test('a horizontal pair can take an additional vertical cut when only one child lacks stance radius', () => {
  const input = whole(10, 5, 4)
  const wider = verifyRoundTrip(input, { ...zone, radius: 6 })
  const tighter = verifyRoundTrip(input, { ...zone, radius: 5 })
  assert.equal(wider.project.sections.length, 2)
  assert.equal(tighter.project.sections.length, 3)
  assert.ok(tighter.project.sections.some(section => section.offset.y > 0))
})

test('a 750-position layout with a 125-solid section cannot fit within six valid sections', () => {
  const input = whole(15, 10, 5, (x, y, z) => x < 5 && z < 5 ? 'o' : y < 3 ? 's' : '.')
  assert.equal(planMinecraftHouseProjectImport(MinecraftHouseProjectImportInput.parse(input), zone), 'minecraft-house-project-import-unsplittable')
})

test('a forced empty section cannot be dropped or counted as an air-only construction task', () => {
  const input = whole(15, 10, 5, (x, y, z) => (x < 5 && z < 5) || y === 4 ? '.' : 'o')
  assert.equal(planMinecraftHouseProjectImport(MinecraftHouseProjectImportInput.parse(input), zone), 'minecraft-house-project-import-unsplittable')
})

test('layout whose horizontal span requires more than six sections fails without dropping cells', () => {
  const input = whole(15, 15, 3, (x, y, z) => y < 2 ? 's' : '.')
  assert.equal(planMinecraftHouseProjectImport(MinecraftHouseProjectImportInput.parse(input), zone), 'minecraft-house-project-import-unsplittable')
})

const valid = whole(10, 5, 4)
for (const [reason, value] of [
  ['fewer than 101 solid cells', whole(5, 5, 4)],
  ['wholly empty layout', whole(10, 5, 4, () => '.')],
  ['more than 600 solid cells', whole(15, 10, 5)],
  ['more than 750 total positions with an otherwise valid solid count', whole(16, 10, 5, (_x, y) => y < 2 ? 'o' : '.')],
  ['an axis longer than 17', whole(18, 5, 2)],
  ['zero width', { ...valid, layout: { ...valid.layout, width: 0 } }],
  ['non-integer dimensions', { ...valid, layout: { ...valid.layout, height: 4.5 } }],
  ['string dimension', { ...valid, layout: { ...valid.layout, depth: '5' } }],
  ['missing cells', { ...valid, layout: { ...valid.layout, blocks: valid.layout.blocks.slice(1) } }],
  ['extra cells', { ...valid, layout: { ...valid.layout, blocks: valid.layout.blocks + '.' } }],
  ['unsupported block symbols', { ...valid, layout: { ...valid.layout, blocks: 'X' + valid.layout.blocks.slice(1) } }],
  ['raw newlines in a canonical block sequence', { ...valid, layout: { ...valid.layout, blocks: '\n' + valid.layout.blocks.slice(1) } }],
  ['untrusted layout fields', { ...valid, layout: { ...valid.layout, origin: [0, 0, 0] } }],
  ['untrusted root fields', { ...valid, autoBuild: true }],
  ['a malformed zone id', { ...valid, zoneId: 'owner-plot' }],
  ['blank project name', { ...valid, name: ' \t ' }],
  ['an oversized project name', { ...valid, name: 'a'.repeat(81) }],
]) {
  test(`whole blueprint schema rejects ${reason}`, () => {
    assert.equal(MinecraftHouseProjectImportInput.safeParse(value).success, false)
  })
}

async function httpFixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = mkdtempSync('.work/house-import-http-')
  const database = join(directory, 'companion.sqlite')
  const store = new CompanionStore(database)
  const { id: _id, ...buildZone } = zone
  const area = store.createBuildZone({ name: '隔离建造区', ...buildZone })
  const narrow = store.createBuildZone({ name: '隔离窄地块', ...buildZone, x: buildZone.x + 30, radius: 2 })
  const originalActivities = store.activities()
  const reader = new DatabaseSync(database, { readOnly: true })
  const minecraft = new MinecraftService(store, {}, { dataDir: directory, serverRoot: directory, owner: 'fixture' })
  let requests = 0
  minecraft.request = async () => {
    requests++
    throw new Error('isolated Worker is offline')
  }
  let handler, origin
  const webServer = { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } }
  registerHttp({ webServer }, { store, minecraft })
  const server = createServer(handler)
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    reader.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const url = `${origin}/companion/api/minecraft/house-projects`
  const owner = { 'x-companion-request': '1', origin }
  const post = (path, input, headers = owner) => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: typeof input === 'string' ? input : JSON.stringify(input) })
  const check = async (response, status, code) => {
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    if (code) assert.equal(result.code, code)
    return result
  }
  return { store, database, area, narrow, owner, post, check, originalActivities, requests: () => requests,
    dataVersion: () => reader.prepare('PRAGMA data_version').get().data_version }
}

test('loopback management previews whole blueprints offline without changing persisted state', async t => {
  const h = await httpFixture(t)
  const input = { ...valid, zoneId: h.area.id }
  const preview = '/import-preview'
  const before = h.dataVersion()
  await t.test('missing owner request header is refused', async () => {
    await h.check(await h.post(preview, input, {}), 403, 'origin-refused')
  })
  await t.test('a device-like authorization header does not grant workbench access', async () => {
    await h.check(await h.post(preview, input, { authorization: 'Bearer isolated-device' }), 403, 'origin-refused')
  })
  await t.test('cross-origin preview is refused even with the owner request header', async () => {
    await h.check(await h.post(preview, input, { ...h.owner, origin: 'https://outside.invalid' }), 403, 'origin-refused')
  })
  await t.test('query parameters cannot alter the import preview contract', async () => {
    await h.check(await h.post(`${preview}?build=true`, input), 400, 'invalid-request')
  })
  await t.test('invalid JSON receives the normal parse error', async () => {
    await h.check(await h.post(preview, '{'), 400, 'invalid-json')
  })
  await t.test('oversized JSON is refused before planning', async () => {
    await h.check(await h.post(preview, JSON.stringify(input) + ' '.repeat(65_536)), 400, 'body-too-large')
  })
  await t.test('a syntactically valid blueprint for an unknown zone is refused', async () => {
    await h.check(await h.post(preview, { ...input, zoneId: randomUUID() }), 404, 'build-zone-not-found')
  })
  await t.test('insufficient authorization is distinguished from a malformed layout', async () => {
    await h.check(await h.post(preview, { ...input, zoneId: h.narrow.id }), 400, 'minecraft-house-project-zone-invalid')
    await h.check(await h.post(preview, { ...input, layout: { ...input.layout, blocks: '' } }), 400, 'invalid-request')
  })
  await t.test('valid but unsplittable layouts receive a dedicated error', async () => {
    const large = whole(15, 10, 5, (x, y, z) => (x < 5 && z < 5) || y === 4 ? '.' : 'o', h.area.id)
    await h.check(await h.post(preview, large), 400, 'minecraft-house-project-import-unsplittable')
  })
  await t.test('the same read-only offline preview is deterministic and never reaches the Worker', async () => {
    const first = await h.check(await h.post(preview, input), 200)
    const second = await h.check(await h.post(preview, input), 200)
    assert.deepEqual(first, second)
    const { id, dimension, x, y, z, radius } = h.area
    assert.deepEqual(first, verifyRoundTrip(input, { id, dimension, x, y, z, radius }))
    assert.equal(h.dataVersion(), before)
    assert.deepEqual(h.store.minecraftHouseProjects.list(), [])
    assert.deepEqual(h.store.tasks(), [])
    assert.deepEqual(h.store.activities(), h.originalActivities)
    assert.equal(h.requests(), 0)
  })
})

test('saving the preview reuses the legacy project and rechecks current authorization', async t => {
  const h = await httpFixture(t)
  const input = { ...valid, zoneId: h.area.id }
  const { project } = await h.check(await h.post('/import-preview', input), 200)
  let saved
  await t.test('the legacy save endpoint still requires a complete sectional blueprint', async () => {
    await h.check(await h.post('', input), 400, 'invalid-request')
    assert.equal(h.store.minecraftHouseProjects.list().length, 0)
  })
  await t.test('concurrent exact saves share one persisted pending project and create no tasks', async () => {
    const responses = await Promise.all([h.post('', project), h.post('', project)])
    const [first, second] = await Promise.all(responses.map(response => h.check(response, 201)))
    saved = first
    assert.deepEqual(first, second)
    assert.equal(h.store.minecraftHouseProjects.list().length, 1)
    assert.deepEqual(first.sections.map(({ status, ...section }) => {
      assert.equal(status, 'pending')
      return section
    }), project.sections)
    assert.equal(first.verification, undefined)
    assert.deepEqual(h.store.tasks(), [])
    assert.deepEqual(h.store.activities(), h.originalActivities)
    assert.equal(h.requests(), 0)
  })
  await t.test('an imported project still needs a real fresh site approval to build', async () => {
    const path = `/${saved.id}/sections/0/build`
    await h.check(await h.post(path, {}), 400, 'invalid-request')
    await h.check(await h.post(path, { previewId: randomUUID() }), 409, 'minecraft-house-project-preview-required')
    assert.deepEqual(h.store.minecraftHouseProjects.get(saved.id), saved)
    assert.deepEqual(h.store.tasks(), [])
    assert.equal(h.requests(), 0)
  })
  await t.test('cold SQLite reopen preserves exactly the saved sections', () => {
    const reopened = new CompanionStore(h.database)
    try { assert.deepEqual(reopened.minecraftHouseProjects.get(saved.id), saved) }
    finally { reopened.close() }
  })
  await t.test('revoking authorization invalidates further import previews and direct saves', async () => {
    assert.equal(h.store.revokeBuildZone(h.area.id), true)
    await h.check(await h.post('/import-preview', input), 404, 'build-zone-not-found')
    await h.check(await h.post('', project), 404, 'build-zone-not-found')
    assert.deepEqual(h.store.minecraftHouseProjects.list(), [saved])
    assert.equal(h.requests(), 0)
  })
})
