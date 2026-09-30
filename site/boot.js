/**
 * Entry point of the static GitHub Pages build.
 *
 * Import order matters and is guaranteed by the ES module spec: `local-api.js`
 * fully evaluates (patching `window.fetch`) before `app.js` is evaluated and
 * runs its `boot()`.
 */

import './local-api.js';
import './app.js';
