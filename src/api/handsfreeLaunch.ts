/**
 * ⚠️ **インカムのボタン押下（`autoRecord=<押した時刻>`）を「1回の押下＝1回の処理」にする。**
 *
 * **なぜ要るか**: `useURL()`（expo-linking）は、`url` イベントで新しいURLを受けたあとに
 * **`getInitialURL()` の結果＝アプリを最初に起動したときの古いURLを遅れて返す**ことがある。
 * ⚠️ **URL文字列の比較だけだと、それを「新しい押下」と取り違えて二重に処理する**
 * （実機で発生: 1回の押下で `startRecording` が並走し、互いのSCOを潰し合った。
 * [pre-research/mic-routing/](../../../pre-research/mic-routing/)）。
 *
 * 📌 **判定は押した時刻で行う**（ネイティブ側が押すたびに `System.currentTimeMillis()` を入れる。
 * `App/plugins/withVoiceInteraction.js`）。
 *
 * ⚠️ **状態はモジュールに置く**（`useRef` ではない）。**画面が作り直されても消えない**ように。
 */

/**
 * これより古い押下は捨てる。
 *
 * ⚠️ **JSが読み直されてモジュールの状態が消えた場合**の保険（そのとき古いURLを
 * 「最後に処理した押下」と比べられない）。📌 **起動直後は位置情報とAPIキーが揃うまで
 * 処理を待つ**ので、その待ちで捨てない程度に長くしてある。
 */
export const STALE_PRESS_MS = 60_000;

/** 最後に処理した押下の時刻。 */
let lastHandledPressAt = 0;

/** `autoRecord` の値から押した時刻を取り出す。数値でなければ null。 */
export function parsePressedAt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * この押下を処理してよいか。**`"new"` のときだけ処理する**（その時点で処理済みとして記録する）。
 *
 * - `"duplicate"`: 処理済みの押下と同じか、それより前（⚠️ **古いURLの再送はここ**）
 * - `"stale"`: 古すぎる（上の `STALE_PRESS_MS`）
 */
export function claimPress(
  pressedAt: number,
  now: number = Date.now(),
): "new" | "duplicate" | "stale" {
  if (pressedAt <= lastHandledPressAt) return "duplicate";
  if (now - pressedAt > STALE_PRESS_MS) return "stale";
  lastHandledPressAt = pressedAt;
  return "new";
}
