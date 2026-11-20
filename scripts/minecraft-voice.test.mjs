import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MinecraftVoiceRelay } from '../src/host/minecraft-voice.ts'

test('voice relay synthesizes for a live listener and drops replies across a reconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-voice-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const listener = join(root, 'listener')
  const audio = join(root, 'source.wav')
  await writeFile(audio, 'test wav bytes')
  const old = randomUUID()
  const next = randomUUID()
  let calls = 0
  let reconnect = false
  const relay = new MinecraftVoiceRelay(root, {
    async synthesizeClip(context, task, text) {
      calls++
      assert.equal(context, 'game.minecraft')
      assert.equal(task, 'chat-task')
      assert.equal(text, '一起玩吧')
      return { id: 'speech-task', status: 'succeeded' }
    },
    async audio() {
      if (reconnect) await writeFile(listener, next)
      return { filePath: audio, bytes: 14 }
    },
  })
  await relay.deliver('chat-task', '一起玩吧', () => true)
  assert.equal(calls, 0)
  await writeFile(listener, old)
  await relay.deliver('chat-task', '一起玩吧', () => false)
  assert.equal(calls, 0)
  reconnect = true
  await relay.deliver('chat-task', '一起玩吧', () => true)
  assert.deepEqual((await readdir(root)).sort(), ['listener', 'source.wav'])
  reconnect = false
  await relay.deliver('chat-task', '一起玩吧', () => true)
  assert.equal(await readFile(join(root, `${next}.wav`), 'utf8'), 'test wav bytes')
  assert.equal(calls, 2)
})
