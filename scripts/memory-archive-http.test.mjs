import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { AutonomyService } from '../src/host/autonomy.ts'
import { registerHttp } from '../src/host/http.ts'
import { CompanionRuntime } from '../src/host/runtime.ts'

const DAY = 86_400_000

async function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/memory-archive-http-'))
  const dbPath = join(directory, 'store.sqlite')
  const store = new CompanionStore(dbPath)
  let origin, handler
  const ctx = {
    agents: { get: () => undefined, roots: () => [] },
    webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler; return () => {} } },
  }
  const media = join(directory, 'media')
  const runtime = new CompanionRuntime(ctx, store, 'test', { provider: 'piper', pythonPath: '/unavailable', modelPath: '/unavailable', mediaDir: media, timeoutMs: 5000 }, media, directory, directory, directory, 'owner')
  registerHttp(ctx, runtime)
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const call = (path, method = 'GET', input, management = true) => fetch(`${origin}/companion/api/${path}`, {
    method, headers: { ...(management && { 'x-companion-request': '1' }), ...(input !== undefined && { 'content-type': 'application/json' }) },
    ...(input !== undefined && { body: JSON.stringify(input) }),
  })
  const seedOld = (content, overrides = {}) => {
    const memory = store.memory.create({ kind: 'other', scope: 'shared', status: 'active', importance: 0.2, confidence: 0.6, content, ...overrides })
    const date = new Date(Date.now() - 200 * DAY).toISOString()
    const db = new DatabaseSync(dbPath)
    try { db.prepare('UPDATE memory SET created_at=?,updated_at=?,last_used_at=? WHERE id=?').run(date, date, date, memory.id) }
    finally { db.close() }
    return store.memory.get(memory.id)
  }
  return { store, runtime, call, seedOld }
}

test('owner can preview, apply a current archive, search its original text and restore the prior status', async t => {
  const h = await fixture(t)
  const active = h.seedOld('很久没提到的格陵兰公园线索')
  const candidate = h.seedOld('冬季读书备选线索', { status: 'candidate', scope: 'context', contextId: 'chat.mobile' })
  const pinned = h.seedOld('锚点不被批量归档', { pinned: true })
  const evidenced = h.seedOld('真实营地经历', { confidence: 0.95, sourceRefs: [{ sessionId: 'game', eventSeq: 12 }] })
  assert.equal((await h.call('memories/archive-preview', 'GET', undefined, false)).status, 403)
  assert.equal((await h.call('events', 'POST', { source: 'core.memory', kind: 'memory.archive-sweep', summary: '伪造后台归档' })).status, 403)
  const { items } = await (await h.call('memories/archive-preview')).json()
  assert.deepEqual(new Set(items.map(item => item.id)), new Set([active.id, candidate.id]))
  assert.equal(items.find(item => item.id === candidate.id).excerpt, candidate.content)
  assert.equal(items.find(item => item.id === candidate.id).contextId, 'chat.mobile')

  const body = { items: items.map(({ id, updatedAt }) => ({ id, updatedAt })) }
  assert.equal((await h.call('memories/archive-stale', 'POST', { items: [body.items[0], body.items[0]] })).status, 400)
  h.store.memory.recordRecall([active])
  const applied = await h.call('memories/archive-stale', 'POST', body)
  assert.equal(applied.status, 200)
  assert.deepEqual(await applied.json(), { archived: 1, skipped: 1 })
  assert.equal(h.store.memory.get(active.id).status, 'active')
  assert.equal(h.store.memory.get(evidenced.id).status, 'active')
  const archived = await (await h.call(`memories?status=archived&q=${encodeURIComponent('冬季读书')}`)).json()
  assert.deepEqual(archived.items.map(item => item.id), [candidate.id])
  assert.equal(archived.items[0].archivedFrom, 'candidate')
  assert.equal(archived.counts.archived, 1)
  assert.equal(h.store.memory.find('冬季读书', { status: 'active+candidate', contextId: 'chat.mobile' }).length, 0)
  assert.equal((await h.call(`memories/${candidate.id}`, 'PATCH', { status: 'active' })).status, 409)
  assert.equal((await h.call(`memories/${pinned.id}/archive`, 'POST', {})).status, 409)
  const restored = await (await h.call(`memories/${candidate.id}/restore`, 'POST', { reason: '主人恢复' })).json()
  assert.equal(restored.status, 'candidate')
  assert.equal(restored.scope, 'context')
  assert.deepEqual(h.store.memory.revisions(candidate.id).map(item => item.snapshot.status), ['candidate', 'archived', 'candidate'])

  assert.equal((await (await h.call(`memories/${active.id}/archive`, 'POST', {})).json()).status, 'archived')
  assert.equal((await (await h.call(`memories/${active.id}/restore`, 'POST', {})).json()).status, 'active')
  assert.equal((await (await h.call(`memories/${active.id}/forget`, 'POST', {})).json()).status, 'forgotten')
  assert.equal((await (await h.call(`memories/${active.id}/restore`, 'POST', {})).json()).status, 'candidate')
})

test('automatic sweep is opt-in, capped by a persisted daily marker, and respects global pause', async t => {
  const h = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const first = h.seedOld('应当被第一次后台归档的线索')
  await h.runtime.autonomy.tick()
  assert.equal(h.store.memory.get(first.id).status, 'active')
  assert.equal(h.store.autonomy.lastMemoryArchiveAt(), undefined)
  const settings = await h.call('autonomy', 'PUT', { memoryArchiveEnabled: true })
  assert.equal(settings.status, 200)
  assert.equal((await settings.json()).settings.memoryArchiveEnabled, true)
  await h.runtime.autonomy.tick()
  assert.equal(h.store.memory.get(first.id).status, 'archived')
  assert.equal(h.store.autonomy.lastMemoryArchiveAt(), now)

  const second = h.seedOld('下一次扫描才可归档的线索')
  const resumed = new AutonomyService(h.store, {})
  await resumed.tick()
  assert.equal(h.store.memory.get(second.id).status, 'active')
  now += DAY
  resumed.updateSettings({ enabled: false })
  await resumed.tick()
  assert.equal(h.store.memory.get(second.id).status, 'active')
  resumed.updateSettings({ enabled: true })
  await resumed.tick()
  assert.equal(h.store.memory.get(second.id).status, 'archived')
  assert.equal(h.store.autonomy.lastMemoryArchiveAt(), now)
  assert.equal(h.store.activities().filter(item => item.kind === 'memory.archive-sweep').length, 2)
})
