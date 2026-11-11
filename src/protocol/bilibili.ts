export interface BilibiliReadInput {
  video: string
  part?: number
  subtitles?: boolean
}

export const MAX_BILIBILI_CLIP_SECONDS = 12
export const MAX_AUTONOMOUS_BILIBILI_CLIP_SECONDS = 8
export const AUTONOMOUS_BILIBILI_CLIP_INTERVAL_MS = 24 * 60 * 60_000
export const BILIBILI_CLIP_TOOL = 'companion_bilibili_clip'
export type BilibiliClipMode = 'visual' | 'audio' | 'both'
export interface BilibiliClipInput {
  bvid: string
  part: number
  start: number
  seconds: number
  mode: BilibiliClipMode
}

export const MAX_BILIBILI_SUBTITLE_BYTES = 256 * 1024
export type BilibiliSubtitleFormat = 'srt' | 'vtt'
export interface BilibiliSubtitleCue { from: number; to: number; text: string }
export interface BilibiliSubtitleProvenance { kind: 'owner-supplied'; sha256: string }

export interface BilibiliSubtitleExcerpt {
  status: 'excerpt'
  language: string
  cues: BilibiliSubtitleCue[]
  truncated: boolean
  provenance?: BilibiliSubtitleProvenance
}

export type BilibiliSubtitle = { status: 'not-requested' | 'unavailable' } | BilibiliSubtitleExcerpt

export interface BilibiliSubtitleDocument {
  bvid: string
  part: number
  cid: number
  format: BilibiliSubtitleFormat
  sha256: string
  cueCount: number
  excerptCueCount: number
  updatedAt: string
}

export interface BilibiliSubtitleUpload {
  video: string
  part?: number
  format: BilibiliSubtitleFormat
  content: string
}

export interface BilibiliReadResult {
  bvid: string
  url: string
  title: string
  owner: string
  description: string
  durationSeconds: number
  part: number
  parts: number
  partTitle: string
  partDurationSeconds: number
  subtitle: BilibiliSubtitle
  receipt: BilibiliReadReceipt
}

export interface BilibiliReadReceipt {
  activityId: number
  at: string
  kind: 'video.inspected' | 'video.subtitle-read' | 'video.clip-sampled'
  provenance?: BilibiliSubtitleProvenance
  clip?: { start: number; seconds: number; visual: boolean; audio: boolean }
}

export interface BilibiliQueueItem {
  id: string
  bvid: string
  part: number
  label?: string
  status: 'queued' | 'reading' | 'read' | 'skipped' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  receipt?: BilibiliReadReceipt
  error?: string
  sourceId?: string
  sourceTitle?: string
}

export interface BilibiliQueueView {
  items: BilibiliQueueItem[]
  nextDecisionAt?: string
  nextClipAt?: string
  sources?: BilibiliSource[]
  nextDiscoveryAt?: string
}

export interface BilibiliSourceInput {
  mid: string
  seasonId: string
  label?: string
}

export interface BilibiliSource extends BilibiliSourceInput {
  id: string
  createdAt: string
  updatedAt: string
  lastCheckedAt?: string
  status: 'waiting' | 'added' | 'unchanged' | 'unavailable'
  lastAdded?: number
  error?: string
}

export interface BilibiliDiscoveredVideo {
  bvid: string
  title: string
}
