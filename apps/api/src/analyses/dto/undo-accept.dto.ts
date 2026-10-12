import { MAX_BULK_ISSUES } from '@wordfix/shared';
import { ArrayMaxSize, IsArray, Matches } from 'class-validator';

/** Points à remettre « à traiter » : ceux acceptés par un « Tout corriger ». */
export class UndoAcceptDto {
  @IsArray()
  @ArrayMaxSize(MAX_BULK_ISSUES)
  @Matches(/^iss_[0-9a-z]{20}$/, { each: true })
  issueIds!: string[];
}
