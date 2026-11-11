import { useCallback, useEffect, useRef } from 'react'
import { AppState, Image, StyleSheet, View } from 'react-native'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useFocusEffect } from 'expo-router'
import { useReducedMotion } from './motion.ts'
import { colors } from './theme.ts'

interface AvatarProps {
  name: string
  size?: number
  online?: boolean
  animated?: boolean
}

export function Avatar({ name, size = 44, online, animated = false }: AvatarProps) {
  const reduced = useReducedMotion()
  const moving = animated && !reduced
  return <View
    accessibilityRole="image"
    accessibilityLabel={`${name}${moving ? '的动态形象' : '的形象'}${online === undefined ? '' : online ? '，在线' : '，离线'}`}
    style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
  >
    {moving ? <AnimatedPortrait /> : <Image accessible={false} source={require('../../assets/persona/whale.png')} resizeMode="cover" fadeDuration={0} style={styles.media} />}
    {online !== undefined && <View style={[styles.status, { width: size * 0.25, height: size * 0.25, borderRadius: size * 0.125, backgroundColor: online ? colors.success : colors.dim }]} />}
  </View>
}

function AnimatedPortrait() {
  const focused = useRef(false)
  const player = useVideoPlayer(require('../../assets/persona/whale.mp4'), instance => {
    instance.loop = true
    instance.muted = true
    instance.audioMixingMode = 'mixWithOthers'
    instance.showNowPlayingNotification = false
    instance.staysActiveInBackground = false
    instance.pause()
  })
  useFocusEffect(useCallback(() => {
    focused.current = true
    if (AppState.currentState === 'active') player.play()
    return () => {
      focused.current = false
      player.pause()
    }
  }, [player]))
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && focused.current) player.play()
      else player.pause()
    })
    return () => subscription.remove()
  }, [player])
  return <VideoView
    player={player}
    style={styles.media}
    contentFit="cover"
    surfaceType="textureView"
    nativeControls={false}
    accessible={false}
    pointerEvents="none"
  />
}

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: colors.avatarBackground,
    borderWidth: 1,
    borderColor: colors.avatarBorder,
    overflow: 'hidden',
  },
  media: { width: '100%', height: '100%' },
  status: { position: 'absolute', right: 0, bottom: 0, borderWidth: 2, borderColor: colors.background },
})
