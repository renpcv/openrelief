// Publishes the built page (dist/) to the repository's gh-pages branch, which
// GitHub Pages serves. Run with `npm run deploy` (it builds first).
// Needs git, and push access to the "origin" remote.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first.');
const remote = git(root, 'remote', 'get-url', 'origin');
const commit = git(root, 'rev-parse', '--short', 'HEAD');
const dirty = git(root, 'status', '--porcelain') !== '';

// A fresh one-commit repository each time: the branch only ever holds the current build.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openrelief-deploy-'));
try {
  fs.cpSync(dist, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, '.nojekyll'), ''); // serve files as they are
  git(tmp, 'init', '-q', '-b', 'gh-pages');
  git(tmp, 'config', 'user.name', git(root, 'config', 'user.name'));
  git(tmp, 'config', 'user.email', git(root, 'config', 'user.email'));
  git(tmp, 'config', 'core.autocrlf', 'false');
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', `Deploy ${commit}${dirty ? ' (with uncommitted changes)' : ''}`);
  git(tmp, 'push', '-q', '-f', remote, 'gh-pages');
  console.log(`Deployed ${commit} to gh-pages of ${remote}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
