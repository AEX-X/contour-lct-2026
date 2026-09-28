import {
  CheckCircle,
  Info,
  WarningCircle,
  WarningOctagon,
  X,
  type Icon,
} from "@phosphor-icons/react";
import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";
import { IconButton } from "./IconButton";

export type AlertTone = "info" | "success" | "warning" | "critical";

const alertIcons: Record<AlertTone, Icon> = {
  info: Info,
  success: CheckCircle,
  warning: WarningCircle,
  critical: WarningOctagon,
};

export interface InlineAlertProps extends HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone;
  title: string;
  children?: ReactNode;
  icon?: Icon;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function InlineAlert({
  tone = "info",
  title,
  children,
  icon,
  action,
  onDismiss,
  dismissLabel = "Закрыть сообщение",
  className,
  ...props
}: InlineAlertProps) {
  const AlertIcon = icon ?? alertIcons[tone];

  return (
    <div
      className={clsx("ui-inline-alert", `ui-inline-alert--${tone}`, className)}
      role={tone === "critical" ? "alert" : "status"}
      {...props}
    >
      <AlertIcon className="ui-inline-alert__icon" size={22} weight="bold" aria-hidden="true" />
      <div className="ui-inline-alert__content">
        <p className="ui-inline-alert__title">{title}</p>
        {children && <div className="ui-inline-alert__body">{children}</div>}
        {action && <div className="ui-inline-alert__action">{action}</div>}
      </div>
      {onDismiss && (
        <IconButton
          className="ui-inline-alert__dismiss"
          label={dismissLabel}
          icon={<X size={18} weight="bold" aria-hidden="true" />}
          onClick={onDismiss}
          variant="ghost"
        />
      )}
    </div>
  );
}
