import { test, expect } from '@playwright/test';

// Critical flow: pagination. The E2E seed carries 20 contracts against PAGE_SIZE.contracts = 15, so a
// next page always exists — assert the pager rather than skip on it, or a broken pager selector would
// turn a real regression into a silent green skip.
test.describe('pagination', () => {
  test('advances to the next page when one exists', async ({ page }) => {
    await page.goto('/contracts');

    const pager = page.getByRole('navigation', { name: 'Навигация по страници' });
    const next = pager.getByRole('link', { name: /Следваща/ });

    await expect(next).toBeVisible();

    const before = page.url();
    await next.click();

    await expect(page).not.toHaveURL(before);
    await expect(page.locator('.contract-row').first()).toBeVisible();
  });
});
