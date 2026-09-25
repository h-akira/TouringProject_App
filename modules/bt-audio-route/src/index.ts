/**
 * ⚠️ **インカム（Bluetooth）のマイクで録るための、SCO 経路の確立と解放。**
 *
 * **なぜ自前か**: `expo-audio` 1.1.1 の `setInput()` は
 * `setCommunicationDevice()` に**入力デバイス**を渡しているが、
 * 公式仕様は**出力(sink)しか受け付けない**ので黙って失敗する
 * （`pre-research/mic-routing/`）。
 *
 * 📌 **録音そのものは `expo-audio` のまま。** ここは経路だけを担当する。
 */
import { requireNativeModule } from "expo-modules-core";

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

declare class BtAudioRouteModule {
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
}

export default requireNativeModule<BtAudioRouteModule>("BtAudioRoute");
