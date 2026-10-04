import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const CATEGORY = '(spelling|grammar|punctuation|style|coherence|structure)';
const NATURE = '(error|suggestion|potential|verify)';

/** Filtres de la liste des problèmes (valeurs multiples séparées par des virgules). */
export class ListIssuesQuery {
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^${CATEGORY}(,${CATEGORY})*$`))
  category?: string;

  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^${NATURE}(,${NATURE})*$`))
  nature?: string;

  /** open = à traiter ; done = déjà traités ; all = tous. */
  @IsOptional()
  @IsIn(['open', 'done', 'all'])
  status?: 'open' | 'done' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
