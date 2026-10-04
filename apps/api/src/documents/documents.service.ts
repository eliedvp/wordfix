import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONTENT_RETENTION_DAYS,
  type DocumentDto,
  SOURCE_FILE_RETENTION_HOURS,
} from '@wordfix/shared';
import { AppError } from '../common/errors/app-error.js';
import { sanitizeFilename } from '../common/filename.js';
import { newId } from '../common/ids.js';
import { validateDocx } from '../docx/docx-validator.js';
import type { Document } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FILE_STORAGE, type FileStorage, sourceKey } from '../storage/file-storage.js';

const HOUR_MS = 60 * 60 * 1000;

export interface UploadedDocxFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /**
   * Import d'un document : validation complète du fichier, stockage privé sous
   * une clé générée, puis enregistrement. L'analyse n'est pas lancée ici : elle
   * démarre quand l'utilisateur confirme (import en deux temps).
   */
  async create(getOwnerId: () => Promise<string>, file: UploadedDocxFile): Promise<DocumentDto> {
    const originalName = sanitizeFilename(file.originalname);
    // Validation d'abord : un fichier refusé ne crée ni session, ni fichier stocké.
    const stats = await validateDocx(file.buffer, originalName);
    const ownerId = await getOwnerId();

    const id = newId('doc');
    const key = sourceKey(id);
    const now = Date.now();

    await this.storage.put(key, file.buffer);
    try {
      const document = await this.prisma.document.create({
        data: {
          id,
          ownerId,
          originalName,
          sizeBytes: file.size,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          storageKey: key,
          wordCount: stats.wordCount,
          declaredPages: stats.declaredPages,
          estimatedPages: stats.estimatedPages,
          fileExpiresAt: new Date(now + SOURCE_FILE_RETENTION_HOURS * HOUR_MS),
          contentExpiresAt: new Date(now + CONTENT_RETENTION_DAYS * 24 * HOUR_MS),
        },
      });
      this.logger.log(
        { documentId: id, sizeBytes: file.size, wordCount: stats.wordCount },
        'Document importé',
      );
      return this.toDto(document);
    } catch (error) {
      // Pas de fichier orphelin si l'enregistrement échoue.
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async list(ownerId: string): Promise<DocumentDto[]> {
    const documents = await this.prisma.document.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(documents.map((document) => this.toDto(document)));
  }

  async get(ownerId: string, id: string): Promise<DocumentDto> {
    return this.toDto(await this.findOwned(ownerId, id));
  }

  /** Suppression immédiate et définitive : fichier, texte extrait, analyses, résultats. */
  async delete(ownerId: string, id: string): Promise<void> {
    const document = await this.findOwned(ownerId, id);
    if (document.storageKey) await this.storage.delete(document.storageKey);
    await this.prisma.document.delete({ where: { id: document.id } });
    this.logger.log({ documentId: id }, 'Document supprimé à la demande');
  }

  /** Document appartenant à l'utilisateur ; 404 sinon (même s'il existe pour un autre). */
  async findOwned(ownerId: string, id: string): Promise<Document> {
    const document = await this.prisma.document.findFirst({ where: { id, ownerId } });
    if (!document) throw new AppError('NOT_FOUND');
    return document;
  }

  toDto(document: Document): Promise<DocumentDto> {
    return Promise.resolve({
      id: document.id,
      originalName: document.originalName,
      sizeBytes: document.sizeBytes,
      wordCount: document.wordCount,
      estimatedPages: document.estimatedPages,
      createdAt: document.createdAt.toISOString(),
      fileAvailable: document.storageKey !== null && document.fileDeletedAt === null,
      fileExpiresAt: document.fileExpiresAt.toISOString(),
      contentExpiresAt: document.contentExpiresAt.toISOString(),
      latestAnalysis: null,
    });
  }
}
