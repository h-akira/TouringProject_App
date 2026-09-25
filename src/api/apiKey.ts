/**
 * APIキーの保管と読み出し（docs/01_architecture.md §8）。
 *
 * ⚠️ **キーはソースにも .env にも置かない。**
 * `EXPO_PUBLIC_*` はバンドルに平文で埋め込まれるため、秘密の置き場にならない
 * （URLは秘密ではないので `.env` のままでよい）。代わりにアプリ画面から入力し、
 * `expo-secure-store` で端末のOS側の保護領域に置く。
 * Androidでは Keystore で暗号化され、他のアプリからは読めない。
 */
import * as SecureStore from "expo-secure-store";

// SecureStore のキー名。値そのものではなく「どこに置いたか」なので公開してよい。
// ⚠️ 変えると既存の端末で保存済みのキーが読めなくなる（再入力が要る）。
const API_KEY_STORE_KEY = "touring.apiKey";

/** 保存済みのAPIキー。未設定なら null。 */
export async function loadApiKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(API_KEY_STORE_KEY);
  } catch {
    // 端末側の保護領域が使えない場合（極めて稀）。キー無しとして扱えば
    // 画面が入力を促すので、ここで落とす必要はない。
    return null;
  }
}

/** APIキーを端末に保存する。前後の空白は取り除く（コピペで混入しやすい）。 */
export async function saveApiKey(apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(API_KEY_STORE_KEY, apiKey.trim());
}

/** 保存済みのAPIキーを消す。 */
export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(API_KEY_STORE_KEY);
}

/**
 * API Gateway がキーを読むヘッダ名。
 * ⚠️ **`x-api-key` 固定**（API Gateway 側の仕様で、変更できない）。
 */
export const API_KEY_HEADER = "x-api-key";
