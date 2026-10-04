import { expect, test } from '@playwright/test';

test.describe('Parcours principal', () => {
  test('importer, analyser, relire, retrouver dans l’historique, supprimer', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Perfectionnez vos documents Word en quelques instants.',
    );

    // Import en deux temps : le fichier est vérifié avant tout lancement.
    await page.getByRole('button', { name: 'Essayer avec un rapport de stage d’exemple' }).click();
    await expect(page.getByText('Fichier vérifié : prêt pour l’analyse.')).toBeVisible();
    await page.getByRole('button', { name: /Lancer l’analyse \(\d+ pages?\)/ }).click();

    // Écran d'analyse puis résultats, à la même adresse.
    await expect(page).toHaveURL(/\/analyses\/ana_[0-9a-z]{20}/);
    await expect(page.getByText('sur 100')).toBeVisible({ timeout: 30_000 });
    const analysisUrl = page.url().split('?')[0] ?? '';

    // Les quatre natures sont distinguées par un libellé.
    for (const label of ['Erreurs', 'Suggestions', 'À examiner', 'À vérifier']) {
      await expect(
        page.getByRole('group', { name: 'Filtrer par nature' }).getByText(label),
      ).toBeVisible();
    }

    // Appliquer une correction : copiée, comptée comme traitée.
    const detail = page.getByRole('article', { name: 'Détail du point' });
    await expect(detail.getByText('Erreur', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Appliquer la correction' }).click();
    const toasts = page.getByRole('region', { name: /Notifications/ });
    await expect(toasts.getByText('Correction copiée. Reportez-la dans Word.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
    await expect(page.getByText(/1 \/ \d+ points traités/)).toBeVisible();

    // Ignorer au clavier, puis annuler.
    await page.keyboard.press('i');
    await expect(toasts.getByText('Point ignoré.')).toBeVisible();
    await toasts.getByRole('button', { name: 'Annuler' }).click();

    // Filtres conservés dans l'adresse après rechargement.
    await page
      .getByRole('group', { name: 'Filtrer par catégorie' })
      .getByRole('button', { name: /Structure/ })
      .click();
    await expect(page).toHaveURL(/categorie=structure/);
    await page.reload();
    await expect(page.getByRole('button', { name: /Structure/, pressed: true })).toBeVisible();

    // Historique : document terminé, reprise, suppression définitive.
    await page.getByRole('link', { name: 'Mes documents' }).click();
    await expect(page.getByText('Terminé')).toBeVisible();
    await page.getByRole('link', { name: 'Reprendre' }).click();
    await expect(page).toHaveURL(analysisUrl);
    await page.goBack();
    await page.getByRole('button', { name: /Supprimer Rapport de stage/ }).click();
    await page.getByRole('button', { name: 'Supprimer définitivement' }).click();
    await expect(page.getByText('Aucun document pour l’instant')).toBeVisible();
    await page.goto(analysisUrl);
    await expect(page.getByRole('heading', { name: 'Analyse introuvable' })).toBeVisible();
  });

  test('la page Confidentialité affiche exactement les cinq engagements validés', async ({
    page,
  }) => {
    await page.goto('/confidentialite');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Connexion chiffrée (HTTPS).',
      'Votre fichier est supprimé au plus tard 24 h après l’import.',
      'Le texte extrait et les résultats sont supprimés après 7 jours. Vous pouvez tout supprimer immédiatement.',
      'Vos analyses ne sont accessibles que depuis ce navigateur. Aucun lien public n’est créé.',
      'Pour l’analyse, le texte de votre document est envoyé à OpenAI.',
    ]);
  });
});
