import Ionicons from '@expo/vector-icons/Ionicons'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ContextKind, SessionBinding } from '../host/types.ts'
import type { AppIconName } from './IconButton.tsx'
import { useEnterAnimation } from './motion.ts'
import { colors } from './theme.ts'

const kindLabels: Record<ContextKind, string> = {
  chat: '聊天场景',
  game: '游戏场景',
  task: '任务场景',
  topic: '话题场景',
  system: '系统场景',
}

const kindIcons: Record<ContextKind, AppIconName> = {
  chat: 'chatbubble-outline',
  game: 'game-controller-outline',
  task: 'checkbox-outline',
  topic: 'chatbubbles-outline',
  system: 'layers-outline',
}

interface TimelineRowProps {
  binding: SessionBinding
  personaName: string
  online: boolean
  index: number
  onPress: () => void
}

export function TimelineRow({ binding, online, index, onPress }: TimelineRowProps) {
  const enter = useEnterAnimation(5, Math.min(index, 4) * 30)
  return <Animated.View style={enter}>
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      android_ripple={{ color: colors.ripple }}
      accessibilityRole="button"
      accessibilityLabel={`${binding.label}，${kindLabels[binding.kind]}，${online ? '正在运行' : '尚未运行'}，${binding.contextId}`}
      onPress={onPress}
    >
      <View style={styles.icon}><Ionicons name={kindIcons[binding.kind]} size={22} color={colors.accent} /></View>
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>{binding.label}</Text>
        <Text style={styles.meta} numberOfLines={1}>{kindLabels[binding.kind]} · {online ? '正在运行' : '尚未运行'}</Text>
      </View>
      <View style={[styles.state, online && styles.stateOnline]}>
        <View style={[styles.dot, online && styles.dotOnline]} />
        <Text style={[styles.stateText, online && styles.online]}>{online ? '在线' : '进入'}</Text>
      </View>
      <Ionicons name="chevron-forward" size={17} color={colors.dim} />
    </Pressable>
  </Animated.View>
}

const styles = StyleSheet.create({
  row: { minHeight: 80, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { backgroundColor: colors.surface },
  icon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, gap: 5, minWidth: 0 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12 },
  state: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stateOnline: { gap: 5 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.dim },
  dotOnline: { backgroundColor: colors.success },
  stateText: { color: colors.muted, fontSize: 12 },
  online: { color: colors.success },
})
