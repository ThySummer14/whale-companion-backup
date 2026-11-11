import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { MinecraftHouseProject } from '../core/minecraft-house-project.ts'
import type { TaskStatus } from '../core/model.ts'
import { SURVEY_MIN_RADIUS, type MinecraftCampGatherView, type MinecraftCampPatrolView, type MinecraftCampVisitStatus, type MinecraftSurveyWindowInput, type MinecraftSurveyWindowView, type MinecraftView } from '../protocol/api.ts'
import { getMinecraftHouseProjects, getMinecraftSurveyWindow, revokeMinecraftSurveyWindow, saveMinecraftSurveyWindow } from './api.ts'

const DAILY_STATUS: Record<NonNullable<MinecraftSurveyWindowView['today']>['status'], string> = {
  waiting: '等待窗口开放',
  available: '时段已开放',
  suppressed: '今日已停止评估',
  ended: '今日窗口已结束',
  used: '今日已创建任务',
  paused: '当前条件下暂缓',
}

const CHOICE = { survey: '她选择勘察营地', supply: '她选择补给营地', build: '她选择建造营地', revisit: '她选择复查营地', patrol: '她选择巡视营地', gather: '她选择采集自然橡木', bilibili: '她选择阅读 B 站字幕', 'house-project': '她选择推进授权建筑的一个分段', 'house-project-supply': '她选择为授权建筑备料', skip: '她决定今天跳过' }
const COMPLETED_VISIT = { supply: '她完成了营地补给，背包确认增加 4 块木板', build: '她完成了营地建造，游戏确认放置 8 块地板和 1 个工作台' }
const PROJECT_STAGE: Record<NonNullable<MinecraftSurveyWindowView['project']>['stage'], string> = {
  gathering: '备料中', revisit: '已建造，等待后续短访复查', complete: '已复查，项目完成', 'needs-review': '等待你确认营地',
}
const PATROL_STATUS: Record<MinecraftCampPatrolView['status'], string> = {
  running: '巡视中', completed: '巡视已完成', partial: '巡视仅完成部分路段', cancelled: '巡视已取消', failed: '巡视失败',
}
const GATHER_STATUS: Record<MinecraftCampGatherView['status'], string> = {
  running: '采集中', completed: '采集与回营已确认', cancelled: '采集已取消', failed: '采集任务未完成',
}
const TASK_LINK = { supply: '查看今日补给任务', build: '查看今日建造任务', revisit: '查看今日复查任务', survey: '查看今日勘察任务', patrol: '查看今日巡视任务', gather: '查看今日采集任务', 'house-project': '查看今日分段施工任务', 'house-project-supply': '查看今日建筑备料任务' }
const DECISION_STATUS: Record<TaskStatus, string> = {
  accepted: '等待评估', running: '正在评估', succeeded: '评估已结束', failed: '评估失败', cancelled: '评估已取消',
}
const VISIT_STATUS: Record<MinecraftCampVisitStatus, string> = {
  starting: '正在尝试进服', online: '已确认进服', offline: '服务端已确认下线', unconfirmed: '下线尚未确认',
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

function minute(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}

function localStamp(value: number, timeZone: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  } catch {
    return date.toISOString()
  }
}

export function MinecraftSurveyWindow({ zones, busy, jobs, tasks = [] }: {
  zones: MinecraftView['buildZones']; busy: boolean; jobs: MinecraftView['jobs']; tasks?: MinecraftView['tasks']
}) {
  const [view, setView] = useState<MinecraftSurveyWindowView>()
  const [readFailed, setReadFailed] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [zoneId, setZoneId] = useState('')
  const [start, setStart] = useState('19:00')
  const [end, setEnd] = useState('20:00')
  const [days, setDays] = useState(1)
  const [allowBilibili, setAllowBilibili] = useState(false)
  const [allowMinecraftLogin, setAllowMinecraftLogin] = useState(false)
  const [allowMinecraftSupply, setAllowMinecraftSupply] = useState(false)
  const [allowMinecraftBuild, setAllowMinecraftBuild] = useState(false)
  const [allowMinecraftProject, setAllowMinecraftProject] = useState(false)
  const [allowMinecraftPatrol, setAllowMinecraftPatrol] = useState(false)
  const [allowMinecraftGather, setAllowMinecraftGather] = useState(false)
  const [allowMinecraftProjectGather, setAllowMinecraftProjectGather] = useState(false)
  const [houseProjectId, setHouseProjectId] = useState('')
  const [allowHouseProjectSupply, setAllowHouseProjectSupply] = useState(false)
  const [houseProjects, setHouseProjects] = useState<MinecraftHouseProject[]>()
  const revision = useRef(0)
  const mutating = useRef(false)

  const clearProjectChoice = () => {
    setAllowMinecraftProject(false)
    setAllowMinecraftProjectGather(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    let unsupported = false
    const refresh = async () => {
      if (pending || unsupported || mutating.current || document.hidden) return
      pending = true
      const expected = revision.current
      try {
        const result = await getMinecraftSurveyWindow(controller.signal)
        if (controller.signal.aborted || expected !== revision.current) return
        unsupported = result === undefined
        setView(result)
        setReadFailed(false)
      } catch {
        if (!controller.signal.aborted && expected === revision.current) setReadFailed(true)
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])

  const readHouseProjects = !!view?.rule?.houseProjectId || !view?.rule && view?.houseProjectAvailable === true && !!zoneId
  useEffect(() => {
    if (!readHouseProjects) return
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await getMinecraftHouseProjects(controller.signal)
        if (!controller.signal.aborted) setHouseProjects(result?.projects)
      } catch {
        if (!controller.signal.aborted) setHouseProjects(undefined)
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [readHouseProjects])

  const update = async (input?: MinecraftSurveyWindowInput) => {
    if (busy || mutating.current) return
    mutating.current = true
    revision.current++
    setSaving(true)
    setFailure(undefined)
    try {
      const next = input ? await saveMinecraftSurveyWindow(input) : await revokeMinecraftSurveyWindow()
      setView(next)
      if (!input) {
        setAllowBilibili(false)
        setAllowMinecraftLogin(false)
        setAllowMinecraftSupply(false)
        setAllowMinecraftBuild(false)
        clearProjectChoice()
        setAllowMinecraftPatrol(false)
        setAllowMinecraftGather(false)
        setHouseProjectId('')
        setAllowHouseProjectSupply(false)
      }
      setReadFailed(false)
    } catch (error) {
      const code = error instanceof Error ? error.message : undefined
      setFailure(code === 'minecraft-house-project-window-unavailable' ? '当前无法授权建筑续建，请核对自主活动设置。'
        : code === 'minecraft-house-project-window-invalid' ? '所选建筑已不可用，请检查授权区域和未完成分段。'
          : '授权操作未完成，请检查区域和当前授权后重试。')
    }
    finally { mutating.current = false; setSaving(false) }
  }

  const eligible = zones.filter(zone => zone.radius >= SURVEY_MIN_RADIUS)
  const validZone = eligible.some(zone => zone.id === zoneId)
  const houseProjectAvailable = view?.houseProjectAvailable === true
  const houseChoices = houseProjectAvailable && validZone ? houseProjects?.filter(item =>
    item.zoneId === zoneId && item.sections.some(section => section.status === 'pending' || section.status === 'interrupted')) ?? [] : []
  const chooseHouseProject = !view?.rule && houseChoices.some(item => item.id === houseProjectId)
  const houseSupplySelectable = chooseHouseProject && view?.houseProjectSupplyAvailable === true
  useEffect(() => {
    if (!houseSupplySelectable || readFailed) setAllowHouseProjectSupply(false)
  }, [houseSupplySelectable, readFailed])

  if (!view) return null
  const duration = minute(end) - minute(start)
  const validTime = TIME.test(start) && TIME.test(end) && duration >= 30 && duration <= 180
  const disabled = busy || saving
  const { rule, today, lastVisit, project, patrol, gather } = view
  const dailyChoiceAvailable = view.dailyChoiceAvailable === true
  const campVisitAvailable = view.campVisitAvailable === true
  const campVisitSupplyAvailable = campVisitAvailable && view.campVisitSupplyAvailable === true
  const campVisitBuildAvailable = campVisitAvailable && view.campVisitBuildAvailable === true
  const campVisitProjectAvailable = campVisitSupplyAvailable && campVisitBuildAvailable && view.campVisitProjectAvailable === true
  const campPatrolAvailable = campVisitAvailable && view.campPatrolAvailable === true
  const campGatherAvailable = campVisitAvailable && view.campGatherAvailable === true
  const campVisitProjectGatherAvailable = campVisitProjectAvailable && campGatherAvailable && view.campVisitProjectGatherAvailable === true
  const chooseBilibili = !rule && dailyChoiceAvailable && allowBilibili
  const chooseVisit = !rule && campVisitAvailable && allowMinecraftLogin
  const chooseSupply = chooseVisit && campVisitSupplyAvailable && allowMinecraftSupply
  const chooseBuild = chooseVisit && campVisitBuildAvailable && allowMinecraftBuild
  const chooseProject = chooseSupply && chooseBuild && campVisitProjectAvailable && allowMinecraftProject
  const choosePatrol = chooseVisit && campPatrolAvailable && allowMinecraftPatrol
  const chooseGather = chooseVisit && campGatherAvailable && allowMinecraftGather
  const chooseProjectGather = chooseProject && chooseGather && campVisitProjectGatherAvailable && allowMinecraftProjectGather
  const chooseHouseProjectSupply = houseSupplySelectable && allowHouseProjectSupply && !readFailed
  const authorizedHouse = rule?.houseProjectId && houseProjects?.find(item => item.id === rule.houseProjectId && item.zoneId === rule.zoneId)
  const validHouseChoice = !houseProjectId || chooseHouseProject
  const choiceMode = rule?.allowBilibili === true || rule?.allowMinecraftLogin === true || !!rule?.houseProjectId
  const visitMode = rule?.allowMinecraftLogin === true || chooseVisit
  const supplyMode = rule?.allowMinecraftSupply === true || chooseSupply
  const buildMode = rule?.allowMinecraftBuild === true || chooseBuild
  const projectMode = rule?.allowMinecraftProject === true || chooseProject
  const patrolMode = rule?.allowMinecraftPatrol === true || choosePatrol
  const gatherMode = rule?.allowMinecraftGather === true || chooseGather
  const projectGatherMode = rule?.allowMinecraftProjectGather === true || chooseProjectGather
  const projectGatherCount = rule?.allowMinecraftProjectGather ? project?.gatheredLogs : undefined
  const houseMode = !!rule?.houseProjectId || chooseHouseProject
  const houseSupplyMode = houseMode && (rule?.allowHouseProjectSupply === true || chooseHouseProjectSupply)
  const surveyMode = !houseMode || visitMode
  const bilibiliMode = rule?.allowBilibili === true || chooseBilibili
  const dailyChoices = [...(surveyMode ? ['营地勘察'] : []), ...(houseMode ? ['指定建筑续建'] : []),
    ...(houseSupplyMode ? ['为指定建筑备料'] : []), ...(bilibiliMode ? ['B 站浏览'] : [])]
  const showChoice = chooseBilibili || chooseVisit || chooseHouseProject
  const title = dailyChoiceAvailable || campVisitAvailable || houseProjectAvailable || choiceMode ? '每日自主活动' : '定时营地勘察'
  const decisionStatus = choiceMode && today?.status === 'used' ? today.decisionStatus : undefined
  const todayTask = jobs.find(job => job.id === today?.taskId) ?? tasks.find(task => task.id === today?.taskId)
  const visitStatus = today?.visitStatus ?? lastVisit?.status
  const choice = today?.choice
  const completedVisit = today?.decisionStatus === 'succeeded' &&
    (choice === 'supply' || choice === 'build' && today.visitStatus === 'offline') ? COMPLETED_VISIT[choice] : undefined
  const completedHouseSupply = today?.decisionStatus === 'succeeded' && choice === 'house-project-supply'
    ? '她完成了建筑备料，背包已核验增加 4 块木板' : undefined
  const taskLink = choice && choice !== 'bilibili' && choice !== 'skip' ? TASK_LINK[choice] : TASK_LINK.survey
  const authorize = (event: FormEvent) => {
    event.preventDefault()
    if (!readFailed && validZone && validTime && validHouseChoice && Number.isInteger(days) && days >= 1 && days <= 7) {
      void update({ zoneId, start, end, days, ...(chooseBilibili && { allowBilibili: true }), ...(chooseVisit && { allowMinecraftLogin: true }),
        ...(chooseSupply && { allowMinecraftSupply: true }), ...(chooseBuild && { allowMinecraftBuild: true }),
        ...(chooseProject && { allowMinecraftProject: true }), ...(choosePatrol && { allowMinecraftPatrol: true }),
        ...(chooseGather && { allowMinecraftGather: true }),
        ...(chooseProjectGather && { allowMinecraftProjectGather: true }), ...(chooseHouseProject && { houseProjectId }),
        ...(chooseHouseProjectSupply && { allowHouseProjectSupply: true }) })
    }
  }
  return <section className="cp-card" aria-label={title}>
    <div className="cp-row cp-between"><h2>{title}</h2>
      <span className="cp-status" role="status" data-state={readFailed ? 'planned' : decisionStatus ?? (today?.status === 'available' ? 'ready' : 'planned')}>
        {readFailed ? '暂时读不到新状态' : decisionStatus ? DECISION_STATUS[decisionStatus]
          : today ? DAILY_STATUS[today.status] : rule ? '授权暂缓' : '尚未授权'}
      </span>
    </div>
    {choiceMode || showChoice
      ? <p className="cp-hint">授权时段内每天最多评估一次。她可选{dailyChoices.join('、')}或跳过。
        {bilibiliMode && '请在「自主」开启 B 站浏览并准备候选。开启短片段后，她还可以自行选择最多 8 秒的片段。'}
        {surveyMode && (visitMode ? '勘察需要路线通过预检。' : '勘察需要她已经进服且路线通过预检。')}评估遵守免打扰，分享动态需要单独授权。</p>
      : <p className="cp-hint">授权期间每天最多创建一次往返勘察任务。她可选择出发或跳过，时间充足时也可延后一次。她进服后，只在授权时段内、免打扰时段外且营地路线通过检查时评估。下线后需手动进服。</p>}
    {((!rule && campVisitAvailable) || rule?.allowMinecraftLogin) && <p className="cp-hint">自主短访最多 5 分钟。进服后只在授权营地且确认安全时才开始活动，结束后由游戏服务端回读下线。人工已进服时保留当前会话。</p>}
    {supplyMode && <p className="cp-hint">短访可根据实查背包选择补给。一次最多消耗 1 根原木、合成 4 块木板，并保留至少 2 根同种原木。短访只执行一项活动。</p>}
    {buildMode && <p className="cp-hint">短访可用背包里的材料在授权营地铺 8 块地板、放 1 个工作台。短访只执行一项活动。</p>}
    {projectMode && <p className="cp-hint">她可以在同一授权营地分多天备料、建造和只读复查。每天最多评估一次，遇到变化会停下来等你确认。</p>}
    {patrolMode && <p className="cp-hint">一次短访最多巡视两段营地路线。每段都要先检查路线，再往返营地。</p>}
    {gatherMode && <p className="cp-hint">一次采集最多取得 1 根自然橡木原木。她会先核对路线与树木，采集后沿原路回营。</p>}
    {projectGatherMode && <p className="cp-hint">跨日营地项目先核对背包。木板不足且无法用现有材料补给时，她才可选择采集。每次短访只执行一项活动。</p>}
    {houseMode && <p className="cp-hint">建筑授权仅适用于指定项目。她已进服且空闲时可重新预检，{houseSupplyMode
      ? '每天最多执行一次建筑行动，可选择为缺料分段备料、施工一个分段或休息。'
      : '并选择每天最多施工一个分段。'}暂停、撤销或窗口到期会停止这项授权。</p>}
    {(houseSupplySelectable || houseSupplyMode) && <p className="cp-hint">备料限用背包里的 1 根自然橡木或云杉原木，合成 4 块同种木板，并保留至少 2 根同种原木。</p>}
    {visitStatus && (choice !== 'patrol' || !patrol) && (choice !== 'gather' || !gather) && <p className="cp-hint" aria-live="polite">{readFailed || !today?.visitStatus ? '最近短访状态 · ' : '短访状态 · '}{VISIT_STATUS[visitStatus]}</p>}
    {patrol && <p className="cp-hint" aria-live="polite">最近巡视 · {PATROL_STATUS[patrol.status]} · 已确认 {patrol.completedSegments}/{patrol.totalSegments} 段 · {VISIT_STATUS[patrol.visitStatus]}</p>}
    {gather && <p className="cp-hint" aria-live="polite">最近采集 · {GATHER_STATUS[gather.status]} · 已核验 {gather.collected} 根 · {VISIT_STATUS[gather.visitStatus]}</p>}
    {failure && <p className="cp-error" role="alert">{failure}</p>}
    {rule ? <>
      <p><strong>{zones.find(zone => zone.id === rule.zoneId)?.name ?? (rule.houseProjectId ? '已选区域' : '已选营地')}</strong> · 每天 {rule.start}–{rule.end} · {rule.timeZone}</p>
      <p className="cp-hint">授权于 {localStamp(rule.expiresAt, rule.timeZone)} 到期。</p>
      {rule.houseProjectId && <p className="cp-hint" aria-live="polite">指定建筑 · {authorizedHouse ? authorizedHouse.name : '暂时读不到原项目'}
        {authorizedHouse && <> · 已核验 {authorizedHouse.sections.filter(section => section.status === 'built').length}/{authorizedHouse.sections.length} 段</>}
        {houseSupplyMode && ' · 已授权备料'}
      </p>}
      {rule.allowMinecraftProject && project && <div className="cp-hint" aria-live="polite">
        <p>营地项目 · {PROJECT_STAGE[project.stage]} · 已确认补给 {project.supplyVisits} 次</p>
        {projectGatherCount !== undefined && Number.isInteger(projectGatherCount) && projectGatherCount >= 0 && projectGatherCount <= 7 &&
          <p>项目累计核验采集 {projectGatherCount} 根橡木</p>}
        {project.stage === 'needs-review' && <p>上次施工未完整确认，或复查时发现营地变化。</p>}
        {project.builtAt && <p>建造于 {localStamp(Date.parse(project.builtAt), rule.timeZone)}</p>}
        {project.revisitedAt && <p>复查于 {localStamp(Date.parse(project.revisitedAt), rule.timeZone)}</p>}
      </div>}
      {today && <p className="cp-hint">{today.date} 的开放时段为 {localStamp(today.opensAt, rule.timeZone)} 至 {localStamp(today.closesAt, rule.timeZone)}。</p>}
      {choiceMode && choice && <p className="cp-hint">{completedHouseSupply ?? completedVisit ?? CHOICE[choice]}</p>}
      {todayTask && <p className="cp-hint"><a href={`#minecraft-task-${todayTask.id}`}>{taskLink}</a></p>}
      <button className="cp-button" type="button" disabled={disabled} onClick={() => { void update() }}>{choiceMode ? '撤销每日活动授权' : '撤销定时勘察'}</button>
    </> : eligible.length ? <form onSubmit={authorize}>
      <p className="cp-hint">按宿主本地时间填写同一天内的开始和结束时间，间隔为 30–180 分钟。当天窗口已结束时，授权从次日开始。</p>
      <div className="cp-actions">
        <label className="cp-row">{houseProjectAvailable ? '授权区域' : '营地'} <select className="cp-input" required value={validZone ? zoneId : ''} disabled={disabled} onChange={event => {
          setZoneId(event.target.value)
          setHouseProjectId('')
          setAllowHouseProjectSupply(false)
        }}>
          <option value="">{houseProjectAvailable ? '选择授权区域' : '选择营地'}</option>{eligible.map(zone => <option key={zone.id} value={zone.id}>{zone.name} · 半径 {zone.radius} 格</option>)}
        </select></label>
        <label className="cp-row">开始 <input className="cp-input" type="time" value={start} required disabled={disabled} onChange={event => {
          setStart(event.target.value)
          setAllowHouseProjectSupply(false)
        }} /></label>
        <label className="cp-row">结束 <input className="cp-input" type="time" value={end} required disabled={disabled} onChange={event => {
          setEnd(event.target.value)
          setAllowHouseProjectSupply(false)
        }} /></label>
        <label className="cp-row">有效天数 <select className="cp-input" value={days} disabled={disabled} onChange={event => {
          setDays(Number(event.target.value))
          setAllowHouseProjectSupply(false)
        }}>
          {[1, 2, 3, 4, 5, 6, 7].map(day => <option key={day} value={day}>{day} 天</option>)}
        </select></label>
      </div>
      {dailyChoiceAvailable && <p><label className="cp-row"><input type="checkbox" checked={allowBilibili} disabled={disabled || readFailed}
        onChange={event => setAllowBilibili(event.target.checked)} />允许她从营地勘察和 B 站浏览中选择</label></p>}
      {campVisitAvailable && <p><label className="cp-row"><input type="checkbox" checked={allowMinecraftLogin} disabled={disabled || readFailed}
        onChange={event => {
          const allowed = event.target.checked
          setAllowMinecraftLogin(allowed)
          if (!allowed) {
            setAllowMinecraftSupply(false)
            setAllowMinecraftBuild(false)
            clearProjectChoice()
            setAllowMinecraftPatrol(false)
            setAllowMinecraftGather(false)
          }
        }} />允许她自行进服并在短访后下线</label></p>}
      {campVisitSupplyAvailable && <p><label className="cp-row"><input type="checkbox" checked={chooseSupply} disabled={disabled || readFailed || !chooseVisit}
        onChange={event => {
          setAllowMinecraftSupply(event.target.checked)
          if (!event.target.checked) clearProjectChoice()
        }} />允许短访时限量补给营地</label></p>}
      {campVisitBuildAvailable && <p><label className="cp-row"><input type="checkbox" checked={chooseBuild} disabled={disabled || readFailed || !chooseVisit}
        onChange={event => {
          setAllowMinecraftBuild(event.target.checked)
          if (!event.target.checked) clearProjectChoice()
        }} />允许短访时限量建造营地</label></p>}
      {campVisitProjectAvailable && <p><label className="cp-row"><input type="checkbox" checked={chooseProject} disabled={disabled || readFailed || !chooseSupply || !chooseBuild}
        onChange={event => {
          if (event.target.checked) setAllowMinecraftProject(true)
          else clearProjectChoice()
        }} />允许她分多天推进营地项目</label></p>}
      {campPatrolAvailable && <p><label className="cp-row"><input type="checkbox" checked={choosePatrol} disabled={disabled || readFailed || !chooseVisit}
        onChange={event => setAllowMinecraftPatrol(event.target.checked)} />允许短访时巡视营地</label></p>}
      {campGatherAvailable && <p><label className="cp-row"><input type="checkbox" checked={chooseGather} disabled={disabled || readFailed || !chooseVisit}
        onChange={event => {
          setAllowMinecraftGather(event.target.checked)
          if (!event.target.checked) setAllowMinecraftProjectGather(false)
        }} />允许短访采集一根自然橡木并回营</label></p>}
      {campVisitProjectGatherAvailable && <p><label className="cp-row"><input type="checkbox" checked={chooseProjectGather} disabled={disabled || readFailed || !chooseProject || !chooseGather}
        onChange={event => setAllowMinecraftProjectGather(event.target.checked)} />允许跨日营地项目安排采集</label></p>}
      {(houseProjectAvailable || houseProjectId) && <p><label className="cp-row">允许续建的建筑
        <select className="cp-input" value={houseProjectId} disabled={disabled || readFailed || !validZone}
          onChange={event => {
            setHouseProjectId(event.target.value)
            setAllowHouseProjectSupply(false)
          }}>
          <option value="">不授权建筑续建</option>
          {houseProjectId && !chooseHouseProject && <option value={houseProjectId}>原选择已不可用</option>}
          {houseChoices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>{houseProjectAvailable && validZone && !houseChoices.length && <span className="cp-hint">
        {houseProjects ? '这个区域没有待施工的建筑项目。' : '暂未读到这个区域的建筑项目。'}
      </span>}</p>}
      {houseSupplySelectable && <p><label className="cp-row"><input type="checkbox" checked={chooseHouseProjectSupply}
        disabled={disabled || readFailed} onChange={event => setAllowHouseProjectSupply(event.target.checked)} />允许她为指定建筑限量备料</label></p>}
      {!validTime && <p className="cp-hint">请选择同一天内相隔 30–180 分钟的时间。</p>}
      <div className="cp-actions"><button className="cp-button" type="submit" disabled={disabled || readFailed || !validZone || !validTime || !validHouseChoice}>{showChoice ? '授权每日自主活动' : '授权定时勘察'}</button></div>
    </form> : <div className="cp-empty">先授权一个半径至少 {SURVEY_MIN_RADIUS} 格的营地。</div>}
  </section>
}
