// Global setup for the integration vitest project. Boots the wrangler proxy once per
// test run, applies migrations manually, seeds the fixture, and disposes on exit.
import { readFileSync } from 'node:fs';
import wrangler from 'wrangler';
import { MIG_0000, MIG_0001, WRANGLER_JSONC } from './paths';
import {
  buildContractsInsert,
  FIXTURE_STATEMENTS,
  stripSqlCommentsAndCollapse,
} from './helpers/fixtures';

export async function setup() {
  const proxy = await wrangler.getPlatformProxy({
    configPath: WRANGLER_JSONC,
    persist: false,
    remoteBindings: false,
  });

  // Apply migrations
  for (const s of stripSqlCommentsAndCollapse(readFileSync(MIG_0000, 'utf8'))) {
    await proxy.env.DB.exec(s);
  }
  for (const s of stripSqlCommentsAndCollapse(readFileSync(MIG_0001, 'utf8'))) {
    await proxy.env.DB.exec(s);
  }

  // Apply fixture
  for (const stmt of [...FIXTURE_STATEMENTS, buildContractsInsert(30)]) {
    await proxy.env.DB.exec(stmt);
  }

  // Stash for tests to import
  // The vitest globalSetup hooks `globalThis.__SIGMA_PROXY__` (ugly but minimal).
  // Production surface would move this to a module export — deferred.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__SIGMA_PROXY__ = proxy;

  return async () => {
    try {
      await proxy.dispose();
    } catch (e) {
      console.warn('proxy.dispose failed', e);
    }
  };
}
