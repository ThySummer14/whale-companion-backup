import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { HostProvider } from '../src/host/provider.tsx'
import { MotionProvider } from '../src/ui/motion.ts'
import { colors } from '../src/ui/theme.ts'

export default function Layout() {
  return <MotionProvider><KeyboardProvider preload={false}>
    <HostProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, headerTitleStyle: { fontWeight: '600' }, animation: 'slide_from_right', animationDuration: 180, animationTypeForReplace: 'push', gestureEnabled: true }}>
        <Stack.Screen name="index" options={{ title: '配对 Host', headerShown: false }} />
        <Stack.Screen name="feed" options={{ headerShown: false }} />
        <Stack.Screen name="scenes" options={{ headerShown: false }} />
        <Stack.Screen name="chat/[contextId]" options={{ headerShown: false }} />
      </Stack>
    </HostProvider>
  </KeyboardProvider></MotionProvider>
}
