/**
 * 録音の開始の合図の長さ（設定画面で選ぶ）。
 *
 * ⚠️ **インカムは出だしを落とす。** 約0.16秒の音は聞こえず、1秒鳴らすと
 * 実際より短い音として聞こえた（Pixel 8a と手元のインカムで確認）。
 * 聞こえ方はインカムで変わるので、決め打ちにせず選べるようにしている。
 * ⚠️ **合図は録音にも入る**ので、長すぎると質問の頭に音が重なる。
 *
 * 純粋な関数だけを置く（`npm test` で確かめられるように、AsyncStorage に触れない）。
 */

/** 選べる長さ。**設定画面の選択肢もこれを使う**（並びと文言を1箇所に持つ）。 */
export const START_CUE_CHOICES: readonly { value: number; label: string }[] = [
  { value: 0, label: "なし" },
  { value: 500, label: "0.5秒" },
  { value: 1_000, label: "1秒" },
  { value: 1_500, label: "1.5秒（既定）" },
  { value: 2_000, label: "2秒" },
  { value: 3_000, label: "3秒" },
];

export const DEFAULT_START_CUE_MS = 1_500;

/**
 * 保存された値を選択肢のどれかに揃える。
 *
 * ⚠️ **未知の値は既定に落とす**（古い版の値や壊れた値で、合図が極端に長く鳴らないように）。
 */
export function normalizeStartCueMs(raw: unknown): number {
  // ⚠️ Number() で変換しない。null や "" が 0（なし）になり、壊れた値で合図が消える。
  if (typeof raw !== "number") return DEFAULT_START_CUE_MS;
  return START_CUE_CHOICES.some((choice) => choice.value === raw)
    ? raw
    : DEFAULT_START_CUE_MS;
}
