import { Flask } from "@phosphor-icons/react";
import clsx from "clsx";
import type { HTMLAttributes } from "react";

export interface DemoBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
  compact?: boolean;
}

export function DemoBadge({ label = "Демо-данные", compact = false, className, ...props }: DemoBadgeProps) {
  return (
    <span className={clsx("ui-demo-badge", compact && "ui-demo-badge--compact", className)} {...props}>
      <Flask size={16} weight="bold" aria-hidden="true" />
      <span>{compact ? "Демо" : label}</span>
    </span>
  );
}
