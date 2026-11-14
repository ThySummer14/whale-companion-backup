import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { DeviceAuthError } from './devices.ts'

export interface MusicPluginManifest {
  id: string
  name: string
  version: string
  main: string
  playback?: 'stream' | 'remote'
  permissions?: { network?: string[] }
  settings?: { key: string; label: string; help?: string }[]
}

export interface MusicPluginView {
  id: string
  name: string
  version: string
  playback: 'stream' | 'remote'
  settings: { key: string; label: string; help?: string }[]
}

interface LoadedPlugin {
  manifest: MusicPluginManifest
  dir: string
  context: ReturnType<typeof createContext>
  exports: Record<string, (params: unknown) => unknown>
}

const CALL_TIMEOUT_MS = 5000

function pluginError(code: string): DeviceAuthError {
  return new DeviceAuthError(code === 'unavailable' ? 404 : code === 'unsupported' ? 400 : 502, `music-plugin-${code}`)
}

export class MusicPluginService {
  private readonly plugins = new Map<string, LoadedPlugin>()

  constructor(
    private readonly root: string,
    private readonly companionRead: (path: string) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  start(): void {
    this.plugins.clear()
    if (!existsSync(this.root)) return
    for (const entry of readdirSync(this.root)) {
      const dir = join(this.root, entry)
      const manifestPath = join(dir, 'plugin.json')
      if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) continue
      let manifest: MusicPluginManifest
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
      if (!manifest?.id || !manifest.main || !/^[a-z0-9-]{1,64}$/u.test(manifest.id)) continue
      try { this.plugins.set(manifest.id, this.load(dir, manifest)) } catch { /* a broken plugin must not hide the others */ }
    }
  }

  list(): MusicPluginView[] {
    return [...this.plugins.values()].map(({ manifest }) => ({
      id: manifest.id, name: manifest.name, version: manifest.version,
      playback: manifest.playback ?? 'stream', settings: manifest.settings ?? [],
    }))
  }

  async call(id: string, method: string, params: unknown): Promise<unknown> {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new DeviceAuthError(404, 'music-plugin-not-found')
    const fn = plugin.exports[method]
    if (!fn) throw new DeviceAuthError(400, 'music-plugin-unsupported')
    plugin.context.__params = params
    let result: unknown
    try {
      result = runInContext(`__exports[${JSON.stringify(method)}](__params)`, plugin.context, { timeout: CALL_TIMEOUT_MS })
    } catch (error) {
      if (error instanceof DeviceAuthError) throw error
      throw pluginError(typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'failed')
    }
    const value = await Promise.resolve(result).catch(error => {
      if (error instanceof DeviceAuthError) throw error
      throw pluginError(typeof error?.code === 'string' ? error.code : 'failed')
    })
    return JSON.parse(JSON.stringify(value ?? null))
  }

  pluginDir(id: string): string {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new DeviceAuthError(404, 'music-plugin-not-found')
    return plugin.dir
  }

  private load(dir: string, manifest: MusicPluginManifest): LoadedPlugin {
    dir = resolve(dir)
    const source = readFileSync(join(dir, manifest.main), 'utf8')
    const entries: string[] = []
    const script = source
      .replace(/export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gu, (_m, asyncPart, name) => { entries.push(`${name}: ${name}`); return `${asyncPart ?? ''}function ${name}` })
      .replace(/export\s+const\s+([A-Za-z0-9_$]+)/gu, (_m, name) => { entries.push(`${name}: ${name}`); return `const ${name}` })
      .replace(/export\s*\{([^}]+)\}\s*;?/gu, (_m, list: string) => {
        for (const part of list.split(',')) {
          const [local, alias] = part.trim().split(/\s+as\s+/u)
          if (local) entries.push(`${(alias ?? local).trim()}: ${local.trim()}`)
        }
        return ''
      })
    const storagePath = join(dir, '.storage.json')
    const readStore = (): Record<string, unknown> => {
      try { return JSON.parse(readFileSync(storagePath, 'utf8')) } catch { return {} }
    }
    const writeStore = (store: Record<string, unknown>) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(storagePath, JSON.stringify(store), { mode: 0o600 })
    }
    const network = manifest.permissions?.network ?? []
    const host = {
      dir,
      storage: {
        get: (key: string) => readStore()[key],
        set: (key: string, value: unknown) => { const store = readStore(); store[key] = value; writeStore(store) },
        remove: (key: string) => { const store = readStore(); delete store[key]; writeStore(store) },
      },
      setting: (key: string) => readStore()[`__setting:${key}`],
      t: (key: string) => {
        try {
          const locales = JSON.parse(readFileSync(join(dir, 'locales', 'zh-CN.json'), 'utf8')) as Record<string, string>
          return locales[key] ?? key
        } catch { return key }
      },
      companion: (path: string) => this.companionRead(path),
      fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const target = new URL(url)
        if (target.protocol !== 'https:' || !network.includes(target.hostname)) throw pluginError('unsupported')
        const response = await this.fetcher(target, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
        const text = await response.text()
        return { ok: response.ok, status: response.status, text: () => text, json: () => JSON.parse(text) }
      },
      openURL: () => { throw pluginError('unsupported') },
      waitForRedirect: () => { throw pluginError('unsupported') },
    }
    const context = createContext({
      host,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, TextDecoder,
      __params: undefined,
    })
    runInContext(`${script}\nglobalThis.__exports = { ${entries.join(', ')} };`, context, { timeout: CALL_TIMEOUT_MS })
    const exports = runInContext('__exports', context) as Record<string, (params: unknown) => unknown>
    return { manifest, dir, context, exports }
  }
}

export function resolvePluginFile(pluginDir: string, url: string): string {
  const base = resolve(pluginDir)
  const path = resolve(base, decodeURIComponent(new URL(url).pathname))
  if (path !== base && !path.startsWith(base + sep)) throw new DeviceAuthError(403, 'music-plugin-path-refused')
  if (!existsSync(path) || !statSync(path).isFile()) throw new DeviceAuthError(404, 'music-plugin-file-not-found')
  return path
}