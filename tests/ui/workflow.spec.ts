import { expect, test } from '@playwright/test';

import type { Dashboard } from '../../lib/ledger-types';

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

test('browser upload preserves bytes and optional public URL metadata', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Add source' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a public source' });
  await dialog.getByLabel('Ingestion mode *').selectOption('upload');
  await dialog.getByLabel('Title *').fill('Uploaded public record');
  await dialog
    .getByLabel('Author or institution *')
    .fill('Public test institution');
  await dialog.getByLabel('Source type *').selectOption('report');
  await dialog
    .getByLabel('Public/source URL (optional)')
    .fill('https://example.gov/uploaded-record');
  await dialog.getByLabel('Local file *').setInputFiles({
    name: 'uploaded-record.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<html><body>Public test record</body></html>'),
  });
  await dialog.getByRole('button', { name: 'Preserve source' }).click();
  await expect(dialog).toBeHidden();

  const dashboard = (await page.evaluate(async () => {
    const response = await fetch('/api/dashboard');
    return response.json();
  })) as Dashboard;
  const uploaded = dashboard.sources.find(
    (source) => source.title === 'Uploaded public record',
  );
  expect(uploaded).toMatchObject({
    ingest_mode: 'upload',
    url: 'https://example.gov/uploaded-record',
    metadata_status: 'pending',
  });
  expect(uploaded?.document_hash).toMatch(/^[0-9a-f]{64}$/);
});

test('browser workflow verifies a source, records evidence, and downloads an export', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Add source' }).first().click();
  const sourceDialog = page.getByRole('dialog', {
    name: 'Add a public source',
  });
  await sourceDialog.getByLabel('Ingestion mode *').selectOption('manual');
  await sourceDialog.getByLabel('Title *').fill('Browser workflow record');
  await sourceDialog
    .getByLabel('Author or institution *')
    .fill('Public test institution');
  await sourceDialog
    .getByLabel('Source type *')
    .selectOption('official_statement');
  await sourceDialog.getByRole('button', { name: 'Preserve source' }).click();
  await expect(sourceDialog).toBeHidden();
  await expect(page.getByText('Source metadata marked verified.')).toHaveCount(
    0,
  );

  await selectView(page, 'Sources');
  const sourceRow = page
    .getByRole('row')
    .filter({ hasText: 'Browser workflow record' });
  await expect(sourceRow).toBeVisible();
  await sourceRow.getByRole('button', { name: 'Verify metadata' }).click();
  await expect(
    page.getByText('Source metadata marked verified.'),
  ).toBeVisible();

  await selectView(page, 'Claims');
  await page.getByRole('button', { name: 'Capture claim' }).click();
  const claimDialog = page.getByRole('dialog', {
    name: 'Capture a structured claim',
  });
  await claimDialog
    .getByLabel('Claim in plain language *')
    .fill('The browser workflow preserves a traceable policy proposition.');
  await claimDialog
    .getByLabel('Researcher interpretation *')
    .fill('This is a browser-level workflow check.');
  await claimDialog
    .getByLabel('Known limitation *')
    .fill('The record exists only for automated verification.');
  await claimDialog.getByLabel('Confidence *').selectOption('moderate');
  await claimDialog.getByLabel('Status *').selectOption('supported');
  await claimDialog.getByLabel('Policy outcome *').fill('Workflow integrity');
  await claimDialog.getByLabel('Case').fill('Browser test');
  await claimDialog.getByLabel('Time period').fill('2026');
  await claimDialog.getByRole('button', { name: 'Capture claim' }).click();
  await expect(claimDialog).toBeHidden();

  const dashboard = (await page.evaluate(async () => {
    const response = await fetch('/api/dashboard');
    return response.json();
  })) as Dashboard;
  const claim = dashboard.claims.find((item) =>
    item.claim_text.startsWith('The browser workflow'),
  );
  const source = dashboard.sources.find(
    (item) => item.title === 'Browser workflow record',
  );
  if (!claim || !source) {
    throw new Error(
      'New browser workflow records were not returned by the API',
    );
  }

  await page.getByRole('button', { name: 'Add evidence' }).click();
  const evidenceDialog = page.getByRole('dialog', {
    name: 'Record located evidence',
  });
  await evidenceDialog.getByLabel('Claim *').selectOption(claim.id);
  await evidenceDialog.getByLabel('Source *').selectOption(source.id);
  await evidenceDialog.getByLabel('Role *').selectOption('supporting');
  await evidenceDialog.getByLabel('Record type *').selectOption('data_point');
  await evidenceDialog.getByLabel('Review state *').selectOption('approved');
  await evidenceDialog
    .getByLabel('Exact passage or data point *')
    .fill('The browser workflow record contains a located policy data point.');
  await evidenceDialog.getByLabel('Locator type').selectOption('paragraph');
  await evidenceDialog.getByLabel('Locator *').fill('paragraph 3');
  await evidenceDialog
    .getByLabel('Reviewer note')
    .fill('Checked by the browser workflow test.');
  await evidenceDialog.getByRole('button', { name: 'Record evidence' }).click();
  await expect(evidenceDialog).toBeHidden();

  await selectView(page, 'Export');
  await expect(page.getByText('Ready to export')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download research bundle' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^policy-evidence-ledger-\d{4}-\d{2}-\d{2}\.zip$/,
  );
});

test('failed draft approval announces the error inside the active dialog', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Add source' }).first().click();
  const sourceDialog = page.getByRole('dialog', {
    name: 'Add a public source',
  });
  await sourceDialog.getByLabel('Ingestion mode *').selectOption('manual');
  await sourceDialog.getByLabel('Title *').fill('Pending browser source');
  await sourceDialog
    .getByLabel('Author or institution *')
    .fill('Public test institution');
  await sourceDialog
    .getByLabel('Source type *')
    .selectOption('official_statement');
  await sourceDialog.getByRole('button', { name: 'Preserve source' }).click();
  await expect(sourceDialog).toBeHidden();

  const dashboard = (await page.evaluate(async () => {
    const response = await fetch('/api/dashboard');
    return response.json();
  })) as Dashboard;
  const source = dashboard.sources.find(
    (item) => item.title === 'Pending browser source',
  );
  const claim = dashboard.claims[0];
  if (!source) {
    throw new Error('Pending browser source was not returned by the API');
  }

  await selectView(page, 'Claims');
  await page.getByRole('button', { name: 'Add evidence' }).click();
  const evidenceDialog = page.getByRole('dialog', {
    name: 'Record located evidence',
  });
  await evidenceDialog.getByLabel('Claim *').selectOption(claim.id);
  await evidenceDialog.getByLabel('Source *').selectOption(source.id);
  await evidenceDialog
    .getByLabel('Exact passage or data point *')
    .fill('Draft record awaiting metadata verification.');
  await evidenceDialog.getByRole('button', { name: 'Record evidence' }).click();
  await expect(evidenceDialog).toBeHidden();

  const draft = page
    .locator('article')
    .filter({ hasText: 'Draft record awaiting metadata verification.' });
  await draft.getByRole('button', { name: 'Review and approve' }).click();
  const approvalDialog = page.getByRole('dialog', {
    name: 'Review and approve evidence',
  });
  await approvalDialog.getByLabel('Locator *').fill('paragraph 2');
  await approvalDialog
    .getByRole('button', { name: 'Approve evidence' })
    .click();
  const dialogAlert = approvalDialog.getByRole('alert');
  await expect(dialogAlert).toContainText(
    'evidence cannot be approved until source metadata is verified',
  );
  await expect(approvalDialog).toBeVisible();
});

test('320px layout and long-form dialogs remain reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await selectView(page, 'Decision log');
  await page.getByRole('button', { name: 'Record decision' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Record a research decision',
  });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
  const dimensions = await dialog.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThanOrEqual(
    dimensions.clientHeight,
  );
});
