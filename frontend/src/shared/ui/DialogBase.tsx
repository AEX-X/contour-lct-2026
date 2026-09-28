import { X } from "@phosphor-icons/react";
import clsx from "clsx";
import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let openDialogCount = 0;
let previousBodyOverflow = "";
let previousRootInert = false;
let previousRootAriaHidden: string | null = null;

interface DialogBaseProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  kind: "modal" | "drawer";
  size: "small" | "medium" | "large";
  side?: "left" | "right";
  className?: string;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function DialogBase({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  kind,
  size,
  side = "right",
  className,
  closeLabel = "Закрыть",
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
}: DialogBaseProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    if (openDialogCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      previousRootInert = appRoot?.inert ?? false;
      previousRootAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    }
    openDialogCount += 1;
    document.body.style.overflow = "hidden";
    document.body.classList.add("ui-dialog-open");
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute("aria-hidden", "true");
    }

    const focusTimer = window.requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(focusableSelector);
      (target ?? panelRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeOnEscape) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
      );

      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
        document.body.classList.remove("ui-dialog-open");
        if (appRoot) {
          appRoot.inert = previousRootInert;
          if (previousRootAriaHidden === null) appRoot.removeAttribute("aria-hidden");
          else appRoot.setAttribute("aria-hidden", previousRootAriaHidden);
        }
      }
      restoreFocusRef.current?.focus();
    };
  }, [closeOnEscape, initialFocusRef, open]);

  if (!open || typeof document === "undefined") return null;

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div
      className={clsx("ui-dialog-backdrop", `ui-dialog-backdrop--${kind}`)}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={panelRef}
        className={clsx(
          "ui-dialog",
          `ui-dialog--${kind}`,
          `ui-dialog--${size}`,
          kind === "drawer" && `ui-dialog--${side}`,
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="ui-dialog__header">
          <div className="ui-dialog__heading">
            <h2 id={titleId} className="ui-dialog__title">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="ui-dialog__description">
                {description}
              </div>
            )}
          </div>
          <IconButton
            label={closeLabel}
            icon={<X size={20} weight="bold" aria-hidden="true" />}
            onClick={onClose}
            variant="ghost"
          />
        </header>
        <div className="ui-dialog__body u-scroll-area">{children}</div>
        {footer && <footer className="ui-dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
