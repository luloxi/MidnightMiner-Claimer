// Preload for `npm run claim:headless:guarded`: any attempt to submit a transaction kills the
// process with exit code 99 before the request leaves the machine. Covers fetch and node:http(s).
import http from "node:http";
import https from "node:https";

const isSubmit = (url) => {
  try {
    return /submit/i.test(new URL(url).pathname);
  } catch {
    return /submit/i.test(String(url));
  }
};
const block = () => {
  console.error("GUARD: transaction submit attempted, aborting before it is sent");
  process.exit(99);
};

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (isSubmit(url)) block();
  return realFetch(input, init);
};

for (const mod of [http, https]) {
  for (const name of ["request", "get"]) {
    const real = mod[name];
    mod[name] = function guarded(...args) {
      const first = args[0];
      const url = typeof first === "string" || first instanceof URL
        ? String(first)
        : `http://${first?.hostname ?? first?.host ?? "x"}${first?.path ?? ""}`;
      if (isSubmit(url)) block();
      return real.apply(this, args);
    };
  }
}
