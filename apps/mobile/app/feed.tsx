import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { useHost } from '../src/host/provider.tsx'
import { Avatar } from '../src/ui/Avatar.tsx'
import { BottomNav } from '../src/ui/BottomNav.tsx'
import { FeedComposer, type ComposerImage } from '../src/ui/FeedComposer.tsx'
import { FeedImage, FeedPostRow, formatFeedTime } from '../src/ui/FeedPostRow.tsx'
import { IconButton } from '../src/ui/IconButton.tsx'
import { MotionPressable } from '../src/ui/MotionPressable.tsx'
import { NavigationDrawer } from '../src/ui/NavigationDrawer.tsx'
import { displayError } from '../src/ui/error-message.ts'
import { useEnterAnimation } from '../src/ui/motion.ts'
import { colors } from '../src/ui/theme.ts'
import type { CompanionEvent, FeedList, FeedPost, FeedThread, WorkbenchView } from '../src/host/types.ts'

export default function FeedScreen() {
  const { client, unpair } = useHost()
  const insets = useSafeAreaInsets()
  const [view, setView] = useState<WorkbenchView>()
  const [feed, setFeed] = useState<FeedList>({ items: [] })
  const [threads, setThreads] = useState<Record<string, FeedThread>>({})
  const [expandedId, setExpandedId] = useState<string>()
  const [composer, setComposer] = useState<FeedPost | 'new' | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const cursor = useRef('0')
  const request = useRef(0)
  const loading = useRef(false)
  const queued = useRef(false)
  const threadRequest = useRef(0)
  const headerEnter = useEnterAnimation(4)
  const load = useCallback(async () => {
    if (!client) return
    if (loading.current) {
      queued.current = true
      return
    }
    loading.current = true
    const current = ++request.current
    try {
      const [nextView, latest] = await Promise.all([client.getState(), client.getFeed()])
      if (current !== request.current) return
      setView(nextView)
      setFeed(latest)
      setLoadingMore(false)
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
  const expandedRef = useRef<string | undefined>(undefined)
  expandedRef.current = expandedId
  const loadThread = useCallback(async (id: string) => {
    if (!client) return
    const current = ++threadRequest.current
    try {
      const thread = await client.getFeedThread(id)
      if (current !== threadRequest.current) return
      setThreads(previous => ({ ...previous, [id]: thread }))
    } catch (failure) {
      if (current === threadRequest.current) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [client])
  useEffect(() => { if (!client) router.replace('/') }, [client])
  useEffect(() => {
    void load()
    if (!client) return
    const unsubscribe = client.subscribe('', cursor.current, {
      status: next => {
        if (next === 'connected') {
          void load()
          if (expandedRef.current) void loadThread(expandedRef.current)
        }
        if (next === 'revoked') setError('device-unauthorized')
      },
      event: (event: CompanionEvent) => {
        if (event.cursor) cursor.current = event.cursor
        if (event.type === 'post.created' || event.type === 'post.deleted' || (event.type === 'activity' && event.payload.kind?.startsWith('post.'))) {
          if (event.type !== 'post.created' || event.payload.post?.author === 'companion') setInviting(false)
          const expanded = expandedRef.current
          const post = event.payload.post
          if (event.type === 'post.deleted' && post?.id === expanded) {
            threadRequest.current += 1
            setExpandedId(undefined)
          } else if (expanded && (post?.id === expanded || post?.parentId === expanded)) {
            void loadThread(expanded)
          }
          void load()
        }
        if (event.type === 'message.failed' || (event.type === 'activity' && ['turn.completed', 'turn.aborted', 'turn.interrupted', 'turn.error'].includes(event.payload.kind ?? ''))) setInviting(false)
      },
    })
    return () => {
      request.current += 1
      threadRequest.current += 1
      loading.current = false
      queued.current = false
      unsubscribe()
    }
  }, [client, load, loadThread])
  const [openingMain, setOpeningMain] = useState(false)
  if (!client) return null
  const personaName = view?.persona.name ?? '小鲸鱼'
  const openMain = async () => {
    if (openingMain) return
    setOpeningMain(true)
    setError(undefined)
    try {
      const state = await client.getState()
      const existing = state.bindings.find(binding => binding.contextId === 'chat.mobile')
      await client.createSession(existing
        ? { contextId: 'chat.mobile', sessionId: existing.sessionId, kind: 'chat', label: '手机主聊天', resume: true }
        : { contextId: 'chat.mobile', kind: 'chat', label: '手机主聊天', resume: false })
      router.push('/chat/chat.mobile')
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setOpeningMain(false) }
  }
  const invite = async () => {
    setInviting(true)
    setError(undefined)
    try {
      const state = await client.getState()
      const existing = state.bindings.find(binding => binding.contextId === 'feed.general')
      await client.createSession(existing
        ? { contextId: 'feed.general', sessionId: existing.sessionId, kind: 'topic', label: '她的动态', resume: true }
        : { contextId: 'feed.general', kind: 'topic', label: '她的动态', resume: false })
      await client.send('feed.general', '请调用 companion_post_create 工具，发布一条不超过 80 字的日常动态。可以聊聊白饭和铁盆，但不要编造真实经历或已经完成的动作。不要只在聊天中给草稿。')
    } catch (failure) {
      setInviting(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  const toggleThread = async (post: FeedPost) => {
    if (expandedId === post.id) {
      threadRequest.current += 1
      setExpandedId(undefined)
      return
    }
    setExpandedId(post.id)
    await loadThread(post.id)
  }
  const publish = async (body: string, parent?: FeedPost, image?: ComposerImage) => {
    if (image && !image.mediaId) image.mediaId = (await client.uploadImage(image)).id
    await client.createFeedPost(body, parent?.id, image?.mediaId)
    setComposer(null)
    if (parent) setExpandedId(parent.id)
    await Promise.all([load(), parent ? loadThread(parent.id) : Promise.resolve()])
  }
  const remove = async (post: FeedPost) => {
    await client.deleteFeedPost(post.id)
    threadRequest.current += 1
    setExpandedId(undefined)
    setThreads(current => { const next = { ...current }; delete next[post.id]; return next })
    await load()
  }
  const loadMore = async () => {
    if (!feed.nextCursor || loadingMore) return
    const current = request.current
    setLoadingMore(true)
    try {
      const next = await client.getFeed(feed.nextCursor)
      if (current !== request.current) return
      setFeed(previous => ({ items: [...previous.items, ...next.items.filter(item => !previous.items.some(old => old.id === item.id))], nextCursor: next.nextCursor }))
    } catch (failure) {
      if (current === request.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (current === request.current) setLoadingMore(false)
    }
  }
  return <SafeAreaView style={styles.safe}>
    <Animated.View style={[styles.header, headerEnter]}>
      <Pressable accessibilityRole="button" accessibilityLabel="打开角色与设置" style={styles.profile} onPress={() => setDrawerOpen(true)}><Avatar name={personaName} size={38} /></Pressable>
      <View style={styles.headerText}><Text style={styles.title}>{personaName}的动态</Text><Text style={styles.subtitle}>她和你，分享同一段日常</Text></View>
      <IconButton name="menu-outline" label="更多选项" size={26} onPress={() => setDrawerOpen(true)} />
    </Animated.View>
    <View style={styles.intro}>
      <Text style={styles.sectionTitle}>最近的动态</Text>
      <MotionPressable accessibilityRole="button" accessibilityLabel="让她写一条动态" disabled={inviting} style={[styles.invite, inviting && styles.disabled]} onPress={() => void invite()}>
        {inviting ? <ActivityIndicator size="small" color={colors.accent} /> : <Ionicons name="sparkles-outline" size={17} color={colors.accent} />}
        <Text style={styles.inviteText}>{inviting ? '正在分享…' : '让她写一条'}</Text>
      </MotionPressable>
    </View>
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surfaceElevated} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
    >
      {error && <View style={styles.error}><Ionicons name="cloud-offline-outline" size={19} color={colors.danger} /><Text style={styles.errorText}>{displayError(error)}</Text></View>}
      {error === 'device-unauthorized' ? <Pressable style={styles.recover} onPress={() => { void unpair().then(() => router.replace('/')) }}><Text style={styles.recoverText}>重新配对</Text></Pressable> : error ? <Pressable style={styles.recover} onPress={() => void load()}><Text style={styles.recoverText}>重试连接</Text></Pressable> : null}
      {!view && !error && <View style={styles.loading}><ActivityIndicator color={colors.accent} /><Text style={styles.loadingText}>正在打开她的日常…</Text></View>}
      {view && !feed.items.length && !error && <View style={styles.empty}>
        <Avatar name={personaName} size={68} />
        <Text style={styles.emptyTitle}>这里还很安静</Text>
        <Text style={styles.emptyDescription}>你可以发布一条动态，或者直接和她说说话。</Text>
        <MotionPressable style={styles.emptyAction} onPress={() => void openMain()}><Text style={styles.emptyActionText}>和她聊聊</Text><Ionicons name="arrow-forward" size={18} color={colors.accentText} /></MotionPressable>
      </View>}
      {feed.items.map((post, index) => {
        const thread = threads[post.id]
        return <FeedPostRow key={post.id} post={post} personaName={personaName} index={index} expanded={expandedId === post.id} onToggle={post => void toggleThread(post)} onReply={setComposer} onDelete={post => void remove(post)} mediaSource={post.mediaId ? client.mediaSource(post.mediaId) : undefined}>
          {thread ? <View style={styles.thread}>
            {thread.replies.map(reply => <View key={reply.id} style={styles.replyRow}>
              {reply.author === 'companion' ? <Avatar name={personaName} size={28} /> : <View style={styles.replyUserAvatar}><Ionicons name="person-outline" size={16} color={colors.accent} /></View>}
              <View style={styles.replyContent}>
                <View style={styles.replyHeading}><Text style={styles.replyName}>{reply.author === 'companion' ? personaName : '你'}</Text><Text style={styles.replyTime}>{formatFeedTime(reply.createdAt)}</Text></View>
                {!!reply.body && <Text style={styles.replyBody}>{reply.body}</Text>}
                {reply.mediaId && <FeedImage source={client.mediaSource(reply.mediaId)} label="回复附件" />}
              </View>
            </View>)}
            {!thread.replies.length && <Text style={styles.noReplies}>还没有回复，来聊一句吧。</Text>}
          </View> : <ActivityIndicator style={styles.threadLoading} size="small" color={colors.accent} />}
        </FeedPostRow>
      })}
      {feed.nextCursor && <MotionPressable style={styles.more} disabled={loadingMore} onPress={() => void loadMore()}>{loadingMore ? <ActivityIndicator size="small" color={colors.accent} /> : <Text style={styles.moreText}>加载更多</Text>}</MotionPressable>}
    </ScrollView>
    <Pressable accessibilityRole="button" accessibilityLabel="发布新动态" style={({ pressed }) => [styles.fab, { bottom: 78 + insets.bottom }, pressed && { opacity: 0.82 }]} onPress={() => setComposer('new')}><Ionicons name="create-outline" size={26} color={colors.accentText} /></Pressable>
    <BottomNav active="feed" onFeed={() => void load()} onScenes={() => router.push('/scenes')} onChat={() => void openMain()} onSettings={() => setDrawerOpen(true)} chatBusy={openingMain} />
    <FeedComposer visible={composer !== null} parent={composer === 'new' ? undefined : composer ?? undefined} personaName={personaName} onClose={() => setComposer(null)} onSubmit={(body, image) => publish(body, composer === 'new' ? undefined : composer ?? undefined, image)} />
    <NavigationDrawer
      visible={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      personaName={personaName}
      subtitle={view?.persona.tagline ?? '共享同一个角色与中央记忆'}
      items={[
        { key: 'feed', icon: 'home-outline', label: '她的动态', detail: '真实发布的文字与回复', onPress: () => setDrawerOpen(false) },
        { key: 'scenes', icon: 'grid-outline', label: '她的场景', detail: '每个话题和活动，都有自己的空间', onPress: () => { setDrawerOpen(false); router.push('/scenes') } },
        { key: 'chat', icon: 'chatbubble-ellipses-outline', label: '手机主聊天', detail: '继续你们的对话', onPress: () => { setDrawerOpen(false); void openMain() } },
        { key: 'host', icon: 'swap-horizontal-outline', label: '更换 Host', detail: '只清除本机配对，不删除她的记忆', danger: true, onPress: () => { setDrawerOpen(false); void unpair() } },
      ]}
    />
  </SafeAreaView>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { paddingBottom: 96 },
  header: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  profile: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 11 },
  intro: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  invite: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 4 },
  inviteText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 64 },
  emptyTitle: { color: colors.text, fontSize: 22, fontWeight: '600', marginTop: 20 },
  emptyDescription: { color: colors.muted, fontSize: 14, lineHeight: 23, textAlign: 'center', marginTop: 10 },
  emptyAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, marginTop: 22, paddingHorizontal: 22, borderRadius: 24, backgroundColor: colors.accent },
  emptyActionText: { color: colors.accentText, fontSize: 15, fontWeight: '600' },
  thread: { marginLeft: 72, marginRight: 16, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.border, paddingBottom: 12, gap: 14 },
  threadLoading: { marginLeft: 72, marginVertical: 16, alignSelf: 'flex-start' },
  replyRow: { flexDirection: 'row', gap: 8 },
  replyUserAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  replyContent: { flex: 1, minWidth: 0 },
  replyHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  replyName: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  replyTime: { color: colors.dim, fontSize: 10 },
  replyBody: { color: colors.text, fontSize: 14, lineHeight: 21, marginTop: 3 },
  noReplies: { color: colors.dim, fontSize: 12 },
  more: { minHeight: 48, margin: 16, borderRadius: 24, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  moreText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
  error: { flexDirection: 'row', gap: 10, margin: 16, padding: 14, backgroundColor: colors.dangerSoft, borderRadius: 12 },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 20 },
  recover: { marginHorizontal: 16, marginBottom: 12, minHeight: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  recoverText: { color: colors.accentText, fontSize: 15, fontWeight: '600' },
  loading: { alignItems: 'center', gap: 14, paddingTop: 72 },
  loadingText: { color: colors.muted, fontSize: 14 },
  fab: { position: 'absolute', right: 16, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
})
