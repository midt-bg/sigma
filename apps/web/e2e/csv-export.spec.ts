import { test, expect } from '@playwright/test';

// Critical flow: CSV export. We fetch the export URL directly instead of driving a browser download
// — the CSV route streams from R2 behind a rate limiter, which makes the download event flaky. A
// single request stays well under the limiter budget and still exercises the streamed response.
test.describe('CSV export', () => {
  test('contracts CSV link resolves to a streamed CSV', async ({ page, request }) => {
    await page.goto('/contracts');

    const link = page.getByRole('link', { name: 'Изтегли CSV' });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    expect(href).toContain('/contracts.csv');

    const res = await request.get(href!);
    // The CSV is streamed, so the response is 206 Partial Content (or 200 for a small body).
    expect([200, 206]).toContain(res.status());
    expect(res.headers()['content-type']).toContain('csv');

    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // First line is a header row with delimited columns.
    expect(body.split('\n')[0]).toContain(',');
  });
});
