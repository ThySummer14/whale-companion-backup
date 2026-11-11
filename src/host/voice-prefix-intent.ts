import { randomUUID } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'

const PREFIX_CHARS = 40
const SENTENCE_END = /[。！？]/u
const PLAIN_CHINESE = /^\p{Script=Han}[\p{Script=Han}，、：； ]*$/u

export class VoicePrefixAttempt {
  readonly key = randomUUID()
  prefix?: string
  assistantSeq?: number
  settled = false
  private revision: number
  private index = 0
  private block?: number
  private text = ''

  constructor(private readonly opening: Extract<AssistantStreamFrame, { type: 'start' }>) {
    this.revision = opening.revision
  }

  /** Returns false when the observed attempt can no longer be speculated on. */
  observe(frame: Exclude<AssistantStreamFrame, { type: 'start' }>): boolean {
    if (this.settled || frame.attemptId !== this.opening.attemptId || frame.revision !== this.revision + 1 || frame.index !== this.index) return false
    this.revision = frame.revision
    if (frame.type === 'end') {
      this.settled = frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message' && frame.outcome.seq === this.assistantSeq
      return this.settled
    }
    this.index++
    const chunk = frame.chunk
    if (chunk.type === 'tool-call-delta' || chunk.type === 'finish' && chunk.reason.kind !== 'stop'
      || chunk.type === 'block-start' && chunk.blockType !== 'text' && chunk.blockType !== 'reasoning'
      || chunk.type === 'block-end' && chunk.block.type !== 'text' && chunk.block.type !== 'reasoning') return false
    if (chunk.type !== 'text-delta') return true
    if (this.block !== undefined && chunk.index !== this.block) return false
    this.block = chunk.index
    if (this.prefix) return true

    this.text += chunk.text.slice(0, PREFIX_CHARS + 1 - this.text.length)
    const boundary = this.text.search(SENTENCE_END)
    const clause = boundary === -1 ? this.text : this.text.slice(0, boundary)
    if (clause && !PLAIN_CHINESE.test(clause)) return false
    if (boundary === -1) return this.text.length < PREFIX_CHARS
    if (boundary >= PREFIX_CHARS || (clause.match(/\p{Script=Han}/gu)?.length ?? 0) < 2 || SENTENCE_END.test(this.text[boundary + 1] ?? '')) return false
    this.prefix = this.text.slice(0, boundary + 1)
    this.text = ''
    return true
  }

  matchFinal(text: string, seq: number): boolean {
    const prefix = this.prefix
    if (this.assistantSeq !== undefined || !prefix || !text.startsWith(prefix) || text.trim().length > 240 || SENTENCE_END.test(text[prefix.length] ?? '')) return false
    this.assistantSeq = seq
    return true
  }
}
