import { Body, Controller, Param, Patch, Req } from '@nestjs/common';
import type { IssueDto } from '@wordfix/shared';
import type { Request } from 'express';
import { toIssueDto } from '../analyses/analyses.service.js';
import { AppError } from '../common/errors/app-error.js';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionService } from '../session/session.service.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';

/**
 * Décision de l'utilisateur sur un problème : accepter, ignorer, vérifier,
 * modifier ou rouvrir. Le fichier Word n'est pas modifié (décision D9).
 */
@Controller('issues')
export class IssuesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: SessionService,
  ) {}

  @Patch(':id')
  async update(
    @Param('id', new ParseIdPipe('iss')) id: string,
    @Body() body: UpdateIssueDto,
    @Req() req: Request,
  ): Promise<IssueDto> {
    const user = await this.session.currentUser(req);
    if (!user) throw new AppError('NOT_FOUND');

    const issue = await this.prisma.issue.findFirst({
      where: { id, analysis: { document: { ownerId: user.id } } },
    });
    if (!issue) throw new AppError('NOT_FOUND');

    const userText = body.userText?.trim() ?? '';
    if (body.status === 'edited' && userText.length === 0) throw new AppError('VALIDATION_FAILED');
    if (body.status === 'accepted' && issue.suggestion === null)
      throw new AppError('VALIDATION_FAILED');

    const updated = await this.prisma.issue.update({
      where: { id },
      data: { status: body.status, userText: body.status === 'edited' ? userText : null },
    });
    return toIssueDto(updated);
  }
}
