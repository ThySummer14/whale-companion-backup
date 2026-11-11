const { withAndroidManifest } = require('expo/config-plugins')

module.exports = function withNetworkSecurity(config) {
  return withAndroidManifest(config, config => {
    config.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'false'
    return config
  })
}
