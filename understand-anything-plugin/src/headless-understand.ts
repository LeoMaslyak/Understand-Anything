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

export interface HeadlessStatus {
  schemaVersion: 1;
  generatedAt: string;
  repoAbsPath: string;
  full: boolean;
  timeoutMs: number;
  model: string | null;
  outputLastMessage: string;
  status: "dry-run" | "running" | "semantic-ready" | "failed";
  stage: "prepared" | "finalizing-intermediates" | "running-codex" | "complete" | "failed";
  finalizationMode: "dry-run" | "intermediates" | "codex";
  nodes?: number;
  edges?: number;
  provenance?: string;
  error?: string;
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
  const command = `understand-anything semantic-graph ${options.repoAbsPath}${options.full ? " --full" : ""}`;
  return `Run the Understand-Anything semantic graph workflow headlessly for this repository:

${options.repoAbsPath}

Requested command:
${command}

Headless execution contract:
- Complete the workflow in this single Codex run. Do not dispatch subagents.
- Do not wait for user confirmation. Continue after creating or finding .understand-anything/.understandignore.
- Do not open or launch the dashboard.
- Do not use a deterministic fallback graph generator as a substitute.
- Do not hand-write or manually assemble .understand-anything/knowledge-graph.json.
- Do not merely stamp or relabel helper output as semantic.
- Generate semantic summaries, tags, layers, tour steps, and relationships from the repository contents you inspect.
- It is acceptable for tiny repositories to have few nodes, few tour steps, and zero or one edges if that accurately reflects the source.
- If .understand-anything/intermediate contains valid outputs from a prior run, inspect and reuse valid intermediate artifacts when that preserves correctness.
- If assembled-graph.json, assemble-review.json, layers.json, or tour.json already exist, complete the remaining semantic phases and final validation instead of rerunning completed phases unnecessarily.
- Write .understand-anything/knowledge-graph.json in the target repo.
- The final artifact must declare top-level "provenance": "understand-anything-semantic".
- If the full semantic workflow cannot complete, exit nonzero and explain why.

Required output files:
- .understand-anything/intermediate/scan-result.json
- .understand-anything/intermediate/batch-0.json, or multiple batch-<n>.json files for larger bounded targets
- .understand-anything/intermediate/assembled-graph.json
- .understand-anything/intermediate/layers.json
- .understand-anything/intermediate/tour.json
- .understand-anything/intermediate/assemble-review.json
- .understand-anything/knowledge-graph.json

Graph shape:
- knowledge-graph.json must be a JSON object with version, provenance, kind, project, nodes, edges, layers, and tour.
- Nodes must use fields: id, type, name, filePath when file-backed, summary, tags, complexity.
- Edges must use fields: source, target, type, direction, weight, and optional description.
- Layers and tour nodeIds must only reference node IDs that exist in nodes.
- Prefer file/config/document nodes for tiny repositories; add function/class/concept nodes only when they are useful and traceable to inspected source.

Recommended execution steps:
1. Create .understand-anything/intermediate and .understand-anything/tmp.
2. Create .understand-anything/.understandignore if missing, then continue without asking.
3. Inspect the bounded target files, excluding dependency/build/binary/generated directories.
4. Write scan-result.json with project name, description, languages, frameworks, files, totalFiles, filteredByIgnore, estimatedComplexity, and importMap.
5. Write semantic batch file(s) from inspected contents. Include nodes for meaningful files and source symbols, plus import/test/config/documentation edges when supported by the files.
6. Write assembled-graph.json by combining the semantic batch output. This is still an intermediate semantic graph, not the final accepted artifact.
7. Write layers.json and tour.json using only assembled node IDs.
8. Write assemble-review.json summarizing validation checks, issues, warnings, and fixes.
9. Write knowledge-graph.json with top-level provenance "understand-anything-semantic".
10. Re-read knowledge-graph.json and verify it is valid JSON, has semantic provenance, has an array of nodes, has an array of edges, and every layer/tour reference exists.

After generation, report node count, edge count, provenance, finalization mode "codex", and output path.`;
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

export function headlessStatusPath(repoAbsPath: string): string {
  return join(repoAbsPath, ".understand-anything", "headless-status.json");
}

export function validateSemanticGraph(repoAbsPath: string): { nodes: number; edges: number; provenance: string } {
  const graphPath = join(repoAbsPath, ".understand-anything", "knowledge-graph.json");
  const rawGraph = JSON.parse(readFileSync(graphPath, "utf8")) as Record<string, unknown>;
  const provenance = semanticProvenance(rawGraph);
  if (provenance === "understand-anything-semantic") {
    writeFileSync(graphPath, `${JSON.stringify(normalizeHeadlessSemanticGraph(rawGraph, repoAbsPath), null, 2)}\n`, "utf8");
  }
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

const VALID_NODE_TYPES = new Set([
  "file", "function", "class", "module", "concept",
  "config", "document", "service", "table", "endpoint",
  "pipeline", "schema", "resource",
  "domain", "flow", "step",
  "article", "entity", "topic", "claim", "source",
]);

const VALID_EDGE_TYPES = new Set([
  "imports", "exports", "contains", "inherits", "implements",
  "calls", "subscribes", "publishes", "middleware",
  "reads_from", "writes_to", "transforms", "validates",
  "depends_on", "tested_by", "configures",
  "related", "similar_to",
  "deploys", "serves", "provisions", "triggers",
  "migrates", "documents", "routes", "defines_schema",
  "contains_flow", "flow_step", "cross_domain",
  "cites", "contradicts", "builds_on", "exemplifies", "categorized_under", "authored_by",
]);

const EDGE_TYPE_NORMALIZATION: Record<string, string> = {
  define: "contains",
  defines: "contains",
  owns: "contains",
  uses: "depends_on",
  outbound: "related",
};

const DIRECTION_NORMALIZATION: Record<string, string> = {
  outbound: "forward",
  inbound: "backward",
  outgoing: "forward",
  incoming: "backward",
};

function normalizeHeadlessSemanticGraph(rawGraph: Record<string, unknown>, repoAbsPath: string): Record<string, unknown> {
  const now = new Date().toISOString();
  const project = typeof rawGraph.project === "object" && rawGraph.project !== null && !Array.isArray(rawGraph.project)
    ? rawGraph.project as Record<string, unknown>
    : {};
  const nodes = normalizeHeadlessNodes(rawGraph.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = normalizeHeadlessEdges(rawGraph.edges, nodeIds);
  const layers = normalizeHeadlessLayers(rawGraph.layers, nodes);
  const tour = normalizeHeadlessTour(rawGraph.tour, nodes);

  return {
    ...rawGraph,
    provenance: "understand-anything-semantic",
    version: typeof rawGraph.version === "string" ? rawGraph.version : "1.0.0",
    kind: rawGraph.kind === "knowledge" ? "knowledge" : "codebase",
    project: {
      name: stringFrom(project.name) ?? basenameFromPath(repoAbsPath),
      languages: stringArrayFrom(project.languages),
      frameworks: stringArrayFrom(project.frameworks),
      description: stringFrom(project.description) ?? "Semantic graph generated by Understand-Anything.",
      analyzedAt: stringFrom(project.analyzedAt) ?? now,
      gitCommitHash: stringFrom(project.gitCommitHash) ?? currentGitCommit(repoAbsPath),
    },
    nodes,
    edges,
    layers,
    tour,
  };
}

function normalizeHeadlessNodes(value: unknown): GraphNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): GraphNode[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const node = item as Record<string, unknown>;
    const id = stringFrom(node.id) ?? `concept:node-${index}`;
    const rawType = stringFrom(node.type)?.toLowerCase() ?? "";
    const type = normalizeNodeType(rawType, node);
    const name = stringFrom(node.name) ?? id;
    return [{
      id,
      type,
      name,
      ...(stringFrom(node.filePath) ? { filePath: stringFrom(node.filePath) ?? undefined } : {}),
      ...(Array.isArray(node.lineRange) && node.lineRange.length === 2 && typeof node.lineRange[0] === "number" && typeof node.lineRange[1] === "number"
        ? { lineRange: [node.lineRange[0], node.lineRange[1]] as [number, number] }
        : {}),
      summary: stringFrom(node.summary) ?? stringFrom(node.description) ?? name,
      tags: stringArrayFrom(node.tags),
      complexity: normalizeComplexityValue(node.complexity),
    }];
  });
}

function normalizeNodeType(rawType: string, node: Record<string, unknown>): GraphNode["type"] {
  if (VALID_NODE_TYPES.has(rawType)) return rawType as GraphNode["type"];
  if (rawType === "project" || rawType === "root" || rawType === "repository") return "concept";
  if (stringFrom(node.filePath)) return "file";
  return "concept";
}

function normalizeComplexityValue(value: unknown): GraphNode["complexity"] {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "simple" || normalized === "low" || normalized === "easy") return "simple";
    if (normalized === "complex" || normalized === "high" || normalized === "hard" || normalized === "difficult") return "complex";
    return "moderate";
  }
  if (typeof value === "number") {
    if (value <= 1) return "simple";
    if (value >= 3) return "complex";
  }
  return "moderate";
}

function normalizeHeadlessEdges(value: unknown, nodeIds: Set<string>): GraphEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GraphEdge[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const edge = item as Record<string, unknown>;
    const source = stringFrom(edge.source);
    const target = stringFrom(edge.target);
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return [];
    const rawType = stringFrom(edge.type)?.toLowerCase() ?? "related";
    const typeCandidate = EDGE_TYPE_NORMALIZATION[rawType] ?? rawType;
    const rawDirection = stringFrom(edge.direction)?.toLowerCase() ?? "forward";
    const directionCandidate = DIRECTION_NORMALIZATION[rawDirection] ?? rawDirection;
    return [{
      source,
      target,
      type: VALID_EDGE_TYPES.has(typeCandidate) ? typeCandidate as GraphEdge["type"] : "related",
      direction: directionCandidate === "backward" || directionCandidate === "bidirectional" ? directionCandidate : "forward",
      ...(stringFrom(edge.description) ? { description: stringFrom(edge.description) ?? undefined } : {}),
      weight: normalizeEdgeWeight(edge.weight),
    }];
  });
}

function normalizeEdgeWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function normalizeHeadlessLayers(value: unknown, nodes: GraphNode[]): Layer[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const layers = Array.isArray(value) ? value.flatMap((item, index): Layer[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const layer = item as Record<string, unknown>;
    const ids = stringArrayFrom(layer.nodeIds).filter((nodeId) => nodeIds.has(nodeId));
    if (ids.length === 0) return [];
    const name = stringFrom(layer.name) ?? `Layer ${index + 1}`;
    return [{
      id: stringFrom(layer.id) ?? `layer:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || index + 1}`,
      name,
      description: stringFrom(layer.description) ?? stringFrom(layer.summary) ?? name,
      nodeIds: ids,
    }];
  }) : [];
  if (layers.length > 0 || nodes.length === 0) return layers;
  return [{
    id: "layer:semantic-graph",
    name: "Semantic Graph",
    description: "Semantic graph nodes generated from the inspected repository.",
    nodeIds: nodes.map((node) => node.id),
  }];
}

function normalizeHeadlessTour(value: unknown, nodes: GraphNode[]): TourStep[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const tour = Array.isArray(value) ? value.flatMap((item, index): TourStep[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const step = item as Record<string, unknown>;
    const ids = stringArrayFrom(step.nodeIds).concat(stringFrom(step.nodeId) ? [stringFrom(step.nodeId) as string] : []).filter((nodeId) => nodeIds.has(nodeId));
    if (ids.length === 0) return [];
    const title = stringFrom(step.title) ?? `Step ${index + 1}`;
    return [{
      order: typeof step.order === "number" ? step.order : typeof step.step === "number" ? step.step : index + 1,
      title,
      description: stringFrom(step.description) ?? stringFrom(step.summary) ?? title,
      nodeIds: [...new Set(ids)],
      ...(stringFrom(step.languageLesson) ? { languageLesson: stringFrom(step.languageLesson) ?? undefined } : {}),
    }];
  }) : [];
  if (tour.length > 0 || nodes.length === 0) return tour;
  return [{
    order: 1,
    title: "Project Overview",
    description: "Start with the first semantic graph node.",
    nodeIds: [nodes[0].id],
  }];
}

export function runHeadless(options: HeadlessOptions): void {
  if (!existsSync(options.repoAbsPath)) {
    throw new Error(`Repository path does not exist: ${options.repoAbsPath}`);
  }

  const uaTmp = join(options.repoAbsPath, ".understand-anything", "tmp");
  mkdirSync(uaTmp, { recursive: true });
  const uaDir = dirname(uaTmp);
  const outputLastMessage = options.outputLastMessage ?? join(uaDir, "headless-last-message.txt");
  const codexArgs = buildCodexArgs(options, outputLastMessage);

  if (options.dryRun) {
    writeHeadlessStatus(options, outputLastMessage, {
      status: "dry-run",
      stage: "prepared",
      finalizationMode: "dry-run",
    });
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

  try {
    if (hasFinalizableIntermediates(options.repoAbsPath)) {
      writeHeadlessStatus(options, outputLastMessage, {
        status: "running",
        stage: "finalizing-intermediates",
        finalizationMode: "intermediates",
      });
      const result = finalizeSemanticGraphFromIntermediates(options.repoAbsPath);
      writeHeadlessStatus(options, outputLastMessage, {
        status: "semantic-ready",
        stage: "complete",
        finalizationMode: "intermediates",
        nodes: result.nodes,
        edges: result.edges,
        provenance: result.provenance,
      });
      console.log(`[understand-anything] semantic graph finalized from intermediates (${result.nodes} nodes, ${result.edges} edges, provenance ${result.provenance})`);
      return;
    }

    writeHeadlessStatus(options, outputLastMessage, {
      status: "running",
      stage: "running-codex",
      finalizationMode: "codex",
    });
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
    writeHeadlessStatus(options, outputLastMessage, {
      status: "semantic-ready",
      stage: "complete",
      finalizationMode: "codex",
      nodes: result.nodes,
      edges: result.edges,
      provenance: result.provenance,
    });
    console.log(`[understand-anything] semantic graph ready (${result.nodes} nodes, ${result.edges} edges, provenance ${result.provenance})`);
  } catch (error) {
    writeHeadlessStatus(options, outputLastMessage, {
      status: "failed",
      stage: "failed",
      finalizationMode: hasFinalizableIntermediates(options.repoAbsPath) ? "intermediates" : "codex",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function writeHeadlessStatus(
  options: HeadlessOptions,
  outputLastMessage: string,
  status: Pick<HeadlessStatus, "status" | "stage" | "finalizationMode"> & Partial<Pick<HeadlessStatus, "nodes" | "edges" | "provenance" | "error">>,
): void {
  const uaDir = join(options.repoAbsPath, ".understand-anything");
  mkdirSync(uaDir, { recursive: true });
  const artifact: HeadlessStatus = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoAbsPath: options.repoAbsPath,
    full: options.full,
    timeoutMs: options.timeoutMs,
    model: options.model,
    outputLastMessage,
    ...status,
  };
  writeFileSync(headlessStatusPath(options.repoAbsPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
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

function printUsage(): void {
  console.log(`Usage: understand-anything semantic-graph <repoAbsPath> [--full] [--timeout-ms <ms>] [--model <model>] [--dry-run]

Runs the real Understand-Anything /understand workflow through Codex in a
headless shell command, then validates that the generated knowledge graph has
semantic provenance. This command does not hand-write or relabel graph output.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runHeadless(parseHeadlessArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
