import { memo } from 'react'
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ChatMessage } from '../host/types.ts'
import { Avatar } from './Avatar.tsx'
import { useEnterAnimation } from './motion.ts'
import { colors } from './theme.ts'
import type { VoiceView } from './useVoicePlayer.ts'

interface MessageBubbleProps {
  message: ChatMessage
  previousRole?: ChatMessage['role']
  personaName: string
  voice?: VoiceView
  onVoicePress?: (messageId: string) => void
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export const MessageBubble = memo(function MessageBubble({ message, previousRole, personaName, voice, onVoicePress }: MessageBubbleProps) {
  const own = message.role === 'user'
  const continued = previousRole === message.role
  const enter = useEnterAnimation(4)
  const phase = voice?.phase
  const busy = phase === 'synthesizing' || phase === 'loading'
  const duration = voice?.task?.audio ? voice.task.audio.durationMs / 1000 : 0
  const label = phase === 'synthesizing' ? '正在生成' : phase === 'loading' ? '准备播放' : phase === 'playing' ? '正在播放' : phase === 'paused' ? '继续播放' : phase === 'failed' ? '重试语音' : duration ? '再听一次' : '听语音'
  const icon = phase === 'failed' ? 'alert-circle-outline' : phase === 'playing' ? 'pause' : phase === 'paused' ? 'play' : 'volume-medium-outline'
  return <Animated.View style={[styles.container, own && styles.ownContainer, continued && styles.continued, message.id !== 'stream' && enter]}>
    {!own && (continued ? <View style={styles.avatarSpace} /> : <Avatar name={personaName} size={28} />)}
    <View style={[styles.content, own && styles.ownContent]}>
      {!own && !continued && <Text style={styles.name}>{personaName}</Text>}
      <View style={[styles.bubble, own ? styles.user : styles.assistant]}>
        <Text selectable style={[styles.text, own && styles.userText]}>{message.text}</Text>
      </View>
      {!own && message.id !== 'stream' && message.text.trim() && <Pressable
        accessibilityRole="button"
        accessibilityLabel={message.text.length > 1500 ? '消息太长，无法朗读' : phase === 'playing' ? '暂停语音' : busy ? '取消语音等待' : label}
        accessibilityState={{ disabled: message.text.length > 1500, busy }}
        disabled={message.text.length > 1500}
        onPress={() => onVoicePress?.(message.id)}
        style={({ pressed }) => [styles.voice, voice && styles.voiceActive, pressed && styles.voicePressed, message.text.length > 1500 && styles.voiceDisabled]}
      >
        {busy ? <ActivityIndicator size="small" color={colors.accent} /> : <Ionicons name={icon} size={19} color={phase === 'failed' ? colors.danger : colors.accent} />}
        <Text style={[styles.voiceText, phase === 'failed' && styles.voiceError]}>{message.text.length > 1500 ? '消息太长' : label}</Text>
        {duration > 0 && <Text style={styles.voiceTime}>{formatTime((voice?.progress ?? 0) * duration)} / {formatTime(duration)}</Text>}
        {voice && duration > 0 && phase !== 'failed' && <View style={styles.progressTrack}><View style={[styles.progress, { width: `${Math.round((voice.progress ?? 0) * 100)}%` }]} /></View>}
      </Pressable>}
      {voice?.error && <Text style={styles.error}>{voice.error}</Text>}
    </View>
  </Animated.View>
})

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 12 },
  ownContainer: { justifyContent: 'flex-end' },
  continued: { marginTop: 4 },
  avatarSpace: { width: 28 },
  content: { flexShrink: 1, maxWidth: '82%' },
  ownContent: { alignItems: 'flex-end' },
  name: { color: colors.muted, fontSize: 12, fontWeight: '500', marginBottom: 5, marginLeft: 3 },
  bubble: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  user: { backgroundColor: colors.accent, borderBottomRightRadius: 6 },
  assistant: { backgroundColor: colors.assistantBubble, borderBottomLeftRadius: 6 },
  text: { color: colors.text, fontSize: 16, lineHeight: 24 },
  userText: { color: colors.accentText },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, marginTop: 3, paddingHorizontal: 4, overflow: 'hidden' },
  voiceActive: { paddingHorizontal: 10, borderRadius: 16, backgroundColor: colors.accentSoft },
  voicePressed: { opacity: 0.65 },
  voiceDisabled: { opacity: 0.4 },
  voiceText: { color: colors.accent, fontSize: 12, fontWeight: '500' },
  voiceError: { color: colors.danger },
  voiceTime: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  progressTrack: { position: 'absolute', bottom: 1, left: 10, right: 10, height: 2, borderRadius: 1, backgroundColor: colors.border },
  progress: { height: 2, borderRadius: 1, backgroundColor: colors.accent },
  error: { color: colors.danger, fontSize: 11, lineHeight: 17, paddingHorizontal: 6, maxWidth: 250 },
})
