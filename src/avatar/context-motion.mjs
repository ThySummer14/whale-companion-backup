const ACTIVITY_TTL_MS = 5000
const poses = {
  chatting: phase => ({ AngleY: 1.4, AngleZ: 1.4 + Math.sin(phase * 1.3), ParamEyeBallY: 0.1 }),
  minecraft: phase => ({
    AngleX: 6.5, AngleY: -2.5, AngleZ: -1.4,
    ParamEyeBallX: 0.22 + 0.06 * Math.sin(phase * 1.8), ParamEyeBallY: -0.12,
  }),
  browsing: phase => ({
    AngleX: -2.8, AngleY: -7, AngleZ: 2.5,
    ParamEyeBallX: -0.13, ParamEyeBallY: -0.28 + 0.045 * Math.sin(phase * 1.1),
  }),
  resting: phase => ({ AngleY: -3.6, AngleZ: 4.1 + 0.6 * Math.sin(phase * 0.7), ParamEyeBallY: -0.12 }),
  speaking: phase => ({ AngleY: 1.9, AngleZ: 1.2 * Math.sin(phase * 1.8) }),
  singing: phase => ({ AngleY: 1.4, AngleZ: 2.9 * Math.sin(phase * 1.05) }),
}

export class StageActivity {
  revision = 0
  activity = undefined
  expiresAt = 0

  clear() {
    this.revision++
    this.activity = undefined
    this.expiresAt = 0
  }

  receive(activity, startedAt, revision) {
    if (revision !== this.revision) return
    this.activity = typeof activity === 'string' && Object.hasOwn(poses, activity) ? activity : undefined
    this.expiresAt = startedAt + ACTIVITY_TTL_MS
  }

  current(now) {
    return now < this.expiresAt ? this.activity : undefined
  }
}

export function contextOffsets(activity, phase) {
  return Object.hasOwn(poses, activity) ? poses[activity](phase) : undefined
}

const headGestures = {
  nod: {
    AngleY: [[0, 0], [0.29, -9], [0.57, 2.5], [0.82, -4], [1.2, 0]],
    AngleZ: [[0, 0], [0.34, 1.8], [0.83, 0.8], [1.2, 0]],
  },
  shake: {
    AngleX: [[0, 0], [0.22, -10], [0.49, 10], [0.76, -7], [1.01, 4], [1.2, 0]],
    AngleZ: [[0, 0], [0.22, 2], [0.49, -2], [0.76, 1.4], [1.01, -0.8], [1.2, 0]],
  },
}

export function headGestureJob(taskId, action, parameters) {
  if (!Object.hasOwn(headGestures, action)) throw new Error('不支持此舞台动作')
  const duration = 1.2
  const tracks = Object.entries(headGestures[action]).map(([id, offsets]) => {
    const parameter = parameters.get(id)
    if (!parameter) throw new Error(`模型缺少动作参数 ${id}`)
    const points = offsets.map(([time, offset]) => [time, parameter.default + offset])
    return { id, action: 0, start: 0, duration, points }
  })
  return { id: taskId, compiled: { duration, steps: [{ kind: 'gesture' }], tracks } }
}
