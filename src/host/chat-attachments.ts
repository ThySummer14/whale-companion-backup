import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ChatAttachment } from '../protocol/chat.ts'
import { DeviceAuthError } from './devices.ts'

type AttachmentStore = Context['attachments']
type ImageInput = Parameters<AttachmentStore['saveImages']>[0][number]
type AttachmentBlock = Extract<UserMessage['content'][number], { type: 'image' | 'file' }>

export const MAX_CHAT_ATTACHMENTS = 4
export const MAX_CHAT_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_CHAT_ATTACHMENT_BASE64 = 4 * Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3)
export const MAX_CHAT_ATTACHMENT_BODY = MAX_CHAT_ATTACHMENT_BASE64 + 65_536

export interface ChatAttachmentInput {
  name: string
  dataBase64: string
}

function safeName(value: string): boolean {
  return value.length > 0 && value.length <= 180 && value !== '.' && value !== '..' && value.isWellFormed() &&
    !/[\\/\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(value)
}

function rasterType(data: Buffer): ImageInput['mediaType'] | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}

function admissionFailure(storage: AttachmentStore, error: unknown): never {
  if (!storage.isAttachmentError(error)) throw error
  if (['TOO_MANY_IMAGES', 'IMAGES_TOO_LARGE', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE'].includes(error.code)) {
    throw new DeviceAuthError(413, 'chat-attachments-too-large')
  }
  if (['INVALID_IMAGE_BASE64', 'INVALID_IMAGE', 'IMAGE_TYPE_MISMATCH', 'UNSUPPORTED_IMAGE_TYPE', 'INVALID_FILE_BASE64'].includes(error.code)) {
    throw new DeviceAuthError(400, 'invalid-chat-attachment')
  }
  throw new DeviceAuthError(503, 'chat-attachments-unavailable')
}

export async function admitChatAttachments(storage: AttachmentStore, input: readonly ChatAttachmentInput[], assertCurrent: () => void): Promise<AttachmentBlock[]> {
  if (input.length > MAX_CHAT_ATTACHMENTS) throw new DeviceAuthError(413, 'chat-attachments-too-large')
  let total = 0
  const decoded = input.map(({ name, dataBase64 }) => {
    if (!safeName(name) || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(dataBase64)) {
      throw new DeviceAuthError(400, 'invalid-chat-attachment')
    }
    const data = Buffer.from(dataBase64, 'base64')
    if (data.toString('base64') !== dataBase64 || !data.length) throw new DeviceAuthError(400, 'invalid-chat-attachment')
    total += data.length
    if (total > MAX_CHAT_ATTACHMENT_BYTES) throw new DeviceAuthError(413, 'chat-attachments-too-large')
    return { name, data, mediaType: rasterType(data) }
  })
  const images = decoded.flatMap(({ name, data, mediaType }) => mediaType ? [{ name, data, mediaType }] : [])
  const blocks: AttachmentBlock[] = []
  try {
    assertCurrent()
    const refs = images.length ? (await storage.saveImages(images))[Symbol.iterator]() : undefined
    for (const { name, data, mediaType } of decoded) {
      assertCurrent()
      if (mediaType) {
        const attachment = refs?.next().value
        if (!attachment) throw new DeviceAuthError(503, 'chat-attachments-unavailable')
        blocks.push({ type: 'image', attachment })
      } else {
        blocks.push({ type: 'file', attachment: await storage.saveFile({ name, data }) })
      }
    }
    return blocks
  } catch (error) {
    admissionFailure(storage, error)
  }
}

export function describeChatAttachment(block: AttachmentBlock): ChatAttachment {
  const { attachmentId, bytes, name } = block.attachment
  const mimeType = block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream'
  const defaultName = block.type === 'image' ? `image.${mimeType.split('/')[1]}` : 'attachment'
  return { id: String(attachmentId), bytes, name: name && safeName(name) ? name : defaultName, mimeType }
}

export function isChatAttachment(block: UserMessage['content'][number]): block is AttachmentBlock {
  return block.type === 'image' || block.type === 'file'
}

export async function readChatAttachment(storage: AttachmentStore, block: AttachmentBlock, signal: AbortSignal, maxBytes = MAX_CHAT_ATTACHMENT_BYTES): Promise<Uint8Array> {
  if (block.attachment.bytes > maxBytes) throw new DeviceAuthError(413, 'chat-attachments-too-large')
  try {
    if (block.type === 'image') {
      const { data } = await storage.readImage(block.attachment, signal)
      if (data.byteLength !== block.attachment.bytes) throw new DeviceAuthError(409, 'chat-attachment-corrupt')
      return data
    }
    const data = Buffer.alloc(block.attachment.bytes)
    let offset = 0
    for await (const chunk of storage.readFileStream(block.attachment, signal)) {
      if (chunk.byteLength > data.length - offset) throw new DeviceAuthError(409, 'chat-attachment-corrupt')
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (offset !== data.length) throw new DeviceAuthError(409, 'chat-attachment-corrupt')
    return data
  } catch (error) {
    signal.throwIfAborted()
    if (!storage.isAttachmentError(error)) throw error
    if (error.code === 'ATTACHMENT_NOT_FOUND') throw new DeviceAuthError(404, 'chat-attachment-not-found')
    if (error.code === 'ATTACHMENT_CORRUPT' || error.code === 'INVALID_ATTACHMENT_REF') throw new DeviceAuthError(409, 'chat-attachment-corrupt')
    throw new DeviceAuthError(503, 'chat-attachments-unavailable')
  }
}
