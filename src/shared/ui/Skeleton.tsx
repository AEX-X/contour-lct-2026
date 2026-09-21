import clsx from "clsx";
import type { CSSProperties, HTMLAttributes } from "react";

type SkeletonStyle = CSSProperties & {
  "--ui-skeleton-width"?: string;
  "--ui-skeleton-height"?: string;
};

export interface SkeletonProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  variant?: "text" | "rectangle" | "circle";
  width?: string | number;
  height?: string | number;
  lines?: number;
}

function toCssSize(value: string | number | undefined) {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

export function Skeleton({
  variant = "text",
  width,
  height,
  lines = 1,
  className,
  style,
  ...props
}: SkeletonProps) {
  const count = Math.max(1, Math.floor(lines));
  const skeletonStyle: SkeletonStyle = {
    ...style,
    "--ui-skeleton-width": toCssSize(width),
    "--ui-skeleton-height": toCssSize(height),
  };

  if (variant === "text" && count > 1) {
    return (
      <span className={clsx("ui-skeleton-group", className)} aria-hidden="true">
        {Array.from({ length: count }, (_, index) => {
          const lineStyle: SkeletonStyle = {
              ...skeletonStyle,
              "--ui-skeleton-width": index === count - 1 ? "72%" : skeletonStyle["--ui-skeleton-width"],
          };

          return <span key={index} className="ui-skeleton ui-skeleton--text" style={lineStyle} />;
        })}
      </span>
    );
  }

  return (
    <span
      className={clsx("ui-skeleton", `ui-skeleton--${variant}`, className)}
      style={skeletonStyle}
      aria-hidden="true"
      {...props}
    />
  );
}
