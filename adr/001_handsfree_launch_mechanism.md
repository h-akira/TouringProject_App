# 001. ハンズフリー起動は `VOICE_COMMAND` を `MainActivity` の intent-filter で受ける

- **日付**: 2026-08-17（最終更新 2026-10-09）
- **ステータス**: 採用

## 背景

US-2.04（スマホに触れずに起動する）を満たす起動の手段が要る
（[docs-parent/00_user_stories.md](../docs-parent/00_user_stories.md) 補足C）。
走行中は画面に触れられず、要件は「スマホに触れないこと」であって「声で呼ぶこと」ではない。

インカムのボタンを押すと、Android の Bluetooth スタック（`com.android.bluetooth`）が
`android.intent.action.VOICE_COMMAND` を発行する（AOSP の `HeadsetSystemInterface.activateVoiceRecognition()`）。
これはコンポーネント名を指定しない汎用の Intent で、既定のアシスタント（`VoiceInteractionService`）とは別の経路である。

## 選択肢

| 案 | 中身 | 判断 |
|---|---|---|
| A. メディアボタンを拾う | `KEYCODE_MEDIA_*` を MediaSession で受ける | 却下。押しやすいボタンはメディアキーを送らない（音楽の操作に割り当てられている）。送ったとしても、音楽やナビが鳴っていればそちらが受け取る |
| B. 既定のアシスタントになる | `VoiceInteractionService` を実装し、デジタルアシスタントのロールを取る | 却下。実装して実機で試したが、インカムのボタンでは本アプリではなく Google App が開いた。ボタンが発行するのは `VOICE_COMMAND` で、アシスタントのロールは関係しない。ロールを取ると Google アシスタントとマップの音声入力も失う |
| C. ウェイクワード（Porcupine 等） | 独自の呼びかけで起動する | 却下。常時マイクを占有し（フォアグラウンドサービス・電池・インカムの通話や音楽との競合）、ヘルメット内の声が本体マイクに届くかも未知だった |
| D. 2台構成（ナビ用の端末と分ける） | 本アプリ専用の端末を持つ | 却下。インカムの音声入力は1台にしか来ず、ボタンの行き先を制御できない |
| **E. `VOICE_COMMAND` を Activity の intent-filter で受ける** | `MainActivity` に intent-filter を足す | 採用 |

## 決定

`MainActivity` に次の intent-filter を足し（`plugins/withVoiceInteraction.js`）、
受けた `VOICE_COMMAND` を `app:///?autoRecord=<押した時刻>` の deep link に読み替えて JS に渡す（値を毎回変えるのは、`useURL()` が同じ値では再発火せず、2回目以降の押下が無視されるため）。
`launchMode="singleTask"` なので、`onCreate` と `onNewIntent` の両方で読み替える。

```xml
<intent-filter>
  <action android:name="android.intent.action.VOICE_COMMAND" />
  <category android:name="android.intent.category.DEFAULT" />
</intent-filter>
```

⚠️ `VoiceInteractionService`（案B）は実機で不成立だった。蒸し返さない。

## 影響

- 既定のデジタルアシスタントは Google のままでよい。Google アシスタントもマップの音声入力も残る。
- ⚠️ 端末で Google App が `VOICE_COMMAND` の既定（preferred activity）に固定されていると、intent-filter があっても無視される。初回だけ Google を一度無効にして有効に戻し、固定を外す必要がある（Google の設定にはクリアのボタンがない。手順は [USAGE.md](../USAGE.md)）。
- `FLAG_ACTIVITY_NEW_TASK` で新しいタスクとして前面に出るので、ナビ中のマップが引っ込む。戻し方は [002](002_return_to_map_after_answer.md)。
- ネイティブの変更なので Expo Go では動かない（Development Build が要る）。

検証の記録: [handsfree/](https://github.com/h-akira/TouringProject_Research/blob/main/handsfree/)（非公開）
