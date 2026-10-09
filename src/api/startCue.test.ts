/**
 * 録音の開始の合図の長さ（src/api/startCue.ts）のテスト。
 *
 * 実行: `npm test`（Node の組み込みテストランナー。純粋な関数だけを対象にする）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_START_CUE_MS,
  START_CUE_CHOICES,
  normalizeStartCueMs,
} from "./startCue.ts";

test("選択肢の値はそのまま使う", () => {
  for (const choice of START_CUE_CHOICES) {
    assert.equal(normalizeStartCueMs(choice.value), choice.value);
  }
});

test("「なし」は0として残る（既定に戻さない）", () => {
  assert.equal(normalizeStartCueMs(0), 0);
});

test("未保存・壊れた値・選択肢に無い値は既定に落とす", () => {
  for (const raw of [undefined, null, "", "1500", "abc", 1_234, -1, 60_000]) {
    assert.equal(normalizeStartCueMs(raw), DEFAULT_START_CUE_MS);
  }
});

test("既定値は選択肢に含まれる", () => {
  assert.ok(START_CUE_CHOICES.some((c) => c.value === DEFAULT_START_CUE_MS));
});
