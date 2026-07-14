import { test, expect } from '@playwright/test';

// Critical flow: list → contract detail. Navigates from the first list row and confirms the detail
// page renders its subject as the <h1>.
test.describe('contract detail', () => {
  test('navigating from the list opens a contract page', async ({ page }) => {
    await page.goto('/contracts');

    const firstTitle = page.locator('.contract-row .title').first();
    await expect(firstTitle).toBeVisible();

    await firstTitle.click();
    await expect(page).toHaveURL(/\/contracts\/.+/);

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    await expect(heading).not.toHaveText('');
  });
});
