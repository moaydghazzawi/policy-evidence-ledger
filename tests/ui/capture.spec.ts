import path from 'node:path';

import { expect, test } from '@playwright/test';

import demoManifest from '../../demo/manifest.json' with { type: 'json' };
import type { Dashboard } from '../../lib/ledger-types';

async function clickVisibleButton(
  page: import('@playwright/test').Page,
  name: string,
) {
  const buttons = page.getByRole('button', { name, exact: true });
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const candidate = buttons.nth(index);
    if (await candidate.isVisible()) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`No visible button named ${name}`);
}

test('capture canonical public-demo screenshots', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Local service connected')).toBeVisible();
  const dashboard = (await page.evaluate(async () => {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error(`Dashboard returned ${response.status}`);
    return response.json();
  })) as Dashboard;
  expect(dashboard.sources).toHaveLength(demoManifest.sources.length);
  expect(dashboard.claims).toHaveLength(demoManifest.claims.length);
  expect(
    dashboard.sources
      .map((source) => source.url)
      .sort((left, right) => (left ?? '').localeCompare(right ?? '')),
  ).toEqual(
    demoManifest.sources
      .map((source) => source.url)
      .sort((left, right) => left.localeCompare(right)),
  );
  expect(
    dashboard.claims
      .map((claim) => claim.claim_text)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(
    demoManifest.claims
      .map((claim) => claim.claim_text)
      .sort((left, right) => left.localeCompare(right)),
  );
  await page.evaluate(() => document.fonts.ready);

  await page.screenshot({
    path: path.resolve('docs/screenshots/research-desk.png'),
    fullPage: true,
  });

  await clickVisibleButton(page, 'Claims');
  await expect(
    page.getByRole('heading', { name: 'Make the reasoning inspectable.' }),
  ).toBeVisible();
  await page.screenshot({
    path: path.resolve('docs/screenshots/claim-cards.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await clickVisibleButton(page, 'Research desk');
  await expect(
    page.getByRole('heading', {
      name: 'Trace each conclusion back to the record.',
    }),
  ).toBeVisible();
  await page.screenshot({
    path: path.resolve('docs/screenshots/mobile-research-desk.png'),
    fullPage: true,
  });
});
