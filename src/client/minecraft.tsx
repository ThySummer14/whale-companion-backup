import { useEffect, useRef, useState, type FormEvent } from 'react'
import { SURVEY_DISTANCE, SURVEY_MAX_DISTANCE, SURVEY_MIN_RADIUS, SURVEY_TRAIL_IDS, SURVEY_TRAIL_LEG, type MinecraftCampControl, type MinecraftView } from '../protocol/api.ts'
import type { AutonomousJob, TaskStatus } from '../core/model.ts'
import type { SurveyDirection } from '../core/minecraft-survey.ts'
import { getMinecraft, minecraftAction, createMinecraftZone, revokeMinecraftZone, resumeMinecraftCamp, setPairedCampPause } from './api.ts'
import { MinecraftSurveyWindow } from './minecraft-survey-window.tsx'
import { MinecraftHouses } from './minecraft-houses.tsx'
import { MinecraftHouseProjects } from './minecraft-house-projects.tsx'

const STATUS: Record<TaskStatus, string> = { accepted: '已接收', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const DIRECTIONS: Record<SurveyDirection, string> = { north: '北', east: '东', south: '南', west: '西' }
const CAMP_STOP: Record<NonNullable<MinecraftCampControl['stopStatus']>, string> = {
  pending: '暂停已保存，等待服务端停稳回执',
  confirmed: '服务端已确认停稳',
  offline: '角色当时离线，暂停已保存',
  unconfirmed: '暂停已保存，停稳尚未确认',
}
const WARDROBE_ERROR: Readonly<Record<string, string>> = {
  'minecraft-wardrobe-unavailable': '当前游戏服无法使用衣柜。',
  'minecraft-wardrobe-option-not-found': '这款外观已不在衣柜中。',
  'minecraft-wardrobe-offline': '大肥鱼已离线。',
  'minecraft-wardrobe-busy': '正在处理上一次换装。',
  'minecraft-wardrobe-refused': 'YSM 拒绝了这款外观，请检查游戏服里的模型授权。',
  'minecraft-wardrobe-unconfirmed': '游戏服未确认这次外观设置。',
  'minecraft-camp-paused': '游戏动作已暂停。',
}

function permitActionLabel(goal: unknown): string {
  if (goal === 'prepare') return '备料并搭建'
  if (goal === 'survey') return '营地往返勘察'
  return goal === 'camp' ? '自主搭建' : '自主补给'
}

function isScheduledSurvey(job: MinecraftView['jobs'][number] | undefined): boolean {
  return job?.kind === 'minecraft.supply' && job.payload.goal === 'survey' &&
    typeof job.payload.windowRuleId === 'string' && typeof job.payload.windowSurveyZoneId === 'string'
}

function surveyResult(job: Pick<AutonomousJob, 'task' | 'payload'>) {
  const { goal, direction, surveySteps, surveyOutcome, surveyTrail, surveyCheckpoints, receiptTaskId } = job.payload
  if (job.task.status !== 'succeeded' || goal !== 'survey') return
  if (surveyTrail !== undefined || surveyCheckpoints !== undefined) {
    const trail = SURVEY_TRAIL_IDS.find(id => id === surveyTrail)
    if (!trail || typeof receiptTaskId !== 'string' || !receiptTaskId) return
    const [first, second] = trail.split('-') as [SurveyDirection, SurveyDirection]
    const route = `先向${DIRECTIONS[first]}、再向${DIRECTIONS[second]}`
    if (surveyOutcome === 'completed' && surveyCheckpoints === 2) {
      return { label: '已完成双段往返', text: `${route}，每段 ${SURVEY_TRAIL_LEG} 格，已确认通过 2/2 个检查点并原路回营。` }
    }
    if (surveyOutcome === 'recovered' && (surveyCheckpoints === 0 || surveyCheckpoints === 1)) {
      return { label: '已提前回程', text: `计划${route}，已确认通过 ${surveyCheckpoints}/2 个检查点。前路变化后沿已走路段折返，已确认回营。` }
    }
    return
  }
  if (typeof direction !== 'string' || !Object.hasOwn(DIRECTIONS, direction)) return
  const heading = DIRECTIONS[direction as SurveyDirection]
  if (surveyOutcome === 'recovered') return { label: '已提前回程', text: `向${heading}勘察时前路发生变化，已确认折返营地。` }
  if (surveyOutcome === undefined && surveySteps === undefined) return { text: `向${heading}步行 ${SURVEY_DISTANCE} 格并回到营地` }
  if (surveyOutcome === 'completed' && typeof surveySteps === 'number' && Number.isInteger(surveySteps) &&
    surveySteps >= SURVEY_DISTANCE && surveySteps <= SURVEY_MAX_DISTANCE) {
    return { text: `向${heading}步行 ${surveySteps} 格并回到营地` }
  }
}

export function MinecraftPage({ notify }: { notify: (error: unknown) => void }) {
  const [view, setView] = useState<MinecraftView>()
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [text, setText] = useState('')
  const [zoneRadius, setZoneRadius] = useState(4)
  const latestRead = useRef(0)
  const load = async () => {
    const read = ++latestRead.current
    const snapshot = await getMinecraft()
    if (read === latestRead.current) setView(snapshot)
  }
  useEffect(() => {
    void load().catch(notify)
    const timer = setInterval(() => { if (!document.hidden) void load().catch(notify) }, 3000)
    return () => clearInterval(timer)
  }, [])
  const run = async (action: string, input?: unknown) => {
    setBusy(true)
    try { await minecraftAction(action, input); await load() }
    catch (error) {
      const message = action === 'wardrobe' && error instanceof Error && WARDROBE_ERROR[error.message]
      notify(message ? new Error(message) : error)
    }
    finally { setBusy(false) }
  }
  const stop = async () => {
    setStopping(true)
    try { await minecraftAction('stop'); await load() }
    catch (error) { notify(error) }
    finally { setStopping(false) }
  }
  const changeCampControl = async (change: () => Promise<MinecraftCampControl>) => {
    setBusy(true)
    try {
      const control = await change()
      latestRead.current++
      setView(current => current && { ...current, campControl: control })
      await load()
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const authorizeCurrentZone = async () => {
    const current = observation?.position
    const dimension = observation?.dimension
    if (!current || !dimension) return
    setBusy(true)
    try {
      await createMinecraftZone({ name: `营地 ${current.x},${current.y},${current.z}`, dimension, x: Math.floor(current.x), y: Math.floor(current.y), z: Math.floor(current.z), radius: zoneRadius })
      await load()
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const revokeZone = async (id: string) => {
    setBusy(true)
    try { await revokeMinecraftZone(id); await load() }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const ask = async (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    const message = text
    setText('')
    await run('ask', { text: message })
  }
  const auth = view?.auth
  const observation = view?.observation
  const campControl = view?.campControl
  const wardrobe = view?.wardrobe
  const lastAppearance = wardrobe?.options.find(option => option.id === wardrobe.last?.id)
  const held = !!campControl?.pausedAt
  const actionDisabled = busy || stopping || held || !view?.online || !!view?.action
  const capabilities = view?.capabilities
  const extendedSurvey = capabilities?.campSurvey && capabilities.campSurveyRoutes
  const trailSurvey = extendedSurvey && capabilities.campSurveyTrails
  const permit = view?.jobs.find(job => job.kind === 'minecraft.supply' && ['accepted', 'running'].includes(job.task.status))
  const permitZoneFields = { planks: 'zoneId', camp: 'campZoneId', prepare: 'prepareZoneId', survey: 'surveyZoneId' } as const
  const permitGoal = permit?.payload.goal
  const scheduledPermit = isScheduledSurvey(permit)
  const permitZone = permit?.payload[scheduledPermit ? 'windowSurveyZoneId' : typeof permitGoal === 'string' && Object.hasOwn(permitZoneFields, permitGoal)
    ? permitZoneFields[permitGoal as keyof typeof permitZoneFields] : 'zoneId']
  const permitExpiresAt = permit?.payload.expiresAt
  const permitLabel = scheduledPermit ? '定时营地勘察' : permitActionLabel(permit?.payload.goal)
  const canAuthorize = !busy && !held && view?.online && auth?.mode === 'cbi' && !permit
  return <>
    <section className="cp-card">
      <div className="cp-row cp-between"><div><h2>她的 Minecraft 世界</h2><p className="cp-hint">独立 worker · 独立 game.minecraft Session · 真实回执</p></div><span className="cp-status" data-state={view?.online ? 'ready' : 'planned'}>{view?.online ? '已进服' : view?.workerOnline ? '等待连接' : 'worker 未就绪'}</span></div>
      <div className="cp-grid">
        <div><div className="cp-label">服务器</div><p>{view?.server.host}:{view?.server.port} · {view?.server.version}</p><div className="cp-label">正版验证与白名单保持开启</div></div>
        <div><div className="cp-label">Carpet 假人</div><p>{view?.profile?.name ?? 'dafeiyu'}</p><div className="cp-label">服务端生成，无需微软账号，不会顶替主人</div></div>
        <div><div className="cp-label">当前动作</div><p>{view?.action ?? '无'}</p><div className="cp-label">跟随、移动、采集和回程都可停止</div></div>
      </div>
      {auth?.mode === 'cbi' && <p className="cp-hint">由 Carpet 生成角色，CBI 执行受控寻路；宿主禁用 CBI 自带的第二套 AI。模型只能调用固定白名单动作。</p>}
      {view?.lastError && <div className="cp-error">{view.lastError}</div>}
      <div className="cp-actions">
        <button className="cp-button" data-primary disabled={busy || held || view?.online || !view?.workerOnline} onClick={() => void run('connect')}>生成并进入世界</button>
        <button className="cp-button" disabled={busy || !view?.online} onClick={() => void run('disconnect')}>下线</button>
        <button className="cp-button" disabled={busy} onClick={() => void load().catch(notify)}>刷新观察</button>
      </div>
    </section>
    {campControl && <section className="cp-card cp-stack">
      <div className="cp-row cp-between"><h2>营地联络站</h2><span className="cp-status">{held ? '游戏动作已暂停' : '游戏动作可用'}</span></div>
      <label className="cp-row"><input type="checkbox" checked={campControl.pairedPauseEnabled} disabled={busy}
        onChange={event => { const enabled = event.target.checked; void changeCampControl(() => setPairedCampPause(enabled)) }} />允许配对手机暂停游戏动作</label>
      <p className="cp-hint">暂停会停止当前动作与生存反射，并拦截后续游戏动作。解除暂停只能在这里操作。</p>
      {held && <>
        {campControl.stopStatus && <p className="cp-hint" aria-live="polite">{CAMP_STOP[campControl.stopStatus]}</p>}
        <div><button className="cp-button" disabled={busy || campControl.stopStatus === 'pending'}
          onClick={() => void changeCampControl(resumeMinecraftCamp)}>解除游戏暂停</button></div>
      </>}
    </section>}
    {wardrobe && <section className="cp-card cp-stack">
      <div className="cp-row cp-between"><h2>大肥鱼的衣柜</h2>
        <span className="cp-status">{held ? '游戏动作已暂停' : !view?.online ? '角色未进服' : wardrobe.available ? '可以换装' : '等待兼容的 YSM 服务端'}</span>
      </div>
      <p className="cp-hint">大肥鱼可以在游戏会话选择这些外观。工作台也可手动设置她的外观。</p>
      {wardrobe.options.length ? <div className="cp-row">
        {wardrobe.options.map(option => <button className="cp-button" type="button" key={option.id}
          disabled={busy || held || !wardrobe.available || !view?.online}
          onClick={() => void run('wardrobe', { id: option.id })}>{option.label}</button>)}
      </div> : <p className="cp-hint">等待有效的本机外观清单。</p>}
      {lastAppearance && wardrobe.last && <p className="cp-hint cp-small" aria-live="polite">
        上次服务端接受的外观为「{lastAppearance.label}」，{new Date(wardrobe.last.confirmedAt).toLocaleString()}。显示效果以游戏客户端为准。
      </p>}
    </section>}
    <section className="cp-card"><div className="cp-row cp-between"><h2>真实观察</h2><span className="cp-label">不是模型编造的地图</span></div>
      {observation ? <><p>位置 {observation.position ? `${observation.position.x}, ${observation.position.y}, ${observation.position.z}` : '读取中'} · {observation.dimension ?? '未知维度'} · {observation.gameMode ?? '未知模式'}</p><p>血量 {observation.health ?? '—'} · 饥饿 {observation.food ?? '—'} · 在线玩家 {observation.players.map(player => player.name).join('、') || '暂无其他玩家'}</p><p className="cp-hint">背包：{observation.inventory.map(item => `${item.name}×${item.count}`).join('、') || '暂无物品'}</p>{observation.survival && <><p>威胁 {observation.survival.threat} · {observation.survival.shielding ? '正在举盾' : observation.survival.autoCombat ? '生存反射待命' : '生存反射已停止'}</p><p className="cp-hint">原木 {observation.survival.logs} · 木板 {observation.survival.planks} · 即时垫脚 {observation.survival.throwaway} · 食物 {observation.survival.food} · 最佳工具耐久 {observation.survival.toolRemaining}</p><p className="cp-hint">资源决策：{observation.survival.next}；保留两根原木，储备不足才限量合成，战斗时暂停。</p></>}</> : <div className="cp-empty">进服后才会显示真实位置、血量、背包与在线玩家。</div>}
      {observation?.survival?.return && observation.survival.return !== 'NONE' && <p className="cp-hint">回程 {observation.survival.return} · 出口 {observation.survival.returnExit ?? '—'} · 已放置 {observation.survival.returnPlaced ?? 0} 块{observation.survival.returnError && observation.survival.returnError !== '-' ? ` · ${observation.survival.returnError}` : ''}</p>}
      {observation?.survival?.craft && observation.survival.craft !== 'NONE' && <p className="cp-hint">合成 {observation.survival.craft} · {observation.survival.craftItem ?? '—'}×{observation.survival.craftCount ?? 0} · 配方 {observation.survival.craftRecipe ?? '—'}{observation.survival.craftError && observation.survival.craftError !== '-' ? ` · ${observation.survival.craftError}` : ''}</p>}
      <div className="cp-actions">
        <button className="cp-button" disabled={busy || held || !view?.online || view?.action === 'follow'} onClick={() => void run('follow')}>跟随主人</button>
        <button className="cp-button" disabled={actionDisabled} onClick={() => void run('dig', { name: 'oak_log' })}>采集一根自然原木</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.crafting} onClick={() => void run('craft', { name: 'oak_planks' })}>合成木板</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.crafting} onClick={() => void run('craft', { name: 'stick' })}>合成木棍</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.crafting} onClick={() => void run('craft', { name: 'stone_pickaxe' })}>合成石镐</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.crafting} onClick={() => void run('craft', { name: 'shield' })}>合成盾牌</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.shield} onClick={() => void run('shield')}>举盾 2 秒</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.safeReturn} onClick={() => void run('return')}>安全垫脚回程</button>
        <button className="cp-button" disabled={stopping || !view?.online} onClick={() => void stop()}>停止动作与生存反射</button>
      </div>
      {view?.online && !view.connecting && capabilities && (!capabilities.crafting || !capabilities.safeReturn || !capabilities.campBuilding) && <p className="cp-hint">当前服务端的 CBI 版本仅开放已确认支持的操作。</p>}
      <p className="cp-hint cp-small">跟随只寻找主人；采集只选择附近有树叶的自然原木。合成一次只执行一个白名单真实配方，镐和盾牌需要附近已有工作台。回程最多 16 格，只去已验证的相邻出口，使用廉价方块或木板并保留原木，不开放任意挖掘、放置或 OP 命令。</p>
    </section>
    <section className="cp-card"><div className="cp-row cp-between"><div><h2>主人授权的营地区域</h2><p className="cp-hint">区域范围由主人设置。角色从已授权的营地中行动。</p></div><div className="cp-actions">
      <label className="cp-row">半径 <select className="cp-input" value={zoneRadius} onChange={event => setZoneRadius(Number(event.target.value))}>
        {[2, 3, 4, 5, 6, 7, 8].map(radius => <option key={radius} value={radius}>{radius} 格</option>)}
      </select></label>
      <button className="cp-button" disabled={busy || !observation?.position || !observation.dimension} onClick={() => void authorizeCurrentZone()}>授权当前位置</button>
    </div></div>
      {observation?.survival?.build && observation.survival.build !== 'NONE' && <p className="cp-hint">建造 {observation.survival.build} · 区域 {observation.survival.buildZone ?? '—'} · 中心 {observation.survival.buildCenter ?? '—'} · 新增地板 {observation.survival.buildFloor ?? 0} · 工作台 {observation.survival.buildTable ?? 0}{observation.survival.buildError && observation.survival.buildError !== '-' ? ` · ${observation.survival.buildError}` : ''}</p>}
      <p className="cp-hint">每次只授权一个区域的一项任务，15 分钟后到期，可随时撤销。她在线且身处该区域时才评估。</p>
      <p className="cp-hint">勘察需要半径至少 {SURVEY_MIN_RADIUS} 格的营地。{extendedSurvey
        ? `服务端在授权区内检查每个方向最长可走的平地路线，最多 ${SURVEY_MAX_DISTANCE} 格。她可选一个方向往返${trailSurvey ? '、选择双段路线' : ''}，也可跳过。`
        : `她从中心出发，可选择一条服务端确认过的平地路线，走 ${SURVEY_DISTANCE} 格后原路返回，也可以跳过。`}</p>
      {trailSurvey && <p className="cp-hint">双段路线由两段互相垂直的平地组成，每段 {SURVEY_TRAIL_LEG} 格。她在转角停稳并确认第一个检查点后才走第二段，回程再沿原路经过转角。</p>}
      {extendedSurvey && <p className="cp-hint">前路发生变化时，只有确认走过的路仍安全才会提前折返。遇到威胁、回程受阻或收到停止指令时，她会原地停下。</p>}
      {view?.online && !capabilities?.campSurvey && <p className="cp-hint">当前服务端尚未开放往返勘察。</p>}
      <p className="cp-hint">补给最多合成一批木板。搭建要求背包已有 8 块同种木板和 1 个工作台。备料并搭建也要求已有工作台，只用背包内的原木补齐木板，最多合成两批。两种搭建都沿用 3×3 营地布局。撤销会请求停止后续步骤，已经合成的材料和已放置的方块保留。</p>
      {permit && <div className="cp-row cp-between">
        <div>
          <strong>{view?.buildZones.find(zone => zone.id === permitZone)?.name ?? '授权区域'} · {permitLabel} · {STATUS[permit.task.status]}</strong>
          {typeof permitExpiresAt === 'number' && <div className="cp-hint">授权到期 {new Date(permitExpiresAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>}
        </div>
        <button className="cp-button" disabled={busy} onClick={() => void run('supply/cancel', typeof permitZone === 'string' ? { zoneId: permitZone } : {})}>{scheduledPermit ? '撤销本次勘察' : `撤销${permitLabel}授权`}</button>
      </div>}
      {(view?.buildZones ?? []).map(zone => <div key={zone.id}><div className="cp-row cp-between"><span>{zone.name} · 半径 {zone.radius}</span><div className="cp-actions">
        <button className="cp-button" disabled={actionDisabled || !capabilities?.campBuilding} onClick={() => void run('build', { zoneId: zone.id, material: 'oak_planks' })}>搭建木板营地</button>
        <button className="cp-button" disabled={actionDisabled || !capabilities?.campBuilding || !capabilities.crafting} onClick={() => void run('prepare', { zoneId: zone.id, material: 'oak_planks' })}>备料并搭建</button>
        <button className="cp-button" disabled={!canAuthorize || !capabilities?.crafting} onClick={() => void run('supply', { zoneId: zone.id })}>授权一次自主补给</button>
        <button className="cp-button" disabled={!canAuthorize || !capabilities?.campBuilding} onClick={() => void run('supply', { zoneId: zone.id, goal: 'camp' })}>授权一次自主搭建</button>
        <button className="cp-button" disabled={!canAuthorize || !capabilities?.crafting || !capabilities.campBuilding} onClick={() => void run('supply', { zoneId: zone.id, goal: 'prepare' })}>授权一次备料并搭建</button>
        <button className="cp-button" disabled={!canAuthorize || !capabilities?.campSurvey || zone.radius < SURVEY_MIN_RADIUS} onClick={() => void run('supply', { zoneId: zone.id, goal: 'survey' })}>授权一次往返勘察</button>
        <button className="cp-button" disabled={busy} onClick={() => void revokeZone(zone.id)}>撤销</button>
      </div></div><p className="cp-hint">{zone.dimension} · {zone.x},{zone.y},{zone.z}{extendedSurvey && zone.radius >= SURVEY_MIN_RADIUS && ` · ${trailSurvey ? '直线' : ''}单程上限 ${Math.min(zone.radius - 1, SURVEY_MAX_DISTANCE)} 格，实际路线以预检为准`}</p></div>)}
      {!view?.buildZones?.length && <div className="cp-empty">还没有授权区。先从真实位置建立一处营地。</div>}
    </section>
    <MinecraftSurveyWindow zones={view?.buildZones ?? []} jobs={view?.jobs ?? []} tasks={view?.tasks ?? []} busy={busy} />
    <MinecraftHouses zones={view?.buildZones ?? []} busy={busy} />
    <MinecraftHouseProjects zones={view?.buildZones ?? []} busy={busy || stopping} />
    <section className="cp-card"><h2>对她说</h2><p className="cp-hint">消息进入独立游戏 Session，由她结合真实观察决定回应、行动或沉默。</p><form className="cp-row" onSubmit={event => void ask(event)}><input className="cp-input" style={{ flex: 1 }} value={text} maxLength={256} placeholder="例如：过来跟着我，或者看看附近有什么" onChange={event => setText(event.target.value)} /><button className="cp-button" data-primary type="submit" disabled={busy || held || !text.trim()}>交给角色</button></form></section>
    <section className="cp-card"><h2>她的经验课</h2><p className="cp-hint">失败会改变后续候选，后续真实成功再核验经验；不是在线训练，也不会扩大动作权限。</p>{(view?.lessons ?? []).map(lesson => <div key={lesson.signature}><div className="cp-row cp-between"><span>{lesson.action} · {lesson.errorCode} · 第 {lesson.occurrences} 次</span><span className="cp-status" data-state={lesson.status === 'resolved' ? 'ready' : 'planned'}>{lesson.status === 'resolved' ? '已验证' : lesson.status === 'disabled' ? '已停用' : '学习中'}</span></div><p className="cp-hint">{lesson.lesson}</p><div className="cp-label">{lesson.targetKey}</div></div>)}{!view?.lessons?.length && <div className="cp-empty">还没有失败案例。真实错误会在这里形成第一条经验。</div>}</section>
    <section className="cp-card"><h2>任务与事件</h2>
      {[
        ...(view?.jobs ?? []).map(job => ({
          id: job.id,
          title: isScheduledSurvey(job) ? '定时营地勘察' : job.kind === 'minecraft.supply' ? `授权${permitActionLabel(job.payload.goal)}` : '世界事件评估',
          status: job.task.status,
          error: job.task.error ?? job.lastError,
          stepCount: job.payload.goal === 'prepare' && Array.isArray(job.payload.steps) ? job.payload.steps.length : undefined,
          survey: surveyResult(job),
          receiptTaskId: typeof job.payload.receiptTaskId === 'string' ? job.payload.receiptTaskId : undefined,
        })),
        ...(view?.tasks ?? []),
      ].map(task => <div className="cp-row cp-between" key={task.id} id={`minecraft-task-${task.id}`}>
        <div>{task.title}
          {'stepCount' in task && task.stepCount !== undefined && <div className="cp-hint">已确认 {task.stepCount} 个步骤</div>}
          {'survey' in task && task.survey && <div className="cp-hint">{task.survey.text}</div>}
          {'receiptTaskId' in task && task.receiptTaskId && <div className="cp-hint">游戏回执 <code>{task.receiptTaskId}</code></div>}
          {task.error && <div className="cp-hint">{task.error}</div>}
        </div>
        <span className="cp-status" data-state={task.status}>{('survey' in task && task.survey?.label) || STATUS[task.status]}</span>
      </div>)}
      {view?.recentEvents.slice().reverse().map(event => <div key={event.seq} className="cp-label">{event.kind}{event.username ? ` · ${event.username}` : ''}{event.message ? ` · ${event.message}` : ''}</div>)}
      {!view?.tasks.length && !view?.jobs.length && !view?.recentEvents.length && <div className="cp-empty">尚无游戏事件。</div>}
    </section>
  </>
}
