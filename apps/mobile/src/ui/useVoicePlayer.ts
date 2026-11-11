import { useCallback, useEffect, useRef, useState } from 'react'
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import type { CompanionClient } from '../host/client.ts'
import type { TtsTask } from '../host/types.ts'

export type VoicePhase = 'idle' | 'synthesizing' | 'loading' | 'playing' | 'paused' | 'failed'

export interface VoiceView {
  phase: VoicePhase
  task?: TtsTask
  error?: string
  progress: number
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'tts-unavailable') return 'Mac mini 的语音服务还没准备好'
  if (message === 'tts-queue-full') return '语音排队较多，请稍后再试'
  if (message === 'message-too-long-for-tts') return '这条消息太长了，暂时无法朗读'
  if (message === 'assistant-message-not-found') return '找不到这条助手消息'
  return message || '语音暂时不可用，请重试'
}

export function useVoicePlayer(client: CompanionClient | null, contextId: string) {
  const player = useAudioPlayer(null, { updateInterval: 250, downloadFirst: true })
  const playback = useAudioPlayerStatus(player)
  const [activeId, setActiveId] = useState<string>()
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [task, setTask] = useState<TtsTask>()
  const [error, setError] = useState<string>()
  const generation = useRef(0)
  const controller = useRef<AbortController | undefined>(undefined)
  const state = useRef({ activeId, phase, task })
  const status = useRef(playback)
  state.current = { activeId, phase, task }
  status.current = playback

  useEffect(() => {
    if (!activeId || phase === 'synthesizing') return
    if (playback.error) {
      setPhase('failed')
      setError('语音加载失败，请检查连接后重试')
    } else if (playback.didJustFinish) {
      setPhase('idle')
    } else if (playback.playing) {
      setPhase('playing')
      setError(undefined)
    }
  }, [activeId, phase, playback])

  useEffect(() => () => {
    generation.current += 1
    controller.current?.abort()
    player.pause()
  }, [player])

  const start = useCallback(async (messageId: string) => {
    if (!client) return
    const request = ++generation.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    player.pause()
    player.replace(null)
    setActiveId(messageId)
    setTask(undefined)
    setError(undefined)
    setPhase('synthesizing')
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, allowsRecording: false, interruptionMode: 'doNotMix' })
      let current = await client.synthesizeMessage(contextId, messageId, abort.signal)
      while (current.status === 'accepted' || current.status === 'running') {
        await delay(650, abort.signal)
        current = await client.ttsTask(current.id, abort.signal)
        if (request !== generation.current) return
      }
      if (!current.audio || current.status !== 'succeeded') throw new Error(current.error || '语音没有生成，请重试')
      if (request !== generation.current) return
      setTask(current)
      player.replace(client.audioSource(current.id))
      player.play()
      setPhase('loading')
    } catch (failure) {
      if (request !== generation.current) return
      setPhase('failed')
      setError(failure instanceof Error && failure.name === 'AbortError' ? '连接中断或超时，请重试' : errorMessage(failure))
    }
  }, [client, contextId, player])

  const toggle = useCallback((messageId: string) => {
    const current = state.current
    if (current.activeId === messageId && ['synthesizing', 'loading'].includes(current.phase)) {
      generation.current += 1
      controller.current?.abort()
      player.pause()
      setPhase('idle')
      return
    }
    if (current.activeId === messageId && current.task?.audio) {
      if (status.current.playing) {
        player.pause()
        setPhase('paused')
        return
      }
      if (current.phase === 'paused' || current.phase === 'idle') {
        const request = ++generation.current
        setPhase('loading')
        void player.seekTo(status.current.didJustFinish ? 0 : status.current.currentTime).then(() => {
          if (request === generation.current) player.play()
        }).catch(() => {
          if (request === generation.current) {
            setPhase('failed')
            setError('无法继续播放，请重试')
          }
        })
        return
      }
    }
    void start(messageId)
  }, [player, start])

  const audioDuration = task?.audio ? task.audio.durationMs / 1000 : 0
  const progress = playback.didJustFinish || (audioDuration > 0 && playback.currentTime >= audioDuration)
    ? 1
    : audioDuration > 0 ? Math.max(0, Math.min(1, playback.currentTime / audioDuration)) : 0
  return {
    active: activeId ? { phase, task, error, progress } as VoiceView : undefined,
    activeId,
    toggle,
  }
}
