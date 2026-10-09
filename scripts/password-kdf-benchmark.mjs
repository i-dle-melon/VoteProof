// Local-only performance assessment. No wrangler config, .dev.vars, D1, R2,
// production credentials, deployment, or performance assertions in npm test.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";

const samples = 40, warmups = 5, compatibilityDate = "2026-10-07";
const bundle = await build({ entryPoints: [fileURLToPath(new URL("./lib/password-kdf-benchmark-worker.js", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const round = (n) => Math.round(n * 100) / 100;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median_ms: round((sorted[samples / 2 - 1] + sorted[samples / 2]) / 2),
    p95_ms: round(sorted[Math.ceil(samples * 0.95) - 1]), samples_ms: values.map(round) };
}
function powershell(code) {
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim());
}
function workerPid() {
  if (platform() !== "win32") return null;
  // Select ONLY the dedicated child PID/name. Never inspect a command line.
  const children = powershell(`@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}" | Select-Object ProcessId,Name) | ConvertTo-Json -Compress`);
  const matches = [children].flat().filter((p) => p?.Name === "workerd.exe");
  if (matches.length !== 1) throw new Error("Cannot isolate benchmark workerd process");
  return matches[0].ProcessId;
}
function processMetrics(pid) {
  if (pid === null) return null;
  return powershell(`$kdfProcess = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{cpu_ms=$kdfProcess.TotalProcessorTime.TotalMilliseconds; rss_bytes=$kdfProcess.WorkingSet64; peak_rss_bytes=$kdfProcess.PeakWorkingSet64; private_bytes=$kdfProcess.PrivateMemorySize64} | ConvertTo-Json -Compress`);
}
const mib = (n) => round(n / 1024 / 1024);
function memory(baseline, end) {
  if (!baseline || !end) return { status: "unavailable (process counters require Windows)" };
  return { baseline_rss_mib: mib(baseline.rss_bytes), end_rss_mib: mib(end.rss_bytes),
    process_peak_rss_mib: mib(end.peak_rss_bytes), peak_above_baseline_mib: mib(end.peak_rss_bytes - baseline.rss_bytes),
    baseline_private_mib: mib(baseline.private_bytes), end_private_mib: mib(end.private_bytes) };
}

const definitions = [{ algorithm: "scrypt", N: 32768, r: 8, p: 3 },
  ...[100000, 200000, 300000, 600000].map((iterations) => ({ algorithm: "PBKDF2-HMAC-SHA256", iterations }))];
const results = [];
for (const definition of definitions) {
  console.error(`Benchmark: ${definition.algorithm} ${definition.iterations ?? "N=32768 r=8 p=3"}`);
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate, bindings: { AUTH_PASSWORD_PEPPER: randomBytes(32).toString("hex"),
      LOCAL_PASSWORD: randomBytes(24).toString("base64url"), LOCAL_ALGORITHM: definition.algorithm,
      LOCAL_ITERATIONS: definition.iterations ?? 0,
      // Node crypto is ONLY an independent correctness reference; all timed
      // derivations run inside workerd's WebCrypto or production noble scrypt.
      LOCAL_REFERENCE: definition.iterations ? pbkdf2Sync("public benchmark vector", "public benchmark salt",
        definition.iterations, 32, "sha256").toString("hex") : "" } }));
  try {
    await runtime.ready;
    const pid = workerPid();
    const call = async (path) => {
      const response = await runtime.dispatchFetch("https://benchmark.example" + path);
      // Never print runtime errors: a future implementation might embed inputs.
      if (response.status !== 200 || !(await response.json()).ok) throw new Error("Local benchmark operation failed");
    };
    await call("/baseline");
    const baseline = processMetrics(pid);
    const setup = await runtime.dispatchFetch("https://benchmark.example/setup");
    if (setup.status !== 200) {
      results.push({ ...definition, status: "UNSUPPORTED_OR_FAILED", hash: null, verification: null });
      continue;
    }
    const correctness = await setup.json();
    if (!correctness.ok) throw new Error("Local benchmark correctness failed");
    const operations = {};
    for (const path of ["hash", "verify"]) {
      for (let i = 0; i < warmups; i++) await call("/" + path);
      const before = processMetrics(pid), times = [];
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        await call("/" + path);
        times.push(performance.now() - start);
      }
      const after = processMetrics(pid);
      operations[path === "hash" ? "hash" : "verification"] = { ...stats(times),
        workerd_process_cpu_mean_ms: before && after ? round((after.cpu_ms - before.cpu_ms) / samples) : null };
    }
    results.push({ ...definition, status: "PASS", ...operations, correctness,
      memory: memory(baseline, processMetrics(pid)),
      workspace: definition.algorithm === "scrypt" ? "32 MiB main V array; plus small buffers and runtime/GC"
        : "Constant native KDF workspace; iterations increase CPU, not a memory-hard work factor" });
  } finally { await runtime.dispose(); }
}
async function version(name) {
  return JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
}
console.log(JSON.stringify({ measured_at: new Date().toISOString(), runtime: "isolated local workerd",
  versions: { node: process.version, workerd: await version("workerd"), miniflare: await version("miniflare"), wrangler: await version("wrangler") },
  hardware: { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model }, compatibility_date: compatibilityDate,
  samples_per_operation: samples, warmups_per_operation: warmups, derived_bytes: 32, salt_bytes: 16,
  timing: "Host wall clock dispatch/response includes IPC, pepper HMAC and comparison; verification uses an existing record and ONE KDF",
  cpu: "Dedicated workerd process TotalProcessorTime delta / sample count; includes local runtime overhead and background GC, excludes host Node; not Production billed CPU",
  memory: "Fresh workerd process per parameter group; Windows process RSS/private/peak includes ALL runtime isolates and GC; not exact KDF allocation or Workers 128 MB isolate usage",
  native: "PBKDF2 calls unmodified workerd crypto.subtle.importKey/deriveBits; no JS/WASM PBKDF2 or Node crypto in timed Worker",
  results }, null, 2));
if (results.some((r) => r.status !== "PASS")) process.exitCode = 1;
