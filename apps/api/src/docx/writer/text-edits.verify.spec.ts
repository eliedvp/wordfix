import { describe, expect, it, vi } from 'vitest';
import { buildDocx } from '../../../test/fixtures/builders.js';
import { parseDocx } from '../parser/docx-parser.js';
import { applyTextEdits, TextEditError } from './text-edits.js';

/**
 * Vérification finale : on simule une réécriture qui aurait altéré la structure d'un
 * paragraphe (empreinte différente après relecture). Aucune correction ne doit alors
 * produire de fichier.
 */
type Corruption = 'none' | 'target' | 'others';
const mode: { corrupt: Corruption } = vi.hoisted(() => ({ corrupt: 'none' }));
vi.mock('./xml-writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xml-writer.js')>();
  let calls = 0;
  return {
    ...actual,
    xmlFingerprint: (node: Parameters<typeof actual.xmlFingerprint>[0], skeleton = false) => {
      const real = actual.xmlFingerprint(node, skeleton);
      const corrupt =
        (mode.corrupt === 'target' && skeleton) || (mode.corrupt === 'others' && !skeleton);
      return corrupt ? `${real}:${calls++}` : real;
    },
  };
});

async function scenario() {
  const source = await buildDocx([
    { p: 'Une phrase avec une fote.' },
    { p: 'Un autre paragraphe.' },
  ]);
  const block = (await parseDocx(source)).blocks[0]!;
  const start = block.text.indexOf('fote');
  return {
    source,
    edits: [
      {
        id: 'e',
        blockId: block.id,
        start,
        end: start + 4,
        expectedBlockText: block.text,
        expectedOriginal: 'fote',
        replacement: 'faute',
      },
    ],
  };
}

describe('applyTextEdits : échec de la vérification finale', () => {
  it('sans altération : la correction est appliquée (contrôle du scénario)', async () => {
    mode.corrupt = 'none';
    const { source, edits } = await scenario();
    expect((await applyTextEdits(source, edits)).applied).toEqual(['e']);
  });

  it('structure du paragraphe corrigé altérée : erreur, aucun fichier', async () => {
    mode.corrupt = 'target';
    const { source, edits } = await scenario();
    await expect(applyTextEdits(source, edits)).rejects.toBeInstanceOf(TextEditError);
    await expect(applyTextEdits(source, edits)).rejects.toThrow(/paragraphe corrigé/);
  });

  it('paragraphe non ciblé altéré : erreur, aucun fichier', async () => {
    mode.corrupt = 'others';
    const { source, edits } = await scenario();
    await expect(applyTextEdits(source, edits)).rejects.toThrow(/non ciblé/);
  });
});
