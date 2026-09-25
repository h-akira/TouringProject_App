const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// US-2.04: インカムのボタンで自アプリが起動できるようにする。
// 方式・却下案は pre-research/handsfree/DECISION.md、実測は同 FINDINGS.md。
//
// ⚠️ **当初は `VoiceInteractionService`（Androidの既定アシスタントRole）で
// 実装していたが、実機で成立しないと判明した。** インカムのボタンは
// AOSP標準の `HeadsetSystemInterface.activateVoiceRecognition()` が
// `Intent.ACTION_VOICE_COMMAND` を発行する経路で、これは
// **Activityのintent-filterで受ける**必要がある（`VoiceInteractionService`
// では受けられない）。Alexa（`com.amazon.dee.app/.../VoiceCommandActivity`）も
// 同じintent-filterを持って初めて選択候補に出ていた（FINDINGS.md §11）。
//
// expo prebuild は android/ を丸ごと作り直すので、この変更はここに書く。
// 手で android/AndroidManifest.xml を編集しても prebuild --clean で消える。

const withVoiceCommandIntentFilter = (config) => {
  return withAndroidManifest(config, (config) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(
      config.modResults,
    );

    if (!mainActivity["intent-filter"]) mainActivity["intent-filter"] = [];
    const hasVoiceCommandFilter = mainActivity["intent-filter"].some((f) =>
      (f.action ?? []).some(
        (a) => a.$["android:name"] === "android.intent.action.VOICE_COMMAND",
      ),
    );
    if (!hasVoiceCommandFilter) {
      mainActivity["intent-filter"].push({
        action: [{ $: { "android:name": "android.intent.action.VOICE_COMMAND" } }],
        category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
      });
    }

    return config;
  });
};

// VOICE_COMMAND で起動された（または既存タスクに再配送された）ことをJS側
// （expo-linking の useURL）に伝える。intentのdataを deep link URLに
// 差し替えてから super.onCreate / super.onNewIntent に渡すことで、
// expo-linking の初期URL解決にそのまま乗せる。
// ⚠️ **expo prebuild のたびに生成される雛形をここで丸ごと上書きする。**
// expo-splashscreen の `@generated` マーカーは自動プラグインの目印なので
// 消さずに残す（他プラグインがこのブロックを見つけて処理する）。
function mainActivityKt(packageName) {
  return `package ${packageName}
import expo.modules.splashscreen.SplashScreenManager

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    redirectVoiceCommandToAutoRecord(intent)
    super.onCreate(null)
  }

  // US-2.04: インカムのボタンは ACTION_VOICE_COMMAND で本Activityを起動する
  // （pre-research/handsfree/FINDINGS.md §11）。アプリが既に起動していると
  // onCreate ではなく onNewIntent が呼ばれるので、両方で拾う。
  override fun onNewIntent(intent: Intent) {
    redirectVoiceCommandToAutoRecord(intent)
    super.onNewIntent(intent)
  }

  private fun redirectVoiceCommandToAutoRecord(intent: Intent) {
    if (intent.action == Intent.ACTION_VOICE_COMMAND) {
      intent.setAction(Intent.ACTION_VIEW)
      // ⚠️ 押すたびに値を変える（時刻を使う）。JS側はURL文字列の変化で
      // 「新しい起動」を検知するので、固定文字列だと2回目以降のボタン押下が
      // 無視される（useURL() の値が変わらないため再発火しない）。
      intent.data = Uri.parse("app:///?autoRecord=" + System.currentTimeMillis())
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
`;
}

const withVoiceCommandMainActivity = (config) => {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const packageName = config.android.package;
      const projectRoot = config.modRequest.platformProjectRoot;
      const filePath = path.join(
        projectRoot,
        "app/src/main/java",
        ...packageName.split("."),
        "MainActivity.kt",
      );
      fs.writeFileSync(filePath, mainActivityKt(packageName));
      return config;
    },
  ]);
};

// 応答後に戻る先（マップアプリ）を選べるようにするため、
// **インストール済みアプリのランチャー項目を引ける**ようにする。
//
// ⚠️ **Android 11+ では既定で他アプリが見えない**（package visibility）。
// `<queries>` を宣言しないと `queryIntentActivities` が空を返し、
// 「戻り先アプリ」の一覧が作れない。
// ⚠️ **`QUERY_ALL_PACKAGES` は使わない。** Google Play の審査対象になる強い権限で、
// ここでは**ランチャーに出るアプリが見えれば足りる**（adr/007「影響」）。
const withLauncherQueries = (config) => {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest.queries) manifest.queries = [];
    const hasLauncherQuery = manifest.queries.some((q) =>
      (q.intent ?? []).some((i) =>
        (i.action ?? []).some(
          (a) => a.$["android:name"] === "android.intent.action.MAIN",
        ),
      ),
    );
    if (!hasLauncherQuery) {
      manifest.queries.push({
        intent: [
          {
            action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
            category: [
              { $: { "android:name": "android.intent.category.LAUNCHER" } },
            ],
          },
        ],
      });
    }
    return config;
  });
};

const withVoiceCommand = (config) => {
  config = withVoiceCommandIntentFilter(config);
  config = withVoiceCommandMainActivity(config);
  config = withLauncherQueries(config);
  return config;
};

module.exports = withVoiceCommand;
