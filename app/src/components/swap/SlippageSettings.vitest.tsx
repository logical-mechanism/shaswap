/**
 * Component tests for SlippageSettings (Vitest + jsdom + @testing-library). The value is
 * NOT cosmetic — it sets the enforced floor / min-out — so the custom-input edge cases
 * (clear→default, lone ".", clamp to [0,50], reject negatives) and preset highlighting
 * are worth pinning. Run with `npm run test:components`.
 */

import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SlippageSettings } from "./SlippageSettings";

/** Controlled wrapper: records onChange AND reflects the new value (so highlighting updates). */
function setup(initial = 0.5) {
  const onChange = vi.fn<(v: number) => void>();
  function Wrapper() {
    const [v, setV] = useState(initial);
    return (
      <SlippageSettings
        value={v}
        onChange={(n) => {
          onChange(n);
          setV(n);
        }}
      />
    );
  }
  render(<Wrapper />);
  // Open the popover so the presets + custom field are in the DOM.
  fireEvent.click(screen.getByLabelText("Slippage settings"));
  const custom = screen.getByLabelText("Custom max slippage percent");
  return { onChange, custom };
}

describe("SlippageSettings", () => {
  it("highlights the active preset and clears it for a custom value", () => {
    setup(0.5);
    expect(screen.getByRole("button", { name: "0.5%" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "1.0%" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Pick a different preset → it becomes active.
    fireEvent.click(screen.getByRole("button", { name: "1.0%" }));
    expect(screen.getByRole("button", { name: "1.0%" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("a custom value deactivates every preset", () => {
    const { custom } = setup(0.5);
    fireEvent.change(custom, { target: { value: "2.5" } });
    for (const name of ["0.1%", "0.5%", "1.0%"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  it("a custom value calls onChange with the parsed number", () => {
    const { onChange, custom } = setup(0.5);
    fireEvent.change(custom, { target: { value: "2.5" } });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
  });

  it("clearing the custom field reverts to the 0.5 default", () => {
    const { onChange, custom } = setup(0.5);
    fireEvent.change(custom, { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.change(custom, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(0.5);
  });

  it("a lone '.' is held in the field but does NOT emit a (NaN) change", () => {
    const { onChange, custom } = setup(0.5);
    onChange.mockClear();
    fireEvent.change(custom, { target: { value: "." } });
    expect(onChange).not.toHaveBeenCalled();
    expect(custom).toHaveValue("."); // accepted as in-progress input
  });

  it("clamps a custom value above 50 down to 50", () => {
    const { onChange, custom } = setup(0.5);
    fireEvent.change(custom, { target: { value: "99" } });
    expect(onChange).toHaveBeenLastCalledWith(50);
  });

  it("rejects a negative custom value (regex blocks the '-')", () => {
    const { onChange, custom } = setup(0.5);
    onChange.mockClear();
    fireEvent.change(custom, { target: { value: "-5" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(custom).toHaveValue(""); // the '-' never lands
  });

  it("shows the high-tolerance caution only above 5%", () => {
    const { custom } = setup(0.5);
    expect(screen.queryByText(/High tolerance/i)).not.toBeInTheDocument();
    fireEvent.change(custom, { target: { value: "7" } });
    expect(screen.getByText(/High tolerance/i)).toBeInTheDocument();
  });
});
