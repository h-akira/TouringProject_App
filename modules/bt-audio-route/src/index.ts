/**
 * ⚠️ **インカム（Bluetooth）のマイクで録るための、SCO 経路の確立と解放。**
 *
 * **なぜ自前か**: `expo-audio` 1.1.1 の `setInput()` は
 * `setCommunicationDevice()` に**入力デバイス**を渡しているが、
 * 公式仕様は**出力(sink)しか受け付けない**ので黙って失敗する
 * （`pre-research/mic-routing/`）。
 *
 * 📌 **録音そのものは `expo-audio` のまま。** ここは経路だけを担当する。
 *
 * ⚠️ **経路は2通りある**:
 * - `startVoiceRecognition()` — **インカムの「音声認識を始めて」に正式に返事をして張る**（いま使う方）
 * - `acquireSco()` — 仮想通話として張る。⚠️ **録音中にインカムのボタンが「電話を切る」になる**
 *   （`pre-research/mic-routing/FINDINGS.md` §10）
 */
import { NativeModule, requireNativeModule } from "expo-modules-core";

/** 通信デバイス1つ。⚠️ **これは出力(sink)の一覧**（入力の一覧とは別物）。 */
export type CommDevice = {
  id: number;
  type: string;
  name: string;
  isSco: boolean;
};

/** `getDevices()` の結果。**診断画面にそのまま出す。** */
export type DevicesInfo = {
  available: CommDevice[];
  current: CommDevice | null;
  mode: string;
  /** ⚠️ **SCOの出力が一覧にあるか。** 無ければ指名しようがない。 */
  hasScoOutput: boolean;
};

/** `acquireSco()` の結果。⚠️ **`ok` を必ず見ること**（無音で気づくのでは遅い）。 */
export type AcquireResult = {
  ok: boolean;
  device: CommDevice | null;
  /** 確立までにかかった時間。⚠️ **走行中の遅延になるので測る。** */
  elapsedMs: number;
  /** 何が起きたか。**失敗の理由もここに入る。** */
  note: string;
};

/** `startVoiceRecognition()` の結果。 */
export type VoiceRecognitionResult = {
  ok: boolean;
  elapsedMs: number;
  note: string;
  /** 機器名（⚠️ アドレスは返さない）。 */
  device: string | null;
};

/**
 * 音声認識のセッション中に SCO が切れた（⚠️ **自分で止めた場合は来ない**）。
 * 📌 **インカムのボタンの2回目の押下は、アプリにはこの形でしか届かない**（Intent は来ない）。
 */
export type VoiceRecognitionEndedEvent = {
  reason: "sco-lost";
  /** どちらで検知したか（ブロードキャスト / ポーリング）。 */
  source: string;
  sessionMs: number;
  connectedMs: number;
  device: string;
};

/** HFP の状態変化（診断用。すべて流す）。 */
export type HeadsetEvent = {
  kind: string;
  state: string;
  previous: string;
  session: boolean;
};

/** `describeRecording()` の結果。 */
export type RecordingInfo = {
  recordings: {
    source: number;
    device: string | null;
    deviceName: string | null;
    silenced: boolean | null;
  }[];
  snapshot: string;
};

type BtAudioRouteEvents = {
  onVoiceRecognitionEnded: (event: VoiceRecognitionEndedEvent) => void;
  onHeadsetEvent: (event: HeadsetEvent) => void;
};

declare class BtAudioRouteModule extends NativeModule<BtAudioRouteEvents> {
  /** 通信デバイスの一覧と現在の選択を返す（副作用なし）。 */
  getDevices(): Promise<DevicesInfo>;

  /**
   * SCO を張る。⚠️ **録音を始める前に呼び、`ok` を確認する。**
   *
   * @param timeoutMs 確立を待つ上限。⚠️ **走行中の遅延になるので短く。**
   */
  acquireSco(timeoutMs: number): Promise<AcquireResult>;

  /** ⚠️ **必ず呼ぶ。** 立てっぱなしだと端末全体の音の出方が変わる。 */
  releaseSco(): Promise<void>;

  /**
   * 音声認識として SCO を張る。⚠️ **インカムのボタンの押下から約5秒以内に呼ぶ。**
   *
   * @param timeoutMs 確立を待つ上限。
   */
  startVoiceRecognition(timeoutMs: number): Promise<VoiceRecognitionResult>;

  /** 音声認識を止めて SCO を切る。⚠️ **録音を終えたら必ず呼ぶ。** */
  stopVoiceRecognition(reason: string): Promise<void>;

  /** いま録音がどのマイクで行われているか。 */
  describeRecording(): Promise<RecordingInfo>;

  /** 経路まわりの状態を1行で。 */
  snapshot(): Promise<string>;

  /** 記録ファイルに1行書く（logcat にも出る）。 */
  appendTrace(line: string): void;

  /** 記録ファイルの場所（`adb pull` 用）。 */
  tracePath(): string | null;
}

export default requireNativeModule<BtAudioRouteModule>("BtAudioRoute");
