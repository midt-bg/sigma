import { test, expect } from '@playwright/test';

// Critical flow: hero search → results. Asserts the round-trip through the /search loader (which
// queries D1) without depending on specific sample rows — the page either lists results or shows a
// graceful empty state, both of which prove the pipeline ran end-to-end.
test.describe('search', () => {
  test('hero search submits and renders the search page', async ({ page }) => {
    await page.goto('/');

    const hero = page.locator('.smart-search--hero');
    await expect(hero).toBeVisible();

    // The hero field carries role="combobox" (it offers autocomplete suggestions), so target it by
    // its form field name rather than the searchbox role.
    await hero.locator('input[name="q"]').fill('договор');
    await hero.getByRole('button', { name: 'Намери' }).click();

    await expect(page).toHaveURL(/\/search\?q=/);
    // PageHeader renders the echoed query as the <h1> on the results page.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('договор');
  });
});
