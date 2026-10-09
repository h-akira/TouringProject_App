import { Stack } from "expo-router";
import { useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";

// Once the app's JS has loaded, hide the splash screen.
// Without this, the splash (configured in app.json) can stay on screen.
export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  // SafeAreaProvider must wrap the app for useSafeAreaInsets to report real
  // values; without it the bottom button sits under Android's navigation bar.
  return (
    <SafeAreaProvider>
      {/* ⚠️ メイン画面は見出しを出さない（"index" と出て縦を取り、下の
          「新しい会話を始める」がスクロールしないと見えなくなっていた）。
          設定画面は戻る矢印のために見出しを残す。 */}
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: "設定" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
