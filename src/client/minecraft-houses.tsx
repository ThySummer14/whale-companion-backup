import { useEffect, useId, useRef, useState } from 'react'
import { MINECRAFT_HOUSE_BLOCKS, MinecraftHouseLayout, minecraftHouseCells, minecraftHouseMaterials,
  type MinecraftHouseDraft, type MinecraftHouseRevisionHistory, type MinecraftHousesView,
  type MinecraftHouseSitePreview, type MinecraftHouseSymbol } from '../core/minecraft-house.ts'
import type { MinecraftView } from '../protocol/api.ts'
import { buildMinecraftHouse, getMinecraftHouseReference, getMinecraftHouseRevisions, getMinecraftHouses,
  previewMinecraftHouse, reviseMinecraftHouse } from './api.ts'
import { MinecraftRecoveryOutcome } from './minecraft-recovery.tsx'

const HOUSE_STATUS: Record<MinecraftHouseDraft['status'], string> = {
  draft: '待预检', running: '施工中', built: '已验收', interrupted: '已中断，可重新预检',
}
export const HOUSE_BLOCK_LABELS = {
  air: { name: '留空', mark: '·' },
  oak_planks: { name: '橡木木板', mark: '橡' },
  spruce_planks: { name: '云杉木板', mark: '杉' },
  cobblestone: { name: '圆石', mark: '石' },
  glass: { name: '玻璃', mark: '玻' },
  cherry_planks: { name: '樱花木板', mark: '樱' },
  pink_concrete: { name: '粉色混凝土', mark: '粉' },
  smooth_sandstone: { name: '平滑砂岩', mark: '砂' },
  dark_oak_planks: { name: '深色橡木木板', mark: '深' },
  lantern: { name: '灯笼', mark: '灯' },
  cherry_leaves: { name: '樱花树叶', mark: '叶' },
}
const SITE_REASONS: Readonly<Record<string, string>> = {
  'homebuild-materials': '背包里的施工材料不足。',
  'homebuild-obstructed': '现场有方块占用了蓝图位置。',
  'homebuild-unsafe-player': '角色当前状态不适合施工。',
  'homebuild-unsafe-stance': '现场缺少安全施工站位。',
  'homebuild-unreachable-placement': '部分蓝图位置超出安全施工距离。',
  'homebuild-no-recovery-route': '现场还没有可往返的续建站位。',
  'homebuild-visibility-changed': '施工站位的视线发生变化。',
  'homebuild-walk-obstructed': '施工路线受阻。',
  'homebuild-off-course': '角色离开了已核验的路线。',
  'homebuild-retreat-unconfirmed': '无法确认安全退路。',
  'homebuild-unavailable-cell': '部分位置未加载或超出可用范围。',
  'homebuild-unsupported': '部分方块缺少可用支撑。',
  'homebuild-zone-invalid': '当前授权区域容不下这份蓝图。',
  'homebuild-cancelled': '这次施工已取消。',
  'house-preconditions-changed': '施工前复核发现现场或材料发生了变化。',
  'house-world-unconfirmed': '无法核实放置后的方块。',
  'house-stance-unconfirmed': '无法核实角色的起点或返程位置。请核对站位后重新预检。',
  'house-ownership-unconfirmed': '无法确认仍由同一个角色进行施工。',
  'house-result-unconfirmed': '无法核实这次施工的结果。',
  'minecraft-camp-paused': '营地控制已暂停。',
  'minecraft-house-cancelled': '这次施工已取消。',
  'minecraft-house-unavailable': '当前连接或角色状态暂不能施工。',
  'minecraft-house-visit-busy': '她正在营地短访，请等这次短访结束。',
  'minecraft-house-revision-stale': '草案已经更新，请检查蓝图后重新预检。',
  'build-zone-not-found': '施工区授权已失效。',
}
export const HOUSE_PREVIEW_TTL_MS = 120_000

type HouseRecovery = NonNullable<MinecraftHouseDraft['recovery']>
const RECOVERY_NEXT: Record<HouseRecovery['next'], string> = {
  'check-materials': '重新预检以查看缺料，补齐后再核对一次。',
  'recheck-site': '检查同一授权区的遮挡、支撑和留空位置，再预检现场。',
  'replan-route': '检查施工通道和退路，确认角色在安全站位后重新预检。',
  'check-safety': '等角色停稳，确认周围安全和地块授权有效，再预检现场。',
}
const RECOVERY_VERIFICATION: Record<NonNullable<HouseRecovery['verification']>, string> = {
  ready: '自动复查通过。要继续施工，请重新预检并确认开工。',
  blocked: '自动复查发现施工条件尚未满足。',
  unavailable: '自动复查暂时无法完成。',
}

export function houseSiteReason(code: string) {
  return Object.hasOwn(SITE_REASONS, code) ? SITE_REASONS[code] : undefined
}

interface SiteCheck {
  draftId: string
  revision: number
  zoneId: string
  expiresAt: number
  result: MinecraftHouseSitePreview
}

interface DraftEditor {
  draftId: string
  revision: number
  base: string
  blocks: string
  undo: string[]
}

function editDraft(draft: MinecraftHouseDraft): DraftEditor {
  const blocks = draft.layout.blocks
  return { draftId: draft.id, revision: draft.revision ?? 0, base: blocks, blocks, undo: [] }
}

function HouseReference({ id }: { id: string }) {
  const [image, setImage] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    void getMinecraftHouseReference(id, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      setImage(url)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [id])
  return <figure className="cp-house-reference">
    <figcaption className="cp-label">聊天参考图</figcaption>
    {failed ? <p className="cp-hint" role="status">暂时读不到原图，仍可查看蓝图。</p>
      : image ? <img src={image} alt="这份小屋草案的聊天参考图" onError={() => setFailed(true)} />
      : <p className="cp-hint" role="status">正在读取参考图…</p>}
  </figure>
}

export function HouseMaterialShortage({ materials }: { materials: NonNullable<MinecraftHouseSitePreview['materials']> }) {
  const [copyResult, setCopyResult] = useState<'copied' | 'failed'>()
  const noteId = useId()
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText
  const copyShortage = async () => {
    try {
      const lines = materials.filter(row => row.missing > 0).map(row => `${HOUSE_BLOCK_LABELS[row.material].name} × ${row.missing}`)
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopyResult('copied')
    } catch { setCopyResult('failed') }
  }

  return <div className="cp-house-shortage">
    <table aria-describedby={noteId}>
      <caption>施工缺料</caption>
      <thead><tr><th scope="col">材料</th><th scope="col">待放置</th><th scope="col">背包覆盖</th><th scope="col">仍缺</th></tr></thead>
      <tbody>{materials.map(({ material, needed, carried, missing }) => <tr key={material}>
        <th scope="row">{HOUSE_BLOCK_LABELS[material].name}</th><td>{needed}</td><td>{carried}</td><td data-short={missing > 0}>{missing}</td>
      </tr>)}</tbody>
    </table>
    <p className="cp-hint" id={noteId}>本次预检只统计待放置的方块。补齐缺料后，请重新预检现场。</p>
    {canCopy && <div className="cp-row">
      <button className="cp-button" type="button" onClick={() => { void copyShortage() }}>复制缺料清单</button>
      <span className="cp-hint" role="status">{copyResult === 'copied' ? '已复制缺料清单。' : copyResult === 'failed' ? '无法复制，可从表格查看缺料数量。' : ''}</span>
    </div>}
  </div>
}

function HouseRecoveryNote({ recovery }: { recovery: HouseRecovery }) {
  const next = RECOVERY_NEXT[recovery.next]
  const checked = recovery.verification && RECOVERY_VERIFICATION[recovery.verification]
  return <section className="cp-house-recovery" aria-label="施工恢复建议">
    <div className="cp-row cp-between">
      <h3>上次施工中断</h3>
      <time className="cp-label" dateTime={recovery.at}>{new Date(recovery.at).toLocaleString()}</time>
    </div>
    <p>{houseSiteReason(recovery.reason) ?? '需要核对角色和现场状态。'}</p>
    {checked && <p className="cp-hint">{checked}</p>}
    {next && <p><strong>系统建议下一步</strong> {next}</p>}
    {recovery.agentDecision && <MinecraftRecoveryOutcome decision={recovery.agentDecision} />}
  </section>
}

export function MinecraftHouses({ zones, busy }: { zones: MinecraftView['buildZones']; busy: boolean }) {
  const [view, setView] = useState<MinecraftHousesView>()
  const [readFailed, setReadFailed] = useState(false)
  const [draftId, setDraftId] = useState('')
  const [zoneChoice, setZoneChoice] = useState<{ draftId: string; zoneId: string }>()
  const [layer, setLayer] = useState(0)
  const [orientation, setOrientation] = useState<'layer' | 'front' | 'left'>('layer')
  const [editor, setEditor] = useState<DraftEditor>()
  const [paint, setPaint] = useState<MinecraftHouseSymbol>('g')
  const [referenceDraftId, setReferenceDraftId] = useState<string>()
  const [historyDraftId, setHistoryDraftId] = useState<string>()
  const [historyVersion, setHistoryVersion] = useState<number>()
  const [history, setHistory] = useState<{ id: string; revision: number; result?: MinecraftHouseRevisionHistory }>()
  const [check, setCheck] = useState<SiteCheck>()
  const [pending, setPending] = useState<'preview' | 'build' | 'save' | 'reload'>()
  const [failed, setFailed] = useState<string>()
  const [editFailure, setEditFailure] = useState<'stale' | 'invalid' | 'unknown'>()
  const [notice, setNotice] = useState<string>()
  const viewEpoch = useRef(0)
  const mutating = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let polling = false
    let unsupported = false
    const refresh = async () => {
      if (polling || unsupported || mutating.current || document.hidden) return
      polling = true
      const expected = viewEpoch.current
      try {
        const next = await getMinecraftHouses(controller.signal)
        if (controller.signal.aborted || expected !== viewEpoch.current) return
        unsupported = next === undefined
        setView(next)
        setReadFailed(false)
      } catch {
        if (!controller.signal.aborted && expected === viewEpoch.current) setReadFailed(true)
      } finally { polling = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])

  const draft = view?.drafts.find(item => item.id === (editor?.draftId ?? draftId)) ?? (editor ? undefined : view?.drafts[0])
  const selectedId = draft?.id
  const draftRevision = draft?.revision ?? 0
  const historyOpen = !!selectedId && historyDraftId === selectedId
  useEffect(() => {
    if (!historyOpen || !selectedId) return
    const controller = new AbortController()
    void getMinecraftHouseRevisions(selectedId, controller.signal).then(result => {
      if (!controller.signal.aborted) setHistory({ id: selectedId, revision: draftRevision, result })
    }).catch(() => {
      if (!controller.signal.aborted) setHistory({ id: selectedId, revision: draftRevision })
    })
    return () => controller.abort()
  }, [historyOpen, selectedId, draftRevision])

  if (!view && !readFailed) return null
  const activeHistory = history?.id === selectedId && history?.revision === draftRevision ? history : undefined
  const historical = activeHistory?.result?.revisions.find(item => item.revision === historyVersion)
  const viewingHistory = historyOpen && historyVersion !== undefined
  const selectedZone = draft?.zoneId ?? (zoneChoice?.draftId === draft?.id ? zoneChoice?.zoneId : undefined)
  const zone = zones.find(item => item.id === selectedZone)
  const canInteract = !busy && !pending
  const canSwitch = canInteract && !editor
  const canWork = canSwitch && !viewingHistory && view?.available && !readFailed && !!zone && !!draft && (draft.status === 'draft' || draft.status === 'interrupted')
  const site = !editor && !viewingHistory && check?.draftId === draft?.id && check?.zoneId === zone?.id && check?.revision === draftRevision ? check : undefined
  const confirmation = site?.result.ready && site.expiresAt > Date.now() ? site.result.previewId : undefined
  const siteFailure = site?.result.ready === false && site.result.reason ? houseSiteReason(site.result.reason) : undefined
  const materials = !readFailed && view?.available && site?.result.ready === false && site.result.reason === 'homebuild-materials'
    ? site.result.materials : undefined
  const activeLayer = draft ? Math.min(layer, draft.layout.height - 1) : 0
  const referenceOpen = !!draft?.reference && referenceDraftId === draft.id
  const shownBlocks = viewingHistory ? historical?.blocks : editor?.blocks ?? draft?.layout.blocks
  const displayLayout = draft && shownBlocks !== undefined ? { ...draft.layout, blocks: shownBlocks } : undefined
  const layoutCells = displayLayout && minecraftHouseCells(displayLayout).map((cell, index) => ({ ...cell, index }))
  const visibleCells = orientation === 'front'
    ? layoutCells?.filter(cell => cell.z === 0).sort((left, right) => right.y - left.y || left.x - right.x)
    : orientation === 'left'
      ? layoutCells?.filter(cell => cell.x === 0).sort((left, right) => right.y - left.y || left.z - right.z)
      : layoutCells?.filter(cell => cell.y === activeLayer)
  const changeCount = editor ? [...editor.blocks].filter((block, index) => block !== editor.base[index]).length : 0
  const stale = !!editor && (editFailure === 'stale' || !draft || draft.status !== 'draft' || draftRevision !== editor.revision)
  const validEdit = !!draft && !!editor && MinecraftHouseLayout.safeParse({ ...draft.layout, blocks: editor.blocks }).success
  const canSave = canInteract && !viewingHistory && !!editor && !!changeCount && !stale && validEdit

  const run = async (operation: 'preview' | 'build') => {
    if (!canWork || !draft || !zone || mutating.current || operation === 'build' &&
      (!confirmation || !site || site.expiresAt <= Date.now())) return
    mutating.current = true
    viewEpoch.current++
    setDraftId(draft.id)
    setPending(operation)
    setCheck(undefined)
    setFailed(undefined)
    setNotice(undefined)
    try {
      if (operation === 'preview') {
        const started = Date.now()
        const result = await previewMinecraftHouse(draft.id, zone.id)
        setCheck({ draftId: draft.id, revision: draftRevision, zoneId: zone.id, expiresAt: started + HOUSE_PREVIEW_TTL_MS, result })
      } else if (confirmation) {
        const result = await buildMinecraftHouse(draft.id, zone.id, confirmation)
        setView(current => current && { ...current, drafts: current.drafts.map(item => item.id === result.id ? result : item) })
      }
    } catch (error) {
      const rejected = error instanceof Error && 'status' in error && error.status === 409
      const reason = error instanceof Error && houseSiteReason(error.message)
      setFailed(reason || (operation === 'preview' ? '现场预检未完成，请检查连接或授权后重试。'
        : rejected ? '施工未获确认，请查看草案状态并重新预检。' : '暂时收不到施工结果，请刷新草案状态。'))
    } finally { mutating.current = false; setPending(undefined) }
  }

  const save = async () => {
    if (!canSave || !editor || mutating.current) return
    mutating.current = true
    viewEpoch.current++
    setPending('save')
    setCheck(undefined)
    setEditFailure(undefined)
    try {
      const result = await reviseMinecraftHouse(editor.draftId, { expectedRevision: editor.revision, blocks: editor.blocks })
      setView(current => current && { ...current, drafts: current.drafts.map(item => item.id === result.id ? result : item) })
      setEditor(undefined)
      setReadFailed(false)
      setNotice('蓝图已保存，请按新版本重新预检。')
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? error.status : undefined
      setEditFailure(status === 404 || status === 409 ? 'stale' : status === 400 ? 'invalid' : 'unknown')
    } finally { mutating.current = false; setPending(undefined) }
  }

  const reloadEditor = async () => {
    if (!editor || mutating.current) return
    mutating.current = true
    viewEpoch.current++
    setPending('reload')
    setCheck(undefined)
    try {
      const latest = await getMinecraftHouses()
      if (!latest) throw new Error('house-draft-view-unavailable')
      const current = latest.drafts.find(item => item.id === editor.draftId)
      setView(latest)
      setReadFailed(false)
      setHistoryVersion(undefined)
      setEditFailure(undefined)
      setEditor(current?.status === 'draft' && latest.revisionsAvailable === true ? editDraft(current) : undefined)
      setNotice('已重新载入最新草案。')
    } catch {
      setReadFailed(true)
      setEditFailure(current => current ?? 'unknown')
    }
    finally { mutating.current = false; setPending(undefined) }
  }

  const changeCell = (index: number) => {
    setEditor(current => {
      if (!current || current.blocks[index] === paint) return current
      const blocks = current.blocks.slice(0, index) + paint + current.blocks.slice(index + 1)
      return { ...current, blocks, undo: [...current.undo.slice(-39), current.blocks] }
    })
  }

  const selectDraft = (id: string) => {
    setDraftId(id)
    setZoneChoice(undefined)
    setLayer(0)
    setOrientation('layer')
    setReferenceDraftId(undefined)
    setHistoryDraftId(undefined)
    setHistoryVersion(undefined)
    setCheck(undefined)
    setFailed(undefined)
    setNotice(undefined)
  }

  return <section className="cp-card" aria-label="参考图小屋">
    <div className="cp-row cp-between"><h2>参考图小屋</h2>
      {draft && <span className="cp-status" role="status" data-state={draft.status === 'built' ? 'succeeded' : 'planned'}>
        {pending === 'build' ? HOUSE_STATUS.running : HOUSE_STATUS[draft.status]}
      </span>}
    </div>
    {readFailed && <p className="cp-hint" role="status">暂时读不到最新草案状态。</p>}
    {notice && <p className="cp-hint" role="status">{notice}</p>}
    {view && !draft && !editor && <p className="cp-hint">可以在聊天里发一张参考图，请大肥鱼先保存小屋草案。</p>}
    {!draft && editor && <>
      <p className="cp-error" role="alert">暂时找不到这份草案，编辑内容仍保留。</p>
      <div className="cp-actions">
        <button className="cp-button" type="button" disabled={!!pending} onClick={() => setEditor(undefined)}>取消编辑</button>
        <button className="cp-button" type="button" disabled={!!pending} onClick={() => { void reloadEditor() }}>放弃本地修改并读取最新版本</button>
      </div>
    </>}
    {draft && <>
      <label className="cp-field">小屋草案
        <select className="cp-select" value={draft.id} disabled={!canSwitch} onChange={event => selectDraft(event.target.value)}>
          {view?.drafts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <p className="cp-hint">宽 {draft.layout.width} × 深 {draft.layout.depth} × 高 {draft.layout.height} 格{draft.reference && ' · 来自聊天参考图'}{draftRevision > 0 && ` · 版本 ${draftRevision}`}</p>
      <div className="cp-actions" role="group" aria-label="小屋层数">
        {Array.from({ length: draft.layout.height }, (_, index) => <button className="cp-button" type="button" key={index}
          aria-pressed={orientation === 'layer' && activeLayer === index} data-primary={orientation === 'layer' && activeLayer === index} onClick={() => {
            setDraftId(draft.id)
            setOrientation('layer')
            setLayer(index)
          }}>第 {index + 1} 层</button>)}
        <button className="cp-button" type="button" aria-pressed={orientation === 'front'} data-primary={orientation === 'front'}
          onClick={() => setOrientation('front')}>正面</button>
        <button className="cp-button" type="button" aria-pressed={orientation === 'left'} data-primary={orientation === 'left'}
          onClick={() => setOrientation('left')}>左侧</button>
        {draft.reference && <button className="cp-button" type="button" aria-expanded={referenceOpen}
          onClick={() => setReferenceDraftId(referenceOpen ? undefined : draft.id)}>{referenceOpen ? '收起参考图' : '对照参考图'}</button>}
        {view?.revisionsAvailable === true && draftRevision > 0 && <button className="cp-button" type="button" aria-expanded={historyOpen}
          disabled={!!pending}
          onClick={() => {
            setHistoryVersion(undefined)
            setHistoryDraftId(historyOpen ? undefined : draft.id)
          }}>{historyOpen ? '收起版本记录' : '版本记录'}</button>}
        {!editor && view?.revisionsAvailable === true && draft.status === 'draft' && <button className="cp-button" type="button"
          disabled={!canInteract || viewingHistory || readFailed} onClick={() => {
            setDraftId(draft.id)
            setEditFailure(undefined)
            setNotice(undefined)
            setCheck(undefined)
            setEditor(editDraft(draft))
          }}>修改蓝图</button>}
      </div>
      {historyOpen && (!activeHistory ? <p className="cp-hint" role="status">正在读取版本记录…</p>
        : activeHistory.result ? <label className="cp-field cp-house-history">查看历史版本
          <select className="cp-select" value={historyVersion ?? ''} disabled={!!pending}
            onChange={event => setHistoryVersion(event.target.value === '' ? undefined : Number(event.target.value))}>
            <option value="">{editor ? '返回当前编辑' : '当前版本'}</option>
            {activeHistory.result.revisions.filter(item => item.revision < draftRevision).map(item => <option key={item.revision} value={item.revision}>
              {item.revision === 0 ? '原始蓝图' : `版本 ${item.revision}`} · {new Date(item.createdAt).toLocaleString()}
            </option>)}
          </select>
        </label> : <p className="cp-hint" role="status">暂时读不到版本记录。</p>)}
      {viewingHistory && <p className="cp-hint">正在查看历史蓝图。返回当前版本后可继续操作。</p>}
      {editor && !viewingHistory && <div className="cp-house-edit">
        <p className="cp-hint">选择材料后点击格子。留空可移除草案中的方块，保存后才会更新蓝图。</p>
        <div className="cp-actions" role="group" aria-label="绘制材料">
          {Object.entries(MINECRAFT_HOUSE_BLOCKS).map(([symbol, block]) => <button className="cp-button" type="button" key={symbol}
            aria-pressed={paint === symbol} data-primary={paint === symbol} disabled={!!pending}
            onClick={() => setPaint(symbol as MinecraftHouseSymbol)}>{HOUSE_BLOCK_LABELS[block].name}</button>)}
        </div>
        <p className="cp-hint" role="status">已改 {changeCount} 格{!validEdit && ' · 草案需要 1～100 个实体方块'}</p>
      </div>}
      <div className="cp-house-comparison">
        <div className="cp-house-layer">
          <p className="cp-label">{orientation === 'front' ? '北墙 · 上 ↑ · 东 →' : orientation === 'left' ? '西墙 · 上 ↑ · 南 →' : '北 ↑ · 东 →'}</p>
          {displayLayout && <div className="cp-house-grid" role={editor && !viewingHistory ? 'group' : 'img'}
            aria-label={orientation === 'front' ? '北墙正面图' : orientation === 'left' ? '西墙左侧图' : `第 ${activeLayer + 1} 层俯视图，北向朝上`}
            style={{ gridTemplateColumns: `repeat(${orientation === 'left' ? draft.layout.depth : draft.layout.width}, minmax(0, 1fr))` }}>
            {visibleCells?.map(cell => {
              const label = HOUSE_BLOCK_LABELS[cell.block]
              const position = `${label.name}（向东 ${cell.x}，向南 ${cell.z}，第 ${cell.y + 1} 层）`
              return editor && !viewingHistory ? <button key={cell.index} className="cp-house-cell" type="button" data-block={cell.block}
                data-changed={editor.base[cell.index] !== cell.symbol} aria-label={position} title={position}
                disabled={!!pending} onClick={() => changeCell(cell.index)}>{label.mark}</button>
                : <span key={cell.index} aria-hidden="true" className="cp-house-cell" data-block={cell.block} title={position}>{label.mark}</span>
            })}
          </div>}
        </div>
        {referenceOpen && <HouseReference key={draft.id} id={draft.id} />}
      </div>
      {displayLayout && <p className="cp-hint cp-row cp-house-materials"><span>{historical ? '历史用料' : editor ? '修改后用料' : '蓝图用料'}</span>
        {Object.entries(minecraftHouseMaterials(displayLayout)).map(([block, count]) =>
          <span key={block}>{HOUSE_BLOCK_LABELS[block as keyof typeof HOUSE_BLOCK_LABELS].name} {count}</span>)}
      </p>}
      {draft.assumptions && <><h3>{draftRevision > 0 || editor ? '原草案设计说明' : '设计补充'}</h3><p className="cp-hint cp-house-notes">{draft.assumptions}</p></>}
      {editor && <>
        <div className="cp-actions">
          {!viewingHistory && <>
            <button className="cp-button" type="button" disabled={!!pending || !editor.undo.length} onClick={() => setEditor(current => {
              const previous = current?.undo.at(-1)
              return current && previous !== undefined ? { ...current, blocks: previous, undo: current.undo.slice(0, -1) } : current
            })}>撤销一步</button>
            <button className="cp-button" type="button" disabled={!!pending || !changeCount}
              onClick={() => setEditor(current => current && { ...current, blocks: current.base, undo: [] })}>还原本次编辑</button>
          </>}
          <button className="cp-button" type="button" disabled={!!pending} onClick={() => {
            setEditor(undefined)
            setHistoryVersion(undefined)
            setEditFailure(undefined)
          }}>取消编辑</button>
          <button className="cp-button" type="button" data-primary={canSave} disabled={!canSave}
            onClick={() => { void save() }}>{pending === 'save' ? '正在保存' : '保存蓝图'}</button>
        </div>
        {stale && <p className="cp-error" role="alert">草案已更新或已进入施工。当前编辑仍保留，请读取最新版本后再修改。</p>}
        {stale && <button className="cp-button" type="button" disabled={!!pending} onClick={() => { void reloadEditor() }}>
          {pending === 'reload' ? '正在读取' : '放弃本地修改并读取最新版本'}</button>}
        {editFailure === 'invalid' && <p className="cp-error" role="alert">宿主未接受这份蓝图，编辑内容仍保留。</p>}
        {editFailure === 'unknown' && <p className="cp-error" role="alert">暂时无法连接宿主，编辑内容仍保留。</p>}
      </>}
      {draft.zoneId ? <p className="cp-hint">固定施工区 · {zone?.name ?? '原授权区域不可用'}。换区需另存草案。</p> : <label className="cp-field">施工区
        <select className="cp-select" value={zone?.id ?? ''} disabled={!canSwitch || viewingHistory} onChange={event => {
          setDraftId(draft.id)
          setZoneChoice({ draftId: draft.id, zoneId: event.target.value })
          setCheck(undefined)
          setFailed(undefined)
        }}>
          <option value="">选择已授权区域</option>
          {zones.map(item => <option key={item.id} value={item.id}>{item.name} · 半径 {item.radius} 格</option>)}
        </select>
      </label>}
      {draft.status === 'interrupted' && <p className="cp-hint">已放置的方块会保留。重试前请重新预检同一区域。</p>}
      {draft.status === 'interrupted' && pending !== 'build' && !viewingHistory && draft.recovery && <HouseRecoveryNote recovery={draft.recovery} />}
      {draft.status === 'built' && draft.receipt && <p className="cp-hint">现场验收 · 核验 {draft.receipt.checked} 格 · 本次新增 {draft.receipt.placed} 块</p>}
      {draft.status !== 'built' && draft.status !== 'running' && <>
        {!view?.available && <p className="cp-hint">当前无法预检或施工，仍可查看草案。</p>}
        <div className="cp-actions">
          <button className="cp-button" type="button" disabled={!canWork} onClick={() => { void run('preview') }}>
            {pending === 'preview' ? '正在预检' : '预检现场'}
          </button>
          <button className="cp-button" type="button" data-primary={!!confirmation} disabled={!canWork || !confirmation}
            onClick={() => { void run('build') }}>{pending === 'build' ? '正在施工' : '确认开工'}</button>
        </div>
      </>}
      {site && <p className="cp-hint" role="status">{confirmation ? `现场预检通过 · 已核验 ${site.result.checked} 格`
        : site.result.ready ? '现场预检已失效，请重新预检。' : `现场预检未通过 · 已核验 ${site.result.checked} 格`}
        {siteFailure && <>。{siteFailure}</>}
      </p>}
      {!!materials?.length && <HouseMaterialShortage materials={materials} />}
      {failed && <p className="cp-error" role="alert">{failed}</p>}
    </>}
  </section>
}
