import { useState, useEffect, useRef, useCallback } from "react";
import {
  Text,
  View,
  Pressable,
  StyleSheet,
  ScrollView,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { useURL, parse as parseUrl } from "expo-linking";
import {
  useAudioRecorder,
  useAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { loadApiKey, API_KEY_HEADER } from "@/api/apiKey";
import * as Speech from "expo-speech";
import {
  recordingOptions,
  AUDIO_MODE_RECORDING,
  AUDIO_MODE_PLAYBACK,
  MIN_RECORDING_MS,
  sendVoiceQuestion,
  type VoiceLocation,
} from "@/api/voice";
import {
  DEFAULT_RECORDING_SETTINGS,
  loadRecordingSettings,
  type RecordingSettings,
} from "@/api/recordingSettings";
import { loadReturnApp } from "@/api/returnApp";
import AppForeground from "@/native/app-foreground";
import {
  acquireMicRoute,
  describeMicRoute,
  releaseMicRoute,
  type MicRoute,
} from "@/api/micRoute";
import type {
  AskRequest,
  AskAcceptedResponse,
  AskResultResponse,
} from "@/api/types";

// 画面に出すバージョン（app.json の version）。
// ⚠️ **実機で「更新が反映されたか」を確かめるためのもの。**
// Expo Go はキャッシュが残ることがあり、見た目では判別できないため。
// アプリの変更時は app.json の version を上げること（CLAUDE.md に明記）。
const APP_VERSION = Constants.expoConfig?.version ?? "?";

// Backend base URL from the environment (.env -> EXPO_PUBLIC_API_BASE_URL).
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

// 回答待ちのポーリング設定（docs/01a）。
// テキストは実測10〜13秒なので大半は最初の帯（1秒間隔）で終わる。
// ⚠️ **音声はここに文字起こしのぶんが乗る**（実測15〜20秒）。バッチの
// ジョブ待ちが入ると更に伸びうるので、打ち切りは音声を基準にしてある。
// ⚠️ **必ず打ち切る。** 終わらない質問を延々と叩き続けない。
const POLL_STEPS = [
  { untilMs: 30_000, intervalMs: 1_000 },
  { untilMs: 60_000, intervalMs: 2_000 },
  { untilMs: 120_000, intervalMs: 4_000 },
] as const;
/** 経過時間に応じた次のポーリング間隔。打ち切り後は null。 */
function nextPollInterval(elapsedMs: number): number | null {
  const step = POLL_STEPS.find((s) => elapsedMs < s.untilMs);
  return step ? step.intervalMs : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTPエラーを、走行中でも意味の取れる文にする。
 *
 * ⚠️ **403 と 429 はAPIキー導入で現実的になったもの**で、原因がURLからは
 * 判別できない。API Gateway は**キー違い・キー無し・未定義のパス**のいずれも
 * 403 で返すため、断定せず両方の可能性を示す（Backend/README.md）。
 */
function describeHttpError(status: number, serverError?: string): string {
  if (status === 403) {
    return "エラー: APIキーが違うか、未設定です（設定画面を確認してください）";
  }
  if (status === 429) {
    // Usage Plan の上限。日次クォータとレート制限のどちらかは区別できない。
    return "エラー: 利用上限に達しました。しばらく待ってからお試しください";
  }
  return "エラー: " + (serverError ?? `HTTP ${status}`);
}

// これ未満しか動いていなければ、方位はGPSの誤差でしかない。
// ⚠️ サーバー側の MIN_DISTANCE_METERS（Backend/src/lib/geo.py）と同じ値。
const MIN_DISTANCE_METERS = 5;

// これより古い位置は「いまの進行方向」の根拠にしない。
// 休憩を挟んでも直前の走行の方位が残り続けるのを防ぐ（信号待ちは残したいので2分）。
const MAX_HISTORY_AGE_MS = 2 * 60 * 1000;

// 起点として遡ってよい時間の上限。
// ⚠️ **方向転換への追従に効く。** 古い点を起点にすると「曲がる前の向き」が
// 出てしまうため、いまの向きの根拠は直近に限る。
//
// ⚠️ **距離で上限を切ってはいけない。** 速度で2点間の距離は大きく変わり
// （60km/hなら3秒で50m、100km/hなら83m）、距離を上限にすると
// 高速走行時に方位が出なくなる。時間なら速度に依存しない。
const MAX_ORIGIN_AGE_MS = 30 * 1000;

/** タイムスタンプ付きの位置。履歴を遡って方位を出すために時刻が要る。 */
type TrackedPoint = {
  coords: Location.LocationObjectCoords;
  timestamp: number;
};

// 16方位のラベル（北から時計回り）。
// ⚠️ Backend/src/lib/geo.py の _COMPASS_POINTS と同じ並び。
const COMPASS_POINTS = [
  "北", "北北東", "北東", "東北東",
  "東", "東南東", "南東", "南南東",
  "南", "南南西", "南西", "西南西",
  "西", "西北西", "北西", "北北西",
] as const;

/**
 * 2点間の方位（真北から時計回りの度数、0〜360）。
 *
 * ⚠️ **サーバー側（Backend/src/lib/geo.py）と同じ式を持つことになる。**
 * 本来は二重実装だが、ここでは**表示が目的**であり、
 * 画面の値とAIの回答がズレていないかの検算にもなる。
 * 質問に添えて送るのは変わらず座標2点で、**方位そのものは送らない**。
 */
function calculateBearing(
  from: Location.LocationObjectCoords,
  to: Location.LocationObjectCoords,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);
  const deltaLon = toRad(to.longitude - from.longitude);

  const x = Math.sin(deltaLon) * Math.cos(lat2);
  const y =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** 度数を16方位のラベルにする。 */
function bearingToCompass(bearing: number): string {
  return COMPASS_POINTS[Math.round(bearing / 22.5) % 16];
}

/** 2点間の距離（メートル）。判定用途なので簡易な近似で足りる。 */
function distanceMeters(
  a: Location.LocationObjectCoords,
  b: Location.LocationObjectCoords,
): number {
  const metersPerDegree = 111_000;
  const dLat = (a.latitude - b.latitude) * metersPerDegree;
  const dLon =
    (a.longitude - b.longitude) *
    metersPerDegree *
    Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * 進行方向の起点にする過去の位置を、履歴から選ぶ。
 *
 * 新しい方から遡り、現在地から MIN_DISTANCE_METERS 以上離れた最初の点を返す。
 * 直前の点が近すぎても（低速・信号待ち）、さらに前を辿れば方位が出せる。
 * **新しい順に見るのが肝**で、方向転換した直後は直近の点ほど
 * いまの向きに忠実（曲がる前の点を使うと転回前の方位が出る）。
 *
 * 見つからずに終わる条件は2つあり、どちらも方位なし（null）とする:
 *   - 直近に5m以上離れた点が無い → 止まっている
 *   - 見つかった点が古すぎる（30秒超）→ ゆっくり動いているか転回中で、
 *     いまの向きの根拠にできない
 *
 * ⚠️ **方向転換の直後は一時的に方位なしになる。これは意図した挙動。**
 * 曲がっている最中の「右手」は数秒で変わるので、出さない方が安全。
 * 直進が数秒続けば起点が見つかり、方位は自然に復活する。
 *
 * 見つかった点の添字も返す。**それより古い点は二度と使わないので捨てられる**。
 */
function findHeadingOrigin(
  history: TrackedPoint[],
  current: Location.LocationObjectCoords,
  now: number,
): { point: TrackedPoint; index: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    // 古い方へ向かって走査しているので、一度超えたらそれ以上は見なくてよい。
    if (now - point.timestamp > MAX_HISTORY_AGE_MS) return null;
    if (distanceMeters(current, point.coords) >= MIN_DISTANCE_METERS) {
      // 最初に条件を満たした＝いちばん新しい点。これが古いなら、
      // それより前はもっと古いので、探索を続ける意味は無い。
      return now - point.timestamp <= MAX_ORIGIN_AGE_MS
        ? { point, index: i }
        : null;
    }
  }
  return null;
}

export default function Index() {
  const [status, setStatus] = useState("位置情報を取得中…");
  const [coords, setCoords] = useState<Location.LocationObjectCoords | null>(
    null,
  );
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // 会話を続けるためのセッションID。サーバーが発行した値を保持して次回送る。
  // 要件は「一問一答＋α」で、アプリを再起動してまで続ける想定はないため
  // 端末に永続化はせずメモリ上だけで持つ（docs/00 の会話継続の方針）。
  // ref ではなく state にしているのは、値の有無で画面表示を変えるため。
  const [sessionId, setSessionId] = useState<string | null>(null);

  // 回答待ちのポーリングを止めるための旗。画面を離れたときやリセット時に立てる。
  // 立て忘れると裏でリクエストが回り続けるので、必ず止める側を用意する。
  const pollAbort = useRef(false);

  // 会話を始めた時刻。経過時間をサーバーに伝えるために持つ。
  // 走行中は質問ごとに場所が変わるので、AIが「さっきの山」を解釈するには
  // 「前の質問からどれだけ経ったか」が要る（docs/01b）。
  const conversationStartedAt = useRef<number | null>(null);

  // 進行方向を出すための位置履歴（US-2.03）。直近2分ぶんだけ持つ。
  // 1点だけだと低速時に「近すぎて方位が出せない」が続くため、履歴を遡る。
  // 送信時に最新値を確実に読む必要があるので ref で持つ（state はクロージャに
  // 古い値が残る）。画面表示用の判定結果は別途 state に出す。
  const historyRef = useRef<TrackedPoint[]>([]);

  // いまの進行方位（度）。出せないときは null。画面に出すためだけの値で、
  // サーバーに送るのはあくまで座標2点（方位はLambdaが計算し直す）。
  const [heading, setHeading] = useState<number | null>(null);

  // 端末に保存されたAPIキー（docs/01 §8）。未設定なら null。
  // ⚠️ 保管は expo-secure-store で、.env には置かない（src/api/apiKey.ts）。
  const [apiKey, setApiKey] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);

  // ⚠️ **録音中かどうかの判定は必ずこちらを見る。** state だけだと、
  // 自動送信のタイマーが「録音を始めたときのレンダー」の値を捕まえてしまい、
  // 30秒後には `recording === false` のまま止まる（＝**録音が止まらず、
  // 送信もされない**）。走行中に画面を見ずに復帰できない状態になる。
  // state の方は画面表示専用。
  const recordingRef = useRef(false);

  // 回答の読み上げ（US-2.02）。URLを差し替えて鳴らすだけなので、
  // プレイヤーは1つを使い回す。
  // ⚠️ 音声は署名付きURLで来る（数分で失効）。届いたらすぐ鳴らす。
  const player = useAudioPlayer(null);

  // 録音の押し忘れを止めるためのタイマー。走行中は画面を見ないので、
  // 上限に達したら自動で送信に回す。
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 録音を始めた時刻。⚠️ **短すぎる録音を弾く**ために使う
  // （インカムのボタンのチャタリング対策。adr/008）。
  const recordingStartedAt = useRef<number | null>(null);

  // ⚠️ **どのマイクで録ったか**（adr/010）。
  // 📌 **「インカムで録れているつもりが本体マイクだった」を二度と起こさない**ため、
  // 録音ごとに残す。⚠️ **実際これが無くて走行1回分を誤認した。**
  const micRouteRef = useRef<MicRoute | null>(null);

  // ⚠️ **インカムがあるのに経路を張れなかったときだけ**画面に出す。
  // 📌 **未接続（室内利用）では何も出さない** — **正常な使い方なので邪魔になる。**
  const [micWarning, setMicWarning] = useState<string | null>(null);
  // 自動送信までの残り秒数。⚠️ **走行中に画面を見る唯一の場面がここ。**
  // 「2回目を押さずに待つ」ときに**あと何秒かが分からないと待てない**
  // （押すべきか待つべきかを判断できない）。null なら録音していない。
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 録音の設定（設定画面で変えられる。src/api/recordingSettings.ts）。
  // ⚠️ **ref で持つ。** 上限タイマーは setTimeout の中で使うので、state だけだと
  // 「録音を始めたときのレンダー」の値をクロージャが captured したままになり、
  // 設定を変えても次の録音まで反映されない。表示用は下の state を使う。
  const settingsRef = useRef<RecordingSettings>(DEFAULT_RECORDING_SETTINGS);
  const [settings, setSettings] = useState<RecordingSettings>(
    DEFAULT_RECORDING_SETTINGS,
  );

  // 声で質問するための録音（US-2.01）。形式は M4A（src/api/voice.ts）。
  // ⚠️ **`audioSource` が設定で変わる**ので、保存済みの設定から組み立てる。
  // `useAudioRecorder` は options が変われば録音オブジェクトを作り直すため、
  // 設定画面で変えた値がそのまま効く（FINDINGS.md §12）。
  const recorder = useAudioRecorder(recordingOptions(settings));

  // ハンズフリー起動（US-2.04）。インカムのボタンを押すと、Bluetoothスタックが
  // 送る ACTION_VOICE_COMMAND を MainActivity（ネイティブ側）が deep link に
  // 読み替えてアプリを開く（`adr/006`）。⚠️ **「起動経路をつなぐだけ」**の
  // 方針どおり、ここでは既存の録音開始処理を呼ぶだけにする（`pre-research/handsfree/`）。
  const launchUrl = useURL();
  // ⚠️ **直近に処理したURLを覚えておく**（真偽値ではなく文字列で持つ）。
  // ネイティブ側はボタンを押すたびに異なるURL（`autoRecord=<時刻>`）を送るので、
  // 「このURLはもう処理した」を文字列比較で判定すれば、2回目以降のボタン押下でも
  // 正しく再発火する。apiKey未ロード等で開始できなかった場合は空のままにし、
  // 次のレンダーで再挑戦できるようにする。
  const autoRecordHandledUrl = useRef<string | null>(null);

  // この一往復がハンズフリー起動から始まったか（US-2.04）。
  // ⚠️ **回答後にマップへ戻すのは、この場合だけ。** 画面から自分で操作した
  // ときにも引っ込めると、**見ようとしている画面を勝手に隠す**ことになる
  // （停車中に設定を詰める・回答を読み返す、といった使い方を壊す）。
  const launchedHandsFree = useRef(false);

  // この一往復がハンズフリーだったか（⚠️ **`launchedHandsFree` とは別物**）。
  // あちらは「まだ戻していない」という意味で、**戻した時点で倒れる**。
  // 回答を待たずに戻すようになったため、**戻した後に起きる失敗**を
  // 読み上げで知らせる必要があり、そのための記録がこれ。
  const wasHandsFree = useRef(false);

  // 応答後に戻る先のアプリ（設定画面で選ぶ。src/api/returnApp.ts）。
  // ⚠️ **ref で持つ。** 戻す処理は非同期の完了後に走るので、state だけだと
  // 古いレンダーの値を掴みうる（vadRef と同じ理由）。
  const returnAppRef = useRef<string | null>(null);
  // 表示用。⚠️ **未設定だと「戻らない」が既定なので、黙っていると
  // 機能が壊れているのと見分けがつかない**（実際にそう見えた）。
  const [returnApp, setReturnApp] = useState<string | null>(null);

  // 設定画面から戻ってきたときに読み直す。
  // ⚠️ **useEffect(…, []) では足りない。** expo-router は戻ってきた画面を
  // 再マウントしないので、初回しか読まないとキーを保存した直後でも
  // 「未設定」のまま質問できない。
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const stored = await loadApiKey();
        if (!cancelled) setApiKey(stored);
      })();
      // 録音の設定も同じタイミングで読み直す。
      // ⚠️ **設定画面で変えた値が、戻った直後の録音から効くようにするため。**
      (async () => {
        const stored = await loadRecordingSettings();
        if (cancelled) return;
        settingsRef.current = stored;
        setSettings(stored);
      })();
      // 戻り先のアプリも同じタイミングで読み直す。
      (async () => {
        const stored = await loadReturnApp();
        if (cancelled) return;
        // ⚠️ **オフなら戻さない**（選択は残っていても使わない）。
        returnAppRef.current = stored.enabled ? stored.packageName : null;
        setReturnApp(stored.enabled ? stored.packageName : null);
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // Androidのナビゲーションバー（戻るボタン等）と最下部のボタンが重なって
  // 押せなくなるのを防ぐ。実機で発生した問題。
  const insets = useSafeAreaInsets();

  // 起動中は位置を監視し続ける（learning/05, 06）。
  // 1点だけでは「どちらを向いているか」が分からないため、US-2.03 では
  // getCurrentPositionAsync（1回だけ）ではなく watchPositionAsync を使う。
  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== "granted") {
        setStatus("位置情報の許可が得られませんでした");
        return;
      }
      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            // ⚠️ この2つは「どちらかを満たせば」ではなく、両方が制約になる。
            // timeInterval = 最短でもこの間隔を空ける（Android専用）
            // distanceInterval = これだけ動いたときにしかコールバックが来ない
            // → **停車中はコールバックが一切来ない。** 停車の検知は
            //   下の setInterval に頼っている（位置の更新では気づけない）。
            timeInterval: 3000,
            // 起点の判定が5m単位なので、位置もそれと同じ粒度で受け取る。
            // 10mだと低速時にコールバックの間隔が空きすぎ、履歴が粗くなって
            // 方向転換からの復帰が遅れる。
            distanceInterval: MIN_DISTANCE_METERS,
          },
          (location) => {
            if (cancelled) return;
            const now = location.timestamp ?? Date.now();

            // 2分より古い点は捨てる。捨てないと履歴が延々と伸びるうえ、
            // 古い点を根拠に「まだ動いている」と誤判定してしまう。
            const history = historyRef.current.filter(
              (p) => now - p.timestamp <= MAX_HISTORY_AGE_MS,
            );
            history.push({ coords: location.coords, timestamp: now });

            // 起点が決まったら、それより古い点は用途が無いので捨てる。
            // 走行中は毎回ここで刈られるので、履歴はごく短いまま保たれる。
            const origin = findHeadingOrigin(history, location.coords, now);
            historyRef.current = origin
              ? history.slice(origin.index)
              : history;

            setCoords(location.coords);
            setHeading(
              origin
                ? calculateBearing(origin.point.coords, location.coords)
                : null,
            );
            setStatus("取得できました");
          },
        );
      } catch (e) {
        setStatus("取得に失敗しました: " + String(e));
      }
    })();

    // 画面を離れるときに監視を止める（止めないとGPSが動き続けて電池を食う）。
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  // ⚠️ **停車の検知はここでしかできない。**
  // distanceInterval があるため、停車中はコールバックが呼ばれない
  // ＝位置の更新をきっかけにした判定では「止まった」ことに永久に気づけない。
  // 時間の経過だけを頼りに、定期的に判定をやり直す。
  useEffect(() => {
    const timer = setInterval(() => {
      const history = historyRef.current;
      const latest = history[history.length - 1];
      if (!latest) return;
      const origin = findHeadingOrigin(history, latest.coords, Date.now());
      setHeading(
        origin ? calculateBearing(origin.point.coords, latest.coords) : null,
      );
      // ここでは履歴を刈らない。停車が続くと最終的に2分で全部落ちるので、
      // 動き出したときに備えて残しておく。
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // 質問と現在地をバックエンドに送り、AIの回答を受け取る（US-1.01・1.03）
  async function askBackend() {
    if (!coords || !question.trim() || sending) return;
    if (!API_BASE_URL) {
      setAnswer("エラー: API URL が未設定です（.env を確認）");
      return;
    }
    // キーが無ければAPIは403を返すだけなので、手前で気づける形にする。
    if (!apiKey) {
      setAnswer("エラー: APIキーが未設定です（設定画面で入力してください）");
      return;
    }
    setSending(true);
    setAnswer(null);
    // 新しい質問を始めるので、前回の中断指示は解除する。
    pollAbort.current = false;
    try {
      // OpenAPIから生成した AskRequest 型で、送るデータの形が保証される。
      // end は過去の位置で、end→start の向きが進行方向になる（US-2.03）。
      // 送信の直前に履歴から選び直す（止まっていれば見つからず、方位なしで送る）。
      const origin = findHeadingOrigin(historyRef.current, coords, Date.now());
      // 会話の最初の質問なら経過時間は無い（サーバー側でも省略扱い）。
      const startedAt = conversationStartedAt.current;
      const requestBody: AskRequest = {
        question: question.trim(),
        start: { latitude: coords.latitude, longitude: coords.longitude },
        ...(startedAt !== null
          ? { elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }
          : {}),
        ...(origin
          ? {
              end: {
                latitude: origin.point.coords.latitude,
                longitude: origin.point.coords.longitude,
              },
            }
          : {}),
        // 前回のIDがあれば送る → 会話が続く。無ければサーバーが新規発行する。
        ...(sessionId ? { sessionId } : {}),
      };
      // ① 質問を出す。回答はここでは返らない（202 + requestId）。
      const res = await fetch(`${API_BASE_URL}/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [API_KEY_HEADER]: apiKey,
        },
        body: JSON.stringify(requestBody),
      });
      const data = (await res.json()) as AskAcceptedResponse & { error?: string };
      if (!res.ok) {
        setAnswer(describeHttpError(res.status, data.error));
        return;
      }
      // 次回のために発行されたIDを覚えておく（これが会話継続の要）
      setSessionId(data.sessionId);
      // 会話の起点は最初の質問が通った時刻。以降はここからの経過を送る。
      if (conversationStartedAt.current === null) {
        conversationStartedAt.current = Date.now();
      }
      setQuestion("");

      // ② 回答ができるまで取りに行く。
      // null は「中断された」= 画面を離れた/リセットされた。表示は変えない。
      const result = await pollForAnswer(data.requestId, apiKey);
      if (result !== null) {
        setAnswer(result.text);
        // 文字で聞いても音声は返る。走行中は画面を見ないので鳴らす。
        if (result.audioUrl) playAnswer(result.audioUrl);
        void returnToMapIfHandsFree();
      }
    } catch (e) {
      setAnswer("送信に失敗しました: " + String(e));
    } finally {
      setSending(false);
      // ⚠️ **この経路でも必ず倒す。** 残すと、あとで画面から質問して成功した
      // ときに `returnToMapIfHandsFree` が発火し、**見ている画面が勝手に
      // マップへ切り替わる**（ハンズフリー起動 → 失敗 → 画面で再質問、の順）。
      launchedHandsFree.current = false;
      wasHandsFree.current = false;
    }
  }

  /** いま送るべき位置情報を組み立てる（テキストと音声で同じものを送る）。 */
  function buildLocation(
    current: Location.LocationObjectCoords,
  ): VoiceLocation {
    const origin = findHeadingOrigin(historyRef.current, current, Date.now());
    const startedAt = conversationStartedAt.current;
    return {
      start: { latitude: current.latitude, longitude: current.longitude },
      ...(startedAt !== null
        ? { elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }
        : {}),
      ...(origin
        ? {
            end: {
              latitude: origin.point.coords.latitude,
              longitude: origin.point.coords.longitude,
            },
          }
        : {}),
    };
  }

  /**
   * 自動送信までの残り秒数を数える（adr/008・方式D）。
   *
   * ⚠️ **これが「あと何秒で送られるか」の唯一の手がかり。**
   * ボタンを押さずに待つときは、この数字を見て判断する。
   *
   * 📌 **1秒ごとで足りる**（秒単位でしか表示しないため）。
   */
  function startCountdown(totalMs: number) {
    stopCountdown();
    const startedAt = Date.now();
    // ⚠️ **最初の1秒を待たずに出す。** 待つと録音直後に空白ができ、
    // 走行中は「動いていない」と見分けがつかない。
    setRemainingSec(Math.ceil(totalMs / 1000));
    countdownTimer.current = setInterval(() => {
      const left = Math.ceil((totalMs - (Date.now() - startedAt)) / 1000);
      // ⚠️ **負の値を出さない。** 送信処理が走るまでの数百msで -1 が見える。
      setRemainingSec(left > 0 ? left : 0);
    }, 1_000);
  }

  function stopCountdown() {
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    setRemainingSec(null);
  }

  /**
   * 録音を始める（US-2.01）。
   *
   * ⚠️ **上限で自動的に止める。** 走行中は止める操作を忘れやすく、
   * 押し忘れれば上限まで録り続けて**質問ごと失われる**（src/api/voice.ts）。
   * 📌 **通常はインカムのボタンを押して終える**ので、この上限は押し忘れの受け皿。
   */
  async function startRecording(): Promise<boolean> {
    // ref で見る。連打されたときも、再レンダーを待たずに2度目を弾ける。
    if (recordingRef.current || sending) return false;
    if (!apiKey) {
      setAnswer("エラー: APIキーが未設定です（設定画面で入力してください）");
      return false;
    }
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setAnswer("エラー: マイクの許可が得られませんでした");
        return false;
      }
      // 録音中は他の音を止める。読み上げの途中で録り始めると自分の声に
      // 回答が被る。
      await setAudioModeAsync(AUDIO_MODE_RECORDING);
      // ⚠️ **録音を始める前にインカムの経路を張る**（adr/010）。
      // これが無いと本体マイクで録ってしまい、走行中は風とエンジン音に埋もれる。
      // ⚠️ **失敗しても止めない。** 走行中に録音が始まらない方が致命的なので、
      // 本体マイクで録って続行する（インカム未接続の室内利用も同じ経路）。
      const route = await acquireMicRoute();
      micRouteRef.current = route;
      console.log("[recording] mic:", describeMicRoute(route));
      // ⚠️ **「インカムはあるのに使えていない」ときだけ知らせる。**
      // **本体マイクで録ると走行中は風とエンジン音に埋もれる**ので、
      // 停車後に気づけるようにしておく（走行中は画面を見られない）。
      setMicWarning(
        route.kind === "builtin" && route.reason === "acquire-failed"
          ? "⚠️ インカムに接続できず、本体マイクで録音しています"
          : null,
      );
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      recordingStartedAt.current = Date.now();
      setRecording(true);
      setAnswer(null);
      recordingTimer.current = setTimeout(() => {
        // 上限に達した。⚠️ **必ず送る。**
        // 押し忘れかもしれないし、長い質問かもしれないが、
        // **どちらにせよ捨てると質問ごと失われる**（adr/008）。
        console.log("[recording] max reached -> send");
        void stopRecordingAndSend();
      }, settingsRef.current.maxRecordingMs);
      // 自動送信までの残り秒数を出す。⚠️ **上限タイマーと同じ値**を渡す。
      startCountdown(settingsRef.current.maxRecordingMs);
      return true;
    } catch (e) {
      recordingRef.current = false;
      recordingStartedAt.current = null;
      setRecording(false);
      // ⚠️ **上限タイマーを必ず消す。** 残すと、この失敗した録音のタイマーが
      // **次の録音の最中に発火して早すぎる送信を起こす**（開始に失敗 → すぐ
      // やり直した場合）。
      if (recordingTimer.current) {
        clearTimeout(recordingTimer.current);
        recordingTimer.current = null;
      }
      // 開始に失敗したらカウントダウンも残さない。
      stopCountdown();
      setAnswer("録音を開始できませんでした: " + String(e));
      return false;
    }
  }

  // ハンズフリー起動を受けて自動で録音を始める。
  // ⚠️ **位置情報とAPIキーの両方が揃うのを待つ。** どちらか欠けたまま
  // startRecording を呼んでもエラーで無音に終わるだけ（画面を見ない前提なので
  // 気づけない）。coords・apiKey は非同期に届くので、揃うまで「未処理」の
  // ままにしておき、揃った時点のレンダーで自然に再評価させる
  // （`autoRecordHandledUrl` を先に確定させない）。
  useEffect(() => {
    if (!launchUrl || !coords || !apiKey) return;
    if (autoRecordHandledUrl.current === launchUrl) return;
    if (!parseUrl(launchUrl).queryParams?.autoRecord) return;
    autoRecordHandledUrl.current = launchUrl;
    // ⚠️ **この行が届くこと自体が方式Cの検証になる**（FINDINGS.md §16）。
    // マイクを掴んでいる最中に Bluetooth スタックが VOICE_COMMAND を
    // 送るかは端末・インカム側の挙動で、コードからは判断できない。
    console.log(
      `[handsfree] VOICE_COMMAND received: recording=${recordingRef.current} ` +
        `sending=${sending} url=${launchUrl}`,
    );
    void (async () => {
      // 方式C: **録音中にもう一度押されたら「話し終えた」とみなして送る**
      // （US-2.04の終了側。⚠️ **音量では終話を判定できない**ので、
      // 音を一切見ないこの経路で終える。adr/008）。
      // ⚠️ **startRecording より前に見る。** あちらは `recordingRef` で
      // 弾くので、ここを通さないと「いま応答中です」と読み上げてしまう。
      if (recordingRef.current) {
        // ⚠️ **短すぎる録音は送らない。** インカムのボタンのチャタリングや、
        // 起動の押下が二重に届いた場合に**空の録音を送ってしまう**
        // （課金されるうえ、意味不明な回答が返る）。
        // 📌 **押し直しは弾かれるだけ**なので、上限（方式D）で必ず送られる。
        const elapsed = Date.now() - (recordingStartedAt.current ?? 0);
        if (elapsed < MIN_RECORDING_MS) {
          console.log(`[handsfree] second press too soon (${elapsed}ms) -> ignore`);
          return;
        }
        console.log(`[handsfree] second press while recording (${elapsed}ms) -> send`);
        // ⚠️ **ハンズフリーの印は倒さない。** この一往復は最初の押下から
        // 続いているので、`launchedHandsFree` / `wasHandsFree` は
        // 立ったままにして、回答後にマップへ戻す経路を保つ。
        void stopRecordingAndSend();
        return;
      }
      // ⚠️ **応答待ちの最中にも押されうる。** その場合 startRecording は
      // `sending` で弾かれるので、**先に前の質問を捨ててはいけない**
      // （捨てたうえに録音も始まらず、押しても完全に無反応になる）。
      const started = await startRecording();
      if (!started) {
        // ⚠️ **黙って諦めない。** 走行中は画面を見ないので、無反応だと
        // 「押せていない」のか「壊れた」のか区別がつかない。
        console.log("[handsfree] could not start recording (busy or no key)");
        Speech.speak("いま応答中です。少し待ってからもう一度お話しください。", {
          language: "ja-JP",
        });
        return;
      }
      // ⚠️ **録音が始まってから前の質問を捨てる。** 順序を逆にすると、
      // 上の早期returnの経路で**前の回答だけが失われる。**
      // 残すと、新しく話し終えたときに**前の質問の答えが返ってくる**
      // （実機で発生した。FINDINGS.md §13.8）。
      pollAbort.current = true;
      // この一往復の出口は「マップへ戻る」。画面操作で始めたときと区別する。
      launchedHandsFree.current = true;
      wasHandsFree.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchUrl, coords, apiKey]);

  /**
   * 録音を送らずに捨てる。
   *
   * ⚠️ **マイクと音声モードを必ず戻す。** 録音したまま放置すると、
   * マイクを掴み続けるうえ**音声モードが録音向きのままになり、
   * 以降の読み上げが鳴らなくなる**（Androidで顕著）。
   * リセットと画面離脱の両方から呼ぶ。
   */
  function discardRecording() {
    if (recordingTimer.current) {
      clearTimeout(recordingTimer.current);
      recordingTimer.current = null;
    }
    // ⚠️ **早期returnより前に止める。** 録音フラグが既に下りていても
    // カウントダウンだけ残っていることがある。
    stopCountdown();
    if (!recordingRef.current) return;
    recordingRef.current = false;
    recordingStartedAt.current = null;
    setRecording(false);
    // 後片付けなので、失敗しても伝える相手がいない（画面を離れている）。
    void (async () => {
      try {
        await recorder.stop();
        await releaseMicRoute();
        await setAudioModeAsync(AUDIO_MODE_PLAYBACK);
      } catch (e) {
        // ⚠️ **止められなくても音声モードだけは必ず戻す。**
        // ここで諦めると録音向きのモードが残り、**以降の読み上げが鳴らない**。
        // 走行中は画面を見ないので、無音になった理由に気づけない。
        console.warn("failed to discard the recording", e);
        try {
          await releaseMicRoute();
          await setAudioModeAsync(AUDIO_MODE_PLAYBACK);
        } catch {
          // ここまで失敗したら打つ手が無い。次の録音開始時に再度試みる。
        }
      }
    })();
  }

  /**
   * 設定画面へ移る。
   *
   * ⚠️ **移る前に録音を捨てる。** `router.push` ではこの画面が
   * **アンマウントされない**ので、後片付けの useEffect が走らない。
   * 録音したまま移ると、①マイクを掴んだままになり、設定画面の音量測定が
   * 開始できない ②裏で上限に達して**設定画面にいる間に送信される**
   * ③双方が `setAudioModeAsync`（プロセス全体に効く）を奪い合う。
   */
  function openSettings() {
    discardRecording();
    // 画面を操作しに来た＝もうハンズフリーの一往復ではない。
    // ⚠️ 倒さないと、設定から戻ったあとの回答で勝手に引っ込む。
    launchedHandsFree.current = false;
    wasHandsFree.current = false;
    router.push("/settings");
  }

  /** 録音を止めて送る。停止と送信を分けない（走行中の操作を1つに保つ）。 */
  async function stopRecordingAndSend() {
    // ⚠️ ref で見る（上記参照）。state を見ると自動送信が素通りする。
    // インカムのボタン再押し・上限タイマー・画面のボタンの3経路から呼ばれるが、
    // **最初の1回だけが通る**（ここで ref を倒すため二重送信にならない）。
    if (!recordingRef.current) return;
    recordingRef.current = false;
    recordingStartedAt.current = null;
    if (recordingTimer.current) {
      clearTimeout(recordingTimer.current);
      recordingTimer.current = null;
    }
    stopCountdown();
    setRecording(false);

    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
      // ⚠️ **経路を必ず解放する。** 立てっぱなしだと通話用のモードが残り、
      // **読み上げが通話経路に流れる**（adr/010）。
      await releaseMicRoute();
      // 録り終えたら再生できる状態に戻す（読み上げがここで鳴る）。
      await setAudioModeAsync(AUDIO_MODE_PLAYBACK);
    } catch (e) {
      // ⚠️ **失敗しても音声モードは戻す。** 録音向きのまま残すと
      // **以降の読み上げが鳴らなくなり**、走行中はその理由に気づけない。
      try {
        await releaseMicRoute();
        await setAudioModeAsync(AUDIO_MODE_PLAYBACK);
      } catch {
        // ここまで失敗したら打つ手が無い。
      }
      setAnswer("録音を停止できませんでした: " + String(e));
      // ⚠️ この2つの return は下の finally を通らないので、ここで倒す
      // （残すと、次に画面から操作したときに勝手に引っ込む）。
      launchedHandsFree.current = false;
      return;
    }
    if (!uri || !coords || !apiKey || !API_BASE_URL) {
      setAnswer("エラー: 録音を送信できませんでした");
      launchedHandsFree.current = false;
      return;
    }

    setSending(true);
    pollAbort.current = false;
    try {
      const accepted = await sendVoiceQuestion(
        API_BASE_URL,
        apiKey,
        uri,
        buildLocation(coords),
        sessionId,
      );
      if (accepted.httpStatus !== 202) {
        // ⚠️ 413 は録音が長すぎたとき。走行中に意味が取れる言葉にする。
        setAnswer(
          accepted.httpStatus === 413
            ? "エラー: 録音が長すぎます。短く話してください"
            : describeHttpError(accepted.httpStatus, accepted.error),
        );
        return;
      }
      setSessionId(accepted.sessionId);
      if (conversationStartedAt.current === null) {
        conversationStartedAt.current = Date.now();
      }
      // ⚠️ **回答を待ってから戻す。前倒しは実機で破綻した（2026-08-21）。**
      // 送信できた時点で戻すと**その分ナビが早く見える**が、背面に回った
      // 本アプリは Android に**キャッシュプロセス**へ落とされ（oom_adj=700・
      // state=LAST を実機で確認）、**JSが凍結してポーリングが止まる。**
      // 症状は「初回の回答が来ず、次にボタンを押すと前回の答えが返る」。
      // ⚠️ **フォアグラウンドサービスを持たない限り、背面では待てない**
      // （pre-research/handsfree/FINDINGS.md §13.8）。
      const result = await pollForAnswer(accepted.requestId, apiKey);
      if (result !== null) {
        setAnswer(result.text);
        if (result.audioUrl) playAnswer(result.audioUrl);
        // 回答が届いた。⚠️ **読み上げの完了は待たない**（背面で鳴り続ける）。
        void returnToMapIfHandsFree();
        // ⚠️ **音声が無いまま終わることがある**（合成に失敗した場合）。
        // 黙ると「何も起きなかった」と区別がつかないので、本文を読み上げる。
        if (!result.audioUrl) announceIfHandsFree(result.text);
      } else {
        announceIfHandsFree("回答を取得できませんでした。もう一度お話しください。");
      }
    } catch (e) {
      setAnswer("送信に失敗しました: " + String(e));
      announceIfHandsFree("送信に失敗しました。もう一度お話しください。");
    } finally {
      setSending(false);
      // ⚠️ **エラーで終わったときは戻らない**（読み上げるものが無く、画面に出た
      // エラーだけが手がかりなので、隠すと何も分からなくなる）。
      // ただし**フラグは倒す。** 残すと、次に画面から操作したときに勝手に引っ込む。
      launchedHandsFree.current = false;
      // ⚠️ **一往復はここで終わり。** 倒さないと、次に画面から操作して失敗した
      // ときに「画面を見ているのに読み上げる」ことになる。
      // 📌 `announceIfHandsFree` はこの手前で呼び終わっているので順序は問題ない。
      wasHandsFree.current = false;
    }
  }

  /**
   * ハンズフリー中だけ、端末内蔵TTSで読み上げて知らせる。
   *
   * ⚠️ **回答を待たずにマップへ戻るようになったので、失敗を画面に出しても
   * 見えない。** 走行中に無反応だと「アプリが落ちた」「ボタンを押せていない」と
   * 区別がつかず、結局画面を見に行くことになる（＝ハンズフリーの趣旨に反する）。
   *
   * ⚠️ **Pollyではなく `expo-speech` を使う**（騒音ガードの通知と同じ理由。
   * AWSに行く必要が無く、**電波が切れている場面でこそ鳴らしたい**）。
   */
  function announceIfHandsFree(message: string) {
    // 画面を見ながら操作しているなら、画面に出ているので読み上げない。
    if (!wasHandsFree.current) return;
    try {
      Speech.speak(message, { language: "ja-JP" });
    } catch (e) {
      console.warn("failed to announce", e);
    }
  }

  /**
   * 回答を読み上げる（US-2.02）。
   *
   * ⚠️ **失敗しても黙って諦める。** 回答そのものは画面に出ているので、
   * 鳴らないことを理由にエラーで上書きすると、読める答えまで消えてしまう。
   */
  function playAnswer(audioUrl: string) {
    try {
      player.replace({ uri: audioUrl });
      player.play();
    } catch (e) {
      console.warn("failed to play the answer", e);
    }
  }

  /**
   * ハンズフリー起動だったら、マップアプリを前面に戻す（US-2.04）。
   *
   * ⚠️ **読み上げより先に戻す。** 回答が届いた時点で戻し、**背面で鳴らし続ける**
   * のが要件（読み上げ終わりを待つと、その間ナビが見えない）。これが成り立つのは
   * `setAudioModeAsync({ shouldPlayInBackground: true })` を先に入れてあるため。
   * ⚠️ **入れ忘れると `expo-audio` は背面に回った瞬間に再生を止める**
   * （AudioModule.kt の `OnActivityEntersBackground`）。
   *
   * ⚠️ **`moveTaskToBack` は使わない。** 自分のタスクを下げるだけで
   * **ホーム画面に落ちる**と実機で確定した（FINDINGS.md §13.4）。
   * 代わりに**戻り先アプリを開く**。⚠️ これは起動し直しではなく
   * **既存タスクの再開**なので、案内中のルートは壊れない（同 §13.5）。
   *
   * ⚠️ **一度戻したらフラグを倒す。** 倒さないと、次に画面から操作したときにも
   * 勝手に引っ込む。次のハンズフリー起動でまた立つ。
   */
  async function returnToMapIfHandsFree() {
    if (!launchedHandsFree.current) return;
    launchedHandsFree.current = false;

    // 未設定なら何もしない。⚠️ **勝手にどこかへ飛ばさない**（src/api/returnApp.ts）。
    // ⚠️ **黙って諦めない。** 既定が「戻らない」なので、設定し忘れると
    // **機能が壊れているのと見分けがつかない**（実際にそう見えた）。
    const packageName = returnAppRef.current;
    if (!packageName) {
      console.log("[handsfree] no return app configured; staying in the app");
      return;
    }

    try {
      const launched = await AppForeground.launchApp(packageName);
      // ⚠️ **false を黙って捨てない。** 戻れないと画面が残るが、走行中は
      // 見ていないので気づけない。実機では `adb logcat | grep handsfree` で追える。
      // ⚠️ **true でも戻ったとは限らない。** アプリが既に背面にある状態で
      // 呼ぶと、Android 10+ は起動を黙って無視する（例外も出ず成功扱い）。
      console.log(`[handsfree] launchApp(${packageName}) returned ${launched}`);
    } catch (e) {
      // 戻れなくても回答は鳴っている。ここで止める理由はない。
      console.warn("failed to return to the map app", e);
    }
  }

  /**
   * 回答ができるまで GET /ask/{id} を叩く。
   *
   * ⚠️ **必ず止まる**ことが重要（docs/01a）:
   *   - done / error になったら止める
   *   - 80秒で打ち切る
   *   - 画面を離れたら止める（pollAbort が立つ）
   *
   * 戻り値が null なら中断された、という意味。空文字と区別する必要がある
   * （空文字だと「回答なし」として画面が無反応に見える）。
   *
   * ⚠️ **APIキーは引数で受け取る**（state を直接読まない）。待っている間に
   * 設定画面でキーが変わっても、この回答は始めたときのキーで取りに行く。
   *
   * `audioUrl` は音声で聞いたときだけ付く（合成に失敗すると付かないので、
   * **無くても回答は成立する**）。
   */
  async function pollForAnswer(
    requestId: string,
    key: string,
  ): Promise<{ text: string; audioUrl?: string } | null> {
    const startedAt = Date.now();

    for (;;) {
      const elapsed = Date.now() - startedAt;
      const interval = nextPollInterval(elapsed);
      if (interval === null) {
        return {
          text: "時間がかかりすぎたため中断しました。もう一度お試しください。",
        };
      }
      await sleep(interval);
      // 待っている間に画面を離れた／リセットされたら、そこで諦める。
      if (pollAbort.current) return null;

      let result: AskResultResponse & { error?: string };
      try {
        const res = await fetch(`${API_BASE_URL}/ask/${requestId}`, {
          headers: { [API_KEY_HEADER]: key },
        });
        result = (await res.json()) as AskResultResponse & { error?: string };
        if (!res.ok) {
          // ⚠️ 429 はここでは諦めない。ポーリングは秒間1回叩くので
          // 一時的にレート上限に触れることがあり、次の周回で通る。
          if (res.status === 429) continue;
          return { text: describeHttpError(res.status, result.error) };
        }
      } catch (e) {
        // 走行中は電波が切れることがある。1回の失敗では諦めず、
        // 打ち切り時間まで試し続ける。
        continue;
      }

      if (result.status === "done") {
        return { text: result.answer ?? "", audioUrl: result.audioUrl };
      }
      if (result.status === "error") {
        return { text: "エラー: " + (result.error ?? "回答できませんでした") };
      }
      // pending ならもう一周
    }
  }

  // 会話をリセットする。IDを捨てれば次の質問から新しい会話になる。
  function resetConversation() {
    setSessionId(null);
    setAnswer(null);
    setQuestion("");
    // 会話が変わるので経過時間の起点も捨てる（次の質問がまた「最初」になる）。
    conversationStartedAt.current = null;
    // 待っている途中でリセットされたら、その回答はもう要らない。
    pollAbort.current = true;
    // 手で操作した時点でハンズフリーの一往復は終わり（上記 openSettings と同じ）。
    launchedHandsFree.current = false;
    wasHandsFree.current = false;
    // ⚠️ 録音中のリセットも起こりうる。捨てないとマイクを掴んだままになり、
    // タイマーが「捨てたはずの会話」に送信してしまう。
    discardRecording();
    // 読み上げの途中なら止める（新しい会話に前の回答が被る）。
    try {
      player.pause();
    } catch {
      // 何も鳴っていなければ失敗しうる。捨ててよい。
    }
  }

  // 画面を離れるときにポーリングを止める（放置すると裏で叩き続ける）。
  // ⚠️ **録音も一緒に捨てる。** タイマーを止めるだけでは足りず、
  // マイクを掴んだまま・音声モードが録音向きのまま残る。
  //
  // ⚠️ discardRecording は毎レンダー作り直されるが、依存配列は空のままでよい。
  // 参照するのはすべて ref で、初回のクロージャでも最新の値を読むため。
  // （依存に入れると、レンダーのたびに後片付けが走ってしまう）
  useEffect(() => {
    return () => {
      pollAbort.current = true;
      discardRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        // 端末のナビゲーションバーの高さぶん余白を足す（最低24）。
        { paddingBottom: Math.max(insets.bottom, 24) + 24 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {/* 実機で更新が反映されたかを確かめるための表示（走行中には使わない） */}
      <Text style={styles.version}>v{APP_VERSION}</Text>

      <Text style={styles.status}>{status}</Text>

      {/* キーが無いと質問できないので、その場合だけ目立たせて設定へ促す。
          ⚠️ **設定済みでもボタンのまま置く。** ツーリング中に停車して開く
          ことがあり、⚠️ **小さなリンクだと手袋のまま押せない。** */}
      {apiKey === null ? (
        <Pressable
          style={styles.setupBanner}
          onPress={openSettings}
        >
          <Text style={styles.setupBannerText}>
            APIキーが未設定です。タップして設定してください
          </Text>
        </Pressable>
      ) : (
        <Pressable style={styles.settingsButton} onPress={openSettings}>
          <Text style={styles.settingsButtonText}>
            {/* ⚠️ 応答後に戻るアプリは既定が「戻らない」。設定し忘れていると
                ハンズフリーが完結しないので、ここで分かるようにする。 */}
            {returnApp === null ? "⚙ 設定（戻るアプリが未設定）" : "⚙ 設定"}
          </Text>
        </Pressable>
      )}

      {coords && (
        <View style={styles.card}>
          <Text style={styles.label}>緯度</Text>
          <Text style={styles.value}>{coords.latitude}</Text>
          <Text style={styles.label}>経度</Text>
          <Text style={styles.value}>{coords.longitude}</Text>
          {/* 進行方位の確認用（US-2.03）。矢印が進行方向を指す。
              停車中・転回直後は出ない（それが正しい挙動）。 */}
          {heading !== null ? (
            <View style={styles.compass}>
              <Text
                style={[
                  styles.compassNeedle,
                  // 北を上として、方位のぶんだけ矢印を回す。
                  { transform: [{ rotate: `${heading}deg` }] },
                ]}
              >
                ↑
              </Text>
              <Text style={styles.compassLabel}>
                {bearingToCompass(heading)} {Math.round(heading)}°
              </Text>
              <Text style={styles.note}>
                右手: {bearingToCompass((heading + 90) % 360)} / 左手:{" "}
                {bearingToCompass((heading + 270) % 360)}
              </Text>
            </View>
          ) : (
            <Text style={styles.note}>進行方向: まだ出せません（停車中など）</Text>
          )}
        </View>
      )}

      {/* 声で質問する（US-2.01）。⚠️ **これが本命の入口。**
          走行中は画面を見ないので、他のどれより大きく、単独で押せる位置に置く。
          止め忘れても上限で自動的に送られる（src/api/voice.ts）。 */}
      {coords && (
        <View style={styles.voiceArea}>
          <Pressable
            style={[
              styles.voiceButton,
              recording && styles.voiceButtonRecording,
              sending && styles.voiceButtonDisabled,
            ]}
            onPress={recording ? stopRecordingAndSend : startRecording}
            disabled={sending}
          >
            <Text style={styles.voiceButtonText}>
              {recording ? "■ 押すと送信します" : "🎤 押して話す"}
            </Text>
          </Pressable>
          {recording && (
            <>
              {/* ⚠️ **走行中に見る唯一の表示。** 「2回目を押さずに待つ」ときに
                  **あと何秒かが分からないと、押すべきか待つべきか判断できない。**
                  📌 **他の何より大きく出す**（一瞬の視線で読めることが要件）。 */}
              <Text style={styles.countdown}>
                {remainingSec === null ? "—" : `あと ${remainingSec} 秒`}
              </Text>
              {/* ⚠️ **秒数はカウントダウンが出しているので、ここでは繰り返さない。**
                  以前この行に上限の秒数を書こうとして「0秒」と出す誤りを入れた
                  （固定の文字列を置いてしまった）。**同じ値を2箇所に書かない。** */}
              <Text style={styles.recordingNote}>
                インカムのボタンをもう一度押すと、すぐ送信します
              </Text>
              {/* ⚠️ **異常なときだけ出る**（インカム未接続では出さない）。 */}
              {micWarning && (
                <Text style={styles.micWarning}>{micWarning}</Text>
              )}
            </>
          )}
        </View>
      )}

      {coords && (
        <View style={styles.askArea}>
          <TextInput
            style={styles.input}
            value={question}
            onChangeText={setQuestion}
            placeholder="例: 右手に見える山は何ですか？"
            placeholderTextColor="#888899"
            multiline
            maxLength={500}
            editable={!sending}
            onSubmitEditing={askBackend}
          />
          <Pressable
            style={[
              styles.button,
              (sending || !question.trim()) && styles.buttonDisabled,
            ]}
            onPress={askBackend}
            disabled={sending || !question.trim()}
          >
            <Text style={styles.buttonText}>
              {sending ? "考えています…" : "質問する"}
            </Text>
          </Pressable>
          {/* 初回はコンテナ起動で10秒前後かかる（pre-research/voice/ §6）。
              回答ができるまで裏で取りに行っている（docs/01a）。 */}
          {sending && (
            <Text style={styles.note}>
              回答を待っています（最初の質問は10秒ほど）
            </Text>
          )}
        </View>
      )}

      {answer && (
        <View style={styles.answerCard}>
          <Text style={styles.label}>回答</Text>
          <Text style={styles.answer}>{answer}</Text>
        </View>
      )}

      {/* US-1.05。走行中は画面を一瞬見るだけなので、リンクではなくボタンにする。
          会話中であることも併せて示す（黙って文脈が続くと混乱するため）。 */}
      {sessionId && (
        <View style={styles.resetArea}>
          <Text style={styles.sessionNote}>会話が続いています</Text>
          <Pressable
            style={[styles.resetButton, sending && styles.resetButtonDisabled]}
            onPress={resetConversation}
            disabled={sending}
          >
            <Text style={styles.resetButtonText}>新しい会話を始める</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1E1E2E",
    padding: 24,
    gap: 20,
  },
  status: { fontSize: 16, color: "#FFFFFF" },
  // 開発用の表示なので目立たせない。
  version: { fontSize: 11, color: "#666677" },
  // キー未設定は質問が一切通らない状態なので、警告色で目立たせる。
  setupBanner: {
    alignSelf: "stretch",
    backgroundColor: "#4A2A1E",
    borderWidth: 1,
    borderColor: "#FF6B35",
    padding: 14,
    borderRadius: 8,
  },
  setupBannerText: { color: "#FF9E7A", fontSize: 14, textAlign: "center" },
  /**
   * 設定ボタン。⚠️ **13pxのリンクだったが、停車中に押せないことがあった。**
   * 📌 **手袋のまま押せる大きさ**にする（走行はしないが、路肩で触る）。
   */
  settingsButton: {
    borderWidth: 2,
    borderColor: "#888899",
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  settingsButtonText: { color: "#CCCCDD", fontSize: 18, fontWeight: "bold" },
  compass: { alignItems: "center", marginTop: 12, gap: 2 },
  // 矢印そのものを回して進行方向を指す。
  compassNeedle: { fontSize: 34, color: "#FF6B35", lineHeight: 38 },
  compassLabel: { fontSize: 18, fontWeight: "bold", color: "#FFFFFF" },
  card: {
    backgroundColor: "#2A2A3E",
    padding: 20,
    borderRadius: 8,
    alignItems: "center",
    gap: 4,
  },
  label: { fontSize: 13, color: "#AAAAAA", marginTop: 8 },
  value: { fontSize: 20, fontWeight: "bold", color: "#FF6B35" },
  voiceArea: { alignSelf: "stretch", alignItems: "center", gap: 8 },
  // ⚠️ 走行中はこれを見ずに押す。指の当たる面積を大きく取る。
  voiceButton: {
    alignSelf: "stretch",
    backgroundColor: "#FF6B35",
    paddingVertical: 28,
    borderRadius: 12,
    alignItems: "center",
  },
  // 録音中は色を変える。画面を一瞬見たときに状態が分かるように。
  voiceButtonRecording: { backgroundColor: "#C0392B" },
  voiceButtonDisabled: { backgroundColor: "#8A5A44" },
  voiceButtonText: { color: "#FFFFFF", fontSize: 22, fontWeight: "bold" },
  /**
   * 自動送信までの残り秒数（adr/008・方式D）。
   *
   * ⚠️ **走行中に一瞬の視線で読めることが要件**なので、
   * **画面で最も大きい文字**にする（ボタンの文字が22px）。
   */
  countdown: {
    fontSize: 56,
    fontWeight: "bold",
    color: "#FFFFFF",
    // 等幅にして桁が変わっても位置が動かないようにする（読み取りが速い）。
    fontVariant: ["tabular-nums"],
  },
  recordingNote: { fontSize: 13, color: "#FF9E7A", textAlign: "center" },
  // ⚠️ **異常時だけ出る警告。** 走行中は読めないので、停車後に気づくためのもの。
  micWarning: { fontSize: 13, color: "#FFD166", textAlign: "center" },
  askArea: { alignSelf: "stretch", alignItems: "center", gap: 12 },
  input: {
    alignSelf: "stretch",
    backgroundColor: "#2A2A3E",
    color: "#FFFFFF",
    fontSize: 16,
    padding: 14,
    borderRadius: 8,
    minHeight: 72,
    textAlignVertical: "top",
  },
  note: { fontSize: 12, color: "#AAAAAA" },
  resetArea: { alignItems: "center", gap: 8 },
  sessionNote: { fontSize: 13, color: "#7FD1AE" },
  resetButton: {
    // Outlined rather than filled, so it does not compete with 「質問する」.
    // ⚠️ Sized for gloved taps at a roadside stop, like the settings button.
    borderWidth: 2,
    borderColor: "#FF6B35",
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  resetButtonDisabled: { borderColor: "#8A5A44" },
  resetButtonText: { color: "#FF6B35", fontSize: 18, fontWeight: "bold" },
  button: {
    backgroundColor: "#FF6B35",
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  buttonDisabled: { backgroundColor: "#8A5A44" },
  buttonText: { color: "#FFFFFF", fontSize: 18, fontWeight: "bold" },
  answerCard: {
    backgroundColor: "#2A2A3E",
    padding: 20,
    borderRadius: 8,
    alignSelf: "stretch",
  },
  answer: { fontSize: 16, color: "#FFFFFF", marginTop: 6 },
});
