/**
 * 応答後にマップアプリを前面へ戻す（US-2.04）。
 *
 * ⚠️ **Androidのみ。** iOSは対象外（docs/00_user_stories.md §5「やらないこと」）。
 * ⚠️ **`moveTaskToBack` では戻せない**（ホームに落ちる）と実機で確定したため、
 * **戻り先アプリをLAUNCHERインテントで開く**方式になっている。
 * 理由と実測は `android/.../AppForegroundModule.kt` と
 * `pre-research/handsfree/FINDINGS.md` §13.4〜13.5。
 */
import { requireNativeModule } from "expo-modules-core";
import type { LaunchableApp } from "@/api/returnApp";

declare class AppForegroundModule {
  /**
   * 戻り先として選べるアプリ（ランチャーに出るもの）を名前順で返す。
   *
   * ⚠️ **`<queries>` の宣言が無いと黙って空になる**（Android 11+ の
   * package visibility。`plugins/withVoiceInteraction.js` で宣言済み）。
   */
  listLaunchableApps(): Promise<LaunchableApp[]>;

  /**
   * 指定のアプリを前面に出す。
   *
   * ⚠️ **起動し直しではなく、既存のタスクの再開になる**ので、
   * **案内中のルートは壊れない**（実機で確認済み。FINDINGS.md §13.5）。
   *
   * @returns 開けたら true。⚠️ **false でも例外にはならない**
   *   （アンインストール済み等）ので、呼び出し側で見ること。
   */
  launchApp(packageName: string): Promise<boolean>;
}

export default requireNativeModule<AppForegroundModule>("AppForeground");
