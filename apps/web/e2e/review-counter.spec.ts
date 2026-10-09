import { expect, type Page, test } from '@playwright/test';

/**
 * Compteur « points traités » dans un vrai navigateur (site, API, worker, base) :
 * il suit chaque décision, même si la relecture de l'analyse est refusée (limite de
 * débit de l'API), ne dépend pas des filtres et survit au rechargement. À chaque
 * étape, le compteur affiché est comparé à celui que renvoie le serveur.
 */
async function serverReviewedCount(page: Page, analysisId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/analyses/${id}`);
    return ((await response.json()) as { reviewedCount: number }).reviewedCount;
  }, analysisId);
}

test('compteur « points traités » : décisions, relecture refusée, filtres, rechargement', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
  await page.getByRole('button', { name: /Lancer l’analyse/ }).click();
  await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });
  const analysisId = /ana_[0-9a-z]{20}/.exec(page.url())?.[0] ?? '';
  const counter = page.getByText(/\d+ \/ \d+ points traités/);
  await expect(counter).toHaveText(/^0 \/ \d+ points traités$/);
  const total = Number(/\/ (\d+)/.exec((await counter.textContent()) ?? '')?.[1]);
  const detail = page.getByRole('article', { name: 'Détail du point' });

  // 1. « Ignorer » alors que l'API refuse de relire l'analyse (429) : le compteur suit
  //    quand même, grâce au compteur renvoyé par le PATCH.
  let refused = 0;
  const analysisUrl = new RegExp(`/api/analyses/${analysisId}$`);
  await page.route(analysisUrl, (route) => {
    refused++;
    return route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Trop de requêtes.' } }),
    });
  });
  await detail.getByRole('button', { name: 'Ignorer' }).click();
  await expect(counter).toHaveText(`1 / ${total} points traités`);
  expect(refused).toBeGreaterThan(0);
  await page.unroute(analysisUrl);
  expect(await serverReviewedCount(page, analysisId)).toBe(1);
  await page.mouse.move(5, 5); // le message « Point ignoré. » ne doit pas masquer les boutons

  // 2. Filtre par nature, puis « J’ai vérifié » sur un point à examiner.
  const natures = page.getByRole('group', { name: 'Filtrer par nature' });
  await natures.getByRole('button', { name: /À examiner/ }).click();
  await expect(counter).toHaveText(`1 / ${total} points traités`);
  await detail.getByRole('button', { name: 'J’ai vérifié' }).click();
  await expect(counter).toHaveText(`2 / ${total} points traités`);
  expect(await serverReviewedCount(page, analysisId)).toBe(2);

  // 3. Vue « Traités » et retour à toutes les natures : le compteur reste global.
  await natures.getByRole('button', { name: /À examiner/ }).click();
  await page
    .getByRole('group', { name: 'Afficher' })
    .getByRole('button', { name: 'Traités' })
    .click();
  await expect(page).toHaveURL(/vue=done/);
  await expect(counter).toHaveText(`2 / ${total} points traités`);
  const treated = page.getByRole('navigation', { name: 'Points relevés' }).getByLabel('Traité');
  await expect(treated).toHaveCount(2);

  // 4. Rechargement : même compteur, mêmes points traités, relus depuis le serveur.
  await page.reload();
  await expect(counter).toHaveText(`2 / ${total} points traités`);
  await expect(treated).toHaveCount(2);
});
