import { build } from 'esbuild';
import fs from 'node:fs';
await build({
  entryPoints: ['wallet-entry.js'], bundle: true, format: 'esm', minify: true, target: 'es2020',
  platform: 'browser', outfile: '../public/js/wallet.js', define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none', inject: ['shims.js'],
});
fs.copyFileSync('node_modules/@near-wallet-selector/modal-ui/styles.css', '../public/css/wallet-modal.css');
console.log('built public/js/wallet.js', fs.statSync('../public/js/wallet.js').size, 'bytes');
