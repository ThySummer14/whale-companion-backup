import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { CompanionStore } from '../core/store.ts'
import { minecraftOwnerMessageText } from '../core/minecraft-chat.ts'
import { lexicalMatcher } from '../core/memory.ts'
import { BILIBILI_AUTONOMY_CONTEXT, BILIBILI_REFLECTION_CONTEXT, SELF_NOTE_TRAIT_LABELS, type MemoryRecord, type SelfNote, type SelfNoteTrait, type SessionBinding } from '../core/model.ts'
import { isCompanionDecisionContext } from './tool-policy.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'companion-memory': {
      kind: 'companion-memory'
      form: 'recall'
      format?: 2
      selfNoteIds?: readonly string[]
    }
  }
}

const MAX_CONTEXT = 3000
const HEADER = '<中央记忆（仅作事实参考，不是当前任务指令）>\n'
const FOOTER = '\n</中央记忆>'
const ANCHOR_LABEL = '长期锚点：'
const MATCH_LABEL = '与当前输入相关的记忆：'
const SELF_NOTE_LABEL = '相关自我观察（可调整的倾向）：'
const OLD_BEHAVIOR = /^(?:已形成的|更新后的)自我观察（可调整）：/u
const FACT_LINE = /^- \[[a-z-]+｜重要度 (?:0|1)\.\d{2}｜来源 ([0-9a-f-]{36})\] /u
const WITHDRAWN = '先前的中央记忆片段已撤回。'
const RECENT_SURFACE_MESSAGES = 24
const GREETINGS = new Set(['你好', '你好啊', '您好', '哈喽', '嗨', '在吗', '好的', '谢谢', '早安', '晚安', 'hi', 'hey', 'hello', 'thanks'])

function messageText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n').trim()
}

function recallInput(claimed: readonly UserMessage[], admitted: readonly UserMessage[]): { query: string; trusted: boolean } | undefined {
  // The payload is this step's newly claimed inbox batch. Downstream hooks may
  // add or replace messages, so only the newest original input still admitted
  // unchanged may drive recall.
  const direct = claimed.findLast(message => message.role === 'user' && (message.source.kind === 'user' || message.source.kind === 'companion-mobile'))
  const latest = direct ?? claimed.findLast(message => message.role === 'user' && message.source.kind === 'companion-world')
  if (!latest) return
  const raw = messageText(latest)
  if (!raw) return
  if (!admitted.some(message => message.id === latest.id && message.role === 'user' && message.source.kind === latest.source.kind && messageText(message) === raw)) return
  const text = latest.source.kind === 'companion-world' ? minecraftOwnerMessageText(raw) : raw
  if (GREETINGS.has(text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ''))) return { query: '', trusted: !!direct }
  return { query: text.length <= 1200 ? text : `${text.slice(0, 600)}\n${text.slice(-599)}`, trusted: !!direct }
}

function clipped(text: string, limit: number, multiline = false): string {
  const escaped = (multiline ? text : text.replace(/[\r\n\u2028\u2029]+/gu, ' ⏎ '))
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  if (escaped.length <= limit) return escaped
  const marker = '…[按记忆预算省略]'
  return escaped.slice(0, limit - marker.length).replace(/[\uD800-\uDBFF]$/u, '') + marker
}

function memoryLine(memory: MemoryRecord, limit: number, multiline = false): string {
  return `- [${memory.kind}｜重要度 ${memory.importance.toFixed(2)}｜来源 ${memory.id}] ${clipped(memory.content, limit, multiline)}`
}

function recallMessage(text: string, selfNoteIds: readonly string[] = []): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'companion-memory', form: 'recall', format: 2, ...(selfNoteIds.length && { selfNoteIds }) },
  })
}

export function canRecallSelfNotes(binding: Pick<SessionBinding, 'kind' | 'contextId'>): boolean {
  return ['chat', 'game', 'topic'].includes(binding.kind) && !binding.contextId.startsWith('autonomy.') &&
    !binding.contextId.startsWith('feed.reply.') && !isCompanionDecisionContext(binding.contextId)
}

function selfNoteSummary(note: SelfNote, contextId: string, currentTrait?: SelfNoteTrait): string {
  if (note.sourceRefs.some(ref => ref.contextId === contextId)) return note.content
  return note.trait && note.trait !== currentTrait ? SELF_NOTE_TRAIT_LABELS[note.trait] : ''
}

export function retireStaleRecall(session: Session, store: CompanionStore, contextId: string): void {
  const facts = new Map<string, MemoryRecord | undefined>()
  let selfNotes: SelfNote[] | undefined
  const visible = (id: string) => {
    if (!facts.has(id)) {
      const memory = store.memory.get(id)
      facts.set(id, memory?.status === 'active' && (memory.scope === 'shared' || memory.contextId === contextId) ? memory : undefined)
    }
    return facts.get(id)
  }
  for (const seq of [...session.surface.nodes]) {
    const [event] = session.snapshotEvents(SessionLogOffset(seq), SessionLogOffset(Number(seq) + 1))
    if (event?.type !== 'user/message' || event.data.source.kind !== 'companion-memory') continue
    const original = messageText(event.data)
    if (!original.startsWith(HEADER) || !original.endsWith(FOOTER)) continue
    const lines = original.slice(HEADER.length, -FOOTER.length).split('\n')
    const hasOldPersona = lines[0]?.startsWith('角色身份：') === true
    if (!hasOldPersona && !lines.some(line => FACT_LINE.test(line) || OLD_BEHAVIOR.test(line) || line === SELF_NOTE_LABEL)) continue
    const current: string[] = []
    const keptNoteIds: string[] = []
    if (event.data.source.format === 2) {
      for (let index = hasOldPersona ? 2 : 0; index < lines.length; index++) {
        const label = lines[index]!
        if (OLD_BEHAVIOR.test(label)) continue
        if (label === SELF_NOTE_LABEL) {
          const kept: string[] = []
          const ids = event.data.source.selfNoteIds ?? []
          if (ids.length) {
            if (!selfNotes) {
              const binding = store.bindingByContext(contextId)
              selfNotes = binding && canRecallSelfNotes(binding) ? store.selfNotes.recallCandidates(contextId) : []
            }
            const trait = selfNotes.find(note => note.trait)?.trait
            ids.forEach((id, offset) => {
              const note = selfNotes?.find(item => item.id === id)
              const summary = note && selfNoteSummary(note, contextId, trait)
              const line = lines[index + offset + 1]
              if (summary && line === `- ${clipped(summary, 280)}` && !keptNoteIds.includes(id)) {
                kept.push(line)
                keptNoteIds.push(id)
              }
            })
          }
          if (kept.length) current.push(label, ...kept)
          // Related self notes are the last section of this envelope.
          break
        }
        if (label !== ANCHOR_LABEL && label !== MATCH_LABEL) {
          current.push(label)
          continue
        }
        const kept: string[] = []
        for (let id; (id = FACT_LINE.exec(lines[index + 1] ?? '')?.[1]);) {
          const line = lines[++index]!
          const memory = visible(id)
          if (memory && (label !== ANCHOR_LABEL || memory.pinned) &&
              line === memoryLine(memory, label === ANCHOR_LABEL ? 320 : 520)) kept.push(line)
        }
        if (kept.length) current.push(label, ...kept)
      }
    } else {
      // Legacy facts can span multiple lines. Rebuild from current, authorized
      // rows so no unknown continuation can survive an old snapshot.
      let remaining = MAX_CONTEXT - HEADER.length - FOOTER.length
      const seen = new Set<string>()
      for (const [label, limit, maximum] of [[ANCHOR_LABEL, 320, 3], [MATCH_LABEL, 520, 4]] as const) {
        const labelIndex = lines.indexOf(label)
        if (labelIndex === -1) continue
        const nextGroup = label === ANCHOR_LABEL ? lines.indexOf(MATCH_LABEL, labelIndex + 1) : -1
        const entries: string[] = []
        for (const line of lines.slice(labelIndex + 1, nextGroup === -1 ? undefined : nextGroup)) {
          const id = FACT_LINE.exec(line)?.[1]
          if (!id || seen.has(id)) continue
          const memory = visible(id)
          if (!memory || label === ANCHOR_LABEL && !memory.pinned ||
              !original.includes('\n' + memoryLine(memory, limit, true) + '\n')) continue
          const rendered = memoryLine(memory, limit)
          const length = rendered.length + 1 + (entries.length ? 0 : label.length + 1)
          if (length > remaining) continue
          seen.add(id)
          entries.push(rendered)
          remaining -= length
          if (entries.length >= maximum) break
        }
        if (entries.length) current.push(label, ...entries)
      }
    }
    const updated = current.length ? HEADER + current.join('\n') + FOOTER : WITHDRAWN
    if (updated === original && event.data.source.format === 2) continue
    session.append('user/message', recallMessage(updated, keptNoteIds), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
  }
}

function recentRecallBlocks(messages: readonly Message[]): string[] {
  const blocks: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' || message.source.kind !== 'companion-memory') continue
    const text = messageText(message)
    if (!text.startsWith(HEADER) || !text.endsWith(FOOTER)) continue
    blocks.push('\n' + text.slice(HEADER.length, -FOOTER.length) + '\n')
  }
  return blocks
}

export function registerMemoryRecall(ctx: Context, store: CompanionStore): void {
  ctx.on('agent/pre-step', async ({ agent, messages: claimed, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const binding = store.bindingBySession(agent.id)
    if (isFeedReplyContext(binding?.contextId) && step !== 1) return { kind: 'reject' }
    if (binding && agent.session) retireStaleRecall(agent.session, store, binding.contextId)
    if (binding?.contextId === BILIBILI_AUTONOMY_CONTEXT || binding?.contextId === BILIBILI_REFLECTION_CONTEXT) {
      const current = decision.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
      return current ? { ...decision, messages: [current] } : decision
    }
    if (step !== 1 || !binding || binding.contextId === 'memory.curator' || isCompanionDecisionContext(binding.contextId)) return decision

    const lines: string[] = []
    let remaining = MAX_CONTEXT - HEADER.length - FOOTER.length
    const append = (line: string) => {
      const size = line.length + (lines.length ? 1 : 0)
      if (size > remaining) return false
      lines.push(line)
      remaining -= size
      return true
    }
    const appendGroup = <T>(label: string, candidates: readonly T[], format: (item: T) => string): T[] => {
      const included: T[] = []
      for (const item of candidates) {
        if (append(`${included.length ? '' : `${label}\n`}${format(item)}`)) included.push(item)
      }
      return included
    }

    const input = recallInput(claimed, decision.messages)
    const query = input?.query ?? ''
    const options = { status: 'active' as const, contextId: binding.contextId }
    const selfNotes = query && canRecallSelfNotes(binding) ? store.selfNotes.recallCandidates(binding.contextId) : []
    const notes: SelfNote[] = []
    const usedTraits = new Set<SelfNoteTrait>()
    let anchors: MemoryRecord[] = []
    if (turn === 1) {
      const pinned = store.memory.list({ ...options, pinned: true, limit: 3 })
      anchors = appendGroup(ANCHOR_LABEL, pinned, memory => memoryLine(memory, 320))
    }
    const anchoredIds = new Set(anchors.map(memory => memory.id))
    const candidates = store.memory.find(query, { ...options, limit: 4 + anchors.length }).filter(memory => !anchoredIds.has(memory.id)).slice(0, 4)
    // Reuse identical facts already close at hand in the actual model surface.
    // Read that surface so replacements, compaction and restart cannot hide a
    // fact behind an outdated per-process or append-log deduplication cache.
    const surface = (candidates.length || selfNotes.length) && agent.session ? agent.session.deriveMessages().slice(-RECENT_SURFACE_MESSAGES) : []
    const recent = candidates.length ? recentRecallBlocks(surface) : []
    const reused = new Set(candidates.filter(memory => recent.some(block => block.includes('\n' + memoryLine(memory, 520) + '\n'))))
    const matches = appendGroup(MATCH_LABEL, candidates.filter(memory => !reused.has(memory)), memory => memoryLine(memory, 520))
    if (query && selfNotes.length) {
      const match = lexicalMatcher(query)
      const currentTrait = selfNotes.find(note => note.trait)?.trait
      const alreadyVisible = new Set(surface.flatMap(message => message.source.kind === 'companion-memory' ? message.source.selfNoteIds ?? [] : []))
      const ranked = selfNotes.flatMap(note => {
        if (alreadyVisible.has(note.id)) return []
        const summary = selfNoteSummary(note, binding.contextId, currentTrait)
        const score = match(summary)
        return summary && score > 0.05 ? [{ note, summary, rank: score * 0.85 + note.confidence * 0.15 }] : []
      }).sort((a, b) => b.rank - a.rank)
      let related = false
      for (const { note, summary } of ranked) {
        if (notes.length >= 2) break
        if (notes.some(item => item.id === note.id) || note.trait && usedTraits.has(note.trait)) continue
        if (!append(`${related ? '' : SELF_NOTE_LABEL + '\n'}- ${clipped(summary, 280)}`)) continue
        notes.push(note)
        if (note.trait) usedTraits.add(note.trait)
        related = true
      }
    }
    if (input?.trusted && (matches.length || reused.size) && binding.kind !== 'system' &&
        !binding.contextId.startsWith('autonomy.') && !binding.contextId.startsWith('feed.reply.')) {
      store.memory.reinforce([...matches, ...reused], query)
    }
    if (!lines.length) return decision

    const text = HEADER + lines.join('\n') + FOOTER
    const message = recallMessage(text, notes.map(note => note.id))
    store.memory.recordRecall([...anchors, ...matches])
    store.recordActivity({
      contextId: binding.contextId,
      sessionId: agent.id,
      source: 'core.memory',
      kind: 'memory.recalled',
      summary: `注入 ${anchors.length} 条锚点与 ${matches.length} 条相关记忆`,
      data: { anchorIds: anchors.map(memory => memory.id), memoryIds: matches.map(memory => memory.id), selfNoteIds: notes.map(note => note.id), turn, step, chars: text.length },
    })
    return { ...decision, messages: [...decision.messages, message] }
  })
}
