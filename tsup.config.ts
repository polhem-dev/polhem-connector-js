import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  clean: true,
  sourcemap: true,

  // NOTE: declarations are emitted by `tsc` (see the build script), not here. tsup bundles
  // `rollup-plugin-dts`, which reaches into TypeScript's internals and expects the 5.x API —
  // against TypeScript 7 it dies with `Cannot read properties of undefined
  // (reading 'useCaseSensitiveFileNames')`. Emitting with the compiler itself avoids depending on
  // a plugin keeping up with the compiler.
  dts: false,
});
