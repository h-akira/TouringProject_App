/**
 * 声で質問するための録音設定と送信（US-2.01 / US-2.02、docs/01 §7）。
 *
 * ⚠️ **アプリは録音して送るだけ。** STT/TTS はバックエンドが呼ぶ。
 * 音声が Lambda を通るので「録音は何秒まで」を手前で強制できる
 * （アプリ側の上限は目安で、**本当の関門はサーバー側**。adr/002）。
 */
import { RecordingPresets, type RecordingOptions } from "expo-audio";
import { API_KEY_HEADER } from "@/api/apiKey";
import type { AskAcceptedResponse, Coordinates } from "@/api/types";
import type { RecordingSettings } from "@/api/recordingSettings";

/**
 * 録音の設定。**M4A（AAC）で録る。**
 *
 * ⚠️ **Transcribe の推奨は FLAC / WAV だが、Androidの録音APIはどちらも出せない**
 * （`AndroidOutputFormat` に該当する値が無い）。両者が重なるのが M4A で、
 * `HIGH_QUALITY` プリセットの既定でもあるため**変換が要らない**（docs/01 §7）。
 *
 * プリセットから変えているのは2点だけ:
 *   - **モノラル**: 音声認識にステレオは要らず、素直に半分のサイズになる
 *   - **16kHz**: 人の声はこれで足りる（Transcribe も 16kHz 以上を想定）。
 *     ⚠️ 走行中は電波が細いので、送るものは小さいほどよい
 *
 * ⚠️ **`audioSource` は設定から渡す**（`RecordingSettings.audioSource`）。
 * **端末側の音の加工（ノイズ除去）が変わる**ため、選べるようにしてある。
 * 📌 実測では `voice_communication` が最もノイズを除けた（FINDINGS.md §15）。
 * ⚠️ **置き場所は `android` の下**（Android専用の設定なので）。
 *
 * 📌 **`useAudioRecorder` は options を `JSON.stringify` して比較し、
 * 変われば録音オブジェクトを作り直す**（`ExpoAudio.js` の
 * `useReleasingSharedObject`）。**設定を変えたその場で新しい値が効く。**
 */
export function recordingOptions(settings: RecordingSettings): RecordingOptions {
  return {
    ...RecordingPresets.HIGH_QUALITY,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
    android: {
      // ⚠️ **プリセットの `android` を必ず展開する。** 丸ごと置き換えると
      // `outputFormat`（mpeg4）と `audioEncoder`（aac）が落ち、M4A で録れなくなる。
      ...RecordingPresets.HIGH_QUALITY.android,
      // ⚠️ **`audioSource` は `android` の下**（トップレベルではない）。
      audioSource: settings.audioSource,
    },
  };
}

/**
 * 録音するときの音声モード。読み上げの途中で録り始めると自分の声に回答が被る。
 *
 * ⚠️ **`setAudioModeAsync` はプロセス全体に効く。** 画面ごとに値を書くと
 * **後から呼んだ画面の設定が全体を上書きする**ので、
 * **録音向き・再生向きの2つに固定し、ここだけで持つ。**
 */
export const AUDIO_MODE_RECORDING = {
  allowsRecording: true,
  playsInSilentMode: true,
} as const;

/**
 * 録音していないときの音声モード。**録音を終えたら必ずこれに戻す。**
 *
 * ⚠️ **`shouldPlayInBackground: true` が要る（US-2.04）。** これが無いと
 * `expo-audio` は**アプリが背面に回った瞬間に再生を止める**
 * （`AudioModule.kt` の `OnActivityEntersBackground` が全プレイヤーを pause）。
 * 回答が届いた時点でマップアプリへ戻り、**背面で読み上げを続ける**のが要件なので、
 * ⚠️ **false に戻すと「マップに戻った瞬間に無音になる」形で壊れる。**
 *
 * ⚠️ **設定画面の音量測定もこれを使うこと。** あちらは背面再生と無関係だが、
 * プロセス全体に効くため、独自の値に戻すと**次のハンズフリー応答が背面で黙る。**
 */
export const AUDIO_MODE_PLAYBACK = {
  allowsRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  /**
   * ⚠️ **`mixWithOthers` にする（US-2.04）。**
   *
   * 応答後はマップアプリを前面に戻すが、**マップは案内の音声のために
   * オーディオフォーカスを取る。** 既定（フォーカスを要求する側）のままだと、
   * `expo-audio` はフォーカスを奪われた時点で
   * **プレイヤーを一時停止する**（`AudioModule.kt` の `AUDIOFOCUS_LOSS*`）ため、
   * ⚠️ **戻った瞬間に読み上げが止まりうる。**
   *
   * `mixWithOthers` は**フォーカスを要求しない**ので、奪われることもない。
   * 📌 **ナビの音声と重なって鳴るが、それが正しい**
   * （どちらも走行中に聞きたい情報で、片方を黙らせる理由がない）。
   */
  interruptionMode: "mixWithOthers",
} as const;

/**
 * ボタン再押しで録音を終えられるようになるまでの時間（adr/008）。
 *
 * ⚠️ **インカムのボタンのチャタリングや、起動の押下が二重に届いた場合に
 * 空の録音を送ってしまうのを防ぐ。** 課金されるうえ、意味不明な回答が返る。
 *
 * 📌 **1秒。** 人が押し直すには十分に短く、機械的な重複を弾くには十分に長い
 * （⚠️ **走行中に押し直せないと、上限まで待たされる**ので長くしすぎない）。
 */
export const MIN_RECORDING_MS = 1_000;

/** 送信できる録音の上限。⚠️ サーバー側の MAX_AUDIO_BYTES と同じ値。 */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/**
 * 📌 **録音の上限は `RecordingSettings.maxRecordingMs`**（src/api/recordingSettings.ts）。
 *
 * ⚠️ **走行中は「止める」操作を忘れやすい**うえ、**一度も話さなかったときは
 * 上限だけが録音を止める**（無音検知は発話があったことを条件にするため）。
 * 既定値をここに二重に置くと必ず片方が古くなるので、`recordingSettings.ts` に集約する。
 */

/** `POST /ask-audio` に添える位置情報（`location` パート）。 */
export type VoiceLocation = {
  start: Coordinates;
  end?: Coordinates;
  elapsedSeconds?: number;
};

/**
 * 録音した音声を `POST /ask-audio` に送る。
 *
 * 戻りは `POST /ask` と同じ形（202 + requestId）なので、**待ち方は共通**
 * ＝ 呼び出し側は `GET /ask/{requestId}` を今までどおりポーリングすればよい。
 *
 * ⚠️ **multipart で送る。** base64 にすると 1.33 倍に膨らみ、
 * その上限が録音の長さの上限でもあるため（docs/02）。
 * `fetch` の FormData に `{uri, name, type}` を渡すのは React Native の作法で、
 * ファイルの中身は端末側が読む（JS側にバイト列を載せない）。
 */
export async function sendVoiceQuestion(
  baseUrl: string,
  apiKey: string,
  audioUri: string,
  location: VoiceLocation,
  sessionId?: string | null,
): Promise<AskAcceptedResponse & { error?: string; httpStatus: number }> {
  const form = new FormData();
  // ⚠️ type は audio/mp4。サーバーは M4A 以外を 400 で弾く（形式が違うと
  // 文字起こしが数分後に失敗し、「聞き取れませんでした」に化けるため）。
  form.append("audio", {
    uri: audioUri,
    name: "question.m4a",
    type: "audio/mp4",
  } as unknown as Blob);
  form.append("location", JSON.stringify(location));
  if (sessionId) form.append("sessionId", sessionId);

  const res = await fetch(`${baseUrl}/ask-audio`, {
    method: "POST",
    headers: {
      // ⚠️ Content-Type は指定しない。境界文字列つきの multipart ヘッダを
      // fetch が組み立てるので、手で書くと境界が合わずサーバー側で
      // パースできなくなる。
      [API_KEY_HEADER]: apiKey,
    },
    body: form,
  });

  const data = (await res.json()) as AskAcceptedResponse & { error?: string };
  return { ...data, httpStatus: res.status };
}
