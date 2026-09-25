/**
 * ⚠️ **走行中の不具合を後から追うための記録。**
 *
 * `console.log` に加えて、**ネイティブ側と同じ記録ファイル**に書く
 * （`bt-audio-route` の `appendTrace`。⚠️ **logcat は数分で流れる**ので走行後には残っていない）。
 * 📌 **ネイティブの経路の記録と時系列が1本になる**ので、どちらが先に起きたかが分かる。
 *
 * 取り出し方は `App/SETUP.md`「走行後に記録を取り出す」。
 */
import BtAudioRoute from "@/native/bt-audio-route";

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** `console.log` と同じ感覚で使う。⚠️ **失敗しても投げない**（記録のために本処理を止めない）。 */
export function trace(...args: unknown[]): void {
  console.log(...args);
  try {
    BtAudioRoute.appendTrace(args.map(stringify).join(" "));
  } catch {
    // 記録できなくても本処理は続ける。
  }
}
