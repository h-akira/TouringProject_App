/**
 * ⚠️ **録音を「インカムのマイク」で行うための経路の確保。**
 *
 * **なぜ要るか**: ⚠️ **これが無いと Pixel 本体マイクで録ってしまう。**
 * **ヘルメットの外にあるスマホが風とエンジン音を正面から拾う**ことになり、
 * ⚠️ **インカムのノイズ除去（CVC）が一度も経路に入らない**
 * （[adr/010](../../../adr/010_intercom_mic_routing.md)）。
 *
 * ⚠️ **`expo-audio` の `setInput()` は使えない**（仕様違反で黙って失敗する）ので、
 * 📌 **経路だけを自前モジュール `bt-audio-route` で張る。**
 *
 * ⚠️ **張り方は「音声認識」**（`startVoiceRecognition`）。仮想通話（`acquireSco`）で張ると、
 * ①インカムのボタンで起動した直後は張れず ②録音中のボタンが「電話を切る」になって
 * 2回目の押下がアプリに届かない（`pre-research/mic-routing/FINDINGS.md` §9・§10）。
 * 📌 **その代わり、2回目の押下は `watchIntercomEnded()` の通知として届く。**
 *
 * ## ⚠️ 「張れない」には2種類ある（混ぜない）
 *
 * | 状況 | 扱い |
 * |---|---|
 * | **インカムを繋いでいない**（室内で使う等） | ✅ **正常。** **本体マイクで録り、何も言わない** |
 * | ⚠️ **繋いでいるのに張れない** | ⚠️ **異常。** **本体マイクで録るが、記録に残す** |
 *
 * ⚠️ **走行中に黙るのが最も困る**ので、**どちらの場合も録音は続ける。**
 * 📌 **ただし「どちらのマイクで録ったか」は必ず残す** —
 * ⚠️ **それが無かったために、走行1回分の録音を「インカムで録れている」と誤認した。**
 */
import { PermissionsAndroid, Platform } from "react-native";
import BtAudioRoute, {
  type VoiceRecognitionEndedEvent,
} from "@/native/bt-audio-route";
import { trace } from "@/api/trace";

/**
 * ⚠️ **SCO の確立を待つ上限。**
 *
 * **音声認識では 217〜274ms で張れた**（Pixel 8a・インカムの電源を入れた直後も含む）。
 * ⚠️ **走行中はボタンを押してから録音が始まるまでの遅延になる**ので、待ちすぎない
 * （張れなければ本体マイクで録って続行する）。
 */
const ACQUIRE_TIMEOUT_MS = 2_000;

/**
 * ⚠️ **ボタンの押下から `startVoiceRecognition` を呼ぶまでの期限。**
 *
 * インカムは押下のあと返事を待ち、**スマホは約5秒で待ちを打ち切る**
 * （AOSP `HeadsetService.sStartVrTimeoutMs`）。過ぎてから呼ぶと「スマホ側から始める音声認識」に
 * なり、成り立つかは未確認。**超えたかどうかを記録に残す**（アプリが起動していない状態からの押下で
 * 位置情報の初回取得を待つと超えうる）。
 */
const VR_ANSWER_DEADLINE_MS = 5_000;

/** どのマイクで録ることになったか。⚠️ **送信結果と一緒に残す。** */
export type MicRoute =
  /** ✅ インカム（SCO）。**狙いどおり。** */
  | { kind: "intercom"; elapsedMs: number }
  /** ✅ 本体マイク。**インカムを繋いでいないので、これが正常。** */
  | { kind: "builtin"; reason: "no-intercom" }
  /** ⚠️ **本体マイク。だがインカムはある** — **異常。** */
  | { kind: "builtin"; reason: "acquire-failed"; note: string };

/**
 * 録音を始める前に呼ぶ。⚠️ **必ず `releaseMicRoute()` と対で使う。**
 *
 * ⚠️ **例外を投げない。** **走行中に録音が始まらないことの方が致命的**なので、
 * **失敗しても「本体マイクで録る」という結果を返して続行させる。**
 */
export async function acquireMicRoute(pressedAt: number | null): Promise<MicRoute> {
  try {
    // ⚠️ **`BLUETOOTH_CONNECT` が要る**（Android 12+）。
    // **宣言だけでは足りず、実行時に求めないと `BluetoothHeadset` を使えない。**
    // 📌 **拒否されても止めない** — **本体マイクで録れば会話は成立する。**
    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        return {
          kind: "builtin",
          reason: "acquire-failed",
          note: "BLUETOOTH_CONNECT が未付与",
        };
      }
    }

    const devices = await BtAudioRoute.getDevices();
    trace("[mic] devices:", devices);

    // ⚠️ **インカムが無いのは「異常」ではない。** 室内で使うときは
    // **本体マイクで録るのが正しい**ので、黙って通す。
    if (!devices.hasScoOutput) {
      return { kind: "builtin", reason: "no-intercom" };
    }

    if (pressedAt !== null) {
      const sincePress = Date.now() - pressedAt;
      trace(
        `[mic] press -> startVoiceRecognition: ${sincePress}ms` +
          (sincePress > VR_ANSWER_DEADLINE_MS ? " ⚠️ over the ~5s answer deadline" : ""),
      );
    }
    const result = await BtAudioRoute.startVoiceRecognition(ACQUIRE_TIMEOUT_MS);
    trace("[mic] startVoiceRecognition:", result);
    if (result.ok) {
      return { kind: "intercom", elapsedMs: result.elapsedMs };
    }

    // ⚠️ **ここが異常。** **インカムはあるのに経路が張れていない。**
    // 📌 **録音は続けるが、後から分かるように必ず残す。**
    trace("[mic] ⚠️ インカムはあるがSCOを張れなかった:", result.note);
    return { kind: "builtin", reason: "acquire-failed", note: result.note };
  } catch (e) {
    // ⚠️ **ここで落とさない。** 経路の確保に失敗しても、
    // **本体マイクで録れるなら録った方がよい。**
    const note = e instanceof Error ? e.message : String(e);
    trace("[mic] ⚠️ 経路の確保で例外:", note);
    return { kind: "builtin", reason: "acquire-failed", note };
  }
}

/**
 * ⚠️ **インカム側で経路が切れたら呼ばれる**（＝**2回目の押下**。自分で解放した場合は呼ばれない）。
 * 戻り値で購読を解除する。
 */
export function watchIntercomEnded(
  onEnded: (event: VoiceRecognitionEndedEvent) => void,
): () => void {
  const sub = BtAudioRoute.addListener("onVoiceRecognitionEnded", (event) => {
    trace("[mic] intercom ended:", event);
    onEnded(event);
  });
  return () => sub.remove();
}

/** いま録音がどのマイクで行われているかを記録に残す（⚠️ **経路の成否の最終確認**）。 */
export async function traceActiveRecording(label: string): Promise<void> {
  try {
    const info = await BtAudioRoute.describeRecording();
    trace(`[mic] recording (${label}):`, info.recordings, info.snapshot);
  } catch (e) {
    trace(`[mic] describeRecording failed (${label}):`, e);
  }
}

/**
 * 録音を終えたら必ず呼ぶ。
 *
 * ⚠️ **立てっぱなしにすると端末全体の音の出方が変わる**
 * （`MODE_IN_COMMUNICATION` のまま残り、**読み上げが通話用の経路に流れる**）。
 */
export async function releaseMicRoute(reason: string): Promise<void> {
  try {
    // ⚠️ **音声認識を先に止める。** 残すと次の `startVoiceRecognition` が断られる。
    await BtAudioRoute.stopVoiceRecognition(reason);
    await BtAudioRoute.releaseSco();
  } catch (e) {
    // ⚠️ **握り潰さない。** 解放漏れは次の録音・読み上げに影響する。
    trace("[mic] ⚠️ 経路の解放に失敗:", e);
  }
}

/** ログ用の短い表現。⚠️ **どのマイクで録ったかを1行で残すため。** */
export function describeMicRoute(route: MicRoute): string {
  if (route.kind === "intercom") return `インカム(${route.elapsedMs}ms)`;
  return route.reason === "no-intercom"
    ? "本体マイク(インカム未接続)"
    : `⚠️ 本体マイク(SCO失敗: ${route.note})`;
}
