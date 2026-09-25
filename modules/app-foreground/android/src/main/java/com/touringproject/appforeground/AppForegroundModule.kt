package com.touringproject.appforeground

import android.content.Intent
import android.util.Log
import java.text.Collator
import java.util.Locale
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// US-2.04: 回答が届いたら、ナビ中のマップアプリを前面に戻す。
//
// インカムのボタンで起動すると、本アプリは FLAG_ACTIVITY_NEW_TASK で新規タスクとして
// 前面に出るため、直前まで見えていたマップが引っ込む (adr/006「影響」)。
// 走行中は画面に触れないので、戻す操作も自動でなければハンズフリーが完結しない。
//
// ⚠️ **`moveTaskToBack` では戻せないと実機で確定した** (2026-08-21)。
// 自分のタスクを下げるだけで、次に何を前面に出すかは決めないため、
// **ホーム画面に落ちる** (pre-research/handsfree/FINDINGS.md §13.4)。
// ⚠️ **他アプリのタスクを前面に上げることもできない**
// (`getAppTasks()` は自分のタスクしか返さない。Android 5 以降のプライバシー制限)。
//
// ✅ **そこで「戻り先アプリをLAUNCHERインテントで開く」方式にした。**
// ⚠️ **これは起動し直しではない。** 実機で確認したところ、LAUNCHERインテントは
// **既存のタスクを再開する** (タスクIDが変わらない) ので、
// **案内中のルートはそのまま残る** (同 §13.5)。
//
// ⚠️ **どのアプリでナビ中かはアプリ側から知り得ない** (他アプリの前面判定は
// Android 5 以降塞がれている) ため、**戻り先は利用者が設定で選ぶ。**
class AppForegroundModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppForeground")

    // 戻り先として選べるアプリの一覧（ランチャーに出るものだけ）。
    //
    // ⚠️ **`<queries>` の宣言が要る。** Android 11+ は既定で他アプリが見えず、
    // 宣言が無いと**黙って空の一覧が返る**（plugins/withVoiceInteraction.js）。
    AsyncFunction("listLaunchableApps") {
      val pm = appContext.reactContext?.packageManager
        ?: return@AsyncFunction emptyList<Map<String, String>>()
      val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
      pm.queryIntentActivities(intent, 0)
        .map {
          mapOf(
            "packageName" to it.activityInfo.packageName,
            "label" to it.loadLabel(pm).toString(),
          )
        }
        // 同じパッケージが複数の入口を出すことがあるので畳む。
        .distinctBy { it["packageName"] }
        // ⚠️ **`sortedBy` だと日本語が五十音順にならない**（UTF-16のコード順に
        // なり、ひらがな・カタカナ・漢字がブロックごとに固まる）。
        // 走行前に一覧から目的のアプリを探すので、並び順は素直な方がよい。
        .sortedWith(compareBy(Collator.getInstance(Locale.JAPANESE)) { it["label"] ?: "" })
    }

    // 指定のアプリを前面に出す。
    //
    // ⚠️ **`FLAG_ACTIVITY_NEW_TASK` が要る**（Activity以外の文脈から開くため）。
    // ⚠️ **`CLEAR_TOP` 等は付けない。** 付けると画面が作り直され、
    // **案内中のルートを壊しうる。** 素のLAUNCHERインテントなら既存タスクが再開する。
    //
    // 戻り値は「開けたか」。⚠️ **false を握り潰さない**（アンインストール済み等）。
    AsyncFunction("launchApp") { packageName: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      val intent: Intent = context.packageManager.getLaunchIntentForPackage(packageName)
        ?: return@AsyncFunction false
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        // ⚠️ **握り潰さない。** 戻れなかった原因（アンインストール済みなのか、
        // 背面からの起動制限なのか）が分からないと切り分けられない。
        // JS側と同じ `handsfree` で追えるようにしておく。
        Log.w("handsfree", "failed to launch $packageName", e)
        false
      }
    }.runOnQueue(Queues.MAIN)
  }
}
