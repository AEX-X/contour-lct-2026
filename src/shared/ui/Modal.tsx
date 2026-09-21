import type { ReactNode, RefObject } from "react";
import { DialogBase } from "./DialogBase";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "small" | "medium" | "large";
  className?: string;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Modal({ size = "medium", ...props }: ModalProps) {
  return <DialogBase kind="modal" size={size} {...props} />;
}
