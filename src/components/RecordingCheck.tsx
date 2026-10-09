/**
 * 設定画面の「録音の確認」。停車中に、録った音を聞き直す。
 *
 * **なぜ要るか**: 聞き取りの良し悪しは**機種と録音の用途の相性**で大きく変わる
 * （古い機種では用途によって全く録れないことがあった）。どの用途が合うかは
 * 端末ごとに**録って聞いて**決めるしかないので、2つの手段を置く:
 *   - **試し録り**: 選んでいる用途で録り、送らずにすぐ再生する（課金されない）
 *   - **履歴**: 走行中に実際に送った録音を、サーバーが聞き取った文と並べて聞き直す
 *     （「録音が悪い」のか「認識が悪い」のかを切り分ける）
 *
 * ⚠️ **試し録りも本番と同じ経路で録る**（インカムの経路を張り、選んでいる用途で録る）。
 * 違う経路で録ると、試した結果が走行中に当てはまらない。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from "expo-audio";
import {
  AUDIO_MODE_PLAYBACK,
  AUDIO_MODE_RECORDING,
  recordingOptions,
} from "@/api/voice";
import type { RecordingSettings } from "@/api/recordingSettings";
import {
  acquireMicRoute,
  describeMicRoute,
  releaseMicRoute,
  watchIntercomEnded,
  type MicRoute,
} from "@/api/micRoute";
import {
  clearRecordings,
  keepRecording,
  loadRecordings,
  type RecordingEntry,
} from "@/api/recordingHistory";
import { MAX_RECORDINGS } from "@/api/recordingEntries";
import { trace } from "@/api/trace";

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 聞き取った文の表示。⚠️ **空文字（聞き取れなかった）と未定義（分からない）を分ける。** */
function describeTranscript(entry: RecordingEntry): string {
  if (!entry.sent) return "（試し録り・送っていない）";
  if (entry.transcript === undefined) return "聞き取り: （結果なし）";
  if (entry.transcript === "") return "聞き取り: ⚠️ 何も聞き取れなかった";
  return `聞き取り: ${entry.transcript}`;
}

export default function RecordingCheck({ settings }: { settings: RecordingSettings }) {
  const [entries, setEntries] = useState<RecordingEntry[]>([]);
  const [testing, setTesting] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // `audioSource` が変われば録音オブジェクトが作り直される（index.tsx と同じ）。
  const recorder = useAudioRecorder(recordingOptions(settings));
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);

  // ⚠️ ref で見る。インカムの通知やタイマーは古いレンダーのまま呼ばれる。
  const testingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const routeRef = useRef<MicRoute | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  const reload = useCallback(async () => {
    setEntries(await loadRecordings());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function play(entry: RecordingEntry) {
    try {
      player.replace({ uri: entry.uri });
      player.play();
      setPlayingId(entry.id);
    } catch (e) {
      trace("[history] failed to play", e);
      setNote("再生できませんでした");
    }
  }

  function stopPlaying() {
    player.pause();
    setPlayingId(null);
  }

  /** 後片付け。⚠️ **経路と音声モードを必ず戻す**（戻さないと読み上げが鳴らなくなる）。 */
  async function cleanUp(reason: string) {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    unwatchRef.current?.();
    unwatchRef.current = null;
    await releaseMicRoute(reason);
    await setAudioModeAsync(AUDIO_MODE_PLAYBACK);
  }

  async function startTest() {
    if (testingRef.current) return;
    setNote(null);
    stopPlaying();
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setNote("マイクの許可が得られませんでした");
        return;
      }
      testingRef.current = true;
      setTesting(true);
      await setAudioModeAsync(AUDIO_MODE_RECORDING);
      // 本番と同じく、インカムのボタンを押すと止まる（経路が切れた通知として届く）。
      unwatchRef.current = watchIntercomEnded(() => void stopTest());
      const route = await acquireMicRoute(null);
      routeRef.current = route;
      if (route.kind !== "intercom") {
        unwatchRef.current?.();
        unwatchRef.current = null;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAtRef.current = Date.now();
      // 押し忘れの受け皿（本番と同じ上限）。
      timerRef.current = setTimeout(() => void stopTest(), settings.maxRecordingMs);
    } catch (e) {
      trace("[history] test recording failed to start", e);
      testingRef.current = false;
      setTesting(false);
      setNote("録音を開始できませんでした: " + String(e));
      await cleanUp("test start failed");
    }
  }

  async function stopTest() {
    if (!testingRef.current) return;
    testingRef.current = false;
    setTesting(false);
    const startedAt = startedAtRef.current;
    startedAtRef.current = null;
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch (e) {
      trace("[history] test recording failed to stop", e);
    }
    await cleanUp("test stop");
    if (!uri) {
      setNote("録音を保存できませんでした");
      return;
    }
    const now = Date.now();
    const entry = await keepRecording(uri, {
      recordedAt: now,
      durationMs: startedAt === null ? 0 : now - startedAt,
      audioSource: settings.audioSource,
      mic: routeRef.current ? describeMicRoute(routeRef.current) : "不明",
      sent: false,
    });
    await reload();
    // 📌 **録り終えたらすぐ再生する**（聞くために録ったので）。
    if (entry) play(entry);
    else setNote("録音を保存できませんでした");
  }

  async function onClear() {
    stopPlaying();
    await clearRecordings();
    await reload();
    setNote("すべて消しました");
  }

  // ⚠️ **画面を離れるときに録音中なら止める。** 残すとマイクと経路を掴んだままになる。
  useEffect(() => {
    return () => {
      if (!testingRef.current) return;
      testingRef.current = false;
      void (async () => {
        try {
          await recorder.stop();
        } catch {
          // 後片付けなので伝える相手がいない。
        }
        await cleanUp("test unmount");
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playing = playingId !== null && playerStatus.playing;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>録音の確認</Text>
      <Text style={styles.note}>
        聞き取りやすさは機種と録音の用途の相性で変わります。試し録りで用途ごとに聞き比べ、
        走行後は送った録音と「どう聞き取られたか」を確かめてください。
        録音は端末の中だけに直近{MAX_RECORDINGS}件まで残ります。
      </Text>

      <Pressable
        style={[styles.button, testing && styles.buttonRecording]}
        onPress={() => void (testing ? stopTest() : startTest())}
      >
        <Text style={styles.buttonText}>
          {testing ? "■ 止めて再生" : `● 試し録り（${settings.audioSource}）`}
        </Text>
      </Pressable>
      <Text style={styles.hint}>
        インカムを繋いでいれば、インカムのマイクで録ります。インカムのボタンでも止められます。
      </Text>

      {note && <Text style={styles.message}>{note}</Text>}

      {entries.length === 0 ? (
        <Text style={styles.note}>まだ録音はありません。</Text>
      ) : (
        entries.map((entry) => {
          const isPlaying = playing && playingId === entry.id;
          return (
            <View key={entry.id} style={styles.row}>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>
                  {formatTime(entry.recordedAt)}　{entry.sent ? "送信" : "試し録り"}
                  {(entry.durationMs / 1000).toFixed(1)}秒
                </Text>
                <Text style={styles.hint}>
                  {entry.audioSource} / {entry.mic}
                </Text>
                <Text style={styles.rowText}>{describeTranscript(entry)}</Text>
                {entry.outcome !== undefined && (
                  <Text style={styles.hint} numberOfLines={2}>
                    結果: {entry.outcome}
                  </Text>
                )}
              </View>
              <Pressable
                style={styles.playButton}
                onPress={() => (isPlaying ? stopPlaying() : play(entry))}
              >
                <Text style={styles.playButtonText}>{isPlaying ? "■" : "▶"}</Text>
              </Pressable>
            </View>
          );
        })
      )}

      {entries.length > 0 && (
        <Pressable style={styles.clearButton} onPress={() => void onClear()}>
          <Text style={styles.clearButtonText}>録音をすべて消す</Text>
        </Pressable>
      )}
    </View>
  );
}

// 見た目は設定画面（src/app/settings.tsx）に揃える。
const styles = StyleSheet.create({
  container: { gap: 16 },
  title: { fontSize: 22, fontWeight: "bold", color: "#FFFFFF" },
  note: { fontSize: 13, color: "#AAAAAA" },
  hint: { fontSize: 12, color: "#888899", lineHeight: 17 },
  message: { fontSize: 14, color: "#7FD1AE", textAlign: "center" },
  button: {
    backgroundColor: "#FF6B35",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonRecording: { backgroundColor: "#C0392B" },
  buttonText: { color: "#FFFFFF", fontSize: 17, fontWeight: "bold" },
  row: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#2A2A3E",
    borderRadius: 8,
    padding: 12,
  },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "bold" },
  rowText: { color: "#FFFFFF", fontSize: 14 },
  playButton: {
    width: 48,
    borderRadius: 8,
    backgroundColor: "#3A3A4E",
    alignItems: "center",
    justifyContent: "center",
  },
  playButtonText: { color: "#FFFFFF", fontSize: 20 },
  clearButton: {
    borderWidth: 2,
    borderColor: "#8A5A44",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  clearButtonText: { color: "#FF9E7A", fontSize: 15, fontWeight: "bold" },
});
