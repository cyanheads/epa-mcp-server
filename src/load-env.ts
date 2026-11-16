/**
 * @fileoverview Loads `.env` into `process.env` before any other module evaluates. ES module
 * imports run before the importing module's body, so `src/index.ts` imports this file first:
 * settings read while tool definitions are built (the count-input schemas read
 * `EPA_CLAMP_LIMITS`) then see `.env` under Node as well as Bun, which loads it on its own.
 * @module load-env
 */

try {
  process.loadEnvFile();
} catch {
  /* A missing `.env` is the normal case. Any other read failure is left to `createApp()`, which
     loads the file again and stops with its configuration-error banner instead of a raw stack. */
}
