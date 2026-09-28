import { Info, type Icon } from "@phosphor-icons/react";
import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: ReactNode;
  icon?: Icon;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  icon: EmptyIcon = Info,
  action,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={clsx("ui-empty-state", compact && "ui-empty-state--compact", className)}
      {...props}
    >
      <span className="ui-empty-state__icon">
        <EmptyIcon size={28} weight="duotone" aria-hidden="true" />
      </span>
      <div className="ui-empty-state__copy">
        <h3 className="ui-empty-state__title">{title}</h3>
        {description && <p className="ui-empty-state__description">{description}</p>}
      </div>
      {action && <div className="ui-empty-state__action">{action}</div>}
    </div>
  );
}
