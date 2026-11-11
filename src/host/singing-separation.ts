import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { MAX_SINGING_WAV_BYTES } from '../protocol/singing.ts'
import { DeviceAuthError } from './devices.ts'
import { readSingingWorkerWav, runSingingWorker } from './singing-worker.ts'

export interface SingingSeparatorProvider {
  separate(source: Uint8Array, signal: AbortSignal): Promise<{ vocal: Uint8Array; accompaniment: Uint8Array }>
}

interface MlxDemucsOptions {
  pythonPath: string
  cacheDir: string
  scratchRoot: string
  timeoutMs: number
}

export class MlxDemucsSeparator implements SingingSeparatorProvider {
  private readonly worker = join(dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json')), 'scripts', 'run-mlx-demucs.py')

  constructor(private readonly options: MlxDemucsOptions) {
    if (![options.pythonPath, options.cacheDir, options.scratchRoot].every(isAbsolute)) {
      throw new Error('Demucs-MLX paths must be absolute')
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 5_000 || options.timeoutMs > 120_000) {
      throw new Error('Invalid Demucs-MLX timeout')
    }
  }

  async separate(source: Uint8Array, client: AbortSignal): Promise<{ vocal: Uint8Array; accompaniment: Uint8Array }> {
    const { pythonPath, cacheDir, scratchRoot, timeoutMs } = this.options
    const signal = AbortSignal.any([client, AbortSignal.timeout(timeoutMs)])
    signal.throwIfAborted()
    if (source.byteLength < 44 || source.byteLength > MAX_SINGING_WAV_BYTES) {
      throw new DeviceAuthError(400, 'singing-invalid-source')
    }
    const model = await stat(join(cacheDir, 'htdemucs.safetensors')).catch(() => undefined)
    if (!model?.isFile()) throw new DeviceAuthError(503, 'singing-separator-unavailable')
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(scratchRoot, 'separate-'))
    try {
      const input = join(directory, 'source.wav')
      await writeFile(input, source, { mode: 0o600, flag: 'wx', signal })
      await runSingingWorker(pythonPath, directory, [this.worker, input, directory, cacheDir],
        signal, 'singing-separation-failed', { DEMUCS_MLX_NO_DOWNLOAD: '1' })
      const invalid = 'singing-separation-output-invalid'
      const vocal = await readSingingWorkerWav(join(directory, 'vocal.wav'), signal, invalid)
      const accompaniment = await readSingingWorkerWav(join(directory, 'accompaniment.wav'), signal, invalid)
      return { vocal, accompaniment }
    } catch (error) {
      client.throwIfAborted()
      if (signal.aborted) throw new DeviceAuthError(503, 'singing-separation-timeout')
      if (error instanceof DeviceAuthError) throw error
      throw new DeviceAuthError(502, 'singing-separation-failed')
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  }
}
