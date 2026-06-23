import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/**/*.ts'],
  format: 'esm',
  outDir: 'lib-tsdown',
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  // Emit `.js` / `.d.ts` (not `.mjs` / `.d.mts`) so bin/main/exports resolve.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
