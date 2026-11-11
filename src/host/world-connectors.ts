import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '../core/model.ts'
import type { WorldHealth, WorldsView } from '../protocol/worlds.ts'
import { registerBilibiliTools } from './bilibili-tools.ts'
import { registerMinecraftTools } from './minecraft-tools.ts'
import { registerSingingTools } from './singing-tools.ts'
import type { CompanionRuntime } from './runtime.ts'
import { WORLD_DEFINITIONS, type WorldDefinition } from './world-manifest.ts'

interface WorldConnector {
  definition: WorldDefinition
  health(): WorldHealth
  registerTools(): () => void
  start?(): void
  abort?(): void
  close?(): Promise<void> | void
}

export class WorldConnectors {
  private readonly actions = new Map<string, WorldConnector>()
  private readonly mounted = new Map<WorldConnector, () => void>()
  private started = false
  private stopping = false
  private stopped?: Promise<void>

  constructor(private readonly connectors: readonly WorldConnector[], private readonly report: (id: string, phase: string) => void) {
    const ids = new Set<string>()
    const contexts = new Set<string>()
    for (const connector of connectors) {
      const { id, contextId, actions } = connector.definition
      if (ids.has(id) || contexts.has(contextId)) throw new Error(`Duplicate World registration: ${id}`)
      ids.add(id)
      contexts.add(contextId)
      for (const [name] of actions) {
        if (this.actions.has(name)) throw new Error(`Duplicate World action: ${name}`)
        this.actions.set(name, connector)
      }
    }
  }

  start(): void {
    if (this.started || this.stopping) return
    this.started = true
    for (const connector of this.connectors) {
      try {
        connector.start?.()
        this.mounted.set(connector, connector.registerTools())
      } catch {
        this.report(connector.definition.id, 'start')
      }
    }
  }

  denied(name: string, binding?: Pick<SessionBinding, 'contextId' | 'kind'>): string | undefined {
    const connector = this.actions.get(name)
    if (!connector) return
    const { contextId, kind } = connector.definition
    if (binding?.contextId !== contextId || binding.kind !== kind) return `World action requires the ${contextId} session`
    if (this.stopping || !this.mounted.has(connector)) return 'World connector is unavailable'
  }

  view(): WorldsView {
    return { version: 1, items: this.connectors.map(connector => {
      const { id, label } = connector.definition
      let status: WorldHealth = 'unavailable'
      try {
        if (!this.stopping && this.mounted.has(connector)) status = connector.health()
      } catch {
        // Status snapshots can keep reporting the other worlds during a local failure.
      }
      return { id, label, status }
    }) }
  }

  beginStop(): void {
    if (this.stopping) return
    this.stopping = true
    for (const connector of this.connectors) {
      try { connector.abort?.() } catch { this.report(connector.definition.id, 'abort') }
      try { this.mounted.get(connector)?.() } catch { this.report(connector.definition.id, 'dispose') }
    }
    this.mounted.clear()
  }

  close(): Promise<void> {
    this.beginStop()
    this.stopped ??= Promise.all(this.connectors.map(async connector => {
      try { await connector.close?.() } catch { this.report(connector.definition.id, 'close') }
    })).then(() => undefined)
    return this.stopped
  }
}

export function createWorldConnectors(ctx: Context, runtime: CompanionRuntime): WorldConnectors {
  return new WorldConnectors([
    {
      definition: WORLD_DEFINITIONS.minecraft,
      health: () => runtime.minecraft.worldHealth(),
      registerTools: () => registerMinecraftTools(ctx, runtime),
      start: () => runtime.minecraft.start(),
      close: () => runtime.minecraft.close(),
    },
    {
      definition: WORLD_DEFINITIONS.bilibili,
      health: () => runtime.bilibili.worldHealth(),
      registerTools: () => registerBilibiliTools(ctx, runtime),
      abort: () => runtime.bilibili.close(),
    },
    {
      definition: WORLD_DEFINITIONS.singing,
      health: () => runtime.singing.worldHealth(),
      registerTools: () => registerSingingTools(ctx, runtime),
      start: () => runtime.singing.start(),
      close: () => runtime.singing.close(),
    },
  ], (id, phase) => ctx.logger.warn(`Companion World ${id} failed during ${phase}`))
}
