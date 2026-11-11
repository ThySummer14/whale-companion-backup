import Ionicons from '@expo/vector-icons/Ionicons'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { MotionPressable } from './MotionPressable.tsx'
import { colors } from './theme.ts'
import type { AppIconName } from './IconButton.tsx'

interface BottomNavProps {
  active: 'feed' | 'scenes' | 'chat'
  onFeed: () => void
  onScenes: () => void
  onChat: () => void
  onSettings: () => void
  chatBusy?: boolean
}

const tabs: { id: 'feed' | 'scenes' | 'chat'; label: string; icon: AppIconName; activeIcon: AppIconName }[] = [
  { id: 'feed', label: '动态', icon: 'home-outline', activeIcon: 'home' },
  { id: 'chat', label: '聊天', icon: 'chatbubble-ellipses-outline', activeIcon: 'chatbubble-ellipses' },
  { id: 'scenes', label: '场景', icon: 'grid-outline', activeIcon: 'grid' },
]

export function BottomNav({ active, onFeed, onScenes, onChat, onSettings, chatBusy = false }: BottomNavProps) {
  return <View style={styles.nav}>
    {tabs.map(item => {
      const selected = active === item.id
      const busy = item.id === 'chat' && chatBusy
      return <MotionPressable
        key={item.id}
        style={styles.item}
        accessibilityRole="tab"
        accessibilityState={{ selected, disabled: busy, busy }}
        accessibilityLabel={busy ? '正在打开聊天' : `切换到${item.label}`}
        disabled={busy}
        onPress={item.id === 'feed' ? onFeed : item.id === 'scenes' ? onScenes : onChat}
      >
        {selected && <View style={styles.indicator} />}
        {busy ? <ActivityIndicator size="small" color={colors.accent} /> : <Ionicons name={selected ? item.activeIcon : item.icon} size={23} color={selected ? colors.accent : colors.muted} />}
        <Text style={[styles.label, selected ? styles.active : styles.inactive]}>{busy ? '打开中' : item.label}</Text>
      </MotionPressable>
    })}
    <MotionPressable style={styles.item} accessibilityRole="button" accessibilityLabel="设置" onPress={onSettings}>
      <Ionicons name="settings-outline" size={23} color={colors.muted} />
      <Text style={[styles.label, styles.inactive]}>设置</Text>
    </MotionPressable>
  </View>
}

const styles = StyleSheet.create({
  nav: { minHeight: 62, flexDirection: 'row', alignItems: 'stretch', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.background, paddingHorizontal: 8 },
  item: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3 },
  indicator: { position: 'absolute', top: 0, width: 24, height: 2, borderRadius: 1, backgroundColor: colors.accent },
  label: { fontSize: 11, fontWeight: '500' },
  active: { color: colors.accent },
  inactive: { color: colors.muted },
})
