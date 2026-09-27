// Web entry point for DME client.
//
// @shopify/react-native-skia creates its Skia JSI object at module import
// time, reading global.CanvasKit. On web, CanvasKit WASM must be loaded
// BEFORE the Skia module is imported -- otherwise Skia.Matrix etc. are
// undefined. This entry delays importing App (and transitively Skia) until
// LoadSkiaWeb has populated global.CanvasKit.

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

import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { registerRootComponent } from 'expo';

LoadSkiaWeb({ locateFile: (file) => `./${file}` })
  .then(() => import('./App'))
  .then(({ default: App }) => {
    registerRootComponent(App);
  })
  .catch((err) => {
    _consoleError('Failed to initialize CanvasKit:', err);
  });
