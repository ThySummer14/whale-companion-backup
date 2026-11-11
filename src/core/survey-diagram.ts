import { SURVEY_DISTANCE, SURVEY_MAX_DISTANCE, SURVEY_TRAIL_IDS, SURVEY_TRAIL_LEG, type CommunityCampReceipt } from '../protocol/api.ts'

type Survey = Extract<CommunityCampReceipt, { kind: 'survey' }>
type Direction = Extract<Survey['route'], { kind: 'straight' }>['direction']
export type SurveyPoint = readonly [number, number]

const VECTORS: Record<Direction, SurveyPoint> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }

function forward([x, y]: SurveyPoint, direction: Direction, steps: number): SurveyPoint {
  const [dx, dy] = VECTORS[direction]
  return [x + dx * steps, y + dy * steps]
}

export function surveyDiagram(receipt: Survey): { points: SurveyPoint[]; reached: number } | undefined {
  if (receipt?.kind !== 'survey' || (receipt.outcome !== 'completed' && receipt.outcome !== 'recovered')) return
  const { route, outcome } = receipt
  const camp: SurveyPoint = [0, 0]
  if (route?.kind === 'straight') {
    if (typeof route.direction !== 'string' || !Object.hasOwn(VECTORS, route.direction) ||
      !Number.isInteger(route.steps) || route.steps < SURVEY_DISTANCE || route.steps > SURVEY_MAX_DISTANCE) return
    return { points: [camp, forward(camp, route.direction, route.steps)], reached: outcome === 'completed' ? 1 : 0 }
  }
  if (route?.kind !== 'trail' || !SURVEY_TRAIL_IDS.includes(route.trail) || (outcome === 'completed'
    ? route.checkpoints !== 2
    : route.checkpoints !== 0 && route.checkpoints !== 1)) return

  const [first, second] = route.trail.split('-') as [Direction, Direction]
  const junction = forward(camp, first, SURVEY_TRAIL_LEG)
  return { points: [camp, junction, forward(junction, second, SURVEY_TRAIL_LEG)], reached: route.checkpoints }
}
