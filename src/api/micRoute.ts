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
import BtAudioRoute from "@/native/bt-audio-route";

/**
 * ⚠️ **SCO の確立を待つ上限。**
 *
 * **実測では 270ms で張れた**（Pixel 8a）。⚠️ **走行中はボタンを押してから
 * 録音が始まるまでの遅延になる**ので、**待ちすぎない。**
 * 📌 **A2DP で音楽を鳴らしている最中は伸びうる**ため、実測値より余裕を持たせてある。
 */
const ACQUIRE_TIMEOUT_MS = 2_000;

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
export async function acquireMicRoute(): Promise<MicRoute> {
  try {
    // ⚠️ **`BLUETOOTH_CONNECT` が要る**（Android 12+）。
    // **宣言だけでは足りず、実行時に求めないと `setCommunicationDevice()` は効かない。**
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

    // ⚠️ **インカムが無いのは「異常」ではない。** 室内で使うときは
    // **本体マイクで録るのが正しい**ので、黙って通す。
    if (!devices.hasScoOutput) {
      return { kind: "builtin", reason: "no-intercom" };
    }

    const result = await BtAudioRoute.acquireSco(ACQUIRE_TIMEOUT_MS);
    if (result.ok) {
      return { kind: "intercom", elapsedMs: result.elapsedMs };
    }

    // ⚠️ **ここが異常。** **インカムはあるのに経路が張れていない。**
    // 📌 **録音は続けるが、後から分かるように必ず残す。**
    console.warn("[mic] インカムはあるがSCOを張れなかった:", result.note);
    return { kind: "builtin", reason: "acquire-failed", note: result.note };
  } catch (e) {
    // ⚠️ **ここで落とさない。** 経路の確保に失敗しても、
    // **本体マイクで録れるなら録った方がよい。**
    const note = e instanceof Error ? e.message : String(e);
    console.warn("[mic] 経路の確保で例外:", note);
    return { kind: "builtin", reason: "acquire-failed", note };
  }
}

/**
 * 録音を終えたら必ず呼ぶ。
 *
 * ⚠️ **立てっぱなしにすると端末全体の音の出方が変わる**
 * （`MODE_IN_COMMUNICATION` のまま残り、**読み上げが通話用の経路に流れる**）。
 */
export async function releaseMicRoute(): Promise<void> {
  try {
    await BtAudioRoute.releaseSco();
  } catch (e) {
    // ⚠️ **握り潰さない。** 解放漏れは次の録音・読み上げに影響する。
    console.warn("[mic] 経路の解放に失敗:", e);
  }
}

/** ログ用の短い表現。⚠️ **どのマイクで録ったかを1行で残すため。** */
export function describeMicRoute(route: MicRoute): string {
  if (route.kind === "intercom") return `インカム(${route.elapsedMs}ms)`;
  return route.reason === "no-intercom"
    ? "本体マイク(インカム未接続)"
    : `⚠️ 本体マイク(SCO失敗: ${route.note})`;
}
