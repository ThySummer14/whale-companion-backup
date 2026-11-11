import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { useHost } from '../src/host/provider.tsx'
import { Avatar } from '../src/ui/Avatar.tsx'
import { BottomNav } from '../src/ui/BottomNav.tsx'
import { IconButton } from '../src/ui/IconButton.tsx'
import { displayError } from '../src/ui/error-message.ts'
import { useEnterAnimation } from '../src/ui/motion.ts'
import { NavigationDrawer } from '../src/ui/NavigationDrawer.tsx'
import { MotionPressable } from '../src/ui/MotionPressable.tsx'
import { colors } from '../src/ui/theme.ts'
import { TimelineRow } from '../src/ui/TimelineRow.tsx'
import type { WorkbenchView } from '../src/host/types.ts'

export default function ScenesScreen() {
  const { client, unpair } = useHost()
  const [data, setData] = useState<WorkbenchView>()
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [connection, setConnection] = useState<'connected' | 'reconnecting' | 'offline' | 'revoked'>('reconnecting')
  const headerEnter = useEnterAnimation(4)
  const heroEnter = useEnterAnimation(8, 30)
  const cursor = useRef('0')
  const request = useRef(0)
  const loading = useRef(false)
  const queued = useRef(false)
  const load = useCallback(async () => {
    if (!client) return
    if (loading.current) {
      queued.current = true
      return
    }
    loading.current = true
    const current = ++request.current
    try {
      const next = await client.getState()
      if (current !== request.current) return
      setData(next)
      setError(undefined)
    } catch (failure) {
      if (current === request.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (current !== request.current) return
      loading.current = false
      if (queued.current) {
        queued.current = false
        void load()
      }
    }
  }, [client])
  useEffect(() => { if (!client) router.replace('/') }, [client])
  useEffect(() => {
    if (!client) return
    void load()
    const unsubscribe = client.subscribe('', cursor.current, {
      status: next => {
        setConnection(next)
        if (next === 'connected') void load()
        if (next === 'revoked') setError('device-unauthorized')
      },
      event: event => {
        if (event.cursor) cursor.current = event.cursor
        if (event.type === 'activity' && /^(session|turn|memory|capability|persona|post)\./.test(event.payload.kind ?? '')) void load()
      },
    })
    return () => {
      request.current += 1
      loading.current = false
      queued.current = false
      unsubscribe()
    }
  }, [client, load])
  if (!client) return null
  const createMain = async () => {
    if (opening) return
    setOpening(true)
    setError(undefined)
    try {
      const existing = data?.bindings.find(binding => binding.contextId === 'chat.mobile')
      if (existing) {
        await client.createSession({ contextId: 'chat.mobile', sessionId: existing.sessionId, kind: 'chat', label: '手机主聊天', resume: true })
      } else {
        await client.createSession({ contextId: 'chat.mobile', kind: 'chat', label: '手机主聊天', resume: false })
      }
      router.push('/chat/chat.mobile')
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setOpening(false) }
  }
  const personaName = data?.persona.name ?? '小鲸鱼'
  const mainExists = data?.bindings.some(binding => binding.contextId === 'chat.mobile') ?? false
  const otherBindings = data?.bindings.filter(binding => binding.contextId !== 'chat.mobile') ?? []
  const runningCount = data?.sessions.filter(session => session.status === 'running').length ?? 0
  const connected = connection === 'connected'
  return <SafeAreaView style={styles.safe}>
    <Animated.View style={[styles.header, headerEnter]}>
      <Pressable accessibilityRole="button" accessibilityLabel="打开角色与设置" style={styles.profile} onPress={() => setDrawerOpen(true)}><Avatar name={personaName} size={38} /></Pressable>
      <View style={styles.headerText}><Text style={styles.title}>{personaName}</Text><Text style={styles.subtitle}>陪伴空间</Text></View>
      <IconButton name="menu-outline" label="更多选项" size={26} onPress={() => setDrawerOpen(true)} />
    </Animated.View>
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surfaceElevated} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
    >
      {error && <View style={styles.error}><Ionicons name="cloud-offline-outline" size={20} color={colors.danger} /><Text style={styles.errorText}>{displayError(error)}</Text></View>}
      {error === 'device-unauthorized' ? <Pressable style={styles.recover} onPress={() => { void unpair().then(() => router.replace('/')) }}><Text style={styles.recoverText}>重新配对</Text></Pressable> : error && !data ? <Pressable style={styles.recover} onPress={() => void load()}><Text style={styles.recoverText}>重试连接</Text></Pressable> : null}
      {!data ? !error && <View style={styles.loading}><ActivityIndicator color={colors.accent} /><Text style={styles.loadingText}>正在连接她的世界…</Text></View> : <>
        <Animated.View style={[styles.hero, heroEnter]}>
          <Text style={styles.eyebrow}>你的专属数字伙伴</Text>
          <View style={styles.identity}>
            <Avatar name={personaName} size={84} animated />
            <View style={styles.identityText}>
              <Text style={styles.personaName}>{personaName}</Text>
              <Text style={styles.tagline} numberOfLines={2}>{data.persona.tagline}</Text>
            </View>
          </View>
          <View style={styles.metadata}>
            <View style={styles.metadataItem}><Ionicons name="layers-outline" size={14} color={colors.muted} /><Text style={styles.metadataText}>{data.bindings.length} 个场景 · {data.memory.active} 条活跃记忆</Text></View>
            <View style={styles.metadataItem}><View style={[styles.hostDot, !connected && styles.hostDotWaiting]} /><Text style={[styles.hostText, !connected && styles.hostWaiting]}>{connected ? 'Host 已连接' : connection === 'revoked' ? 'Host 已撤销' : 'Host 重连中'}</Text></View>
          </View>
          <MotionPressable
            style={styles.mainAction}
            accessibilityRole="button"
            accessibilityLabel={mainExists ? '进入手机主聊天' : '创建手机主聊天'}
            accessibilityState={{ disabled: opening, busy: opening }}
            disabled={opening}
            onPress={() => void createMain()}
          >
            <View style={styles.mainActionIcon}><Ionicons name="chatbubble-ellipses" size={23} color={colors.accentText} /></View>
            <View style={styles.mainActionText}><Text style={styles.mainActionTitle}>{opening ? '正在打开…' : '和她聊聊'}</Text><Text style={styles.mainActionSubtitle}>{mainExists ? '继续你们的对话' : '从第一句话开始认识彼此'}</Text></View>
            {opening ? <ActivityIndicator size="small" color={colors.accentText} /> : <Ionicons name="arrow-forward" size={21} color={colors.accentText} />}
          </MotionPressable>
        </Animated.View>
        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>{mainExists ? '她的其他场景' : '她的场景'}</Text><Text style={styles.sectionCount}>{runningCount} 个运行中</Text></View>
        {otherBindings.map((binding, index) => <TimelineRow
          key={binding.contextId}
          binding={binding}
          index={index}
          personaName={personaName}
          online={data.sessions.some(session => session.id === binding.sessionId && session.status === 'running')}
          onPress={() => router.push(`/chat/${binding.contextId}`)}
        />)}
        {!otherBindings.length && <Text style={styles.empty}>新的话题和活动，会在这里出现。</Text>}
      </>}
    </ScrollView>
    <BottomNav active="scenes" onFeed={() => router.push('/feed')} onScenes={() => setDrawerOpen(false)} onChat={() => void createMain()} onSettings={() => setDrawerOpen(true)} chatBusy={opening} />
    <NavigationDrawer
      visible={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      personaName={personaName}
      subtitle={data?.persona.tagline ?? '共享同一个角色与中央记忆'}
      items={[
        { key: 'feed', icon: 'home-outline', label: '她的动态', detail: '真实发布的文字与回复', onPress: () => { setDrawerOpen(false); router.push('/feed') } },
        { key: 'scenes', icon: 'grid-outline', label: '她的场景', detail: '每个话题和活动，都有自己的空间', onPress: () => setDrawerOpen(false) },
        { key: 'chat', icon: 'chatbubble-ellipses-outline', label: '手机主聊天', detail: '继续你们的对话', onPress: () => { setDrawerOpen(false); void createMain() } },
        { key: 'host', icon: 'swap-horizontal-outline', label: '更换 Host', detail: '只清除本机配对，不删除她的记忆', danger: true, onPress: () => { setDrawerOpen(false); void unpair() } },
      ]}
    />
  </SafeAreaView>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { paddingBottom: 32 },
  header: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  profile: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 11 },
  hero: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 22, backgroundColor: colors.hero, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: '600', letterSpacing: 0.4, marginBottom: 16 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identityText: { flex: 1, minWidth: 0, gap: 5 },
  personaName: { color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.3 },
  tagline: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  metadata: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 18 },
  metadataItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metadataText: { color: colors.muted, fontSize: 11 },
  hostDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.success },
  hostDotWaiting: { backgroundColor: colors.warning },
  hostText: { color: colors.success, fontSize: 11 },
  hostWaiting: { color: colors.warning },
  mainAction: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 22, paddingHorizontal: 14, paddingVertical: 12, minHeight: 68, borderRadius: 18, backgroundColor: colors.accent },
  mainActionPressed: { opacity: 0.82 },
  mainActionIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#ffffff1c', alignItems: 'center', justifyContent: 'center' },
  mainActionText: { flex: 1, gap: 3 },
  mainActionTitle: { color: colors.accentText, fontSize: 16, fontWeight: '700' },
  mainActionSubtitle: { color: '#e3f3ff', fontSize: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  sectionCount: { color: colors.muted, fontSize: 11 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: 'center', marginTop: 40, paddingHorizontal: 24 },
  error: { flexDirection: 'row', gap: 10, margin: 16, padding: 14, backgroundColor: colors.dangerSoft, borderRadius: 12 },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 20 },
  recover: { marginHorizontal: 16, minHeight: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  recoverText: { color: colors.accentText, fontSize: 15, fontWeight: '600' },
  loading: { alignItems: 'center', gap: 14, paddingTop: 72 },
  loadingText: { color: colors.muted, fontSize: 14 },
})
