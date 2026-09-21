import clsx from "clsx";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentedControlItem {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  items: SegmentedControlItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
  fullWidth?: boolean;
  disabled?: boolean;
}

export function SegmentedControl({
  items,
  value,
  onChange,
  label,
  className,
  fullWidth = false,
  disabled = false,
}: SegmentedControlProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (currentIndex: number, direction: 1 | -1) => {
    if (items.length === 0) return;

    for (let offset = 1; offset <= items.length; offset += 1) {
      const nextIndex = (currentIndex + direction * offset + items.length) % items.length;
      if (!items[nextIndex]?.disabled && !disabled) {
        itemRefs.current[nextIndex]?.focus();
        onChange(items[nextIndex]!.value);
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index, 1);
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index, -1);
    }

    if (event.key === "Home") {
      event.preventDefault();
      const firstEnabled = items.findIndex((item) => !item.disabled);
      if (firstEnabled >= 0) {
        itemRefs.current[firstEnabled]?.focus();
        onChange(items[firstEnabled]!.value);
      }
    }

    if (event.key === "End") {
      event.preventDefault();
      let lastEnabled = -1;
      for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        if (!items[itemIndex]?.disabled) {
          lastEnabled = itemIndex;
          break;
        }
      }
      if (lastEnabled >= 0) {
        itemRefs.current[lastEnabled]?.focus();
        onChange(items[lastEnabled]!.value);
      }
    }
  };

  return (
    <div
      className={clsx(
        "ui-segmented-control",
        fullWidth && "ui-segmented-control--full-width",
        className,
      )}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {items.map((item, index) => {
        const selected = item.value === value;

        return (
          <button
            key={item.value}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            className={clsx("ui-segmented-control__item", selected && "is-selected")}
            role="radio"
            aria-checked={selected}
            disabled={disabled || item.disabled}
            tabIndex={selected || (!value && index === 0) ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {item.icon && <span className="ui-segmented-control__icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
