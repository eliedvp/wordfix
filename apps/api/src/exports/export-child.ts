/**
 * Processus enfant éphémère d'un export : il applique les corrections à une copie de
 * l'original, puis les options « Embellir » demandées, et se termine. Il ne reçoit
 * que l'original, les corrections et les options (aucun secret, aucune connexion à la
 * base ni au stockage) et ne renvoie jamais le texte d'une erreur, seulement un
 * code : les journaux ne contiennent aucun contenu.
 */
import type { ExportOptions } from '@wordfix/shared';
import { DocxPackageError } from '../docx/package-reader.js';
import { BeautifyError, beautifyDocx } from '../docx/writer/beautify.js';
import { DocxRewriteError } from '../docx/writer/rewrite-docx.js';
import { applyTextEdits, type TextEdit, TextEditError } from '../docx/writer/text-edits.js';
import { XmlRewriteError } from '../docx/writer/xml-writer.js';

export interface ChildRequest {
  source: Uint8Array;
  edits: TextEdit[];
  /** Options « Embellir » (absentes : corrections seules). */
  beautify?: ExportOptions;
}

export type ChildResponse =
  | {
      kind: 'done';
      /** Fichier produit, ou null si rien n'a été modifié. */
      file: Uint8Array | null;
      applied: string[];
      skipped: { id: string; reason: string }[];
      /** Modifications « Embellir » appliquées. */
      beautified: { typography: number; layout: number };
    }
  | { kind: 'error'; problem: string };

function problemOf(error: unknown): string {
  if (error instanceof TextEditError) return error.problem;
  if (error instanceof BeautifyError) return error.problem;
  if (error instanceof XmlRewriteError) return error.problem;
  if (error instanceof DocxRewriteError) return error.problem;
  if (error instanceof DocxPackageError) return `package_${error.problem}`;
  return 'unexpected';
}

let replied = false;

/**
 * Réponse au parent. L'enfant ne se termine pas de lui-même : le parent mesure son pic
 * de mémoire une fois le message entièrement reçu (sérialisation et envoi compris),
 * puis lui envoie un message de libération, qui le termine.
 */
function reply(response: ChildResponse): void {
  replied = true;
  process.send?.(response, (error: Error | null) => {
    if (error) process.exit(1);
  });
  process.once('message', () => process.exit(0));
}

// Canal fermé (service d'export arrêté) : l'enfant ne doit pas survivre en orphelin,
// sinon il occuperait encore de la mémoire quand le service redémarre et relance l'export.
process.once('disconnect', () => process.exit(replied ? 0 : 1));

process.once('message', (message: ChildRequest) => {
  const source = Buffer.from(
    message.source.buffer,
    message.source.byteOffset,
    message.source.byteLength,
  );
  run(source, message).then(reply, (error: unknown) =>
    reply({ kind: 'error', problem: problemOf(error) }),
  );
});

async function run(source: Buffer, message: ChildRequest): Promise<ChildResponse> {
  const corrected = await applyTextEdits(source, message.edits);
  let buffer = corrected.changed ? corrected.buffer : source;
  const beautified = { typography: 0, layout: 0 };
  const options = message.beautify;
  if (options && (options.typography || options.layout)) {
    const result = await beautifyDocx(buffer, options);
    buffer = result.buffer;
    beautified.typography = result.typography;
    beautified.layout = result.layout;
  }
  return {
    kind: 'done',
    // Jamais l'original à la place d'un document modifié.
    file: buffer === source ? null : buffer,
    applied: corrected.applied,
    skipped: corrected.skipped,
    beautified,
  };
}
