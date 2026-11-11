import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { MAX_SINGING_WAV_BYTES } from '../protocol/singing.ts'
import { DeviceAuthError } from './devices.ts'

export async function runSingingWorker(
  python: string, cwd: string, args: string[], signal: AbortSignal, failure: string, env: NodeJS.ProcessEnv,
): Promise<void> {
  signal.throwIfAborted()
  const separateGroup = process.platform !== 'win32'
  const child = spawn(python, args, {
    cwd, stdio: 'ignore', detached: separateGroup,
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, PYTHONNOUSERSITE: '1',
      HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', ...env,
    },
  })
  let force: ReturnType<typeof setTimeout> | undefined
  const kill = (name: NodeJS.Signals) => {
    try {
      if (separateGroup && child.pid) process.kill(-child.pid, name)
      else child.kill(name)
    } catch { /* The worker may already have exited. */ }
  }
  const stop = () => {
    kill('SIGTERM')
    force = setTimeout(() => kill('SIGKILL'), 2000)
    force.unref()
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    signal.throwIfAborted()
    if (status !== 0) throw new DeviceAuthError(502, failure)
  } finally {
    signal.removeEventListener('abort', stop)
    if (force) clearTimeout(force)
  }
}

export async function readSingingWorkerWav(path: string, signal: AbortSignal, failure: string): Promise<Buffer> {
  const invalid = () => new DeviceAuthError(502, failure)
  signal.throwIfAborted()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 44 || info.size > MAX_SINGING_WAV_BYTES) throw invalid()
    const data = Buffer.alloc(info.size)
    for (let offset = 0; offset < data.length;) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw invalid()
      offset += bytesRead
    }
    if ((await file.stat()).size !== data.length) throw invalid()
    signal.throwIfAborted()
    return data
  } finally { await file.close() }
}
