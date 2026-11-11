const MAX_AGE_MS = 1800
const ACTIVITIES = new Set(['offline', 'idle', 'resting', 'chatting', 'minecraft', 'speaking', 'singing', 'browsing'])
const ACTIONS = new Set(['blush', 'point', 'nod', 'shake'])

export class PresenterCues {
  sample = undefined

  receive(value, observedAt) {
    if (typeof value?.available !== 'boolean' || !Number.isFinite(observedAt)) {
      this.clear()
      return
    }
    const action = value.action
    const playable = action && ACTIONS.has(action.id) && Number.isSafeInteger(action.startedAt) && action.startedAt > 0 &&
      Number.isFinite(action.elapsedMs) && action.elapsedMs >= 0 && action.elapsedMs < 60_000
    const energy = value.voiceEnergy
    this.sample = {
      observedAt,
      available: value.available,
      activity: value.available && ACTIVITIES.has(value.activity) ? value.activity : undefined,
      voiceEnergy: value.available && Number.isFinite(energy) && energy > 0 && energy <= 1 ? energy : 0,
      action: value.available && playable ? { id: action.id, startedAt: action.startedAt, elapsedMs: action.elapsedMs } : undefined,
    }
  }

  clear() { this.sample = undefined }

  current(now) {
    const sample = this.sample
    if (!sample || now - sample.observedAt >= MAX_AGE_MS) return undefined
    const { available, activity, voiceEnergy, action } = sample
    return {
      available, activity, voiceEnergy,
      action: action && { ...action, elapsedMs: action.elapsedMs + Math.max(0, now - sample.observedAt) },
    }
  }
}

export function applyPresenterPose(engine, state, reduceMotion) {
  const energy = state?.voiceEnergy ?? 0
  engine.idle = !reduceMotion
  engine.homeActivity = reduceMotion ? undefined : state?.activity
  engine.speechReserved = energy > 0
  engine.speechPose = energy > 0 ? { values: { ParamMouthOpenY: energy, ParamMouthForm: energy * 0.35 } } : undefined
  if (engine.speechPose) {
    for (const id of Object.keys(engine.speechPose.values)) if (engine.params.has(id) && !engine.physicsOutputs.has(id)) engine.managed.add(id)
  }
}

export class PresenterAction {
  selection = undefined

  constructor(makeJob) { this.makeJob = makeJob }

  apply(engine, action) {
    const key = action && `${action.id}:${action.startedAt}`
    if (key !== this.selection?.key) {
      if (engine.job) engine.stop()
      this.selection = key ? { key } : undefined
      const selection = this.selection
      if (selection) {
        void Promise.resolve().then(() => this.makeJob(key, action.id, engine.params)).then(job => {
          if (this.selection === selection) selection.job = job
        }).catch(() => {})
      }
    }
    const selection = this.selection
    const job = selection?.job
    if (!job || !action) return
    const elapsed = action.elapsedMs / 1000
    if (elapsed >= job.compiled.duration) {
      if (engine.job) engine.stop()
      return
    }
    if (engine.job !== job) {
      try { engine.start(job) }
      catch { selection.job = undefined; return }
      engine.paused = true
    }
    // The main stage owns action time. Rendering here never creates a receipt.
    engine.elapsed = elapsed
  }
}
