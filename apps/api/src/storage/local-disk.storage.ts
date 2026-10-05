import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { assertValidKey, type FileStorage } from './file-storage.js';

/** Stockage sur disque local (développement). Fichiers lisibles par le seul propriétaire. */
export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(dirname(this.pathFor(key)), { recursive: true, force: true });
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Chemin hors du stockage');
    return path;
  }
}
