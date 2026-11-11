import type { ReactNode } from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import type { FeedPost } from '../host/types.ts'
import { Avatar } from './Avatar.tsx'
import { IconButton } from './IconButton.tsx'
import { MotionPressable } from './MotionPressable.tsx'
import { useEnterAnimation } from './motion.ts'
import { colors } from './theme.ts'

export function formatFeedTime(value: string): string {
  const time = new Date(value).getTime()
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`
  const date = new Date(value)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function FeedImage({ source, label }: { source: NonNullable<FeedPostRowProps['mediaSource']>; label: string }) {
  return <Image accessibilityLabel={label} source={source} resizeMode="contain" style={styles.media} />
}

interface FeedPostRowProps {
  post: FeedPost
  personaName: string
  index: number
  expanded: boolean
  onToggle: (post: FeedPost) => void
  onReply: (post: FeedPost) => void
  onDelete: (post: FeedPost) => void
  mediaSource?: { uri: string; headers: Record<string, string> }
  children?: ReactNode
}

export function FeedPostRow({ post, personaName, index, expanded, onToggle, onReply, onDelete, mediaSource, children }: FeedPostRowProps) {
  const enter = useEnterAnimation(4, Math.min(index, 4) * 25)
  const companion = post.author === 'companion'
  return <Animated.View style={enter}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${companion ? personaName : '你'}的动态：${post.body || '图片'}`} style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => onToggle(post)}>
      <View style={styles.avatar}>
        {companion ? <Avatar name={personaName} size={44} /> : <View style={styles.userAvatar}><Ionicons name="person-outline" size={24} color={colors.accent} /></View>}
      </View>
      <View style={styles.content}>
        <View style={styles.heading}><Text style={styles.name}>{companion ? personaName : '你'}</Text><Text style={styles.time}>{formatFeedTime(post.createdAt)}</Text></View>
        {!!post.body && <Text selectable style={styles.body}>{post.body}</Text>}
        {mediaSource && <FeedImage source={mediaSource} label="动态附件" />}
        <View style={styles.actions}>
          <MotionPressable accessibilityRole="button" accessibilityLabel={`回复${companion ? personaName : '这条'}动态`} style={styles.reply} onPress={event => { event.stopPropagation(); onReply(post) }}>
            <Ionicons name="chatbubble-outline" size={17} color={colors.muted} />
            <Text style={styles.replyText}>{post.replyCount ? `${post.replyCount} 条回复` : '回复'}</Text>
          </MotionPressable>
          {!companion && <IconButton name="trash-outline" label="删除动态" size={18} onPress={() => onDelete(post)} style={styles.delete} />}
        </View>
      </View>
    </Pressable>
    {expanded && children}
  </Animated.View>
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { backgroundColor: colors.surface },
  avatar: { paddingTop: 2 },
  userAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, minWidth: 0 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  time: { color: colors.dim, fontSize: 11 },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  media: { width: '100%', height: 220, borderRadius: 12, backgroundColor: colors.accentSoft, marginTop: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 8, minHeight: 40 },
  reply: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingRight: 16 },
  replyText: { color: colors.muted, fontSize: 12 },
  delete: { marginLeft: 'auto' },
})
