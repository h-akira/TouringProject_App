/**
 * ボタン押下の重複判定（src/api/handsfreeLaunch.ts）のテスト。
 *
 * 実行: `npm test`（Node の組み込みテストランナー。⚠️ 純粋な関数だけを対象にする —
 * React Native やネイティブモジュールに触れるものはここでは動かない）。
 *
 * ⚠️ `lastHandledPressAt` はモジュールに1つなので、テストごとに時刻をずらして独立させる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_PRESS_MS, claimPress, parsePressedAt } from "./handsfreeLaunch.ts";

test("parsePressedAt は数字だけの文字列を時刻として読む", () => {
  assert.equal(parsePressedAt("1790343087695"), 1790343087695);
  assert.equal(parsePressedAt(undefined), null);
  assert.equal(parsePressedAt("abc"), null);
  assert.equal(parsePressedAt("12a"), null);
  assert.equal(parsePressedAt(["1790343087695"]), null);
});

test("useURL が古いURLを遅れて返しても、二重に処理しない（実機で起きた順序）", () => {
  const press = 1_800_000_000_000;
  const oldLaunch = press - 16 * 60 * 1000; // 約16分前の起動時のURL
  assert.equal(claimPress(press, press + 900), "new");
  assert.equal(claimPress(oldLaunch, press + 1_100), "duplicate");
  assert.equal(claimPress(press, press + 1_200), "duplicate"); // 同じURLの再評価
  assert.equal(claimPress(press + 8_000, press + 8_300), "new"); // 本当の2回目の押下
});

test("古すぎる押下は捨て、処理済みにもしない", () => {
  const now = 1_900_000_000_000;
  assert.equal(claimPress(now - STALE_PRESS_MS - 1, now), "stale");
  // 捨てた押下より新しい押下は通る（stale は記録されない）
  assert.equal(claimPress(now - 5_000, now), "new");
});
