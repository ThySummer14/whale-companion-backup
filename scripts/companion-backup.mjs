#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const manifestFile = 'manifest.json'
const databaseFile = 'companion/companion.db'
const minecraftCursor = 'minecraft/cbi-events.cursor'
const dshTrees = ['attachments', 'sessions', 'storages']
const packagePattern = /^dsh-companion-bot-(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)\.tgz$/u

const usage = `Usage:
  node scripts/companion-backup.mjs create --offline --dsh-home DIR --snapshot NEW_DIR --package FILE [--data-dir DIR]
  node scripts/companion-backup.mjs verify --snapshot DIR
  node scripts/companion-backup.mjs restore --offline --snapshot DIR --dsh-home NEW_DIR

Stop every DSH writer sharing these data directories before create or restore.
Restore prepares a fresh data-only DSH Home. Install the verified bundled package separately.`

function contains(parent, path) {
  const rel = relative(parent, path)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function fileInfo(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function need(path, kind) {
  const info = await fileInfo(path)
  if (kind === 'file' ? !info?.isFile() : !info?.isDirectory()) throw new Error(`Expected a regular ${kind}: ${path}`)
  return info
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function copyRegular(source, destination) {
  const before = await need(source, 'file')
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  await chmod(destination, 0o600)
  const after = await need(source, 'file')
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Source changed while copying: ${source}`)
  }
}

async function copyTree(source, destination) {
  await need(source, 'directory')
  await mkdir(destination, { mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else await copyRegular(from, to)
  }
}

async function withNewDirectory(path, sources, action) {
  const parent = await realpath(dirname(path))
  const target = join(parent, basename(path))
  for (const source of sources) {
    const original = await realpath(source)
    if (contains(original, target) || contains(target, original)) throw new Error('Destination must be separate from the source')
  }
  await mkdir(target, { mode: 0o700 })
  try { return await action(target) }
  catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

function databaseSchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (!Number.isSafeInteger(version) || version < 1 ||
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_binding'").get()) {
    throw new Error('Expected a Companion database with a known schema version')
  }
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Companion database failed integrity or foreign-key checks')
  }
  return version
}

async function snapshotDatabase(source, destination) {
  await need(source, 'file')
  const input = new DatabaseSync(source, { readOnly: true })
  try { await backup(input, destination) }
  finally { input.close() }
  await chmod(destination, 0o600)
  const copy = new DatabaseSync(destination)
  try {
    // Ship a self-contained SQLite file. Checkpoints and sidecars stay with the source.
    copy.exec('PRAGMA journal_mode=DELETE')
    return databaseSchema(copy)
  } finally { copy.close() }
}

function bundleVersion(path, name) {
  const version = packagePattern.exec(name)?.[1]
  if (!version) throw new Error('Expected a versioned dsh-companion-bot tarball')
  const contents = execFileSync('tar', ['-xOf', path, 'package/package.json'], { maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const bundle = JSON.parse(contents)
  if (bundle.name !== 'dsh-companion-bot' || bundle.version !== version) throw new Error('Companion package name or version does not match its tarball name')
  return version
}

async function inventory(root, dir = '', files = []) {
  for (const name of (await readdir(join(root, dir))).sort()) {
    if (!dir && name === manifestFile) continue
    const path = dir ? `${dir}/${name}` : name
    const full = join(root, path)
    const info = await lstat(full)
    if (info.isDirectory()) {
      files.push({ path, directory: true })
      await inventory(root, path, files)
    } else if (info.isFile()) files.push({ path, bytes: info.size, sha256: await hashFile(full) })
    else throw new Error(`Unsupported snapshot entry: ${path}`)
  }
  return files
}

async function verifySnapshot(path) {
  await need(path, 'directory')
  const manifestPath = join(path, manifestFile)
  await need(manifestPath, 'file')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.format !== 1 || typeof manifest.package !== 'string' || !packagePattern.test(manifest.package) ||
    typeof manifest.sourceVoiceRoot !== 'string' || !isAbsolute(manifest.sourceVoiceRoot) ||
    !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.schema)) throw new Error('Invalid Companion snapshot manifest')
  const roots = new Set(['companion', manifest.package, ...dshTrees, manifestFile])
  await need(join(path, 'companion'), 'directory')
  if ((await readdir(path)).some(name => !roots.has(name)) ||
    (await readdir(join(path, 'companion'))).some(name => !['companion.db', 'media', 'minecraft'].includes(name))) {
    throw new Error('Unexpected files in snapshot')
  }
  const minecraft = join(path, 'companion', 'minecraft')
  if (await fileInfo(minecraft)) {
    await need(minecraft, 'directory')
    await need(join(path, 'companion', minecraftCursor), 'file')
    if ((await readdir(minecraft)).length !== 1) throw new Error('Unexpected files in Minecraft snapshot')
  }
  const actual = await inventory(path)
  if (JSON.stringify(manifest.files) !== JSON.stringify(actual)) throw new Error('Snapshot file inventory or SHA-256 mismatch')
  for (const tree of ['companion/media', ...dshTrees]) {
    const file = join(path, tree)
    if (await fileInfo(file)) await need(file, 'directory')
  }
  const packagePath = join(path, manifest.package)
  await need(packagePath, 'file')
  if (bundleVersion(packagePath, manifest.package) !== manifest.version) throw new Error('Snapshot package version mismatch')
  const dbPath = join(path, databaseFile)
  await need(dbPath, 'file')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (databaseSchema(db) !== manifest.schema) throw new Error('Snapshot database schema mismatch')
  } finally { db.close() }
  return manifest
}

async function createSnapshot({ home, data, snapshot, packagePath }) {
  await need(home, 'directory')
  await need(data, 'directory')
  await need(packagePath, 'file')
  const name = basename(packagePath)
  const version = bundleVersion(packagePath, name)
  return withNewDirectory(snapshot, [home, data, packagePath], async target => {
    await mkdir(join(target, 'companion'), { mode: 0o700 })
    const schema = await snapshotDatabase(join(data, 'companion.db'), join(target, databaseFile))
    const trees = [['companion/media', join(data, 'media')], ...dshTrees.map(tree => [tree, join(home, tree)])]
    for (const [tree, source] of trees) {
      if (await fileInfo(source)) await copyTree(source, join(target, tree))
    }
    const workerDir = join(data, 'minecraft')
    if (await fileInfo(workerDir)) {
      await need(workerDir, 'directory')
      const cursor = join(data, minecraftCursor)
      if (await fileInfo(cursor)) {
        await mkdir(join(target, 'companion', 'minecraft'), { mode: 0o700 })
        await copyRegular(cursor, join(target, 'companion', minecraftCursor))
      }
    }
    await copyRegular(packagePath, join(target, name))
    const files = await inventory(target)
    const manifest = { format: 1, createdAt: new Date().toISOString(), package: name, version, schema,
      sourceVoiceRoot: join(data, 'media', 'voice'), files }
    const pending = join(target, 'manifest.pending')
    await writeFile(pending, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(pending, join(target, manifestFile))
    return manifest
  })
}

function restoreVoicePaths(path, source, destination, files) {
  const db = new DatabaseSync(path)
  const counters = { relocatedVoiceFiles: 0, unavailableVoiceFiles: 0 }
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tts_asset'").get()) return counters
    const paths = new Set(files.filter(file => !file.directory).map(file => file.path))
    const rows = db.prepare('SELECT id, file_path FROM tts_asset').all()
    const change = db.prepare('UPDATE tts_asset SET file_path=? WHERE id=? AND file_path=?')
    db.exec('BEGIN IMMEDIATE')
    for (const row of rows) {
      const name = basename(row.file_path)
      if (row.file_path !== join(source, name) || !name.endsWith('.wav') || !paths.has(`companion/media/voice/${name}`)) {
        counters.unavailableVoiceFiles++
        continue
      }
      const next = join(destination, name)
      if (row.file_path !== next) {
        change.run(next, row.id, row.file_path)
        counters.relocatedVoiceFiles++
      }
    }
    db.exec('COMMIT')
    databaseSchema(db)
    return counters
  } finally { db.close() }
}

async function restoreSnapshot(snapshot, home) {
  const manifest = await verifySnapshot(snapshot)
  const counts = await withNewDirectory(home, [snapshot], async target => {
    for (const tree of ['companion', ...dshTrees]) {
      const source = join(snapshot, tree)
      if (await fileInfo(source)) await copyTree(source, join(target, tree))
    }
    const actual = await inventory(target)
    if (JSON.stringify(manifest.files.filter(file => file.path !== manifest.package)) !== JSON.stringify(actual)) {
      throw new Error('Restored data did not match the verified snapshot')
    }
    return restoreVoicePaths(join(target, databaseFile), manifest.sourceVoiceRoot, join(home, 'companion', 'media', 'voice'), actual)
  })
  return { ...manifest, ...counts }
}

async function run() {
  const command = process.argv[2]
  if (command === '--help' || command === '-h' || !command) { console.log(usage); return }
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    'dsh-home': { type: 'string' }, 'data-dir': { type: 'string' }, snapshot: { type: 'string' },
    package: { type: 'string' }, offline: { type: 'boolean' },
  } })
  const required = {
    create: ['snapshot', 'dsh-home', 'package', 'offline'], verify: ['snapshot'], restore: ['snapshot', 'dsh-home', 'offline'],
  }
  const flags = Object.hasOwn(required, command) ? required[command] : undefined
  if (!flags || flags.some(key => !values[key]) ||
    Object.keys(values).some(key => !flags.includes(key) && !(command === 'create' && key === 'data-dir' && values[key]))) throw new Error(usage)
  const snapshot = resolve(values.snapshot)
  const home = values['dsh-home'] && resolve(values['dsh-home'])
  const manifest = command === 'create' ? await createSnapshot({
    home, data: resolve(values['data-dir'] ?? join(home, 'companion')), snapshot, packagePath: resolve(values.package),
  }) : command === 'restore' ? await restoreSnapshot(snapshot, home) : await verifySnapshot(snapshot)
  const files = manifest.files.filter(file => !file.directory)
  console.log(JSON.stringify({ action: command, package: manifest.package, schema: manifest.schema,
    files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0),
    ...(command === 'restore' && { relocatedVoiceFiles: manifest.relocatedVoiceFiles, unavailableVoiceFiles: manifest.unavailableVoiceFiles }),
  }))
}

run().catch(error => { console.error(error.message); process.exitCode = 1 })
