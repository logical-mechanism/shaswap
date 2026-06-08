import { test, expect } from "@playwright/test";

/**
 * Navigation + render smoke for every route, against the MockProvider (read-only
 * surfaces work with no wallet).
 */

test("swap home renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Swap with Pip/i })).toBeVisible();
});

test("pools page lists the mock pools", async ({ page }) => {
  await page.goto("/pools");
  await expect(page.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
  // MockProvider returns pools → at least one "Tend →" row link is present.
  await expect(page.getByRole("link", { name: /Tend/ }).first()).toBeVisible();
});

test("a pool detail page opens from the pools list", async ({ page }) => {
  await page.goto("/pools");
  await page.getByRole("link", { name: /Tend/ }).first().click();
  await expect(page).toHaveURL(/\/pools\/.+/);
  await expect(page.getByRole("link", { name: /All pools/ })).toBeVisible();
});

test("create pool page renders", async ({ page }) => {
  await page.goto("/pools/create");
  await expect(page.getByRole("heading", { name: "Create pool" })).toBeVisible();
});

test("orders page renders", async ({ page }) => {
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
});

test("an unknown route shows the branded 404", async ({ page }) => {
  await page.goto("/nope-not-a-real-page");
  await expect(page.getByText(/Pip looked everywhere/i)).toBeVisible();
});
