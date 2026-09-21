import { ArrowDown, ArrowRight, ArrowUp, Minus, type Icon } from "@phosphor-icons/react";
import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";
import type { StatusTone } from "./StatusBadge";

export type KpiTrendDirection = "up" | "down" | "flat";
export type KpiTrendSentiment = "positive" | "negative" | "neutral";

export interface KpiTrend {
  value: string;
  label?: string;
  direction?: KpiTrendDirection;
  sentiment?: KpiTrendSentiment;
}

export interface KpiCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  label: string;
  value: ReactNode;
  icon: Icon;
  tone?: StatusTone;
  detail?: ReactNode;
  trend?: KpiTrend;
  onClick?: () => void;
  actionLabel?: string;
}

const trendIcons: Record<KpiTrendDirection, Icon> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
};

export function KpiCard({
  label,
  value,
  icon: KpiIcon,
  tone = "info",
  detail,
  trend,
  onClick,
  actionLabel,
  className,
  ...props
}: KpiCardProps) {
  const TrendIcon = trend ? trendIcons[trend.direction ?? "flat"] : null;
  const content = (
    <>
      <span className={clsx("ui-kpi-card__icon", `ui-kpi-card__icon--${tone}`)}>
        <KpiIcon size={28} weight="duotone" aria-hidden="true" />
      </span>
      <span className="ui-kpi-card__content">
        <span className="ui-kpi-card__label">{label}</span>
        <span className="ui-kpi-card__value u-tabular-nums">{value}</span>
        {trend && TrendIcon && (
          <span
            className={clsx(
              "ui-kpi-card__trend",
              `ui-kpi-card__trend--${trend.sentiment ?? "neutral"}`,
            )}
          >
            <TrendIcon size={14} weight="bold" aria-hidden="true" />
            <span>{trend.value}</span>
            {trend.label && <span className="ui-kpi-card__trend-label">{trend.label}</span>}
          </span>
        )}
        {!trend && detail && <span className="ui-kpi-card__detail">{detail}</span>}
      </span>
      {onClick && (
        <ArrowRight className="ui-kpi-card__arrow" size={20} weight="bold" aria-hidden="true" />
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={clsx("ui-kpi-card", "ui-kpi-card--interactive", className)}
        onClick={onClick}
        aria-label={actionLabel ?? `Открыть: ${label}`}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={clsx("ui-kpi-card", className)} {...props}>
      {content}
    </div>
  );
}
