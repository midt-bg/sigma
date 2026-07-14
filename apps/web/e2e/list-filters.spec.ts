import { test, expect } from '@playwright/test';

// Critical flow: filtering a list. Filters live in the URL (shareable), and the FilterRail form
// auto-submits on change. We assert the selected facet lands in the URL and survives a reload —
// the URL is the single source of truth, which stands in for the (not-yet-built) save-filter idea.
test.describe('list filters', () => {
  test('applying a filter updates the URL and persists on reload', async ({ page }) => {
    await page.goto('/contracts');

    const rail = page.getByRole('complementary', { name: 'Филтри' });
    // Pick the first VISIBLE facet checkbox with a name — options inside a collapsed category
    // subgroup are hidden; the top-level facets (year / procedure) render their options directly.
    const facet = rail
      .locator('form label.check:visible')
      .filter({ has: page.locator('input[type="checkbox"][name]') })
      .first();
    await expect(facet).toBeVisible();

    const input = facet.locator('input[type="checkbox"][name]');
    const name = await input.getAttribute('name');
    const value = await input.getAttribute('value');
    expect(name).toBeTruthy();

    // Clicking the label fires the FilterRail form's change handler, which auto-submits the facet
    // into the query string (shareable state).
    await facet.click();
    await expect(page).toHaveURL(new RegExp(`[?&]${name}=`));

    const filteredUrl = page.url();
    await page.goto(filteredUrl);
    // Shareable: reloading the filtered URL keeps the exact facet checked (URL is the source of truth).
    await expect(rail.locator(`form input[name="${name}"][value="${value}"]`)).toBeChecked();
  });
});
