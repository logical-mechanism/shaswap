/**
 * Component tests for SwapCard — the disabled-button label ladder per app state, the
 * ADA-funding blockers (over-balance / over-spendable / insufficient-ADA incl. the partial
 * reserve), stale-route rejection, and the split-route breakdown. The MeshJS wallet hooks,
 * the read hooks, and the tx builder are mocked via vi.hoisted state so each state is driven
 * deterministically. Run with `npm run test:components`.
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
    route: null as unknown,
    routeLoading: false,
    routeError: null as string | null,
  },
  postOrders: vi.fn(),
  reloadPools: vi.fn(),
  reloadRoute: vi.fn(),
}));

vi.mock("@/lib/wallet/hooks", () => ({
  useWallet: () => ({
    connected: h.state.connected,
    wallet: h.state.wallet,
    refresh: vi.fn(),
  }),
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
vi.mock("@/hooks/useRoute", () => ({
  useRoute: () => ({
    route: h.data.route,
    loading: h.data.routeLoading,
    error: h.data.routeError,
    reload: h.reloadRoute,
  }),
}));
vi.mock("@/lib/client/tx", () => ({ postOrders: (...a: unknown[]) => h.postOrders(...a) }));
vi.mock("@/lib/client/activity", () => ({ recordPost: () => {} }));

// Imported AFTER the mocks are registered.
import { SwapCard } from "./SwapCard";

// ---- helpers ----

const BIG_ADA = "100000000000"; // 100k ADA — never the binding constraint

/**
 * A fresh ADA→TEST single-leg route whose amountIn matches `adaAmount` (so routeFresh
 * passes). One leg against the fixture POOL — i.e. the no-split, single-pool case.
 */
function freshRoute(adaAmount: string, amountOut = "19000000000") {
  const amountIn = toBaseUnits(adaAmount, 6);
  return {
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn,
    tip: "500000", // matches the default 0.5 ₳ tip, so routeFresh's tip check passes
    amountOut,
    price: "1.9",
    priceImpact: 0.01,
    legs: [
      { poolId: POOL.id, amountIn, amountOut, feeBps: POOL.feeBps, priceImpact: 0.01 },
    ],
    singleBestOut: amountOut,
    singleBestPoolId: POOL.id,
  };
}

/** A two-leg ADA→TEST split route across POOL and a second pool, beating the best single. */
function splitRoute(adaAmount: string) {
  const amountIn = toBaseUnits(adaAmount, 6);
  const half = (BigInt(amountIn) / 2n).toString();
  return {
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn,
    tip: "500000",
    amountOut: "19500000000",
    price: "1.95",
    priceImpact: 0.02,
    legs: [
      { poolId: POOL.id, amountIn: half, amountOut: "9800000000", feeBps: POOL.feeBps, priceImpact: 0.02 },
      { poolId: "pool2", amountIn: half, amountOut: "9700000000", feeBps: 5, priceImpact: 0.02 },
    ],
    singleBestOut: "19000000000",
    singleBestPoolId: POOL.id,
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
    route: null,
    routeLoading: false,
    routeError: null,
  };
  h.postOrders = vi.fn();
  h.reloadPools = vi.fn();
  h.reloadRoute = vi.fn();
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
    h.state.lovelace = "5000000"; // 5 ADA — selling all of it leaves nothing for the
    // min-ADA + fee + tip reserve (min 2 + fee 1 + tip 0.5 = 3.5)
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

  it("route read failed → No price right now", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = null;
    h.data.routeError = "provider blip";
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "No price right now" })).toBeDisabled();
  });

  it("route in flight → Pip’s pricing it…", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = null;
    h.data.routeLoading = true;
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "Pip’s pricing it…" })).toBeDisabled();
  });

  it("estimated output rounds to nothing → Amount too small", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = freshRoute("10", "0"); // fresh route, but zero out → leg floor 0
    render(<SwapCard />);
    typeFrom("10");
    expect(screen.getByRole("button", { name: "Amount too small" })).toBeDisabled();
  });

  it("valid route but tip cleared → Enter a solver tip", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = freshRoute("10");
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
    h.data.route = freshRoute("10");
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
    setupTokenSell("3000000"); // 3 ADA < 3.5 needed (min 2 + fee 1 + tip 0.5)
    expect(
      screen.getByRole("button", { name: "Not enough ADA for fees" }),
    ).toBeDisabled();
  });

  it("the partial flag raises the ADA requirement (a second min-ADA)", () => {
    setupTokenSell("4000000"); // 4 ADA: enough for full-fill (3.5), NOT for partial (5.5)
    // full-fill order: 4 ADA covers min 2 + fee 1 + tip 0.5 = 3.5 → not blocked on ADA
    expect(
      screen.queryByRole("button", { name: "Not enough ADA for fees" }),
    ).toBeNull();
    // enable partial fills → now needs min 4 + fee 1 + tip 0.5 = 5.5 ADA → blocked
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      screen.getByRole("button", { name: "Not enough ADA for fees" }),
    ).toBeDisabled();
  });
});

describe("SwapCard — routeFresh rejects a stale-amount route", () => {
  it("a route for a different amount is ignored (no To value, not postable)", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    // route priced for a DIFFERENT amount than the one entered
    h.data.route = { ...freshRoute("999"), amountOut: "5000000000" };
    render(<SwapCard />);
    typeFrom("10");
    // the stale output never lands in the (read-only) To field
    expect(toInput().value).toBe("");
    // and the order is not postable — the button reflects "still fetching", not Post order
    expect(screen.queryByRole("button", { name: "Post order" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pip’s pricing it…" })).toBeDisabled();
  });
});

describe("SwapCard — split route breakdown", () => {
  it("a two-leg route shows the per-pool split and the gain over one pool", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.pools = [POOL, { ...POOL, id: "pool2", feeBps: 5 }];
    h.data.route = splitRoute("10");
    render(<SwapCard />);
    typeFrom("10");
    // expand the rate-line details, then assert the split breakdown is shown. "Routed
    // across 2 pools" appears both in the visible breakdown and the sr-only announcement.
    fireEvent.click(screen.getByRole("button", { name: /1 ADA/ }));
    expect(screen.getAllByText(/Routed across 2 pools/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/vs one pool/i)).toBeInTheDocument();
    // still postable (one tx, two legs)
    expect(screen.getByRole("button", { name: "Post order" })).toBeEnabled();
  });
});

describe("SwapCard — on-demand price refresh", () => {
  it("the rate-line ↻ re-scans pools and re-routes (no background polling)", () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = freshRoute("10");
    render(<SwapCard />);
    typeFrom("10");
    fireEvent.click(screen.getByRole("button", { name: "Refresh price" }));
    expect(h.reloadPools).toHaveBeenCalledTimes(1);
    expect(h.reloadRoute).toHaveBeenCalledTimes(1);
  });
});

describe("SwapCard — posting", () => {
  it("clicking Post shows Posting order… while the build is in flight", async () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = freshRoute("10");
    h.postOrders.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SwapCard />);
    typeFrom("10");
    fireEvent.click(screen.getByRole("button", { name: "Post order" }));
    expect(
      await screen.findByRole("button", { name: "Posting order…" }),
    ).toBeDisabled();
    expect(h.postOrders).toHaveBeenCalledTimes(1);
  });

  it("a successful post shows the Order posted ✓ banner", async () => {
    h.state.connected = true;
    h.state.networkId = 0;
    h.state.lovelace = BIG_ADA;
    h.data.route = freshRoute("10");
    h.postOrders.mockResolvedValue({
      txHash: "ab".repeat(32),
      orderRefs: [`${"ab".repeat(32)}#0`],
      owner: "addr_test1...",
    });
    render(<SwapCard />);
    typeFrom("10");
    fireEvent.click(screen.getByRole("button", { name: "Post order" }));
    expect(await screen.findByText(/Order posted/i)).toBeInTheDocument();
  });
});
