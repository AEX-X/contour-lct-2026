import { CircleNotch } from "@phosphor-icons/react";
import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type IconButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type IconButtonSize = "medium" | "large";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    className,
    variant = "ghost",
    size = "medium",
    loading = false,
    disabled,
    type = "button",
    title,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        "ui-icon-button",
        `ui-icon-button--${variant}`,
        `ui-icon-button--${size}`,
        className,
      )}
      disabled={disabled || loading}
      aria-label={label}
      aria-busy={loading || undefined}
      title={title ?? label}
      {...props}
    >
      {loading ? (
        <CircleNotch className="ui-spin" size={20} weight="bold" aria-hidden="true" />
      ) : (
        icon
      )}
    </button>
  );
});
