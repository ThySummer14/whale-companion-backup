import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CompanionStore } from '../src/core/store.ts'
import { registerHttp } from '../src/host/http.ts'
import { SingingService } from '../src/host/singing.ts'
import { ApplioRvcCoverProvider, SeedVcCoverProvider } from '../src/host/singing-cover.ts'

function wav(seconds = 5) {
  const size = seconds * 16_000 * 2
  const bytes = Buffer.alloc(44 + size)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(size, 40); bytes.writeInt16LE(300, 44)
  return bytes
}

function fixture(t, source) {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/singing-cover-test-'))
  const scratch = join(root, 'scratch')
  const reference = join(root, 'reference.wav')
  writeFileSync(reference, wav())
  writeFileSync(join(root, 'inference.py'), source)
  const store = new CompanionStore(join(root, 'store.sqlite'))
  const cover = new SeedVcCoverProvider({ pythonPath: '/usr/bin/python3', repoDir: root, referenceAudio: reference, scratchRoot: scratch, timeoutMs: 15_000 })
  const singing = new SingingService(store, join(root, 'media'), undefined, cover)
  t.after(async () => { await singing.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  return { singing, store, scratch }
}

const fixtureScript = `import os
import shutil
import sys
from pathlib import Path

class Torch:
    float32 = "float32"

    def from_numpy(self, data):
        return self

    def to(self, *, device, dtype):
        assert dtype == self.float32
        return {None: 1}

torch = Torch()
device = "fixture"
F0_ori = F0_alt = []
F0_ori = torch.from_numpy(F0_ori).to(device)[None]
F0_alt = torch.from_numpy(F0_alt).to(device)[None]

def save(_wave, _rate, *, encoding, bits_per_sample):
    assert encoding == "PCM_S" and bits_per_sample == 16

class Wave:
    def cpu(self):
        return self

vc_wave = Wave()
sr = 16000
save(vc_wave.cpu(), sr)
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
assert os.environ["HF_HUB_OFFLINE"] == "1"
assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
assert Path(args["--target"]).is_file()
assert args["--f0-condition"] == "True"
assert args["--auto-f0-adjust"] == "False"
assert args["--fp16"] == "False"
shutil.copyfile(args["--source"], Path(args["--output"]) / "vc_fixture.wav")
`

test('owner cover upload invokes the offline F0 CLI and archives only its bounded WAV output', async t => {
  const { singing, store, scratch } = fixture(t, fixtureScript)
  let route, origin
  registerHttp({ webServer: { host: '127.0.0.1', getOrigin: () => origin, register: value => { route = value } } }, { singing })
  const server = createServer(route.handler)
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections() }))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  const endpoint = `${origin}/companion/api/singing/covers?title=${encodeURIComponent('隔离导唱')}`
  const headers = { 'x-companion-request': '1', 'content-type': 'audio/wav' }
  const submit = (body, requestHeaders = headers) => fetch(endpoint, { method: 'POST', headers: requestHeaders, body })
  const guide = wav()
  assert.equal(singing.view().available, false)
  assert.equal(singing.view().coverAvailable, true)
  assert.equal((await submit(guide, { 'content-type': 'audio/wav' })).status, 403)
  assert.equal((await submit(guide, { ...headers, 'content-type': 'audio/mpeg' })).status, 415)
  assert.equal((await submit(wav(2))).status, 400)
  const accepted = await submit(guide)
  assert.equal(accepted.status, 202)
  const { task } = await accepted.json()
  for (let attempt = 0; attempt < 60 && ['accepted', 'running'].includes(store.taskById(task.id).status); attempt++) await delay(10)
  assert.equal(store.taskById(task.id).status, 'succeeded')
  assert.deepEqual(Buffer.from((await singing.audio(task.id)).data), guide)
  const receipt = store.activities().find(item => item.kind === 'song.archived')
  assert.equal(receipt.data.mode, 'cover')
  assert.equal(receipt.data.durationSeconds, 5)
  assert.deepEqual(readdirSync(scratch), [])
  assert.equal(singing.archive().items[0].id, task.id)
})

test('cancelling a running local cover clears its input and leaves no playable song', async t => {
  const { singing, store, scratch } = fixture(t, `import time\ntime.sleep(10)\n${fixtureScript}`)
  const { task } = singing.submitCover('取消导唱', wav())
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (readdirSync(scratch).length) break } catch { /* Scratch is made asynchronously. */ }
    await delay(10)
  }
  assert.equal(singing.cancel(task.id).task.status, 'cancelled')
  await singing.close()
  assert.deepEqual(readdirSync(scratch), [])
  await assert.rejects(singing.audio(task.id), { code: 'singing-audio-not-found' })
  assert.equal(store.activities().some(item => item.kind === 'song.archived'), false)
})

function rvcFixture(t, script) {
  mkdirSync('.work', { recursive: true })
  const root = resolve(mkdtempSync('.work/singing-applio-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = {
    pythonPath: '/usr/bin/python3', repoDir: root, modelPath: join(root, 'voice.pth'),
    indexPath: join(root, 'voice.index'), scratchRoot: join(root, 'scratch'), timeoutMs: 15_000,
  }
  const required = ['voice.pth', 'voice.index', 'rvc/models/embedders/contentvec/config.json',
    'rvc/models/embedders/contentvec/pytorch_model.bin', 'rvc/models/predictors/rmvpe.pt']
  for (const file of required) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'fixture')
  }
  writeFileSync(join(root, 'core.py'), script)
  return { options, cover: new ApplioRvcCoverProvider(options) }
}

const rvcScript = `import json
import os
import shutil
import sys
from pathlib import Path

assert sys.argv[1] == "infer"
args = dict(zip(sys.argv[2::2], sys.argv[3::2]))
assert args["--pitch"] == "0" and args["--f0-method"] == "rmvpe"
assert args["--index-rate"] == "0.3" and args["--protect"] == "0.33"
assert args["--volume-envelope"] == "1.0" and args["--cleanup-mode"] == "off"
assert args["--sid"] == "0" and args["--export-format"] == "WAV"
assert Path(args["--pth-path"]).suffix == ".pth" and Path(args["--index-path"]).suffix == ".index"
assert args["--embedder-model"] == "custom"
assert Path(args["--embedder-model-custom"], "pytorch_model.bin").is_file()
assert os.environ["HF_HUB_OFFLINE"] == "1" and os.environ["TRANSFORMERS_OFFLINE"] == "1"
config = Path(os.environ["APPLIO_CONFIG_FILE"])
assert config.parent == Path(args["--input-path"]).parent and json.loads(config.read_text()) == {}
shutil.copyfile(args["--input-path"], args["--output-path"])
`

test('Applio receives a private guide and fixed offline singing settings', async t => {
  const { cover, options } = rvcFixture(t, rvcScript)
  const guide = wav()
  assert.equal(cover.engine, 'applio-rvc')
  assert.deepEqual(await cover.convert(guide, new AbortController().signal), guide)
  assert.deepEqual(readdirSync(options.scratchRoot), [])
  assert.throws(() => new ApplioRvcCoverProvider({ ...options, indexPath: 'relative.index' }), /absolute/u)
  assert.throws(() => new ApplioRvcCoverProvider({ ...options, indexPath: options.modelPath }), /\.index/u)
})

test('Applio refuses missing offline assets before staging private audio', async t => {
  const { cover, options } = rvcFixture(t, rvcScript)
  rmSync(join(options.repoDir, 'rvc/models/predictors/rmvpe.pt'))
  await assert.rejects(cover.convert(wav(), new AbortController().signal), { code: 'singing-rvc-assets-unavailable' })
  assert.throws(() => readdirSync(options.scratchRoot), { code: 'ENOENT' })
})

test('Applio process failure and cancellation both remove staged audio', async t => {
  const failed = rvcFixture(t, 'raise SystemExit(5)')
  await assert.rejects(failed.cover.convert(wav(), new AbortController().signal), { code: 'singing-cover-failed' })
  assert.deepEqual(readdirSync(failed.options.scratchRoot), [])
  const slow = rvcFixture(t, 'import time\ntime.sleep(30)')
  const controller = new AbortController()
  const pending = assert.rejects(slow.cover.convert(wav(), controller.signal), { name: 'AbortError' })
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (readdirSync(slow.options.scratchRoot).length) break } catch { /* Scratch is made asynchronously. */ }
    await delay(10)
  }
  controller.abort()
  await pending
  assert.deepEqual(readdirSync(slow.options.scratchRoot), [])
})
