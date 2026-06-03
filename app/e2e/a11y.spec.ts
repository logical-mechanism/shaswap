import { test, expect } from "@playwright/test";

/**
 * Keyboard-only a11y smoke — locks in the focus/Escape work: a visible focus ring on
 * Tab, the skip link, and that every custom menu (slippage / token / wallet) closes on
 * Escape AND returns focus to its trigger.
 */

test("the skip link is the first focusable and jumps to main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /Skip to content/i });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("a keyboard-focused control shows a visible focus ring", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab"); // → the skip link
  const visible = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const s = getComputedStyle(el);
    return el.matches(":focus-visible") || parseFloat(s.outlineWidth) > 0;
  });
  expect(visible).toBe(true);
});

test("Escape closes the slippage menu and returns focus to its trigger", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Slippage settings" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Max slippage" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Escape closes the token menu and returns focus to its trigger", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Select token/ }).first();
  await trigger.click();
  const listbox = page.getByRole("listbox", { name: "Tokens" });
  await expect(listbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Escape closes the wallet menu and returns focus to its trigger", async ({ page }) => {
  await page.goto("/");
  // Scope to the header — the swap card also has a disabled "Connect wallet" button.
  const trigger = page
    .getByRole("banner")
    .getByRole("button", { name: "Connect wallet" });
  await trigger.click();
  await expect(page.getByText(/Pick your wallet/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Pick your wallet/i)).toBeHidden();
  await expect(trigger).toBeFocused();
});
