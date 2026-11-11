import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { MlxDemucsSeparator } from '../src/host/singing-separation.ts'

function fixture(t, worker, provisioned = true) {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/singing-separation-test-'))
  const scratch = join(root, 'scratch')
  const cacheDir = join(root, 'cache')
  const pythonPath = join(root, 'python')
  mkdirSync(cacheDir)
  if (provisioned) writeFileSync(join(cacheDir, 'htdemucs.safetensors'), 'fixture weights')
  writeFileSync(pythonPath, `#!/bin/sh
set -eu
test "$DEMUCS_MLX_NO_DOWNLOAD" = 1
test "$HF_HUB_OFFLINE" = 1
test -f "$4/htdemucs.safetensors"
${worker}
`, { mode: 0o700 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const separator = new MlxDemucsSeparator({ pythonPath, cacheDir, scratchRoot: scratch, timeoutMs: 5_000 })
  return { scratch, separator }
}

test('offline separator reads only the two bounded artifacts and cleans the private job', async t => {
  const { scratch, separator } = fixture(t, `
cp "$2" "$3/vocal.wav"
cp "$2" "$3/accompaniment.wav"
touch "$3/other.wav"`)
  const source = Buffer.alloc(44, 1)
  const stems = await separator.separate(source, new AbortController().signal)
  assert.deepEqual(stems, { vocal: source, accompaniment: source })
  assert.deepEqual(readdirSync(scratch), [])
})

test('a missing local model fails before staging the uploaded source', async t => {
  const { scratch, separator } = fixture(t, 'exit 42', false)
  await assert.rejects(separator.separate(Buffer.alloc(44), new AbortController().signal), {
    code: 'singing-separator-unavailable',
  })
  assert.equal(existsSync(scratch), false)
})

test('a short or symlinked separator output fails without keeping temporary data', async t => {
  const cases = [
    { worker: 'printf bad > "$3/vocal.wav"', code: 'singing-separation-output-invalid' },
    { worker: 'ln -s "$2" "$3/vocal.wav"', code: 'singing-separation-failed' },
  ]
  for (const { worker, code } of cases) {
    const { scratch, separator } = fixture(t, worker)
    await assert.rejects(separator.separate(Buffer.alloc(44), new AbortController().signal), { code })
    assert.deepEqual(readdirSync(scratch), [])
  }
})

test('cancelling during separation terminates the worker and cleans the temporary source', async t => {
  const { scratch, separator } = fixture(t, 'touch "$3/started"\nsleep 30')
  const controller = new AbortController()
  t.after(() => controller.abort())
  const error = new Error('cancel test separator')
  const rejection = assert.rejects(separator.separate(Buffer.alloc(44), controller.signal), reason => reason === error)
  for (let i = 0; i < 100; i++) {
    if (existsSync(scratch) && readdirSync(scratch).some(item => existsSync(join(scratch, item, 'started')))) break
    await delay(10)
  }
  const started = existsSync(scratch) && readdirSync(scratch).some(item => existsSync(join(scratch, item, 'started')))
  controller.abort(error)
  await rejection
  assert.equal(started, true)
  assert.deepEqual(readdirSync(scratch), [])
})
