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
      <Stack />
    </SafeAreaProvider>
  );
}
