import { WarningOctagon } from "@phosphor-icons/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import "../../styles/index.css";
import { Button } from "./Button";
import { KpiCard } from "./KpiCard";
import { Modal } from "./Modal";
import { Progress } from "./Progress";
import { SegmentedControl } from "./SegmentedControl";

describe("design-system primitives", () => {
  it("marks a loading button as busy and unavailable", () => {
    render(<Button loading>Сохранить</Button>);

    const button = screen.getByRole("button", { name: "Сохранить" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("exposes KPI drilldown as an accessible button", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <KpiCard
        label="Критические инциденты"
        value={3}
        icon={WarningOctagon}
        tone="critical"
        onClick={onClick}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Открыть: Критические инциденты" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("supports keyboard navigation in a segmented control", async () => {
    const user = userEvent.setup();

    function Example() {
      const [value, setValue] = useState("map");
      return (
        <SegmentedControl
          label="Представление объектов"
          value={value}
          onChange={setValue}
          items={[
            { value: "map", label: "Карта" },
            { value: "list", label: "Список" },
          ]}
        />
      );
    }

    render(<Example />);
    const map = screen.getByRole("radio", { name: "Карта" });
    const list = screen.getByRole("radio", { name: "Список" });

    map.focus();
    await user.keyboard("{ArrowRight}");

    expect(list).toHaveFocus();
    expect(list).toHaveAttribute("aria-checked", "true");
  });

  it("announces progress using native progressbar semantics", () => {
    render(<Progress label="Доступность датчиков" value={91} showValue />);

    const progress = screen.getByRole("progressbar", { name: "Доступность датчиков" });
    expect(progress).toHaveAttribute("aria-valuenow", "91");
    expect(progress).toHaveAttribute("aria-valuetext", "91%");
  });

  it("closes a modal with Escape and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Открыть
          </button>
          <Modal
            open={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            title="Подтверждение"
          >
            <button type="button">Продолжить</button>
          </Modal>
        </>
      );
    }

    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Открыть" });
    await user.click(trigger);

    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
