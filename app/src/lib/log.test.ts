/**
 * Tests for the structured logger (`log.ts`): level gating, prod JSON shape, and the
 * errText summariser. Run with `npm run test`. Captures console output via a temporary
 * override (no new deps).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { errText, log } from "./log.ts";

/** Run `fn` with console.{log,warn,error} captured; restore env + console after. */
function capture(
  env: Record<string, string | undefined>,
  fn: () => void,
): string[] {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prevEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" ").trim());
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" ").trim());
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" ").trim());
  try {
    fn();
  } finally {
    Object.assign(console, orig);
    for (const k of Object.keys(prevEnv)) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
  return lines;
}

test("LOG_LEVEL gates lower levels", () => {
  const lines = capture({ LOG_LEVEL: "warn", NODE_ENV: "development" }, () => {
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.equal(lines.length, 2); // warn + error only
  assert.ok(lines.some((l) => l.includes("w")));
  assert.ok(lines.some((l) => l.includes("e")));
});

test("production emits one JSON object per line with level/msg/fields/ts", () => {
  const [line] = capture({ NODE_ENV: "production", LOG_LEVEL: "info" }, () => {
    log.info("order posted", { txHash: "abc", n: 3 });
  });
  const obj = JSON.parse(line) as Record<string, unknown>;
  assert.equal(obj.level, "info");
  assert.equal(obj.msg, "order posted");
  assert.equal(obj.txHash, "abc");
  assert.equal(obj.n, 3);
  assert.equal(typeof obj.ts, "string");
});

test("errText summarises Error/string/object and truncates", () => {
  assert.equal(errText(new Error("boom")), "boom");
  assert.equal(errText("plain"), "plain");
  assert.match(errText({ code: 2 }), /"code":2/);
  assert.equal(errText("x".repeat(500)).length, 301); // 300 + ellipsis
});
