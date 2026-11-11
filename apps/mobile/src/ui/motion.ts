import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Animated, Easing, type ViewStyle } from 'react-native'

const ReducedMotionContext = createContext(false)

export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let mounted = true
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduced(value) }).catch(() => {})
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => { mounted = false; subscription.remove() }
  }, [])
  return createElement(ReducedMotionContext.Provider, { value: reduced }, children)
}

export function useReducedMotion(): boolean {
  return useContext(ReducedMotionContext)
}

export function useEnterAnimation(distance = 6, delay = 0): Animated.AnimatedProps<ViewStyle> {
  const reduced = useReducedMotion()
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current
  useEffect(() => {
    if (reduced) {
      progress.setValue(1)
      return
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 180,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    })
    animation.start()
    return () => animation.stop()
  }, [delay, progress, reduced])
  return {
    opacity: progress,
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
  }
}
