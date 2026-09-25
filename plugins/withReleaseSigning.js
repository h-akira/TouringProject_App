const { withAppBuildGradle } = require("@expo/config-plugins");

// release ビルドを **upload key** で署名する。
//
// ⚠️ **素の雛形は release を debug 鍵で署名している**（雛形のコメントにも
// "In production, you need to generate your own keystore file." とある）。
// ⚠️ **debug鍵で署名したものをPlayは受け付けない。**
//
// 📌 **鍵の原本はリポジトリの外**（`~/.keystore/`）に置き、
// **場所とパスワードは `App/.env`（gitignore済）から渡す**（`adr/009`）。
// ⚠️ **鍵もパスワードも絶対にコミットしないこと。**
//
// ⚠️ **パスワードを `build.gradle` に埋め込まない。**
// 埋め込むと**生成物の中に平文で残り**、しかも `android/` は
// **`--clean` を付けない限り作り直されない**ので、**消したつもりでも残る。**
// 📌 **そこで Gradle 側で `System.getenv()` を読む形にする。**
//
// ⚠️ **`gradlew` は `.env` を読まない。** `.env` を自動で読むのは `expo` だけなので、
// **`npm run bundle:play` が `set -a && . ./.env` で明示的に読み込んでいる**
// （直接 `gradlew` を叩くと**黙って debug 署名になる**）。
//
// ⚠️ **環境変数が無いときは debug 鍵のままにする**。
// 日常の開発（`expo run:android`）に鍵は要らないので、**未設定でも止めない。**
// ⚠️ **その場合 release は debug 署名なので、Playには出せない。**
//
// | 環境変数 | 中身 |
// |---|---|
// | `TRG_KEYSTORE_PATH` | `.jks` の場所（絶対パス） |
// | `TRG_KEYSTORE_PASSWORD` | キーストアのパスワード |
// | `TRG_KEY_ALIAS` | 鍵の別名 |
// | `TRG_KEY_PASSWORD` | 鍵のパスワード |
const UPLOAD_SIGNING_CONFIG = `        upload {
            // Values come from the environment at build time, so no secret is
            // ever written into this generated file. See plugins/withReleaseSigning.js.
            def keystorePath = System.getenv('TRG_KEYSTORE_PATH')
            if (keystorePath) {
                storeFile file(keystorePath)
                storePassword System.getenv('TRG_KEYSTORE_PASSWORD')
                keyAlias System.getenv('TRG_KEY_ALIAS')
                keyPassword System.getenv('TRG_KEY_PASSWORD')
            }
        }
`;

// Pick the signing config at build time, so a plain `expo run:android` keeps
// working without a keystore.
const RELEASE_SIGNING = `            // Use the upload key when it is configured; the release build is
            // otherwise debug-signed and cannot be uploaded to Play.
            if (System.getenv('TRG_KEYSTORE_PATH')) {
                signingConfig signingConfigs.upload
            } else {
                signingConfig signingConfigs.debug
            }`;

const withReleaseSigning = (config) => {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    // ⚠️ **prebuild は `--clean` を付けないと `android/` を作り直さない**ので、
    // **書き換え済みの build.gradle に対しても plugin が走る。**
    // ⚠️ **ここで抜けないと、走るたびに署名ブロックが入れ子で二重化していく**
    // （`expo run:android` は内部で prebuild を呼ぶので**日常的に踏む**）。
    if (contents.includes("signingConfigs.upload")) {
      return config;
    }

    const anchor = /signingConfigs\s*\{\n/;
    if (!anchor.test(contents)) {
      throw new Error(
        "withReleaseSigning: build.gradle に signingConfigs が見つからない",
      );
    }
    contents = contents.replace(anchor, `signingConfigs {\n${UPLOAD_SIGNING_CONFIG}`);

    const releaseSigning =
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)^\s*signingConfig signingConfigs\.debug$/m;
    if (!releaseSigning.test(contents)) {
      throw new Error(
        "withReleaseSigning: release の signingConfig が見つからない",
      );
    }
    contents = contents.replace(releaseSigning, `$1${RELEASE_SIGNING}`);

    config.modResults.contents = contents;
    return config;
  });
};

module.exports = withReleaseSigning;
