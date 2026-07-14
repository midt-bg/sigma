import { test, expect } from '@playwright/test';

// Critical flow: mobile navigation. Runs under the `mobile-chrome` project (Pixel 5 viewport),
// where the primary nav is collapsed behind the "Меню" toggle.
test.describe('mobile navigation', () => {
  test('menu opens and routes to a section', async ({ page }) => {
    await page.goto('/');

    const nav = page.locator('.site-nav');
    const toggle = page.getByRole('button', { name: 'Меню' });
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(nav).toHaveClass(/is-open/);

    const link = nav.getByRole('link').first();
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();

    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });
});
