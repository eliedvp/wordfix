import type { NextConfig } from 'next';

/**
 * Adresse interne de l'API NestJS, lue côté serveur uniquement.
 * Le navigateur n'appelle jamais l'API directement : il appelle /api/* sur le
 * domaine du site, et Next.js relaie la requête (décision D4).
 */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
