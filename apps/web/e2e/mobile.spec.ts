import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('sur mobile : action principale à l’écran, actions facultatives empilées, panneau amené à l’écran, détail en panneau', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
  await page.getByRole('button', { name: /Lancer l’analyse/ }).click();
  await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });

  // L'action principale est à l'écran dès la fin de l'analyse, sans défiler : la carte est
  // sous la partie supérieure, son bouton est repris dans une barre en bas de l'écran.
  await expect(
    page
      .getByTestId('barre-action-principale')
      .getByRole('button', { name: 'Corriger et télécharger' }),
  ).toBeInViewport();
  // Trois actions facultatives, empilées ; « Revoir les corrections » ouvre son panneau,
  // amené à l'écran.
  const actions = page.getByRole('navigation', { name: 'Autres actions' });
  const boxes = await Promise.all(
    (await actions.getByRole('button').all()).map((button) => button.boundingBox()),
  );
  expect(boxes).toHaveLength(3);
  expect(new Set(boxes.map((box) => Math.round(box?.x ?? -1))).size).toBe(1);
  await actions.getByRole('button', { name: 'Revoir les corrections' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Revoir les corrections' }),
  ).toBeInViewport();

  await page
    .getByRole('navigation', { name: 'Points relevés' })
    .getByRole('button')
    .first()
    .click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('article', { name: 'Détail du point' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Fermer' }).click();
  await expect(sheet).toBeHidden();

  // Aucun défilement horizontal de la page.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
