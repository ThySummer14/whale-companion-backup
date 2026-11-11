const active = session => session?.status === 'preparing' || session?.status === 'playing'
const pcmBlockSeconds = 0.04
const pcmScheduleAheadSeconds = 0.16
const pcmStartLeadSeconds = 0.008
// Keep these versioned wire values in sync with protocol/singing.ts.
const songVocalStepMs = 25
const maxSongVocalSamples = 2600

function decodeVocalEnvelope(header, duration) {
  if (!header?.startsWith('v1:') || header.length > 3 + Math.ceil(maxSongVocalSamples / 3) * 4 ||
      !Number.isFinite(duration) || duration <= 0) return
  const encoded = header.slice(3)
  try {
    const decoded = atob(encoded)
    // Browser resampling can round the decoded duration across one bucket boundary.
    const buckets = Math.ceil(duration * 1000 / songVocalStepMs)
    if (!decoded.length || decoded.length > maxSongVocalSamples || Math.abs(decoded.length - buckets) > 1 ||
        btoa(decoded) !== encoded) return
    return Uint8Array.from(decoded, byte => byte.charCodeAt(0))
  } catch { return }
}

function wait(ms, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class RealtimeVoicePlayer {
  constructor(api, stageId) {
    this.stageId = stageId
    this.api = (path, data) => api(path, path === '/realtime/receipt' && stageId ? { ...data, stageId } : data)
    this.ticking = false
    this.energy = 0
    this.positionMs = 0
    this.acceptAutoRead = false
    this.songForeground = true
  }

  setAutoReadEnabled(enabled) {
    this.acceptAutoRead = enabled
    if (!enabled && this.playbackStageId) this.stopLocal()
  }

  setSongForeground(visible) {
    this.songForeground = visible
    if (!visible && this.session?.kind === 'song') return this.interrupt()
  }

  async unlock() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) throw new Error('当前浏览器不支持 Web Audio')
      this.context = new AudioContext()
    }
    await this.context.resume()
    return this.context.state
  }

  get canInterrupt() {
    return active(this.session) || this.session?.status === 'cancelling' || !!this.loading || !!this.current
  }

  get songReady() {
    return this.songForeground && this.context?.state === 'running' && !this.failedSongId
  }

  interrupt() {
    this.requestCancellation(this.session)
    this.stopLocal()
    return this.tick()
  }

  requestCancellation(session) {
    if (active(session) && this.cancelPending !== session.id) {
      this.cancelPending = session.id
      this.cancelRequest = this.api('/realtime/cancel', { sessionId: session.id }).catch(() => undefined)
    }
  }

  songPlaybackError(error) {
    const session = this.session
    if (session?.kind !== 'song' || !active(session) || this.cancelPending === session.id || this.failedSongId === session.id) return
    this.failedSongId = session.id
    this.stopLocal()
    this.lastError = error.message
    void this.api('/realtime/receipt', { sessionId: session.id, segmentIndex: 0, status: 'error', error: this.lastError.slice(0, 300) }).catch(() => {})
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    let followSegment = false
    try {
      const { session, playbackStageId, streamStageId, songStageId } = await this.api('/realtime')
      const song = session?.kind === 'song'
      this.playbackStageId = song ? undefined : playbackStageId
      if (!active(session) || session?.id !== this.failedSongId) this.failedSongId = undefined
      const wrongStage = song ? !this.stageId || songStageId !== this.stageId
        : playbackStageId && playbackStageId !== this.stageId || streamStageId && streamStageId !== this.stageId
      if (wrongStage) {
        this.session = undefined
        this.stopLocal()
        return
      }
      if (!song && playbackStageId && !this.acceptAutoRead && active(session) && this.cancelPending !== session.id) {
        this.session = undefined
        this.stopLocal()
        return
      }
      this.session = session
      if (this.loading && this.loading.sessionId !== session?.id || this.current && this.current.sessionId !== session?.id) this.stopLocal()
      if (this.cancelPending && this.cancelPending !== session?.id) this.clearCancellation()
      if (song && (!this.songForeground || this.current && this.context?.state !== 'running')) this.requestCancellation(session)
      if (session?.status === 'cancelling' || active(session) && this.cancelPending === session.id) {
        this.stopLocal()
        const result = session.status === 'cancelling' ? session : (
          await this.cancelRequest || await this.api('/realtime/cancel', { sessionId: session.id })
        ).session
        this.session = result
        const segment = result?.segments.find(item => item.status !== 'completed')
        if (result?.status === 'cancelling' && segment) {
          this.session = (await this.api('/realtime/receipt', { sessionId: result.id, segmentIndex: segment.index, status: 'cancelled', positionMs: 0, energy: 0 })).session
        }
        if (this.session?.status === 'cancelled') this.lastError = undefined
        this.clearCancellation()
        return
      }
      if (!active(session)) {
        this.clearCancellation()
        this.stopLocal()
        if (session?.status === 'failed') this.lastError = session.error
        return
      }
      const current = this.current
      if (current) {
        if (current.endedAt === undefined) return
        await current.started
        if (this.current !== current) return
        if (session.segments[current.segmentIndex]?.status !== 'completed') {
          await this.api('/realtime/receipt', { sessionId: current.sessionId, segmentIndex: current.segmentIndex, status: 'completed', positionMs: current.endedAt, energy: 0 })
        }
        if (this.current === current) {
          this.current = undefined
          followSegment = session.streaming && session.segments.some(segment => segment.index > current.segmentIndex && segment.status === 'ready')
        }
        return
      }
      if (this.loading || this.context?.state !== 'running' || song && !this.songReady) return
      const next = session.segments.find(segment => segment.status !== 'completed')
      if (next?.status === 'ready') {
        if (session.streaming && !song) {
          if (this.stageId) void this.playStream(session, next)
        } else if (next.taskId) void this.play(session, next)
      }
    } catch (error) {
      this.lastError = error.message
      this.songPlaybackError(error)
    } finally {
      this.ticking = false
      if (followSegment) void this.tick()
    }
  }

  clearCancellation() {
    this.cancelPending = undefined
    this.cancelRequest = undefined
  }

  async play(session, segment) {
    const song = session.kind === 'song'
    const load = { sessionId: session.id, controller: new AbortController() }
    this.loading = load
    this.lastError = undefined
    this.streamMetrics = undefined
    try {
      const stageQuery = this.stageId ? `?stageId=${encodeURIComponent(this.stageId)}` : ''
      const response = await fetch(`/companion/avatar/api/realtime/audio/${segment.taskId}${stageQuery}`, {
        headers: { 'x-companion-request': '1' },
        signal: AbortSignal.any([load.controller.signal, AbortSignal.timeout(20_000)]),
      })
      if (!response.ok) throw new Error(`${song ? '歌曲' : '语音段'}读取失败：${response.status}`)
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer())
      if (this.loading !== load) return
      const vocalEnvelope = song ? decodeVocalEnvelope(response.headers?.get('x-companion-vocal-envelope'), buffer.duration) : undefined
      const { session: latest, playbackStageId, songStageId } = await this.api('/realtime')
      const cannotPlayHere = song ? !this.songReady || !this.stageId || songStageId !== this.stageId || latest?.kind !== 'song'
        : latest?.kind === 'song' || playbackStageId && (playbackStageId !== this.stageId || !this.acceptAutoRead)
      if (this.loading !== load || cannotPlayHere || latest?.id !== session.id || !active(latest) || latest.segments[segment.index]?.status !== 'ready' || this.context.state !== 'running') return
      const source = this.context.createBufferSource()
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 256
      source.buffer = buffer
      source.connect(analyser)
      analyser.connect(this.context.destination)
      const current = {
        sessionId: session.id, segmentIndex: segment.index, source, analyser,
        startedAt: this.context.currentTime,
        ...(song && { kind: 'song', durationMs: Math.round(buffer.duration * 1000), vocalEnvelope }),
        samples: new Float32Array(analyser.fftSize),
      }
      source.onended = () => this.finish(current)
      this.current = current
      source.start()
      current.started = this.api('/realtime/receipt', { sessionId: session.id, segmentIndex: segment.index, status: 'playing', positionMs: 0, energy: 0 })
      await current.started
    } catch (error) {
      if (this.loading !== load) return
      if (song) {
        this.songPlaybackError(error)
        return
      }
      this.lastError = error.message
      this.stopLocal()
      await this.api('/realtime/receipt', { sessionId: session.id, segmentIndex: segment.index, status: 'error', error: this.lastError.slice(0, 300) }).catch(() => {})
    } finally {
      if (this.loading === load) this.loading = undefined
    }
  }

  async playStream(session, segment) {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])
    const load = { sessionId: session.id, controller }
    const requestedAt = performance.now()
    const metrics = { underruns: 0, peakBufferedMs: 0 }
    this.streamMetrics = metrics
    this.loading = load
    this.lastError = undefined
    let current, reader
    const fail = async error => {
      if (this.loading !== load && (!current || this.current !== current)) return
      this.lastError = error.message
      this.stopLocal()
      await this.api('/realtime/receipt', { sessionId: session.id, segmentIndex: segment.index, status: 'error', error: this.lastError.slice(0, 300) }).catch(() => {})
    }
    try {
      const response = await fetch(`/companion/avatar/api/realtime/stream/${encodeURIComponent(session.id)}/${segment.index}?stageId=${encodeURIComponent(this.stageId)}`, {
        headers: { 'x-companion-request': '1' }, signal,
      })
      signal.throwIfAborted()
      if (response.status === 409) {
        const { session: latest, streamStageId } = await this.api('/realtime')
        signal.throwIfAborted()
        if (latest?.id !== session.id || !active(latest) || streamStageId && streamStageId !== this.stageId) return
      }
      if (!response.ok) throw new Error(`流式语音读取失败：${response.status}`)
      const sampleRate = Number(response.headers.get('x-companion-sample-rate'))
      if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream' || !response.body || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
        throw new Error('流式语音格式无效')
      }
      reader = response.body.getReader()
      const block = new Float32Array(Math.round(sampleRate * pcmBlockSeconds))
      let used = 0
      let lowByte = -1
      const elapsed = () => Math.round(performance.now() - requestedAt)
      const enqueue = async () => {
        await this.waitForPcmSpace(current, signal)
        signal.throwIfAborted()
        if (!current) {
          const analyser = this.context.createAnalyser()
          analyser.fftSize = 256
          analyser.connect(this.context.destination)
          current = {
            sessionId: session.id, segmentIndex: segment.index, analyser, controller, sampleRate, requestedAt,
            samples: new Float32Array(analyser.fftSize), sources: new Map(), playedFrames: 0,
          }
          this.current = current
        }
        const buffer = this.context.createBuffer(1, used, sampleRate)
        buffer.getChannelData(0).set(block.subarray(0, used))
        const source = this.context.createBufferSource()
        const now = this.context.currentTime
        // Adjacent buffers share a sample boundary. Only startup and starvation need a new lead time.
        const uninterrupted = current.scheduledUntil >= now
        const when = uninterrupted ? current.scheduledUntil : now + pcmStartLeadSeconds
        if (!uninterrupted) {
          if (current.scheduledUntil !== undefined) metrics.underruns++
          current.startedAt = when
        }
        source.buffer = buffer
        source.connect(current.analyser)
        current.sources.set(source, { when, frames: used })
        source.onended = () => {
          if (this.current !== current) return
          current.playedFrames += current.sources.get(source).frames
          current.sources.delete(source)
          source.disconnect()
          if (current.eof && !current.sources.size) this.finish(current)
        }
        current.scheduledUntil = when + buffer.duration
        source.start(when)
        metrics.peakBufferedMs = Math.max(metrics.peakBufferedMs, Math.round((current.scheduledUntil - now) * 1000))
        if (!current.started) {
          metrics.firstScheduledMs = elapsed()
          current.started = (async () => {
            while (this.context.currentTime < when) await wait(8, signal)
            signal.throwIfAborted()
            metrics.audioClockReachedMs = elapsed()
            return this.api('/realtime/receipt', { sessionId: session.id, segmentIndex: segment.index, status: 'playing', positionMs: 0, energy: 0 })
          })()
          void current.started.catch(fail)
        }
        used = 0
      }
      while (true) {
        // Pace network pulls as well as scheduling within an already received chunk.
        await this.waitForPcmSpace(current, signal)
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        if (value.length && metrics.firstPacketMs === undefined) metrics.firstPacketMs = elapsed()
        for (const byte of value) {
          if (lowByte < 0) {
            lowByte = byte
          } else {
            const word = lowByte | (byte << 8)
            block[used++] = ((word << 16) >> 16) / 32768
            lowByte = -1
            if (used === block.length) await enqueue()
          }
        }
      }
      if (lowByte >= 0) throw new Error('流式语音在样本中间结束')
      if (used) await enqueue()
      if (!current) throw new Error('流式语音未返回样本')
      current.eof = true
      if (!current.sources.size) this.finish(current)
    } catch (error) {
      await fail(error)
    } finally {
      reader?.releaseLock()
      if (this.loading === load) this.loading = undefined
    }
  }

  async waitForPcmSpace(current, signal) {
    while (current?.scheduledUntil - this.context.currentTime >= pcmScheduleAheadSeconds) await wait(12, signal)
    signal.throwIfAborted()
  }

  finish(current) {
    if (this.current !== current) return
    current.endedAt = this.position(current)
    this.release(current)
    void this.tick()
  }

  position(current) {
    if (current.sources) {
      let frames = current.playedFrames
      for (const { when, frames: length } of current.sources.values()) {
        frames += Math.max(0, Math.min(length, (this.context.currentTime - when) * current.sampleRate))
      }
      return Math.round(frames * 1000 / current.sampleRate)
    }
    const elapsed = Math.max(0, Math.round((this.context.currentTime - current.startedAt) * 1000))
    return current.durationMs === undefined ? elapsed : Math.min(current.durationMs, elapsed)
  }

  release(current) {
    const sources = current.sources?.keys() ?? [current.source]
    for (const source of sources) {
      source.onended = null
      if (current.endedAt === undefined) {
        try { source.stop() } catch {}
      }
      source.disconnect()
    }
    current.sources?.clear()
    current.analyser.disconnect()
    this.energy = 0
    this.positionMs = 0
  }

  stopLocal() {
    this.loading?.controller.abort()
    this.loading = undefined
    const current = this.current
    this.current = undefined
    current?.controller?.abort()
    if (current && current.endedAt === undefined) this.release(current)
  }

  isPlaying(current) {
    return !!current && current.endedAt === undefined && this.context?.state === 'running'
      && (!current.sources || this.context.currentTime >= current.startedAt && this.context.currentTime < current.scheduledUntil)
  }

  applyMouth(engine) {
    const current = this.current
    if (!engine) return
    if (!this.isPlaying(current)) {
      engine.speechReserved = false
      engine.speechPose = undefined
      this.energy = 0
      return
    }
    if (current.vocalEnvelope) {
      const elapsed = Math.max(0, (this.context.currentTime - current.startedAt) * 1000)
      const bucket = Math.floor(elapsed / songVocalStepMs)
      this.energy = (current.vocalEnvelope[bucket] ?? 0) / 255
    } else {
      current.analyser.getFloatTimeDomainData(current.samples)
      let sum = 0
      for (const sample of current.samples) sum += sample * sample
      this.energy = Math.min(1, Math.sqrt(sum / current.samples.length) * 5)
    }
    if (current.sources && this.streamMetrics.firstSignalMs === undefined && this.energy > 0.015) {
      this.streamMetrics.firstSignalMs = Math.round(performance.now() - current.requestedAt)
    }
    this.positionMs = this.position(current)
    engine.speechReserved = true
    engine.speechPose = { values: { ParamMouthOpenY: this.energy, ParamMouthForm: this.energy * 0.35 } }
  }

  telemetry() {
    const playing = this.isPlaying(this.current)
    return {
      playing,
      ...(this.current?.kind === 'song' && { kind: 'song' }),
      ...(playing && this.current.kind === 'song' && { mouthSource: this.current.vocalEnvelope ? 'vocal-envelope' : 'mixed-audio' }),
      segmentIndex: this.current?.segmentIndex,
      positionMs: this.positionMs,
      energy: this.energy,
      audioContextState: this.context?.state ?? 'not-created',
      ...(this.streamMetrics ? { pcm: { ...this.streamMetrics } } : {}),
      error: this.lastError,
    }
  }
}
