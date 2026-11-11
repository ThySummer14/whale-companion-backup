import { surveyDiagram } from '../core/survey-diagram.ts'
import type { CommunityCampReceipt } from '../protocol/api.ts'

type Survey = Extract<CommunityCampReceipt, { kind: 'survey' }>
const CAMP = [72, 57] as const

export function CommunityRoute({ receipt }: { receipt: Survey }) {
  const diagram = surveyDiagram(receipt)
  if (!diagram) return null
  const points = diagram.points.map(([x, y]) => [CAMP[0] + x * 6, CAMP[1] + y * 6])
  const { reached } = diagram
  return <svg aria-hidden="true" width="128" height="100" viewBox="0 0 144 114" className="cp-community-route">
    <rect x="1" y="1" width="142" height="112" rx="8" fill="#f5f1e2" stroke="#d5cdb7" />
    <path d="M15 31V15m-4 5 4-5 4 5" stroke="#67766d" fill="none" strokeWidth="1.5" />
    <text x="22" y="23" fill="#526359" fontSize="10">N</text>
    <polyline points={points.map(point => point.join(',')).join(' ')} fill="none" stroke="#a59d83" strokeWidth="2" strokeDasharray="4 3" />
    {reached > 0 && <polyline data-verified-route points={points.slice(0, reached + 1).map(point => point.join(',')).join(' ')}
      fill="none" stroke="#367365" strokeWidth="3" strokeLinejoin="round" />}
    {points.slice(1).map(([x, y], index) => <circle key={`${x},${y}`} cx={x} cy={y} r="3.5" data-reached={index < reached}
      fill={index < reached ? '#367365' : '#f5f1e2'} stroke={index < reached ? '#367365' : '#a59d83'} strokeWidth="1.5" />)}
    <rect x={CAMP[0] - 4} y={CAMP[1] - 4} width="8" height="8" rx="2" fill="#705942" />
  </svg>
}
