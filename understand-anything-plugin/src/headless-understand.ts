#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, validateGraph } from "@understand-anything/core";
import type { GraphEdge, GraphNode, KnowledgeGraph, Layer, TourStep } from "@understand-anything/core";

export interface HeadlessOptions {
  repoAbsPath: string;
  full: boolean;
  dryRun: boolean;
  timeoutMs: number;
  model: string | null;
  outputLastMessage: string | null;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const args = [...argv];
  const subcommand = args[0] === "semantic-graph" ? args.shift() : null;
  if (subcommand === null && args[0]?.startsWith("-")) {
    throw new Error("Usage: understand-anything semantic-graph <repoAbsPath> [--full] [--dry-run]");
  }

  let repoArg = args.shift() ?? process.cwd();
  let full = false;
  let dryRun = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let model: string | null = null;
  let outputLastMessage: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--full") {
      full = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--timeout-ms" && args[index + 1]) {
      timeoutMs = parsePositiveInt(args[index + 1]) ?? timeoutMs;
      index += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInt(arg.slice("--timeout-ms=".length)) ?? timeoutMs;
    } else if (arg === "--model" && args[index + 1]) {
      model = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "--output-last-message" && args[index + 1]) {
      outputLastMessage = resolve(args[index + 1]);
      index += 1;
    } else if (arg.startsWith("--output-last-message=")) {
      outputLastMessage = resolve(arg.slice("--output-last-message=".length));
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      repoArg = arg;
    }
  }

  return {
    repoAbsPath: resolve(repoArg),
    full,
    dryRun,
    timeoutMs,
    model,
    outputLastMessage,
  };
}

export function buildHeadlessPrompt(options: Pick<HeadlessOptions, "repoAbsPath" | "full">): string {
  const skillPath = join(packageRoot(), "skills", "understand", "SKILL.md");
  const command = `/understand ${options.repoAbsPath}${options.full ? " --full" : ""}`;
  return `Run the real Understand-Anything /understand workflow end-to-end for this repository:

${options.repoAbsPath}

Use the installed skill instructions at:
${skillPath}

Requested command:
${command}

Hard requirements:
- Run the real Understand-Anything /understand workflow end-to-end.
- Do not use a deterministic fallback graph generator as a substitute.
- Do not hand-write or manually assemble .understand-anything/knowledge-graph.json.
- Do not merely stamp or relabel helper output as semantic.
- Do not open the dashboard.
- If .understand-anything/intermediate contains valid outputs from a prior run, inspect and reuse valid intermediate artifacts instead of starting over when that preserves correctness.
- If assembled-graph.json, assemble-review.json, or architecture outputs already exist, complete the remaining real /understand phases and final validation rather than rerunning completed phases unnecessarily.
- The final artifact must be written to .understand-anything/knowledge-graph.json in the target repo.
- The final artifact itself must declare semantic provenance, preferably top-level "provenance": "understand-anything-semantic".
- If the full semantic workflow cannot complete, exit nonzero and explain why.

After generation, report node count, edge count, provenance, and output path.`;
}

export function buildCodexArgs(options: HeadlessOptions, outputLastMessage: string): string[] {
  const args = [
    "exec",
    "--cd",
    options.repoAbsPath,
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--output-last-message",
    outputLastMessage,
  ];
  if (options.model) args.push("--model", options.model);
  args.push(buildHeadlessPrompt(options));
  return args;
}

export function validateSemanticGraph(repoAbsPath: string): { nodes: number; edges: number; provenance: string } {
  const graphPath = join(repoAbsPath, ".understand-anything", "knowledge-graph.json");
  const rawGraph = JSON.parse(readFileSync(graphPath, "utf8")) as Record<string, unknown>;
  const provenance = semanticProvenance(rawGraph);
  const graph = loadGraph(repoAbsPath, { validate: true }) as Record<string, unknown> | null;
  if (!graph) {
    throw new Error("No .understand-anything/knowledge-graph.json artifact was produced.");
  }

  if (provenance !== "understand-anything-semantic") {
    throw new Error(`Knowledge graph provenance is not semantic: ${provenance || "missing"}`);
  }

  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
    provenance,
  };
}

export function finalizeSemanticGraphFromIntermediates(repoAbsPath: string): { nodes: number; edges: number; provenance: string } {
  const uaDir = join(repoAbsPath, ".understand-anything");
  const intermediateDir = join(uaDir, "intermediate");
  const assembled = readJsonRecord(join(intermediateDir, "assembled-graph.json"));
  const layers = readJsonArray<Layer>(join(intermediateDir, "layers.json"));
  const tour = readJsonArray<TourStep>(join(intermediateDir, "tour.json"));
  const scan = readOptionalJsonRecord(join(intermediateDir, "scan-result.json"));
  const meta = readOptionalJsonRecord(join(uaDir, "meta.json"));

  assertUnderstandWorkflowEvidence(intermediateDir, assembled, scan);

  if (!Array.isArray(assembled.nodes) || assembled.nodes.length === 0) {
    throw new Error("Cannot finalize semantic graph: assembled-graph.json has no nodes.");
  }
  if (!Array.isArray(assembled.edges)) {
    throw new Error("Cannot finalize semantic graph: assembled-graph.json has no edges array.");
  }

  validateLayerAndTourReferences(assembled.nodes as GraphNode[], layers, tour);

  mkdirSync(uaDir, { recursive: true });
  const graph = {
    provenance: "understand-anything-semantic",
    version: typeof assembled.version === "string" ? assembled.version : "1.0.0",
    kind: "codebase",
    project: buildProjectMeta(repoAbsPath, scan, meta),
    nodes: assembled.nodes as GraphNode[],
    edges: assembled.edges as GraphEdge[],
    layers,
    tour,
  };

  const validation = validateGraph(graph);
  if (!validation.success || !validation.data) {
    throw new Error(`Cannot finalize semantic graph: ${validation.fatal ?? validation.issues[0]?.message ?? "validation failed"}`);
  }

  const outputGraph: KnowledgeGraph & { provenance: string } = {
    ...validation.data,
    provenance: "understand-anything-semantic",
  };
  writeFileSync(join(uaDir, "knowledge-graph.json"), `${JSON.stringify(outputGraph, null, 2)}\n`, "utf8");

  return validateSemanticGraph(repoAbsPath);
}

function semanticProvenance(graph: Record<string, unknown>): string {
  if (typeof graph.provenance === "string") return graph.provenance;
  const project = graph.project;
  if (project && typeof project === "object" && typeof (project as { source?: unknown }).source === "string") {
    return (project as { source: string }).source;
  }
  return "";
}

function run(options: HeadlessOptions): void {
  if (!existsSync(options.repoAbsPath)) {
    throw new Error(`Repository path does not exist: ${options.repoAbsPath}`);
  }

  const uaTmp = join(options.repoAbsPath, ".understand-anything", "tmp");
  mkdirSync(uaTmp, { recursive: true });
  const uaDir = dirname(uaTmp);
  const outputLastMessage = options.outputLastMessage ?? join(uaDir, "headless-last-message.txt");
  const codexArgs = buildCodexArgs(options, outputLastMessage);

  if (options.dryRun) {
    console.log(JSON.stringify({
      repoAbsPath: options.repoAbsPath,
      full: options.full,
      timeoutMs: options.timeoutMs,
      model: options.model,
      outputLastMessage,
      command: "codex",
      args: codexArgs,
    }, null, 2));
    return;
  }

  if (hasFinalizableIntermediates(options.repoAbsPath)) {
    const result = finalizeSemanticGraphFromIntermediates(options.repoAbsPath);
    console.log(`[understand-anything] semantic graph finalized from intermediates (${result.nodes} nodes, ${result.edges} edges, provenance ${result.provenance})`);
    return;
  }

  execFileSync("codex", codexArgs, {
    cwd: options.repoAbsPath,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    timeout: options.timeoutMs,
    env: {
      ...process.env,
      UNDERSTAND_NO_WORKTREE_REDIRECT: process.env.UNDERSTAND_NO_WORKTREE_REDIRECT ?? "1",
    },
  });

  const result = validateSemanticGraph(options.repoAbsPath);
  console.log(`[understand-anything] semantic graph ready (${result.nodes} nodes, ${result.edges} edges, provenance ${result.provenance})`);
}

function hasFinalizableIntermediates(repoAbsPath: string): boolean {
  const intermediateDir = join(repoAbsPath, ".understand-anything", "intermediate");
  const hasRequiredOutputs = [
    "assembled-graph.json",
    "layers.json",
    "tour.json",
  ].every((file) => existsSync(join(intermediateDir, file)));
  return hasRequiredOutputs && existsSync(join(intermediateDir, "scan-result.json")) && (
    existsSync(join(intermediateDir, "assemble-review.json")) ||
    hasBatchIntermediate(intermediateDir)
  );
}

function readJsonRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Missing required semantic intermediate: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Semantic intermediate must be a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function readOptionalJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return readJsonRecord(path);
}

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) {
    throw new Error(`Missing required semantic intermediate: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Semantic intermediate must be a JSON array: ${path}`);
  }
  return parsed as T[];
}

function assertUnderstandWorkflowEvidence(
  intermediateDir: string,
  assembled: Record<string, unknown>,
  scan: Record<string, unknown> | null,
): void {
  if (!scan || !Array.isArray(scan.files)) {
    throw new Error("Cannot finalize semantic graph: missing Understand workflow evidence in scan-result.json.");
  }
  if (!existsSync(join(intermediateDir, "assemble-review.json")) && !hasBatchIntermediate(intermediateDir)) {
    throw new Error("Cannot finalize semantic graph: missing Understand workflow evidence from batch or assemble-review intermediates.");
  }
  const provenance = semanticProvenance(assembled);
  if (provenance.includes("deterministic") || provenance.includes("helper")) {
    throw new Error(`Cannot finalize semantic graph: refusing non-semantic assembled graph provenance "${provenance}".`);
  }
}

function hasBatchIntermediate(intermediateDir: string): boolean {
  for (let index = 1; index <= 999; index += 1) {
    if (existsSync(join(intermediateDir, `batch-${index}.json`))) return true;
  }
  return false;
}

function validateLayerAndTourReferences(nodes: GraphNode[], layers: Layer[], tour: TourStep[]): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const layer of layers) {
    if (!layer || typeof layer.id !== "string" || !Array.isArray(layer.nodeIds)) {
      throw new Error("Cannot finalize semantic graph: layers.json contains an invalid layer.");
    }
    for (const nodeId of layer.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        throw new Error(`Cannot finalize semantic graph: layer "${layer.id}" references missing node "${nodeId}".`);
      }
    }
  }
  for (const step of tour) {
    if (!step || typeof step.title !== "string" || !Array.isArray(step.nodeIds)) {
      throw new Error("Cannot finalize semantic graph: tour.json contains an invalid step.");
    }
    for (const nodeId of step.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        throw new Error(`Cannot finalize semantic graph: tour step "${step.title}" references missing node "${nodeId}".`);
      }
    }
  }
}

function buildProjectMeta(
  repoAbsPath: string,
  scan: Record<string, unknown> | null,
  meta: Record<string, unknown> | null,
): KnowledgeGraph["project"] {
  return {
    name: stringFrom(scan?.name) ?? basenameFromPath(repoAbsPath),
    languages: stringArrayFrom(scan?.languages),
    frameworks: stringArrayFrom(scan?.frameworks),
    description: stringFrom(scan?.description) ?? "Semantic graph generated by Understand-Anything.",
    analyzedAt: new Date().toISOString(),
    gitCommitHash: stringFrom(meta?.gitCommitHash) ?? currentGitCommit(repoAbsPath),
  };
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function basenameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "project";
}

function currentGitCommit(repoAbsPath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoAbsPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "unknown";
  }
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function printUsage(): void {
  console.log(`Usage: understand-anything semantic-graph <repoAbsPath> [--full] [--timeout-ms <ms>] [--model <model>] [--dry-run]

Runs the real Understand-Anything /understand workflow through Codex in a
headless shell command, then validates that the generated knowledge graph has
semantic provenance. This command does not hand-write or relabel graph output.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(parseHeadlessArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
