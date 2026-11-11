import { useEffect, useRef, useState } from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { Animated, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Avatar } from './Avatar.tsx'
import { IconButton, type AppIconName } from './IconButton.tsx'
import { useReducedMotion } from './motion.ts'
import { colors } from './theme.ts'

interface DrawerItem {
  key: string
  icon: AppIconName
  label: string
  detail?: string
  danger?: boolean
  onPress: () => void
}

interface NavigationDrawerProps {
  visible: boolean
  onClose: () => void
  personaName: string
  subtitle: string
  items: DrawerItem[]
}

export function NavigationDrawer({ visible, onClose, personaName, subtitle, items }: NavigationDrawerProps) {
  const window = useWindowDimensions()
  const width = Math.min(328, window.width * 0.86)
  const reduced = useReducedMotion()
  const [mounted, setMounted] = useState(visible)
  const translate = useRef(new Animated.Value(-width)).current
  useEffect(() => {
    if (reduced) {
      setMounted(visible)
      translate.setValue(visible ? 0 : -width)
      return
    }
    const animation = Animated.timing(translate, { toValue: visible ? 0 : -width, duration: visible ? 180 : 160, useNativeDriver: true })
    if (visible) setMounted(true)
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false) })
    return () => animation.stop()
  }, [reduced, translate, visible, width])
  if (!mounted) return null
  return <Modal transparent visible={mounted} animationType={reduced ? 'none' : 'fade'} statusBarTranslucent onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭导航" onPress={onClose} />
      <Animated.View style={[styles.panel, { width, transform: [{ translateX: translate }] }]}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.header}>
            <Avatar name={personaName} size={56} />
            <View style={styles.headerText}><Text numberOfLines={1} style={styles.title}>{personaName}</Text><Text numberOfLines={2} style={styles.subtitle}>{subtitle}</Text></View>
            <IconButton name="close" label="关闭设置" size={25} onPress={onClose} style={styles.close} />
          </View>
          <Text style={styles.sectionTitle}>你的空间</Text>
          <View style={styles.items}>
            {items.map(item => <Pressable key={item.key} style={({ pressed }) => [styles.item, pressed && styles.pressed]} onPress={item.onPress} accessibilityRole="button">
              <View style={[styles.itemIcon, item.danger && styles.dangerIcon]}><Ionicons name={item.icon} size={21} color={item.danger ? colors.danger : colors.accent} /></View>
              <View style={styles.itemText}><Text style={[styles.itemTitle, item.danger && styles.danger]}>{item.label}</Text>{item.detail && <Text style={styles.detail}>{item.detail}</Text>}</View>
              {!item.danger && <Ionicons name="chevron-forward" size={17} color={colors.dim} />}
            </Pressable>)}
          </View>
          <View style={styles.footer}><Ionicons name="shield-checkmark-outline" size={17} color={colors.dim} /><Text style={styles.footerText}>同一个角色，记忆留在你的 Host 上</Text></View>
        </SafeAreaView>
      </Animated.View>
    </View>
  </Modal>
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)' },
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.surface, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  safe: { flex: 1, paddingHorizontal: 18 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headerText: { flex: 1, minWidth: 0, gap: 5 },
  close: { marginRight: -10 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: '500', marginTop: 24, marginBottom: 8, marginLeft: 4 },
  items: { gap: 4 },
  item: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 10, borderRadius: 12 },
  itemIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  itemText: { flex: 1, minWidth: 0, gap: 4 },
  itemTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  detail: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  danger: { color: colors.danger },
  dangerIcon: { backgroundColor: colors.dangerSoft },
  pressed: { backgroundColor: colors.surfaceElevated },
  footer: { marginTop: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  footerText: { flex: 1, color: colors.dim, fontSize: 11, lineHeight: 18 },
})
