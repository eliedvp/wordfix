import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type { ExportDto } from '@wordfix/shared';
import type { Request } from 'express';
import { AppError } from '../common/errors/app-error.js';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe.js';
import { SessionService } from '../session/session.service.js';
import { CreateExportDto } from './dto/create-export.dto.js';
import { attachmentDisposition } from './export-mapper.js';
import { ExportsService } from './exports.service.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

@Controller()
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly session: SessionService,
  ) {}

  private async userId(req: Request): Promise<string> {
    const user = await this.session.currentUser(req);
    if (!user) throw new AppError('NOT_FOUND');
    return user.id;
  }

  /**
   * Demande d'un document corrigé : corrections figées et options « Embellir »,
   * traitement en arrière-plan (202).
   */
  @Post('analyses/:id/exports')
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Param('id', new ParseIdPipe('ana')) analysisId: string,
    @Body() body: CreateExportDto,
    @Req() req: Request,
  ): Promise<ExportDto> {
    return this.exports.create(await this.userId(req), analysisId, {
      typography: body?.typography === true,
      layout: body?.layout === true,
    });
  }

  @Get('exports/:id')
  async get(
    @Param('id', new ParseIdPipe('exp')) id: string,
    @Req() req: Request,
  ): Promise<ExportDto> {
    return this.exports.get(await this.userId(req), id);
  }

  /** Téléchargement du document corrigé (pièce jointe, jamais mise en cache). */
  @Get('exports/:id/download')
  async download(
    @Param('id', new ParseIdPipe('exp')) id: string,
    @Req() req: Request,
  ): Promise<StreamableFile> {
    const { data, fileName } = await this.exports.download(await this.userId(req), id);
    return new StreamableFile(data, {
      type: DOCX_MIME,
      disposition: attachmentDisposition(fileName),
      length: data.length,
    });
  }
}
