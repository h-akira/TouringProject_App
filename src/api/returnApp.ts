/**
 * 応答後に戻る先のアプリ（US-2.04・[adr/007](../../../adr/007_return_to_map_after_answer.md)）。
 *
 * ⚠️ **なぜ設定が要るか。** 「直前に見ていたアプリ」をアプリ側から知る手段が無い
 * （他アプリの前面判定は Android 5 以降塞がれている）。
 * また `moveTaskToBack` では**ホーム画面に落ちるだけ**で戻らないことが
 * 実機で確定した（`pre-research/handsfree/FINDINGS.md` §13.4）。
 * そのため**戻り先は利用者に選んでもらう。**
 *
 * ⚠️ **秘密ではないので AsyncStorage に置く**（`expo-secure-store` はAPIキー用）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 戻るかどうか（オン/オフ）。
 *
 * ⚠️ **選んだアプリとは別に持つ。** ひとつの値で「戻らない＝null」を表すと、
 * **一時的に切っただけで選択が消え**、戻したいときに大量のアプリから
 * 選び直すことになる。**オフにしても選択は残す。**
 */
const ENABLED_KEY = "touring.returnApp.enabled";

/** 戻り先のパッケージ名。⚠️ **オフでも消さない**（上記の理由）。 */
const PACKAGE_KEY = "touring.returnApp";

/**
 * 最近選んだパッケージ名（新しい順）。
 *
 * ⚠️ **一覧のアプリが多すぎて目的のものを探せない**ため、
 * **選んだことのあるものを上位に出す**。お気に入りの手動登録は作らない
 * （★を付ける操作自体が「多すぎる一覧から探す」作業になるため）。
 */
const RECENT_KEY = "touring.returnApp.recent";

/** 上位に出す「最近選んだもの」の数。⚠️ 多いと結局スクロールになる。 */
const RECENT_LIMIT = 5;

/** 戻り先に選べるアプリ。ネイティブ側の `listLaunchableApps` が返す形。 */
export type LaunchableApp = {
  packageName: string;
  label: string;
};

export type ReturnAppSettings = {
  /** 応答後にアプリへ戻るか。⚠️ **既定は false**（勝手にどこかへ飛ばさない）。 */
  enabled: boolean;
  /** 戻り先。`null` は「まだ選んでいない」。⚠️ **`enabled` とは独立**。 */
  packageName: string | null;
  /** 最近選んだパッケージ名（新しい順）。一覧の並べ替えに使う。 */
  recent: string[];
};

/**
 * 保存された設定を読む。
 *
 * ⚠️ **既定は「戻らない」。** 勝手にどこかへ飛ばすより、
 * 何も起きない方が利用者に説明がつくため。
 */
export async function loadReturnApp(): Promise<ReturnAppSettings> {
  try {
    const [enabled, packageName, recent] = await Promise.all([
      AsyncStorage.getItem(ENABLED_KEY),
      AsyncStorage.getItem(PACKAGE_KEY),
      AsyncStorage.getItem(RECENT_KEY),
    ]);
    return {
      // ⚠️ **旧版からの移行**: `enabled` が無い端末では、
      // **アプリが選ばれていること自体をオンとみなす**
      // （旧版は「選んである＝戻る」だったため、そのまま動き続ける）。
      enabled: enabled === null ? packageName !== null : enabled === "true",
      packageName,
      recent: parseRecent(recent),
    };
  } catch {
    // 読めなければ「戻らない」に倒す（勝手に別のアプリを開かない）。
    return { enabled: false, packageName: null, recent: [] };
  }
}

/** 保存された `recent` を配列に戻す。⚠️ **壊れていても落とさない。** */
function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** 戻るかどうかを切り替える。⚠️ **選んだアプリには触らない。** */
export async function saveReturnAppEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, String(enabled));
}

/**
 * 戻り先のアプリを保存し、「最近選んだもの」の先頭に入れる。
 *
 * 📌 **選んだ時点で「戻る」を立てる。** アプリをわざわざ選ぶのは
 * **戻りたいから**であって、選んだうえでオフのままにする意味が無い。
 *
 * @returns 更新後の「最近選んだもの」
 */
export async function saveReturnApp(packageName: string): Promise<string[]> {
  // 重複を除いて先頭へ。⚠️ **同じものを選び直したときに増やさない。**
  const { recent } = await loadReturnApp();
  const next = [packageName, ...recent.filter((p) => p !== packageName)].slice(
    0,
    RECENT_LIMIT,
  );
  await Promise.all([
    AsyncStorage.setItem(PACKAGE_KEY, packageName),
    AsyncStorage.setItem(ENABLED_KEY, "true"),
    AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next)),
  ]);
  return next;
}

/**
 * 「最近選んだもの」から1件だけ消す。
 *
 * ⚠️ **誤操作で選んでしまったものが残り続ける。** 一覧の上位は
 * **探す手間を減らすための場所**なので、要らないものが居座ると逆効果になる。
 *
 * 📌 **いま戻り先に選んでいるアプリでも消せる。**
 * 「最近選んだもの」は**一覧の並び順の話**であって、選択そのものではない
 * （消しても戻り先の設定は変わらない）。
 *
 * @returns 更新後の「最近選んだもの」
 */
export async function removeRecentApp(packageName: string): Promise<string[]> {
  const { recent } = await loadReturnApp();
  const next = recent.filter((p) => p !== packageName);
  await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

/**
 * 一覧を「最近選んだものが先」に並べ替え、必要なら名前で絞り込む。
 *
 * ⚠️ **インストール済みアプリは数が多く、目的のものを探せない。**
 * 📌 **選んだことのあるものを上に出す**だけで、実用上はほぼ足りる
 * （実際に戻り先にするのはナビアプリ数個なので）。
 *
 * @param apps 端末から取れたアプリの一覧
 * @param recent 最近選んだパッケージ名（新しい順）
 * @param query 絞り込みの文字列（空なら絞り込まない）
 */
export function orderApps(
  apps: readonly LaunchableApp[],
  recent: readonly string[],
  query: string,
): { recent: LaunchableApp[]; rest: LaunchableApp[] } {
  const trimmed = query.trim().toLowerCase();
  const matched = trimmed
    ? apps.filter(
        (app) =>
          app.label.toLowerCase().includes(trimmed) ||
          app.packageName.toLowerCase().includes(trimmed),
      )
    : [...apps];

  // ⚠️ **`recent` の順序を保つ**（新しい順に出したいので、indexOf で引く）。
  const recentApps = recent
    .map((pkg) => matched.find((app) => app.packageName === pkg))
    .filter((app): app is LaunchableApp => app !== undefined);
  const recentSet = new Set(recentApps.map((app) => app.packageName));
  const rest = matched
    .filter((app) => !recentSet.has(app.packageName))
    // 残りは名前順。⚠️ **端末が返す順はばらばら**なので、並びを安定させる。
    .sort((a, b) => a.label.localeCompare(b.label, "ja"));

  return { recent: recentApps, rest };
}
