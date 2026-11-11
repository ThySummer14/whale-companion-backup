import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Bot } from 'mineflayer'
import {
  MinecraftOvoSmeltRequest,
  MinecraftOvoSmeltReceipt,
  MinecraftOvoStorageRequest,
  MinecraftOvoStorageReceipt,
  type MinecraftOvoPosition,
  minecraftOvoDimension,
} from '../../src/core/minecraft-ovo.ts'
import type { MinecraftAuthorizedZone } from '../../src/core/minecraft-supply.ts'
import { z } from 'zod'

type OvoBot = Bot & { output: string; interrupt_code: boolean; modes: Record<string, unknown> }
type OvoSkills = {
  putInChest(bot: OvoBot, itemName: string, count: number): Promise<boolean>
  takeFromChest(bot: OvoBot, itemName: string, count: number): Promise<boolean>
  startSmelt(bot: OvoBot, itemName: string, count: number): Promise<OvoPosition | false>
  collectSmelted(bot: OvoBot): Promise<number>
}
type OvoPosition = z.infer<typeof MinecraftOvoPosition>
type Zone = z.infer<typeof MinecraftAuthorizedZone>
type Container = { position: OvoPosition; name: string }

export interface OvoActionHost {
  start(kind: string): AbortController
  succeed(kind: string): void
  fail(kind: string, message: string): void
  stop(): void
  record(kind: string, data?: Record<string, unknown>): void
}

const RESULTS = { sand: 'glass', raw_iron: 'iron_ingot', beef: 'cooked_beef', cobblestone: 'stone' } as const

function inventoryCount(bot: Bot, name: string): number {
  return bot.inventory.items().filter(item => item.name === name).reduce((total, item) => total + item.count, 0)
}

function inZone(position: { x: number; y: number; z: number }, zone: Zone): boolean {
  return Math.abs(position.x - zone.x) <= zone.radius && Math.abs(position.y - zone.y) <= zone.radius && Math.abs(position.z - zone.z) <= zone.radius
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function createOvoBot({ root, username, host, port, authenticate }: {
  root: string; username: string; host: string; port: number
  authenticate: 'offline' | ((client: unknown, options: any) => void)
}): Promise<{ bot: OvoBot; skills: OvoSkills }> {
  const module = (path: string) => pathToFileURL(join(root, path)).href
  const { setSettings } = await import(module('src/agent/settings.js'))
  setSettings({ minecraft_version: '1.21.1', host, port, auth: authenticate })
  const ovoRequire = createRequire(join(root, 'package.json'))
  const ovoMineflayer = ovoRequire('mineflayer')
  const workerRequire = createRequire(join(process.cwd(), 'package.json'))
  const pf = workerRequire('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')
  const previousCreateBot = ovoMineflayer.createBot
  let bot: OvoBot, skills: OvoSkills
  try {
    ovoMineflayer.createBot = workerRequire('mineflayer').createBot
    const mcdata = await import(module('src/utils/mcdata.js'))
    skills = await import(module('src/agent/library/skills.js')) as OvoSkills
    bot = mcdata.initBot(username) as OvoBot
  } finally {
    ovoMineflayer.createBot = previousCreateBot
  }
  bot.output = ''
  bot.interrupt_code = false
  bot.modes = { isOn: () => false, pause: () => {}, resume: () => {}, behavior_log: '' }
  bot.once('spawn', () => {
    const movements = new pf.Movements(bot)
    movements.canDig = false
    const setMovements = bot.pathfinder.setMovements.bind(bot.pathfinder)
    bot.pathfinder.setMovements = next => {
      next.canDig = false
      setMovements(next)
    }
    bot.pathfinder.setMovements(movements)
  })
  return { bot, skills }
}

export class OvoSkillRunner {
  private smelting?: { position: OvoPosition; itemName: z.infer<typeof MinecraftOvoSmeltRequest>['itemName']; count: number; zoneId: string }

  constructor(private readonly bot: OvoBot, private readonly skills: OvoSkills, private readonly host: OvoActionHost) {}

  private container(zone: Zone, name: 'chest' | 'furnace'): Container {
    const block = this.bot.findBlock({
      maxDistance: 16,
      count: 32,
      matching: candidate => !candidate?.position || (candidate.name === name && inZone(candidate.position, zone)),
    })
    if (!block) throw new Error(`ovo-${name}-not-found`)
    return { name, position: { x: block.position.x, y: block.position.y, z: block.position.z } }
  }

  private async run<T>(kind: string, zone: Zone, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.bot.game.gameMode !== 'survival' || minecraftOvoDimension(this.bot.game.dimension) !== minecraftOvoDimension(zone.dimension) || !inZone(this.bot.entity.position, zone) ||
      this.bot.health < 16 || this.bot.food < 12 || this.bot.oxygenLevel < 200) throw new Error('ovo-preconditions-changed')
    const controller = this.host.start(kind)
    const bot = this.bot
    const abort = () => {
      bot.interrupt_code = true
      this.host.stop()
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch {}
      }
    }
    const timer = setTimeout(abort, 60_000)
    timer.unref()
    controller.signal.addEventListener('abort', abort, { once: true })
    bot.once('end', abort)
    bot.once('death', abort)
    bot.interrupt_code = false
    const chat = bot.chat.bind(bot)
    const dig = bot.dig.bind(bot)
    const place = bot.placeBlock.bind(bot)
    const findBlock = bot.findBlock.bind(bot)
    const findBlocks = bot.findBlocks.bind(bot)
    bot.chat = message => {
      if (message.startsWith('/')) {
        this.host.record('safety.command-refused', { kind })
        throw new Error('ovo-command-refused')
      }
      chat(message)
    }
    bot.dig = async () => { throw new Error('ovo-break-refused') }
    bot.placeBlock = async () => { throw new Error('ovo-place-refused') }
    bot.findBlock = options => findBlock({ ...options,
      matching: block => !block?.position || (inZone(block.position, zone) && (typeof options.matching === 'function' ? options.matching(block)
        : Array.isArray(options.matching) ? options.matching.includes(block.type) : options.matching === block.type)) })
    bot.findBlocks = options => findBlocks({ ...options,
      matching: block => !block?.position || (inZone(block.position, zone) && (typeof options.matching === 'function' ? options.matching(block)
        : Array.isArray(options.matching) ? options.matching.includes(block.type) : options.matching === block.type)) })
    try {
      const result = await work(controller.signal)
      controller.signal.throwIfAborted()
      if (!inZone(bot.entity.position, zone) || bot.interrupt_code) throw new Error('ovo-action-unconfirmed')
      this.host.succeed(kind)
      return result
    } catch (error) {
      const message = controller.signal.aborted ? 'ovo-action-cancelled' : error instanceof Error ? error.message : String(error)
      this.host.fail(kind, message)
      throw new Error(message)
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abort)
      bot.removeListener('end', abort)
      bot.removeListener('death', abort)
      bot.chat = chat
      bot.dig = dig
      bot.placeBlock = place
      bot.findBlock = findBlock
      bot.findBlocks = findBlocks
    }
  }

  private async countChest(target: Container, itemName: string): Promise<number> {
    const block = this.bot.blockAt(this.bot.entity.position.clone().set(target.position.x, target.position.y, target.position.z))
    if (!block || block.name !== 'chest') throw new Error('ovo-container-changed')
    const chest = await this.bot.openContainer(block)
    try { return chest.containerItems().filter(item => item.name === itemName).reduce((total, item) => total + item.count, 0) }
    finally { await chest.close() }
  }

  async storage(input: unknown): Promise<MinecraftOvoStorageReceipt> {
    const { zone, operation, itemName, count } = MinecraftOvoStorageRequest.parse(input)
    const target = this.container(zone, 'chest')
    return this.run('storage', zone, async () => {
      const inventoryBefore = inventoryCount(this.bot, itemName)
      const chestBefore = await this.countChest(target, itemName)
      if (operation === 'deposit' && inventoryBefore < count || operation === 'withdraw' && chestBefore < count) {
        throw new Error('minecraft-storage-insufficient')
      }
      const accepted = operation === 'deposit' ? await this.skills.putInChest(this.bot, itemName, count)
        : await this.skills.takeFromChest(this.bot, itemName, count)
      if (!accepted) throw new Error('minecraft-storage-rejected')
      const inventoryAfter = inventoryCount(this.bot, itemName)
      const chestAfter = await this.countChest(target, itemName)
      const inventoryDelta = inventoryAfter - inventoryBefore
      const chestDelta = chestAfter - chestBefore
      if (operation === 'deposit' && (inventoryDelta !== -count || chestDelta !== count) ||
        operation === 'withdraw' && (inventoryDelta !== count || chestDelta !== -count)) {
        throw new Error('minecraft-storage-receipt-unconfirmed')
      }
      return MinecraftOvoStorageReceipt.parse({ zoneId: zone.id, operation, itemName, count, position: target.position, inventoryDelta, chestDelta })
    })
  }

  async smelt(input: unknown): Promise<MinecraftOvoSmeltReceipt> {
    const { zone, phase, itemName, count } = MinecraftOvoSmeltRequest.parse(input)
    if (minecraftOvoDimension(this.bot.game.dimension) !== minecraftOvoDimension(zone.dimension)) throw new Error('ovo-preconditions-changed')
    if (phase === 'start' && this.smelting) throw new Error('minecraft-smelt-busy')
    if (phase === 'collect' && (!this.smelting || this.smelting.zoneId !== zone.id || this.smelting.itemName !== itemName || this.smelting.count !== count)) {
      throw new Error('minecraft-smelt-target-required')
    }
    const target = this.smelting?.position ?? this.container(zone, 'furnace').position
    const output = RESULTS[itemName]
    return this.run('smelt', zone, async signal => {
      const block = this.bot.blockAt(this.bot.entity.position.clone().set(target.x, target.y, target.z))
      if (!block || block.name !== 'furnace') throw new Error('ovo-container-changed')
      if (phase === 'start') {
        const furnace = await this.bot.openFurnace(block)
        const inputItem = furnace.inputItem()
        const outputItem = furnace.outputItem()
        const fuelItem = furnace.fuelItem()
        await furnace.close()
        if (outputItem || inputItem && inputItem.name !== itemName) throw new Error('minecraft-smelt-occupied')
        if (fuelItem && fuelItem.name !== 'coal' && fuelItem.name !== 'charcoal') throw new Error('minecraft-smelt-fuel-unavailable')
        const fuel = this.bot.inventory.items().find(item => item.name === 'coal' || item.name === 'charcoal')
        if (!fuelItem && (!fuel || fuel.count < Math.ceil(count / 8))) throw new Error('minecraft-smelt-fuel-unavailable')
        const before = inventoryCount(this.bot, itemName)
        const started = await this.skills.startSmelt(this.bot, itemName, count)
        if (!started || started.x !== target.x || started.y !== target.y || started.z !== target.z) throw new Error('minecraft-smelt-start-unconfirmed')
        const after = inventoryCount(this.bot, itemName)
        const inventoryDelta = after - before
        if (inventoryDelta !== -count) throw new Error('minecraft-smelt-start-unconfirmed')
        this.smelting = { position: target, itemName, count, zoneId: zone.id }
        return MinecraftOvoSmeltReceipt.parse({ zoneId: zone.id, phase, itemName, output, count, position: target, inventoryDelta })
      }
      const before = inventoryCount(this.bot, output)
      const deadline = Date.now() + 30_000
      let collected = 0
      while (Date.now() < deadline && !collected) {
        const furnace = await this.bot.openFurnace(block)
        const pending = furnace.outputItem()
        await furnace.close()
        if (pending && pending.name !== output) throw new Error('minecraft-smelt-output-unconfirmed')
        collected = await this.skills.collectSmelted(this.bot)
        if (!collected) await sleep(500, signal)
      }
      if (collected !== count) throw new Error('minecraft-smelt-output-unconfirmed')
      const inventoryDelta = inventoryCount(this.bot, output) - before
      if (inventoryDelta !== count) throw new Error('minecraft-smelt-output-unconfirmed')
      this.smelting = undefined
      return MinecraftOvoSmeltReceipt.parse({ zoneId: zone.id, phase, itemName, output, count, position: target, inventoryDelta })
    })
  }
}
