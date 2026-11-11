import { sampleMotion } from './engine.mjs'
import { headGestureJob } from './context-motion.mjs'

async function readAction(basePath, path) {
  const response = await fetch(`${basePath}/model/${path}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`模型资源加载失败：${response.status}`)
  return response.json()
}

function expressionJob(taskId, data) {
  const duration = 2.4
  const weightPoints = [[0, 0], [0.25, 1], [1.9, 1], [duration, 0]]
  return { id: taskId, compiled: { duration, steps: [{ kind: 'expression' }], tracks: data.Parameters.map(parameter => ({ id: parameter.Id, action: 0, start: 0, duration, expression: { value: parameter.Value, blend: parameter.Blend, layer: 'exclusive', weightPoints } })) } }
}

function motionJob(taskId, data) {
  const duration = data.Meta.Duration
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 60) throw new Error('模型动作时长无效')
  const steps = Math.max(2, Math.ceil(duration * 30))
  return { id: taskId, compiled: { duration, steps: [{ kind: 'gesture' }], tracks: data.Curves.filter(curve => curve.Target === 'Parameter').map(curve => ({ id: curve.Id, action: 0, start: 0, duration, points: Array.from({ length: steps + 1 }, (_, index) => { const time = duration * index / steps; return [time, sampleMotion(curve.Segments, time)] }) })) } }
}

export async function makeActionJob(taskId, action, parameters, basePath = '') {
  if (action === 'blush') return expressionJob(taskId, await readAction(basePath, 'Exp3/脸红.exp3.json'))
  if (action === 'point') return motionJob(taskId, await readAction(basePath, 'Animation/竖手指切出来动画.motion3.json'))
  return headGestureJob(taskId, action, parameters)
}
