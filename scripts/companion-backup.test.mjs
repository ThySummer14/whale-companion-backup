import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./companion-backup.mjs', import.meta.url))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function fixture(t) {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/companion-backup-test-'))
  const home = join(root, 'old home')
  const data = join(root, 'custom data')
  const snapshot = join(root, 'snapshot')
  const restored = join(root, 'restored home')
  const wav = join(data, 'media/voice/local.wav')
  const pack = join(root, 'dsh-companion-bot-0.15.1.tgz')
  const file = (path, value) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value)
  }
  file(join(root, 'package/package.json'), JSON.stringify({ name: 'dsh-companion-bot', version: '0.15.1' }))
  execFileSync('tar', ['-czf', pack, '-C', root, 'package'])
  file(join(home, 'sessions/native/session.jsonl'), 'native history\n')
  file(join(home, 'storages/session_projcache/known.json'), '{"known":true}\n')
  file(join(home, 'attachments/v1/file-objects/object'), 'native attachment\n')
  file(join(home, '.credentials.yaml'), 'fixture excluded')
  file(join(home, 'profiles/web/cordis.patch.yml'), 'fixture excluded')
  file(join(data, 'minecraft/worker.token'), 'fixture excluded')
  file(join(data, 'minecraft/cbi-events.cursor'), '31')
  file(join(data, 'singing-temp/interrupted.wav'), 'fixture excluded')
  file(join(data, 'media/feed/test.png'), 'image bytes')
  file(wav, 'voice bytes')
  mkdirSync(join(data, 'media/songs'))
  const database = join(data, 'companion.db')
  const db = new DatabaseSync(database)
  db.exec(`PRAGMA user_version=13; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session_binding (id TEXT PRIMARY KEY);
    CREATE TABLE tts_asset (id TEXT PRIMARY KEY, file_path TEXT NOT NULL);
    INSERT INTO session_binding VALUES ('chat.mobile');`)
  const insert = db.prepare('INSERT INTO tts_asset VALUES (?,?)')
  insert.run('present', wav)
  insert.run('missing', join(data, 'media/voice/missing.wav'))
  insert.run('external', join(root, 'unmanaged.wav'))
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const invoke = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { encoding: 'utf8' })
  const create = (destination = snapshot, packagePath = pack) => invoke('create', '--offline', '--dsh-home', home,
    '--data-dir', data, '--package', packagePath, '--snapshot', destination)
  const verify = () => invoke('verify', '--snapshot', snapshot)
  const restore = (destination = restored) => invoke('restore', '--offline', '--snapshot', snapshot, '--dsh-home', destination)
  return { root, home, data, db, database, pack, snapshot, restored, wav, create, verify, restore, invoke }
}

function result(command) {
  assert.equal(command.status, 0, command.stderr)
  return JSON.parse(command.stdout)
}

test('snapshot captures SQLite WAL, native state, media, old bundle and event cursor without configuration', t => {
  const h = fixture(t)
  const before = sha(h.database)
  assert.ok(statSync(`${h.database}-wal`).size > 0)
  const created = result(h.create())
  assert.equal(created.schema, 13)
  assert.deepEqual(result(h.verify()), { ...created, action: 'verify' })
  const restored = result(h.restore())
  assert.equal(restored.relocatedVoiceFiles, 1)
  assert.equal(restored.unavailableVoiceFiles, 2)
  assert.equal(sha(h.database), before)
  assert.equal(h.db.prepare("SELECT file_path FROM tts_asset WHERE id='present'").get().file_path, h.wav)
  assert.equal(sha(join(h.snapshot, created.package)), sha(h.pack))
  assert.deepEqual(readdirSync(h.snapshot).sort(), ['attachments', 'companion', created.package, 'manifest.json', 'sessions', 'storages'])
  assert.deepEqual(readdirSync(join(h.snapshot, 'companion')).sort(), ['companion.db', 'media', 'minecraft'])
  assert.deepEqual(readdirSync(join(h.restored, 'companion/minecraft')), ['cbi-events.cursor'])
  assert.equal(readFileSync(join(h.restored, 'companion/minecraft/cbi-events.cursor'), 'utf8'), '31')
  assert.equal(readFileSync(join(h.restored, 'sessions/native/session.jsonl'), 'utf8'), 'native history\n')
  assert.equal(readFileSync(join(h.restored, 'attachments/v1/file-objects/object'), 'utf8'), 'native attachment\n')
  assert.equal(sha(join(h.restored, 'storages/session_projcache/known.json')), sha(join(h.home, 'storages/session_projcache/known.json')))
  assert.equal(sha(join(h.restored, 'companion/media/feed/test.png')), sha(join(h.data, 'media/feed/test.png')))
  assert.ok(statSync(join(h.restored, 'companion/media/songs')).isDirectory())
  assert.equal(statSync(h.snapshot).mode & 0o777, 0o700)
  assert.equal(statSync(join(h.restored, 'companion/companion.db')).mode & 0o777, 0o600)

  const restoreDb = new DatabaseSync(join(h.restored, 'companion/companion.db'), { readOnly: true })
  const snapshotDb = new DatabaseSync(join(h.snapshot, 'companion/companion.db'), { readOnly: true })
  try {
    const restoredWav = restoreDb.prepare("SELECT file_path FROM tts_asset WHERE id='present'").get().file_path
    assert.equal(restoredWav, join(h.restored, 'companion/media/voice/local.wav'))
    assert.equal(sha(restoredWav), sha(h.wav))
    assert.equal(snapshotDb.prepare("SELECT file_path FROM tts_asset WHERE id='present'").get().file_path, h.wav)
    assert.equal(restoreDb.prepare("SELECT file_path FROM tts_asset WHERE id='external'").get().file_path, join(h.root, 'unmanaged.wav'))
    assert.equal(restoreDb.prepare('SELECT id FROM session_binding').get().id, 'chat.mobile')
    assert.equal(restoreDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(restoreDb.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(snapshotDb.prepare('PRAGMA journal_mode').get().journal_mode, 'delete')
  } finally { restoreDb.close(); snapshotDb.close() }
})

test('same-length corruption and undeclared entries are rejected before a restore starts', t => {
  const h = fixture(t)
  result(h.create())
  const image = join(h.snapshot, 'companion/media/feed/test.png')
  writeFileSync(image, 'IMAGE BYTES')
  assert.match(h.verify().stderr, /SHA-256 mismatch/u)
  assert.match(h.restore().stderr, /SHA-256 mismatch/u)
  assert.equal(existsSync(h.restored), false)
  writeFileSync(image, 'image bytes')
  writeFileSync(join(h.snapshot, 'unlisted'), 'extra')
  assert.match(h.restore().stderr, /Unexpected files/u)
  assert.equal(existsSync(h.restored), false)
})

test('snapshot and restore never overwrite directories, require offline acknowledgement and reject source nesting', t => {
  const h = fixture(t)
  assert.match(h.create(join(h.home, 'nested')).stderr, /separate from the source/u)
  assert.match(h.invoke('create', '--dsh-home', h.home, '--snapshot', h.snapshot, '--package', h.pack).stderr, /Usage/u)
  result(h.create())
  const digest = sha(join(h.snapshot, 'manifest.json'))
  assert.match(h.create().stderr, /EEXIST/u)
  assert.equal(sha(join(h.snapshot, 'manifest.json')), digest)
  assert.match(h.invoke('restore', '--snapshot', h.snapshot, '--dsh-home', h.restored).stderr, /Usage/u)
  assert.match(h.restore(h.home).stderr, /EEXIST/u)
  assert.equal(readFileSync(join(h.home, 'sessions/native/session.jsonl'), 'utf8'), 'native history\n')
})

test('mislabeled tarball and symlinked media are rejected without a published backup', t => {
  const h = fixture(t)
  const wrongName = join(h.root, 'dsh-companion-bot-0.56.0.tgz')
  writeFileSync(wrongName, readFileSync(h.pack))
  assert.match(h.create(h.snapshot, wrongName).stderr, /version does not match/u)
  assert.equal(existsSync(h.snapshot), false)
  symlinkSync(h.pack, join(h.data, 'media/linked'))
  assert.match(h.create().stderr, /regular file/u)
  assert.equal(existsSync(h.snapshot), false)
  assert.equal(existsSync(h.pack), true)
})
