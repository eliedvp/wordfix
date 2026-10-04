import type { IssueNature } from '@wordfix/shared';
import { NATURES } from '@/lib/nature';
import { cn } from '@/lib/utils';

export function NatureBadge({ nature, className }: { nature: IssueNature; className?: string }) {
  const config = NATURES[nature];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        config.soft,
        config.text,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {config.label}
    </span>
  );
}
