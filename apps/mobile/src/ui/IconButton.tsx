import type { ComponentProps } from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { colors } from './theme.ts'

export type AppIconName = ComponentProps<typeof Ionicons>['name']

interface IconButtonProps {
  name: AppIconName
  label: string
  onPress: () => void
  size?: number
  color?: string
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}

export function IconButton({ name, label, onPress, size = 22, color = colors.muted, disabled = false, style }: IconButtonProps) {
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.button, style, pressed && styles.pressed, disabled && styles.disabled]}
  >
    <Ionicons name={name} size={size} color={color} />
  </Pressable>
}

const styles = StyleSheet.create({
  button: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  pressed: { backgroundColor: colors.accentSoft },
  disabled: { opacity: 0.4 },
})
