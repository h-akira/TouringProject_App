/**
 * 録音を端末に残し、あとで聞き直せるようにする（設定画面の「録音の確認」）。
 *
 * **なぜ要るか**: 聞き取りの良し悪しは**機種・録音の用途・話し方で変わる**が、
 * 「回答が変だった」だけでは**録音が悪いのか、認識が悪いのか**を切り分けられない。
 * 録った音とサーバーが聞き取った文を並べて、停車中に確かめられるようにする。
 *
 * ⚠️ **端末の中だけに置く**（サーバーには残さない）。声は個人情報なので、
 * 件数も `MAX_RECORDINGS` で抑え、古いものから消す。
 *
 * ⚠️ **例外を投げない。** 走行中の送信の途中で呼ぶので、ここが失敗しても
 * **質問の送信は続けなければならない**（記録は諦めてよい）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { trace } from "@/api/trace";
import {
  addEntry,
  parseEntries,
  updateEntry,
  type RecordingEntry,
} from "@/api/recordingEntries";

export type { RecordingEntry } from "@/api/recordingEntries";

/** 秘密ではないので AsyncStorage に置く（`expo-secure-store` は API キー用）。 */
const STORE_KEY = "touring.recordingHistory";

/** 録音のファイルの置き場。⚠️ **キャッシュではなく document に置く**（OS に消されないように）。 */
const DIR_NAME = "recordings";

/**
 * 読み書きを1本に並べる。
 *
 * ⚠️ **送信の直後に「足す」、回答が来たら「書き足す」**ので、間に設定画面の
 * 試し録りが挟まると、読んでから書くまでの間に互いの変更を上書きしうる。
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function read(): Promise<RecordingEntry[]> {
  return parseEntries(await AsyncStorage.getItem(STORE_KEY));
}

async function write(entries: RecordingEntry[]): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(entries));
}

function deleteFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (e) {
    trace("[history] failed to delete a recording", e);
  }
}

/**
 * 録り終えた時刻から決まる識別子。
 *
 * 📌 **`keepRecording` を待たずに後から `updateRecording` できるようにする**
 * （送信を保存の完了まで待たせないため。順序は `serialize` が保つ）。
 */
export function recordingId(recordedAt: number): string {
  return String(recordedAt);
}

/** 残してある録音を新しい順に返す。⚠️ **ファイルが消えているものは除く。** */
export function loadRecordings(): Promise<RecordingEntry[]> {
  return serialize(async () => {
    try {
      return (await read()).filter((e) => {
        try {
          return new File(e.uri).exists;
        } catch {
          return false;
        }
      });
    } catch (e) {
      trace("[history] failed to load", e);
      return [];
    }
  });
}

/**
 * 録り終えた録音を写して残す。失敗したら null（⚠️ **送信は止めない**）。
 *
 * 📌 **移動ではなく複製**にする。元のファイルはこのあと送信に使うので、
 * 触らずに残しておく。
 */
export function keepRecording(
  sourceUri: string,
  meta: Omit<RecordingEntry, "id" | "uri">,
): Promise<RecordingEntry | null> {
  return serialize(async () => {
    try {
      const dir = new Directory(Paths.document, DIR_NAME);
      if (!dir.exists) dir.create();
      const id = recordingId(meta.recordedAt);
      const target = new File(dir, `${id}.m4a`);
      if (target.exists) target.delete();
      new File(sourceUri).copy(target);

      const entry: RecordingEntry = { ...meta, id, uri: target.uri };
      const { entries, dropped } = addEntry(await read(), entry);
      await write(entries);
      for (const old of dropped) deleteFile(old.uri);
      return entry;
    } catch (e) {
      trace("[history] failed to keep a recording", e);
      return null;
    }
  });
}

/** 聞き取った文や結果を書き足す。 */
export function updateRecording(
  id: string,
  patch: Partial<Omit<RecordingEntry, "id">>,
): Promise<void> {
  return serialize(async () => {
    try {
      await write(updateEntry(await read(), id, patch));
    } catch (e) {
      trace("[history] failed to update a recording", e);
    }
  });
}

/** 残してある録音をすべて消す。 */
export function clearRecordings(): Promise<void> {
  return serialize(async () => {
    try {
      for (const e of await read()) deleteFile(e.uri);
      await AsyncStorage.removeItem(STORE_KEY);
    } catch (e) {
      trace("[history] failed to clear", e);
    }
  });
}
