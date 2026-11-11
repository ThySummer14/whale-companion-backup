import { useEffect, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { useHost } from '../src/host/provider.tsx'
import { Avatar } from '../src/ui/Avatar.tsx'
import { displayError } from '../src/ui/error-message.ts'
import { colors } from '../src/ui/theme.ts'

export default function PairScreen() {
  const { client, busy, error, pair, unpair } = useHost()
  const [link, setLink] = useState('')
  useEffect(() => { if (client) router.replace('/feed') }, [client])
  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} automaticOffset>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}><Avatar name="小鲸鱼" size={68} /><Text style={styles.brandName}>COMPANION</Text></View>
        <Text style={styles.title}>把小鲸鱼带在身边</Text>
        <Text style={styles.subtitle}>连接你的 Mac mini，随时和她聊聊。</Text>
        <View style={styles.form}>
          <Text style={styles.label}>一次性配对链接</Text>
          <TextInput
            accessibilityLabel="一次性配对链接"
            style={styles.input}
            multiline
            placeholder="companion://pair?p=…"
            placeholderTextColor={colors.dim}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
            value={link}
            onChangeText={setLink}
          />
          <Text style={styles.hint}>在 DSH 的 Companion → 设备中生成链接，粘贴到这里即可。</Text>
          {error && <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.danger} /><Text style={styles.errorText}>{displayError(error)}</Text></View>}
          <Pressable accessibilityRole="button" accessibilityLabel="配对" style={({ pressed }) => [styles.button, (busy || !link.trim()) && styles.disabled, pressed && styles.pressed]} disabled={busy || !link.trim()} onPress={() => void pair(link).catch(() => {})}>
            {busy ? <ActivityIndicator color={colors.accentText} /> : <><Ionicons name="link-outline" size={20} color={colors.accentText} /><Text style={styles.buttonText}>连接 Mac mini</Text><Ionicons name="arrow-forward" size={20} color={colors.accentText} /></>}
          </Pressable>
          {client && <Pressable style={styles.secondary} onPress={() => void unpair()}><Text style={styles.secondaryText}>取消本机配对</Text></Pressable>}
        </View>
        <View style={styles.note}><Ionicons name="shield-checkmark-outline" size={22} color={colors.success} /><Text style={styles.noteText}>原生设备凭据使用系统安全存储。手机不接触 DSH 启动令牌或模型密钥，聊天与记忆留在你的 Host 上。</Text></View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 36, paddingBottom: 28 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 28 },
  brandName: { color: colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 2.2 },
  title: { fontSize: 30, lineHeight: 40, fontWeight: '700', letterSpacing: -0.4, color: colors.text },
  subtitle: { fontSize: 16, lineHeight: 25, color: colors.muted, marginTop: 8 },
  form: { marginTop: 32 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 10 },
  input: { minHeight: 112, maxHeight: 144, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.surfaceElevated, padding: 16, fontSize: 14, lineHeight: 21, color: colors.text, textAlignVertical: 'top' },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 19, marginTop: 10 },
  button: { flexDirection: 'row', gap: 10, minHeight: 52, borderRadius: 26, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  buttonText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  secondary: { alignItems: 'center', minHeight: 44, justifyContent: 'center', marginTop: 8 },
  secondaryText: { color: colors.danger, fontSize: 14 },
  error: { flexDirection: 'row', gap: 8, marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: colors.dangerSoft },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 20 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 'auto', paddingTop: 36 },
  noteText: { flex: 1, color: colors.muted, lineHeight: 21, fontSize: 12 },
})
