import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type DocumentDto, MAX_UPLOAD_BYTES } from '@wordfix/shared';
import type { Request, Response } from 'express';
import { AppError } from '../common/errors/app-error.js';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe.js';
import { QuotaService } from '../security/quota.service.js';
import { SessionService } from '../session/session.service.js';
import { DocumentsService, type UploadedDocxFile } from './documents.service.js';

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly session: SessionService,
    private readonly quota: QuotaService,
  ) {}

  /** Import d'un .docx (champ multipart « file »). */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      // Sans option de stockage, Multer garde le fichier en mémoire (jamais sur disque).
      // La limite coupe l'envoi dès 20 Mo reçus : le fichier n'est jamais lu en entier.
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
      defParamCharset: 'utf8',
    }),
  )
  async upload(
    @UploadedFile() file: UploadedDocxFile | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentDto> {
    await this.quota.consumeUpload(req.ip ?? 'unknown');
    if (!file) throw new AppError('FILE_MISSING');
    return this.documents.create(async () => (await this.session.ensureUser(req, res)).id, file);
  }

  /** Historique de la session. */
  @Get()
  async list(@Req() req: Request): Promise<DocumentDto[]> {
    const user = await this.session.currentUser(req);
    return user ? this.documents.list(user.id) : [];
  }

  @Get(':id')
  async get(
    @Param('id', new ParseIdPipe('doc')) id: string,
    @Req() req: Request,
  ): Promise<DocumentDto> {
    const user = await this.session.currentUser(req);
    if (!user) throw new AppError('NOT_FOUND');
    return this.documents.get(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseIdPipe('doc')) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.session.currentUser(req);
    if (!user) throw new AppError('NOT_FOUND');
    await this.documents.delete(user.id, id);
  }
}
