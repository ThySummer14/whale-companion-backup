import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CompanionRuntime } from './runtime.ts'
import { isFeedReplyContext } from '../core/feed-reply.ts'

const output = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
} as const

export function registerOcrTools(ctx: Context, runtime: CompanionRuntime): () => void {
  const store = runtime.store
  const authority = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent ?? ctx.agents.currentInitiator()
    if (!agent) throw new Error('Companion OCR requires a registered DSH session')
    const binding = store.bindingBySession(agent.id)
    if (!binding) throw new Error('This DSH session is not registered as a Companion context')
    if (binding.contextId === 'memory.curator' || isFeedReplyContext(binding.contextId)) throw new Error('Private evaluations cannot access OCR tools')
    return binding
  }
  return ctx.tools.register(defineTool({
    name: 'companion_ocr',
    description: 'Read text out of one real Companion media image or document (PNG/JPEG/WebP/PDF/DOCX/PPTX) with DeepSeek OCR. Pass a media id from the media library or an attachment; returns per-page text. Use it when the owner asks what a picture or document says.',
    parameters: {
      mediaId: { type: 'string', description: 'Real Companion media asset id to recognize.' },
      purpose: { type: 'string', description: 'text_recognition (default) or rich_layout_recognition for layout boxes.' },
    },
    output,
    async execute(args, exec) {
      authority(exec)
      if (!runtime.ocr?.configured()) throw new Error('OCR is not configured on this host')
      const asset = store.media.get(String(args.mediaId))
      if (!asset) throw new Error('No such media asset')
      const bytes = await readFile(asset.path)
      const purpose = args.purpose === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition'
      const result = await runtime.ocr.recognize(bytes, asset.path.split('/').pop() ?? 'file', purpose)
      return JSON.stringify(result)
    },
  }))
}