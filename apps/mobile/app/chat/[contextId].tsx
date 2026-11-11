import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router, useLocalSearchParams } from 'expo-router'
import { useHost } from '../../src/host/provider.tsx'
import { Avatar } from '../../src/ui/Avatar.tsx'
import { IconButton } from '../../src/ui/IconButton.tsx'
import { MessageBubble } from '../../src/ui/MessageBubble.tsx'
import { MotionPressable } from '../../src/ui/MotionPressable.tsx'
import { displayError } from '../../src/ui/error-message.ts'
import { useEnterAnimation } from '../../src/ui/motion.ts'
import { useVoicePlayer } from '../../src/ui/useVoicePlayer.ts'
import { colors } from '../../src/ui/theme.ts'
import type { ChatMessage, CompanionEvent } from '../../src/host/types.ts'

export default function ChatScreen() {
  const { contextId } = useLocalSearchParams<{ contextId: string }>()
  const { client, unpair } = useHost()
  const voice = useVoicePlayer(client, contextId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [stream, setStream] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [personaName, setPersonaName] = useState('她')
  const [title, setTitle] = useState('对话')
  const [focused, setFocused] = useState(false)
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'offline' | 'revoked'>('reconnecting')
  const [error, setError] = useState<string>()
  const cursor = useRef('0')
  const historyRequest = useRef(0)
  const list = useRef<{ scrollToEnd: (options?: { animated?: boolean }) => void } | null>(null)
  const followLatest = useRef(true)
  const pendingText = useRef('')
  const streamStartedAt = useRef(0)
  const streamSettledAt = useRef(0)
  const frame = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enterStyle = useEnterAnimation(5)
  const flushStream = useCallback(() => {
    if (frame.current) {
      clearTimeout(frame.current)
      frame.current = undefined
    }
    const text = pendingText.current
    pendingText.current = ''
    if (text) setStream(current => current + text)
  }, [])
  const load = useCallback(async () => {
    if (!client) return
    const current = ++historyRequest.current
    try {
      const history = await client.history(contextId)
      if (current !== historyRequest.current) return
      setMessages(previous => previous.length === history.messages.length && previous.every((message, index) => {
        const next = history.messages[index]
        return next !== undefined && message.id === next.id && message.text === next.text && message.role === next.role
      }) ? previous : history.messages)
      setError(undefined)
    } catch (failure) {
      if (current === historyRequest.current) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [client, contextId])
  useEffect(() => {
    setMessages([])
    setStream('')
    setSending(false)
    pendingText.current = ''
    streamStartedAt.current = 0
    streamSettledAt.current = 0
    cursor.current = '0'
    void load()
    if (!client) return
    const unsubscribe = client.subscribe(contextId, cursor.current, {
      status: next => {
        setStatus(next)
        if (next === 'revoked') {
          historyRequest.current += 1
          setSending(false)
          flushStream()
          setStream('')
          setError('设备已撤销，请重新配对')
        }
        if (next === 'connected') {
          flushStream()
          void load()
        }
      },
      event: (event: CompanionEvent) => {
        if (event.cursor) cursor.current = event.cursor
        if (event.type === 'message.delta') {
          if (!streamStartedAt.current) streamStartedAt.current = Date.now()
          setSending(true)
          if (event.payload.phase === 'chunk') {
            pendingText.current += event.payload.text ?? ''
            if (!frame.current) frame.current = setTimeout(flushStream, 32)
          }
        } else if (event.type === 'message.completed' || (event.type === 'activity' && event.payload.kind === 'assistant.completed')) {
          streamSettledAt.current = Date.parse(event.occurredAt) || Date.now()
          flushStream()
          setSending(false)
          setStream('')
          void load()
        } else if (event.type === 'message.failed' || (event.type === 'activity' && ['turn.aborted', 'turn.interrupted'].includes(event.payload.kind ?? ''))) {
          streamSettledAt.current = Date.parse(event.occurredAt) || Date.now()
          flushStream()
          setSending(false)
          setStream('')
          if (event.type === 'message.failed') setError('这一轮没有完成，请重试')
          void load()
        }
      },
    })
    return () => {
      historyRequest.current += 1
      if (frame.current) clearTimeout(frame.current)
      frame.current = undefined
      pendingText.current = ''
      unsubscribe()
    }
  }, [client, contextId, load, flushStream])
  useEffect(() => {
    if (!stream || streamSettledAt.current < streamStartedAt.current) return
    const latest = messages.at(-1)
    if (latest?.role !== 'assistant' || !latest.text.startsWith(stream)) return
    pendingText.current = ''
    if (frame.current) clearTimeout(frame.current)
    frame.current = undefined
    setStream('')
    setSending(false)
  }, [messages, stream])
  useEffect(() => {
    let active = true
    void client?.getState().then(view => {
      if (!active) return
      setPersonaName(view.persona.name)
      setTitle(view.bindings.find(binding => binding.contextId === contextId)?.label ?? contextId)
    }).catch(() => {})
    return () => { active = false }
  }, [client, contextId])
  if (!client) return null
  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    followLatest.current = true
    streamStartedAt.current = Date.now()
    streamSettledAt.current = 0
    setSending(true)
    setError(undefined)
    try {
      await client.send(contextId, text)
      setInput('')
      await load()
    } catch (failure) {
      setSending(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  const cancel = async () => {
    try { await client.cancel(contextId) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const connected = status === 'connected'
  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} automaticOffset>
      <Animated.View style={[styles.flex, enterStyle]}>
        <View style={styles.header}>
          <IconButton name="chevron-back" label="返回场景" size={29} color={colors.text} onPress={() => router.replace('/scenes')} style={styles.back} />
          <Avatar name={personaName} size={36} />
          <View style={styles.headerText}><Text numberOfLines={1} style={styles.title}>{title}</Text><Text numberOfLines={1} style={styles.subtitle}>与{personaName}的对话 · {contextId}</Text></View>
          <View style={styles.connection}><View style={[styles.connectionDot, !connected && styles.connectionWaiting]} /><Text style={[styles.status, connected ? styles.online : styles.offline]}>{connected ? '已连接' : status === 'revoked' ? '已撤销' : '重连中'}</Text></View>
        </View>
        {status === 'revoked' && <Pressable style={styles.reconnect} onPress={() => { void unpair().then(() => router.replace('/')) }}><Text style={styles.reconnectText}>重新配对</Text></Pressable>}
        {error && <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.danger} /><Text style={styles.errorText}>{displayError(error)}</Text></View>}
        <ScrollView
          ref={instance => { list.current = instance }}
          style={styles.flex}
          contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={event => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
            followLatest.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 96
          }}
          onContentSizeChange={() => { if (followLatest.current) list.current?.scrollToEnd({ animated: false }) }}
          onLayout={() => { if (followLatest.current) list.current?.scrollToEnd({ animated: false }) }}
        >
          {messages.map((message, index) => <MessageBubble key={message.id} message={message} previousRole={messages[index - 1]?.role} personaName={personaName} voice={voice.activeId === message.id ? voice.active : undefined} onVoicePress={voice.toggle} />)}
          {stream.length > 0 && <MessageBubble message={{ id: 'stream', role: 'assistant', text: stream }} previousRole={messages.at(-1)?.role} personaName={personaName} />}
          {!messages.length && !stream && <View style={styles.empty}>
            <Avatar name={personaName} size={68} />
            <Text style={styles.emptyTitle}>和{personaName}说点什么</Text>
            <Text style={styles.emptyDescription}>不用从任务开始，聊聊今天也好。{`\n`}你们有独立的对话，也共享重要的记忆。</Text>
            <Pressable style={({ pressed }) => [styles.starter, pressed && styles.pressed]} onPress={() => setInput('你好呀')}><Ionicons name="pencil-outline" size={16} color={colors.accent} /><Text style={styles.starterText}>从一句“你好”开始</Text></Pressable>
          </View>}
        </ScrollView>
        <View style={styles.composer}>
          {(sending || stream) && <View style={styles.generating} accessibilityLiveRegion="polite"><ActivityIndicator size="small" color={colors.muted} /><Text style={styles.generatingText}>{stream ? `${personaName}正在回复…` : '等待她的回复…'}</Text><Pressable accessibilityRole="button" style={styles.cancel} onPress={() => void cancel()}><Ionicons name="stop-circle-outline" size={18} color={colors.danger} /><Text style={styles.cancelText}>取消</Text></Pressable></View>}
          <View style={styles.composerRow}>
            <TextInput
              accessibilityLabel="消息内容"
              style={[styles.input, focused && styles.inputFocused]}
              multiline
              placeholder="和她聊聊…"
              placeholderTextColor={colors.dim}
              value={input}
              onChangeText={setInput}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            <MotionPressable
              accessibilityRole="button"
              accessibilityLabel="发送"
              accessibilityState={{ disabled: sending || !input.trim() || status === 'revoked' }}
              style={[styles.send, (sending || !input.trim() || status === 'revoked') && styles.disabled]}
              disabled={sending || !input.trim() || status === 'revoked'}
              onPress={() => void send()}
            >
              {sending ? <ActivityIndicator color={colors.accentText} size="small" /> : <Ionicons name="arrow-up" size={24} color={colors.accentText} />}
            </MotionPressable>
          </View>
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  </SafeAreaView>
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 10 },
  back: { marginLeft: -4 },
  headerText: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: colors.text, fontWeight: '600', fontSize: 16 },
  subtitle: { color: colors.muted, fontSize: 10 },
  connection: { flexDirection: 'row', alignItems: 'center', gap: 5, marginRight: 8 },
  connectionDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.success },
  connectionWaiting: { backgroundColor: colors.warning },
  status: { fontSize: 11 },
  online: { color: colors.success },
  offline: { color: colors.warning },
  messages: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, paddingBottom: 64 },
  emptyTitle: { color: colors.text, fontSize: 21, fontWeight: '600', marginTop: 20 },
  emptyDescription: { color: colors.muted, fontSize: 14, lineHeight: 23, textAlign: 'center', marginTop: 10 },
  starter: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.accentSoft, marginTop: 22 },
  starterText: { color: colors.accent, fontSize: 13 },
  pressed: { opacity: 0.72 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, backgroundColor: colors.background },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 9 },
  input: { flex: 1, minHeight: 46, maxHeight: 112, borderWidth: 1, borderColor: colors.border, borderRadius: 23, backgroundColor: colors.surfaceElevated, paddingHorizontal: 17, paddingTop: 12, paddingBottom: 12, fontSize: 16, lineHeight: 22, color: colors.text, textAlignVertical: 'center' },
  inputFocused: { borderColor: colors.accent },
  send: { backgroundColor: colors.accent, borderRadius: 23, width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  sendPressed: { opacity: 0.78 },
  disabled: { opacity: 0.35 },
  generating: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, paddingLeft: 4 },
  generatingText: { flex: 1, color: colors.muted, fontSize: 12 },
  cancel: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 8 },
  cancelText: { color: colors.danger, fontSize: 12 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, padding: 12, backgroundColor: colors.dangerSoft, borderRadius: 12 },
  errorText: { flex: 1, color: colors.danger, fontSize: 12, lineHeight: 19 },
  reconnect: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  reconnectText: { color: colors.accent, fontSize: 14 },
})
