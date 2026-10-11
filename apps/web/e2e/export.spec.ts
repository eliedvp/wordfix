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

test.describe('Document corrigé', () => {
  test('générer puis télécharger le document corrigé, distinct de l’original', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse \(\d+ pages?\)/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });

    const panel = page.getByRole('region', { name: 'Document corrigé' });
    // Aucune correction choisie : rien à générer, rien à télécharger.
    await expect(panel.getByText(/Acceptez ou modifiez au moins un point/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Générer le document corrigé' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: /Télécharger/ })).toHaveCount(0);

    // Une correction acceptée (la proposition est copiée dans le presse-papiers).
    const detail = page.getByRole('article', { name: 'Détail du point' });
    await detail.getByRole('button', { name: 'Appliquer la correction' }).click();
    await expect(page.getByText(/1 \/ \d+ points traités/)).toBeVisible();
    const suggestion = await page.evaluate(() => navigator.clipboard.readText());
    expect(suggestion).not.toBe('');

    await expect(panel.getByText(/1 correction acceptée ou modifiée sera appliquée/)).toBeVisible();
    await panel.getByRole('button', { name: 'Générer le document corrigé' }).click();
    await expect(
      panel.getByText(/Document corrigé prêt : 1 sur 1 correction appliquée/),
    ).toBeVisible({
      timeout: 30_000,
    });

    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Télécharger le document corrigé' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    const file = readFileSync(await download.path());
    const original = readFileSync(SAMPLE);
    // Jamais l'original à la place du document corrigé.
    expect(file.equals(original)).toBe(false);
    const [corrected, source] = await Promise.all([documentText(file), documentText(original)]);
    expect(corrected).not.toBe(source);
    expect(corrected).toContain(suggestion);

    // Après rechargement, le document prêt est retrouvé sans nouvelle demande.
    let requests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/analyses\/[^/]+\/exports$/.test(request.url())) {
        requests++;
      }
    });
    await page.reload();
    await expect(panel.getByText(/Document corrigé prêt/)).toBeVisible({ timeout: 30_000 });
    expect(requests).toBe(0);

    // Un choix modifié ensuite : le document est signalé comme ne reflétant plus les choix.
    await page
      .getByRole('navigation', { name: 'Points relevés' })
      .getByRole('button', { name: /^Erreur :/ })
      .first()
      .click();
    await detail.getByRole('button', { name: 'Appliquer la correction' }).click();
    await expect(panel.getByText(/Vos choix ont changé depuis la génération/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Générer une nouvelle version' })).toBeEnabled();
  });
});
