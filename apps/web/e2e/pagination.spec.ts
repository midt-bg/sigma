import { test, expect } from '@playwright/test';

// Critical flow: pagination. The pager only renders a "Следваща" link when a next page exists, so
// with a small sample seed this may be a single page — we skip rather than fail in that case.
test.describe('pagination', () => {
  test('advances to the next page when one exists', async ({ page }) => {
    await page.goto('/contracts');

    const pager = page.getByRole('navigation', { name: 'Навигация по страници' });
    const next = pager.getByRole('link', { name: /Следваща/ });

    test.skip((await next.count()) === 0, 'single page of results in the sample seed');

    const before = page.url();
    await next.click();

    await expect(page).not.toHaveURL(before);
    await expect(page.locator('.contract-row').first()).toBeVisible();
  });
});
