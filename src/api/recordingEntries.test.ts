/**
 * 録音の履歴の一覧（src/api/recordingEntries.ts）のテスト。
 *
 * 実行: `npm test`（Node の組み込みテストランナー。純粋な関数だけを対象にする）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addEntry,
  parseEntries,
  updateEntry,
  type RecordingEntry,
} from "./recordingEntries.ts";

function entry(id: string): RecordingEntry {
  return {
    id,
    uri: `file:///recordings/${id}.m4a`,
    recordedAt: 0,
    durationMs: 3_000,
    audioSource: "voice_communication",
    mic: "インカム(250ms)",
    sent: true,
  };
}

test("新しいものを先頭に足す", () => {
  const { entries, dropped } = addEntry([entry("a")], entry("b"));
  assert.deepEqual(
    entries.map((e) => e.id),
    ["b", "a"],
  );
  assert.deepEqual(dropped, []);
});

test("上限を超えたら古いものを消す対象として返す", () => {
  const { entries, dropped } = addEntry([entry("b"), entry("a")], entry("c"), 2);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["c", "b"],
  );
  assert.deepEqual(
    dropped.map((e) => e.id),
    ["a"],
  );
});

test("聞き取った文と結果を後から書き足せる", () => {
  const updated = updateEntry([entry("a"), entry("b")], "a", {
    transcript: "",
    outcome: "エラー: Nothing could be heard in the recording.",
  });
  assert.equal(updated[0].transcript, "");
  assert.equal(updated[1].transcript, undefined);
});

test("上限で消えた録音への書き足しは何もしない", () => {
  const before = [entry("a")];
  assert.deepEqual(updateEntry(before, "gone", { outcome: "x" }), before);
});

test("壊れた保存値は空として読む", () => {
  assert.deepEqual(parseEntries(null), []);
  assert.deepEqual(parseEntries("{"), []);
  assert.deepEqual(parseEntries('{"id":"a"}'), []);
  assert.deepEqual(
    parseEntries(JSON.stringify([entry("a"), { id: 1 }])).map((e) => e.id),
    ["a"],
  );
});
