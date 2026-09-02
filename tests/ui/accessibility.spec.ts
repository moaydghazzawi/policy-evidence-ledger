import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const views = [
  'Research desk',
  'Sources',
  'Claims',
  'Definitions',
  'Comparisons',
  'Decision log',
  'Export',
];

async function selectView(page: import('@playwright/test').Page, view: string) {
  const buttons = page.getByRole('button', { name: view, exact: true });
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const candidate = buttons.nth(index);
    if (await candidate.isVisible()) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`No visible navigation button for ${view}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Local service connected')).toBeVisible();
});

test('main research views have no serious or critical axe violations', async ({
  page,
}) => {
  for (const view of views) {
    await selectView(page, view);
    const results = await new AxeBuilder({ page })
      .options({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })
      .analyze();
    const blocking = results.violations.filter((item) =>
      ['serious', 'critical'].includes(item.impact ?? ''),
    );
    expect(
      blocking,
      `${view}: ${blocking.map((item) => item.id).join(', ')}`,
    ).toEqual([]);
  }
});

test('source dialog is keyboard reachable and every visible field is labelled', async ({
  page,
}) => {
  const addSource = page.getByRole('button', { name: 'Add source' }).first();
  await addSource.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Add a public source' }),
  ).toBeVisible();
  await expect(page.getByLabel('Ingestion mode *')).toBeVisible();
  await expect(page.getByLabel('Title *')).toBeVisible();
  await expect(page.getByLabel('Author or institution *')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze();
  const blocking = results.violations.filter((item) =>
    ['serious', 'critical'].includes(item.impact ?? ''),
  );
  expect(blocking).toEqual([]);
});

for (const viewport of [
  { width: 320, height: 640, label: 'narrow mobile' },
  { width: 390, height: 844, label: 'mobile' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1440, height: 900, label: 'desktop' },
]) {
  test(`${viewport.label} layout has no page-level horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    for (const view of views) {
      await selectView(page, view);
      const dimensions = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(
        dimensions.scroll,
        `${view} overflows at ${viewport.width}px`,
      ).toBeLessThanOrEqual(dimensions.client + 1);
    }
  });
}
