/**
 * 録音の履歴の一覧（純粋な関数だけ。保存は src/api/recordingHistory.ts）。
 *
 * ⚠️ **React Native にもネイティブにも触れない**（`npm test` で動かすため）。
 */

/** 端末に残す録音の件数。⚠️ **超えたら古いものから消す**（声は個人情報なので溜めない）。 */
export const MAX_RECORDINGS = 10;

/** 残した録音1件。 */
export type RecordingEntry = {
  /** ファイル名にも使う識別子。 */
  id: string;
  /** 端末内のファイルの URI。 */
  uri: string;
  /** 録り終えた時刻（ミリ秒）。 */
  recordedAt: number;
  /** 録音の長さ（ミリ秒）。 */
  durationMs: number;
  /** 録音の用途（`audioSource`）。⚠️ **機種との相性を比べるために残す。** */
  audioSource: string;
  /** どのマイクで録ったか（`describeMicRoute` の表現）。 */
  mic: string;
  /** 送ったか（false は設定画面の試し録り）。 */
  sent: boolean;
  /**
   * サーバーが聞き取った文。⚠️ **空文字は「何も聞き取れなかった」**、
   * 未定義は「まだ分からない（送っていない・結果が来ていない）」。
   */
  transcript?: string;
  /** 回答、またはエラーの文言。 */
  outcome?: string;
};

/**
 * 先頭に足し、上限を超えたぶんを返す（新しい順に並べる）。
 *
 * 📌 **消すべきものを返す**のは、ファイルの削除を呼び出し側に任せるため。
 */
export function addEntry(
  entries: readonly RecordingEntry[],
  entry: RecordingEntry,
  max: number = MAX_RECORDINGS,
): { entries: RecordingEntry[]; dropped: RecordingEntry[] } {
  const next = [entry, ...entries.filter((e) => e.id !== entry.id)];
  return { entries: next.slice(0, max), dropped: next.slice(max) };
}

/** 1件を部分的に書き換える。⚠️ **無ければ何もしない**（上限で既に消えた場合）。 */
export function updateEntry(
  entries: readonly RecordingEntry[],
  id: string,
  patch: Partial<Omit<RecordingEntry, "id">>,
): RecordingEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

/** 保存された JSON を読む。⚠️ **壊れていても落とさず、読めた分だけ返す。** */
export function parseEntries(raw: string | null): RecordingEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecordingEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RecordingEntry).id === "string" &&
        typeof (e as RecordingEntry).uri === "string" &&
        typeof (e as RecordingEntry).recordedAt === "number",
    );
  } catch {
    return [];
  }
}
