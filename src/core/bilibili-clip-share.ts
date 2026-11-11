import { z } from 'zod'
import type { BilibiliReadReceipt } from '../protocol/bilibili.ts'

export const BilibiliClipReaction = z.string().trim().min(6).max(100).regex(/^我[^\p{Cc}\p{Cf}]+$/u)
  .refine(text => text.isWellFormed() && !/(?:https?:|www\.|\/\/|@|BV[a-z0-9]{10}|\]\(|[看听]完了|看过整[部段期集])/iu.test(text))

export function repeatsBilibiliMaterial(text: string, materials: readonly string[]): boolean {
  const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const body = normalized(text)
  return materials.some(material => {
    const chars = Array.from(normalized(material))
    const length = Math.min(8, chars.length)
    return length >= 4 && chars.some((_, index) => index + length <= chars.length && body.includes(chars.slice(index, index + length).join('')))
  })
}

export function bilibiliClipSharePrefix(clip: NonNullable<BilibiliReadReceipt['clip']>): string {
  if (!clip.visual) return '我参考了一小段 B 站视频的声音转写。'
  return clip.audio ? '我抽样看了一小段 B 站视频，也参考了声音转写。' : '我抽样看了一小段 B 站视频的画面。'
}
