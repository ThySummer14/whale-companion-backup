import { useEffect, useState } from 'react'
import type { MediaCleanupPreview, MediaCleanupResult, MediaView } from '../core/model.ts'
import { getMedia, previewMedia, refreshMedia, cleanupMedia } from './api.ts'

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

export function MediaPanel({ notify }: { notify: (error: unknown) => void }) {
  const [view, setView] = useState<MediaView>()
  const [preview, setPreview] = useState<MediaCleanupPreview>()
  const [result, setResult] = useState<MediaCleanupResult>()
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getMedia().then(setView).catch(notify) }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch (error) { notify(error) } finally { setBusy(false) }
  }
  const cleanup = async () => {
    if (!preview) return
    const value = await cleanupMedia(preview.olderThanDays, Math.max(1, preview.candidates.length))
    setResult(value)
    setPreview(undefined)
    setView(await getMedia())
  }
  return <section className="cp-card">
    <div className="cp-row cp-between"><h2>媒体清单</h2><span className="cp-label">手动确认后删除过期缓存</span></div>
    <div className="cp-grid">
      <div><div className="cp-label">已核对文件</div><div className="cp-metric">{view?.summary.files ?? '—'}</div><div className="cp-label">{size(view?.summary.bytes ?? 0)}</div></div>
      <div><div className="cp-label">可再生成语音缓存</div><div className="cp-metric">{size(view?.summary.cacheBytes ?? 0)}</div><div className="cp-label">最近使用决定过期时间</div></div>
      <div><div className="cp-label">缺失文件</div><div className="cp-metric">{view?.summary.missingFiles ?? '—'}</div><div className="cp-label">缺失不计为已释放空间</div></div>
      <div><div className="cp-label">已清理缓存</div><div className="cp-metric">{view?.summary.deletedFiles ?? 0}</div><div className="cp-label">累计释放 {size(view?.summary.deletedBytes ?? 0)}</div></div>
    </div>
    {view?.error && <div className="cp-error">{view.error}</div>}
    <div className="cp-actions"><button className="cp-button" disabled={busy} onClick={() => void run(async () => { setView(await refreshMedia()); setPreview(undefined) })}>重新核对文件</button><label className="cp-label">缓存未使用天数 <input className="cp-input" style={{ width: 90 }} type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} /></label><button className="cp-button" disabled={busy} onClick={() => void run(async () => { setPreview(await previewMedia(days)) })}>生成清理预览</button></div>
    <p className="cp-hint cp-small">保护范围：{view?.protected.join('、') ?? '模型、原始素材、记忆与备份'}。删除前逐项核对路径、大小与 SHA-256；保护项和已变化文件不会删除。</p>
    {preview && <div className="cp-session"><strong>预览：{preview.candidates.length} 个候选，共 {size(preview.bytes)}</strong><div className="cp-label">{preview.duplicateGroups.length} 组重复内容；确认后才执行。</div>{preview.candidates.slice(0, 20).map(asset => <div key={asset.id} className="cp-row cp-between"><span className="cp-code">{asset.path}</span><span className="cp-label">{size(asset.bytes)}</span></div>)}<button className="cp-button" data-primary disabled={busy || !preview.candidates.length} onClick={() => void run(cleanup)}>确认删除这些缓存</button></div>}
    {result && <div className="cp-session"><strong>已删除 {result.deleted.length} 个文件，实际释放 {size(result.bytes)}</strong>{result.skipped.length > 0 && <div className="cp-label">跳过 {result.skipped.length} 项：{result.skipped.map(item => `${item.asset.path}（${item.reason}）`).join('、')}</div>}</div>}
    {view?.items.slice(0, 20).map(asset => <div key={asset.id} className="cp-row cp-between"><div><div className="cp-code">{asset.path}</div><div className="cp-label">{asset.retention === 'cache' ? '可再生成缓存' : '保留素材'} · {asset.hash ? `SHA-256 ${asset.hash.slice(0, 12)}…` : '尚未校验'} · 最近使用 {new Date(asset.lastUsedAt).toLocaleString('zh-CN', { hour12: false })}</div></div><span className="cp-label">{size(asset.bytes)}</span></div>)}
  </section>
}
