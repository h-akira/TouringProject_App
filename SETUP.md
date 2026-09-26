# App/ セットアップと困ったとき

> 📌 **このリポジトリは [TouringProject](https://github.com/h-akira/TouringProject) の submodule。**
> 設計・経緯（`docs/` `adr/` `pre-research/`）と、**分離（2026-09-25）より前の git 履歴**は親リポジトリにある。

**初回の環境構築・中断/再開の手順・つまずいたときの対処**を置く。
**普段の使い方は [README.md](README.md)。**

## 動かす（実機Android + Development Build）

### 0. Android開発環境（初回だけ）

**Android Studio / Android SDK / JDK 17** が要る。

```sh
brew install --cask zulu@17
brew install --cask android-studio   # 初回起動でStandardセットアップ
```

`~/.zshrc` 等に環境変数を追加:

```sh
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

`adb --version` が通れば準備完了。実機をUSB接続し、
`設定 > 開発者向けオプション > USBデバッグ` を有効化してから
`adb devices` で認識されることを確認する。

> ⚠️ **AIにビルドさせるときは `ANDROID_HOME` を明示的に渡すこと。**
> `~/.zshrc` は**対話シェルでしか読まれない**ので、AIが実行する
> 非対話シェルには環境変数が引き継がれず、Gradleが
> `SDK location not found` で失敗する。
>
> ```sh
> ANDROID_HOME="$HOME/Library/Android/sdk" npx expo run:android
> ```
>
> 📌 `android/local.properties` に `sdk.dir` を書く方法もあるが、
> `android/` ごと `.gitignore` 済みで `prebuild` のたびに消えるため、
> 環境変数を渡す方が確実。

### 1. 準備（初回だけ）

```sh
cd App
npm install          # postinstall で API の型が自動生成される
cp .env.example .env # ← APIのURLを書く（下記）
```

**実機をUSB接続し `adb devices` で認識されることを確認**したら、初回だけビルド:

```sh
npx expo prebuild --platform android   # android/ を生成
npx expo run:android                   # ビルドして実機にインストール
```

⚠️ **`android/` は生成物なので `.gitignore` 済み。** 手で編集しても
`prebuild --clean` で消える。**ネイティブ側の変更は2箇所のどちらかに書く**:

| 置き場 | 何を書くか |
|---|---|
| `App/plugins/` | **マニフェスト・`MainActivity.kt` など、生成物への差し込み**（Expo config plugin） |
| `App/modules/` | **JSから呼ぶ自前のネイティブ機能**（Expo Modules API）。`modules/` は既定でautolinkされるので登録は要らない |

**`.env` に書くのはURLだけ:**

```sh
EXPO_PUBLIC_API_BASE_URL=https://<api-id>.execute-api.ap-northeast-1.amazonaws.com/Prod
```

⚠️ **APIキーは `.env` に書かない。** `EXPO_PUBLIC_*` は**バンドルに平文で埋め込まれる**ので
秘密の置き場にならない。キーは**アプリの設定画面から入力**する（後述）。

デプロイ済みのURLは次で取れる:

```sh
AWS_PROFILE=touring aws cloudformation describe-stacks \
  --stack-name stack-trg-dev-main --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text
```

### 2. 起動（2回目以降。実機に既にインストール済みの前提）

```sh
cd App
npx expo start
```

**実機のアプリ（アイコン名「Touring Assistant」）を直接開くと、開発サーバーに自動で繋がる。**
QRコードやExpo Goは使わない。

⚠️ **`npx expo start` は対話型TUI。** AIエージェントにバックグラウンド実行させず、
自分のターミナルで起動すること。

⚠️ **スマホとMacが同じWi-Fiにいること**（Metroバンドラに繋ぐため）。
📌 **API自体はモバイル回線でも叩ける**（APIキー認証なのでIPに依存しない）。
繋がらないときは `npx expo start --tunnel` を試す。

### 3. APIキーを入れる（初回だけ）

起動直後は「**APIキーが未設定です**」と出る。タップして設定画面へ。

キーの値は次で取る（⚠️ **コミットしないこと**）:

```sh
AWS_PROFILE=touring aws apigateway get-api-key \
  --api-key "$(AWS_PROFILE=touring aws cloudformation describe-stacks \
      --stack-name stack-trg-dev-main --region ap-northeast-1 \
      --query "Stacks[0].Outputs[?OutputKey=='ApiKeyId'].OutputValue" --output text)" \
  --include-value --region ap-northeast-1 --query value --output text
```

貼り付けて保存すると `expo-secure-store`（AndroidではKeystoreで暗号化）に保管される。
**一度入れれば再入力は不要。**

## 開発を中断・再開するとき

- **中断するとき**: 特別な後片付けは不要。`npx expo start` を `Ctrl+C` で止めるだけ。
  実機のアプリはそのままでよい（次回 `npx expo start` すれば自動で繋がる）。
- **再開するとき**:
  1. 実機をUSB接続（`adb devices` で認識確認。**インカムのボタン試験は有線接続不要**、
     Wi-Fi経由の開発サーバー接続だけ繋がっていればよい）
  2. `cd App && npx expo start`
  3. 実機のアプリ（アイコン名「Touring Assistant」）を開く。開発サーバーに自動接続される
  4. しばらく間が空いていた場合、`npm install`（依存の変更を取り込む）と
     `npx expo run:android`（ネイティブ側の変更を取り込む）を念のため実行するとよい

## 実走行用のビルド（Metro無しで動かす）← ツーリングに出る前に

⚠️ **通常の Development Build は起動時に Metro（開発サーバー）へJSを取りに行く**ので、
**Macから離れると起動しない。** バイクに乗るなら**JSを焼き込んだビルド**が要る。

📌 **これは「自分が走るため」のビルド**（Metro無しで動けばよい）。
📌 **人に配るためのビルドは別**（下記「Playストアに出すビルド」）。

### 作り方（release）

```sh
cd App
# ⚠️ version を先に上げる（prebuild の後だと android/ に反映されない）
ANDROID_HOME="$HOME/Library/Android/sdk" npx expo prebuild --platform android
ANDROID_HOME="$HOME/Library/Android/sdk" ./android/gradlew -p android assembleRelease
```

⚠️ **`ANDROID_HOME` を明示する。** 非対話シェルには `~/.zshrc` が読まれず
`SDK location not found` で失敗する。
⚠️ **`.env` はビルド時に焼き込まれる**（`EXPO_PUBLIC_*`）ので、**ビルド前に正しいこと。**

できるもの: `android/app/build/outputs/apk/release/app-release.apk`
**約45MB**（フルビルド **5分22秒** / 差分ビルドは30秒前後）。

📌 **`arm64-v8a` だけをビルドしている**（`plugins/withSingleAbi.js`）。
⚠️ **既定の4アーキテクチャだと `App/` が 18.9GB まで膨らむ**
（`.so` が `node_modules` 配下に積み上がる）。詳細は
[docs/01c](https://github.com/h-akira/TouringProject/blob/main/docs/01c_app_client.md) §8a。

### 実機へ入れる

**PCからコマンドで入れる**（`adb` がUSB経由でAPKを転送してインストールする）。

```sh
# ① 実機をUSB接続し、認識されているか確認
adb devices
# ② インストール（-r = 上書き）
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

⚠️ **スマホ側の操作が2つある**（「コマンドだけで完結」ではない）:

| いつ | 何をするか |
|---|---|
| **初回のみ** | `設定 > 開発者向けオプション > USBデバッグ` を有効化（上記「動かす」章と同じ） |
| **USBを挿したとき** | ⚠️ **「このパソコンからのUSBデバッグを許可しますか？」が実機に出たら「許可」を押す。** 「常に許可する」にチェックを入れると次回から出ない |

⚠️ **許可を押すまで `adb devices` は `unauthorized` と表示され、インストールは失敗する:**

```
XXXXXXXX    device        ← 正常
XXXXXXXX    unauthorized  ← ⚠️ 実機の画面で「許可」を押す
（何も出ない）             ← USBが刺さっていない／ケーブルが充電専用
```

📌 **インストール自体に画面操作は要らない**（完了すると `Success` と出る）。
APKファイルを実機で直接開く方法だと「提供元不明のアプリ」の許可が要るが、
**`adb install` はその経路を通らない。**

📌 **`-r` で上書きインストールできる。** 上の手順（`.env` に署名鍵を設定していない状態）では
release も **debugと同じキーストアで署名される**ため、
**保存済みのAPIキー・録音の設定・戻り先アプリは消えない。**

⚠️ **署名鍵を設定してからビルドしたAPKは、署名が変わるので上書きできない**
（`adb install -r` が `INSTALL_FAILED_UPDATE_INCOMPATIBLE` で失敗する）。
**一度アンインストールが要る＝保存済みの設定は消える。**
📌 **走行用のAPKを作るときは `.env` の `TRG_*` を外しておくと混ざらない。**

### ✅ release でも `console.log` は出る（確認済み）

**実機で挙動を追うための `[recording]` / `[handsfree]` ログは release でも `adb logcat` に出る。**
除去の経路が**どれも無い**ことを確認済み:

| 経路 | 状態 |
|---|---|
| `babel.config.js` | **無し** |
| `babel-plugin-transform-remove-console` | **未インストール** |
| Metro の `drop_console` | 既定に**無し**（`metro-config` の `minifierConfig`） |
| `minifyEnabled` | 既定 **false**（`gradle.properties` に指定無し） |

ビルドしたAPKの中に文字列が残っていることも確認できる:

```sh
unzip -p android/app/build/outputs/apk/release/app-release.apk assets/index.android.bundle \
  | grep -ac "max reached"   # 1 以上なら出る
```

⚠️ **`grep -a` が要る**（バンドルは**Hermesバイトコード**なのでバイナリ扱いになる）。
⚠️ **`[recording]` で検索しない** — 角括弧は正規表現のため空振りする。
⚠️ **日本語では検索しない** — Hermesは**UTF-16で格納する**ので `grep` に写らない
（確かめ方は下記）。

### テスト（純粋な関数だけ）

```sh
npm test    # Node の組み込みテストランナー（src/**/*.test.ts）
```

⚠️ **React Native やネイティブモジュールに触れるものは対象外**（Node では動かない）。
**経路・録音まわりは実機の記録で確かめる**（下記）。

### 走行後に記録を取り出す

⚠️ **`adb logcat` は数分で流れる**ので、走行中の出来事は走行後には残っていない。
📌 **そのため、経路まわり（ネイティブ）とアプリ（JS の `trace()`）の記録を端末内のファイルにも書いている**
（`src/api/trace.ts`。2MB を超えると `.1` に回して書き直す）。

```sh
adb pull /sdcard/Android/data/com.touringproject.app/files/btroute-trace.log
adb pull /sdcard/Android/data/com.touringproject.app/files/btroute-trace.log.1   # あれば1つ前
```

| 目印 | 何が分かるか |
|---|---|
| `[vr] start result: ok=...` | インカムの経路が張れたか・何msかかったか |
| `[hfp] audio: ... -> ...` | インカムの経路の開閉（**2回目の押下はここに出る**） |
| `[vr] sco lost by remote` | インカム側で経路が切れた（＝2回目の押下とみなした） |
| `[mic] recording (...)` | ⚠️ **実際に録音しているマイク**（`bluetooth_sco` ならインカム） |

⚠️ **位置情報は書いていない**が、**機器名は入る**。リポジトリに貼るときは確認すること。

### ビルド後に確かめること

```sh
APK=android/app/build/outputs/apk/release/app-release.apk
# ① JSバンドルが入ったか（⚠️ これが本体。debug APK には入っていない）
unzip -l "$APK" | grep index.android.bundle
# ② 署名がdebugキーストアか（＝上書きインストールできる）
#    ⚠️ 配信用は upload key で署名される（下記「Playストアに出すビルド」）
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$APK" | grep "Signer #1"
# ③ ハンズフリーの intent-filter と <queries> が生きているか
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump xmltree --file AndroidManifest.xml "$APK" \
  | grep -E "VOICE_COMMAND|queries"
```

⚠️ **最終確認はUSBを抜いて起動すること**（Metroを止めてから）。

#### ⚠️ バンドルは Hermes バイトコードなので `grep` が効かない

**「今回の変更がAPKに入ったか」を文字列で確かめたいとき**、
⚠️ **`unzip -p … | grep` は空振りする**（`file` で見ると
`Hermes JavaScript bytecode` で、**プレーンなJSではない**）。

📌 **文字列そのものは残っている**が、**日本語は UTF-16LE で格納される**。
`strings` はUTF-8しか拾わないので、**日本語だけ見つからない**という
⚠️ **紛らわしい空振り方**をする（ASCIIのログ文字列は見つかる）。

```sh
unzip -p "$APK" assets/index.android.bundle > /tmp/bundle.js
python3 -c '
import sys
data = open("/tmp/bundle.js","rb").read()
for p in sys.argv[1:]:
    print(p, "utf8:", data.count(p.encode()), "utf16:", data.count(p.encode("utf-16-le")))
' "押して話す" "second press while recording"
```

📌 **`expo-dev-client` は `package.json` に入れたままでよい。**
release APKには**含まれない**ことを確認済み（Metroでの開発には引き続き要る）。

## Playストアに出すビルド（内部テスト用）

⚠️ **上の release APK とは別物。** **Playに出すのは AAB**（Android App Bundle）で、
**専用の署名鍵**が要る。方針の経緯は [adr/009](https://github.com/h-akira/TouringProject/blob/main/adr/009_play_internal_testing_release.md)。

| | 走るためのAPK | Playに出すAAB |
|---|---|---|
| コマンド | `assembleRelease` | **`npm run bundle:play`** |
| 署名 | debug鍵でよい | ⚠️ **upload key が必須** |
| ABI | `arm64-v8a` だけ | ⚠️ **全ABI**（配る相手の端末を選べない） |

📌 **ふだんの配信はタグの push で済む**（下の「5. アップロード」）。
**以下の 1〜4 は、手元で AAB を作るとき**（CI が使えないときの逃げ道）の手順。

### 1. 署名鍵を作る（初回だけ・⚠️ 不可逆）

⚠️ **リポジトリの中に作らないこと。** リポジトリを消すと鍵まで消える。

```sh
mkdir -p ~/.keystore
keytool -genkeypair -v -storetype JKS \
  -keystore ~/.keystore/touring-upload.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

⚠️ **`-validity 10000` にする**（単位は**日**。10000日 ≒ **27年**）。
⚠️ **期限が切れると、配った相手が更新を受け取れなくなる。**
📌 **Android公式は「最低25年」を推奨**しており、⚠️ **Playは有効期限が
2033年10月22日より後であることを要求する。** `10000` は両方を満たす定番値
（Android Studio の既定値でもある）。
📌 **対話で聞かれる氏名・組織は、内部テストなら適当でよい**（一般には見えない）。
⚠️ **パスワードは控えておくこと**（後で `.env` に書く）。

📌 **鍵を失っても致命的ではない。** Play App Signing を使えば
**Play Console から upload key を再登録できる**（24〜48時間）。
⚠️ **回復不能なのは Google が預かる app signing key の方**で、そちらは自分では持たない。

### 2. `.env` に場所とパスワードを書く

```sh
# App/.env（⚠️ gitignore済。絶対にコミットしない）
TRG_KEYSTORE_PATH=/Users/<あなた>/.keystore/touring-upload.jks
TRG_KEYSTORE_PASSWORD='<キーストアのパスワード>'
TRG_KEY_ALIAS=upload
TRG_KEY_PASSWORD='<鍵のパスワード>'
```

⚠️ **パスワードは必ずシングルクォートで囲む。**
**この `.env` はシェルの `source` で読まれる**ので、⚠️ **裸で書くと
`#` 以降が捨てられ、空白でコマンドとして解釈される**（変数が空になり、
**署名がエラーになる**）。📌 **囲めば記号も空白もそのまま通る。**

📌 **`build.gradle` には書き込まれない。** Gradle が**ビルド時に環境変数として読む**ので、
**生成物に平文で残らない**（`plugins/withReleaseSigning.js`）。

### 3. AABを作る

```sh
cd App
# ⚠️ version を先に上げる（versionCode の元になる）
ANDROID_HOME="$HOME/Library/Android/sdk" npm run bundle:play
```

できるもの: `android/app/build/outputs/bundle/release/app-release.aab`（**約72MB**）。
📌 **APKより大きいのは全ABIを含むから。** ⚠️ **利用者の端末に届くのは
Playが分割したぶんだけ**なので、ダウンロードサイズは増えない。

⚠️ **`npm run bundle:play` が `TRG_ALL_ABI=1` と `--clean` を内包している**
（全ABIへの切り替え忘れを防ぐため）。⚠️ **その分ビルドは長い**（4〜5分）。

### 4. 確かめること

```sh
AAB=android/app/build/outputs/bundle/release/app-release.aab
# ① 全ABIが入ったか（4つ出れば正しい）
unzip -l "$AAB" | grep -oE 'lib/[a-z0-9_-]+/' | sort -u
# ② upload key で署名されたか（⚠️ 証明書の中身を見る。ファイル名では判別しない）
unzip -p "$AAB" 'META-INF/*.RSA' | keytool -printcert | grep -E '所有者|Owner'
#    ⚠️ "CN=Android Debug" と出たら debug 鍵。Playには出せない
# ③ versionCode が上がったか（app.json の version から導出される）
grep versionCode android/app/build.gradle
```

⚠️ **`versionCode` は `app.json` の `version` から自動で決まる**
（`1.34.0` → `13400`。`plugins/withVersionCode.js`）。
⚠️ **Playは同じ番号を二度受け付けない**ので、**出すたびに `version` を上げる。**

### 5. アップロード

📌 **`v*` タグを push すると、GitHub Actions がビルド・署名して内部テストに上げる**
（`.github/workflows/play-release.yml`）。

```sh
# version を上げてコミットしたあと（タグ名は v + app.json の version）
git tag -a v1.42.0 -m "<何が動くようになったか>"
git push && git push origin v1.42.0
```

- ⚠️ **タグと `app.json` の `version` が違うと、ビルド前に止まる**（`versionCode` の取り違えを防ぐため）
- ⚠️ **debug 鍵で署名された AAB・全ABIでない AAB・API の URL が入っていない AAB は、上げる前に止まる**（上の「4. 確かめること」と同じ検査＋URL）
- ⚠️ **タグは1つずつ push する**（`git push --tags` で一度に4つ以上上がると、GitHub がイベントを作らず**黙って走らない**）
- 📌 **API の URL（`EXPO_PUBLIC_API_BASE_URL`）も Environment `play` の Secret**（手元では `.env` から入る）
- 📌 **CI は `npm run bundle:aab` を呼ぶ。** `bundle:play` は `.env` を読んでからこれを呼ぶだけ。
  ⚠️ **`bundle:aab` は鍵の環境変数が無いと止まる**（黙って debug 署名にしない）
- 📌 **鍵と Play の鍵（サービスアカウント）は GitHub の Environment `play` にあり、`v*` タグからしか読めない。**
  準備の手順は [pre-research/play-cicd/SETUP.md](https://github.com/h-akira/TouringProject/blob/main/pre-research/play-cicd/SETUP.md)

⚠️ **初回だけは Play Console の画面から手で上げる必要があった**
（Play Developer API は**既に存在するアプリしか更新できない**）。**2026-09-13 に済んでいる。**

⚠️ **AABは実機に直接インストールできない。** 手元で動作確認するなら
**上の release APK を使う**か、内部テストに上げてPlay経由で入れる。

📌 **署名・AAB・`versionCode` の一般知識は
[learning/14](https://github.com/h-akira/TouringProject/blob/main/learning/14_android_app_signing_and_release.md)。**

### 6. ⚠️ Play Console で迷ったところ（実際に踏んだもの）

**画面の場所は改装で変わるので、⚠️ 迷ったら上部の検索窓に項目名を入れるのが速い。**

| 迷ったこと | 答え |
|---|---|
| ⚠️ **アプリ名を後から直したい** | **「ユーザーを増やす」→「ストアでの表示」→「メインのストアの掲載情報」。** ⚠️ **「テストとリリース」の下ではない** |
| **「リリース名」が空欄** | ⚠️ **AABのアップロードが完了すると自動で入る**（`13500 (1.35.0)`）。**上げ切る前は空** |
| **「1/2 件の拡張機能が有効です」** | 📌 **正常。** デバッグシンボルは入るが、⚠️ **難読化していないのでマッピングファイルは存在しない** |
| **「難読化解除ファイルがありません」の警告** | 📌 **正常。** ⚠️ **`minifyEnabled` が `false`** なので生成されない。**エラーではないので進める** |
| ⚠️ **アップロードしても公開できない** | ⚠️ **「アプリのコンテンツ」の宣言が未了。** 内部テストでも求められる（免除されるのは**データセーフティ**だけ） |
| ⚠️ **テスターに「アイテムが見つかりませんでした」** | ⚠️ **初回は反映に数時間かかる**（2026-09-11 に実際に遭遇。**設定は全て正しく、待っただけで入った**）。📌 **内部テストに「国/地域」の設定は無い**（⚠️ **全世界が対象。国で絞れるのはクローズドテストと本番のみ**）ので、そこを疑っても無駄。⚠️ **設定を疑う前に、まず数時間待つ** |

⚠️ **パッケージ名（`com.touringproject.app`）は変更も再利用もできない。**
📌 **AABを上げるまでは確定しない**ので、アプリを作り直しても消費されない。

---

## 困ったとき

| 症状 | 原因 |
|---|---|
| **403** | ⚠️ ①APIキーが未設定/誤り（設定画面）②デプロイ漏れ。**切り分けは `/health`**（キー不要・200なら生きている） |
| **429** | Usage Planの上限。⚠️ **クォータはポーリングも消費する**（1問≒11回） |
| **「録音が長すぎます」** | サーバーが2MBで弾いた（`MAX_AUDIO_BYTES`）。⚠️ **録音の上限（既定20秒）とは別**で、上限を大きく延ばしたときに出る |
| **回答は出るが読み上げない** | 音声合成の失敗。⚠️ **異常ではない**（回答は画面に出ている） |
| **聞き取りが違う** | 地名の同音異義（「柳井」→「屋内」等）。⚠️ **走行中の風切り音にも弱い** |
| **「API URL が未設定」** | `.env` が無い/`EXPO_PUBLIC_API_BASE_URL` が空。⚠️ **`.env` を変えたら `expo start` を再起動** |
| 実機のアプリを開くと「There was a problem loading the project」 | 開発サーバー（`npx expo start`）が起動していないか、繋がっていない。起動し直して実機のアプリを開き直す |
| 実機のアプリが起動直後に強制終了する | `NoClassDefFoundError` の場合は依存の重複が疑わしい。`npx expo-doctor` で確認 |
| 直したのに変わらない | `version` を上げたか確認。ネイティブ側の変更なら `npx expo run:android` で再ビルドしたか確認 |
