import type { TaskRecord } from '../core/model.ts'

export const MAX_SINGING_WAV_BYTES = 24 * 1024 * 1024
export const SONG_VOCAL_STEP_MS = 25
export const MAX_SONG_VOCAL_SAMPLES = 2600
export const SONG_VOCAL_ENVELOPE_HEADER = 'x-companion-vocal-envelope'
export const MIN_SINGING_SCORE_SECONDS = 4
export const MAX_SINGING_SCORE_SECONDS = 180
export const MAX_SINGING_SCORE_ROWS = 512

export type SingingCoverEngine = 'seed-vc' | 'applio-rvc'

export interface SingingInput {
  title: string
  lyrics: string
  style: string
  durationSeconds: number
}

export interface SingingScoreInput {
  title: string
  bpm: number
  notes: { midi: number | null; beats: number; lyric?: string }[]
}

export function scoreDurationSeconds({ bpm, notes }: Pick<SingingScoreInput, 'bpm' | 'notes'>): number {
  return notes.reduce((sum, note) => sum + note.beats, 0) * 60 / bpm
}

export interface SingingTaskView {
  task: TaskRecord
  audio?: { id: string; bytes: number; mimeType: 'audio/wav'; durationSeconds?: number }
  coverPhase?: 'synthesizing' | 'separating' | 'converting' | 'mixing' | 'archiving'
  scoreProgress?: { stage: 'converting'; completed: number; total: number }
  coverEngine?: SingingCoverEngine
}

export interface SingingView {
  available: boolean
  scoreAvailable?: boolean
  scoreMaxSeconds?: number
  coverAvailable?: boolean
  sourceCoverAvailable?: boolean
  coverEngine?: SingingCoverEngine
  tasks: SingingTaskView[]
}

export interface DeviceSingingTrack {
  id: string
  title: string
  createdAt: string
  bytes: number
  mimeType: 'audio/wav'
  durationSeconds?: number
}

export interface DeviceSingingArchive {
  version: 1
  items: DeviceSingingTrack[]
}
