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

test.describe('Parcours complet du MVP', () => {
  test('import, analyse, Tout corriger (avec annulation), Embellir, téléchargement', async ({
    page,
  }) => {
    // Import et analyse.
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse \(\d+ pages?\)/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });

    // Tout corriger : corrections sûres acceptées en une action, puis annulées, puis refaites.
    const quickFix = page.getByRole('region', { name: 'Correction rapide' });
    const fixAll = quickFix.getByRole('button', { name: /^Tout corriger \(\d+\)$/ });
    await expect(fixAll).toBeVisible();
    const count = Number((await fixAll.textContent())?.match(/\((\d+)\)/)?.[1]);
    expect(count).toBeGreaterThan(0);
    await fixAll.click();
    await expect(
      quickFix.getByText(new RegExp(`^${count} corrections? acceptées?\\.`)),
    ).toBeVisible();
    await expect(page.getByText(new RegExp(`^${count} / \\d+ points traités`))).toBeVisible();

    await quickFix.getByRole('button', { name: 'Annuler « Tout corriger »' }).click();
    await expect(quickFix.getByText(/remises? à traiter/)).toBeVisible();
    await expect(page.getByText(/^0 \/ \d+ points traités/)).toBeVisible();
    await quickFix.getByRole('button', { name: `Tout corriger (${count})` }).click();
    await expect(page.getByText(new RegExp(`^${count} / \\d+ points traités`))).toBeVisible();

    // Embellir + document corrigé.
    const panel = page.getByRole('region', { name: 'Document corrigé' });
    await panel.getByRole('checkbox', { name: /Typographie française/ }).check();
    await panel.getByRole('checkbox', { name: /Mise en page harmonisée/ }).check();
    await panel.getByRole('button', { name: 'Générer le document corrigé' }).click();
    await expect(
      panel.getByText(
        new RegExp(`Document corrigé prêt : \\d+ sur ${count} corrections? appliquées?`),
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/^Embellissement : /)).toBeVisible();

    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Télécharger le document corrigé' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\(corrigé\)\.docx$/);
    const file = readFileSync(await download.path());
    const original = readFileSync(SAMPLE);
    expect(file.equals(original)).toBe(false);
    const [corrected, source] = await Promise.all([documentText(file), documentText(original)]);
    expect(corrected).not.toBe(source);
    // Le sens du texte est conservé : mêmes caractères hors espaces, sauf corrections.
    expect(corrected.split('\n')).toHaveLength(source.split('\n').length);
  });
});
