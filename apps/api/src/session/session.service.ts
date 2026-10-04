import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { newId } from '../common/ids.js';
import type { Env } from '../config/env.schema.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const SESSION_COOKIE = 'wf_sid';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** On ne met à jour lastSeenAt qu'une fois par heure, pour éviter une écriture par requête. */
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Session anonyme (décision D3).
 *
 * Le navigateur reçoit un jeton aléatoire de 256 bits dans un cookie httpOnly ;
 * la base ne stocke que son empreinte SHA-256. Un utilisateur invité n'est créé
 * qu'au premier import : la simple visite du site ne crée rien en base.
 * Les futurs comptes réutiliseront cet utilisateur (isGuest = false, email).
 */
@Injectable()
export class SessionService {
  private readonly secureCookie: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookie = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /** Utilisateur de la session courante, ou null s'il n'y en a pas (ou plus). */
  async currentUser(req: Request): Promise<User | null> {
    const token = this.readToken(req);
    if (!token) return null;

    const user = await this.prisma.user.findUnique({
      where: { sessionTokenHash: hashToken(token) },
    });
    if (user && Date.now() - user.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    }
    return user;
  }

  /** Utilisateur de la session ; crée un invité et pose le cookie si nécessaire. */
  async ensureUser(req: Request, res: Response): Promise<User> {
    const existing = await this.currentUser(req);
    if (existing) return existing;

    const token = randomBytes(32).toString('base64url');
    const user = await this.prisma.user.create({
      data: { id: newId('usr'), isGuest: true, sessionTokenHash: hashToken(token) },
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.secureCookie,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
    return user;
  }

  private readToken(req: Request): string | null {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[SESSION_COOKIE];
    // Un jeton valide fait exactement 43 caractères base64url (32 octets).
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
}
