// Capacitor 6 expects tar's historical default export. tar 7 keeps the same
// extract API but uses named exports; supply only the compatibility alias.
// This lets the existing Android platform use the patched tar release.
const tar = require('tar');
if (!tar.default) Object.defineProperty(tar, 'default', { value: tar });
require('@capacitor/cli/bin/capacitor');
