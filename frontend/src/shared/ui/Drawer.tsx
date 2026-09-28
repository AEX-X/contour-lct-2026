import type { ReactNode, RefObject } from "react";
import { DialogBase } from "./DialogBase";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "small" | "medium" | "large";
  side?: "left" | "right";
  className?: string;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Drawer({ size = "medium", side = "right", ...props }: DrawerProps) {
  return <DialogBase kind="drawer" size={size} side={side} {...props} />;
}
