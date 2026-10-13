import { expect, type Page, test } from '@playwright/test';

/**
 * « Corriger et télécharger » sur mobile (390 × 844, tactile) : action principale visible
 * dès la fin de l'analyse, erreurs claires, nouvel essai, et récupération du fichier si
 * le téléchargement automatique échoue. Réussite annoncée seulement une fois le fichier reçu.
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
  // Aucune action préalable : la carte principale est déjà là.
  const panel = page.getByRole('region', { name: 'Votre document corrigé' });
  await expect(panel.getByRole('heading', { name: 'Votre document corrigé' })).toBeVisible();
  const button = panel.getByRole('button', { name: 'Corriger et télécharger' });
  await expect(button).toBeEnabled();
  return { panel, button };
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('Corriger et télécharger sur mobile', () => {
  test('un seul geste depuis le premier écran : la barre du bas prépare et télécharge', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });
    const bar = page.getByTestId('barre-action-principale');
    const action = bar.getByRole('button', { name: 'Corriger et télécharger' });
    await expect(action).toBeInViewport();
    await expect(action).toBeEnabled();
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await action.tap();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    // La carte est amenée à l'écran ; la réussite y est annoncée, la barre a disparu.
    const panel = page.getByRole('region', { name: 'Votre document corrigé' });
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeInViewport();
    await expect(bar).toBeHidden();
    await expectNoHorizontalScroll(page);
  });

  test('barre du bas au clavier : focus transféré au bouton de la carte, conservé pendant tout le traitement', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });
    const bar = page.getByTestId('barre-action-principale');
    const barButton = bar.getByRole('button', { name: 'Corriger et télécharger' });
    await expect(barButton).toBeEnabled();
    const panel = page.getByRole('region', { name: 'Votre document corrigé' });
    const cardButton = panel.locator('[data-action-principale]');
    await barButton.focus();
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await page.keyboard.press('Enter');
    // Focus sur le bouton de la carte, jamais perdu sur la page (y compris quand il passe
    // à « Préparation… » puis « Téléchargement… »).
    await expect(cardButton).toBeFocused();
    await expect(bar).toBeHidden();
    await downloading;
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeVisible();
    await expect(cardButton).toHaveText('Télécharger à nouveau');
    await expect(cardButton).toBeFocused();
  });

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
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeVisible();
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
    // Acceptations des corrections fiables envoyées au serveur.
    let accepts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/issues/accept-reliable')) {
        accepts++;
      }
    });
    const { panel, button } = await openDownload(page);
    await button.tap();
    await expect(panel.getByText('Aucun document corrigé n’a été produit.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText(/a pris trop de temps/)).toBeVisible();
    await expect(panel.getByText(/inutile d’importer de nouveau votre document/)).toBeVisible();
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeHidden();
    const retry = panel.getByRole('button', { name: 'Réessayer' });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport();
    await expectNoHorizontalScroll(page);

    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await retry.tap();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeVisible();
    // Une seule acceptation des corrections fiables, malgré le nouvel essai.
    expect(accepts).toBe(1);
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
    // Jamais annoncé comme téléchargé : le fichier n'a pas été reçu.
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeHidden();
    // Le document est prêt : le bouton le télécharge de nouveau, sans nouvelle préparation.
    const retry = panel.getByRole('button', { name: 'Réessayer le téléchargement' });
    let requests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/exports$/.test(request.url())) requests++;
    });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport();
    const downloading = page.waitForEvent('download');
    await retry.tap();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeVisible();
    expect(requests).toBe(0);
    await expectNoHorizontalScroll(page);
  });
});
