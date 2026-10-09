// Dedicated local workerd benchmark; no routes/bindings deployed, no secrets printed.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
const cryptoModule = fileURLToPath(
  new URL("../src/lib/legacy-password-kdf.js", import.meta.url),
).replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import {passwordRecord,verifyPassword} from ${JSON.stringify(cryptoModule)};
export default { async fetch(request,env) {
 const value=env.LOCAL_BENCH_PASSWORD;
 const record=await passwordRecord(value,env);
 if(new URL(request.url).pathname==='/pair' && !await verifyPassword(value,record,env)) throw new Error('Benchmark verification failed');
 return Response.json({verified:true}); } };`,
    resolveDir: process.cwd(),
    sourcefile: "local-kdf-benchmark.js",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-07",
    bindings: {
      AUTH_PASSWORD_PEPPER: randomBytes(32).toString("hex"),
      LOCAL_BENCH_PASSWORD: randomBytes(24).toString("base64url"),
    },
  }),
);
try {
  await runtime.ready;
  const hash = [],
    pair = [];
  for (const [path, result] of [
    ["/", hash],
    ["/pair", pair],
  ])
    for (let i = 0; i < 5; i++) {
      const start = performance.now(),
        r = await runtime.dispatchFetch("https://benchmark.example" + path);
      if (r.status !== 200) throw new Error("Benchmark failed");
      await r.json();
      result.push(Math.round(performance.now() - start));
    }
  console.log(
    JSON.stringify(
      {
        runtime: "local workerd",
        algorithm: "scrypt",
        N: 32768,
        r: 8,
        p: 3,
        derived_bytes: 32,
        memory_mib: 32,
        measurement:
          "Host wall clock around workerd dispatch; includes IPC/HMAC, not Production CPU billing",
        hash_ms: hash,
        hash_median_ms: [...hash].sort((a, b) => a - b)[2],
        hash_and_verify_ms: pair,
        requires_paid_cpu_budget: true,
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.dispose();
}
