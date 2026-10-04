import yauzl, { type Entry, type ZipFile } from 'yauzl';

/**
 * Lecture sûre d'une archive ZIP (un .docx est une archive ZIP de fichiers XML).
 *
 * Protections contre les archives piégées (« bombes ZIP ») :
 * - le répertoire central est lu avant toute décompression ;
 * - nombre d'entrées, taille décompressée totale et taux de compression bornés ;
 * - chaque lecture est plafonnée en octets, même si l'archive ment sur les tailles ;
 * - yauzl refuse les chemins absolus ou contenant « .. ».
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  /** Taux maximal décompressé / compressé pour une entrée de plus de 1 Mo. */
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export type ZipErrorReason = 'corrupted' | 'limits' | 'encrypted' | 'missing_entry';

export class ZipReadError extends Error {
  constructor(
    readonly reason: ZipErrorReason,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.name = 'ZipReadError';
  }
}

export class SafeZip {
  private constructor(
    private readonly zip: ZipFile,
    readonly entries: ReadonlyMap<string, Entry>,
  ) {}

  static async open(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<SafeZip> {
    const zip = await new Promise<ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(
        buffer,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true },
        (err, zipFile) => {
          if (err || !zipFile) {
            reject(new ZipReadError('corrupted', `ZIP illisible : ${err?.message ?? 'inconnu'}`));
          } else {
            resolve(zipFile);
          }
        },
      );
    });

    if (zip.entryCount > limits.maxEntries) {
      zip.close();
      throw new ZipReadError('limits', `trop d'entrées (${zip.entryCount})`);
    }

    const entries = new Map<string, Entry>();
    let total = 0;

    await new Promise<void>((resolve, reject) => {
      const fail = (error: ZipReadError) => {
        zip.close();
        reject(error);
      };
      zip.on('error', (err: Error) =>
        fail(new ZipReadError('corrupted', `ZIP invalide : ${err.message}`, { cause: err })),
      );
      zip.on('end', () => resolve());
      zip.on('entry', (entry: Entry) => {
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          fail(new ZipReadError('encrypted', `entrée chiffrée : ${entry.fileName}`));
          return;
        }
        total += entry.uncompressedSize;
        const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
        if (total > limits.maxTotalUncompressedBytes) {
          fail(new ZipReadError('limits', 'taille décompressée totale excessive'));
          return;
        }
        if (entry.uncompressedSize > 1024 * 1024 && ratio > limits.maxCompressionRatio) {
          fail(new ZipReadError('limits', `taux de compression suspect : ${entry.fileName}`));
          return;
        }
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });

    return new SafeZip(zip, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Lit une entrée en entier, sans jamais dépasser maxBytes octets décompressés. */
  async read(name: string, maxBytes: number): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipReadError('missing_entry', `entrée absente : ${name}`);
    if (entry.uncompressedSize > maxBytes) {
      throw new ZipReadError('limits', `entrée trop volumineuse : ${name}`);
    }

    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      this.zip.openReadStream(entry, (err, s) => {
        if (err || !s) {
          reject(new ZipReadError('corrupted', `lecture impossible : ${name}`, { cause: err }));
        } else {
          resolve(s);
        }
      });
    });

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBytes) throw new ZipReadError('limits', `entrée trop volumineuse : ${name}`);
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ZipReadError) throw error;
      throw new ZipReadError('corrupted', `données compressées invalides : ${name}`, {
        cause: error,
      });
    }
    return Buffer.concat(chunks);
  }

  async readText(name: string, maxBytes: number): Promise<string> {
    return (await this.read(name, maxBytes)).toString('utf8');
  }

  close(): void {
    this.zip.close();
  }
}
