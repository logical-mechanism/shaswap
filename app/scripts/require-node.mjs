// Preflight for `npm test`: fail loudly when Node is too old for the test runner.
//
// The test script uses `node --experimental-strip-types` (Node >= 22.6) to run the
// `.test.ts` files directly. On an older Node that flag is rejected with a "bad option"
// message, yet the npm script can still exit 0 — a FALSE GREEN that hides the fact that
// zero tests ran. This guard turns that into a clear, non-zero failure.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `\n✗ Node ${process.versions.node} is too old to run the tests.\n` +
      `  The runner needs Node >= 22.6 (TypeScript type-stripping).\n` +
      `  Use the version pinned in .nvmrc:  nvm use\n`,
  );
  process.exit(1);
}
