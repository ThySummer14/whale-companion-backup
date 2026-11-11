import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { msaJobOf, msaJobStart, msaSession } from './msa.mjs'
import { CbiWorld } from './cbi-world.ts'
import { MinecraftWardrobeId } from '../../src/protocol/minecraft-wardrobe.ts'
import { MinecraftShieldRequest } from '../../src/protocol/minecraft-shield.ts'
import type { Bot } from 'mineflayer'
import { createOvoBot, OvoSkillRunner } from './ovo-skills.ts'
import { offlineMinecraftProfile } from './offline.ts'

const require = createRequire(join(process.cwd(), 'package.json'))

const dataDir = process.env.COMPANION_MC_DATA_DIR || join(homedir(), '.local', 'share', 'companion', 'minecraft')
const token = readFileSync(process.env.COMPANION_MC_TOKEN_FILE || join(dataDir, 'worker.token'), 'utf8').trim()
const gameHost = process.env.COMPANION_MC_GAME_HOST || '127.0.0.1'
const gamePort = Number(process.env.COMPANION_MC_GAME_PORT || 25565)
const serverRoot = process.env.COMPANION_MC_SERVER_ROOT || join(homedir(), '工作', '会话', 'coopcraft', 'server')
const launchLabel = process.env.COMPANION_MC_LAUNCH_LABEL || 'com.coopcraft.server'
const launchPlist = process.env.COMPANION_MC_LAUNCH_PLIST || join(homedir(), 'Library', 'LaunchAgents', `${launchLabel}.plist`)
const owner = process.env.COMPANION_MC_OWNER || 'thyysummer'
const accountEmail = process.env.COMPANION_MC_ACCOUNT_EMAIL || 'bot@companion.local'
const accountCache = join(dataDir, 'msa', 'bot')
const skipLaunch = process.env.COMPANION_MC_SKIP_LAUNCH === '1'
const apiPort = Number(process.env.COMPANION_MC_API_PORT || 18789)
const ovoRoot = process.env.COMPANION_MC_OVO_ROOT
const offline = process.env.COMPANION_MC_AUTH_MODE === 'offline'
const botName = process.env.COMPANION_MC_BOT_NAME || 'dafeiyu'
const logNames = new Set(['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'])

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/"(?:accessToken|refreshToken|clientToken|token)"\s*:\s*"[^"]*"/gi, '"[redacted]"').replace(/[A-Za-z0-9_-]{80,}/g, '[redacted]').slice(0, 240)
}

function uuid(value: string): string {
  const raw = value.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(raw)) throw new Error('invalid-profile-uuid')
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.from(chunk).length
    if (size > 16_384) throw new Error('request-too-large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

class MinecraftWorld extends EventEmitter {
  // The alternative account-backed client loads these only when selected.
  private readonly mineflayer = require('mineflayer') as typeof import('mineflayer')
  private readonly pathfinder = require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')
  private readonly collectBlock = require('mineflayer-collectblock') as { plugin: (bot: Bot) => void }
  private bot?: Bot & { pathfinder?: any; collectBlock?: any }
  private ovo?: OvoSkillRunner
  private online = false
  private connecting?: Promise<unknown>
  private action?: { kind: string; controller: AbortController }
  private profile?: { name: string; uuid: string }
  private lastError?: string
  private sequence = 0
  private readonly events: Record<string, unknown>[] = []

  constructor() {
    super()
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  }

  private record(kind: string, data: Record<string, unknown> = {}): void {
    this.sequence++
    this.events.push({ seq: this.sequence, kind, at: new Date().toISOString(), ...data })
    if (this.events.length > 100) this.events.shift()
  }

  activityPresence(): { online: boolean; action?: string } {
    const action = this.action
    return { online: this.online, action: action && !action.controller.signal.aborted ? action.kind : undefined }
  }

  view(): Record<string, unknown> {
    return {
      online: this.online,
      connecting: Boolean(this.connecting),
      action: this.action?.kind,
      profile: this.profile,
      auth: offline ? { mode: 'offline' } : msaJobOf('bot'),
      lastError: this.lastError,
      observation: this.online ? this.observe() : undefined,
      capabilities: { pathfinder: true, collectBlock: true, follow: true, navigation: true, gather: true,
        ovoStorage: !!this.ovo, ovoSmelting: !!this.ovo },
    }
  }

  eventsAfter(cursor: number): Record<string, unknown>[] {
    return this.events.filter(event => Number(event.seq) > cursor).slice(-50)
  }

  login(): unknown {
    if (offline) return this.connect()
    if (this.online) throw new Error('already-online')
    const job = msaJobStart({
      innerID: 'bot', email: accountEmail, cacheDir: accountCache,
      onDone: profile => {
        this.profile = { name: profile.name, uuid: profile.uuid }
        this.record('account.authorized', { name: profile.name })
        void this.authorizeAndConnect().catch(error => {
          this.lastError = publicError(error)
          this.record('connection.failed', { message: this.lastError })
        })
      },
    })
    return { auth: job }
  }

  async authorize(): Promise<unknown> {
    if (offline) return this.connect()
    if (this.online) return this.view()
    if (!this.profile) {
      const session = await msaSession({ email: accountEmail, cacheDir: accountCache })
      this.profile = { name: session.selectedProfile.name, uuid: session.selectedProfile.id }
    }
    return this.authorizeAndConnect()
  }

  private async authorizeAndConnect(): Promise<void> {
    if (!this.profile) throw new Error('profile-required')
    if (this.profile.name.toLowerCase() === owner.toLowerCase()) throw new Error('primary-account-refused')
    await this.whitelist(this.profile)
    await this.connect()
  }

  private whitelistEntries(): { uuid: string; name: string }[] {
    return JSON.parse(readFileSync(join(serverRoot, 'whitelist.json'), 'utf8')) as { uuid: string; name: string }[]
  }

  private async launch(action: 'bootout' | 'bootstrap'): Promise<void> {
    if (skipLaunch) return
    const uid = process.getuid?.() ?? 501
    const args = action === 'bootout' ? [action, `gui/${uid}/${launchLabel}`] : [action, `gui/${uid}/${launchLabel}`, launchPlist]
    await new Promise<void>((resolve, reject) => {
      const child = spawn('launchctl', args, { env: { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''
      child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-200) })
      child.once('error', reject)
      child.once('exit', code => { if (code === 0) resolve(); else reject(new Error(`launch-${action}-${code}:${error}`)) })
    })
  }

  private async whitelist(profile: { name: string; uuid: string }): Promise<void> {
    const entries = this.whitelistEntries()
    if (entries.some(entry => entry.name.toLowerCase() === profile.name.toLowerCase() || entry.uuid.replace(/-/g, '').toLowerCase() === profile.uuid.replace(/-/g, '').toLowerCase())) return
    await this.launch('bootout')
    let added = false
    try {
      const now = new Date().toISOString().replace(/[:.]/g, '-')
      mkdirSync(join(serverRoot, 'backups'), { recursive: true, mode: 0o700 })
      copyFileSync(join(serverRoot, 'whitelist.json'), join(serverRoot, 'backups', `whitelist-${now}.json`))
      entries.push({ uuid: uuid(profile.uuid), name: profile.name })
      const target = join(serverRoot, 'whitelist.json')
      writeFileSync(`${target}.tmp`, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
      renameSync(`${target}.tmp`, target)
      added = true
      this.record('whitelist.added', { name: profile.name })
    } finally {
      await this.launch('bootstrap')
      this.record(added ? 'server.restored' : 'server.restore-requested')
    }
  }

  async connect(): Promise<unknown> {
    if (this.online) return this.view()
    this.connecting ??= this.connectInternal().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connectInternal(): Promise<unknown> {
    const testProfile = offlineMinecraftProfile({ enabled: offline, ovoRoot, gameHost, botName, owner })
    const session = testProfile ? undefined : await msaSession({ email: accountEmail, cacheDir: accountCache })
    const profile = testProfile ?? { name: session!.selectedProfile.name, uuid: session!.selectedProfile.id }
    if (profile.name.toLowerCase() === owner.toLowerCase()) throw new Error('primary-account-refused')
    this.profile = profile
    if (!testProfile && !this.whitelistEntries().some(entry => entry.name.toLowerCase() === profile.name.toLowerCase() || entry.uuid.replace(/-/g, '').toLowerCase() === profile.uuid.replace(/-/g, '').toLowerCase())) throw new Error('whitelist-required')
    const authenticate = testProfile ? 'offline' as const : (client: any, options: any) => {
      if (!session) throw new Error('msa-session-required')
      client.session = session
      client.uuid = uuid(profile.uuid)
      client.username = profile.name
      client.emit('session', session)
      const authOptions = options as typeof options & { haveCredentials: boolean }
      authOptions.haveCredentials = true
      options.accessToken = session.accessToken
      options.session = session
      if (session.certificates) Object.assign(client, session.certificates)
      const pending = options.connect?.(client) as Promise<void> | undefined
      pending?.catch((error: unknown) => { bot.emit('error', error instanceof Error ? error : new Error(String(error))) })
    }
    const ovo = ovoRoot ? await createOvoBot({ root: ovoRoot, username: profile.name, host: gameHost, port: gamePort, authenticate }) : undefined
    const bot = ovo?.bot ?? this.mineflayer.createBot({
      host: gameHost, port: gamePort, username: profile.name, version: '1.21.1', respawn: false, auth: authenticate,
    }) as Bot & { pathfinder?: any; collectBlock?: any }
    this.bot = bot
    if (!ovo) {
      bot.loadPlugin(this.pathfinder.pathfinder)
      bot.loadPlugin(this.collectBlock.plugin)
    }
    bot.on('error', error => {
      this.lastError = publicError(error)
      this.record('connection.error', { message: this.lastError })
    })
    bot.on('kicked', reason => {
      this.lastError = publicError(reason)
      this.record('connection.kicked', { message: this.lastError })
    })
    bot.on('end', () => {
      if (this.bot === bot) {
        this.ovo = undefined
        this.bot = undefined
      }
      this.online = false
      this.action = undefined
      this.record('connection.offline')
    })
    bot.on('death', () => { this.record('player.death', { observation: this.observe() }) })
    bot.on('chat', (username, message) => {
      if (username === bot.username) this.record('chat.sent', { message, delivery: 'sent' })
      else this.record('chat.received', { username, message })
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('spawn-timeout')) }, 25_000)
      const cleanup = () => {
        clearTimeout(timer)
        bot.removeListener('spawn', ready)
        bot.removeListener('error', fail)
        bot.removeListener('kicked', fail)
        bot.removeListener('end', fail)
      }
      const ready = () => { cleanup(); resolve() }
      const fail = (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(publicError(error))) }
      bot.once('spawn', ready)
      bot.once('error', fail)
      bot.once('kicked', fail)
      bot.once('end', fail)
    })
    this.online = true
    this.ovo = ovo && new OvoSkillRunner(ovo.bot, ovo.skills, {
      start: kind => this.startAction(kind),
      succeed: kind => this.finishAction(kind),
      fail: (kind, message) => { this.action = undefined; this.record('action.failed', { kind, message }) },
      stop: () => this.stopPathing(),
      record: (kind, data) => this.record(kind, data),
    })
    this.record('connection.online', { observation: this.observe() })
    return this.view()
  }

  async disconnect(): Promise<unknown> {
    await this.stop()
    const bot = this.bot
    this.online = false
    this.ovo = undefined
    this.bot = undefined
    bot?.quit()
    return this.view()
  }

  private requireBot(): Bot & { pathfinder?: any; collectBlock?: any } {
    if (!this.bot || !this.online) throw new Error('minecraft-offline')
    return this.bot
  }

  private position(): Record<string, number> | undefined {
    const value = this.bot?.entity?.position
    return value ? { x: Number(value.x.toFixed(3)), y: Number(value.y.toFixed(3)), z: Number(value.z.toFixed(3)) } : undefined
  }

  private inventory(): { name: string; count: number }[] {
    return this.bot?.inventory.items().map(item => ({ name: item.name, count: item.count })) ?? []
  }

  observe(): Record<string, unknown> {
    const bot = this.requireBot()
    const me = bot.entity.position
    const players = Object.values(bot.players).filter(player => player.username !== bot.username).map(player => ({
      name: player.username,
      distance: player.entity ? Number(me.distanceTo(player.entity.position).toFixed(2)) : undefined,
    }))
    const nearby = Object.values(bot.entities).filter(entity => entity !== bot.entity && (entity.type === 'player' || entity.type === 'mob')).slice(0, 16).map(entity => ({
      name: entity.username ?? entity.name ?? entity.type,
      kind: entity.type,
      distance: Number(me.distanceTo(entity.position).toFixed(2)),
    }))
    return {
      online: this.online,
      username: bot.username,
      version: bot.version,
      position: this.position(),
      dimension: bot.game.dimension,
      gameMode: bot.game.gameMode,
      health: bot.health,
      food: bot.food,
      saturation: bot.foodSaturation,
      oxygen: bot.oxygenLevel,
      timeOfDay: bot.time.timeOfDay,
      raining: bot.isRaining,
      thundering: bot.isRaining && bot.thunderState > 0,
      players,
      nearby,
      inventory: this.inventory(),
      action: this.action?.kind,
    }
  }

  private startAction(kind: string): AbortController {
    this.requireBot()
    if (this.action) throw new Error('action-busy')
    const controller = new AbortController()
    this.action = { kind, controller }
    this.record('action.started', { kind })
    return controller
  }

  private finishAction(kind: string): void {
    if (this.action?.kind === kind) this.action = undefined
    this.record('action.finished', { kind, observation: this.online ? this.observe() : undefined })
  }

  private stopPathing(): void {
    const bot = this.bot
    if (!bot) return
    try { bot.pathfinder?.setGoal?.(null) } catch {}
    try { bot.pathfinder?.stop?.() } catch {}
    try { bot.stopDigging() } catch {}
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
      try { bot.setControlState(control, false) } catch {}
    }
  }

  async stop(): Promise<unknown> {
    this.action?.controller.abort()
    this.stopPathing()
    if (this.bot?.collectBlock) await this.bot.collectBlock.cancelTask().catch(() => {})
    this.action = undefined
    this.record('action.stopped')
    return this.view()
  }

  async chat(text: string, receiptOnly = false): Promise<unknown> {
    const bot = this.requireBot()
    const message = z.string().trim().min(1).max(256).parse(text)
    if (message.startsWith('/')) throw new Error('chat-commands-forbidden')
    bot.chat(message)
    this.record('chat.sent', { message, delivery: 'sent' })
    return { delivery: 'sent', ...(!receiptOnly && { observation: this.observe() }) }
  }

  async follow(): Promise<unknown> {
    const bot = this.requireBot()
    const target = bot.players[owner]?.entity
    if (!target) throw new Error('owner-not-visible')
    const controller = this.startAction('follow')
    try {
      const movements = new this.pathfinder.Movements(bot)
      movements.canDig = false
      movements.allowSprinting = true
      bot.pathfinder.setMovements(movements)
      bot.pathfinder.setGoal(new this.pathfinder.goals.GoalFollow(target, 2), true)
      this.record('follow.started', { target: owner })
      return { following: true, observation: this.observe() }
    } catch (error) {
      controller.abort()
      this.stopPathing()
      this.action = undefined
      throw error
    }
  }

  async move(input: { x: number; y: number; z: number }): Promise<unknown> {
    const bot = this.requireBot()
    const target = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).parse(input)
    const current = bot.entity.position
    if (Math.hypot(target.x - current.x, target.z - current.z) > 32 || Math.abs(target.y - current.y) > 8) throw new Error('move-out-of-range')
    const block = bot.blockAt(current.offset(target.x - current.x, target.y - current.y, target.z - current.z))
    if (block && /^(lava|fire|water|magma_block|cactus|sweet_berry_bush|wither_rose|powder_snow)$/.test(block.name)) throw new Error('unsafe-target')
    const controller = this.startAction('move')
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const movements = new this.pathfinder.Movements(bot)
      movements.canDig = false
      movements.allowSprinting = true
      bot.pathfinder.setMovements(movements)
      bot.pathfinder.thinkTimeout = 3500
      await bot.pathfinder.goto(new this.pathfinder.goals.GoalNear(target.x, target.y, target.z, 1))
      this.finishAction('move')
      return { moved: true, observation: this.observe() }
    } catch (error) {
      this.stopPathing()
      this.action = undefined
      if (controller.signal.aborted) throw new Error('move-cancelled')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private naturalLog(block: { name: string; position: Bot['entity']['position'] }): boolean {
    if (!logNames.has(block.name)) return false
    const bot = this.requireBot()
    for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) for (let z = -3; z <= 3; z++) {
      const nearby = bot.blockAt(block.position.offset(x, y, z))
      if (nearby?.name.endsWith('_leaves')) return true
    }
    return false
  }

  async dig(name = 'oak_log'): Promise<unknown> {
    const bot = this.requireBot()
    if (!logNames.has(name)) throw new Error('unsupported-gather-target')
    const target = bot.findBlock({ matching: block => this.naturalLog(block), maxDistance: 16, count: 1 })
    if (!target) throw new Error('safe-natural-log-not-found')
    if (!bot.canDigBlock(target)) throw new Error('cannot-dig-target')
    const controller = this.startAction('dig')
    const timeout = setTimeout(() => controller.abort(), 45_000)
    try {
      const before = this.inventory().filter(item => item.name === target.name).reduce((sum, item) => sum + item.count, 0)
      await bot.collectBlock.collect(target, { ignoreTimeout: true })
      const current = bot.blockAt(target.position)
      if (current && current.name !== 'air') throw new Error('dig-unconfirmed')
      const after = this.inventory().filter(item => item.name === target.name).reduce((sum, item) => sum + item.count, 0)
      const drops = Object.values(bot.entities).filter(entity => entity.name === 'item').slice(0, 5).map(entity => ({ name: entity.name, position: entity.position }))
      this.finishAction('dig')
      return { changed: true, block: target.name, inventoryDelta: after - before, drops, observation: this.observe() }
    } catch (error) {
      this.stopPathing()
      this.action = undefined
      if (controller.signal.aborted) throw new Error('dig-cancelled')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async storage(input: unknown): Promise<unknown> {
    if (!this.ovo) throw new Error('ovo-unavailable')
    return this.ovo.storage(input)
  }

  async smelt(input: unknown): Promise<unknown> {
    if (!this.ovo) throw new Error('ovo-unavailable')
    return this.ovo.smelt(input)
  }

  async close(): Promise<void> {
    await this.stop().catch(() => {})
    const bot = this.bot
    this.online = false
    this.ovo = undefined
    this.bot = undefined
    bot?.quit()
    this.removeAllListeners()
  }
}

const world = process.env.COMPANION_MC_AUTH_MODE === 'cbi' ? new CbiWorld() : new MinecraftWorld()
const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.headers.authorization !== `Bearer ${token}` || req.headers.host !== `127.0.0.1:${apiPort}`) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${apiPort}`)
      const path = url.pathname
      if (req.method === 'GET' && path === '/api') {
        json(res, 200, world.view())
        return
      }
      if (req.method === 'GET' && path === '/api/events') {
        const cursor = Number(url.searchParams.get('after') || 0)
        if (world instanceof CbiWorld) world.refreshChatRelay(!closing && url.searchParams.get('chatRelay') === '1')
        json(res, 200, {
          items: world.eventsAfter(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0),
          presence: world.activityPresence(),
        })
        return
      }
      if (req.method === 'GET' && path === '/api/observe') {
        json(res, 200, await world.observe())
        return
      }
      if (path === '/api/wardrobe' && url.searchParams.size) throw new Error('minecraft-wardrobe-invalid-request')
      if (req.method === 'GET' && path === '/api/wardrobe') {
        const view = world instanceof CbiWorld ? await world.wardrobe() : { available: false, options: [] }
        if (!res.destroyed) json(res, 200, view)
        return
      }
      if (req.method === 'PUT' && path === '/api/lessons') {
        json(res, 200, world instanceof CbiWorld ? world.updateLessons(await body(req)) : { avoidedTargets: 0 })
        return
      }
      if (req.method !== 'POST' || !path.startsWith('/api/')) {
        json(res, 404, { error: 'not-found' })
        return
      }
      const visitId = req.headers['x-companion-camp-visit']
      const visitRevisit = path === '/api/camp/visit/revisit'
      const visitPatrolSegment = path === '/api/camp/visit/patrol-segment'
      const visitGather = path === '/api/camp/visit/gather-preview' || path === '/api/camp/visit/gather'
      const houseAction = ['/api/house/preview', '/api/house/build', '/api/house/candidates', '/api/house/cell', '/api/house/verify',
        '/api/house/project-verify', '/api/house/recovery-preview', '/api/house/recover',
        '/api/house/supply-preview', '/api/house/supply'].includes(path)
      const visitAction = visitRevisit || visitPatrolSegment || visitGather || path === '/api/camp/visit/supply-preview' || path === '/api/camp/visit/supply' ||
        path === '/api/camp/visit/build-preview' || path === '/api/camp/visit/build'
      if (visitAction && url.searchParams.size) throw new Error('minecraft-camp-visit-invalid-request')
      if (houseAction && (req.url?.includes('?') || visitId !== undefined)) throw new Error('minecraft-house-invalid-request')
      if (path === '/api/shield' && (req.url?.includes('?') || visitId !== undefined)) throw new Error('shield-invalid-request')
      if ((visitAction || visitId !== undefined) &&
        ((!visitAction && path !== '/api/survey-preview' && path !== '/api/survey') || !z.uuid().safeParse(visitId).success)) {
        throw new Error('minecraft-camp-visit-invalid-request')
      }
      const execute = async () => {
        const input = await body(req).catch(error => {
          if (path === '/api/wardrobe') throw new Error('minecraft-wardrobe-invalid-request')
          if (path === '/api/shield') throw new Error('shield-invalid-request')
          if (houseAction) throw new Error('minecraft-house-invalid-request')
          if (visitRevisit || visitPatrolSegment || visitGather) throw new Error('minecraft-camp-visit-invalid-request')
          throw error
        })
        let result: unknown
        switch (path) {
          case '/api/login': result = world.login(); break
          case '/api/connect': result = await world.connect(); break
          case '/api/disconnect': result = await world.disconnect(); break
          case '/api/chat': {
            const chat = z.object({ text: z.string(), receiptOnly: z.boolean().optional() }).parse(input)
            result = await world.chat(chat.text, chat.receiptOnly)
            break
          }
          case '/api/stop': result = await (world instanceof CbiWorld ? world.stopFromOwner() : world.stop()); break
          case '/api/camp/visit/start':
          case '/api/camp/visit/end': {
            if (!(world instanceof CbiWorld)) throw new Error('minecraft-camp-visit-unavailable')
            if (url.searchParams.size) throw new Error('minecraft-camp-visit-invalid-request')
            if (path === '/api/camp/visit/end') {
              result = await world.endCampVisit(input)
              break
            }
            const controller = new AbortController()
            const disconnected = () => controller.abort()
            res.once('close', disconnected)
            if (res.destroyed) disconnected()
            try { result = await world.startCampVisit(input, controller.signal) }
            finally { res.off('close', disconnected) }
            break
          }
          case '/api/camp/pause':
          case '/api/camp/resume':
            if (!(world instanceof CbiWorld)) throw new Error('minecraft-camp-unavailable')
            z.strictObject({}).parse(input)
            result = path === '/api/camp/pause' ? await world.pauseCamp() : world.resumeCamp()
            break
          case '/api/wardrobe': {
            if (!(world instanceof CbiWorld)) throw new Error('minecraft-wardrobe-unavailable')
            const choice = z.strictObject({ id: MinecraftWardrobeId }).safeParse(input)
            if (!choice.success) throw new Error('minecraft-wardrobe-invalid-request')
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            res.once('close', disconnect)
            if (res.destroyed) disconnect()
            try { result = await world.changeAppearance(choice.data.id, controller.signal) }
            finally { res.off('close', disconnect) }
            break
          }
          case '/api/follow': result = await world.follow(); break
          case '/api/move': result = await world.move(z.object({ x: z.number(), y: z.number(), z: z.number() }).parse(input)); break
          case '/api/dig': result = await world.dig(z.object({ name: z.string().optional() }).parse(input).name); break
          case '/api/return':
            if (!(world instanceof CbiWorld)) throw new Error('safe-return-requires-cbi')
            result = await world.returnToSafety(); break
          case '/api/shield': {
            if (!(world instanceof CbiWorld)) throw new Error('shield-unavailable')
            const request = MinecraftShieldRequest.safeParse(input)
            if (!request.success) throw new Error('shield-invalid-request')
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            res.once('close', disconnect)
            if (res.destroyed) disconnect()
            try { result = await world.holdShield(request.data, controller.signal) }
            finally { res.off('close', disconnect) }
            break
          }
          case '/api/craft':
            if (!(world instanceof CbiWorld)) throw new Error('craft-requires-cbi')
            result = await world.craft(z.object({ name: z.string() }).parse(input).name); break
          case '/api/storage':
          case '/api/smelt':
          case '/api/supply':
          case '/api/camp-supply':
          case '/api/camp/visit/supply-preview':
          case '/api/camp/visit/supply':
          case '/api/camp/visit/build-preview':
          case '/api/camp/visit/build':
          case '/api/camp/visit/revisit':
          case '/api/camp/visit/patrol-segment':
          case '/api/camp/visit/gather-preview':
          case '/api/camp/visit/gather':
          case '/api/survey-preview':
          case '/api/survey':
          case '/api/house/preview':
          case '/api/house/build':
          case '/api/house/recovery-preview':
          case '/api/house/recover':
          case '/api/house/candidates':
          case '/api/house/cell':
          case '/api/house/verify':
          case '/api/house/project-verify':
          case '/api/house/supply-preview':
          case '/api/house/supply':
          case '/api/build-authorized': {
            const capability = path === '/api/storage' || path === '/api/smelt' ? 'ovo' : houseAction ? 'house' : visitGather ? 'camp-visit-gather' : visitPatrolSegment ? 'camp-visit-patrol' : visitRevisit ? 'camp-visit-revisit'
              : path.startsWith('/api/survey') ? 'survey' : path.includes('/build') ? 'build' : 'supply'
            if (path === '/api/storage' || path === '/api/smelt') {
              if (!(world instanceof MinecraftWorld)) throw new Error(`${capability}-unavailable`)
            } else if (!(world instanceof CbiWorld)) throw new Error(`${capability}-unavailable`)
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            res.once('close', disconnect)
            if (res.destroyed) disconnect()
            try {
              if (world instanceof MinecraftWorld) result = path === '/api/storage' ? await world.storage(input) : await world.smelt(input)
              else switch (path) {
                case '/api/survey-preview': result = await world.surveyPreview(input, controller.signal); break
                case '/api/survey': result = await world.survey(input, controller.signal); break
                case '/api/camp/visit/supply-preview': result = await world.campVisitSupplyPreview(input, controller.signal); break
                case '/api/camp/visit/supply': result = await world.campVisitSupply(input, controller.signal); break
                case '/api/camp/visit/build-preview': result = await world.campVisitBuildPreview(input, controller.signal); break
                case '/api/camp/visit/build': result = await world.campVisitBuild(input, controller.signal); break
                case '/api/camp/visit/revisit': result = await world.campVisitRevisit(input, controller.signal); break
                case '/api/camp/visit/patrol-segment': result = await world.campVisitPatrolSegment(input, controller.signal); break
                case '/api/camp/visit/gather-preview': result = await world.campVisitGatherPreview(input, controller.signal); break
                case '/api/camp/visit/gather': result = await world.campVisitGather(input, controller.signal); break
                case '/api/house/preview': result = await world.previewHouse(input, controller.signal); break
                case '/api/house/build': result = await world.buildHouse(input, controller.signal); break
                case '/api/house/recovery-preview': result = await world.previewHouse(input, controller.signal, true); break
                case '/api/house/recover': result = await world.buildHouse(input, controller.signal, true); break
                case '/api/house/candidates': result = await world.houseCandidates(input, controller.signal); break
                case '/api/house/cell': result = await world.placeHouseCell(input, controller.signal); break
                case '/api/house/verify': result = await world.verifyHouse(input, controller.signal); break
                case '/api/house/project-verify': result = await world.verifyHouseProject(input, controller.signal); break
                case '/api/house/supply-preview': result = await world.houseSupplyPreview(input, controller.signal); break
                case '/api/house/supply': result = await world.houseSupply(input, controller.signal); break
                case '/api/build-authorized': result = await world.buildCamp(input, controller.signal); break
                default: result = await world.supply(input, controller.signal, path === '/api/camp-supply')
              }
            } finally { res.off('close', disconnect) }
            break
          }
          case '/api/build':
            if (!(world instanceof CbiWorld)) throw new Error('build-requires-cbi')
            result = await world.buildCamp(input); break
          default: json(res, 404, { error: 'not-found' }); return
        }
        return result
      }
      const control = path === '/api/stop' || path === '/api/disconnect' || path === '/api/camp/pause' || path === '/api/camp/resume' ||
        path === '/api/camp/visit/start' || path === '/api/camp/visit/end'
      const result = await (world instanceof CbiWorld && !control ? world.withCampAction(execute, visitId as string | undefined) : execute())
      if (!res.destroyed && !res.headersSent) json(res, 200, result)
    } catch (error) {
      const message = publicError(error)
      if (!res.destroyed) json(res, ['minecraft-wardrobe-invalid-request', 'minecraft-camp-visit-invalid-request', 'minecraft-house-invalid-request', 'shield-invalid-request'].includes(message) ? 400
        : message === 'minecraft-wardrobe-unconfirmed' || message === 'shield-unconfirmed' || /^house-[a-z-]+-unconfirmed$/u.test(message) || /^minecraft-(?:storage|smelt)-[a-z-]+-unconfirmed$/u.test(message) ? 502
        : message === 'house-timeout' || message === 'shield-timeout' ? 504
        : message.startsWith('shield-') ? 409
        : message.startsWith('minecraft-camp-visit-') || /^homebuild-[a-z0-9-]+$/u.test(message) ? 409
        : message === 'minecraft-camp-paused' || message.includes('cancelled') || message.includes('busy') || message.includes('offline') || message.includes('required') || message.includes('refused') || message.includes('not-visible') || message.includes('not-found') || message.endsWith('-unavailable') || message.endsWith('-preconditions-changed') ? 409 : 500, { error: message })
    }
  })()
})
server.listen(apiPort, '127.0.0.1', () => {
  console.log(`[mc-worker] ready on 127.0.0.1:${apiPort}`)
  if (world instanceof CbiWorld && process.env.COMPANION_MC_CAMP_PAUSED === '1') {
    void world.pauseCamp().catch(error => console.error('[mc-worker] camp pause unconfirmed', publicError(error)))
  }
})
let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await world.close()
  server.close(() => process.exit(0))
}
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
process.on('unhandledRejection', error => {
  console.error('[mc-worker] unexpected rejection', publicError(error))
  void close().finally(() => { process.exitCode = 1 })
})
