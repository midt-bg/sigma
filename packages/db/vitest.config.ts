import { defineConfig } from 'vitest/config';

// The db suite is real-SQLite integration style: tests shell out to the sqlite3 CLI dozens of
// times each, and the heaviest (ship-domain) legitimately runs for around a minute. On loaded CI
// runners individual tests can exceed vitest's 5s default timeout and fail flaky (seen on the
// refresh-slice EOP derivation test), so give the whole suite generous headroom - correctness
// here is asserted by the checks, not by speed.
export default defineConfig({
  test: { testTimeout: 120_000 },
});
