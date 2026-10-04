const numberFormat = new Intl.NumberFormat('fr-FR');

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
}

export function formatPages(pages: number): string {
  return `${formatNumber(pages)} ${pages > 1 ? 'pages estimées' : 'page estimée'}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** « dans 6 jours », « dans 3 h », « expiré ». */
export function formatTimeLeft(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expiré';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'dans moins d’une heure';
  if (hours < 48) return `dans ${hours} h`;
  return `dans ${Math.floor(hours / 24)} jours`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'moins d’une minute';
  const minutes = Math.round(seconds / 60);
  return `environ ${minutes} min`;
}
