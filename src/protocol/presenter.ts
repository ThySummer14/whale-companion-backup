import type { AvatarAction } from '../core/model.ts'
import type { HomeView } from './api.ts'

export interface PresenterSnapshot {
  available: boolean
  activity?: HomeView['activity']
  voiceEnergy?: number
  action?: { id: AvatarAction['id']; startedAt: number; elapsedMs: number }
}

export interface PresenterView {
  running: boolean
  obsUrl?: string
  desktopUrl?: string
}
