import clsx from "clsx";
import type { CSSProperties, HTMLAttributes } from "react";
import type { StatusTone } from "./StatusBadge";

type ProgressStyle = CSSProperties & { "--ui-progress-value"?: string };

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  value?: number;
  max?: number;
  label?: string;
  valueLabel?: string;
  showValue?: boolean;
  tone?: StatusTone;
  size?: "small" | "medium";
  indeterminate?: boolean;
}

export function Progress({
  value = 0,
  max = 100,
  label,
  valueLabel,
  showValue = false,
  tone = "info",
  size = "medium",
  indeterminate = false,
  className,
  ...props
}: ProgressProps) {
  const safeMax = max > 0 ? max : 100;
  const safeValue = Math.min(Math.max(value, 0), safeMax);
  const percentage = (safeValue / safeMax) * 100;
  const announcedValue = valueLabel ?? `${Math.round(percentage)}%`;
  const style: ProgressStyle = {
    "--ui-progress-value": indeterminate ? "40%" : `${percentage}%`,
  };

  return (
    <div className={clsx("ui-progress", `ui-progress--${size}`, className)} {...props}>
      {(label || showValue) && (
        <div className="ui-progress__header">
          {label && <span className="ui-progress__label">{label}</span>}
          {showValue && <span className="ui-progress__value u-tabular-nums">{announcedValue}</span>}
        </div>
      )}
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={label ?? "Прогресс"}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={indeterminate ? undefined : safeValue}
        aria-valuetext={indeterminate ? "Выполняется" : announcedValue}
      >
        <span
          className={clsx(
            "ui-progress__bar",
            `ui-progress__bar--${tone}`,
            indeterminate && "is-indeterminate",
          )}
          style={style}
        />
      </div>
    </div>
  );
}
