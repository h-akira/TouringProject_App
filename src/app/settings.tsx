/**
 * 設定画面（docs/01_architecture.md §8）。
 *
 * 走行中には使わない画面なので、作り込みは最小限にとどめる
 * （CLAUDE.md「モバイルは必要最低限」）。停車中に触る想定。
 *
 * 扱うのは3つ:
 *   - **APIキー**（一度入れたら変えない）
 *   - **録音の設定**（上限の秒数・録音の用途）
 *   - **応答後に戻るアプリ**（⚠️ **戻る/戻らない**と**どのアプリか**は別物。
 *     一時的に切っただけで選択が消えると、戻すときに選び直しになる）
 *
 * 📌 **無音検知（VAD）の調整は廃止した。** 走行中はエンジン音で音量が飽和して
 * 成立しないため（[adr/008](../../../adr/008_end_of_speech_detection.md)）。
 * 音量計・dB表示・閾値の入力欄も一緒に消している。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, Pressable, StyleSheet, TextInput, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { type RecordingSource } from "expo-audio";
import { loadApiKey, saveApiKey, clearApiKey } from "@/api/apiKey";
import {
  loadReturnApp,
  saveReturnApp,
  saveReturnAppEnabled,
  removeRecentApp,
  orderApps,
  type LaunchableApp,
} from "@/api/returnApp";
import AppForeground from "@/native/app-foreground";
import {
  AUDIO_SOURCE_CHOICES,
  DEFAULT_RECORDING_SETTINGS,
  RECORDING_LIMITS,
  loadRecordingSettings,
  saveRecordingSettings,
  clearRecordingSettings,
  normalizeRecordingSettings,
  type RecordingSettings,
} from "@/api/recordingSettings";

/** 数秒後に自動で消える通知を扱う。 */
const MESSAGE_TIMEOUT_MS = 3_000;

/**
 * 一定時間で自動的に消えるメッセージ。
 *
 * ⚠️ **消えないと「反映されたか」が分からなくなる。** 出したままだと、
 * 2回目に保存したとき**前回の「保存しました」が残っているのか、
 * 今回出たのか区別できない**（同じ文言なので変化が見えない）。
 * 一度消してから出し直すことで、押すたびに必ず変化が起きる。
 */
function useTransientMessage(): [string | null, (message: string | null) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    // ⚠️ 一度 null にしてから出す。同じ文言でも「消えて出た」が見えるように。
    setMessage(null);
    if (next === null) return;
    // 次のフレームで出す（同じレンダーで戻すと変化が見えない）。
    timer.current = setTimeout(() => {
      setMessage(next);
      timer.current = setTimeout(() => setMessage(null), MESSAGE_TIMEOUT_MS);
    }, 50);
  }, []);

  // 画面を離れるときにタイマーを残さない。
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return [message, show];
}

export default function Settings() {
  const [apiKey, setApiKey] = useState("");
  // 保存済みかどうか。入力欄には既存のキーを出さないので、
  // 「もう入れてあるのか」はこの表示でしか分からない。
  const [stored, setStored] = useState<boolean>(false);
  // ⚠️ 数秒で消える（出しっぱなしだと、2回目の保存で反映されたか分からない）。
  const [message, setMessage] = useTransientMessage();
  const [loading, setLoading] = useState(true);

  // 録音の上限。入力途中は数値にならないので、文字列のまま持つ。
  // ⚠️ **数値でstateを持つと「1.」の途中入力が消えて打てなくなる。**
  const [maxRecordingSec, setMaxRecordingSec] = useState("");
  const [recMessage, setRecMessage] = useTransientMessage();
  const [rec, setRec] = useState<RecordingSettings>(DEFAULT_RECORDING_SETTINGS);

  // 応答後に戻るアプリ（US-2.04）。
  // ⚠️ **「戻るか」と「どのアプリか」を別々に持つ。** ひとつにまとめると、
  // **一時的に戻らないようにしただけで選択が消え**、戻したいときに
  // 大量の一覧から選び直すことになる。
  const [apps, setApps] = useState<LaunchableApp[]>([]);
  const [returnEnabled, setReturnEnabled] = useState(false);
  const [returnApp, setReturnApp] = useState<string | null>(null);
  const [recentApps, setRecentApps] = useState<string[]>([]);
  // アプリの絞り込み。⚠️ **インストール済みが多すぎて探せない**ため。
  const [appQuery, setAppQuery] = useState("");
  const [returnAppMessage, setReturnAppMessage] = useTransientMessage();

  const insets = useSafeAreaInsets();

  // ⚠️ 保存済みのキーを入力欄に流し込まない。
  // 画面に出す必要が無いうえ、肩越しに見られる・スクショに写る経路を増やすため。
  // 「設定済みか」だけを見せ、変更したいときは入力し直してもらう。
  //
  // 📌 **閾値の方は逆に、現在値を入力欄に出す**（秘密ではなく、
  // 「いまいくつか」を見ながら微調整するための画面なので）。
  useEffect(() => {
    (async () => {
      setStored((await loadApiKey()) !== null);
      const settings = await loadRecordingSettings();
      setRec(settings);
      // ⚠️ 入力はミリ秒ではなく秒で受ける（読む値なので桁を減らす）。
      setMaxRecordingSec(String(settings.maxRecordingMs / 1000));
      const ret = await loadReturnApp();
      setReturnEnabled(ret.enabled);
      setReturnApp(ret.packageName);
      setRecentApps(ret.recent);
      setLoading(false);
    })();
    // 戻り先に選べるアプリの一覧。⚠️ **失敗しても設定画面全体は使えるようにする**
    // （一覧が空でも、APIキーや閾値の設定は独立して成立する）。
    (async () => {
      try {
        setApps(await AppForeground.listLaunchableApps());
      } catch (e) {
        console.warn("failed to list launchable apps", e);
      }
    })();
  }, []);

  /**
   * 「戻る/戻らない」を切り替える。
   *
   * ⚠️ **選んだアプリは消さない。** 一時的に切りたいだけのことがあり、
   * 消すと**戻すときに大量の一覧から選び直し**になる。
   */
  async function onToggleReturnEnabled(enabled: boolean) {
    setReturnEnabled(enabled);
    try {
      await saveReturnAppEnabled(enabled);
      setReturnAppMessage(
        enabled
          ? returnApp === null
            ? "戻ります（⚠️ アプリを選んでください）"
            : "戻るようにしました"
          : "戻らないようにしました（選んだアプリは残ります）",
      );
    } catch {
      setReturnAppMessage("保存できませんでした");
    }
  }

  /**
   * 戻り先のアプリを選ぶ。⚠️ **選んだ時点で保存する**（保存ボタンを作らない）。
   * 走行前に触る設定なので、押し忘れで効かない方が困る。
   *
   * 📌 **選んだら「戻る」も一緒に立てる**（選ぶ＝戻りたい、なので）。
   */
  async function onSelectReturnApp(packageName: string) {
    setReturnApp(packageName);
    setReturnEnabled(true);
    try {
      setRecentApps(await saveReturnApp(packageName));
      setReturnAppMessage("保存しました");
    } catch {
      setReturnAppMessage("保存できませんでした");
    }
  }

  async function onSave() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setMessage("キーを入力してください");
      return;
    }
    try {
      await saveApiKey(trimmed);
      setStored(true);
      // 保存できたら入力欄からは消す（画面に残し続けない）。
      setApiKey("");
      setMessage("保存しました");
    } catch (e) {
      setMessage("保存に失敗しました: " + String(e));
    }
  }

  async function onClear() {
    try {
      await clearApiKey();
      setStored(false);
      setApiKey("");
      setMessage("削除しました");
    } catch (e) {
      setMessage("削除に失敗しました: " + String(e));
    }
  }

  /**
   * 録音の用途（`audioSource`）を選ぶ。
   *
   * ⚠️ **選んだ時点で保存する**（「保存」ボタンを待たない）。
   * 入力欄と違って選択肢なので、押した結果がそのまま設定になる方が分かりやすい。
   */
  async function onSelectAudioSource(value: RecordingSource) {
    try {
      const saved = await saveRecordingSettings({ ...rec, audioSource: value });
      setRec(saved);
      setRecMessage(`録音の用途を ${value} にしました`);
    } catch (e) {
      setRecMessage("保存に失敗しました: " + String(e));
    }
  }

  /**
   * 「最近選んだもの」から1件外す。
   *
   * 📌 **戻り先の選択には触らない。** ここは**一覧の並びの話**なので、
   * いま選んでいるアプリを消しても設定は変わらない
   * （消した直後も「いま選択中」の表示は残る）。
   */
  async function onRemoveRecent(packageName: string) {
    try {
      setRecentApps(await removeRecentApp(packageName));
      setReturnAppMessage("最近選んだものから外しました");
    } catch {
      setReturnAppMessage("外せませんでした");
    }
  }

  async function onSaveRecording() {
    // 秒で受けてミリ秒に直す。数値でない入力は保存済みの値を据え置く。
    const parsed = normalizeRecordingSettings({
      maxRecordingMs: Number(maxRecordingSec) * 1000,
      // ⚠️ **入力欄には無いので、いまの値を持ち回る**（落とすと既定に戻る）。
      audioSource: rec.audioSource,
    });
    try {
      const saved = await saveRecordingSettings(parsed);
      setRec(saved);
      // ⚠️ **範囲外の入力は寄せて保存されるので、入力欄も直った値に揃える**
      // （画面と実際の設定がズレたままになるのを防ぐ）。
      setMaxRecordingSec(String(saved.maxRecordingMs / 1000));
      setRecMessage("保存しました");
    } catch (e) {
      setRecMessage("保存に失敗しました: " + String(e));
    }
  }

  async function onResetRecording() {
    try {
      await clearRecordingSettings();
      setRec(DEFAULT_RECORDING_SETTINGS);
      setMaxRecordingSec(
        String(DEFAULT_RECORDING_SETTINGS.maxRecordingMs / 1000),
      );
      setRecMessage("既定値に戻しました");
    } catch (e) {
      setRecMessage("戻せませんでした: " + String(e));
    }
  }

  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, 24) + 24 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>APIキー</Text>
      <Text style={styles.note}>
        バックエンドを呼ぶのに必要です。デプロイ時に発行された値を入れてください。
      </Text>

      {!loading && (
        <Text style={stored ? styles.statusOk : styles.statusMissing}>
          {stored ? "設定済み" : "未設定"}
        </Text>
      )}

      <TextInput
        style={styles.input}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={stored ? "変更する場合のみ入力" : "APIキーを貼り付け"}
        placeholderTextColor="#888899"
        // ⚠️ 肩越しに見られないよう伏せ字にする。
        secureTextEntry
        // キーは大小を区別する。勝手に直されると通らない値になる。
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Pressable
        style={[styles.button, !apiKey.trim() && styles.buttonDisabled]}
        onPress={onSave}
        disabled={!apiKey.trim()}
      >
        <Text style={styles.buttonText}>保存</Text>
      </Pressable>

      {stored && (
        <Pressable style={styles.clearButton} onPress={onClear}>
          <Text style={styles.clearButtonText}>削除</Text>
        </Pressable>
      )}

      {message && <Text style={styles.message}>{message}</Text>}

      {/* ⚠️ **無音検知の調整。** 走行中は画面を触れないので、
          「話し終えたら自動で送る」が成立しないとハンズフリーにならない。
          妥当な値は風切り音・エンジン音で変わるため、ここで詰められるようにする。 */}
      <View style={styles.divider} />
      <Text style={styles.title}>録音</Text>
      <Text style={styles.note}>
        インカムのボタンをもう一度押すと、その場で送信します。
        押さなかったときは下の秒数で自動的に送られます。
      </Text>

      <Text style={styles.fieldLabel}>
        録音の上限（秒・{RECORDING_LIMITS.maxRecordingMs.min / 1000}〜
        {RECORDING_LIMITS.maxRecordingMs.max / 1000}）
      </Text>
      <Text style={styles.hint}>
        ⚠️ ボタンを押さないときは、ここまで待ってから送られます。
        長い質問をしたいときは伸ばしてください（長すぎると送信に失敗します）。
      </Text>
      <TextInput
        style={styles.input}
        value={maxRecordingSec}
        onChangeText={setMaxRecordingSec}
        keyboardType="numbers-and-punctuation"
        placeholder={String(DEFAULT_RECORDING_SETTINGS.maxRecordingMs / 1000)}
        placeholderTextColor="#888899"
      />

      <Pressable style={styles.button} onPress={onSaveRecording}>
        <Text style={styles.buttonText}>保存</Text>
      </Pressable>

      {/* ⚠️ **録音の用途（audioSource）。** 端末側のノイズ除去が変わる。
          📌 実測は pre-research/handsfree/FINDINGS.md §15。 */}
      <Text style={styles.fieldLabel}>録音の用途</Text>
      <Text style={styles.hint}>
        端末側の音の加工（ノイズ除去）が変わります。
        📌 実測では voice_communication が最もノイズを除けました。
      </Text>
      {AUDIO_SOURCE_CHOICES.map((choice) => (
        <Pressable
          key={choice.value}
          style={[
            styles.appRow,
            rec.audioSource === choice.value && styles.appRowSelected,
          ]}
          onPress={() => void onSelectAudioSource(choice.value)}
        >
          <Text style={styles.appRowText}>
            {rec.audioSource === choice.value ? "◉" : "○"}　{choice.label}
          </Text>
          <Text style={styles.hint}>{choice.hint}</Text>
        </Pressable>
      ))}

      <Pressable style={styles.clearButton} onPress={onResetRecording}>
        <Text style={styles.clearButtonText}>既定値に戻す</Text>
      </Pressable>

      {recMessage && <Text style={styles.message}>{recMessage}</Text>}

      <View style={styles.divider} />

      <Text style={styles.title}>応答後に戻るアプリ</Text>
      <Text style={styles.note}>
        インカムのボタンで起動したときだけ、回答が届いた時点でこのアプリに戻ります
        （読み上げは戻ったあとも続きます）。ナビ中のアプリを選んでください。
      </Text>
      <Text style={styles.note}>
        ⚠️ 案内中のルートは壊れません（開き直すのではなく、元の画面に戻ります）。
      </Text>

      {/* ⚠️ **まず「戻る/戻らない」の二択。** アプリの選択とは分ける。
          一時的に切りたいだけのときに、選んだアプリまで消さないため。 */}
      <View style={styles.toggleRow}>
        <Pressable
          style={[styles.toggle, !returnEnabled && styles.toggleSelected]}
          onPress={() => void onToggleReturnEnabled(false)}
        >
          <Text
            style={!returnEnabled ? styles.toggleTextOn : styles.toggleText}
          >
            戻らない
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toggle, returnEnabled && styles.toggleSelected]}
          onPress={() => void onToggleReturnEnabled(true)}
        >
          <Text style={returnEnabled ? styles.toggleTextOn : styles.toggleText}>
            戻る
          </Text>
        </Pressable>
      </View>

      {/* ⚠️ **「戻る」を選んだときだけアプリを出す。**
          「戻らない」のときに一覧を見せても選ばせる意味が無い。
          📌 **選択自体は残っている**ので、戻せば元のアプリが選ばれたまま。 */}
      {returnEnabled ? (
        <>
          <Text style={styles.selectedApp}>
            {returnApp === null
              ? "⚠️ アプリが選ばれていません"
              : `いま選択中: ${
                  apps.find((a) => a.packageName === returnApp)?.label ??
                  returnApp
                }`}
          </Text>

          {/* ⚠️ **一覧が多すぎて探せない**ので、名前で絞り込めるようにする。
              ⚠️ **見出しを付ける。** プレースホルダだけだと、消したときに
              **どこが入力欄なのか分からなくなる**（下のアプリ行と同じ見た目のため）。 */}
          <Text style={styles.fieldLabel}>アプリを絞り込む</Text>
          <View style={styles.searchRow}>
            <TextInput
              style={[styles.input, styles.searchInput]}
              value={appQuery}
              onChangeText={setAppQuery}
              placeholder="アプリ名を入力"
              placeholderTextColor="#888899"
              autoCorrect={false}
              autoCapitalize="none"
            />
            {/* 📌 **入力があるときだけ×を出す**（消すために全選択させない）。 */}
            {appQuery !== "" && (
              <Pressable
                style={styles.searchClear}
                onPress={() => setAppQuery("")}
              >
                <Text style={styles.searchClearText}>✕</Text>
              </Pressable>
            )}
          </View>

          {apps.length === 0 ? (
            <Text style={styles.note}>アプリの一覧を取得できませんでした。</Text>
          ) : (
            (() => {
              // 📌 **選んだことのあるものを上に出す**（お気に入りは作らない）。
              const { recent, rest } = orderApps(apps, recentApps, appQuery);
              if (recent.length === 0 && rest.length === 0) {
                return (
                  <Text style={styles.note}>該当するアプリがありません。</Text>
                );
              }
              /**
               * アプリ1件の行。
               *
               * ⚠️ **「最近選んだもの」には×を付ける。** 誤操作で選んでしまった
               * ものが上位に居座ると、**探す手間を減らすための場所が逆に邪魔になる。**
               */
              const row = (app: LaunchableApp, removable = false) => (
                <View key={app.packageName} style={styles.appRowWrap}>
                  <Pressable
                    style={[
                      styles.appRow,
                      styles.appRowGrow,
                      returnApp === app.packageName && styles.appRowSelected,
                    ]}
                    onPress={() => void onSelectReturnApp(app.packageName)}
                  >
                    <Text style={styles.appRowText} numberOfLines={1}>
                      {returnApp === app.packageName ? "◉" : "○"}　{app.label}
                    </Text>
                  </Pressable>
                  {removable && (
                    <Pressable
                      style={styles.recentRemove}
                      onPress={() => void onRemoveRecent(app.packageName)}
                    >
                      <Text style={styles.recentRemoveText}>✕</Text>
                    </Pressable>
                  )}
                </View>
              );
              return (
                <>
                  {recent.length > 0 && (
                    <>
                      <Text style={styles.groupLabel}>
                        最近選んだもの（✕ で一覧から消せます）
                      </Text>
                      {recent.map((app) => row(app, true))}
                      {rest.length > 0 && (
                        <Text style={styles.groupLabel}>すべてのアプリ</Text>
                      )}
                    </>
                  )}
                  {rest.map((app) => row(app))}
                </>
              );
            })()
          )}
        </>
      ) : (
        returnApp !== null && (
          <Text style={styles.hint}>
            📌 「
            {apps.find((a) => a.packageName === returnApp)?.label ?? returnApp}
            」を選んだままにしてあります。「戻る」にすればそのまま使えます。
          </Text>
        )
      )}

      {returnAppMessage && (
        <Text style={styles.message}>{returnAppMessage}</Text>
      )}

      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <Text style={styles.backButtonText}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    // ⚠️ center にしない。項目が増えて画面より縦に長くなったため、
    // 中央寄せだと上端が切れてスクロールしても戻せなくなる。
    justifyContent: "flex-start",
    backgroundColor: "#1E1E2E",
    padding: 24,
    paddingTop: 40,
    gap: 16,
  },
  title: { fontSize: 22, fontWeight: "bold", color: "#FFFFFF" },
  note: { fontSize: 13, color: "#AAAAAA" },
  statusOk: { fontSize: 15, color: "#7FD1AE", fontWeight: "bold" },
  statusMissing: { fontSize: 15, color: "#FF6B35", fontWeight: "bold" },
  input: {
    backgroundColor: "#2A2A3E",
    color: "#FFFFFF",
    fontSize: 16,
    padding: 14,
    borderRadius: 8,
  },
  button: {
    backgroundColor: "#FF6B35",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonDisabled: { backgroundColor: "#8A5A44" },
  buttonText: { color: "#FFFFFF", fontSize: 17, fontWeight: "bold" },
  clearButton: {
    borderWidth: 2,
    borderColor: "#8A5A44",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  clearButtonText: { color: "#FF9E7A", fontSize: 15, fontWeight: "bold" },
  message: { fontSize: 14, color: "#7FD1AE", textAlign: "center" },
  // 行と「×」を横に並べる。⚠️ ×が無い行でも幅が変わらないようにする。
  appRowWrap: { flexDirection: "row", gap: 8, alignItems: "stretch" },
  appRowGrow: { flex: 1 },
  appRow: {
    backgroundColor: "#2A2A3E",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  appRowSelected: { borderColor: "#FF6B35" },
  appRowText: { color: "#FFFFFF", fontSize: 15 },
  /**
   * 「最近選んだもの」から外す×。
   *
   * ⚠️ **選ぶ側と押し間違えない大きさにする。** 小さすぎると誤爆し、
   * 大きすぎると本来の目的（選ぶ）を邪魔する。
   */
  recentRemove: {
    width: 48,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#3A3A4E",
    alignItems: "center",
    justifyContent: "center",
  },
  recentRemoveText: { color: "#888899", fontSize: 18, fontWeight: "bold" },
  // 絞り込み欄と、その中身を消す×。
  searchRow: { flexDirection: "row", gap: 8, alignItems: "stretch" },
  searchInput: { flex: 1 },
  searchClear: {
    width: 48,
    borderRadius: 8,
    backgroundColor: "#2A2A3E",
    alignItems: "center",
    justifyContent: "center",
  },
  searchClearText: { color: "#AAAAAA", fontSize: 18, fontWeight: "bold" },
  divider: {
    borderTopWidth: 1,
    borderTopColor: "#3A3A4E",
    marginTop: 12,
    paddingTop: 4,
  },
  fieldLabel: { fontSize: 14, color: "#FFFFFF", fontWeight: "bold" },
  hint: { fontSize: 12, color: "#888899", lineHeight: 17 },
  /**
   * 「戻る/戻らない」の二択。
   *
   * ⚠️ **一覧の中の1行にしない。** 一行に混ぜると、切り替えたつもりで
   * アプリの選択を外してしまう（それが元の作りの問題だった）。
   */
  toggleRow: { flexDirection: "row", gap: 12 },
  toggle: {
    flex: 1,
    borderWidth: 2,
    borderColor: "#3A3A4E",
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: "center",
  },
  toggleSelected: { borderColor: "#FF6B35", backgroundColor: "#3A2A2E" },
  toggleText: { color: "#888899", fontSize: 17, fontWeight: "bold" },
  toggleTextOn: { color: "#FF6B35", fontSize: 17, fontWeight: "bold" },
  // いま何が選ばれているか。⚠️ 一覧が長いので、上で分かるようにする。
  selectedApp: { fontSize: 14, color: "#7FD1AE", fontWeight: "bold" },
  groupLabel: {
    fontSize: 12,
    color: "#888899",
    fontWeight: "bold",
    marginTop: 4,
  },
  backButton: { paddingVertical: 12, alignItems: "center" },
  backButtonText: { color: "#AAAAAA", fontSize: 16 },
});
