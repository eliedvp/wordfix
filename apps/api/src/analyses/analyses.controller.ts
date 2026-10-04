import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { AnalysisDto, IssueListDto } from '@wordfix/shared';
import type { Request } from 'express';
import { AppError } from '../common/errors/app-error.js';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe.js';
import { SessionService } from '../session/session.service.js';
import { AnalysesService } from './analyses.service.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';

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
    return this.analyses.start(await this.userId(req), documentId);
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
}
