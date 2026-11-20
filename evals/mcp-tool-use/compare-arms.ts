#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Compares runs of the same cases with `--arm tools` and `--arm raw`: `pnpm mcp-tool-use:compare
 * <results.jsonl>... [--model <id>]` prints, per case and arm, the pass rate and what a sample
 * spent on the forge: calls, failed calls, result bytes, requested sleep, and tokens and cost.
 * Rows with an error are skipped. Agent cost is priced only for Claude models.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { PRICES } from "./run.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { model: { type: "string", default: "claude-sonnet-5-5" } },
});

type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
type Call = { step: number; tool: string; input: unknown; failed?: boolean; output?: string };
type Row = {
  id: string;
  arm?: string;
  pass: boolean;
  error?: string;
  calls?: ReadonlyArray<Call>;
  usage: Usage;
  shellUsage: Usage;
};

const FORGE_TOOL =
  /^(pull_request_\w+|ci_logs|ci_rerun|(un)?watch_pull_request|(un)?link_pull_requests?|list_thread_pull_requests)$/;
const FORGE_COMMAND = /(^|[\s;&|(`$])(gh|cafe|glab|tea|src)\s|api\.github\.com|git\.cafe\/api/;
const command = (call: Call) =>
  call.tool === "Bash" && typeof call.input === "object" && call.input !== null
    ? String((call.input as { command?: unknown }).command ?? "")
    : "";
const isForge = (call: Call) => FORGE_TOOL.test(call.tool) || FORGE_COMMAND.test(command(call));
const sleepSeconds = (call: Call) =>
  [...command(call).matchAll(/\bsleep\s+(\d+)/g)].reduce((sum, [, s]) => sum + Number(s), 0) +
  (call.tool === "sleep" || call.tool === "Monitor" ? 60 : 0);

const price = (usage: Usage, model: string) => {
  const rates = (PRICES as Record<string, Usage | undefined>)[model];
  if (rates === undefined) return Number.NaN;
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheWrite * rates.cacheWrite +
      usage.cacheRead * rates.cacheRead) /
    1e6
  );
};

const rows: Array<Row> = positionals.flatMap((file) =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row)
    .filter((row) => row.error === undefined),
);

type Stats = {
  n: number;
  pass: number;
  steps: number;
  forge: number;
  failed: number;
  bytes: number;
  sleep: number;
  help: number;
  tokens: number;
  cost: number;
};
const empty = (): Stats => ({
  n: 0,
  pass: 0,
  steps: 0,
  forge: 0,
  failed: 0,
  bytes: 0,
  sleep: 0,
  help: 0,
  tokens: 0,
  cost: 0,
});
const add = (stats: Stats, row: Row) => {
  const calls = row.calls ?? [];
  const forge = calls.filter(isForge);
  stats.n++;
  if (row.pass) stats.pass++;
  stats.steps += calls.length === 0 ? 1 : Math.max(...calls.map((call) => call.step)) + 1;
  stats.forge += forge.length;
  stats.failed += forge.filter((call) => call.failed === true).length;
  stats.bytes += forge.reduce((sum, call) => sum + (call.output?.length ?? 0), 0);
  stats.sleep += calls.reduce((sum, call) => sum + sleepSeconds(call), 0);
  stats.help += forge.filter((call) => /--help\b|\shelp\s*$/.test(command(call))).length;
  stats.tokens += row.usage.input + row.usage.cacheWrite + row.usage.cacheRead + row.usage.output;
  stats.cost += price(row.usage, values.model) + price(row.shellUsage, "claude-haiku-5-5");
};

const byCase = new Map<string, Map<string, Stats>>();
const totals = new Map<string, Stats>();
for (const row of rows) {
  const arm = row.arm ?? "tools";
  const perArm = byCase.get(row.id) ?? new Map<string, Stats>();
  byCase.set(row.id, perArm);
  const stats = perArm.get(arm) ?? empty();
  perArm.set(arm, stats);
  add(stats, row);
  const total = totals.get(arm) ?? empty();
  totals.set(arm, total);
  add(total, row);
}

const mean = (value: number, n: number, digits = 1) =>
  n === 0 ? "-" : (value / n).toFixed(digits);
const cells = (s: Stats) =>
  [
    `${s.pass}/${s.n}`,
    mean(s.steps, s.n),
    mean(s.forge, s.n),
    mean(s.failed, s.n),
    mean(s.bytes / 1024, s.n),
    mean(s.sleep, s.n, 0),
    mean(s.help, s.n),
    mean(s.tokens / 1000, s.n, 0),
    Number.isNaN(s.cost) ? "-" : `$${mean(s.cost, s.n, 3)}`,
  ].join(" | ");
const header =
  "| case | arm | pass | model calls | forge calls | failed | forge KB | sleep s | --help | ktokens | $/sample |";
console.log(`# Tools vs raw CLI (${values.model})\n\nMeans per sample.\n\n${header}`);
console.log(`| --- | --- | ${Array.from({ length: 9 }, () => "---").join(" | ")} |`);
for (const [id, perArm] of [...byCase].toSorted(([a], [b]) => a.localeCompare(b))) {
  for (const [arm, stats] of [...perArm].toSorted(([a], [b]) => b.localeCompare(a)))
    console.log(`| ${id} | ${arm} | ${cells(stats)} |`);
}
console.log("\n## All cases\n");
console.log(
  `${header.replace("| case ", "")}\n| --- | ${Array.from({ length: 9 }, () => "---").join(" | ")} |`,
);
for (const [arm, stats] of [...totals].toSorted(([a], [b]) => b.localeCompare(a))) {
  const perPass = stats.pass === 0 ? "-" : `$${(stats.cost / stats.pass).toFixed(3)}`;
  console.log(`| ${arm} | ${cells(stats)} |`);
  if (!Number.isNaN(stats.cost)) console.log(`\n- ${arm}: cost per passing sample ${perPass}`);
}
