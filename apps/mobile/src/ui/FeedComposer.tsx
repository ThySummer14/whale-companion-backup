import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Image, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import type { FeedPost } from '../host/types.ts'
import { IconButton } from './IconButton.tsx'
import { MotionPressable } from './MotionPressable.tsx'
import { displayError } from './error-message.ts'
import { useReducedMotion } from './motion.ts'
import { colors } from './theme.ts'

export interface ComposerImage {
  uri: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  dataBase64: string
  mediaId?: string
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface FeedComposerProps {
  visible: boolean
  parent?: FeedPost
  personaName: string
  onClose: () => void
  onSubmit: (body: string, image?: ComposerImage) => Promise<void>
}

export function FeedComposer({ visible, parent, personaName, onClose, onSubmit }: FeedComposerProps) {
  const reduced = useReducedMotion()
  const [mounted, setMounted] = useState(visible)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [image, setImage] = useState<ComposerImage>()
  const translateY = useRef(new Animated.Value(320)).current
  useEffect(() => {
    setInput('')
    setImage(undefined)
    setError(undefined)
    setBusy(false)
  }, [visible, parent?.id])
  useEffect(() => {
    if (reduced) {
      setMounted(visible)
      translateY.setValue(visible ? 0 : 320)
      return
    }
    if (visible) setMounted(true)
    const animation = Animated.timing(translateY, { toValue: visible ? 0 : 320, duration: visible ? 200 : 160, useNativeDriver: true })
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false) })
    return () => animation.stop()
  }, [reduced, translateY, visible])
  if (!mounted) return null
  const pick = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, base64: Platform.OS === 'web' })
      const asset = result.canceled ? undefined : result.assets[0]
      if (!asset) return
      const file = Platform.OS === 'web' ? asset.file : new File(asset.uri)
      if (!file?.size || file.size > MAX_IMAGE_BYTES) {
        setError('请选择 10MB 以内的图片')
        return
      }
      const mimeType = asset.mimeType || file.type
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp') {
        setError('请选择 JPEG、PNG 或 WebP 图片')
        return
      }
      const dataBase64 = file instanceof File ? await file.base64() : asset.base64
      if (!dataBase64) throw new Error('无法读取所选图片')
      setImage({ uri: asset.uri, mimeType, dataBase64 })
    } catch (failure) {
      setError(displayError(failure))
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    const body = input.trim()
    if ((!body && !image) || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit(body, image)
      setInput('')
      onClose()
    } catch (failure) {
      setError(displayError(failure))
    } finally {
      setBusy(false)
    }
  }
  return <Modal transparent visible={mounted} animationType={reduced ? 'none' : 'fade'} statusBarTranslucent onRequestClose={() => { if (!busy) onClose() }}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} automaticOffset>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭编辑器" onPress={onClose} disabled={busy} />
      <Animated.View style={[styles.panel, { transform: [{ translateY }] }]}>
        <SafeAreaView edges={['bottom']} style={styles.safe}>
          <View style={styles.handle} />
          <View style={styles.heading}><Text style={styles.title}>{parent ? `回复${personaName}` : '发布新动态'}</Text><IconButton name="close" label="关闭" onPress={onClose} disabled={busy} /></View>
          {parent && <Text numberOfLines={2} style={styles.parent}>{parent.body}</Text>}
          <TextInput
            accessibilityLabel="动态内容"
            autoFocus
            multiline
            maxLength={4000}
            style={styles.input}
            placeholder={parent ? '和她一起聊聊这条动态…' : '今天有什么想分享的？'}
            placeholderTextColor={colors.dim}
            value={input}
            onChangeText={setInput}
          />
          <View style={styles.attachRow}><MotionPressable accessibilityRole="button" accessibilityLabel="选择图片" disabled={busy} onPress={() => void pick()}><Text style={styles.attach}>{image ? '更换图片' : '添加图片'}</Text></MotionPressable>{image && <MotionPressable accessibilityRole="button" accessibilityLabel="移除图片" disabled={busy} onPress={() => setImage(undefined)}><Text style={styles.attach}>移除</Text></MotionPressable>}</View>
          {image && <Image accessibilityLabel="待发布图片预览" source={{ uri: image.uri }} resizeMode="cover" style={styles.mediaPreview} />}
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.footer}><Text style={styles.hint}>{parent ? '回复会出现在这条动态下面' : '把此刻的想法留在这里'}</Text><MotionPressable accessibilityRole="button" accessibilityLabel={parent ? '回复' : '发布'} disabled={busy || (!input.trim() && !image)} style={[styles.submit, (busy || (!input.trim() && !image)) && styles.disabled]} onPress={() => void submit()}>
            {busy ? <ActivityIndicator color={colors.accentText} size="small" /> : <Text style={styles.submitText}>{parent ? '回复' : '发布'}</Text>}
          </MotionPressable></View>
        </SafeAreaView>
      </Animated.View>
    </KeyboardAvoidingView>
  </Modal>
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(23,38,51,0.24)' },
  panel: { backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  safe: { paddingHorizontal: 18, paddingTop: 8 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 6 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52 },
  title: { color: colors.text, fontSize: 19, fontWeight: '600' },
  parent: { color: colors.muted, fontSize: 13, lineHeight: 20, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  input: { minHeight: 112, maxHeight: 180, color: colors.text, fontSize: 17, lineHeight: 25, textAlignVertical: 'top', paddingVertical: 12 },
  attachRow: { flexDirection: 'row', gap: 16, minHeight: 40, alignItems: 'center' },
  attach: { color: colors.accent, fontSize: 13, fontWeight: '600', paddingVertical: 8 },
  mediaPreview: { width: '100%', height: 160, borderRadius: 12, backgroundColor: colors.accentSoft, marginBottom: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  hint: { flex: 1, color: colors.dim, fontSize: 11, lineHeight: 17 },
  submit: { minWidth: 82, minHeight: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  submitText: { color: colors.accentText, fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
})
