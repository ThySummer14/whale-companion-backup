import { useEffect, useRef, useState } from 'react'
import { MAX_SINGING_MIDI_BYTES, parseSingingMidi, singingMidiDraft } from '../protocol/singing-midi.ts'
import { MAX_SINGING_SCORE_ROWS } from '../protocol/singing.ts'

export function SingingMidiImport({ disabled, hasDraft, apply }: {
  disabled: boolean
  hasDraft: boolean
  apply: (draft: { bpm: number; text: string }, filename: string) => void
}) {
  const reading = useRef(0)
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<{ midi: ReturnType<typeof parseSingingMidi>; name: string }>()
  const [trackIndex, setTrackIndex] = useState(0)
  const [start, setStart] = useState('1')
  const [count, setCount] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [error, setError] = useState<string>()
  const [applied, setApplied] = useState(false)
  useEffect(() => () => { reading.current++ }, [])

  const track = source?.midi.tracks[trackIndex]
  const selectTrack = (index: number, noteCount: number) => {
    setTrackIndex(index)
    setStart('1')
    setCount(String(Math.min(noteCount, 8)))
    setError(undefined)
    setApplied(false)
  }

  const load = async (file?: File) => {
    const request = ++reading.current
    setSource(undefined)
    setLyrics('')
    setError(undefined)
    setApplied(false)
    setLoading(false)
    if (!file) return
    if (!/\.midi?$/iu.test(file.name) || !file.size || file.size > MAX_SINGING_MIDI_BYTES) {
      setError('请选择不超过 256 KiB 的 .mid 或 .midi 文件。')
      return
    }
    setLoading(true)
    try {
      const bytes = await file.arrayBuffer()
      if (request !== reading.current) return
      const midi = parseSingingMidi(new Uint8Array(bytes))
      const first = midi.tracks[0]
      if (!first) throw new Error('文件里没有可选的旋律音轨。')
      selectTrack(0, first.noteCount)
      setSource({ midi, name: file.name })
    } catch (failure) {
      if (request === reading.current) setError(failure instanceof Error && !(failure instanceof DOMException)
        ? failure.message : '无法读取这份 MIDI 文件。')
    } finally {
      if (request === reading.current) setLoading(false)
    }
  }

  const importDraft = () => {
    if (!source || !track || disabled) return
    setError(undefined)
    setApplied(false)
    try {
      const draft = singingMidiDraft(source.midi, {
        track: track.track, channel: track.channel, start: Number(start), count: Number(count), lyrics: lyrics.trim() || undefined,
      })
      apply(draft, source.name)
      setApplied(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法把所选旋律转成短谱。')
    }
  }

  const changeSelection = (value: string, set: (value: string) => void) => {
    set(value)
    setError(undefined)
    setApplied(false)
  }

  return <details className="cp-stack">
    <summary>从 MIDI 导入旋律</summary>
    <p className="cp-hint cp-small">选一个单声部片段。文件在浏览器里读取，演唱时只提交下方的短谱。</p>
    <label className="cp-field">
      <span className="cp-label">MIDI 文件（最多 256 KiB）</span>
      <input className="cp-input" type="file" accept=".mid,.midi,audio/midi,audio/x-midi" disabled={disabled}
        onChange={event => { void load(event.target.files?.[0]) }} />
    </label>
    {loading && <p className="cp-hint cp-small" role="status">正在读取 MIDI…</p>}
    {source && <>
      <div className="cp-grid">
        <label className="cp-field">
          <span className="cp-label">旋律轨道和通道</span>
          <select className="cp-input" value={trackIndex} disabled={disabled} onChange={event => {
            const index = Number(event.target.value)
            const selected = source.midi.tracks[index]
            if (selected) selectTrack(index, selected.noteCount)
          }}>
            {source.midi.tracks.map(({ track, channel, name, noteCount }, index) => <option key={`${track}-${channel}`} value={index}>
              {`轨道 ${track} · 通道 ${channel}${name ? ` · ${name}` : ''} · ${noteCount} 个音符`}
            </option>)}
          </select>
        </label>
        <label className="cp-field">
          <span className="cp-label">起始音符</span>
          <input className="cp-input" type="number" min={1} max={track?.noteCount} step={1} value={start} disabled={disabled}
            onChange={event => changeSelection(event.target.value, setStart)} />
        </label>
        <label className="cp-field">
          <span className="cp-label">选取音符数</span>
          <input className="cp-input" type="number" min={1} max={Math.min(track?.noteCount ?? 1, MAX_SINGING_SCORE_ROWS)} step={1} value={count} disabled={disabled}
            onChange={event => changeSelection(event.target.value, setCount)} />
        </label>
      </div>
      <label className="cp-field">
        <span className="cp-label">逐音歌词（可选）</span>
        <input className="cp-input" type="text" maxLength={MAX_SINGING_SCORE_ROWS * 2} placeholder="微光照归途_" value={lyrics} disabled={disabled}
          onChange={event => changeSelection(event.target.value, setLyrics)} />
      </label>
      <p className="cp-hint cp-small">每个音符填一个汉字或 _。留空时读取对齐的 MIDI 歌词，缺失的字可在短谱里补齐。</p>
      <div><button className="cp-button" type="button" disabled={disabled} onClick={importDraft}>
        {hasDraft ? '用所选片段替换短谱' : '将所选片段填入短谱'}
      </button></div>
    </>}
    {error && <p className="cp-error cp-small" role="alert">{error}</p>}
    {applied && <p className="cp-hint cp-small" role="status">已填入短谱，可以继续编辑歌词、音高和时值。</p>}
  </details>
}
