# App/ — モバイルアプリ（React Native / Expo）

> 📌 **このリポジトリは [TouringProject](https://github.com/h-akira/TouringProject) の submodule。**
> 設計・経緯（`docs/` `adr/` `pre-research/`）と、**分離（2026-09-25）より前の git 履歴**は親リポジトリにある。

ツーリングAI会話アプリのクライアント。**実機Android + Expo Development Build** で動かす。

設計の全体像は [docs/01_architecture.md](https://github.com/h-akira/TouringProject/blob/main/docs/01_architecture.md)。

> ⚠️ **このアプリは"薄いクライアント"に徹する。** 位置を取る・AWSに送る・回答を出す、まで。
> 賢い処理（住所の解決・方位の算出・回答の生成）は**すべてAWS側**にある。

> ⚠️ **US-2.04（ハンズフリー起動）でネイティブコードが必要になり、
> Expo Go から Development Build に移行した**（[adr/006](https://github.com/h-akira/TouringProject/blob/main/adr/006_handsfree_launch_mechanism.md)）。
> **Expo Goでは動かない**（`VOICE_COMMAND` のintent-filterはネイティブのマニフェストにあり、
> Expo Goのランタイムには反映されない）。

## 動かす

**初回のセットアップ（Android SDK・JDK・APIキーの取り出し）は
[SETUP.md](SETUP.md)。** 2回目以降はこれだけ:

```sh
cd App
npx expo start          # 開発サーバー（Metro）を起動
```

⚠️ **`expo start` は対話型なので、自分のターミナルで動かすこと。**
実機のアプリ（アイコン名「Touring Assistant」）を開くと自動で繋がる。

⚠️ **実機にアプリが入っていない／ネイティブを変えたときは
[SETUP.md](SETUP.md) の手順が要る。**

## 試す

1. 位置情報の許可を出す（初回にダイアログが出る）
2. 緯度・経度が表示されるのを待つ
3. **「🎤 押して話す」→ 質問を話す → 黙る**
   （**話し終えれば自動で送信される。** 押して止めることもできる。
   文字で試すなら、下の入力欄から「質問する」）

⚠️ **最初の質問は10秒ほどかかる**（AgentCoreのコールドスタート）。2回目以降は2〜3秒。
**声の場合は文字起こしのぶんが乗る**（実測15〜20秒）。

### 声で質問する（US-2.01 / US-2.02）

**アプリは録音して送るだけ**で、文字起こしも読み上げもバックエンドが行う
（[docs/01](https://github.com/h-akira/TouringProject/blob/main/docs/01_architecture.md) §7）。**回答は自動で読み上げられる。**

- 初回はマイクの許可を求められる
- **インカムのボタンをもう一度押すと、その場で送信される**
  （[adr/008](https://github.com/h-akira/TouringProject/blob/main/adr/008_end_of_speech_detection.md)）
- **押さなくても20秒で自動送信される**（設定画面で変えられる）。
  📌 **残り秒数が画面に大きく出る**ので、押すか待つかはその場で決められる
- 📌 **どちらかが必ず効くので、録音は必ず送られる**
- ⚠️ **文字で質問しても音声は返る**（走行中は画面を見られないため）
- 📌 **回答が読み上げられないことがある。** 音声合成に失敗した場合で、
  **回答自体は画面に出る**（読めれば用は足りるので、エラーにはしない）

### インカムのボタンで使う（US-2.04・ハンズフリー）

**画面に触れずに一巡する。** インカムのボタン → 起動 → 録音 → 自動送信 → 読み上げ
→ **マップアプリへ復帰**（[adr/006](https://github.com/h-akira/TouringProject/blob/main/adr/006_handsfree_launch_mechanism.md)・
[adr/007](https://github.com/h-akira/TouringProject/blob/main/adr/007_return_to_map_after_answer.md)）。

- ⚠️ **初回だけ `設定 > アプリ > Google > デフォルトをクリア` が要る。**
  Google App が `VOICE_COMMAND` の既定として固定されていると、
  **ボタンを押してもGoogleが開く**（[docs/01c](https://github.com/h-akira/TouringProject/blob/main/docs/01c_app_client.md) §2）。
  📌 **「デジタルアシスタント」はGoogleのままでよい**（本アプリを選ぶ必要は無い）
- ⚠️ **設定画面で「戻る」を選び、アプリを選んでおくこと。**
  **既定は「戻らない」**なので、選ばないとマップに戻らない
  （未設定なら画面の「設定」ボタンにその旨が出る）
  📌 **「戻らない」にしても選んだアプリは残る**ので、戻せばそのまま使える
- 📌 **戻るのは回答が届いた時点**で、**読み上げは戻ったあとに背面で鳴る**
- 📌 **インカムを繋いでいれば、録音はインカムのマイクで行う。** 張れなかったときだけ
  画面に黄色の警告が出る（[docs/01c](https://github.com/h-akira/TouringProject/blob/main/docs/01c_app_client.md) §3a）

> 📌 **進行方位（矢印）は走らないと出ない。** 停車中・転回直後は「まだ出せません」が正常
> （5m以上動いた直近の点が必要）。詳細は [docs/01b](https://github.com/h-akira/TouringProject/blob/main/docs/01b_heading.md)。

## ネイティブコードを変更したら再ビルドが要る

JS/TS だけの変更は `npx expo start` を起動していればそのまま反映される。
**`app.json` の `plugins`/`permissions`、`App/plugins/` 配下、`App/modules/` 配下、
`android/` を直接触るような変更は再ビルドが必要**:

```sh
npx expo prebuild --platform android --clean   # android/ を作り直す
npx expo run:android                           # ビルドしてインストール
```

⚠️ **`android/` は生成物。** 直接編集しても `prebuild --clean` で消える。

## ⚠️ 変更したらバージョンを上げる

**`app.json` の `version` を必ず上げる。** 画面左上に表示され、
**更新が反映されたかの判別に使う**（キャッシュが残ることがあるため）。
上げ忘れると「直したのに変わらない」の原因が分からなくなる。

## 構成

```
App/
  app.json              Expoの設定（⚠️ version を上げる）
  .env                  APIのURL（gitignore。⚠️ キーは入れない）
  plugins/
    withVoiceInteraction.js  ネイティブの生成物への差し込み（Expo config plugin）
                             ・VOICE_COMMAND の intent-filter（ハンズフリー起動）
                             ・MainActivity.kt を丸ごと生成
                             ・<queries>（戻り先アプリの一覧に必要）
  modules/
    app-foreground/     自前のネイティブ機能（Expo Modules API・autolink）
                        応答後にマップアプリを前面へ戻す
    bt-audio-route/     インカムのマイクの経路（音声認識として張る）
                        ・経路と録音の記録ファイル（走行後に取り出す。SETUP.md）
  android/              ⚠️ 生成物（gitignore）。手で編集しない
  src/
    app/                画面（expo-router。ファイル名がURLになる）
      _layout.tsx       全画面の外枠
      index.tsx         メイン（位置・方位・質問・回答・録音）
      settings.tsx      APIキー／録音の設定／応答後に戻るアプリ
    api/
      apiKey.ts         キーの保管（expo-secure-store）
      micRoute.ts       インカムの経路の確保・解放・2回目の押下の検知
      handsfreeLaunch.ts  ボタン押下の重複判定（押した時刻で見る）
      trace.ts          記録（console.log ＋ 端末内のファイル）
      voice.ts          録音設定・音声モード・送信
      recordingSettings.ts  録音の設定の保管（AsyncStorage）
      returnApp.ts      応答後に戻るアプリの保管（AsyncStorage）
      types.ts          APIの型のエイリアス
      schema.ts         ⚠️ 自動生成。手で編集しない（gitignore）
```

⚠️ **`src/app/` は expo-router の画面ディレクトリ**で、親リポジトリでの `App/`（このリポジトリ自体）とは別物。

## APIの型は自動生成

**正本は [docs/02_api_openapi.yaml](https://github.com/h-akira/TouringProject/blob/main/docs/02_api_openapi.yaml)**（フロント↔バックの契約）。

```sh
npm run gen:api   # docs/02 → src/api/schema.ts
```

📌 **`postinstall` と `prestart` で自動的に走る**ので、普段は意識しなくてよい。
⚠️ **契約を変えたら `docs/02` 側を直す。** `schema.ts` を手で編集しても次の生成で消える。

## やらないこと

**UIは動作確認に足る最小限**にとどめる。
凝った作り込みはせず、価値の中核であるAWS側に手をかける。
