import { expect, type Page, test } from '@playwright/test';

/**
 * « Télécharger les modifications » sur mobile (390 × 844, tactile) : erreurs claires,
 * nouvel essai, et récupération du fichier si le téléchargement automatique échoue.
 * Les pannes sont simulées dans le navigateur ; le serveur, lui, est réel.
 */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const ERROR_BODY = {
  error: {
    code: 'INTERNAL_ERROR',
    message: 'Une erreur inattendue est survenue. Réessayez dans un instant.',
  },
};

async function openDownload(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
  await page.getByRole('button', { name: /Lancer l’analyse/ }).click();
  await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole('navigation', { name: 'Actions' })
    .getByRole('button', { name: 'Télécharger les modifications' })
    .click();
  const panel = page.getByRole('region', { name: 'Télécharger les modifications' });
  await expect(
    panel.getByRole('heading', { name: 'Télécharger les modifications' }),
  ).toBeInViewport();
  const button = panel.getByRole('button', { name: 'Télécharger les modifications' });
  await expect(button).toBeEnabled();
  return { panel, button };
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('Télécharger sur mobile', () => {
  test('demande refusée par le serveur : message clair, puis nouvel essai qui aboutit', async ({
    page,
  }) => {
    let refused = 0;
    await page.route('**/api/analyses/*/exports', async (route) => {
      if (route.request().method() === 'POST' && refused === 0) {
        refused++;
        await route.fulfill({ status: 503, json: ERROR_BODY });
        return;
      }
      await route.continue();
    });
    const { panel, button } = await openDownload(page);
    await button.tap();
    const message = panel.getByText(ERROR_BODY.error.message);
    await expect(message).toBeVisible();
    await message.scrollIntoViewIfNeeded();
    await expect(message).toBeInViewport();
    expect(refused).toBe(1);
    await expectNoHorizontalScroll(page);

    // Nouvel essai : le même bouton, toujours disponible.
    await expect(button).toBeEnabled();
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await button.tap();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    await expect(panel.getByText(/Document prêt :/)).toBeVisible();
    await expect(message).toBeHidden();
  });

  test('préparation en échec (délai dépassé) : « Réessayer », puis téléchargement', async ({
    page,
  }) => {
    let failed = 0;
    await page.route(/\/api\/exports\/exp_[0-9a-z]+$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      if (failed === 0 && body.status === 'READY') {
        failed++;
        await route.fulfill({
          response,
          json: { ...body, status: 'FAILED', errorCode: 'EXPORT_TIMEOUT' },
        });
        return;
      }
      await route.fulfill({ response, json: body });
    });
    const { panel, button } = await openDownload(page);
    await button.tap();
    await expect(panel.getByText('Aucun document corrigé n’a été produit.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText(/a pris trop de temps/)).toBeVisible();
    const retry = panel.getByRole('button', { name: 'Réessayer' });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport();
    await expectNoHorizontalScroll(page);

    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await retry.tap();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    await expect(panel.getByText(/Document prêt :/)).toBeVisible();
  });

  test('téléchargement automatique en échec : message, puis récupération du fichier par le bouton', async ({
    page,
  }) => {
    let blocked = 0;
    await page.route('**/api/exports/*/download', async (route) => {
      if (blocked === 0) {
        blocked++;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const { panel, button } = await openDownload(page);
    await button.tap();
    await expect(panel.getByText(/Document prêt :/)).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.getByText('Connexion impossible. Vérifiez votre accès à Internet puis réessayez.'),
    ).toBeVisible();
    expect(blocked).toBe(1);
    // Le document est prêt : le même bouton le télécharge, sans nouvelle préparation.
    let requests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/exports$/.test(request.url())) requests++;
    });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    const downloading = page.waitForEvent('download');
    await button.tap();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    await expect(panel.getByText(/Téléchargement lancé/)).toBeVisible();
    expect(requests).toBe(0);
    await expectNoHorizontalScroll(page);
  });
});
