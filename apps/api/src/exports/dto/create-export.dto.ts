import { IsBoolean, IsOptional } from 'class-validator';

/** Options « Embellir mon document » (absentes : corrections seules). */
export class CreateExportDto {
  @IsOptional()
  @IsBoolean()
  typography?: boolean;

  @IsOptional()
  @IsBoolean()
  layout?: boolean;
}
