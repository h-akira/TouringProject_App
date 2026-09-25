/**
 * 録音の設定の保管と読み出し（US-2.01 / US-2.04）。
 *
 * ⚠️ **秘密ではないので `expo-secure-store` には置かない**（あちらはAPIキー用）。
 * 設定値の保管は AsyncStorage が定石。
 *
 * 既定値の出どころは3段階で、**後のものが優先される**:
 *   1. コード上の既定値（`DEFAULT_RECORDING_SETTINGS`）
 *   2. `.env` の `EXPO_PUBLIC_*`（ビルド時に固定）
 *   3. 端末に保存された値（設定画面で入れたもの）← **最優先**
 *
 * 📌 **かつては無音検知（VAD）の閾値もここにあったが、廃止した。**
 * **走行中はエンジン音で音量が飽和して成立しない**ため
 * （[adr/008](../../../adr/008_end_of_speech_detection.md)）。
 * いまの終話はインカムのボタン再押しと、下記の上限で決まる。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RecordingSource } from "expo-audio";

/**
 * 保存先のキー名。
 *
 * ⚠️ **旧`touring.vadSettings` から変えている。** 旧キーには廃止した無音検知の
 * 値が入っており、**読み直しても使い道が無い**（`normalize` が捨てるだけ）。
 * 📌 **新しいキーにすることで、全員が既定値から始まる。**
 */
const STORE_KEY = "touring.recordingSettings";

export type RecordingSettings = {
  /**
   * 録音の上限（ミリ秒）。ここに達したら録れているぶんで送る。
   *
   * ⚠️ **押し忘れの出口であり、「押さずに待つ」ときの待ち時間でもある。**
   * インカムのボタンを2回目に押せば即座に送れるが、**押すのが面倒なときは
   * これを待つ**ことになる（adr/008）。
   */
  maxRecordingMs: number;

  /**
   * 録音の用途（Androidの `MediaRecorder.AudioSource`）。
   *
   * ⚠️ **端末側の音の加工（ノイズ除去）が変わる。**
   * 📌 実測で `voice_communication` が4種中もっともノイズを除けた
   * （`pre-research/handsfree/FINDINGS.md` §15）。
   */
  audioSource: RecordingSource;
};

/**
 * 選べる録音の用途と、その説明。**設定画面の選択肢もこれを使う**
 * （並びと文言を1箇所に持つ）。
 *
 * ⚠️ **`RecordingSource` の全部は並べない。** `camcorder`（カメラ向き）
 * `remote_submix`（端末の再生音を録る）`voice_performance`（低遅延の実演向け）は
 * **この用途に無関係**なので、迷わせないために出さない。
 */
export const AUDIO_SOURCE_CHOICES: readonly {
  value: RecordingSource;
  label: string;
  hint: string;
}[] = [
  {
    value: "voice_communication",
    label: "voice_communication（既定）",
    hint: "通話向け。ノイズ抑制とエコー除去。📌 実測でいちばんノイズが減った",
  },
  {
    value: "voice_recognition",
    label: "voice_recognition",
    hint: "音声認識向け。AGC（自動ゲイン調整）が切られる",
  },
  {
    value: "mic",
    label: "mic",
    hint: "汎用のマイク。加工が少ない",
  },
  {
    value: "unprocessed",
    label: "unprocessed",
    hint: "一切加工しない生の音",
  },
];

/** 保存された値が選択肢のどれかであること。⚠️ 未知の値は既定に落とす。 */
function isAudioSource(value: unknown): value is RecordingSource {
  return AUDIO_SOURCE_CHOICES.some((choice) => choice.value === value);
}

/** 数値の環境変数を読む。未設定・数値でない場合は既定値。 */
function envNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

/** 保存された値が無いときに使う既定値。 */
export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  /**
   * ⚠️ **20秒。** 長いとその分ただ待たされるので、30秒から詰めた。
   * 📌 **画面に残り秒数を大きく出している**ので、待つ判断はその場でできる。
   */
  maxRecordingMs: envNumber(process.env.EXPO_PUBLIC_MAX_RECORDING_MS, 20_000),
  /**
   * ⚠️ **既定は `voice_communication`。** 4種の実測でノイズ除去が最も効いた
   * （FINDINGS.md §15）。
   */
  audioSource: isAudioSource(process.env.EXPO_PUBLIC_AUDIO_SOURCE)
    ? process.env.EXPO_PUBLIC_AUDIO_SOURCE
    : "voice_communication",
};

/**
 * 入力できる範囲。⚠️ **走行中に自分を締め出さないための歯止め。**
 *
 * 極端な値を入れると「録音が永久に止まらない」といった、
 * **画面を見ずには復帰できない状態**を自分で作れてしまう。
 */
export const RECORDING_LIMITS = {
  /**
   * ⚠️ **上限は「送れる大きさ」で決まっている。**
   * サーバーは 2MB を超える音声を 413 で弾く（Backend の `MAX_AUDIO_BYTES`）。
   * 64kbps・モノラルなら 2MB ≒ 262秒なので、**余裕を見て 180秒まで**にする
   * （AACのビットレートは厳密には一定でないため、上限ぎりぎりを許さない）。
   * ⚠️ **ここを緩めるならサーバー側の上限も一緒に見直すこと。**
   *
   * ⚠️ **下限5秒。** これより短いと、話し始める前に送信されてしまう。
   */
  maxRecordingMs: { min: 5_000, max: 180_000 },
} as const;

/** 値を範囲内に収める。範囲外の入力を弾くのではなく寄せる。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 読み込んだ値を検証して整える。
 *
 * ⚠️ **保存された値を信用しない。** 手で書き換えられる場所ではないが、
 * 古い版の形が残っていることはある（キーの欠落・数値でない値）。
 * 壊れた値で起動して「録音が止まらない」より、既定値に戻る方が安全。
 */
export function normalizeRecordingSettings(raw: unknown): RecordingSettings {
  const source = (raw ?? {}) as Partial<Record<keyof RecordingSettings, unknown>>;
  const max = Number(source.maxRecordingMs);
  return {
    maxRecordingMs: Number.isFinite(max)
      ? clamp(
          max,
          RECORDING_LIMITS.maxRecordingMs.min,
          RECORDING_LIMITS.maxRecordingMs.max,
        )
      : DEFAULT_RECORDING_SETTINGS.maxRecordingMs,
    // ⚠️ 数値ではないので同じ扱いにできない（選択肢のどれかであることだけ見る）。
    audioSource: isAudioSource(source.audioSource)
      ? source.audioSource
      : DEFAULT_RECORDING_SETTINGS.audioSource,
  };
}

/** 保存された設定。未保存・読み出し失敗なら既定値。 */
export async function loadRecordingSettings(): Promise<RecordingSettings> {
  try {
    const stored = await AsyncStorage.getItem(STORE_KEY);
    if (stored === null) return DEFAULT_RECORDING_SETTINGS;
    return normalizeRecordingSettings(JSON.parse(stored));
  } catch {
    // 壊れたJSONや読み出し失敗。⚠️ **ここで落とさない**
    // （設定が壊れただけで、走行中にアプリが使えなくなる方が困る）。
    return DEFAULT_RECORDING_SETTINGS;
  }
}

/** 設定を端末に保存する。範囲外の値は寄せてから保存する。 */
export async function saveRecordingSettings(
  settings: RecordingSettings,
): Promise<RecordingSettings> {
  const normalized = normalizeRecordingSettings(settings);
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 保存された設定を消して既定値に戻す。 */
export async function clearRecordingSettings(): Promise<void> {
  await AsyncStorage.removeItem(STORE_KEY);
}
