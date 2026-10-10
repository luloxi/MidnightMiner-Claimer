// Preload for `npm run claim:headless:guarded`: any attempt to submit a transaction kills the
// process with exit code 99 before the request leaves the machine. Proof that dry-run never submits.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (/\/tx\/submit\b/.test(url) || /\/submit\b/i.test(new URL(url).pathname)) {
    console.error("GUARD: transaction submit attempted, aborting before it is sent");
    process.exit(99);
  }
  return realFetch(input, init);
};
