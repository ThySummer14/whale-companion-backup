import { constants } from 'node:fs'
import { chmod, copyFile, lstat, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import type { TtsService } from './tts.ts'

const LEASE_MAX_AGE_MS = 3_000
const REPLY_MAX_WAIT_MS = 20_000
const MAX_WAV_BYTES = 3_000_000

export class MinecraftVoiceRelay {
  private pending = false

  constructor(private readonly dir: string, private readonly tts: Pick<TtsService, 'synthesizeClip' | 'get' | 'audio'>) {}

  private async lease(): Promise<string | undefined> {
    const path = join(this.dir, 'listener')
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile() || info.size !== 36 || Date.now() - info.mtimeMs >= LEASE_MAX_AGE_MS) return
    const id = await readFile(path, 'utf8').catch(() => '')
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) return id
  }

  async deliver(taskId: string, text: string, stillAllowed: () => boolean): Promise<void> {
    if (this.pending) return
    this.pending = true
    try {
      const lease = await this.lease()
      if (!lease || !stillAllowed()) return
      const characters = Array.from(text.trim().slice(0, 240))
      if (characters.at(-1)?.match(/[\uD800-\uDBFF]/u)) characters.pop()
      const deadline = Date.now() + REPLY_MAX_WAIT_MS
      let task = await this.tts.synthesizeClip('game.minecraft', taskId, characters.join(''))
      while (task.status === 'accepted' || task.status === 'running') {
        if (Date.now() >= deadline || !stillAllowed() || await this.lease() !== lease) return
        await wait(150, undefined, { ref: false })
        task = this.tts.get(task.id)
      }
      if (task.status !== 'succeeded' || Date.now() >= deadline) return
      const audio = await this.tts.audio(task.id)
      if (audio.bytes > MAX_WAV_BYTES) return
      const temporary = join(this.dir, `.${randomUUID()}.part`)
      try {
        await copyFile(audio.filePath, temporary, constants.COPYFILE_EXCL)
        await chmod(temporary, 0o600)
        if (stillAllowed() && await this.lease() === lease) await rename(temporary, join(this.dir, `${lease}.wav`))
      } finally {
        await rm(temporary, { force: true })
      }
    } finally {
      this.pending = false
    }
  }
}
