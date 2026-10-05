import { describe, expect, it } from 'vitest';
import {
  buildDocx,
  buildFakePdf,
  buildOleFile,
  buildPlainZip,
  buildZipBomb,
  filler,
  patchDocx,
} from '../../test/fixtures/builders.js';
import { AppError } from '../common/errors/app-error.js';
import { validateDocx } from './docx-validator.js';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

describe('validateDocx', () => {
  it('accepte un vrai .docx et compte ses mots', async () => {
    const buffer = await buildDocx([{ h: 1, text: 'Introduction' }, { p: filler(120) }]);
    const stats = await validateDocx(buffer, 'Rapport.docx');
    expect(stats.wordCount).toBe(121);
    expect(stats.estimatedPages).toBeGreaterThanOrEqual(1);
  });

  it('refuse un fichier vide', async () => {
    expect(await codeOf(validateDocx(Buffer.alloc(0), 'vide.docx'))).toBe('CORRUPTED_FILE');
  });

  it('refuse un PDF renommé en .docx', async () => {
    expect(await codeOf(validateDocx(buildFakePdf(), 'faux.docx'))).toBe('UNSUPPORTED_FORMAT');
  });

  it('refuse une archive ZIP qui n’est pas un document Word', async () => {
    expect(await codeOf(validateDocx(await buildPlainZip(), 'archive.docx'))).toBe(
      'UNSUPPORTED_FORMAT',
    );
  });

  it('refuse une bonne structure avec une mauvaise extension', async () => {
    const buffer = await buildDocx([{ p: 'Bonjour.' }]);
    expect(await codeOf(validateDocx(buffer, 'rapport.zip'))).toBe('UNSUPPORTED_FORMAT');
  });

  it('reconnaît un ancien .doc et un .docx protégé par mot de passe', async () => {
    expect(await codeOf(validateDocx(buildOleFile(false), 'ancien.doc'))).toBe('LEGACY_DOC_FORMAT');
    expect(await codeOf(validateDocx(buildOleFile(true), 'secret.docx'))).toBe(
      'PASSWORD_PROTECTED',
    );
  });

  it('refuse un document avec macros', async () => {
    const buffer = await buildDocx([{ p: 'Bonjour.' }]);
    expect(await codeOf(validateDocx(buffer, 'macro.docm'))).toBe('MACRO_DOCUMENT');
    const withVba = await patchDocx(buffer, (zip) => {
      zip.file('word/vbaProject.bin', Buffer.from('fake'));
    });
    expect(await codeOf(validateDocx(withVba, 'macro.docx'))).toBe('MACRO_DOCUMENT');
  });

  it('refuse un fichier tronqué (corrompu)', async () => {
    const buffer = await buildDocx([{ p: filler(200) }]);
    const truncated = buffer.subarray(0, Math.floor(buffer.length / 2));
    expect(await codeOf(validateDocx(truncated, 'casse.docx'))).toBe('CORRUPTED_FILE');
  });

  it('refuse une bombe ZIP sans la décompresser', async () => {
    expect(await codeOf(validateDocx(await buildZipBomb(), 'bombe.docx'))).toBe('CORRUPTED_FILE');
  }, 30_000);

  it('refuse un XML contenant une déclaration d’entités (XXE)', async () => {
    const buffer = await buildDocx([{ p: 'Bonjour.' }]);
    const evil = await patchDocx(buffer, async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file(
        'word/document.xml',
        xml.replace(
          '<w:document',
          '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document',
        ),
      );
    });
    expect(await codeOf(validateDocx(evil, 'xxe.docx'))).toBe('CORRUPTED_FILE');
  });

  it('signale un document sans texte', async () => {
    const buffer = await buildDocx([{ p: '' }]);
    expect(await codeOf(validateDocx(buffer, 'vide.docx'))).toBe('EMPTY_DOCUMENT');
  });

  it('signale un document trop long', async () => {
    const buffer = await buildDocx(Array.from({ length: 61 }, () => ({ p: filler(1000) })));
    expect(await codeOf(validateDocx(buffer, 'long.docx'))).toBe('DOCUMENT_TOO_LONG');
  });
});
