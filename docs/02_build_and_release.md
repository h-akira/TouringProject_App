# ビルドと配信の設計

ビルドの種類と、Play の内部テストへの配信の仕組み。手順は [SETUP.md](../SETUP.md)、経緯は [adr/004](../adr/004_play_internal_testing_release.md)。

## 1. ビルドの種類

| | 開発（Development Build） | 実走行用の APK | 配信用の AAB |
|---|---|---|---|
| JS | Metro から取る | 焼き込む | 焼き込む |
| 署名 | debug 鍵 | debug 鍵（上書きインストールで設定が消えない） | upload key |
| ABI | `arm64-v8a` | `arm64-v8a` | 全4種 |
| 作り方 | `npx expo run:android` | `assembleRelease` | `v*` タグの push（GitHub Actions）、または手元で `npm run bundle:play` |

- 通常の Development Build は起動時に Metro から JS を取るので、Mac から離れると起動しない。実走行には JS を焼き込んだ release ビルドを使う。
- `console.log` は release でも出る（`adb logcat` で追える）。

## 2. ABI は既定で1種類だけにする

既定では `arm64-v8a`（実機の Pixel 8a）だけをビルドする（`plugins/withSingleAbi.js`）。
既定の4種（`armeabi-v7a` `arm64-v8a` `x86` `x86_64`）すべてをビルドすると、ネイティブライブラリがアーキテクチャごとに作られ、`node_modules` の中に十数GB が生成される（実測で 18.9GB、1種なら 3.6GB）。

- 生成するのは `npm install` ではなく Gradle で、生成先が `node_modules` の中なので気づきにくい。消してもビルドすれば戻るので、作らせないのが要点。
- ⚠️ `android/gradle.properties` を直接編集しても `prebuild` が作り直す。config plugin から書く。
- エミュレータ（`x86_64`）では動かない。実機でしか確認しない方針なので許容する。
- 配信用のビルドだけは全 ABI にする（配る相手の端末は選べない）。環境変数 `TRG_ALL_ABI` で切り替え、切り替えは AAB を作る npm script に埋め込む。AAB の ABI ごとの分割は Play が行うので、利用者のダウンロードは増えない。

## 3. `versionCode` と `version`

- `versionCode` は `app.json` の `version` から導出する（`1.35.0` → `13500`。`plugins/withVersionCode.js`）。各桁は99まで。
- ⚠️ Play は同じ `versionCode` を二度受け付けない。
- `version` はビルドが変わるときだけ上げる。画面の左上に出るので、実機に更新が入ったかの判別にも使う。

## 4. 署名

- 署名の設定は環境変数から読む（`plugins/withReleaseSigning.js`）。鍵もパスワードも `build.gradle` に書き込まない。未設定なら debug 鍵のまま。
- upload key の原本はリポジトリの外（`~/.keystore/`）。手元ではパスとパスワードを `.env`（gitignore 済み）に書く。
- CI では、upload key の写しを GitHub の Environment `play` の secrets に置き、`v*` タグからの実行だけが読める。

## 5. 配信（Play の内部テスト）

`v*` タグの push で `.github/workflows/play-release.yml` が動く。

1. タグと `app.json` の `version` が一致するか確かめる（違えば止める）
2. `npm ci`（`postinstall` で API の型を `docs-parent/04_api_openapi.yaml` から生成する）
3. upload key を復元し、全 ABI の AAB をビルドして署名する
4. `r0adkll/upload-google-play`（コミット SHA で固定）で内部テストへ上げる

- ⚠️ public リポジトリなので、`pull_request` では動かさない。
- Google Cloud・Play Console・GitHub の設定手順は CICD リポジトリ（非公開）の `PLAY_RELEASE.md`。
