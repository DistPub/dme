// Web entry point for DME client.
//
// The web bundle no longer contains @shopify/react-native-skia (the only Skia
// consumer left is the native QR renderer, loaded lazily in src/handshake/
// invite-native.ts), so CanvasKit WASM does not need to be preloaded and the
// app can render synchronously with no cross-origin isolation.

// react-native-web's findNodeHandle calls react-dom's findDOMNode, which
// React 18 deprecates. react-native-gesture-handler uses findNodeHandle on
// web, so the warning fires on every GestureDetector. It is non-blocking and
// upstream-fixed in newer versions outside Expo SDK 52's range; filter it
// here to keep the console clean.
const _consoleError = console.error;
console.error = (...args) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('findDOMNode is deprecated')
  ) {
    return;
  }
  _consoleError(...args);
};

import { registerRootComponent } from 'expo';

const App = require('./App').default;
registerRootComponent(App);
