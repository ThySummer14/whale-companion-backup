import { useEffect, useId, useState, type CSSProperties } from 'react'
import { SURVEY_DISTANCE, SURVEY_MAX_DISTANCE, SURVEY_TRAIL_IDS, SURVEY_TRAIL_LEG, type CommunityCampReceipt, type CommunitySite, type CommunityView } from '../protocol/api.ts'
import { CommunityRoute } from './community-route.tsx'

type CommunityDestination = 'home' | 'avatar' | 'singing' | 'bilibili' | 'feed' | 'minecraft'
type Roof = 'gable' | 'terrace' | 'hip'

interface SiteRecipe {
  label: string
  description: string
  entrance: readonly [number, number]
  width: number
  depth: number
  floors: 1 | 2
  roof: Roof
  columns: number
  colors: { wall: string; trim: string; roof: string; shade: string; sign: string }
  links: readonly { label: string; destination: CommunityDestination }[]
}

const WIDTH = 720
const EXTENDED_WIDTH = 940
const HEIGHT = 266
const STREET_Y = 228
const MAX_STATE_AGE_MS = 15_000
const SITE_IDS: readonly CommunitySite[] = ['home', 'studio', 'library']
const EXTENDED_SITE_IDS: readonly CommunitySite[] = [...SITE_IDS, 'camp']
const SITES: Record<CommunitySite, SiteRecipe> = {
  home: {
    label: '大肥鱼小屋', description: '床边、窗边、沙发和电脑桌都在这里。回到室内可查看大肥鱼此刻的位置。',
    entrance: [125, 151], width: 124, depth: 42, floors: 1, roof: 'gable', columns: 3,
    colors: { wall: '#ecd2ac', trim: '#fff0d1', roof: '#c38068', shade: '#995a55', sign: '#905450' },
    links: [{ label: '回到小屋室内', destination: 'home' }],
  },
  studio: {
    label: '声演工坊', description: '这里通向形象舞台和歌唱工作台，可以看 Live2D，或从归档挑一首歌。',
    entrance: [355, 144], width: 158, depth: 49, floors: 2, roof: 'terrace', columns: 4,
    colors: { wall: '#d5c8dc', trim: '#f6e8f5', roof: '#9e88aa', shade: '#716383', sign: '#68567b' },
    links: [{ label: '打开 Live2D 舞台', destination: 'avatar' }, { label: '打开歌唱工作台', destination: 'singing' }],
  },
  library: {
    label: '社区阅览室', description: '从这里可以打开大肥鱼的 B 站阅读页，或去动态墙看她和你的留言。',
    entrance: [591, 163], width: 138, depth: 42, floors: 2, roof: 'hip', columns: 3,
    colors: { wall: '#c9d9ba', trim: '#f4efd0', roof: '#719982', shade: '#557861', sign: '#4e725e' },
    links: [{ label: '打开 B 站阅读', destination: 'bilibili' }, { label: '打开动态墙', destination: 'feed' }],
  },
  camp: {
    label: '营地联络站', description: '查看游戏回执确认的营地行动，或打开 Minecraft 工作台。',
    entrance: [814, 154], width: 132, depth: 47, floors: 1, roof: 'gable', columns: 3,
    colors: { wall: '#dec795', trim: '#f4e4c7', roof: '#8c9c81', shade: '#667960', sign: '#526b56' },
    links: [{ label: '打开 Minecraft', destination: 'minecraft' }],
  },
}

function dimensions(site: SiteRecipe) {
  const [x, front] = site.entrance
  const left = x - site.width / 2
  const right = x + site.width / 2
  const wallTop = front - 16 * site.floors - 12
  return { x, front, left, right, wallTop, roofBack: wallTop - site.depth }
}

function Building({ site }: { site: SiteRecipe }) {
  const { x, front, left, right, wallTop, roofBack } = dimensions(site)
  const { colors, width, floors, columns } = site
  const flat = site.roof === 'terrace'
  const hip = site.roof === 'hip'
  const ridgeInset = hip ? 17 : 0
  const ridgeY = wallTop - Math.round(site.depth * .56)
  const roofLeft = left - 7
  const roofRight = right + 7

  return <g>
    <rect x={left - 13} y={front - 22} width={width + 32} height={35} fill="#879b77" opacity=".36" />
    <rect x={left - 10} y={front - 20} width={width + 20} height={30} fill="#e9d9ae" />
    <rect x={left - 3} y={front - 3} width={width + 6} height={6} fill={colors.shade} />
    <rect x={left} y={wallTop} width={width} height={front - wallTop} fill={colors.wall} />
    <rect x={left} y={wallTop} width={width} height={7} fill={colors.shade} opacity=".25" />
    <rect x={left} y={wallTop} width={5} height={front - wallTop} fill={colors.trim} />
    <rect x={right - 5} y={wallTop} width={5} height={front - wallTop} fill={colors.trim} />
    {Array.from({ length: floors }, (_, floor) => Array.from({ length: columns }, (_, column) => {
      const windowX = Math.round(left + (column + .5) * width / columns)
      const windowY = wallTop + 10 + floor * 15
      if (floor === floors - 1 && Math.abs(windowX - x) < 13) return null
      return <g key={`${floor}-${column}`}>
        <rect x={windowX - 8} y={windowY - 2} width={16} height={12} fill={colors.trim} />
        <rect x={windowX - 6} y={windowY} width={12} height={8} fill="#5e7379" />
        <rect x={windowX - 5} y={windowY + 1} width={5} height={4} fill="#b9d0be" />
        <path d={`M${windowX} ${windowY}v8`} stroke={colors.trim} />
      </g>
    }))}
    <rect x={x - 12} y={front - 22} width={24} height={22} fill={colors.trim} />
    <rect x={x - 9} y={front - 20} width={18} height={20} fill={colors.sign} />
    <rect x={x - 6} y={front - 17} width={12} height={7} fill="#bbcfb9" />
    <rect x={x + 5} y={front - 7} width={2} height={2} fill={colors.trim} />
    <rect x={x - 14} y={front} width={28} height={4} fill={colors.shade} />

    <rect x={roofLeft} y={roofBack} width={width + 14} height={site.depth + 4} fill={colors.shade} />
    {flat ? <g>
      <rect x={roofLeft + 5} y={roofBack + 5} width={width + 4} height={site.depth - 8} fill={colors.roof} />
      <rect x={roofLeft + 11} y={roofBack + 11} width={width - 8} height={site.depth - 19} fill={colors.shade} opacity=".48" />
      <rect x={x - 24} y={roofBack + 15} width={48} height={21} fill={colors.trim} />
      <path d={`M${x - 17} ${roofBack + 29}h4v-5h5v8h5v-12h5v9h5v-6h5v6h4`} fill="none" stroke={colors.sign} strokeWidth="2" />
    </g> : <g>
      <polygon points={`${roofLeft},${roofBack + 2} ${roofRight},${roofBack + 2} ${roofRight - ridgeInset},${ridgeY} ${roofLeft + ridgeInset},${ridgeY}`} fill={colors.roof} />
      <polygon points={`${roofLeft + ridgeInset},${ridgeY} ${roofRight - ridgeInset},${ridgeY} ${roofRight},${wallTop} ${roofLeft},${wallTop}`} fill={colors.roof} opacity=".75" />
      <path d={`M${roofLeft + ridgeInset} ${ridgeY}H${roofRight - ridgeInset} M${roofLeft + 10} ${wallTop - 8}H${roofRight - 10} M${roofLeft + 5} ${wallTop - 3}H${roofRight - 5}`} fill="none" stroke={colors.trim} opacity=".37" strokeWidth="2" />
    </g>}
    <rect x={roofLeft} y={wallTop} width={width + 14} height={4} fill={colors.sign} />
  </g>
}

const TREE_POSITIONS: readonly (readonly [number, number])[] = [[34, 49], [69, 41], [230, 79], [245, 105], [479, 49], [510, 56], [678, 65], [690, 106], [35, 191], [199, 202], [283, 200], [426, 197], [517, 197], [681, 189]]

function MapArtwork({ siteIds, width }: { siteIds: readonly CommunitySite[]; width: number }) {
  const trees = width === WIDTH ? TREE_POSITIONS : [...TREE_POSITIONS, [740, 169], [904, 58], [897, 191]] as const
  return <svg viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true" className="cp-community-art" shapeRendering="crispEdges">
    <rect width={width} height={HEIGHT} fill="#c2d1a8" />
    <path d={`M0 29H${width}M0 254H${width}`} fill="none" stroke="#b0c396" strokeWidth="3" />
    <path d={`M0 ${STREET_Y}H${width}`} fill="none" stroke="#ad9572" strokeWidth="22" />
    <path d={`M0 ${STREET_Y}H${width}`} fill="none" stroke="#deca9f" strokeWidth="17" />
    {siteIds.map(id => {
      const [x, front] = SITES[id].entrance
      return <path key={id} d={`M${x} ${front}V${STREET_Y}`} fill="none" stroke="#deca9f" strokeWidth="13" />
    })}
    {Array.from({ length: Math.floor(width / 30) }, (_, index) => <rect key={index} x={8 + index * 30} y={STREET_Y - 4 + index % 3 * 3} width={index % 2 ? 8 : 12} height="2" fill="#baa881" />)}
    {trees.map(([x, y], index) => <g key={x} transform={`translate(${x} ${y})`}>
      <rect x="-10" y="9" width="23" height="5" fill="#91a77d" />
      <rect x="-3" y="4" width="6" height="10" fill="#937756" />
      <path d="M-11 6V-6h4v-5H7v5h4V6H7v4H-7V6Z" fill={index % 3 === 0 ? '#6f8d70' : '#7f9f73'} />
      <path d="M-8 0v-5h4v-3H5v3H2v5Z" fill="#a1ba83" />
    </g>)}
    <path d="M72 194h4m-2-2v4m116-24h4m-2-2v4m56 13h4m-2-2v4m203-22h4m-2-2v4m196 3h4m-2-2v4" fill="none" stroke="#f1e6b7" strokeWidth="2" />
    {siteIds.map(id => <Building key={id} site={SITES[id]} />)}
  </svg>
}

function buttonPosition(site: SiteRecipe, width: number): CSSProperties {
  const { left, front, roofBack } = dimensions(site)
  return {
    left: `${(left - 10) / width * 100}%`,
    top: `${(roofBack - 4) / HEIGHT * 100}%`,
    width: `${(site.width + 20) / width * 100}%`,
    height: `${(front - roofBack + 26) / HEIGHT * 100}%`,
  }
}

const STYLES = `
.cp-community h2{margin:0}.cp-community p{margin:4px 0 0}
.cp-community-map{position:relative;margin:12px 0;border-radius:10px;overflow:hidden;border:1px solid var(--cp-line);background:#c2d1a8}
.cp-community-art{display:block;width:100%;height:auto}
.cp-community-place{position:absolute;display:flex;align-items:flex-end;justify-content:center;min-width:44px;min-height:44px;border:0;border-radius:6px;padding:0;background:none;color:#263d32;font:inherit;font-weight:700;cursor:pointer}
.cp-community-place span{display:block;flex:none;padding:1px 3px;border-radius:4px;background:#f7ecd0;font-size:clamp(9px,1.9vw,13px);line-height:1.35;white-space:nowrap;box-shadow:0 1px 1px #55684f30}
.cp-community-place[aria-pressed=true] span{background:#344e41;color:#fff6df}
.cp-community-place[data-current=true] span{outline:2px solid #245745;outline-offset:2px}
.cp-community-place[data-current=true] span::before{content:'';display:inline-block;width:5px;height:5px;margin:0 3px 2px 1px;border-radius:50%;background:currentColor}
.cp-community-place:hover span{text-decoration:underline;text-underline-offset:2px}
.cp-community-place:focus-visible{outline:2px solid #263d32;outline-offset:2px}
.cp-community-detail{display:flex;gap:8px 16px;justify-content:space-between;align-items:center;flex-wrap:wrap}
.cp-community-links{display:flex;gap:6px;flex-wrap:wrap}
.cp-community-live{font-size:12px;color:var(--cp-muted)}
.cp-community-live[data-current=true]{color:#397560;font-weight:650}
.cp-community-diary{border-top:1px solid var(--cp-line);padding-top:12px;margin-top:13px}
.cp-community-diary ul{list-style:none;padding:0;margin:7px 0 0}
.cp-community-diary li{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;padding:8px 0}
.cp-community-diary li+li{border-top:1px solid var(--cp-line)}
.cp-community-diary time{color:var(--cp-muted);font-size:12px;white-space:nowrap}
`

const DIRECTIONS = { north: '北', east: '东', south: '南', west: '西' } as const
const CAMP_LABELS = { supply: '营地补给完成', build: '营地搭建完成', prepare: '营地备料与搭建完成' } as const
const campTime = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

function isDirection(value: string): value is keyof typeof DIRECTIONS {
  return Object.hasOwn(DIRECTIONS, value)
}

function isCampReceipt(receipt: CommunityCampReceipt): boolean {
  if (!receipt || typeof receipt.at !== 'string' || !Number.isFinite(Date.parse(receipt.at))) return false
  if (receipt.kind !== 'survey') return Object.hasOwn(CAMP_LABELS, receipt.kind)
  const { route, outcome } = receipt
  if (!route || (outcome !== 'completed' && outcome !== 'recovered')) return false
  if (route.kind === 'straight') return isDirection(route.direction) && Number.isInteger(route.steps) && route.steps >= SURVEY_DISTANCE && route.steps <= SURVEY_MAX_DISTANCE
  return route.kind === 'trail' && SURVEY_TRAIL_IDS.includes(route.trail) && (outcome === 'completed' ? route.checkpoints === 2 : route.checkpoints === 0 || route.checkpoints === 1)
}

function CampReceipt({ receipt }: { receipt: CommunityCampReceipt }) {
  let title: string
  let detail: string | undefined
  if (receipt.kind !== 'survey') title = CAMP_LABELS[receipt.kind]
  else {
    const { route, outcome } = receipt
    title = outcome === 'completed' ? '营地勘察完成' : '地形变化后安全回营'
    if (route.kind === 'straight') {
      const segment = `向${DIRECTIONS[route.direction]}步行 ${route.steps} 格`
      detail = outcome === 'completed' ? `${segment}后沿原路回营。` : `原计划${segment}，途中提前折返。`
    } else {
      const [first, second] = route.trail.split('-') as [keyof typeof DIRECTIONS, keyof typeof DIRECTIONS]
      const directions = `先向${DIRECTIONS[first]}、再向${DIRECTIONS[second]}`
      detail = outcome === 'completed' ? `${directions}，每段 ${SURVEY_TRAIL_LEG} 格，确认两个检查点后原路回营。`
        : `计划${directions}，确认 ${route.checkpoints} 个检查点后提前折返。`
    }
  }
  return <li>
    <div><strong>{title}</strong>{detail && <p className="cp-hint">{detail}</p>}</div>
    {receipt.kind === 'survey' && <CommunityRoute receipt={receipt} />}
    <time dateTime={receipt.at}>{campTime.format(new Date(receipt.at))}</time>
  </li>
}

export function CommunityMap({ community, receivedAt, readFailed, onOpen }: {
  community?: CommunityView
  receivedAt?: number
  readFailed?: boolean
  onOpen: (destination: CommunityDestination) => void
}) {
  const [selected, setSelected] = useState<CommunitySite>('home')
  const [expiredAt, setExpiredAt] = useState<number>()
  const heading = useId()
  const inspection = useId()
  const projection = community?.version === 1 ? community : undefined
  const siteIds = projection ? EXTENDED_SITE_IDS : SITE_IDS
  const width = projection ? EXTENDED_WIDTH : WIDTH
  const selection = siteIds.includes(selected) ? selected : 'home'
  const site = SITES[selection]
  useEffect(() => {
    if (receivedAt === undefined) return
    const remaining = MAX_STATE_AGE_MS - (Date.now() - receivedAt)
    const timer = setTimeout(() => setExpiredAt(receivedAt), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [receivedAt])
  const stale = readFailed || receivedAt === undefined || expiredAt === receivedAt || Date.now() - receivedAt >= MAX_STATE_AGE_MS
  const current = !stale && projection?.activeSite && siteIds.includes(projection.activeSite) ? projection.activeSite : undefined
  const receipts = Array.isArray(projection?.recentCamp) ? projection.recentCamp.filter(isCampReceipt).slice(0, 4) : []

  return <section className="cp-card cp-community" aria-labelledby={heading}>
    <style>{STYLES}</style>
    <div className="cp-row cp-between">
      <h2 id={heading}>小家街区</h2>
      {projection && <span className="cp-community-live" role="status" data-current={!!current}>
        {current ? `当前活动 · ${SITES[current].label}` : stale ? '实时活动等待同步' : '暂无在线活动'}
      </span>}
    </div>
    <p className="cp-hint">选择一座建筑，查看用途和可打开的页面。</p>
    <div className="cp-community-map" role="group" aria-label="查看街区建筑">
      <MapArtwork siteIds={siteIds} width={width} />
      {siteIds.map(id => <button key={id} className="cp-community-place" type="button" style={buttonPosition(SITES[id], width)} aria-pressed={selection === id}
        aria-controls={inspection} data-current={current === id} onClick={() => setSelected(id)}>
        <span>{SITES[id].label}</span>
      </button>)}
    </div>
    <div className="cp-community-detail" id={inspection}>
      <div role="status"><h3>{site.label}</h3><p className="cp-hint">{site.description}</p></div>
      <div className="cp-community-links">
        {site.links.map(link => <button key={link.destination} className="cp-button" type="button" onClick={() => onOpen(link.destination)}>{link.label}</button>)}
      </div>
    </div>
    {selection === 'camp' && <section className="cp-community-diary" aria-label="营地经历">
      <h3>{stale ? '上次同步的营地经历' : '已确认的营地经历'}</h3>
      {receipts.length ? <ul>{receipts.map((receipt, index) => <CampReceipt key={`${receipt.kind}-${receipt.at}-${index}`} receipt={receipt} />)}</ul>
        : <p className="cp-hint">暂时没有已确认的营地经历。</p>}
    </section>}
  </section>
}
