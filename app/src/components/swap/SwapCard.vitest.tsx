/**
 * Component tests for SwapCard — the disabled-button label ladder per app state, the
 * ADA-funding blockers (over-balance / over-spendable / insufficient-ADA incl. the partial
 * reserve), and stale-quote rejection. The MeshJS
 * wallet hooks, the read hooks, and the tx builder are mocked via vi.hoisted state so each
 * state is driven deterministically. Run with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ADA, POOL, TEST, TOKENS } from "../../test/fixtures";
import { toBaseUnits } from "@/lib/format";

// ---- mocks (hoisted so the vi.mock factories can read mutable state) ----

const h = vi.hoisted(() => ({
  state: {
    connected: false,
    networkId: undefined as number | undefined,
    address: undefined as string | undefined,
    lovelace: "0",
    assets: [] as { unit: string; quantity: string }[],
    wallet: {} as Record<string, unknown>,
  },
  data: {
    tokens: [] as unknown[],
    tokensLoading: false,
    tokensError: null as string | null,
    pools: [] as unknown[],
    quote: null as unknown,
    quoteLoading: false,
    quoteError: null as string | null,
  },
  postOrder: vi.fn(),
  reloadPools: vi.fn(),
  reloadQuote: vi.fn(),
}));

vi.mock("@/lib/wallet/hooks", () => ({
  useWallet: () => ({ connected: h.state.connected, wallet: h.state.wallet }),
  useNetwork: () => h.state.networkId,
  useAddress: () => h.state.address,
  useLovelace: () => h.state.lovelace,
  useAssets: () => h.state.assets,
}));
vi.mock("@/hooks/useTokens", () => ({
  useTokens: () => ({
    tokens: h.data.tokens,
    loading: h.data.tokensLoading,
    error: h.data.tokensError,
  }),
}));
vi.mock("@/hooks/usePools", () => ({
  usePools: () => ({
    pools: h.data.pools,
    loading: false,
    error: null,
    reload: h.reloadPools,
  }),
}));
vi.mock("@/hooks/useQuote", () => ({
  useQuote: () => ({
    quote: h.data.quote,
    loading: h.data.quoteLoading,
    error: h.data.quoteError,
    reload: h.reloadQuote,
  }),
}));
vi.mock("@/lib/client/tx", () => ({ postOrder: (...a: unknown[]) => h.postOrder(...a) }));
vi.mock("@/lib/client/activity", () => ({ recordPost: () => {} }));

// Imported AFTER the mocks are registered.
import { SwapCard } from "./SwapCard";

// ---- helpers ----

const BIG_ADA = "100000000000"; // 100k ADA — never the binding constraint

/** A fresh ADA→TEST quote whose amountIn matches `amount` ADA (so quoteFresh passes). */
function freshQuote(adaAmount: string, amountOut = "19000000000") {
  return {
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn: toBaseUnits(adaAmount, 6),
    amountOut,
    price: "1.9",
    priceImpact: 0.01,
    poolId: POOL.id,
  };
}

function reset() {
  h.state = {
    connected: false,
    networkId: undefined,
    address: undefined,
    lovelace: "0",
    assets: [],
    wallet: {},
  };
  h.data = {
    tokens: TOKENS,
    tokensLoading: false,
    tokensError: null,
    pools: [POOL],
    quote: null,
    quoteLoading: false,
    quoteError: null,
  };
  h.postOrder = vi.fn();
  h.reloadPools = vi.fn();
  h.reloadQuote = vi.fn();
}
beforeEach(reset);

/** The editable (From) amount input — the only non-readOnly textbox before Advanced opens. */
function fromInput(): HTMLInputElement {
  const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
  const el = inputs.find((i) => !i.readOnly);
  if (!el) throw new Error("no editable From input");
  return el;
}
function toInput(): HTMLInputElement {
  const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
  const el = inputs.find((i) => i.readOnly);
  if (!el) throw new Error("no readOnly To input");
  return el;
}
/** Pick the "To" token from its dropdown — it now defaults to UNSELECTED (chip reads
 *  "Select"). The To trigger's accessible name is exactly "Select token"; the From one
 *  reads "Select token (current: …)", so the anchored match targets the To selector. */
function selectTo(ticker: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Select token$/ }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(ticker) }));
}
function typeFrom(v: string) {
  // The "To" side defaults to unselected now; pick TEST first so there's a complete pair
  // before typing the sell amount (mirrors a user choosing what to buy, then the amount).
  if (screen.queryByRole("button", { name: /^Select token$/ })) selectTo("TEST");
  fireEvent.change(fromInput(), { target: { value: v } });
}

describe("SwapCard — disabled-button label ladder", () => {
  it("disconnected → Connect wallet", () => {
    render(<SwapCard />);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeDisabled();
  });

  it("wrong network → Wrong network", () => {
    h.state.connected = true;
    h.state.networkId = 1; // mainnet id on a preprod (id 0) deployment
    render(<SwapCard />);
    expect(screen.getByRole("button", { name: "Wrong network" })).toBeDisabled();
  });

  it("network id still unknown → Checking network…", () => {
    h.state.connected = true;
    h.state.networkId = undefined;
    render(<SwapCard />);
    expect(screen.getByRole("button", { name: "Checking network…" })).toBeDisabled();
  });

  it("connected, no amount → Enter an amount", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    render(<SwapCard />);
    selectTo("TEST");
    expect(screen.getByRole("button", { name: "Enter an amount" })).toBeDisabled();
  });

  it("amount over balance → Insufficient ADA", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = "5000000"; // 5 ADA
    render(<SwapCard />);
    typeFrom("10"); // 10 ADA > 5 ADA balance
    expect(screen.getByRole("button", { name: "Insufficient ADA" })).toBeDisabled();
  });

  it("within balance but inside the ADA reserve → Leave ADA for tip + fees", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = "5000000"; // 5 ADA — exactly the reserve (min 2 + fee 1 + tip 2)
    render(<SwapCard />);
    typeFrom("5"); // == balance: not over balance, but over spendable
    expect(
      screen.getByRole("button", { name: "Leave ADA for tip + fees" }),
    ).toBeDisabled();
  });

  it("no pool for the pair → No pool for this pair", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.pools = []; // nothing trades ADA/TEST
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "No pool for this pair" })).toBeDisabled();
  });

  it("quote read failed → No price right now", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = null;
    h.data.quoteError = "provider blip";
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "No price right now" })).toBeDisabled();
  });

  it("quote in flight → Pip’s pricing it…", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = null;
    h.data.quoteLoading = true;
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "Pip’s pricing it…" })).toBeDisabled();
  });

  it("estimated output rounds to nothing → Amount too small", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = freshQuote("10", "0"); // fresh quote (matches 10 ADA), but zero out → floor 0
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "Amount too small" })).toBeDisabled();
  });

  it("valid quote but tip cleared → Enter a solver tip", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = freshQuote("10");
    render(<SwapCard />);
    typeFrom("10");
    // open Advanced (its button name is "Advanced Show"), clear the solver tip
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    const editables = (screen.getAllByRole("textbox") as HTMLInputElement[]).filter(
      (i) => !i.readOnly,
    );
    fireEvent.change(editables[1], { target: { value: "" } }); // [From, tip]
    expect(screen.getByRole("button", { name: "Enter a solver tip" })).toBeDisabled();
  });

  it("everything valid → Post order (enabled)", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = freshQuote("10");
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "Post order" })).toBeEnabled();
  });
});

describe("SwapCard — non-ADA sell funds min-ADA + tip + fee from wallet ADA", () => {
  function setupTokenSell(lovelace: string) {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = lovelace;
    h.state.assets = [{ unit: TEST.unit, quantity: "1000" }];
    render(<SwapCard />);
    // pick a To token first, THEN flip so the FROM side becomes TEST (a non-ADA sell)
    selectTo("TEST");
    fireEvent.click(screen.getByRole("button", { name: "Swap direction" }));
    typeFrom("10"); // 10 TEST (0 decimals)
  }

  it("not enough wallet ADA for fees → Not enough ADA for fees", () => {
    setupTokenSell("3000000"); // 3 ADA < 5 ADA needed (min 2 + fee 1 + tip 2)
    expect(
      screen.getByRole("button", { name: "Not enough ADA for fees" }),
    ).toBeDisabled();
  });

  it("the partial flag raises the ADA requirement (a second min-ADA)", () => {
    setupTokenSell("6000000"); // 6 ADA: enough for full-fill, NOT for partial (needs 7)
    // full-fill order: 6 ADA covers min 2 + fee 1 + tip 2 = 5 → not blocked on ADA
    expect(
      screen.queryByRole("button", { name: "Not enough ADA for fees" }),
    ).toBeNull();
    // enable partial fills → now needs min 4 + fee 1 + tip 2 = 7 ADA → blocked
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      screen.getByRole("button", { name: "Not enough ADA for fees" }),
    ).toBeDisabled();
  });
});

describe("SwapCard — quoteFresh rejects a stale-amount quote", () => {
  it("a quote for a different amount is ignored (no To value, not postable)", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    // quote priced for a DIFFERENT amount than the one entered
    h.data.quote = { ...freshQuote("999"), amountOut: "5000000000" };
    render(<SwapCard />);
    typeFrom("10");
    // the stale output never lands in the (read-only) To field
    expect(toInput().value).toBe("");
    // and the order is not postable — the button reflects "still fetching", not Post order
    expect(screen.queryByRole("button", { name: "Post order" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pip’s pricing it…" })).toBeDisabled();
  });
});

describe("SwapCard — on-demand price refresh", () => {
  it("the rate-line ↻ re-scans pools and re-quotes (no background polling)", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = freshQuote("10");
    render(<SwapCard />);
    typeFrom("10");
    fireEvent.click(screen.getByRole("button", { name: "Refresh price" }));
    expect(h.reloadPools).toHaveBeenCalledTimes(1);
    expect(h.reloadQuote).toHaveBeenCalledTimes(1);
  });
});

describe("SwapCard — posting", () => {
  it("clicking Post shows Posting order… while the build is in flight", async () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = freshQuote("10");
    h.postOrder.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SwapCard />);
    typeFrom("10");
    fireEvent.click(screen.getByRole("button", { name: "Post order" }));
    expect(
      await screen.findByRole("button", { name: "Posting order…" }),
    ).toBeDisabled();
    expect(h.postOrder).toHaveBeenCalledTimes(1);
  });

  it("a successful post shows the Order posted ✓ banner", async () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.quote = freshQuote("10");
    h.postOrder.mockResolvedValue({
      txHash: "ab".repeat(32),
      orderRef: `${"ab".repeat(32)}#0`,
      owner: "addr_test1...",
    });
    render(<SwapCard />);
    typeFrom("10");
    fireEvent.click(screen.getByRole("button", { name: "Post order" }));
    expect(await screen.findByText(/Order posted/i)).toBeInTheDocument();
  });
});
