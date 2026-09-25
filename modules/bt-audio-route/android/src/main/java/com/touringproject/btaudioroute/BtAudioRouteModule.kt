package com.touringproject.btaudioroute

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

// インカム（Bluetooth）のマイクで録音するための、SCO 経路の確立と解放。
//
// ## なぜ自前で書くのか
//
// expo-audio 1.1.1 の setInput() は setCommunicationDevice() に「入力デバイス」を
// 渡しているが、公式仕様は出力(sink)デバイスしか受け付けない:
//
//   > Only devices in a sink role (AKA output devices, see AudioDeviceInfo#isSink())
//   > can be specified. The matching source device is selected automatically
//   > by the platform.
//
// 渡しても例外は出ず false が返るだけで、expo-audio はその戻り値を捨てている。
// 結果、アプリ側にエラーが一切見えないまま SCO が張られず、録音は全サンプル0の
// 無音になっていた（pre-research/mic-routing/）。
//
// ## この方式が正しいことの裏づけ
//
// 同じ端末の dumpsys audio に、Googleレコーダーが成功したときの記録が残っていた:
//
//   setCommunicationRouteForClient ... device: role:output type:bt_sco
//     isPrivileged: false  from API: setCommunicationDevice()
//   BtHelper.onScoAudioStateChanged, state: 12      ← 181ms 後に確立
//
// つまり「出力(sink)を渡す」だけで SCO は張れ、特権APIは要らない。
//
// ## 役割を録音まで広げない
//
// ここが持つのは経路だけで、録音は expo-audio のままにする。上のログのとおり
// SCO の確立は録音とは独立して成立するため、MediaRecorder を自前で抱える
// 必要がない（App/ への展開も小さく済む）。
class BtAudioRouteModule : Module() {
  private val audioManager: AudioManager
    get() = requireNotNull(appContext.reactContext) { "reactContext がない" }
      .getSystemService(Context.AUDIO_SERVICE) as AudioManager

  // acquire の多重実行を防ぐ。経路は端末で1つしかないので、重なると
  // 「どちらのリスナーが誰の完了を見ているか」が混ざる。
  private val acquiring = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("BtAudioRoute")

    // 通信デバイスの一覧と、いま選ばれているものを返す（診断用）。
    //
    // ⚠️ getAvailableCommunicationDevices() は【出力】を返す。
    // expo-audio の getAvailableInputs() が返す【入力】の一覧とは別物で、
    // setCommunicationDevice() に渡してよいのはこちらだけ。
    AsyncFunction("getDevices") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        throw CodedException("Android 12 未満は対象外（setCommunicationDevice が無い）")
      }
      val am = audioManager
      mapOf(
        "available" to am.availableCommunicationDevices.map { describe(it) },
        "current" to am.communicationDevice?.let { describe(it) },
        "mode" to modeName(am.mode),
        // SCO の出力が一覧にあるか。⚠️ A2DP 接続中は出てこない端末があるため、
        // 「ペアリング済み ≠ 指名できる」を見分けられるようにする。
        "hasScoOutput" to am.availableCommunicationDevices.any { it.type == SCO_TYPE },
      )
    }.runOnQueue(Queues.MAIN)

    // SCO を張る。AOSP javadoc / Audio Manager self-managed call guide の手順どおり:
    //
    //   1. リスナーを登録する
    //   2. setMode(MODE_IN_COMMUNICATION)
    //      ⚠️ setSpeakerphoneOn() は呼ばない（通信デバイスの指名を上書きしうる）
    //   3. getAvailableCommunicationDevices() から SCO の【出力】を取る
    //   4. setCommunicationDevice(sink) → ⚠️ 戻り値を必ず見る
    //   5. リスナーで切替の完了を待つ（固定 sleep ではない）
    //
    // 入力は「プラットフォームが自動で対にする」ので setPreferredDevice() は呼ばない。
    AsyncFunction("acquireSco") { timeoutMs: Int, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        promise.reject(CodedException("Android 12 未満は対象外"))
        return@AsyncFunction
      }
      if (!acquiring.compareAndSet(false, true)) {
        promise.reject(CodedException("すでに確立処理中"))
        return@AsyncFunction
      }

      val am = audioManager
      val startedAt = System.currentTimeMillis()

      // ⚠️ すでに SCO なら張り直さない。解放と確立が交差すると、
      // 直前の切断イベントを「確立した」と読み違える。
      am.communicationDevice?.let { current ->
        if (current.type == SCO_TYPE) {
          acquiring.set(false)
          promise.resolve(result(true, current, 0, "すでにSCO"))
          return@AsyncFunction
        }
      }

      // 2. モードを立てる。
      // ⚠️ expo-audio の setAudioModeAsync({ shouldRouteThroughEarpiece }) は
      // これに加えて setSpeakerphoneOn() も呼ぶので、そちらは使わせない
      // （公式手順が明示的に禁じている操作）。
      am.mode = AudioManager.MODE_IN_COMMUNICATION

      // 3. SCO の【出力】を探す。
      val sink = am.availableCommunicationDevices.firstOrNull { it.type == SCO_TYPE }
      if (sink == null) {
        // 経路が張れないことを、無音という形ではなくここで言い切る。
        am.mode = AudioManager.MODE_NORMAL
        acquiring.set(false)
        promise.resolve(
          result(false, null, elapsed(startedAt), "SCOの出力が一覧に無い（接続を確認）"),
        )
        return@AsyncFunction
      }

      // 5. 先にリスナーを張る。⚠️ set の後だと、間に合ったイベントを取り逃す。
      val settled = AtomicBoolean(false)
      val handler = android.os.Handler(android.os.Looper.getMainLooper())
      lateinit var listener: AudioManager.OnCommunicationDeviceChangedListener
      lateinit var onTimeout: Runnable

      fun finish(ok: Boolean, device: AudioDeviceInfo?, note: String) {
        if (!settled.compareAndSet(false, true)) return
        handler.removeCallbacks(onTimeout)
        runCatching { am.removeOnCommunicationDeviceChangedListener(listener) }
        if (!ok) {
          // 張れなかったのにモードを立てたままにしない（端末の音の出方が変わる）。
          runCatching {
            am.clearCommunicationDevice()
            am.mode = AudioManager.MODE_NORMAL
          }
        }
        acquiring.set(false)
        promise.resolve(result(ok, device, elapsed(startedAt), note))
      }

      listener = AudioManager.OnCommunicationDeviceChangedListener { device ->
        if (device?.type == SCO_TYPE) finish(true, device, "確立")
      }
      am.addOnCommunicationDeviceChangedListener({ it.run() }, listener)

      // ⚠️ 公式は「最大30秒」と言うが、そこまで待たない。
      // 走行中はボタンを押してから録音が始まるまでの遅延になるため、
      // 実測（Googleレコーダーで181ms）から見て余裕のある値で打ち切る。
      onTimeout = Runnable {
        finish(false, am.communicationDevice, "確立待ちがタイムアウト")
      }
      handler.postDelayed(onTimeout, timeoutMs.toLong())

      // 4. 指名する。⚠️ 戻り値を捨てない（expo-audio はここを捨てていた）。
      val accepted = runCatching { am.setCommunicationDevice(sink) }
        .onFailure { Log.w(TAG, "setCommunicationDevice が例外", it) }
        .getOrDefault(false)

      if (!accepted) {
        finish(false, null, "setCommunicationDevice が false を返した")
        return@AsyncFunction
      }

      // ⚠️ すでに切替が済んでいてイベントが来ない場合に備える。
      am.communicationDevice?.let { if (it.type == SCO_TYPE) finish(true, it, "確立（即時）") }
    }

    // 解放。⚠️ 立てっぱなしだと端末全体の音の出方が変わるので、必ず通す。
    AsyncFunction("releaseSco") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val am = audioManager
        runCatching { am.clearCommunicationDevice() }
          .onFailure { Log.w(TAG, "clearCommunicationDevice が例外", it) }
        am.mode = AudioManager.MODE_NORMAL
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun result(ok: Boolean, device: AudioDeviceInfo?, ms: Int, note: String) = mapOf(
    "ok" to ok,
    "device" to device?.let { describe(it) },
    "elapsedMs" to ms,
    "note" to note,
  )

  private fun elapsed(from: Long) = (System.currentTimeMillis() - from).toInt()

  private fun describe(device: AudioDeviceInfo) = mapOf(
    "id" to device.id,
    "type" to typeName(device.type),
    "name" to device.productName.toString(),
    "isSco" to (device.type == SCO_TYPE),
  )

  private fun typeName(type: Int) = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_sco"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_a2dp"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "ble_headset"
    else -> "type_$type"
  }

  private fun modeName(mode: Int) = when (mode) {
    AudioManager.MODE_NORMAL -> "normal"
    AudioManager.MODE_IN_COMMUNICATION -> "in_communication"
    AudioManager.MODE_IN_CALL -> "in_call"
    AudioManager.MODE_RINGTONE -> "ringtone"
    else -> "mode_$mode"
  }

  private companion object {
    const val TAG = "btroute"
    const val SCO_TYPE = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
  }
}
