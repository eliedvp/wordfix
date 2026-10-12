import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  AcceptReliableResultDto,
  AnalysisDto,
  IssueListDto,
  UndoAcceptResultDto,
} from '@wordfix/shared';
import type { Request } from 'express';
import { AppError } from '../common/errors/app-error.js';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe.js';
import { SessionService } from '../session/session.service.js';
import { AnalysesService } from './analyses.service.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { UndoAcceptDto } from './dto/undo-accept.dto.js';

@Controller()
export class AnalysesController {
  constructor(
    private readonly analyses: AnalysesService,
    private readonly session: SessionService,
  ) {}

  private async userId(req: Request): Promise<string> {
    const user = await this.session.currentUser(req);
    if (!user) throw new AppError('NOT_FOUND');
    return user.id;
  }

  /** Lancement de l'analyse, après confirmation de l'utilisateur. Réponse immédiate (202). */
  @Post('documents/:id/analyze')
  @HttpCode(HttpStatus.ACCEPTED)
  async start(
    @Param('id', new ParseIdPipe('doc')) documentId: string,
    @Req() req: Request,
  ): Promise<{ analysisId: string }> {
    return this.analyses.start(await this.userId(req), documentId, req.ip ?? 'unknown');
  }

  @Get('analyses/:id')
  async get(
    @Param('id', new ParseIdPipe('ana')) id: string,
    @Req() req: Request,
  ): Promise<AnalysisDto> {
    return this.analyses.get(await this.userId(req), id);
  }

  @Post('analyses/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', new ParseIdPipe('ana')) id: string,
    @Req() req: Request,
  ): Promise<AnalysisDto> {
    return this.analyses.cancel(await this.userId(req), id);
  }

  @Get('analyses/:id/issues')
  async issues(
    @Param('id', new ParseIdPipe('ana')) id: string,
    @Query() query: ListIssuesQuery,
    @Req() req: Request,
  ): Promise<IssueListDto> {
    return this.analyses.listIssues(await this.userId(req), id, query);
  }

  /** « Tout corriger » : acceptation des corrections fiables encore à traiter. */
  @Post('analyses/:id/issues/accept-reliable')
  @HttpCode(HttpStatus.OK)
  async acceptReliable(
    @Param('id', new ParseIdPipe('ana')) id: string,
    @Req() req: Request,
  ): Promise<AcceptReliableResultDto> {
    return this.analyses.acceptReliable(await this.userId(req), id);
  }

  /** Annulation de « Tout corriger » (points encore acceptés seulement). */
  @Post('analyses/:id/issues/undo-accept')
  @HttpCode(HttpStatus.OK)
  async undoAccept(
    @Param('id', new ParseIdPipe('ana')) id: string,
    @Body() body: UndoAcceptDto,
    @Req() req: Request,
  ): Promise<UndoAcceptResultDto> {
    return this.analyses.undoAccept(await this.userId(req), id, body.issueIds);
  }
}
