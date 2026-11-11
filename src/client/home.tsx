import { useEffect, useId, useState, type Ref } from 'react'
import { HOME_JOURNAL_REVISION_MS, type HomeView } from '../protocol/api.ts'

const MAX_STATE_AGE_MS = 15_000

const ACTIVITIES = {
  offline: { label: '离线', detail: '暂时没有在线活动。', anchor: 'none' },
  idle: { label: '窗边闲坐', detail: '现在没有检测到正在进行的活动。', anchor: 'window' },
  resting: { label: '安静时段', detail: '按当前节律设定，她在房间里休息。', anchor: 'bed' },
  chatting: { label: '沙发上聊天', detail: '她正在处理一段对话。', anchor: 'sofa' },
  minecraft: { label: '在电脑前玩 Minecraft', detail: '游戏 Worker 报告动作正在执行。', anchor: 'desk' },
  speaking: { label: '在舞台上说话', detail: 'Live2D 舞台正在播放她的语音。', anchor: 'stage' },
  browsing: { label: '在阅读角读 B 站', detail: '正在读取公开视频资料或字幕。', anchor: 'phone' },
  singing: { label: '在舞台唱歌', detail: 'Live2D 舞台正在播放已归档歌曲。', anchor: 'stage' },
} as const satisfies Record<HomeView['activity'], { label: string; detail: string; anchor: HomeView['anchor'] }>

const REFLECTING = {
  label: '在书桌前写自我笔记', detail: '她正在复盘已发生的经历。', anchor: 'desk',
} as const

const EVENT_LABELS = {
  chat: '完成一次对话回复',
  gather: '完成采集',
  craft: '完成合成',
  build: '完成搭建',
  return: '完成回程',
  post: '发布一条动态',
  reply: '回复一条动态',
  video: 'B 站浏览记录',
  song: '完成一次舞台歌唱播放',
} as const satisfies Record<HomeView['recent'][number]['kind'], string>

function HomeEventLabel({ event }: { event: HomeView['recent'][number] }) {
  const video = event.kind === 'video' ? event.video : undefined
  if (!video) return <span>{EVENT_LABELS[event.kind]}</span>
  const label = video.mode === 'clip' ? '看过一段 B 站视频' : '读取了 B 站字幕摘录'
  const source = video.source
  if (!source) return <span>{label}</span>
  const url = new URL(`https://www.bilibili.com/video/${encodeURIComponent(source.bvid)}/`)
  url.searchParams.set('p', String(source.part))
  if (video.mode === 'clip' && video.source) url.searchParams.set('t', String(video.source.startSeconds))
  return <a href={url.href} target="_blank" rel="noreferrer">{label} · 第 {source.part} P</a>
}

export type RoomDestination = 'scenes' | 'minecraft' | 'avatar' | 'bilibili' | 'autonomy'
type RoomAnchor = Exclude<HomeView['anchor'], 'none'>
const ROOM_SPOTS: Record<RoomAnchor, {
  label: string; x: number; y: number; labelX: number; labelY: number; detail: string
  shortcut?: { destination: RoomDestination; label: string }
}> = {
  window: { label: '窗边', x: 311, y: 116, labelX: 311, labelY: 57, detail: '空闲时，她会待在窗边。' },
  bed: { label: '床边', x: 165, y: 178, labelX: 112, labelY: 117, detail: '进入安静时段且没有正在进行的活动时，小家会显示她在床边休息。', shortcut: { destination: 'autonomy', label: '查看自主节律' } },
  sofa: { label: '沙发', x: 214, y: 257, labelX: 128, labelY: 257, detail: '处理已绑定场景中的对话时，小家会显示她在沙发上。', shortcut: { destination: 'scenes', label: '打开聊天场景' } },
  desk: { label: '电脑桌', x: 511, y: 161, labelX: 511, labelY: 103, detail: 'Minecraft Worker 报告正在执行游戏动作时，小家会点亮电脑桌。', shortcut: { destination: 'minecraft', label: '打开 Minecraft' } },
  stage: { label: '小舞台', x: 502, y: 259, labelX: 502, labelY: 309, detail: '舞台回报正在播放语音或歌曲时，小家会显示她在这里。', shortcut: { destination: 'avatar', label: '打开 Live2D 舞台' } },
  phone: { label: '阅读角', x: 371, y: 173, labelX: 392, labelY: 196, detail: '读取 B 站公开视频资料和字幕时，小家会显示她在阅读角。', shortcut: { destination: 'bilibili', label: '打开 B 站浏览' } },
}
const ROOM_ANCHORS = Object.keys(ROOM_SPOTS) as RoomAnchor[]

const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

function isKey<T extends object>(record: T, value: unknown): value is keyof T {
  return typeof value === 'string' && Object.hasOwn(record, value)
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function HomeRoom({ anchor, tone, reflecting }: { anchor: HomeView['anchor']; tone: 'day' | 'night' | 'quiet'; reflecting: boolean }) {
  const spot = anchor === 'none' ? undefined : ROOM_SPOTS[anchor]
  return <svg className="cp-home-scene" viewBox="0 0 620 360" data-tone={tone} aria-hidden="true">
    <rect width="620" height="360" fill="#e5ddcb" />
    <rect x="20" y="23" width="580" height="315" rx="19" fill="#987461" />
    <rect x="29" y="36" width="562" height="293" rx="11" fill="#eacaa5" />
    <g className="cp-home-floor" fill="none" stroke="#b37e62" opacity=".23">
      <path d="M30 68H590M30 103H590M30 138H590M30 173H590M30 208H590M30 243H590M30 278H590M30 313H590" />
      <path d="M101 37v31m91 0v35m-91 0v35m91 0v35m-91 0v35m91 0v35m-91 0v35m91 0v35M285 37v31m91 0v35m-91 0v35m91 0v35m-91 0v35m91 0v35m-91 0v35m91 0v35M469 37v31m91 0v35m-91 0v35m91 0v35m-91 0v35m91 0v35m-91 0v35m91 0v35" />
    </g>

    {/* Window and window seat. */}
    <rect x="238" y="26" width="146" height="64" rx="9" fill="#b18868" />
    <rect className="cp-home-sky" x="245" y="32" width="132" height="52" rx="5" fill="#9bc0bf" />
    <path d="M246 69h19v-9h20v6h18v18h-57Zm69 0h27v-7h21v7h14v15h-62Z" fill="#d9e0b6" opacity=".75" />
    <path d="M311 32v52m-66-23h132" fill="none" stroke="#fcf1dc" strokeWidth="4" />
    <rect x="232" y="82" width="158" height="8" rx="4" fill="#765746" />
    <rect x="267" y="100" width="88" height="34" rx="15" fill="#f6e4c5" />

    {/* Bed and bedside lamp. */}
    <rect x="55" y="74" width="122" height="90" rx="10" fill="#986f5b" />
    <rect x="62" y="78" width="109" height="79" rx="9" fill="#fbecd5" />
    <rect x="70" y="85" width="42" height="20" rx="6" fill="#fffbeb" />
    <rect x="121" y="85" width="42" height="20" rx="6" fill="#fffbeb" />
    <path d="M62 111h109v38a8 8 0 0 1-8 8H70a8 8 0 0 1-8-8Z" fill="#a8aa85" />
    <path d="M62 121h109m-91 0v36m16-36v36m16-36v36m16-36v36m16-36v36m16-36v36" fill="none" stroke="#d8d8b2" strokeWidth="2" />
    <rect x="185" y="77" width="31" height="33" rx="6" fill="#aa8063" />
    <circle className="cp-home-lamp" cx="201" cy="91" r="10" fill="#f7d17e" />

    {/* Desk, monitor, and chair. */}
    <rect x="448" y="72" width="123" height="63" rx="10" fill="#9d755e" />
    <rect x="455" y="77" width="110" height="49" rx="6" fill="#c19b76" />
    <rect x="475" y="80" width="70" height="29" rx="4" fill="#554f55" />
    <rect className="cp-home-monitor" x="479" y="84" width="62" height="20" rx="2" fill="#85a09c" data-active={anchor === 'desk' && !reflecting} />
    <rect x="490" y="113" width="40" height="6" rx="2" fill="#f2dfc3" />
    {reflecting && <g className="cp-home-notebook" fill="none" stroke="#725048" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M485 111q13-5 26 1 13-6 26-1v18q-13-5-26 1-13-6-26-1Z" fill="#f9eed6" />
      <path d="M511 112v18m-20-14 15 1m-15 4 15 1m10-5 15-1m-15 6 15-1" />
    </g>}
    <rect x="489" y="140" width="44" height="34" rx="12" fill="#8c8f80" />

    {/* Reading cushion and phone on its side table. */}
    <ellipse cx="380" cy="176" rx="43" ry="27" fill="#d4aa8d" />
    <rect x="348" y="153" width="42" height="40" rx="12" fill="#a3a98a" />
    <rect x="352" y="158" width="34" height="30" rx="10" fill="#d9d3a9" />
    <circle cx="404" cy="174" r="15" fill="#ad816a" />
    <rect x="398" y="163" width="12" height="19" rx="3" fill="#4e4d63" />
    <rect x="400" y="165" width="8" height="14" rx="1" fill={anchor === 'phone' ? '#b5e8d9' : '#8da6a3'} />

    {/* Sofa and its rug. */}
    <rect x="50" y="208" width="166" height="99" rx="31" fill="#f4ddbc" />
    <path d="M69 221h128m-128 73h128" fill="none" stroke="#cbac88" strokeWidth="2" strokeDasharray="3 5" />
    <rect x="64" y="228" width="126" height="60" rx="14" fill="#ac6c66" />
    <rect x="77" y="238" width="47" height="41" rx="7" fill="#d99483" />
    <rect x="130" y="238" width="47" height="41" rx="7" fill="#d99483" />
    <rect x="82" y="241" width="21" height="15" rx="4" fill="#f0b99e" />

    {/* Small stage, speakers, and mic stand. */}
    <rect x="424" y="217" width="156" height="86" rx="20" fill="#94758b" />
    <rect x="430" y="223" width="144" height="71" rx="15" fill="#bea1aa" />
    <rect x="440" y="232" width="21" height="34" rx="4" fill="#574a59" />
    <rect x="543" y="232" width="21" height="34" rx="4" fill="#574a59" />
    <circle cx="450" cy="255" r="5" fill="#9a8194" />
    <circle cx="553" cy="255" r="5" fill="#9a8194" />
    <path d="M502 240v34m-9 0h18" stroke="#655365" strokeWidth="3" strokeLinecap="round" />
    <rect x="497" y="232" width="10" height="15" rx="5" fill="#655365" />

    {/* Coffee table, plants, and entry. */}
    <ellipse cx="311" cy="232" rx="65" ry="44" fill="#e3b98e" />
    <rect x="276" y="212" width="70" height="36" rx="13" fill="#bd9070" />
    <rect x="281" y="215" width="60" height="27" rx="11" fill="#edc5a1" />
    <rect x="297" y="221" width="22" height="14" rx="3" fill="#faf0d6" />
    <circle cx="328" cy="229" r="6" fill="#a6a98a" />
    <rect x="278" y="309" width="65" height="19" rx="6" fill="#b78673" />
    <path d="M285 315h51m-51 6h51" stroke="#e1b9a0" strokeWidth="1.5" strokeDasharray="4 3" />
    <path d="M277 332h67" stroke="#f9ead4" strokeWidth="9" strokeLinecap="round" />
    <g fill="#859576">
      <circle cx="48" cy="187" r="10" /><circle cx="56" cy="179" r="9" /><circle cx="59" cy="191" r="9" />
      <circle cx="565" cy="188" r="10" /><circle cx="575" cy="179" r="9" /><circle cx="576" cy="192" r="9" />
    </g>

    {spot && <g transform={`translate(${spot.x} ${spot.y})`}>
      <circle r="24" fill="#fff5dd" stroke="#aa664d" strokeWidth="1.5" />
      <ellipse cy="12" rx="15" ry="4" fill="#e3bf9d" />
      <path d="M-13-6h4v-4H6v4h6v3h5v-5h3V6h-3V2h-5v4H7v4H-8V6h-5Z" fill="#735574" />
      <path d="M-10-5h4v-3H5v3h6V4H6v3H-7V4h-3Z" fill="#ebc4d2" />
      <path d="M-10 2h21v2H6v3H-7V4h-3Z" fill="#fbebdf" />
      <path d="M-6-2h2v2h-2Zm8 0h2v2H2Z" fill="#534258" />
    </g>}
  </svg>
}

export function HomePage({ home, name, receivedAt, readFailed, roomRef, onOpen }: {
  home?: HomeView; name: string; receivedAt?: number; readFailed: boolean
  roomRef: Ref<HTMLElement>; onOpen: (destination: RoomDestination) => void
}) {
  const [expiredAt, setExpiredAt] = useState<number>()
  const [selected, select] = useState<RoomAnchor>()
  const selectionId = useId()
  useEffect(() => {
    if (receivedAt === undefined) return
    const remaining = MAX_STATE_AGE_MS - (Date.now() - receivedAt)
    const timer = setTimeout(() => setExpiredAt(receivedAt), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [receivedAt])

  const projection = home?.version === 1 && isKey(ACTIVITIES, home.activity) && validDate(home.observedAt)
    && ACTIVITIES[home.activity].anchor === home.anchor ? home : undefined
  const stale = readFailed || (receivedAt !== undefined && (expiredAt === receivedAt || Date.now() - receivedAt >= MAX_STATE_AGE_MS))
  const activity = stale ? undefined : projection?.activity
  const journal = stale ? undefined : projection?.journal
  const journalAt = validDate(journal?.at) ? Date.parse(journal.at) : NaN
  const observedAt = projection ? Date.parse(projection.observedAt) : NaN
  const reflecting = journal?.state === 'reflecting' && activity === 'idle' && journalAt <= observedAt
  const revised = journal?.state === 'revised' && journalAt <= observedAt && journalAt > observedAt - HOME_JOURNAL_REVISION_MS
  const current = reflecting ? REFLECTING : activity ? ACTIVITIES[activity] : undefined
  const position = current?.anchor ?? 'none'
  const desk = reflecting ? { ...ROOM_SPOTS.desk, label: '书桌', labelY: 72, detail: REFLECTING.detail,
    shortcut: { destination: 'autonomy', label: '查看自主节律' } as const } : ROOM_SPOTS.desk
  const spot = selected === 'desk' ? desk : selected && ROOM_SPOTS[selected]
  const shortcut = spot ? spot.shortcut : undefined
  const recent = Array.isArray(projection?.recent) ? projection.recent.filter(event => event && isKey(EVENT_LABELS, event.kind) && validDate(event.at)).slice(0, 4) : []
  const unavailable = stale ? { label: '等待重新连接', detail: '暂时读不到新的活动状态。' }
    : receivedAt === undefined ? { label: '正在读取', detail: '等 Companion 回传活动状态。' }
    : { label: '小家状态暂不可用', detail: '连接支持小家状态的 Companion 后，这里会显示她的位置。' }

  return <div className="cp-home-layout">
    <section className="cp-card cp-home-room" ref={roomRef} tabIndex={-1}>
      <header className="cp-row cp-between">
        <div><h2>{name}的小家</h2><p className="cp-hint cp-home-subtitle">从当前活动看她待在哪儿</p></div>
        <span className="cp-home-state" role="status" data-activity={reflecting ? 'reflecting' : activity ?? 'unknown'}>{(current ?? unavailable).label}</span>
      </header>
      <div className="cp-home-map" role="group" aria-label="查看室内位置">
        <HomeRoom anchor={position} tone={activity === 'resting' ? 'night' : !activity || activity === 'offline' ? 'quiet' : 'day'} reflecting={reflecting} />
        {ROOM_ANCHORS.map(id => {
          const room = id === 'desk' ? desk : ROOM_SPOTS[id]
          return <button key={id} type="button" className="cp-home-spot" aria-pressed={selected === id} aria-controls={selectionId}
            data-current={position === id} style={{ left: `${room.labelX / 6.2}%`, top: `${room.labelY / 3.6}%` }}
            onClick={() => select(id === selected ? undefined : id)}>{room.label}{position === id && <span className="cp-visually-hidden">，她目前在这里</span>}</button>
        })}
      </div>
      <footer className="cp-row cp-between cp-home-caption">
        <span>{(current ?? unavailable).detail}</span>
        {current && projection && <span>观察于 <time dateTime={projection.observedAt}>{timeFormat.format(new Date(projection.observedAt))}</time></span>}
      </footer>
      {revised && <p className="cp-row cp-between cp-home-journal"><span>更新了自我笔记</span>
        <time dateTime={journal.at}>{timeFormat.format(new Date(journalAt))}</time></p>}
      <div id={selectionId} className="cp-home-inspection">
        <div aria-live="polite">{spot ? <><strong>{spot.label}</strong><p>{spot.detail}</p></> : <p>点选房间里的位置，查看它对应的活动和入口。</p>}</div>
        {shortcut && <button type="button" className="cp-button" onClick={() => onOpen(shortcut.destination)}>{shortcut.label}</button>}
      </div>
    </section>
    <section className="cp-card cp-home-history">
      <h2>最近的活动</h2>
      <p className="cp-hint cp-home-subtitle">{stale && recent.length ? '上次同步的活动回执' : '来自已记录的对话、游戏、动态与阅读'}</p>
      {recent.length ? <ul className="cp-home-events">{recent.map((event, index) => <li key={`${event.kind}:${event.at}:${index}`}>
        <HomeEventLabel event={event} /><time dateTime={event.at}>{timeFormat.format(new Date(event.at))}</time>
      </li>)}</ul> : <p className="cp-home-empty">{stale ? '等重新连接后同步活动。' : '还没有活动回执。'}</p>}
    </section>
  </div>
}
