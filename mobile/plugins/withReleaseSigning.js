// Assina a release com a chave própria do app (credentials/, fora do git) em vez da chave de debug.
// Com a mesma chave sempre, as atualizações instalam por cima sem precisar desinstalar.
// Se credentials/release.properties não existir, a release continua com a chave de debug.
const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING = `
        release {
            def props = new Properties()
            def propsFile = rootProject.file('../credentials/release.properties')
            if (propsFile.exists()) {
                propsFile.withInputStream { props.load(it) }
                storeFile rootProject.file('../credentials/' + props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (!gradle.includes("credentials/release.properties")) {
      gradle = gradle.replace(/signingConfigs\s*\{\s*debug\s*\{[^}]*\}/, (m) => m + SIGNING);
      gradle = gradle.replace(
        /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/,
        "$1signingConfig rootProject.file('../credentials/release.properties').exists() ? signingConfigs.release : signingConfigs.debug",
      );
    }
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
