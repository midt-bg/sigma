import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Accessibility smoke over the key pages. For a government site a11y is mandatory; this is the
// regression net (concrete fixes live in #71/#73). The gate fails only on serious/critical
// violations to stay actionable — minor/moderate issues are surfaced but not blocking initially.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Known pre-existing serious violations, owned by the a11y-fix issues #71/#73: `definition-list` on
// the home page and `nested-interactive` on the list pages. Baselined so this net blocks NEW
// serious/critical regressions without failing on debt this PR is not scoped to fix. Remove ids here
// as #71/#73 land.
const BASELINE_RULES = new Set(['definition-list', 'nested-interactive']);

async function scanBlocking(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.filter(
    (v) => (v.impact === 'serious' || v.impact === 'critical') && !BASELINE_RULES.has(v.id),
  );
}

function describeViolations(violations: Awaited<ReturnType<typeof scanBlocking>>) {
  return violations.map((v) => `${v.id} (${v.impact}): ${v.help}`).join('\n');
}

const STATIC_PAGES = [
  { name: 'home', path: '/' },
  { name: 'contracts list', path: '/contracts' },
  { name: 'methodology', path: '/methodology' },
];

for (const { name, path } of STATIC_PAGES) {
  test(`a11y smoke: ${name}`, async ({ page }) => {
    await page.goto(path);
    const blocking = await scanBlocking(page);
    expect(
      blocking,
      `axe found blocking violations on ${name}:\n${describeViolations(blocking)}`,
    ).toEqual([]);
  });
}

test('a11y smoke: contract detail', async ({ page }) => {
  await page.goto('/contracts');
  const firstTitle = page.locator('.contract-row .title').first();
  test.skip((await firstTitle.count()) === 0, 'no contracts in the sample seed');

  await firstTitle.click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const blocking = await scanBlocking(page);
  expect(
    blocking,
    `axe found blocking violations on contract detail:\n${describeViolations(blocking)}`,
  ).toEqual([]);
});
