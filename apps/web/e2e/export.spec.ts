import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** Lecteur DOCX de l'API (build de production, déjà requis par ces tests). */
async function documentText(file: Buffer): Promise<string> {
  const parserUrl = new URL('../../api/dist/docx/parser/docx-parser.js', import.meta.url).href;
  const { parseDocx } = (await import(parserUrl)) as {
    parseDocx: (source: Buffer) => Promise<{ blocks: { text: string }[] }>;
  };
  return (await parseDocx(file)).blocks.map((block) => block.text).join('\n');
}

const SAMPLE = new URL('../public/exemple/rapport-de-stage-exemple.docx', import.meta.url);

test.describe('Corriger et télécharger', () => {
  test('choix explicites : un clic prépare puis télécharge le document corrigé, distinct de l’original', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse \(\d+ pages?\)/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });

    const actions = page.getByRole('navigation', { name: 'Autres actions' });
    const panel = page.getByRole('region', { name: 'Votre document corrigé' });
    const download = panel.getByRole('button', { name: 'Corriger et télécharger' });
    // Corrections fiables exclues ici (détails et options, repliés par défaut) : seul le
    // choix explicite doit être appliqué.
    await panel.getByText('Détails et options').click();
    await panel.getByRole('checkbox', { name: /Inclure les corrections fiables/ }).uncheck();
    // Aucune correction choisie : rien à télécharger, et c'est expliqué.
    await expect(panel.getByText(/acceptez ou modifiez au moins un point/)).toBeVisible();
    await expect(download).toBeDisabled();

    // Une correction acceptée dans la revue ; sa proposition relevée avec « Copier ».
    await actions.getByRole('button', { name: 'Revoir les corrections' }).click();
    const detail = page.getByRole('article', { name: 'Détail du point' });
    await detail.getByRole('button', { name: 'Copier' }).click();
    const suggestion = await page.evaluate(() => navigator.clipboard.readText());
    expect(suggestion).not.toBe('');
    await detail.getByRole('button', { name: 'Appliquer la correction' }).click();
    await expect(page.getByText(/1 \/ \d+ points traités/)).toBeVisible();

    // Un seul clic : préparation, puis téléchargement automatique.
    await expect(panel.getByText(/^1 correction sera appliquée\./)).toBeVisible();
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await download.click();
    const file = await downloading;
    await expect(
      panel.getByText(/Document corrigé téléchargé : «\s.*\(corrigé\)\.docx\s»/),
    ).toBeVisible();
    await expect(panel.getByText(/1 sur 1 correction appliquée/)).toBeVisible();
    expect(file.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    const corrected = readFileSync(await file.path());
    const original = readFileSync(SAMPLE);
    // Jamais l'original à la place du document corrigé.
    expect(corrected.equals(original)).toBe(false);
    const [correctedText, source] = await Promise.all([
      documentText(corrected),
      documentText(original),
    ]);
    expect(correctedText).not.toBe(source);
    expect(correctedText).toContain(suggestion);

    // Bouton de secours : un nouveau clic relance le téléchargement du même document.
    const again = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Télécharger à nouveau' }).click();
    expect((await again).suggestedFilename()).toBe(file.suggestedFilename());

    // Après rechargement, le document prêt est retrouvé sans nouvelle demande.
    let requests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/analyses\/[^/]+\/exports$/.test(request.url())) {
        requests++;
      }
    });
    await page.reload();
    await expect(panel.getByText(/Document prêt/)).toBeVisible({ timeout: 30_000 });
    expect(requests).toBe(0);

    // Un choix modifié ensuite : le document est signalé comme ne reflétant plus les choix.
    // Réponse du serveur ralentie : « Mise en forme » est ouvert avant qu'elle n'arrive, et
    // la réponse ne doit pas ramener l'utilisateur sur la revue.
    await page.route('**/api/issues/**', async (route) => {
      if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    // La revue, ouverte avant le rechargement, l'est restée (panneau gardé dans l'adresse).
    await expect(actions.getByRole('button', { name: 'Revoir les corrections' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await page
      .getByRole('navigation', { name: 'Points relevés' })
      .getByRole('button', { name: /^Erreur :/ })
      .first()
      .click();
    await detail.getByRole('button', { name: 'Appliquer la correction' }).click();
    await actions.getByRole('button', { name: 'Mise en forme' }).click();
    await expect(panel.getByText(/Vos choix ont changé depuis la génération/)).toBeVisible();
    // Après la réponse (ralentie) du serveur, le panneau ouvert reste « Mise en forme ».
    await expect(page.getByText(/2 \/ \d+ points traités/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Mise en forme' })).toBeVisible();
    await expect(page).toHaveURL(/panneau=mise-en-forme/);
    await expect(download).toBeEnabled();
    await expect(
      panel.getByRole('button', { name: 'Télécharger la version précédente' }),
    ).toBeEnabled();
    expect(requests).toBe(0);
  });

  test('par défaut : corrections fiables incluses en un clic, visibles et annulables', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse \(\d+ pages?\)/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });
    const total = Number(
      /\/ (\d+) points/.exec(
        (await page.getByText(/0 \/ \d+ points traités/).textContent()) ?? '',
      )?.[1],
    );

    const actions = page.getByRole('navigation', { name: 'Autres actions' });
    // L'action principale est visible dès la fin de l'analyse, sans rien ouvrir.
    const panel = page.getByRole('region', { name: 'Votre document corrigé' });
    const main = panel.getByRole('button', { name: 'Corriger et télécharger' });
    await expect(main).toBeInViewport();
    await expect(panel.getByText(/(sera|seront) appliquées?/)).toBeVisible();
    await panel.getByText('Détails et options').click();
    const include = panel.getByRole('checkbox', { name: /Inclure les corrections fiables/ });
    await expect(include).toBeChecked();
    const label = await panel.getByText(/Inclure les corrections fiables \(\d+\)/).textContent();
    const reliable = Number(/\((\d+)\)/.exec(label ?? '')?.[1]);
    expect(reliable).toBeGreaterThan(0);
    // Points à vérifier : signalés, sans bloquer le téléchargement.
    await expect(
      panel.getByText(/points? incertains? demandent? votre vérification/),
    ).toBeVisible();

    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await main.click();
    const file = await downloading;
    await expect(panel.getByText(/Document corrigé téléchargé/)).toBeVisible();
    await expect(
      panel.getByText(new RegExp(`\\d+ sur ${reliable} corrections? appliquées?`)),
    ).toBeVisible();
    const [correctedText, source] = await Promise.all([
      documentText(readFileSync(await file.path())),
      documentText(readFileSync(SAMPLE)),
    ]);
    expect(correctedText).not.toBe(source);
    // Les décisions sont visibles (compteur du haut) et annulables dans la revue.
    await expect(page.getByText(`${reliable} / ${total} points traités`)).toBeVisible();
    await actions.getByRole('button', { name: 'Revoir les corrections' }).click();
    await page.getByRole('button', { name: 'Annuler « Tout corriger »' }).click();
    await expect(page.getByText(`0 / ${total} points traités`)).toBeVisible();
  });
});
