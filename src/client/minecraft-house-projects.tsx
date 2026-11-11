import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MINECRAFT_HOUSE_BLOCKS, minecraftHouseCells, minecraftHouseMaterials, type MinecraftHouseLayout } from '../core/minecraft-house.ts'
import { MinecraftHouseProjectInput, PROJECT_MAX_SECTIONS, PROJECT_MIN_SECTIONS, PROJECT_SECTION_OFFSET_LIMIT,
  type MinecraftHouseProject, type MinecraftHouseProjectSitePreview, type MinecraftHouseProjectsView } from '../core/minecraft-house-project.ts'
import { MinecraftHouseProjectImportInput, type MinecraftHouseProjectImportPreview } from '../core/minecraft-house-project-import.ts'
import type { MinecraftView } from '../protocol/api.ts'
import { buildMinecraftHouseProjectSection, createMinecraftHouseProject, getMinecraftHouseProjects,
  previewMinecraftHouseProjectImport, previewMinecraftHouseProjectSection, verifyMinecraftHouseProject, nameMinecraftHouseProjectPlace } from './api.ts'
import { HOUSE_BLOCK_LABELS, HOUSE_PREVIEW_TTL_MS, HouseMaterialShortage, houseSiteReason } from './minecraft-houses.tsx'

type Section = MinecraftHouseProject['sections'][number]
type Operation = 'create' | 'import-preview' | 'preview' | 'build' | 'verify' | 'place'
type BlueprintFormat = 'whole' | 'sections'
interface SiteCheck {
  projectId: string
  index: number
  status: Section['status']
  expiresAt: number
  result: MinecraftHouseProjectSitePreview
}

const SECTION_STATUS: Record<Section['status'], string> = {
  pending: '待预检', running: '施工中', interrupted: '施工中断', built: '该段已核验',
}
const PROJECT_ERRORS: Readonly<Record<string, string>> = {
  'minecraft-house-project-import-unsplittable': '整栋蓝图无法拆成现有施工器能处理的分段。请缩小尺寸、调整留空，或导入已拆好的分段蓝图。',
  'minecraft-house-project-zone-invalid': '授权区域容不下各段蓝图及其施工站位。请检查分段偏移和区域半径。',
  'minecraft-house-project-preview-required': '这段的预检已失效，请重新核对现场。',
  'minecraft-house-project-unavailable': '当前连接或角色状态暂不能施工。',
  'minecraft-house-project-incomplete': '所有分段都核验通过后，才能进行整栋验收。',
  'minecraft-house-project-busy': '大肥鱼正忙，等当前施工或核对结束后再试。',
  'minecraft-house-project-not-found': '找不到建筑项目。请刷新项目状态。',
  'minecraft-house-project-section-not-found': '找不到施工段。请刷新项目状态。',
  'minecraft-house-project-verification-unconfirmed': '游戏服没有返回完整的整栋核对结果，请重新验收。',
  'minecraft-place-verification-required': '整栋验收通过后才能命名地点。',
  'minecraft-place-name-conflict': '这个地点名已被使用，请换一个名字。',
  'build-zone-not-found': '施工区授权已失效。',
}

function blueprintSize({ width, depth, height }: Pick<MinecraftHouseLayout, 'width' | 'depth' | 'height'>) {
  return `宽 ${width} × 深 ${depth} × 高 ${height} 格`
}

function projectDimensions(sections: MinecraftHouseProject['sections']) {
  const corners = sections.map(({ offset, layout }) => {
    const x = offset.x - Math.floor(layout.width / 2)
    const z = offset.z - Math.floor(layout.depth / 2)
    return { x, z, y: offset.y, east: x + layout.width, south: z + layout.depth, top: offset.y + layout.height }
  })
  return {
    width: Math.max(...corners.map(corner => corner.east)) - Math.min(...corners.map(corner => corner.x)),
    depth: Math.max(...corners.map(corner => corner.south)) - Math.min(...corners.map(corner => corner.z)),
    height: Math.max(...corners.map(corner => corner.top)) - Math.min(...corners.map(corner => corner.y)),
  }
}

function exampleSections(): MinecraftHouseProjectInput['sections'] {
  return (['西屋', '东屋'] as const).map((name, index) => {
    const blocks = Array.from({ length: 100 }, (_, cell) => {
      const x = cell % 5, y = Math.floor(cell / 25), z = Math.floor(cell / 5) % 5
      if (y === 0) return 'o'
      if (y === 3) return 'c'
      if ((x === 2 && z === 0) || (z === 2 && x === (index === 0 ? 4 : 0))) return '.'
      if (z === 4 && x === 2) return 'g'
      return x === 0 || x === 4 || z === 0 || z === 4 ? 's' : '.'
    }).join('')
    return { name, offset: { x: index === 0 ? -2 : 3, y: 0, z: 0 }, layout: { width: 5, depth: 5, height: 4, blocks } }
  })
}

function exampleWholeLayout(): MinecraftHouseProjectImportInput['layout'] {
  const width = 10, depth = 10, height = 4
  const blocks = Array.from({ length: width * depth * height }, (_, cell) => {
    const x = cell % width, z = Math.floor(cell / width) % depth, y = Math.floor(cell / (width * depth))
    if ((x === 4 || x === 5) && (z === 4 || z === 5)) return '.'
    if (y === 0) return 'o'
    if (y === height - 1) return 'c'
    if (z === 0 && (x === 4 || x === 5)) return '.'
    if (z === depth - 1 && (x === 2 || x === 7)) return 'g'
    return x === 0 || x === width - 1 || z === 0 || z === depth - 1 ? 's' : '.'
  }).join('')
  return { width, depth, height, blocks }
}

function ImportPlan({ preview }: { preview: MinecraftHouseProjectImportPreview }) {
  const { project, materials, placed, checked } = preview
  return <section className="cp-house-recovery cp-house-import-plan" aria-label="自动分段预览">
    <h3>自动分段预览</h3>
    <p role="status">{project.sections.length} 个分区 · {checked} 格规划范围 · {placed} 块实体方块 · {checked - placed} 格留空</p>
    <p className="cp-hint cp-row cp-house-materials">
      <strong>整栋计划用料</strong>
      {Object.entries(MINECRAFT_HOUSE_BLOCKS).map(([symbol, block]) => {
        const count = materials[symbol as keyof typeof MINECRAFT_HOUSE_BLOCKS]
        return symbol !== '.' && !!count && <span key={symbol}>{HOUSE_BLOCK_LABELS[block].name} {count}</span>
      })}
    </p>
    <ol aria-label="自动划分的施工分区">
      {project.sections.map(({ name, layout, offset }, index) => <li key={index}>
        <strong>{name}</strong>
        <p>{blueprintSize(layout)} · 相对授权区中心 ({offset.x}, {offset.y}, {offset.z})</p>
        <p className="cp-hint cp-row cp-house-materials">
          {Object.entries(minecraftHouseMaterials(layout)).map(([block, count]) =>
            <span key={block}>{HOUSE_BLOCK_LABELS[block as keyof typeof HOUSE_BLOCK_LABELS].name} {count}</span>)}
        </p>
      </li>)}
    </ol>
    <p className="cp-hint">这里只核对蓝图与授权范围。保存后可逐段查看，开工前还需预检现场并确认。</p>
  </section>
}

function ProjectSectionBlueprint({ layout }: { layout: MinecraftHouseLayout }) {
  const [layer, setLayer] = useState(0)
  const cells = minecraftHouseCells(layout).filter(cell => cell.y === layer)
  const materials = minecraftHouseMaterials(layout)
  return <div>
    <div className="cp-actions" role="group" aria-label="施工段层数">
      {Array.from({ length: layout.height }, (_, index) => <button className="cp-button" type="button" key={index}
        aria-pressed={layer === index} data-primary={layer === index} onClick={() => setLayer(index)}>第 {index + 1} 层</button>)}
    </div>
    <p className="cp-label">北 ↑ · 东 →</p>
    <div className="cp-house-grid" role="img" aria-label={`施工段第 ${layer + 1} 层俯视图，北向朝上`}
      style={{ gridTemplateColumns: `repeat(${layout.width}, minmax(0, 1fr))` }}>
      {cells.map(cell => {
        const label = HOUSE_BLOCK_LABELS[cell.block]
        return <span className="cp-house-cell" data-block={cell.block} key={cell.z * layout.width + cell.x} aria-hidden="true"
          title={`${label.name}（向东 ${cell.x}，向南 ${cell.z}）`}>{label.mark}</span>
      })}
    </div>
    <p className="cp-hint cp-row cp-house-materials"><span>本段蓝图用料</span>
      {Object.entries(materials).map(([block, count]) =>
        <span key={block}>{HOUSE_BLOCK_LABELS[block as keyof typeof HOUSE_BLOCK_LABELS].name} {count}</span>)}
    </p>
  </div>
}

function ProjectNextStep({ project, duplicateName, canRequest, canSelect, selectSection }: {
  project: MinecraftHouseProject
  duplicateName: boolean
  canRequest: boolean
  canSelect: boolean
  selectSection: (index: number) => void
}) {
  const [copyResult, setCopyResult] = useState<'copied' | 'failed'>()
  const plan = project.plan
  if (!plan && !canRequest) return null
  const selected = plan?.section
  const option = plan?.options.find(item => item.section === selected)
  const snapshotChanged = plan?.options.some(item => {
    const section = project.sections[item.section]
    return !section || section.status !== item.status || section.reason !== item.previousReason
  })
  const historical = !canRequest || snapshotChanged
  const title = plan?.action === 'build' && option ? `建议${option.recovery ? '换站位续建' : '先建'}「${option.name}」`
    : plan?.action === 'prepare' && option ? `建议先为「${option.name}」备料`
      : option ? `建议暂缓「${option.name}」` : '建议先等等'
  const reference = `「${project.name}」${duplicateName ? ` #${project.id}` : ''}`
  const request = `请帮我选 Minecraft 建筑工程${reference}的下一段`
  const copyRequest = async () => {
    try { await navigator.clipboard.writeText(request); setCopyResult('copied') }
    catch { setCopyResult('failed') }
  }
  return <section className="cp-house-recovery" aria-label="大肥鱼的下一步建议" style={{ overflowWrap: 'anywhere' }}>
    <h3>大肥鱼的下一步建议</h3>
    {plan ? <>
      <p><strong>{title}</strong>{historical && ' · 历史建议'}</p>
      <p>{plan.reason}</p>
      <p className="cp-hint">
        {'现场观察始于 '}<time dateTime={plan.observedAt}>{new Date(plan.observedAt).toLocaleString('zh-CN')}</time>
        {option?.ready && ' · 当时预检通过'}
        {option?.reason && ` · ${houseSiteReason(option.reason) ?? '当时预检未通过'}`}
      </p>
      {option?.previousReason && option.previousReason !== option.reason && <p className="cp-hint">
        上次施工中断。{houseSiteReason(option.previousReason) ?? '请核对角色和现场状态。'}
      </p>}
      {!!option?.materials?.length && <HouseMaterialShortage key={plan.recordedAt} materials={option.materials} />}
      <p className="cp-hint">
        {historical ? '现场或授权状态已变化，或暂时无法读取。这里保留当时的建议。' : '施工前请重新预检，再确认本段开工。'}
      </p>
      {!historical && canSelect && option && selected !== undefined && <button className="cp-button" type="button"
        onClick={() => selectSection(selected)}>查看建议施工段</button>}
    </> : <p className="cp-hint">还没有建议。可在聊天中请她根据现场情况选择下一步。</p>}
    {canRequest && <div className="cp-stack">
      <label className="cp-field">聊天请求
        <input className="cp-input" readOnly value={request} onFocus={event => event.currentTarget.select()} />
      </label>
      {typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function' && <div className="cp-row">
        <button className="cp-button" type="button" onClick={() => { void copyRequest() }}>复制聊天请求</button>
        <span className="cp-hint" role="status">{copyResult === 'copied' ? '已复制聊天请求。'
          : copyResult === 'failed' ? '可手动选中聊天请求并复制。' : ''}</span>
      </div>}
    </div>}
  </section>
}

export function MinecraftHouseProjects({ zones, busy }: { zones: MinecraftView['buildZones']; busy: boolean }) {
  const [view, setView] = useState<MinecraftHouseProjectsView>()
  const [readFailed, setReadFailed] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [sectionChoice, setSectionChoice] = useState<{ projectId: string; index: number }>()
  const [check, setCheck] = useState<SiteCheck>()
  const [pending, setPending] = useState<Operation>()
  const [failure, setFailure] = useState<string>()
  const [name, setName] = useState('')
  const [placeName, setPlaceName] = useState('')
  const [importZone, setImportZone] = useState('')
  const [blueprintFormat, setBlueprintFormat] = useState<BlueprintFormat>('whole')
  const [blueprints, setBlueprints] = useState<Record<BlueprintFormat, string>>({ whole: '', sections: '' })
  const [importPlan, setImportPlan] = useState<{ result: MinecraftHouseProjectImportPreview; zoneUpdatedAt: string }>()
  const mutating = useRef(false)
  const epoch = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    let polling = false
    let unsupported = false
    const refresh = async () => {
      if (polling || unsupported || mutating.current || document.hidden) return
      const expected = epoch.current
      polling = true
      try {
        const result = await getMinecraftHouseProjects(controller.signal)
        if (controller.signal.aborted || expected !== epoch.current) return
        unsupported = result === undefined
        setView(result)
        setReadFailed(false)
      } catch {
        if (!controller.signal.aborted && expected === epoch.current) {
          setReadFailed(true)
          setCheck(undefined)
        }
      } finally { polling = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])

  const project = view?.projects.find(item => item.id === projectId) ?? view?.projects[0]
  const zone = zones.find(item => item.id === project?.zoneId)
  const nextIndex = project?.sections.findIndex(item => item.status === 'pending' || item.status === 'interrupted') ?? -1
  const selectedIndex = project?.id === sectionChoice?.projectId ? sectionChoice?.index ?? 0 : Math.max(0, nextIndex)
  const section = project?.sections[selectedIndex]
  const builtCount = project?.sections.filter(item => item.status === 'built').length ?? 0
  const projectRunning = project?.sections.some(item => item.status === 'running') ?? false
  const interactive = !busy && !pending
  const canImport = interactive && !readFailed
  const importArea = zones.find(item => item.id === importZone && !item.revokedAt)
  const blueprint = blueprints[blueprintFormat]
  const validImportPlan = importArea && importPlan?.zoneUpdatedAt === importArea.updatedAt ? importPlan.result : undefined
  const canWork = interactive && !!zone && view?.available && !readFailed && !projectRunning
  const canName = interactive && !!zone && !readFailed && !projectRunning && project?.verification?.matched === true
  const canBuildSection = canWork && (section?.status === 'pending' || section?.status === 'interrupted')
  const site = check && project?.id === check.projectId && selectedIndex === check.index &&
    section?.status === check.status && zone && view?.available && !readFailed && !busy && !projectRunning ? check : undefined
  const confirmation = site?.result.ready && site.expiresAt > Date.now() ? site.result.previewId : undefined
  const canVerify = canWork && !!project && builtCount === project.sections.length
  const chooseSection = (index: number) => {
    if (!project || !interactive) return
    setSectionChoice({ projectId: project.id, index })
    setCheck(undefined)
    setFailure(undefined)
  }

  useEffect(() => {
    if (!check?.result.ready || !check.expiresAt) return
    const timer = setTimeout(() => setCheck(current => current === check
      ? { ...current, expiresAt: 0 } : current), Math.max(0, check.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [check])
  useEffect(() => {
    if (check && !site) setCheck(undefined)
  }, [check, site])
  useEffect(() => {
    setPlaceName(project?.place?.name ?? '')
  }, [project?.id, project?.place?.name])

  const execute = async (operation: Operation, action: () => Promise<void>) => {
    if (mutating.current) return
    mutating.current = true
    epoch.current++
    if (operation !== 'import-preview') setCheck(undefined)
    setFailure(undefined)
    setPending(operation)
    try { await action() }
    catch (error) {
      const reason = error instanceof Error && (houseSiteReason(error.message) ||
        (Object.hasOwn(PROJECT_ERRORS, error.message) && PROJECT_ERRORS[error.message]))
      setFailure(reason || (operation === 'create' ? '宿主未保存蓝图，请检查分段位置与授权区。输入已保留。'
        : operation === 'import-preview' ? '蓝图预览未完成。输入已保留。'
          : operation === 'preview' ? '现场预检未完成。' : operation === 'verify' ? '整栋验收未完成，请刷新后重试。'
          : operation === 'place' ? '地点名未保存，请核对整栋验收、授权和名称后重试。'
          : '暂时收不到施工结果，请刷新状态，再决定是否重新预检。'))
    } finally { mutating.current = false; setPending(undefined) }
  }

  const storeProject = (result: MinecraftHouseProject) => setView(current => {
    if (!current) return current
    const projects = current.projects.some(item => item.id === result.id)
      ? current.projects.map(item => item.id === result.id ? result : item) : [result, ...current.projects]
    return { ...current, projects }
  })

  const clearImportPlan = () => {
    setImportPlan(undefined)
    setFailure(undefined)
  }

  const saveProject = (input: MinecraftHouseProjectInput) => {
    void execute('create', async () => {
      const saved = await createMinecraftHouseProject(input)
      storeProject(saved)
      setProjectId(saved.id)
      setSectionChoice(undefined)
      setName('')
      setBlueprints(current => ({ ...current, [blueprintFormat]: '' }))
      setImportPlan(undefined)
    })
  }

  const importProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canImport || !importArea) return
    clearImportPlan()
    let parsed: unknown
    try { parsed = JSON.parse(blueprint) }
    catch { setFailure('蓝图需要使用有效的 JSON，请检查括号和引号。'); return }
    if (blueprintFormat === 'sections') {
      const result = MinecraftHouseProjectInput.safeParse({ name, zoneId: importArea.id, sections: parsed })
      if (!result.success) {
        setFailure('请检查分段尺寸、方块序列和偏移，整栋应是连续长方体且超过 100 个实体方块。')
        return
      }
      saveProject(result.data)
      return
    }
    const layout = parsed && typeof parsed === 'object' && 'blocks' in parsed && typeof parsed.blocks === 'string'
      ? { ...parsed, blocks: parsed.blocks.replace(/\s+/gu, '') } : parsed
    const result = MinecraftHouseProjectImportInput.safeParse({ name, zoneId: importArea.id, layout })
    if (!result.success) {
      setFailure('请检查整栋蓝图的 width、depth、height 和 blocks。方块序列应铺满长方体，包含 101～600 个实体方块，总计最多 750 格。')
      return
    }
    void execute('import-preview', async () => {
      const resultPreview = await previewMinecraftHouseProjectImport(result.data)
      setImportPlan({ result: resultPreview, zoneUpdatedAt: importArea.updatedAt })
    })
  }

  const run = (operation: Exclude<Operation, 'create' | 'import-preview'>) => {
    if (!project || !section || (operation === 'verify' ? !canVerify : !canBuildSection)) return
    if (operation === 'build' && (!confirmation || !site || site.expiresAt <= Date.now())) return
    setProjectId(project.id)
    setSectionChoice({ projectId: project.id, index: selectedIndex })
    void execute(operation, async () => {
      if (operation === 'preview') {
        const started = Date.now()
        const result = await previewMinecraftHouseProjectSection(project.id, selectedIndex)
        setCheck({ projectId: project.id, index: selectedIndex, status: section.status, expiresAt: started + HOUSE_PREVIEW_TTL_MS, result })
      } else if (operation === 'build' && confirmation) {
        storeProject(await buildMinecraftHouseProjectSection(project.id, selectedIndex, confirmation))
      } else if (operation === 'verify') {
        storeProject(await verifyMinecraftHouseProject(project.id))
      }
    })
  }

  if (!view && !readFailed) return null
  const materials = site?.result.ready === false ? site.result.materials : undefined
  const verification = project?.verification
  const unmatchedSections = verification?.unmatchedSections.map(index => project?.sections[index]?.name).filter(Boolean)
  return <section className="cp-card" aria-label="分段建筑">
    <div className="cp-row cp-between">
      <h2>分段建筑</h2>
      {project && <span className="cp-status" data-state={verification?.matched ? 'succeeded' : verification ? 'failed' : 'planned'}>
        {verification?.matched ? '整栋已验收' : verification ? '整栋核对有差异' : `已核验 ${builtCount} / ${project.sections.length} 段`}
      </span>}
    </div>
    {readFailed && <p className="cp-hint" role="status">暂时读不到最新项目状态。</p>}
    {view && !project && <p className="cp-hint">导入整栋或已拆分的蓝图，在同一授权区逐段预检、施工，再核对整栋。</p>}
    {project && section && <>
      <label className="cp-field">建筑项目
        <select className="cp-select" value={project.id} disabled={!interactive} onChange={event => {
          setProjectId(event.target.value)
          setSectionChoice(undefined)
          setCheck(undefined)
          setFailure(undefined)
        }}>{view?.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </label>
      <p className="cp-hint">
        {zone ? `授权区 ${zone.name} · 半径 ${zone.radius} 格` : '原施工区授权已失效，仍可查看历史进度。'}
        {' · '}{blueprintSize(projectDimensions(project.sections))} · 蓝图共 {project.sections.reduce((total, item) => total + item.layout.blocks.replaceAll('.', '').length, 0)} 块
      </p>
      <ProjectNextStep key={project.id} project={project}
        duplicateName={!!view?.projects.some(item => item.id !== project.id && item.name === project.name)}
        canRequest={!!zone && !!view?.available && !readFailed && nextIndex >= 0}
        canSelect={!!canWork} selectSection={chooseSection} />
      <div className="cp-actions" role="group" aria-label="施工分段">
        {project.sections.map((item, index) => <button className="cp-button cp-house-project-section" type="button" key={index}
          aria-pressed={index === selectedIndex} data-primary={index === selectedIndex} disabled={!interactive}
          onClick={() => chooseSection(index)}>
          {index + 1}. {item.name} · {pending === 'build' && index === selectedIndex ? '施工中' : SECTION_STATUS[item.status]}
        </button>)}
      </div>
      <p className="cp-hint">{blueprintSize(section.layout)} · 相对授权区中心 ({section.offset.x}, {section.offset.y}, {section.offset.z})</p>
      <ProjectSectionBlueprint key={`${project.id}:${selectedIndex}`} layout={section.layout} />
      {section.receipt && <p className="cp-hint">{section.receipt.recovery ? '站位恢复回执' : '本段回执'} · 核验 {section.receipt.checked} 格 · 放置 {section.receipt.placed} 块</p>}
      {section.status === 'interrupted' && <p className="cp-hint">
        {(section.reason && houseSiteReason(section.reason)) || '上次施工未取得完成回执。'}已放置的方块会保留，继续前请重新预检。
      </p>}
      {zone && !view?.available && <p className="cp-hint">当前无法预检、施工或验收，仍可查看项目。</p>}
      <div className="cp-actions">
        {(section.status === 'pending' || section.status === 'interrupted') && <>
          <button className="cp-button" type="button" disabled={!canBuildSection}
            onClick={() => run('preview')}>{pending === 'preview' ? '正在预检' : '预检本段'}</button>
          <button className="cp-button" type="button" data-primary={!!confirmation} disabled={!canBuildSection || !confirmation}
            onClick={() => run('build')}>{pending === 'build' ? '正在施工' : site?.result.recovery ? '确认本段续建' : '确认本段开工'}</button>
        </>}
        {builtCount === project.sections.length && <button className="cp-button" type="button" data-primary={canVerify}
          disabled={!canVerify} onClick={() => run('verify')}>{pending === 'verify' ? '正在验收整栋' : verification ? '重新验收整栋' : '验收整栋'}</button>}
      </div>
      {site && <p className="cp-hint" role="status">
        {confirmation ? `${site.result.recovery ? '续建站位预检通过' : '本段预检通过'} · 已核验 ${site.result.checked} 格`
          : site.result.ready ? '本段预检已失效，请重新预检。' : `本段预检未通过 · 已核验 ${site.result.checked} 格`}
        {!site.result.ready && site.result.reason && <>。{houseSiteReason(site.result.reason) ?? '请检查连接、角色状态和施工现场。'}</>}
      </p>}
      {confirmation && site?.result.recovery && <p className="cp-hint">确认后她会重新核对路线，补齐缺块并返回起点。</p>}
      {!!materials?.length && <HouseMaterialShortage key={selectedIndex} materials={materials} />}
      {verification && <p className="cp-hint" role="status">
        {verification.matched ? `整栋验收通过 · 核验 ${verification.checked} 格`
          : `整栋验收发现差异 · 涉及 ${unmatchedSections?.join('、') || '施工区'}。请核对并修正现场，再重新验收。`}
        {' · '}<time dateTime={verification.checkedAt}>{new Date(verification.checkedAt).toLocaleString('zh-CN')}</time>
      </p>}
      {verification?.matched && zone && <form className="cp-stack cp-house-recovery" aria-label="命名建筑地点" onSubmit={event => {
        event.preventDefault()
        if (!canName || !project) return
        void execute('place', async () => { storeProject(await nameMinecraftHouseProjectPlace(project.id, placeName)) })
      }}>
        <label className="cp-field">建筑地点名
          <input className="cp-input" required maxLength={40} value={placeName} disabled={!canName}
            placeholder="例如：橡木小院" onChange={event => setPlaceName(event.target.value)} />
        </label>
        <p className="cp-hint">保存整栋工程的授权区中心，不表示入口或当前站位。大肥鱼能在游戏中查看，也能通过共享记忆回忆。</p>
        <div><button className="cp-button" type="submit" disabled={!canName || !placeName.trim()}>
          {pending === 'place' ? '正在保存地点名' : project.place ? '更新地点名' : '保存地点名'}
        </button></div>
      </form>}
    </>}
    {failure && <p className="cp-error" role="alert">{failure}</p>}
    {view && <details className="cp-house-project-import">
      <summary>导入建筑蓝图</summary>
      <form className="cp-stack" onSubmit={importProject}>
        <label className="cp-field">蓝图格式
          <select className="cp-select" value={blueprintFormat} disabled={!canImport} onChange={event => {
            setBlueprintFormat(event.target.value === 'sections' ? 'sections' : 'whole')
            clearImportPlan()
          }}>
            <option value="whole">整栋蓝图 · 自动分段</option>
            <option value="sections">已有分段蓝图</option>
          </select>
        </label>
        <label className="cp-field">项目名称
          <input className="cp-input" value={name} maxLength={80} required disabled={!canImport} onChange={event => {
            setName(event.target.value)
            clearImportPlan()
          }} />
        </label>
        <label className="cp-field">施工授权区
          <select className="cp-select" required value={importArea?.id ?? ''} disabled={!canImport}
            onChange={event => {
              setImportZone(event.target.value)
              clearImportPlan()
            }}>
            <option value="">选择已授权区域</option>
            {zones.filter(item => !item.revokedAt).map(item => <option key={item.id} value={item.id}>{item.name} · 半径 {item.radius} 格</option>)}
          </select>
        </label>
        <label className="cp-field">{blueprintFormat === 'whole' ? '整栋蓝图 JSON' : '分段蓝图 JSON'}
          <textarea className="cp-textarea" required value={blueprint} spellCheck={false} disabled={!canImport}
            aria-describedby="cp-house-project-format-hint" onChange={event => {
              const value = event.target.value
              setBlueprints(current => ({ ...current, [blueprintFormat]: value }))
              clearImportPlan()
            }} />
        </label>
        <p className="cp-hint" id="cp-house-project-format-hint">
          {blueprintFormat === 'whole'
            ? <>填写宽 <code>width</code>、深 <code>depth</code>、高 <code>height</code> 和方块串 <code>blocks</code>。整栋最多 750 格，含 101～600 个实体方块。占地水平居中，底层与授权区中心同高。四合院示例建议选择半径 8 格的授权区。</>
            : <>共 {PROJECT_MIN_SECTIONS}～{PROJECT_MAX_SECTIONS} 段。相对中心偏移为 ±{PROJECT_SECTION_OFFSET_LIMIT} 格以内，x、z 表示该段中心，y 表示该段底层。两室示例建议选择半径 8 格的授权区。</>}
          {' '}方块从底层开始，每层从北到南，行内从西到东。<code>.</code> 留空，<code>o</code> 橡木，<code>s</code> 云杉，<code>c</code> 圆石，<code>g</code> 玻璃。
        </p>
        <div className="cp-row">
          <button className="cp-button" type="button" disabled={!canImport || !!blueprint.trim()} onClick={() => {
            const whole = blueprintFormat === 'whole'
            if (!name.trim()) setName(whole ? '四合院' : '双房间小屋')
            setBlueprints(current => ({ ...current, [blueprintFormat]: JSON.stringify(whole ? exampleWholeLayout() : exampleSections(), null, 2) }))
            clearImportPlan()
          }}>{blueprintFormat === 'whole' ? '填入四合院示例' : '填入双房间示例'}</button>
          <button className="cp-button" type="submit" data-primary={!validImportPlan}
            disabled={!canImport || !importArea || !name.trim() || !blueprint.trim()}>
            {blueprintFormat === 'sections' ? pending === 'create' ? '正在保存' : '保存项目草案'
              : pending === 'import-preview' ? '正在拆分蓝图' : validImportPlan ? '重新预览分段' : '预览自动分段'}
          </button>
        </div>
        {blueprintFormat === 'whole' && validImportPlan && <>
          <ImportPlan preview={validImportPlan} />
          <div className="cp-row">
            <button className="cp-button" type="button" data-primary disabled={!canImport}
              onClick={() => { if (canImport) saveProject(validImportPlan.project) }}>
              {pending === 'create' ? '正在保存' : '保存项目草案'}
            </button>
          </div>
        </>}
      </form>
    </details>}
  </section>
}
