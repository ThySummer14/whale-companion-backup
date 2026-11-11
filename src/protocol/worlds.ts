export type WorldHealth = 'unconfigured' | 'standby' | 'ready' | 'busy' | 'paused' | 'unavailable'

export interface WorldsView {
  version: 1
  items: { id: string; label: string; status: WorldHealth }[]
}
