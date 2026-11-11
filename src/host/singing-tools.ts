import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isDeepStrictEqual } from 'node:util'
import { SINGING_CONTEXT } from '../core/model.ts'
import { MAX_SINGING_MIDI_BYTES, parseSingingMidi, singingMidiDraft } from '../protocol/singing-midi.ts'
import { parseScoreDraft } from '../protocol/singing-score.ts'
import { MAX_SINGING_SCORE_ROWS, MAX_SINGING_SCORE_SECONDS, MIN_SINGING_SCORE_SECONDS, type SingingTaskView } from '../protocol/singing.ts'
import { SingingInputSchema } from './api-schemas.ts'
import { isChatAttachment, readChatAttachment } from './chat-attachments.ts'
import type { CompanionRuntime } from './runtime.ts'

const COVER = 'companion_singing_cover'
const SCORE = 'companion_singing_score'
const SHARE = 'companion_singing_share'
const SONG_SHARE_REQUEST = /^(?:(?:请[ \t]*)?(发布|撤下)歌唱动态|(Share song|Withdraw song post))[：:][ \t]*(.+)$/iu
const COVER_REQUEST = /^(?:(?:请(?:帮我)?|帮我)\s*翻唱|翻唱(?:[：:]|这|一下)|(?:please\s+)?cover(?:[：:]|\s+this\b))/iu
const SCORE_REQUEST = /^(?:(?:请(?:帮我)?|帮我|给我)\s*)?按谱(?:唱|演唱)/u
const MIDI_HEADER = /^按谱唱[ \t]+MIDI$/iu
const MIDI_COMMAND = /^[ \t]+MIDI\b/iu
const MIDI_FILE = /\.midi?$/iu
const MIDI_FIELDS = /^(曲名|轨道|通道|起始|音符数|歌词)\s*[:：]\s*(.+)$/u
const MIDI_FORMAT = '请在同一条消息附上一份 MIDI。首行写「按谱唱 MIDI」，随后逐行填写曲名、轨道、通道、起始、音符数，可另填歌词。'
const output = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const

interface SingingTurn {
  session: Session
  turn: number
  step?: number
  claim?: UserMessage
  owner?: UserMessage
  ambiguous?: true
  calls: Map<string, string>
  nested: Map<string, { rootCallId: string; name: string }>
}

function receipt({ task, audio, coverPhase, coverEngine, scoreProgress }: SingingTaskView): string {
  return JSON.stringify({ taskId: task.id, status: task.status, title: task.title, coverPhase, coverEngine, scoreProgress, playable: !!audio, error: task.error })
}

function readMidiRequest(text: string) {
  const [heading, ...lines] = text.split(/\r?\n/u)
  if (!heading || !MIDI_HEADER.test(heading.trim())) throw new Error(MIDI_FORMAT)
  const fields = new Map<string, string>()
  for (const line of lines) {
    if (!line.trim()) continue
    const match = MIDI_FIELDS.exec(line.trim())
    if (!match?.[1] || !match[2] || fields.has(match[1])) throw new Error(MIDI_FORMAT)
    fields.set(match[1], match[2])
  }
  const positive = (key: string) => {
    const value = fields.get(key) ?? ''
    const number = Number(value)
    if (!/^\d{1,9}$/u.test(value) || number < 1) throw new Error(MIDI_FORMAT)
    return number
  }
  const title = fields.get('曲名')
  if (!title || title.length > 80) throw new Error('MIDI 演唱需要填写 1–80 字的曲名。')
  return {
    title,
    track: positive('轨道'),
    channel: positive('通道'),
    start: positive('起始'),
    count: positive('音符数'),
    lyrics: fields.get('歌词'),
  }
}

export function registerSingingTools(ctx: Context, runtime: CompanionRuntime): () => void {
  let current: SingingTurn | undefined
  const stopEvents = ctx.on('session/event', (session, event) => {
    const binding = runtime.store.bindingByContext(SINGING_CONTEXT)
    if (binding?.sessionId !== session.id || binding.kind !== 'topic') return
    if (event.type === 'turn/start') {
      current = { session, turn: event.data.turn, calls: new Map(), nested: new Map() }
      return
    }
    const turn = current
    if (turn?.session !== session) return
    if (event.type === 'turn/end' && event.data.turn === turn.turn) current = undefined
    if ((event.type === 'step/start' || event.type === 'step/end') && event.data.turn === turn.turn) {
      turn.step = event.type === 'step/start' ? event.data.step : undefined
      turn.calls.clear()
      turn.nested.clear()
    }
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      const source = event.data.source
      if (source.kind !== 'user' && !(source.kind === 'companion-mobile' && source.form === 'relay')) return
      if (turn.owner || turn.step !== 1 || turn.calls.size || turn.claim?.id !== event.data.id ||
        !isDeepStrictEqual(turn.claim.content, event.data.content) || !isDeepStrictEqual(turn.claim.source, source)) turn.ambiguous = true
      else turn.owner = event.data
    }
    if (event.type === 'tool/call' && event.data.turn === turn.turn && event.data.step === turn.step) {
      turn.calls.set(event.data.callId, event.data.name)
    }
    if (event.type === 'tool/ptc-dispatch-start' && [COVER, SCORE, SHARE].includes(event.data.name) && turn.calls.get(event.data.rootCallId) === 'run_code') {
      turn.nested.set(event.data.subCallId, { rootCallId: event.data.rootCallId, name: event.data.name })
    }
  })
  const stopClaims = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (current?.session !== agent.session || current.turn !== turn) return
    const source = message.source
    if (source.kind !== 'user' && !(source.kind === 'companion-mobile' && source.form === 'relay')) return
    if (current.claim || current.step !== undefined) current.ambiguous = true
    else current.claim = message
  })
  const stopSession = ctx.on('session/disposed', session => { if (current?.session === session) current = undefined })

  const liveSingingAgent = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent
    const binding = runtime.store.bindingByContext(SINGING_CONTEXT)
    if (!agent || binding?.sessionId !== agent.id || binding.kind !== 'topic' || ctx.agents.get(agent.id) !== agent ||
      agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
      throw new Error('This operation requires the dedicated singing session')
    }
    return agent
  }

  const requestInput = (exec: ToolRunContext, name: typeof COVER | typeof SCORE | typeof SHARE) => {
    const agent = liveSingingAgent(exec)
    const turn = current
    const nested = turn?.nested.get(exec.callId)
    const matchingCall = exec.parent ? !!exec.rootCallId && nested?.rootCallId === exec.rootCallId && nested.name === name : turn?.calls.get(exec.callId) === name
    if (turn?.session !== agent.session || turn.ambiguous || !turn.owner || !matchingCall) {
      throw new Error(name === COVER ? 'Attach one WAV to a new, explicit cover request in this singing session'
        : name === SCORE ? 'Send a new, explicit score singing request in this singing session'
        : 'Send a new, explicit song sharing or withdrawal request in this singing session')
    }
    const { owner } = turn
    const text = owner.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    return { turn, owner, text, origin: { sessionId: agent.id, messageId: String(owner.id) } }
  }

  const coverInput = (exec: ToolRunContext) => {
    const { turn, owner, text, origin } = requestInput(exec, COVER)
    const attachments = owner.content.filter(isChatAttachment)
    const file = attachments[0]
    if (!COVER_REQUEST.test(text) || attachments.length !== 1 || file?.type !== 'file' || !/\.wav$/iu.test(file.attachment.name ?? '')) {
      throw new Error('Send one authorized WAV in the same message as an explicit request, such as 帮我翻唱这段')
    }
    return { turn, file, origin }
  }

  const disposers = [stopEvents, stopClaims, stopSession, ctx.tools.register(defineTool({
    name: 'companion_singing_generate',
    description: 'Submit one local song generation when the owner explicitly asks in this singing session. Return the task reference. Audio is playable in the Companion workbench only after a successful task with an archived WAV.',
    parameters: {
      title: { type: 'string', description: 'Short song title.', required: true },
      lyrics: { type: 'string', description: 'Lyrics for the actual vocals, up to 1200 characters.', required: true },
      style: { type: 'string', description: 'Musical direction and singing language, up to 200 characters.', required: true },
      durationSeconds: { type: 'number', description: 'Requested length in whole seconds, 10–60.', required: true },
    },
    output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const agent = exec.agent ?? ctx.agents.currentInitiator()
      const binding = agent && runtime.store.bindingBySession(agent.id)
      if (binding?.contextId !== SINGING_CONTEXT || binding.kind !== 'topic') throw new Error('Song generation requires the dedicated singing session')
      const { task } = runtime.singing.submit(SingingInputSchema.parse(args), { sessionId: binding.sessionId })
      return JSON.stringify({ taskId: task.id, status: task.status, title: task.title })
    },
  })), ctx.tools.register(defineTool({
    name: COVER,
    description: 'When the owner explicitly asks to cover a song in the current singing message and attaches exactly one authorized WAV to that same message, submit one private local cover task. Examples: 帮我翻唱这段, 请翻唱这段, 翻唱：歌名. Give only a short title. The host selects the attachment. An accepted task is still processing; the archived WAV is playable only after success.',
    parameters: { title: { type: 'string', description: 'Song title, up to 80 characters.', required: true } },
    output,
    async execute(args, exec) {
      const { turn, file, origin } = coverInput(exec)
      const previous = runtime.singing.sourceCoverForMessage(origin)
      if (previous) return receipt(previous)
      if (!runtime.singing.sourceCoverAvailable) throw new Error('Local song covers are unavailable')
      const storage = ctx.get('attachments')
      if (!storage) throw new Error('Song attachment storage is unavailable')
      const source = await readChatAttachment(storage, file, exec.signal)
      if (coverInput(exec).turn !== turn) throw new Error('The cover request is no longer active')
      return receipt(runtime.singing.submitSourceCover(args.title, Buffer.from(source.buffer, source.byteOffset, source.byteLength), undefined, origin))
    },
  })), ctx.tools.register(defineTool({
    name: SHARE,
    description: 'On an explicit current owner message beginning 发布歌唱动态：曲名 / Share song: Title, write one original short caption and share only the completed recording named in that message. For 撤下歌唱动态：曲名 / Withdraw song post: Title, omit the caption. The host reads the title or task ID from the message, validates ownership and checks the archive. Speak about the recording only.',
    parameters: { caption: { type: 'string', description: 'One line about the recording, 1–280 characters, for sharing only.' } },
    output,
    async execute(args, exec) {
      const { turn, text, origin } = requestInput(exec, SHARE)
      const request = SONG_SHARE_REQUEST.exec(text)
      if (!request) throw new Error('请发送「发布歌唱动态：曲名」或「撤下歌唱动态：曲名」。')
      const selector = request[3]!.trim().replace(/^《(.+)》$/u, '$1').trim()
      if (!selector || selector.length > 80 || /[\p{Cc}\p{Cf}]/u.test(selector)) throw new Error('请提供准确的曲名或任务 ID。')
      const operation = request[1] === '撤下' || request[2]?.toLowerCase() === 'withdraw song post' ? 'withdraw' : 'share'
      return JSON.stringify(await runtime.changeSongShare({
        operation, selector, sessionId: origin.sessionId, caption: args.caption, signal: exec.signal,
        assertCurrent: () => {
          if (requestInput(exec, SHARE).turn !== turn) throw new Error('本轮歌唱动态请求已结束。')
        },
      }))
    },
  })), ctx.tools.register(defineTool({
    name: 'companion_singing_status',
    description: 'Read the real status of a song submitted in this singing session. Omit taskId for the most recent task. Only a receipt with playable=true has an archived WAV.',
    parameters: { taskId: { type: 'string', description: 'Optional task ID returned by a singing tool in this session.' } },
    output,
    async execute(args, exec) {
      const agent = liveSingingAgent(exec)
      const task = runtime.singing.sessionTask(agent.id, args.taskId)
      if (!task) throw new Error('No matching song task in this singing session')
      return receipt(task)
    },
  }))]
  if (runtime.singing.scoreAvailable) disposers.push(ctx.tools.register(defineTool({
    name: SCORE,
    description: 'Submit local Mandarin score singing only on the current owner request starting with 按谱唱 or 请按谱唱. For 按谱唱 MIDI with one same-message .mid or .midi attachment, call with no arguments. The host reads 曲名, 轨道, 通道, 起始, 音符数 and optional 歌词 from the owner message. For a written score, supply title, bpm and notes, preserving the melody and lyrics. Compose a short original only if requested. Accepted tasks are still processing.',
    parameters: {
      title: { type: 'string', description: 'Written score title, up to 80 characters.' },
      bpm: { type: 'integer', description: 'Written score tempo, 60–180 BPM.' },
      notes: { type: 'array', description: `Monophonic notes, ${MIN_SINGING_SCORE_SECONDS}–${MAX_SINGING_SCORE_SECONDS} seconds overall, up to ${MAX_SINGING_SCORE_ROWS} events. Each phrase needs at least two sung syllables.`,
        items: { type: 'object', additionalProperties: false, properties: {
          midi: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'MIDI pitch 48–84, or null for a rest.', required: true },
          beats: { type: 'number', description: '0.25–8 beats in increments of 0.25.', required: true },
          lyric: { type: 'string', description: 'One Chinese character or _ to continue the previous syllable. Omit for a rest.' },
        } },
      },
    },
    output,
    async execute(args, exec) {
      const { text, owner, turn, origin } = requestInput(exec, SCORE)
      const command = SCORE_REQUEST.exec(text)?.[0]
      if (!command) throw new Error('Begin a new score request with 按谱唱')
      const attachments = owner.content.filter(isChatAttachment)
      if (!attachments.length && !MIDI_COMMAND.test(text.slice(command.length))) {
        return receipt(runtime.singing.submitScore(args, origin))
      }
      const request = readMidiRequest(text)
      const file = attachments[0]
      if (attachments.length !== 1 || file?.type !== 'file' || !MIDI_FILE.test(file.attachment.name ?? '')) throw new Error(MIDI_FORMAT)
      if (file.attachment.bytes > MAX_SINGING_MIDI_BYTES) throw new Error(`MIDI 文件最多 ${MAX_SINGING_MIDI_BYTES / 1024} KiB。`)
      const previous = runtime.singing.scoreForMessage(origin)
      if (previous) return receipt(previous)
      const storage = ctx.get('attachments')
      if (!storage) throw new Error('MIDI 附件存储不可用。')
      const source = await readChatAttachment(storage, file, exec.signal, MAX_SINGING_MIDI_BYTES)
      if (requestInput(exec, SCORE).turn !== turn) throw new Error('本轮 MIDI 演唱请求已结束。')
      const accepted = runtime.singing.scoreForMessage(origin)
      if (accepted) return receipt(accepted)
      const { bpm, text: draft } = singingMidiDraft(parseSingingMidi(source), request)
      const score = parseScoreDraft(draft, bpm)
      if ('error' in score) throw new Error(score.error)
      return receipt(runtime.singing.submitScore({ title: request.title, bpm, notes: score.notes }, origin))
    },
  })))
  return () => { for (const dispose of disposers) dispose() }
}
