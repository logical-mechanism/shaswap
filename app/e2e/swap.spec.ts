import { test, expect } from "@playwright/test";

/**
 * Swap-card read surface against the MockProvider: amount entry produces a rate +
 * minimum-received, and changing the output token re-quotes. No wallet is needed — the
 * quote flows through /api/quote → MockProvider.
 */

test("entering an amount shows a rate and a minimum-received row", async ({ page }) => {
  await page.goto("/");
  // From defaults to ADA; the first decimal input is its amount field.
  await page.locator('input[inputmode="decimal"]').first().fill("100");
  // the collapsed rate summary updates from the mock quote (ADA → TEST)
  await expect(page.getByText(/1 ADA ≈/)).toBeVisible();
  // expand the breakdown → the Minimum received row is present (exact: the sr-only
  // live region also contains a lowercase "minimum received").
  await page.getByRole("button", { name: /Details/ }).click();
  await expect(page.getByText("Minimum received", { exact: true })).toBeVisible();
});

test("changing the output token re-quotes", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[inputmode="decimal"]').first().fill("100");
  await expect(page.getByText(/1 ADA ≈/)).toBeVisible();
  // open the To token select (the second one) and pick HOSKY (mock has an ADA/HOSKY pool)
  await page.getByRole("button", { name: /Select token/ }).nth(1).click();
  await page.getByRole("option", { name: /HOSKY/ }).click();
  await expect(page.getByText(/1 ADA ≈/)).toBeVisible();
  // the To token select now reflects HOSKY (unambiguous vs. the rate line / live region)
  await expect(page.getByRole("button", { name: /current: HOSKY/ })).toBeVisible();
});
