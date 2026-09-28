import { CircleNotch } from "@phosphor-icons/react";
import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "medium" | "large";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    variant = "primary",
    size = "medium",
    loading = false,
    fullWidth = false,
    startIcon,
    endIcon,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        "ui-button",
        `ui-button--${variant}`,
        `ui-button--${size}`,
        fullWidth && "ui-button--full-width",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <CircleNotch className="ui-spin" size={20} weight="bold" aria-hidden="true" />
      ) : (
        startIcon && <span className="ui-button__icon">{startIcon}</span>
      )}
      <span className="ui-button__label">{children}</span>
      {!loading && endIcon && <span className="ui-button__icon">{endIcon}</span>}
    </button>
  );
});
