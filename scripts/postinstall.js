// Postinstall: copy lottie-web's prebuilt UMD player into renderer/vendor so
// the renderer (sandbox:true, file://) can <script src> it without fetch().
//
// Why a copy step instead of a bundler? The project deliberately avoids a
// build pipeline. The single runtime dep we accept is lottie-web; making it
// loadable from the renderer is just a file copy.
//
// This script intentionally never throws — if lottie-web isn't installed
// (e.g. offline dev, or someone running with --omit=optional), we just log a
// warning so the rest of the install isn't disturbed. The renderer checks
// `window.lottie` at runtime and degrades gracefully.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(
  __dirname,
  '..',
  'node_modules',
  'lottie-web',
  'build',
  'player',
  'lottie.min.js',
);
const DEST_DIR = path.join(__dirname, '..', 'renderer', 'vendor');
const DEST = path.join(DEST_DIR, 'lottie.min.js');

function main() {
  if (!fs.existsSync(SRC)) {
    console.warn(
      `[gaya postinstall] lottie-web not found at ${SRC}; skipping copy. ` +
        `Run \`npm install lottie-web\` if you want Lottie pack support.`,
    );
    return;
  }
  try {
    fs.mkdirSync(DEST_DIR, { recursive: true });
    fs.copyFileSync(SRC, DEST);
    console.log(`[gaya postinstall] copied lottie.min.js -> ${path.relative(process.cwd(), DEST)}`);
  } catch (err) {
    console.warn('[gaya postinstall] failed to copy lottie.min.js:', err.message);
  }
}

try {
  main();
} catch (err) {
  console.warn('[gaya postinstall] unexpected error (ignored):', err && err.message);
}

// Always exit success so npm install doesn't abort on lottie issues.
process.exit(0);
