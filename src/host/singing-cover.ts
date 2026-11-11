import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { MAX_SINGING_WAV_BYTES as MAX_WAV_BYTES, type SingingCoverEngine } from '../protocol/singing.ts'
import { DeviceAuthError } from './devices.ts'
import { readSingingWorkerWav, runSingingWorker } from './singing-worker.ts'

export interface SingingCoverProvider {
  readonly engine?: SingingCoverEngine
  convert(guide: Uint8Array, signal: AbortSignal): Promise<Uint8Array>
}

interface SeedVcOptions {
  pythonPath: string
  repoDir: string
  referenceAudio: string
  scratchRoot: string
  timeoutMs: number
}

export class SeedVcCoverProvider implements SingingCoverProvider {
  readonly engine = 'seed-vc'
  private readonly worker = join(dirname(createRequire(import.meta.url).resolve('dsh-companion-bot/package.json')), 'scripts', 'run-seed-vc-svc.py')

  constructor(private readonly options: SeedVcOptions) {
    if (![options.pythonPath, options.repoDir, options.referenceAudio, options.scratchRoot].every(isAbsolute)) {
      throw new Error('Seed-VC paths must be absolute')
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 15_000 || options.timeoutMs > 300_000) {
      throw new Error('Invalid Seed-VC timeout')
    }
  }

  async convert(guide: Uint8Array, client: AbortSignal): Promise<Uint8Array> {
    const { pythonPath, repoDir, referenceAudio, scratchRoot, timeoutMs } = this.options
    const signal = AbortSignal.any([client, AbortSignal.timeout(timeoutMs)])
    signal.throwIfAborted()
    if (guide.byteLength < 44 || guide.byteLength > MAX_WAV_BYTES) throw new DeviceAuthError(400, 'singing-invalid-guide')
    const reference = await stat(referenceAudio).catch(() => undefined)
    if (!reference?.isFile() || reference.size < 44 || reference.size > MAX_WAV_BYTES) {
      throw new DeviceAuthError(503, 'singing-reference-unavailable')
    }
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(scratchRoot, 'cover-'))
    try {
      const input = join(directory, 'guide.wav')
      const output = join(directory, 'output')
      await mkdir(output, { mode: 0o700 })
      await writeFile(input, guide, { mode: 0o600, flag: 'wx', signal })
      await runSingingWorker(pythonPath, repoDir, [this.worker, repoDir, '--source', input, '--target', referenceAudio, '--output', output,
        '--diffusion-steps', '30', '--length-adjust', '1.0', '--inference-cfg-rate', '0.7', '--f0-condition', 'True',
        '--auto-f0-adjust', 'False', '--semi-tone-shift', '0', '--fp16', 'False'], signal, 'singing-cover-failed', {
        TRANSFORMERS_OFFLINE: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1',
      })
      signal.throwIfAborted()
      const files = (await readdir(output, { withFileTypes: true })).filter(item => item.isFile() && /^vc_.*\.wav$/u.test(item.name))
      const item = files[0]
      if (files.length !== 1 || !item) throw new DeviceAuthError(502, 'singing-cover-output-invalid')
      return await readSingingWorkerWav(join(output, item.name), signal, 'singing-cover-output-invalid')
    } catch (error) {
      client.throwIfAborted()
      if (signal.aborted) throw new DeviceAuthError(503, 'singing-cover-timeout')
      if (error instanceof DeviceAuthError) throw error
      throw new DeviceAuthError(502, 'singing-cover-failed')
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  }
}

interface ApplioRvcOptions {
  pythonPath: string
  repoDir: string
  modelPath: string
  indexPath: string
  scratchRoot: string
  timeoutMs: number
}

export class ApplioRvcCoverProvider implements SingingCoverProvider {
  readonly engine = 'applio-rvc'

  constructor(private readonly options: ApplioRvcOptions) {
    if (![options.pythonPath, options.repoDir, options.modelPath, options.indexPath, options.scratchRoot].every(isAbsolute)) {
      throw new Error('Applio RVC paths must be absolute')
    }
    if (!options.modelPath.endsWith('.pth') || !options.indexPath.endsWith('.index')) {
      throw new Error('Applio RVC requires a .pth model and its .index')
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 15_000 || options.timeoutMs > 300_000) {
      throw new Error('Invalid Applio RVC timeout')
    }
  }

  async convert(guide: Uint8Array, client: AbortSignal): Promise<Uint8Array> {
    const { pythonPath, repoDir, modelPath, indexPath, scratchRoot, timeoutMs } = this.options
    const signal = AbortSignal.any([client, AbortSignal.timeout(timeoutMs)])
    signal.throwIfAborted()
    if (guide.byteLength < 44 || guide.byteLength > MAX_WAV_BYTES) throw new DeviceAuthError(400, 'singing-invalid-guide')
    const core = join(repoDir, 'core.py')
    const contentvec = join(repoDir, 'rvc', 'models', 'embedders', 'contentvec')
    const assets = await Promise.all([core, modelPath, indexPath, join(contentvec, 'config.json'), join(contentvec, 'pytorch_model.bin'),
      join(repoDir, 'rvc', 'models', 'predictors', 'rmvpe.pt')].map(path => stat(path).catch(() => undefined)))
    signal.throwIfAborted()
    if (assets.some(asset => !asset?.isFile() || asset.size === 0)) throw new DeviceAuthError(503, 'singing-rvc-assets-unavailable')

    await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(scratchRoot, 'cover-rvc-'))
    try {
      const input = join(directory, 'guide.wav')
      const output = join(directory, 'converted.wav')
      const config = join(directory, 'applio.json')
      await writeFile(input, guide, { mode: 0o600, flag: 'wx', signal })
      await writeFile(config, '{}', { mode: 0o600, flag: 'wx', signal })
      // Loading ContentVec through its local path bypasses the built-in asset downloader.
      await runSingingWorker(pythonPath, repoDir, [core, 'infer', '--input-path', input, '--output-path', output,
        '--pth-path', modelPath, '--index-path', indexPath, '--embedder-model', 'custom', '--embedder-model-custom', contentvec,
        '--f0-method', 'rmvpe', '--pitch', '0', '--index-rate', '0.3', '--protect', '0.33', '--volume-envelope', '1.0',
        '--sid', '0', '--export-format', 'WAV', '--cleanup-mode', 'off'], signal, 'singing-cover-failed', {
        APPLIO_CONFIG_FILE: config, APPLIO_LOGS_DIR: directory, MPLCONFIGDIR: directory,
        PYTORCH_ENABLE_MPS_FALLBACK: '1', TRANSFORMERS_OFFLINE: '1',
      })
      return await readSingingWorkerWav(output, signal, 'singing-cover-output-invalid')
    } catch (error) {
      client.throwIfAborted()
      if (signal.aborted) throw new DeviceAuthError(503, 'singing-cover-timeout')
      if (error instanceof DeviceAuthError) throw error
      throw new DeviceAuthError(502, 'singing-cover-failed')
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  }
}

