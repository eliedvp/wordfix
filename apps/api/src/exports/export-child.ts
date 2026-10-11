/**
 * Processus enfant éphémère d'un export : il applique les corrections à une copie de
 * l'original puis se termine. Il ne reçoit que l'original et les corrections (aucun
 * secret, aucune connexion à la base ni au stockage) et ne renvoie jamais le texte
 * d'une erreur, seulement un code : les journaux ne contiennent aucun contenu.
 */
import { DocxPackageError } from '../docx/package-reader.js';
import { DocxRewriteError } from '../docx/writer/rewrite-docx.js';
import { applyTextEdits, type TextEdit, TextEditError } from '../docx/writer/text-edits.js';
import { XmlRewriteError } from '../docx/writer/xml-writer.js';

export interface ChildRequest {
  source: Uint8Array;
  edits: TextEdit[];
}

export type ChildResponse =
  | {
      kind: 'done';
      /** Fichier produit, ou null si aucune correction n'a été appliquée. */
      file: Uint8Array | null;
      applied: string[];
      skipped: { id: string; reason: string }[];
    }
  | { kind: 'error'; problem: string };

function problemOf(error: unknown): string {
  if (error instanceof TextEditError) return error.problem;
  if (error instanceof XmlRewriteError) return error.problem;
  if (error instanceof DocxRewriteError) return error.problem;
  if (error instanceof DocxPackageError) return `package_${error.problem}`;
  return 'unexpected';
}

function reply(response: ChildResponse): void {
  process.send?.(response, () => process.exit(0));
}

// Service d'export arrêté (canal fermé) : l'enfant ne doit pas survivre en orphelin,
// sinon il occuperait encore de la mémoire quand le service redémarre et relance l'export.
process.once('disconnect', () => process.exit(1));

process.once('message', (message: ChildRequest) => {
  const source = Buffer.from(
    message.source.buffer,
    message.source.byteOffset,
    message.source.byteLength,
  );
  applyTextEdits(source, message.edits).then(
    (result) =>
      reply({
        kind: 'done',
        file: result.changed ? result.buffer : null,
        applied: result.applied,
        skipped: result.skipped,
      }),
    (error: unknown) => reply({ kind: 'error', problem: problemOf(error) }),
  );
});
