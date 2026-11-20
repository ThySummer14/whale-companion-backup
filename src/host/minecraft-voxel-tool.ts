import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolArgsError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { describeChatAttachment, isChatAttachment, readChatAttachment } from './chat-attachments.ts'
import { DeviceAuthError } from './devices.ts'
import { MAX_VOXEL_PALETTE_BYTES, type VoxelBlueprintService } from './minecraft-voxel-blueprints.ts'

export const VOXEL_BLUEPRINT_TOOL = 'companion_minecraft_voxel_blueprint'
export type VoxelBlueprintPreparation = Pick<VoxelBlueprintService, 'prepare'>

const PREPARE_REQUEST = /转换|转成|转为|转进|导出|导入|做成|生成|放进|\bconvert\b|\bexport\b|\bimport\b/iu
const TARGET_REQUEST = /Minecraft|我的世界|Axiom|蓝图|图纸|\.schem\b/iu
const VOXEL_HANDEDNESS = /(?:深度(?:轴)?|前后).{0,12}(?:正\s*Z|不反转|不翻转)|depth[- ]as[- ]z/iu
const BlueprintName = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Bidi_Control}\u2028\u2029]+$/u)

export function voxelBlueprintRequest(message: UserMessage) {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (!PREPARE_REQUEST.test(text) || !TARGET_REQUEST.test(text)) return
  const files = message.content.filter(isChatAttachment)
  if (files.length < 1 || files.length > 2 || files.some(file => file.type !== 'file')) return
  const vox = files.find(file => /\.vox$/iu.test(describeChatAttachment(file).name))
  const palette = files.find(file => /\.json$/iu.test(describeChatAttachment(file).name))
  if (!vox || files.length !== (palette ? 2 : 1)) return
  return { vox, palette, depthAsZ: VOXEL_HANDEDNESS.test(text), messageId: String(message.id) }
}

export function createVoxelBlueprintTool(service: VoxelBlueprintPreparation, storage: Context['attachments'],
  request: NonNullable<ReturnType<typeof voxelBlueprintRequest>>, scope: { contextId: string; sessionId: string },
  begin: (exec: ToolRunContext) => { signal: AbortSignal; assertCurrent: () => void }) {
  return defineTool({
    name: VOXEL_BLUEPRINT_TOOL,
    description: 'Convert the single .vox file attached by the owner in this turn to an Axiom .schem and a preview in the paired app’s building approvals. An optional second JSON attachment supplies a color-to-block palette. The output is an unreviewed blueprint. The tool does not place blocks.',
    parameters: {
      name: { type: 'string', description: 'Optional short title for the blueprint. Defaults to the original filename.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => [{ type: 'text', text: value }] },
    async execute({ name }, exec) {
      const { signal, assertCurrent } = begin(exec)
      const source = describeChatAttachment(request.vox)
      const title = BlueprintName.safeParse(name ?? source.name.replace(/\.vox$/iu, '').slice(0, 80))
      if (!title.success) throw new ToolArgsError(['name: use a title of 1–80 characters without control characters.'])
      const [bytes, palette] = await Promise.all([
        readChatAttachment(storage, request.vox, signal),
        request.palette ? readChatAttachment(storage, request.palette, signal, MAX_VOXEL_PALETTE_BYTES) : undefined,
      ])
      assertCurrent()
      try {
        const blueprint = await service.prepare({ name: title.data, bytes, palette, depthAsZ: request.depthAsZ,
          source: { ...scope, messageId: request.messageId, attachmentId: source.id, filename: source.name,
            ...(request.palette && { paletteAttachmentId: describeChatAttachment(request.palette).id }) } }, signal, assertCurrent)
        assertCurrent()
        const { id, size, declared, sha256 } = blueprint
        return JSON.stringify({ status: 'prepared', id, name: blueprint.name, size, blocks: declared, sha256,
          next: '配对手机 → 活动 → 建筑审批，预览并确认蓝图，或保存 .schem 到 Axiom。' })
      } catch (error) {
        if (error instanceof DeviceAuthError) return JSON.stringify({ status: 'failed', code: error.code })
        throw error
      }
    },
  })
}
