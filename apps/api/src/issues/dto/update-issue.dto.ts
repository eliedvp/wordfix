import { ISSUE_STATUSES, type IssueStatus } from '@wordfix/shared';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateIssueDto {
  @IsIn(ISSUE_STATUSES)
  status!: IssueStatus;

  /** Texte de l'utilisateur, obligatoire avec le statut « edited ». */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  userText?: string;
}
