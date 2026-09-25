package com.touringproject.btaudioroute

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
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
//
// ## ⚠️ インカムのボタンで起動したときは「音声認識」として張る（startVoiceRecognition）
//
// ボタンを押すとインカムは AT+BVRA=1（音声認識を始めて）を送り、スマホの返事を約5秒待つ。
// その間に acquireSco（仮想通話）で張ろうとすると、インカムは codec 交渉に応じず失敗する。
// さらに仮想通話の最中はインカムのボタンが「電話を切る」になり、2回目の押下が
// アプリに届かない（pre-research/mic-routing/FINDINGS.md §9・§10）。
//
// そこで BluetoothHeadset.startVoiceRecognition() でボタンの要求に正式に返事をし、
// Bluetooth スタック自身に SCO を張らせる。⚠️ このとき setCommunicationDevice() は呼ばない:
// AudioService は「外部で張られた SCO」を要求元アプリのために覚え、外部が切ったあと
// 仮想通話で張り直してしまう（BtHelper.requestScoState の SCO_STATE_ACTIVE_EXTERNAL）。
// 外部の SCO が張られていれば、通話系の経路は何もしなくても SCO に向く
// （AudioDeviceBroker.preferredCommunicationDevice）。
//
// 2回目の押下は AT+BVRA=0 として届き、スタックが SCO を切るだけでアプリへの Intent は無い。
// そのため「SCO が切れた」を観測して onVoiceRecognitionEnded として JS に知らせる。
@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT は JS 側（micRoute.ts）で実行時に求める
class BtAudioRouteModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "reactContext がない" }

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  // acquire の多重実行を防ぐ。経路は端末で1つしかないので、重なると
  // 「どちらのリスナーが誰の完了を見ているか」が混ざる。
  private val acquiring = AtomicBoolean(false)

  // ---- 音声認識の経路（すべてメインスレッドで触る） ----
  private val main = Handler(Looper.getMainLooper())
  private var headset: BluetoothHeadset? = null
  private var proxyRequested = false
  private val proxyWaiters = mutableListOf<(BluetoothHeadset?) -> Unit>()
  private var receiver: BroadcastReceiver? = null

  // 音声認識のセッション。null なら張っていない。
  private var vrDevice: BluetoothDevice? = null
  private var vrStartedAt = 0L
  private var vrConnectedAt = 0L
  // ⚠️ 自分で止めている最中か。これが立っている間の切断は「2回目の押下」ではない。
  private var vrReleasing = false
  // 開始待ち（SCO の確立待ち）の完了関数。
  private var vrPending: ((Boolean, String) -> Unit)? = null
  private var lastAudioState = -1

  // ---- 記録ファイル（⚠️ 走行中は logcat が流れるので、端末内にも残す） ----
  private val traceExecutor = Executors.newSingleThreadExecutor()
  private val traceTime = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

  override fun definition() = ModuleDefinition {
    Name("BtAudioRoute")

    Events("onVoiceRecognitionEnded", "onHeadsetEvent")

    OnCreate {
      trace("native", "module created: sdk=${Build.VERSION.SDK_INT} ${snapshot()}")
    }

    OnDestroy {
      receiver?.let { runCatching { context.unregisterReceiver(it) } }
      receiver = null
      headset?.let { h ->
        runCatching {
          context.getSystemService(BluetoothManager::class.java)
            ?.adapter?.closeProfileProxy(BluetoothProfile.HEADSET, h)
        }
      }
      headset = null
      traceExecutor.shutdown()
    }

    // JS 側のログも同じ記録ファイルに書く（時系列を1本にするため）。
    Function("appendTrace") { line: String ->
      trace("js", line)
    }

    // 記録ファイルの場所（adb pull 用）。
    Function("tracePath") {
      traceFile()?.absolutePath
    }

    // 音声認識として SCO を張る。⚠️ ボタンの押下から約5秒以内に呼ぶこと
    // （それを過ぎるとスマホが返事の待ちを打ち切る。HeadsetService.sStartVrTimeoutMs）。
    AsyncFunction("startVoiceRecognition") { timeoutMs: Int, promise: Promise ->
      startVoiceRecognition(timeoutMs, promise)
    }.runOnQueue(Queues.MAIN)

    // 音声認識を止めて SCO を切る。⚠️ 録音を終えたら必ず呼ぶ。
    AsyncFunction("stopVoiceRecognition") { reason: String ->
      stopVoiceRecognition(reason)
    }.runOnQueue(Queues.MAIN)

    // いま録音がどのマイクで行われているか（⚠️ 「インカムのつもりが本体マイク」を見抜くため）。
    AsyncFunction("describeRecording") {
      describeRecording()
    }.runOnQueue(Queues.MAIN)

    // 経路まわりの状態を1行で（診断用）。
    AsyncFunction("snapshot") {
      snapshot()
    }.runOnQueue(Queues.MAIN)

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
      trace("sco", "releaseSco: ${snapshot()}")
    }.runOnQueue(Queues.MAIN)
  }

  // ================= 音声認識の経路 =================

  private fun startVoiceRecognition(timeoutMs: Int, promise: Promise) {
    val startedAt = System.currentTimeMillis()
    trace("vr", "start requested: timeout=${timeoutMs}ms ${snapshot()}")

    fun resolve(ok: Boolean, note: String) {
      val ms = elapsed(startedAt)
      trace("vr", "start result: ok=$ok elapsed=${ms}ms note=$note ${snapshot()}")
      promise.resolve(
        mapOf("ok" to ok, "elapsedMs" to ms, "note" to note, "device" to vrDevice?.let { name(it) }),
      )
    }

    if (vrPending != null) {
      resolve(false, "すでに開始処理中")
      return
    }
    ensureReceiver()

    withHeadset(PROXY_TIMEOUT_MS) { h ->
      if (h == null) {
        resolve(false, "BluetoothHeadset のプロキシが得られない")
        return@withHeadset
      }
      val devices = runCatching { h.connectedDevices }.getOrElse {
        resolve(false, "connectedDevices が例外: ${it.javaClass.simpleName}: ${it.message}")
        return@withHeadset
      }
      trace("vr", "connected headsets: ${devices.joinToString { name(it) }}")
      val device = devices.firstOrNull()
      if (device == null) {
        resolve(false, "HFP で接続中の機器が無い")
        return@withHeadset
      }

      // 前のセッションが残っていたら先に止める（残っていると startVoiceRecognition が断られる）。
      if (vrDevice != null) {
        trace("vr", "previous session still active -> stop first")
        runCatching { h.stopVoiceRecognition(vrDevice) }
        vrDevice = null
      }

      vrDevice = device
      vrStartedAt = startedAt
      vrConnectedAt = 0L
      vrReleasing = false

      val onTimeout = Runnable { vrPending?.invoke(false, "SCO確立待ちがタイムアウト") }
      // ⚠️ SCO の確立をブロードキャストとポーリングの両方で待つ（片方が来なくても進めるように）。
      val poll = object : Runnable {
        override fun run() {
          if (vrPending == null) return
          if (runCatching { h.isAudioConnected(device) }.getOrDefault(false)) {
            vrPending?.invoke(true, "確立（ポーリングで検知）")
          } else {
            main.postDelayed(this, POLL_MS)
          }
        }
      }
      vrPending = { ok, note ->
        vrPending = null
        main.removeCallbacks(onTimeout)
        main.removeCallbacks(poll)
        if (ok) {
          vrConnectedAt = System.currentTimeMillis()
          // ⚠️ setCommunicationDevice() は呼ばない（上のクラスコメント参照）。モードだけ立てる。
          val before = modeName(audioManager.mode)
          audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
          trace("vr", "mode $before -> ${modeName(audioManager.mode)}")
          startSessionMonitor(h, device)
        } else {
          // 張れなかったら音声認識も止める（インカムを待たせたままにしない）。
          val stopped = runCatching { h.stopVoiceRecognition(device) }
          trace("vr", "cleanup after failure: stopVoiceRecognition=${stopped.getOrNull()} ${stopped.exceptionOrNull() ?: ""}")
          vrDevice = null
        }
        resolve(ok, note)
      }
      main.postDelayed(onTimeout, timeoutMs.toLong())

      val accepted = runCatching { h.startVoiceRecognition(device) }
      trace("vr", "startVoiceRecognition(${name(device)}) -> ${accepted.getOrNull()} ${accepted.exceptionOrNull() ?: ""}")
      if (accepted.getOrDefault(false) != true) {
        vrPending?.invoke(false, "startVoiceRecognition が ${accepted.exceptionOrNull()?.javaClass?.simpleName ?: "false"} を返した")
        return@withHeadset
      }
      // すでに張れていてイベントが来ない場合に備え、すぐ1回目を見る。
      main.post(poll)
    }
  }

  // セッション中、SCO が切れたかを見張る（⚠️ ブロードキャストの取りこぼしに備えたポーリング）。
  private fun startSessionMonitor(h: BluetoothHeadset, device: BluetoothDevice) {
    val monitor = object : Runnable {
      override fun run() {
        if (vrDevice != device) return
        val connected = runCatching { h.isAudioConnected(device) }.getOrDefault(false)
        if (!connected) {
          onScoLost("ポーリングで検知")
        } else {
          main.postDelayed(this, POLL_MS)
        }
      }
    }
    main.postDelayed(monitor, POLL_MS)
  }

  // セッション中に SCO が切れた。自分で止めたのでなければ、インカム側の操作（2回目の押下）とみなす。
  private fun onScoLost(source: String) {
    val device = vrDevice ?: return
    if (vrReleasing) {
      trace("vr", "sco lost during own release ($source) -> ignore")
      return
    }
    val sessionMs = System.currentTimeMillis() - vrStartedAt
    val connectedMs = if (vrConnectedAt > 0) System.currentTimeMillis() - vrConnectedAt else -1
    trace("vr", "sco lost by remote ($source): session=${sessionMs}ms connected=${connectedMs}ms ${snapshot()}")
    vrDevice = null
    runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
    sendEvent(
      "onVoiceRecognitionEnded",
      mapOf(
        "reason" to "sco-lost",
        "source" to source,
        "sessionMs" to sessionMs,
        "connectedMs" to connectedMs,
        "device" to name(device),
      ),
    )
  }

  private fun stopVoiceRecognition(reason: String) {
    trace("vr", "stop requested: reason=$reason ${snapshot()}")
    vrPending?.invoke(false, "停止が要求された（$reason）")
    val device = vrDevice
    val h = headset
    if (device != null && h != null) {
      vrReleasing = true
      val r = runCatching { h.stopVoiceRecognition(device) }
      trace("vr", "stopVoiceRecognition(${name(device)}) -> ${r.getOrNull()} ${r.exceptionOrNull() ?: ""}")
      // 切断の通知が遅れて来ても「2回目の押下」と取り違えないよう、しばらく印を残す。
      main.postDelayed({ vrReleasing = false }, RELEASE_GRACE_MS)
    }
    vrDevice = null
    if (audioManager.mode != AudioManager.MODE_NORMAL) {
      audioManager.mode = AudioManager.MODE_NORMAL
    }
    trace("vr", "stopped: ${snapshot()}")
  }

  private fun withHeadset(timeoutMs: Long, block: (BluetoothHeadset?) -> Unit) {
    headset?.let { block(it); return }
    var done = false
    val once: (BluetoothHeadset?) -> Unit = { h -> if (!done) { done = true; block(h) } }
    proxyWaiters.add(once)
    main.postDelayed({ if (!done) { trace("vr", "headset proxy timeout"); proxyWaiters.remove(once); once(null) } }, timeoutMs)
    if (proxyRequested) return
    proxyRequested = true
    val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    val requested = adapter?.getProfileProxy(
      context,
      object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
          main.post {
            headset = proxy as BluetoothHeadset
            trace("vr", "headset proxy connected")
            val waiters = proxyWaiters.toList()
            proxyWaiters.clear()
            waiters.forEach { it(headset) }
          }
        }

        override fun onServiceDisconnected(profile: Int) {
          main.post {
            trace("vr", "headset proxy disconnected")
            headset = null
            proxyRequested = false
          }
        }
      },
      BluetoothProfile.HEADSET,
    ) ?: false
    trace("vr", "getProfileProxy(HEADSET) -> $requested (adapter=${adapter != null})")
    if (!requested) proxyRequested = false
  }

  // HFP の状態変化を受ける（⚠️ 経路の問題を後から追えるよう、セッション外でもすべて記録する）。
  private fun ensureReceiver() {
    if (receiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        val state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)
        val prev = intent.getIntExtra(BluetoothProfile.EXTRA_PREVIOUS_STATE, -1)
        val device = deviceOf(intent)
        val kind = when (intent.action) {
          BluetoothHeadset.ACTION_AUDIO_STATE_CHANGED -> "audio"
          BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED -> "connection"
          else -> intent.action ?: "?"
        }
        val text = if (kind == "audio") audioStateName(state) else connStateName(state)
        val prevText = if (kind == "audio") audioStateName(prev) else connStateName(prev)
        trace("hfp", "$kind: $prevText -> $text device=${device?.let { name(it) }} session=${vrDevice != null} releasing=$vrReleasing")
        sendEvent(
          "onHeadsetEvent",
          mapOf("kind" to kind, "state" to text, "previous" to prevText, "session" to (vrDevice != null)),
        )
        if (kind != "audio") return
        lastAudioState = state
        if (state == BluetoothHeadset.STATE_AUDIO_CONNECTED) {
          vrPending?.invoke(true, "確立（ブロードキャストで検知）")
        } else if (state == BluetoothHeadset.STATE_AUDIO_DISCONNECTED && vrPending == null) {
          onScoLost("ブロードキャストで検知")
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction(BluetoothHeadset.ACTION_AUDIO_STATE_CHANGED)
      addAction(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // ⚠️ EXPORTED にする。HFP の通知の送り主は system ではなく Bluetooth アプリ
      // （別の uid）なので、NOT_EXPORTED だと「他アプリから」として一度も届かなかった
      // （v1.38.0 の実機記録。ポーリングだけで検知していた）。
      // 偽装の心配は無い: どちらの通知も保護されたブロードキャストで、一般アプリは送れない。
      context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
    } else {
      context.registerReceiver(r, filter)
    }
    receiver = r
    trace("vr", "receiver registered")
  }

  private fun describeRecording(): Map<String, Any?> {
    val configs = audioManager.activeRecordingConfigurations
    val list = configs.map { c ->
      mapOf(
        "source" to c.clientAudioSource,
        "device" to c.audioDevice?.let { typeName(it.type) },
        "deviceName" to c.audioDevice?.productName?.toString(),
        "silenced" to (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) c.isClientSilenced else null),
      )
    }
    trace("rec", "active recordings: $list ${snapshot()}")
    return mapOf("recordings" to list, "snapshot" to snapshot())
  }

  // 経路まわりの状態を1行にまとめる。⚠️ 何かがおかしいときに「その瞬間の全体」を残すため。
  private fun snapshot(): String {
    val am = runCatching { audioManager }.getOrNull() ?: return "[no audio manager]"
    val comm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      am.communicationDevice?.let { typeName(it.type) } ?: "null"
    } else {
      "n/a"
    }
    val h = headset
    val d = vrDevice
    val audio = if (h != null && d != null) runCatching { h.isAudioConnected(d) }.getOrNull() else null
    return "[mode=${modeName(am.mode)} comm=$comm scoOn=${am.isBluetoothScoOn} " +
      "session=${d != null} audioConnected=$audio releasing=$vrReleasing " +
      "pending=${vrPending != null} proxy=${h != null} lastAudio=${audioStateName(lastAudioState)}]"
  }

  private fun deviceOf(intent: Intent): BluetoothDevice? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
    }

  // ⚠️ MAC アドレスは記録しない（名前だけ）。
  private fun name(device: BluetoothDevice): String =
    runCatching { device.name }.getOrNull() ?: "?"

  private fun audioStateName(s: Int) = when (s) {
    BluetoothHeadset.STATE_AUDIO_CONNECTED -> "AUDIO_CONNECTED"
    BluetoothHeadset.STATE_AUDIO_CONNECTING -> "AUDIO_CONNECTING"
    BluetoothHeadset.STATE_AUDIO_DISCONNECTED -> "AUDIO_DISCONNECTED"
    -1 -> "unknown"
    else -> "audio_$s"
  }

  private fun connStateName(s: Int) = when (s) {
    BluetoothProfile.STATE_CONNECTED -> "CONNECTED"
    BluetoothProfile.STATE_CONNECTING -> "CONNECTING"
    BluetoothProfile.STATE_DISCONNECTED -> "DISCONNECTED"
    BluetoothProfile.STATE_DISCONNECTING -> "DISCONNECTING"
    else -> "conn_$s"
  }

  // ================= 記録ファイル =================

  private fun traceFile(): File? =
    runCatching { context.getExternalFilesDir(null) }.getOrNull()?.let { File(it, TRACE_FILE) }

  private fun trace(tag: String, msg: String) {
    Log.i(TAG, "[$tag] $msg")
    val line = "${traceTime.format(Date())} [$tag] $msg\n"
    val file = traceFile() ?: return
    runCatching {
      traceExecutor.execute {
        runCatching {
          if (file.length() > TRACE_MAX_BYTES) {
            file.renameTo(File(file.parentFile, "$TRACE_FILE.1"))
          }
          file.appendText(line)
        }
      }
    }
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
    const val PROXY_TIMEOUT_MS = 1_500L
    const val POLL_MS = 200L
    const val RELEASE_GRACE_MS = 3_000L
    const val TRACE_FILE = "btroute-trace.log"
    const val TRACE_MAX_BYTES = 2L * 1024 * 1024
  }
}
