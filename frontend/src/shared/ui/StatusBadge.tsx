import {
  CheckCircle,
  CloudSlash,
  Info,
  Sparkle,
  WarningCircle,
  WarningOctagon,
  type Icon,
} from "@phosphor-icons/react";
import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

export type StatusTone = "critical" | "forecast" | "warning" | "success" | "info" | "neutral";

const defaultIcons: Record<StatusTone, Icon> = {
  critical: WarningOctagon,
  forecast: Sparkle,
  warning: WarningCircle,
  success: CheckCircle,
  info: Info,
  neutral: CloudSlash,
};

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  icon?: Icon | null;
  children: ReactNode;
}

export function StatusBadge({
  tone = "neutral",
  icon,
  children,
  className,
  ...props
}: StatusBadgeProps) {
  const BadgeIcon = icon === undefined ? defaultIcons[tone] : icon;

  return (
    <span className={clsx("ui-status-badge", `ui-status-badge--${tone}`, className)} {...props}>
      {BadgeIcon && <BadgeIcon size={14} weight="bold" aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}
