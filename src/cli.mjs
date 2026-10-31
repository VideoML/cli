#!/usr/bin/env node
// Reject an unpinned esbuild override before the TypeScript loader can run.
if (process.env.ESBUILD_BINARY_PATH) {
  console.error('BUNDLE_RUNTIME_MISMATCH: ESBUILD_BINARY_PATH is not permitted');
  process.exitCode=1;
} else {
  const {register}=await import('tsx/esm/api');
  register();
  await import('./cli.ts');
}
