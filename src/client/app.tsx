import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ActivityStatus, CapabilityStatus, Presence, TaskStatus } from '../core/model.ts'
import type { WorkbenchView } from '../protocol/api.ts'
import { getState } from './api.ts'
import { PersonaSettings } from './persona.tsx'
import { MemoryPage } from './memory.tsx'
import { Scenes } from './scenes.tsx'
import { DevicesPage } from './devices.tsx'
import { FeedPage } from './feed.tsx'
import { AutonomyPage } from './autonomy.tsx'
import { AvatarPanel } from './avatar.tsx'
import { MinecraftPage } from './minecraft.tsx'
import { HomePage } from './home.tsx'
import { CommunityMap } from './community.tsx'
import { BilibiliPage } from './bilibili.tsx'
import { SingingPage } from './singing.tsx'
import { STYLES } from './styles.ts'

type Tab = 'overview' | 'home' | 'avatar' | 'singing' | 'minecraft' | 'bilibili' | 'autonomy' | 'feed' | 'scenes' | 'activity' | 'memory' | 'tasks' | 'capabilities' | 'devices' | 'settings'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'home', label: '小家' },
  { id: 'avatar', label: '形象' },
  { id: 'singing', label: '歌唱' },
  { id: 'minecraft', label: 'Minecraft' },
  { id: 'bilibili', label: 'B 站' },
  { id: 'autonomy', label: '自主节律' },
  { id: 'feed', label: '动态' },
  { id: 'scenes', label: '场景' },
  { id: 'activity', label: '活动' },
  { id: 'memory', label: '中央记忆' },
  { id: 'tasks', label: '任务' },
  { id: 'capabilities', label: '能力' },
  { id: 'devices', label: '设备' },
  { id: 'settings', label: '角色设置' },
]

const PRESENCE: Record<Presence, string> = { unconfigured: '未绑定', offline: '离线', idle: '空闲', running: '运行中' }
const TASK: Record<TaskStatus, string> = { accepted: '已接收', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const CAPABILITY: Record<CapabilityStatus, string> = { ready: '已就绪', planned: '未接入', unavailable: '不可用', error: '异常' }
const ACTIVITY: Record<ActivityStatus, string> = { info: '记录', success: '成功', warning: '注意', error: '错误' }

function Dot({ state }: { state: string }) {
  return <span className="cp-dot" data-state={state} aria-hidden />
}

function Status({ state, children }: { state: string; children: ReactNode }) {
  return <span className="cp-status" data-state={state}>{children}</span>
}

function time(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function Metric({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return <section className="cp-card"><div className="cp-label">{label}</div><div className="cp-metric">{value}</div>{detail && <div className="cp-label">{detail}</div>}</section>
}

function Overview({ data }: { data: WorkbenchView }) {
  const usage = data.stats.usage24h
  return <>
    <div className="cp-grid">
      <Metric label="长期场景" value={data.bindings.length} detail={PRESENCE[data.presence]} />
      <Metric label="中央记忆" value={data.memory.active} detail={`候选 ${data.memory.candidate} · 遗忘 ${data.memory.forgotten}`} />
      <Metric label="累计活动" value={data.stats.activities} detail={`24 小时 ${data.stats.activities24h} 条`} />
      <Metric label="待处理任务" value={data.stats.runningTasks} detail={`失败 ${data.stats.failedTasks} 个`} />
      <Metric label="累计未缓存输入 Token" value={data.stats.inputTokens.toLocaleString()} detail="仅统计已绑定场景" />
      <Metric label="输出 Token" value={data.stats.outputTokens.toLocaleString()} detail="不是模型账单口径" />
    </div>
    {usage && <section className="cp-card">
      <h2>最近 24 小时的模型用量</h2>
      <p className="cp-hint">已绑定场景的主模型请求中，{usage.measuredCalls} 次回报用量，{usage.unmeteredCalls} 次缺少用量。标题、压缩等独立请求未计入。</p>
      <p>未缓存输入 {usage.uncachedInputTokens.toLocaleString()} · 缓存读取 {usage.cacheReadTokens.toLocaleString()} · 缓存写入 {usage.cacheWriteTokens.toLocaleString()} · 输出 {usage.outputTokens.toLocaleString()}</p>
      <p>后台回报用量 {usage.backgroundCalls} 次，未缓存输入 {usage.backgroundUncachedInputTokens.toLocaleString()}</p>
      {!!usage.byContext?.length && <div className="cp-table-wrap">
        <table className="cp-table"><caption>按未缓存输入、缓存写入和输出合计排序，最多 8 个场景。推理量单列，随模型回报。</caption>
          <thead><tr><th>场景</th><th>已计量 / 缺统计</th><th>未缓存输入</th><th>缓存读 / 写</th><th>输出</th><th>已报告推理</th></tr></thead>
          <tbody>{usage.byContext.map(row => <tr key={row.contextId}>
            <td>{data.bindings.find(binding => binding.contextId === row.contextId)?.label ?? row.contextId}</td>
            <td>{row.measuredCalls} / {row.unmeteredCalls}</td>
            <td>{row.uncachedInputTokens.toLocaleString()}</td>
            <td>{row.cacheReadTokens.toLocaleString()} / {row.cacheWriteTokens.toLocaleString()}</td>
            <td>{row.outputTokens.toLocaleString()}</td>
            <td>{row.reasoningTokens?.toLocaleString() ?? '未报告'}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>}
    <section className="cp-card"><div className="cp-row cp-between"><h2>场景状态</h2><span className="cp-label">Session 各自隔离，中央记忆共享</span></div>
      {data.bindings.length ? data.bindings.map(binding => <div className="cp-session" key={binding.contextId}><strong>{binding.label}</strong><div className="cp-code">{binding.contextId} → {binding.sessionId}</div></div>) : <div className="cp-empty">到“场景”页绑定聊天、游戏或任务 Session。</div>}
    </section>
    <section className="cp-card">
      <div className="cp-row cp-between"><h2>最近活动</h2><span className="cp-label">最新 5 条</span></div>
      {data.activities.length ? <ActivityList data={data} limit={5} /> : <div className="cp-empty">绑定场景并开始活动后，这里会出现真实事件。</div>}
    </section>
  </>
}

function ActivityList({ data, limit }: { data: WorkbenchView; limit?: number }) {
  const activities = limit ? data.activities.slice(0, limit) : data.activities
  return <div className="cp-table-wrap"><table className="cp-table"><thead><tr><th>时间</th><th>场景</th><th>类型</th><th>活动</th><th>状态</th></tr></thead><tbody>
    {activities.map(activity => <tr key={activity.id}>
      <td className="cp-meta">{time(activity.occurredAt)}</td>
      <td className="cp-code">{activity.contextId ?? '中央'}</td>
      <td><div className="cp-kind">{activity.kind}</div><div className="cp-code">{activity.source}</div></td>
      <td>{activity.summary}{activity.data.toolName && <div className="cp-code">{String(activity.data.toolName)}</div>}</td>
      <td><Status state={activity.status}>{ACTIVITY[activity.status]}</Status></td>
    </tr>)}
  </tbody></table></div>
}

function Tasks({ data }: { data: WorkbenchView }) {
  return <section className="cp-card"><div className="cp-row cp-between"><h2>任务记录</h2><span className="cp-label">投递不等于执行成功</span></div>
    {data.tasks.length ? <div className="cp-table-wrap"><table className="cp-table"><thead><tr><th>任务</th><th>场景</th><th>能力</th><th>状态</th><th>更新时间</th></tr></thead><tbody>
      {data.tasks.map(task => <tr key={task.id}><td><strong>{task.title}</strong><div className="cp-code">{task.id}</div>{task.error && <div className="cp-error">{task.error}</div>}</td><td className="cp-code">{task.contextId ?? '中央'}</td><td className="cp-code">{task.capabilityId}</td><td><Status state={task.status}>{TASK[task.status]}</Status></td><td className="cp-meta">{time(task.updatedAt)}</td></tr>)}
    </tbody></table></div> : <div className="cp-empty">还没有任务。后续连接器通过受控 API 创建任务后，会在这里看到完整状态。</div>}
  </section>
}

function Capabilities({ data }: { data: WorkbenchView }) {
  return <div className="cp-capabilities">{data.capabilities.map(capability => <section className="cp-card" key={capability.id}>
    <div className="cp-capability-top"><h3>{capability.displayName}</h3><span className="cp-presence"><Dot state={capability.status} />{CAPABILITY[capability.status]}</span></div>
    <div className="cp-code">{capability.id}</div><p>{capability.detail}</p><div className="cp-label">更新于 {time(capability.updatedAt)}</div>
  </section>)}</div>
}

export function CompanionApp({ openSession }: { openSession: (id: string) => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [stageSong, setStageSong] = useState<string>()
  const [snapshot, setSnapshot] = useState<{ data: WorkbenchView; receivedAt: number }>()
  const [error, setError] = useState<string>()
  const [stateReadFailed, setStateReadFailed] = useState(false)
  const data = snapshot?.data
  const homeRoom = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  const queue = useRef(Promise.resolve())
  const load = useCallback(() => {
    const next = queue.current.then(async () => {
      try {
        const value = await getState()
        if (mounted.current) {
          setSnapshot({ data: value, receivedAt: Date.now() })
          setStateReadFailed(false)
          setError(undefined)
        }
      } catch (failure) {
        if (mounted.current) {
          setStateReadFailed(true)
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
    })
    queue.current = next.catch(() => {})
    return next
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [load])
  const notify = useCallback((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)), [])
  return <div className="companion-panel"><style>{STYLES}</style><div className="cp-wrap">
    <header className="cp-header"><div><h1 className="cp-title">{data?.persona.name || 'Companion'} 工作台</h1><p className="cp-subtitle">{data?.persona.tagline || '一个角色、一份中央记忆、多个并行场景'}</p></div><span className="cp-presence"><Dot state={data?.presence ?? 'unconfigured'} />{data ? PRESENCE[data.presence] : '连接中'}</span></header>
    <nav className="cp-tabs" aria-label="Companion 工作台页面">{TABS.map(item => <button key={item.id} className="cp-tab" aria-current={tab === item.id ? 'page' : undefined} data-active={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    {error && <div className="cp-error" role="alert">{error}<button className="cp-button" style={{ marginLeft: 12 }} onClick={() => void load()}>重试</button></div>}
    {tab === 'home' ? <>
      <HomePage home={data?.home} name={data?.persona.name || '大肥鱼'} receivedAt={snapshot?.receivedAt} readFailed={stateReadFailed} roomRef={homeRoom} onOpen={setTab} />
      <CommunityMap community={data?.community} receivedAt={snapshot?.receivedAt} readFailed={stateReadFailed} onOpen={destination => {
        if (destination === 'home') homeRoom.current?.focus()
        else setTab(destination)
      }} />
    </> : !data ? <div className="cp-empty">正在读取 Companion 状态…</div> : <>
      {tab === 'overview' && <Overview data={data} />}
      {tab === 'avatar' && <AvatarPanel notify={notify} songs={data.singing?.tasks} initialSong={stageSong} />}
      {tab === 'singing' && <SingingPage data={data} reload={load} openSession={openSession} openStage={id => { setStageSong(id); setTab('avatar') }} />}
      {tab === 'minecraft' && <MinecraftPage notify={notify} />}
      {tab === 'bilibili' && <BilibiliPage data={data} reload={load} openSession={openSession} notify={notify} />}
      {tab === 'autonomy' && <AutonomyPage data={data} reload={load} notify={notify} />}
      {tab === 'feed' && <FeedPage personaName={data.persona.name} reload={load} notify={notify} stateReadFailed={stateReadFailed} />}
      {tab === 'scenes' && <Scenes data={data} reload={load} openSession={openSession} notify={notify} />}
      {tab === 'activity' && (data.activities.length ? <section className="cp-card"><div className="cp-row cp-between"><h2>活动流</h2><span className="cp-label">最近 {data.activities.length} 条</span></div><ActivityList data={data} /></section> : <div className="cp-empty">还没有活动记录。</div>)}
      {tab === 'memory' && <MemoryPage data={data} reload={load} notify={notify} />}
      {tab === 'tasks' && <Tasks data={data} />}
      {tab === 'capabilities' && <Capabilities data={data} />}
      {tab === 'devices' && <DevicesPage reload={load} notify={notify} />}
      {tab === 'settings' && <PersonaSettings data={data} reload={load} notify={notify} />}
    </>}
  </div></div>
}
