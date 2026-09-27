# TouringProject_App — ツーリング AI 会話アプリ（Android）

バイクで走りながら、インカムのボタンと声だけで AI に質問できる Android アプリ。
[TouringProject](https://github.com/h-akira/TouringProject) の submodule で、質問への回答は AWS 側（Backend・Agent）が作る。

| 見たいもの | 場所 |
|---|---|
| 初回のセットアップ・ビルド・配信・困ったとき | [SETUP.md](SETUP.md) |
| 設計 | [docs/](docs/README.md) |
| 決定の経緯 | [adr/](adr/README.md) |
| プロジェクト全体の要件と契約 | [docs-parent/](docs-parent/README.md)（親リポジトリの写し。編集しない） |

## 動かす

実機の Android と Expo Development Build で動かす（Expo Go では動かない）。
初回は [SETUP.md](SETUP.md) の手順でビルドして実機に入れる。2回目以降はこれだけ:

```sh
npx expo start
```

実機のアプリ（アイコン名「Touring Assistant」）を開くと、開発サーバーに自動で繋がる。
⚠️ `expo start` は対話型なので、自分のターミナルで動かす。

ネイティブ（`app.json` の `plugins`・`plugins/`・`modules/`）を変えたら再ビルドが要る:

```sh
npx expo prebuild --platform android --clean
npx expo run:android
```

`android/` は生成物（gitignore）。直接編集しない。

## 使う

1. 初回だけ: 位置情報とマイクの許可を出し、設定画面で API キーを入れる（取り出し方は [SETUP.md](SETUP.md)）
2. 初回だけ: `設定 > アプリ > Google > デフォルトをクリア`（しないとインカムのボタンで Google が開く。既定のアシスタントは Google のままでよい）
3. 設定画面で「戻る」を選び、応答後に戻るアプリ（ナビ）を選ぶ（既定は「戻らない」）
4. インカムのボタンを押して話し、もう一度押すと送信する（押さなくても20秒で送信される）
5. 回答が読み上げられ、ナビのアプリに戻る

- 画面のボタン（押して話す）や文字の入力でも質問できる。文字で聞いても回答は読み上げる。
- 最初の質問は10秒ほど、声の質問は15〜20秒かかる。
- 進行方位は走らないと出ない（停車中・曲がった直後は「まだ出せません」が正常）。
- インカムを繋いでいれば録音はインカムのマイクで行う。張れなかったときだけ画面に黄色の警告が出る。
- 回答の音声が作れなかった（音声合成の失敗）ときは、回答は画面に出る。インカムのボタンで始めたときは、本文を端末の音声で読み上げる。

## API の型

API の契約は `docs-parent/04_api_openapi.yaml`（親リポジトリの写し）で、型はそこから生成する。

```sh
npm run gen:api   # docs-parent/04_api_openapi.yaml → src/api/schema.ts
```

`postinstall` と `prestart` で自動的に走る。`schema.ts` は生成物（gitignore）なので手で編集しない。
契約を変えるときは親リポジトリの `docs/` を直し、親の `docs/sync.sh` で `docs-parent/` を更新する。

## テスト

```sh
npm test    # 純粋な関数だけ（src/**/*.test.ts）
```

## 構成

```
app.json          Expo の設定（version は画面の左上に出る）
plugins/          生成物（マニフェスト・MainActivity.kt・Gradle）への差し込み（config plugin）
modules/          自前のネイティブモジュール（インカムの経路・戻り先アプリを開く）
src/app/          画面（expo-router）
src/api/          API 呼び出し・録音・設定の保管・記録
docs/ adr/        設計と経緯
docs-parent/      親リポジトリの docs の写し（編集しない）
```
