import { describe, expect, it } from 'vitest';
import { checkFileBeforeUpload } from '@/lib/file-check';

describe('vérification du fichier dans le navigateur', () => {
  it('accepte un .docx de taille raisonnable', () => {
    expect(checkFileBeforeUpload({ name: 'Rapport.DOCX', size: 1024 })).toBeNull();
  });

  it('refuse les autres formats avec un message adapté', () => {
    expect(checkFileBeforeUpload({ name: 'ancien.doc', size: 10 })).toMatch(/\.doc/);
    expect(checkFileBeforeUpload({ name: 'macro.docm', size: 10 })).toMatch(/macros/);
    expect(checkFileBeforeUpload({ name: 'rapport.pdf', size: 10 })).toMatch(
      /pas un document Word/,
    );
  });

  it('refuse un fichier vide ou de plus de 20 Mo', () => {
    expect(checkFileBeforeUpload({ name: 'a.docx', size: 0 })).toMatch(/endommagé/);
    expect(checkFileBeforeUpload({ name: 'a.docx', size: 21 * 1024 * 1024 })).toMatch(/20 Mo/);
  });
});
