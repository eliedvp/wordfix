import { Injectable, type PipeTransform } from '@nestjs/common';
import { AppError } from '../errors/app-error.js';
import { type IdPrefix, isId } from '../ids.js';

/**
 * Valide un identifiant reçu dans l'URL. Un identifiant mal formé répond 404,
 * comme un identifiant inconnu : on ne révèle rien sur ce qui existe.
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<unknown, string> {
  constructor(private readonly prefix: IdPrefix) {}

  transform(value: unknown): string {
    if (!isId(this.prefix, value)) throw new AppError('NOT_FOUND');
    return value;
  }
}
