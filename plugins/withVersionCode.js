const { withAppBuildGradle } = require("@expo/config-plugins");

// `app.json` の `version` から `versionCode` を導出する。
//
// ⚠️ **Playは同じ `versionCode` を二度受け付けない。**
// 素の雛形は `versionCode 1` で固定されており、**上げ忘れるとアップロードが弾かれる。**
//
// 📌 **本プロジェクトには既に「`version` を上げたらタグを打つ」規約がある**ので、
// **そこに乗せて上げ忘れの経路を1本に減らす**（`adr/009`）。
//
// ⚠️ **各桁は99までしか使えない**（`1.34.0` → `13400`）。
// この規模では問題にならないが、`minor` が100に達したら桁を広げること。
//
// ⚠️ **`android/app/build.gradle` を直接編集しても無駄。**
// prebuild が作り直すので、config plugin から書く必要がある。
const toVersionCode = (version) => {
  const parts = String(version ?? "").split(".");
  if (parts.length !== 3) {
    throw new Error(
      `withVersionCode: app.json の version は "major.minor.patch" 形式であること (受け取った値: ${version})`,
    );
  }
  const [major, minor, patch] = parts.map((part) => {
    // ⚠️ `Number()` は " 1" や "0x3" まで通してしまい、タイポが例外ではなく
    // **静かに別の番号**になる。桁の形そのものを見る。
    if (!/^\d{1,2}$/.test(part)) {
      throw new Error(
        `withVersionCode: version の各桁は 0〜99 の整数であること (受け取った値: ${version})`,
      );
    }
    return Number(part);
  });

  const versionCode = major * 10000 + minor * 100 + patch;
  // ⚠️ **Playは versionCode に 1 以上を要求する**（`0.0.0` だと 0 になる）。
  if (versionCode < 1) {
    throw new Error(
      `withVersionCode: versionCode は 1 以上であること (受け取った値: ${version})`,
    );
  }
  return versionCode;
};

const withVersionCode = (config) => {
  return withAppBuildGradle(config, (config) => {
    const versionCode = toVersionCode(config.version);
    const pattern = /versionCode\s+\d+/;
    if (!pattern.test(config.modResults.contents)) {
      throw new Error(
        "withVersionCode: build.gradle に versionCode が見つからない",
      );
    }
    config.modResults.contents = config.modResults.contents.replace(
      pattern,
      `versionCode ${versionCode}`,
    );
    return config;
  });
};

module.exports = withVersionCode;
module.exports.toVersionCode = toVersionCode;
