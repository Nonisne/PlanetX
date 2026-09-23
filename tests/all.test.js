// Runs every test file in its own process.
//
// `node --test <dir>` spawns children with piped stdio, which this sandbox denies
// (EPERM); spawnSync with inherited stdio is allowed, and it gives each file a pristine
// global environment — which matters because these files install DOM/fetch/storage
// stubs and would otherwise contaminate one another.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const files = [
  'rules.test.js',
  'launcher.test.js',
  'research.test.js',
  'puzzles.test.js',
  'expert-puzzles.test.js',
  'builtin-room.test.js',
  'setup-config.test.js',
  'tutorial.test.js',
  'tutorial-server.test.js',
  'record-parity.test.js',
  'console.test.js',
  'theory-inventory.test.js',
  'dwarf-belt.test.js',
  'official-rules.test.js',
  'review-order.test.js',
  'room.test.js',
  'archive.test.js',
  'server.test.js',
  'client.test.js',
  'client-config.test.js',
  'app-state.test.js',
  'ui.smoke.test.js',
  'tutorial-ui.test.js',
  'history-ui.test.js',
  'endgame-ui.test.js',
  'bot.test.js',
];

const results = [];
for (const file of files) {
  // Opening order is shuffled in real games. Pin it here so existing cases
  // that walk the host's first turn stay deterministic. A test can still set
  // `room.rng` before start-game to choose someone else.
  const res = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    cwd: repo,
    env: { ...process.env, PLANETX_TEST_PIN_OPENING: '1' },
  });
  if (res.error) console.error(`${file}: ${res.error.message}`);
  results.push({ file, ok: res.status === 0 });
}

const failed = results.filter((r) => !r.ok);
console.log('\n──────── summary ────────');
for (const r of results) console.log(`${r.ok ? '✔' : '✖'}  ${r.file}`);
console.log(failed.length ? `${failed.length} of ${results.length} test files failed` : `all ${results.length} test files passed`);
process.exit(failed.length ? 1 : 0);
