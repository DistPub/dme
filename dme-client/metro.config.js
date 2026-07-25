/**
 * metro.config.js - DME client Metro configuration.
 *
 * Enables package.json `exports` field resolution so packages that only
 * declare `exports` (no `main`) -- e.g. @atproto/identity -- resolve
 * correctly. Expo's default config already sets up the matching condition
 * names (require/import) and per-platform conditions (react-native/browser).
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;

module.exports = config;
