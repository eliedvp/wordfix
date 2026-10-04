import { randomBytes } from 'node:crypto';

/**
 * Identifiants applicatifs : un préfixe lisible + 20 caractères aléatoires
 * (environ 103 bits d'entropie). Impossibles à deviner, ils ne révèlent ni
 * l'ordre de création ni le nombre d'éléments.
 */
export type IdPrefix = 'usr' | 'doc' | 'ana' | 'chk' | 'iss';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 20;

export function newId(prefix: IdPrefix): string {
  let out = '';
  while (out.length < ID_LENGTH) {
    for (const byte of randomBytes(ID_LENGTH * 2)) {
      // Rejet des octets >= 252 pour une distribution uniforme sur 36 symboles.
      if (byte < 252) out += ALPHABET.charAt(byte % 36);
      if (out.length === ID_LENGTH) break;
    }
  }
  return `${prefix}_${out}`;
}

export function isId(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-z]{${ID_LENGTH}}$`).test(value);
}
