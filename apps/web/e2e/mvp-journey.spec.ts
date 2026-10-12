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
  test('import, analyse, Tout corriger (avec annulation), mise en forme, téléchargement', async ({
    page,
  }) => {
    // Import et analyse.
    await page.goto('/');
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await page.getByRole('button', { name: /Lancer l’analyse \(\d+ pages?\)/ }).click();
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });

    // Tout corriger (panneau « Corriger ») : accepté en une action, annulé, puis refait.
    const actions = page.getByRole('navigation', { name: 'Actions' });
    await actions.getByRole('button', { name: 'Corriger' }).click();
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

    // Mise en forme (facultative), puis téléchargement en un clic.
    await actions.getByRole('button', { name: 'Mise en forme' }).click();
    const formatting = page.getByRole('region', { name: 'Mise en forme' });
    // Structure du rapport d'exemple : présence (API) distincte de la conformité.
    const row = (label: string) =>
      formatting.getByRole('listitem').filter({ hasText: new RegExp(`^${label}`) });
    await expect(row('Numérotation des titres')).toContainText('titres numérotés dans le texte');
    await expect(row('Numérotation des titres')).toContainText('Contrôlé : 1 écart relevé');
    await expect(row('Sommaire et titres')).toContainText('Aucun sommaire Word détecté');
    await expect(row('Sommaire et titres')).toContainText('Non applicable');
    await expect(row('Sommaire et titres')).not.toContainText('Contrôlé');
    await expect(row('Titres mis en forme')).toContainText('reconnus par Word');
    // La pagination n'est jamais présentée comme vérifiée.
    await expect(row('Pagination')).toContainText('Non vérifiée');
    await expect(row('Pagination')).toContainText('ne recalcule pas la pagination');
    await formatting.getByRole('checkbox', { name: /Typographie française/ }).check();
    await formatting.getByRole('checkbox', { name: /Harmonisation de la présentation/ }).check();
    await actions.getByRole('button', { name: 'Télécharger les modifications' }).click();
    const panel = page.getByRole('region', { name: 'Télécharger les modifications' });
    await expect(
      panel.getByText('Typographie française · Harmonisation de la présentation'),
    ).toBeVisible();
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await panel.getByRole('button', { name: 'Télécharger les modifications' }).click();
    const download = await downloading;
    await expect(
      panel.getByText(new RegExp(`Document prêt : \\d+ sur ${count} corrections? appliquées?`)),
    ).toBeVisible();
    await expect(panel.getByText(/^Mise en forme : /)).toBeVisible();
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
