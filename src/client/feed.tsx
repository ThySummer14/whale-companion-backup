import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { MINECRAFT_SHARE_CONTEXT, type FeedPost, type FeedThread } from '../core/model.ts'
import { MAX_SINGING_WAV_BYTES } from '../protocol/singing.ts'
import { createFeedPost, deleteFeedPost, getFeed, getFeedThread, getSongAudio, replyFeedPost } from './api.ts'

type FeedSong = NonNullable<FeedPost['song']>
type SongPreview = { status: 'loading' | 'failed' } | { status: 'ready'; url: string }

function FeedSongPlayer({ song }: { song: FeedSong }) {
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState<SongPreview>({ status: 'loading' })
  const audio = useRef<HTMLAudioElement>(null)
  const { id, bytes, title } = song
  const url = preview.status === 'ready' ? preview.url : undefined
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    void getSongAudio(id, bytes, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setPreview({ status: 'ready', url: objectUrl })
    }).catch(() => {
      if (!controller.signal.aborted) setPreview({ status: 'failed' })
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id, bytes, attempt])
  useEffect(() => {
    const player = audio.current
    if (player) return () => {
      player.pause()
      player.removeAttribute('src')
      player.load()
    }
  }, [url])
  if (preview.status === 'failed') return <div className="cp-row">
    <span className="cp-hint cp-small" role="status">歌曲归档暂时无法播放。</span>
    <button className="cp-button" type="button" onClick={() => {
      setPreview({ status: 'loading' })
      setAttempt(value => value + 1)
    }}>重试加载</button>
  </div>
  if (!url) return <div className="cp-hint cp-small" role="status">正在读取歌曲归档…</div>
  return <audio ref={audio} controls preload="metadata" aria-label={`试听《${title}》`} src={url}
    style={{ width: '100%', maxWidth: 400 }} onError={() => {
      URL.revokeObjectURL(url)
      setPreview({ status: 'failed' })
    }} />
}

function FeedSongCard({ song, open, disabled, onToggle }: { song: FeedSong; open: boolean; disabled: boolean; onToggle: () => void }) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(song.id) || typeof song.title !== 'string' || !song.title.trim() ||
    !Number.isSafeInteger(song.bytes) || song.bytes < 44 || song.bytes > MAX_SINGING_WAV_BYTES) return null
  const seconds = song.durationSeconds
  return <section className="cp-stack cp-feed-song" aria-label={`歌曲《${song.title}》`}>
    <div className="cp-row"><span className="cp-status">歌唱归档</span><strong>{song.title}</strong>
      {typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && <span className="cp-label">{seconds.toFixed(1)} 秒</span>}</div>
    <div><button className="cp-button" type="button" aria-expanded={open} disabled={disabled} onClick={onToggle}>{open ? '关闭播放器' : '打开播放器'}</button></div>
    {open && <FeedSongPlayer key={`${song.id}:${song.bytes}`} song={song} />}
  </section>
}

function BilibiliFeedLink({ source }: { source: NonNullable<FeedPost['bilibiliSource']> }) {
  const { bvid, part, startSeconds } = source
  if (!/^BV[a-zA-Z0-9]{10}$/u.test(bvid) || !Number.isInteger(part) || part < 1 || part > 1000 ||
    !Number.isInteger(startSeconds) || startSeconds < 0 || startSeconds > 604_800) return null
  const href = `https://www.bilibili.com/video/${bvid}/?p=${part}&t=${startSeconds}`
  const time = `${Math.floor(startSeconds / 60)}:${String(startSeconds % 60).padStart(2, '0')}`
  return <p className="cp-meta"><a href={href} target="_blank" rel="noreferrer">B 站出处 · 第 {part} P · {time}</a></p>
}

function FeedImage({ id, label }: { id: string; label: string }) {
  const [source, setSource] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    void fetch(`/companion/api/media-file/${encodeURIComponent(id)}`, {
      headers: { 'x-companion-request': '1' },
      signal: controller.signal,
    }).then(response => {
      if (!response.ok) throw new Error('无法读取图片')
      return response.blob()
    }).then(blob => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setSource(objectUrl)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])
  if (failed) return <p className="cp-hint">图片暂时无法读取。</p>
  return source && <img src={source} alt={label} onError={() => setFailed(true)} style={{ display: 'block', maxWidth: '100%', maxHeight: 360, borderRadius: 12, marginBlock: 8 }} />
}

export function FeedPage({ personaName, reload, notify, stateReadFailed }: {
  personaName: string; reload: () => Promise<void>; notify: (error: unknown) => void; stateReadFailed: boolean
}) {
  const [items, setItems] = useState<FeedPost[]>([])
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string>()
  const [openSong, setOpenSong] = useState<string>()
  const [threads, setThreads] = useState<Record<string, FeedThread>>({})
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    try {
      const value = await getFeed()
      setItems(value.items)
    } catch (error) {
      setOpenSong(undefined)
      throw error
    }
  }, [])
  useEffect(() => { void load().catch(notify) }, [load, notify])
  useEffect(() => { if (stateReadFailed) setOpenSong(undefined) }, [stateReadFailed])
  const publish = async (event: FormEvent) => {
    event.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    try {
      await createFeedPost(body)
      setBody('')
      await Promise.all([load(), reload()])
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const toggle = async (post: FeedPost) => {
    if (expanded === post.id) { setExpanded(undefined); return }
    setExpanded(post.id)
    if (!threads[post.id]) {
      try {
        const thread = await getFeedThread(post.id)
        setThreads(current => ({ ...current, [post.id]: thread }))
      } catch (error) { notify(error) }
    }
  }
  const reply = async (event: FormEvent, post: FeedPost) => {
    event.preventDefault()
    const text = replyDraft[post.id]?.trim()
    if (!text) return
    setBusy(true)
    try {
      await replyFeedPost(post.id, text)
      const thread = await getFeedThread(post.id)
      setThreads(current => ({ ...current, [post.id]: thread }))
      setReplyDraft(current => ({ ...current, [post.id]: '' }))
      await Promise.all([load(), reload()])
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const remove = async (post: FeedPost) => {
    setBusy(true)
    try {
      await deleteFeedPost(post.id, post.author)
      setOpenSong(current => current === post.id ? undefined : current)
      setExpanded(undefined)
      setThreads(current => { const next = { ...current }; delete next[post.id]; return next })
      await Promise.all([load(), reload()])
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  return <>
    <form className="cp-card" onSubmit={event => void publish(event)}>
      <h2>发布一条你的动态</h2>
      <div className="cp-field"><label className="cp-label" htmlFor="cp-feed-new">此刻想分享什么？</label><textarea id="cp-feed-new" className="cp-textarea" required maxLength={4000} placeholder="分享今天的想法…" value={body} onChange={event => setBody(event.target.value)} /></div>
      <div className="cp-actions"><button className="cp-button" data-primary type="submit" disabled={busy || !body.trim()}>发布动态</button><button className="cp-button" type="button" disabled={busy} onClick={() => void load().catch(notify)}>刷新</button></div>
      <p className="cp-hint cp-small">动态可以附上 Minecraft 回执、B 站出处或已归档的歌曲。</p>
    </form>
    <section className="cp-card"><div className="cp-row cp-between"><h2>时间线</h2><span className="cp-label">{items.length} 条动态</span></div>
      {items.length ? items.map(post => <article className="cp-session" key={post.id}>
        <div className="cp-row cp-between"><strong>{post.author === 'companion' ? personaName : '你'}</strong><span className="cp-meta">{new Date(post.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></div>
        {post.body && <p style={{ whiteSpace: 'pre-wrap', marginBlock: 8 }}>{post.body}</p>}
        {post.mediaId && <FeedImage key={post.mediaId} id={post.mediaId} label="动态附件" />}
        {post.song && <FeedSongCard song={post.song} open={!stateReadFailed && openSong === post.id} disabled={stateReadFailed}
          onToggle={() => setOpenSong(current => current === post.id ? undefined : post.id)} />}
        {post.bilibiliSource ? <BilibiliFeedLink source={post.bilibiliSource} /> : post.contextId === MINECRAFT_SHARE_CONTEXT && post.sourceTaskId
          ? <div className="cp-meta">Minecraft 回执 <span className="cp-code">{post.sourceTaskId}</span></div>
          : post.contextId && <div className="cp-code">{post.contextId}</div>}
        <div className="cp-actions"><button className="cp-button" type="button" onClick={() => void toggle(post)}>{expanded === post.id ? '收起回复' : post.replyCount ? `${post.replyCount} 条回复` : '回复'}</button><button className="cp-button" type="button" disabled={busy} onClick={() => void remove(post)}>删除</button></div>
        {expanded === post.id && <div className="cp-stack">
          {(threads[post.id]?.replies.length ?? 0) > 0 ? threads[post.id]!.replies.map(reply => <div key={reply.id}>
            <div className="cp-row cp-between"><strong>{reply.author === 'companion' ? personaName : '你'}</strong><span className="cp-meta">{new Date(reply.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></div>
            {reply.body && <p style={{ whiteSpace: 'pre-wrap', marginBlock: 6 }}>{reply.body}</p>}
            {reply.mediaId && <FeedImage key={reply.mediaId} id={reply.mediaId} label="回复附件" />}
          </div>) : <div className="cp-hint">{threads[post.id] ? '还没有回复。' : '正在读取回复…'}</div>}
          <form onSubmit={event => void reply(event, post)}><div className="cp-field"><label className="cp-label" htmlFor={`cp-reply-${post.id}`}>回复{post.author === 'companion' ? personaName : '这条动态'}</label><textarea id={`cp-reply-${post.id}`} className="cp-textarea" style={{ minHeight: 64 }} required maxLength={4000} value={replyDraft[post.id] ?? ''} onChange={event => setReplyDraft(current => ({ ...current, [post.id]: event.target.value }))} /></div><div className="cp-actions"><button className="cp-button" data-primary type="submit" disabled={busy || !replyDraft[post.id]?.trim()}>发布回复</button></div></form>
        </div>}
      </article>) : <div className="cp-empty">还没有动态。可以发布第一条，或从手机邀请角色写一条。</div>}
    </section>
  </>
}
