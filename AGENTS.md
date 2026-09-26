# AGENTS.md — App

バイクで走りながらインカムのボタンと声で AI と対話する Android アプリ（React Native / Expo）。
親リポジトリ `TouringProject` の submodule。共通の規約は親の `AGENTS.md`（親の中で作業しているときは既に読まれている）。

走行中は画面を見られず手も使えない。迷ったらこの前提に立ち返る。App は薄いクライアントに徹し、UI は動作確認に足る最小限にする。

## どこに何があるか

| 場所 | 中身 |
|---|---|
| `docs/` | App の設計（現在の姿だけ） |
| `adr/` | App の決定の経緯（書き方は親の `AGENTS.md`） |
| `docs-parent/` | 親の `docs/` の写し（要件・技術方針・契約・OpenAPI）。⚠️ 編集しない。更新は親の `docs/sync.sh` |
| `README.md` / `SETUP.md` | 使い方 / 初回のセットアップ・ビルド・配信・困ったとき |

コードのコメントから参照してよいのは、`docs/`・`adr/`・`docs-parent/` と research の絶対 URL だけ（learning は参照しない）。

## 開発環境

- 実機の Android ＋ Expo Development Build で確かめる（Expo Go では動かない）。
- ⚠️ `npx expo start` は対話型の TUI なので、AI はバックグラウンドで起動しない。ユーザーに自分のターミナルで起動してもらう。
- ネイティブ（`app.json` の `plugins`・`plugins/`・`modules/`）を変えたら `npx expo run:android` で再ビルドが要る。JS/TS だけなら Metro で反映される。
- ⚠️ `android/` は `prebuild` の生成物（gitignore）。手で編集しても消える。変更は config plugin（`plugins/`）か自前のモジュール（`modules/`）に書く。
- AI がビルドするときは `ANDROID_HOME="$HOME/Library/Android/sdk"` を明示する（非対話シェルは `~/.zshrc` を読まない）。
- デプロイと実機での確認はユーザーが行う。

## Expo SDK 54

- ⚠️ SDK 54 を使う。コードを書く前に SDK 54 の公式ドキュメント（`https://docs.expo.dev/versions/v54.0.0/`）を見る。新しい SDK のドキュメントは、54 に存在しない API を現役のように書いている。
- 推移的な依存が新しい SDK 向けに解決されて起動直後に落ちることがある。`npx expo-doctor` で検出できる。

## `version` とタグ

- ⚠️ `app.json` の `version` は、ビルドが変わる変更（JS/TS・ネイティブ・依存・設定）のときだけ上げる。ドキュメントやコメントだけの変更では上げない。
- `version` は画面の左上に出て、実機に更新が入ったかの判別に使う。`versionCode` はここから導出される。
- ⚠️ `version` を上げたら、コミット時に注釈付きタグ `v<version>` を App リポジトリで打つ（`git tag -a`。軽量タグは使わない）。メッセージは英語で「何が動くようになったか」を書く（差分の要約ではない）。タグと `version` は1対1。
- ⚠️ `v*` タグの push は Play の内部テストへの配信を意味する（`.github/workflows/play-release.yml`）。タグの push もユーザーが行う（`git -C App push origin v<version>`。1つずつ push する）。

## API の型

- 型は `docs-parent/04_api_openapi.yaml` から生成する（`npm run gen:api` → `src/api/schema.ts`。`postinstall`・`prestart` で自動）。
- `schema.ts` は生成物（gitignore）で、手で編集しない。エイリアスは `src/api/types.ts`。
- 契約を変えるときは親の `docs/` を直して `docs/sync.sh` を実行し、ここで `docs-parent/` をコミットしてから `npm run gen:api`。

## 落とし穴

- ハンズフリー起動は `android.intent.action.VOICE_COMMAND` を `MainActivity` の intent-filter で受ける（`plugins/withVoiceInteraction.js`）。⚠️ `VoiceInteractionService`（既定のアシスタント）は実機で不成立だったので蒸し返さない。ウェイクワードも却下済み（adr/001）。
- ⚠️ インカムの経路は `modules/bt-audio-route` の `startVoiceRecognition` で張る。`expo-audio` の `setInput()` は黙って失敗するので使わない。`setCommunicationDevice()` を併用しない（adr/005）。
- `setAudioModeAsync` はプロセス全体に効く。モードは `src/api/voice.ts` の2つだけを使う。
- 背面では JS が凍結する。背面で待つ処理を足さない（フォアグラウンドサービスは持たない）。
- API が 403 を返したら、API キーの誤りとデプロイ漏れの両方を疑う。切り分けは `GET /health`（キー不要）。
- 実機の記録ファイル（`btroute-trace.log`）には機器名が入る。リポジトリに貼るときは確かめる。

## テスト

`npm test`（純粋な関数だけ）と `npm run typecheck`。経路・録音まわりは実機の記録で確かめる（`SETUP.md`）。
