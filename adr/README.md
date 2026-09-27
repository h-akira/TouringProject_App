# adr/ — App の決定の記録

App に固有の判断と、却下した案とその理由。現在の設計は [docs/](../docs/)、プロジェクト全体の決定は親リポジトリの [adr/](https://github.com/h-akira/TouringProject/blob/main/adr/README.md)。

| # | 決定 | 日付 | ステータス |
|---|---|---|---|
| [001](001_handsfree_launch_mechanism.md) | ハンズフリー起動は `VOICE_COMMAND` を `MainActivity` の intent-filter で受ける | 2026-08-17 | 採用 |
| [002](002_return_to_map_after_answer.md) | 応答後は設定で選んだアプリを LAUNCHER インテントで開いて戻る | 2026-08-21 | 採用 |
| [003](003_end_of_speech_detection.md) | 終話はインカムのボタン再押しと録音の上限で決める | 2026-09-09 | 採用 |
| [004](004_play_internal_testing_release.md) | Play の内部テストで配り、`v*` タグで GitHub Actions が配信する | 2026-09-10 | 採用 |
| [005](005_intercom_mic_routing.md) | 録音はインカムのマイクから行い、経路は「音声認識」として張る | 2026-09-22 | 採用 |

書き方は親リポジトリの `AGENTS.md`（ADR の書き方）に従う。番号は再利用しない。
