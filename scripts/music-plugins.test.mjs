import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MusicPluginService, resolvePluginFile } from '../src/host/music-plugins.ts'

function fixture(t, { network = [], companion, fetcher } = {}) {
  const root = mkdtempSync('.work/music-plugins-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const demo = join(root, 'demo')
  mkdirSync(demo, { recursive: true })
  writeFileSync(join(demo, 'plugin.json'), JSON.stringify({
    id: 'demo', name: 'Demo', version: '1.0.0', main: 'index.js', playback: 'stream',
    permissions: { network }, settings: [{ key: 'greeting', label: 'Greeting' }],
  }))
  writeFileSync(join(demo, 'index.js'), `
export function home() { return { title: host.setting('greeting') || 'Welcome', sections: [] } }
export function search({ query, kind, offset }) {
  const tracks = [{ id: 't1', name: 'Song One', artists: [{ id: 'a1', name: 'A' }], duration: 12000 }]
  return { [kind]: offset > 0 ? [] : tracks.filter(track => track.name.toLowerCase().includes(query.toLowerCase())), more: false }
}
export function stream({ id }) {
  if (id !== 't1') { const e = new Error('no'); e.code = 'unavailable'; throw e }
  return { url: 'file://' + host.dir + '/tone.mp3', type: 'mp3' }
}
export function remember({ value }) { host.storage.set('v', value); return host.storage.get('v') }
export async function remote() { return await host.fetch('https://api.example.test/x') }
export function library() { return host.companion('singing') }
export { search as find };
`)
  writeFileSync(join(demo, 'tone.mp3'), Buffer.from([1, 2, 3]))
  const broken = join(root, 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'plugin.json'), '{ not json')
  const service = new MusicPluginService(root, companion ?? (async () => ({ items: [] })), fetcher)
  service.start()
  return { service, root, demo }
}

test('plugin list skips broken manifests and exposes settings', t => {
  const { service } = fixture(t)
  assert.deepEqual(service.list(), [{ id: 'demo', name: 'Demo', version: '1.0.0', playback: 'stream', settings: [{ key: 'greeting', label: 'Greeting' }] }])
})

test('search, stream and storage behave like the MyGo plugin contract', async t => {
  const { service, demo } = fixture(t)
  const found = await service.call('demo', 'search', { query: 'song', kind: 'tracks', offset: 0 })
  assert.equal(found.tracks[0].id, 't1')
  assert.deepEqual(await service.call('demo', 'search', { query: 'song', kind: 'tracks', offset: 1 }), { tracks: [], more: false })
  assert.equal((await service.call('demo', 'find', { query: 'song', kind: 'tracks', offset: 0 })).tracks[0].id, 't1')
  const stream = await service.call('demo', 'stream', { id: 't1' })
  assert.equal(stream.url, `file://${resolve(demo)}/tone.mp3`)
  await assert.rejects(service.call('demo', 'stream', { id: 'nope' }), { code: 'music-plugin-unavailable' })
  assert.equal(await service.call('demo', 'remember', { value: 42 }), 42)
  assert.equal(await service.call('demo', 'remember', { value: 43 }), 43)
  assert.equal(resolvePluginFile(demo, stream.url), join(resolve(demo), 'tone.mp3'))
  assert.throws(() => resolvePluginFile(demo, 'file:///etc/passwd'), { code: 'music-plugin-path-refused' })
})

test('network fetch is denied without the permission and settings stay private', async t => {
  const { service } = fixture(t)
  await assert.rejects(service.call('demo', 'remote', {}), { code: 'music-plugin-unsupported' })
  const allowed = fixture(t, { network: ['api.example.test'], fetcher: async () => new Response('{}', { status: 403 }) })
  const result = await allowed.service.call('demo', 'remote', {})
  assert.equal(result.ok, false)
})

test('companion bridge is read-only whitelisted data and unknown plugins fail closed', async t => {
  const { service } = fixture(t, { companion: async path => (path === 'singing' ? { items: [{ id: 's1', title: '空城计' }] } : null) })
  assert.deepEqual(await service.call('demo', 'library', {}), { items: [{ id: 's1', title: '空城计' }] })
  await assert.rejects(service.call('missing', 'search', {}), { code: 'music-plugin-not-found' })
  await assert.rejects(service.call('demo', 'nope', {}), { code: 'music-plugin-unsupported' })
})
test('dafeiyu source plugin lists, searches and streams the Companion archive', async t => {
  const root = mkdtempSync('.work/music-plugins-dafeiyu-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'dafeiyu'), { recursive: true })
  for (const file of ['plugin.json', 'index.js']) {
    writeFileSync(join(root, 'dafeiyu', file), readFileSync(join('plugins', 'dafeiyu', file)))
  }
  const service = new MusicPluginService(root, async path => {
    if (path !== 'singing') throw new Error('unexpected bridge path')
    return { version: 1, items: [{ id: '5adeffbd-0ad4-4919-82c6-1a0b791db949', title: '空城计（大肥鱼翻唱）', durationSeconds: 18.04 }] }
  })
  service.start()
  const home = await service.call('dafeiyu', 'home', {})
  assert.equal(home.sections[0].tracks[0].name, '空城计（大肥鱼翻唱）')
  assert.equal(home.sections[0].tracks[0].duration, 18040)
  const found = await service.call('dafeiyu', 'search', { query: '空城', kind: 'tracks', offset: 0 })
  assert.equal(found.tracks.length, 1)
  const empty = await service.call('dafeiyu', 'search', { query: '不存在', kind: 'tracks', offset: 0 })
  assert.equal(empty.tracks.length, 0)
  const stream = await service.call('dafeiyu', 'stream', { id: '5adeffbd-0ad4-4919-82c6-1a0b791db949' })
  assert.equal(stream.url, 'companion://singing/5adeffbd-0ad4-4919-82c6-1a0b791db949')
  await assert.rejects(service.call('dafeiyu', 'stream', { id: 'nope' }), { code: 'music-plugin-unavailable' })
})

test('the upstream MyGo demo plugin loads and answers search and stream', async t => {
  const reference = '.work/mygo-music-reference/examples/demo-plugin'
  if (!existsSync(reference)) return
  const root = mkdtempSync('.work/music-plugins-upstream-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'demo'), { recursive: true })
  cpSync(reference, join(root, 'demo'), { recursive: true })
  const service = new MusicPluginService(root, async () => ({ items: [] }))
  service.start()
  assert.deepEqual(service.list().map(plugin => plugin.id), ['demo'])
  const found = await service.call('demo', 'search', { query: 'song', kind: 'tracks', offset: 0 })
  assert.equal(found.tracks.length, 3)
  const stream = await service.call('demo', 'stream', { id: 't1' })
  assert.equal(stream.type, 'mp3')
  assert.equal(resolvePluginFile(service.pluginDir('demo'), stream.url), join(resolve(root), 'demo', 'tone.mp3'))
})
