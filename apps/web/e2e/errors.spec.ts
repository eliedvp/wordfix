import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ERROR_CATALOG } from '@wordfix/shared';

const SAMPLE = readFileSync(
  fileURLToPath(new URL('../public/exemple/rapport-de-stage-exemple.docx', import.meta.url)),
);
const input = (page: import('@playwright/test').Page) => page.locator('input[type="file"]');

test.describe('Erreurs affichées clairement', () => {
  test('refuse un PDF dans le navigateur, sans envoi', async ({ page }) => {
    let uploads = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/documents') && request.method() === 'POST') uploads++;
    });
    await page.goto('/');
    await input(page).setInputFiles({
      name: 'rapport.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    });
    await expect(page.getByText(ERROR_CATALOG.UNSUPPORTED_FORMAT.message)).toBeVisible();
    expect(uploads).toBe(0);
  });

  test('refuse un fichier trop volumineux dans le navigateur', async ({ page }) => {
    await page.goto('/');
    await input(page).setInputFiles({
      name: 'gros.docx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(21 * 1024 * 1024),
    });
    await expect(page.getByText(ERROR_CATALOG.FILE_TOO_LARGE.message)).toBeVisible();
  });

  test('affiche le message du serveur pour un .docx endommagé', async ({ page }) => {
    await page.goto('/');
    await input(page).setInputFiles({
      name: 'casse.docx',
      mimeType: 'application/octet-stream',
      buffer: SAMPLE.subarray(0, SAMPLE.length / 2),
    });
    await expect(page.getByText(ERROR_CATALOG.CORRUPTED_FILE.message)).toBeVisible();
  });

  test('explique une coupure réseau pendant l’envoi', async ({ page }) => {
    await page.route('**/api/documents', (route) => route.abort('internetdisconnected'));
    await page.goto('/');
    await input(page).setInputFiles({
      name: 'rapport.docx',
      mimeType: 'application/octet-stream',
      buffer: SAMPLE,
    });
    await expect(page.getByText(/Connexion impossible/)).toBeVisible();
  });

  test('analyse inconnue ou d’une autre session : page claire', async ({ page }) => {
    await page.goto('/analyses/ana_aaaaaaaaaaaaaaaaaaaa');
    await expect(page.getByRole('heading', { name: 'Analyse introuvable' })).toBeVisible();
  });

  test('page inexistante', async ({ page }) => {
    await page.goto('/nimporte-quoi');
    await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
  });
});
