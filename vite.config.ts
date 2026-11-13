import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built page works from any folder on a static host.
  base: './',
  // Keep the dev server's dependency cache out of the project folder: when the
  // project lives in a synced folder (Dropbox, OneDrive...), the sync client
  // can lock the cache mid-update and the page then fails to load.
  cacheDir: path.join(os.tmpdir(), 'openrelief-vite-cache'),
});
