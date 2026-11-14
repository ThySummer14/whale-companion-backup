import type { z } from 'zod'
import type { HouseRecoveryAgentDecision } from '../core/minecraft-recovery.ts'

type Decision = z.infer<typeof HouseRecoveryAgentDecision>

const OBSERVATION: Record<NonNullable<Decision['observed']>, string> = {
  ready: '本次现场复查通过',
  blocked: '本次现场复查发现施工条件尚未满足',
  unavailable: '本次现场复查暂时无法完成',
}
const MATERIALS: Record<NonNullable<Decision['placed']>['material'], string> = {
  oak_planks: '橡木木板', spruce_planks: '云杉木板', cobblestone: '圆石', glass: '玻璃', cherry_planks: '樱花木板', pink_concrete: '粉色混凝土', smooth_sandstone: '平滑砂岩', dark_oak_planks: '深色橡木木板', lantern: '灯笼', cherry_leaves: '樱花树叶',
}

export function MinecraftRecoveryOutcome({ decision }: { decision: Decision }) {
  const { placed, placements, verification } = decision
  return <div style={{ overflowWrap: 'anywhere' }}>
    {decision.observed && <p className="cp-hint">{OBSERVATION[decision.observed]}</p>}
    {placements?.length ? <>
      <p><strong>已实际放置 {placements.length} 块蓝图方块</strong>。{!verification && '小屋仍待核验完工。'}</p>
      <ul aria-label="已核验的蓝图格">{placements.map(({ index, material }) => <li key={index}>蓝图第 {index + 1} 格 · {MATERIALS[material]}</li>)}</ul>
    </> : placed && <p><strong>已实际放置一块{MATERIALS[placed.material]}</strong>，蓝图第 {placed.index + 1} 格。小屋仍待核验完工。</p>}
    {verification?.outcome === 'completed' && <p><strong>整栋小屋已核验完工</strong>，{verification.verification.checked} 格与蓝图相符。</p>}
    {verification?.outcome === 'incomplete' && <p className="cp-hint">最近一次整体验收核对 {verification.verification.checked} 格，
      其中 {verification.verification.missing} 格待放、{verification.verification.blocked} 格受阻。</p>}
    {decision.plan && <p><strong>大肥鱼记录的计划</strong> {decision.plan}</p>}
  </div>
}
