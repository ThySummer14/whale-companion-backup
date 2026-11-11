import type { ReactNode } from 'react'
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useReducedMotion } from './motion.ts'

interface MotionPressableProps extends Omit<PressableProps, 'style' | 'onPressIn' | 'onPressOut' | 'children'> {
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}

export function MotionPressable({ style, children, ...props }: MotionPressableProps) {
  const reduced = useReducedMotion()
  const pressed = useSharedValue(0)
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: withTiming(pressed.value ? 0.82 : 1, { duration: reduced ? 0 : 100 }),
    transform: [{ scale: reduced ? 1 : withTiming(pressed.value ? 0.98 : 1, { duration: 120, easing: Easing.out(Easing.cubic) }) }],
  }))
  return <Animated.View style={[{ flex: StyleSheet.flatten(style)?.flex }, animatedStyle]}>
    <Pressable
      {...props}
      style={style}
      onPressIn={() => { pressed.value = 1 }}
      onPressOut={() => { pressed.value = 0 }}
    >
      {children}
    </Pressable>
  </Animated.View>
}
