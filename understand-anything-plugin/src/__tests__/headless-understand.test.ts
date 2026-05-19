import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCodexArgs,
  buildHeadlessPrompt,
  finalizeSemanticGraphFromIntermediates,
  headlessStatusPath,
  parseHeadlessArgs,
  runHeadless,
  validateSemanticGraph,
} from "../headless-understand.js";

describe("headless understand CLI", () => {
  it("parses semantic graph options without defaulting to dashboard mode", () => {
    const options = parseHeadlessArgs([
      "semantic-graph",
      "/repo",
      "--full",
      "--timeout-ms",
      "12345",
      "--model",
      "gpt-test",
      "--dry-run",
    ]);

    expect(options.repoAbsPath).toBe("/repo");
    expect(options.full).toBe(true);
    expect(options.timeoutMs).toBe(12345);
    expect(options.model).toBe("gpt-test");
    expect(options.dryRun).toBe(true);
  });

  it("builds a Codex invocation that runs the semantic workflow headlessly", () => {
    const options = parseHeadlessArgs([
      "semantic-graph",
      "/repo",
      "--full",
      "--model",
      "gpt-test",
    ]);
    const args = buildCodexArgs(options, "/tmp/last-message.txt");

    expect(args).toContain("exec");
    expect(args).toContain("--cd");
    expect(args).toContain("/repo");
    expect(args).toContain("--output-last-message");
    expect(args).toContain("/tmp/last-message.txt");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-test");
    expect(args.at(-1)).toContain("Run the Understand-Anything semantic graph workflow headlessly");
    expect(args.at(-1)).toContain("Do not hand-write or manually assemble");
    expect(args.at(-1)).toContain("reuse valid intermediate artifacts");
    expect(args.at(-1)).toContain("understand-anything-semantic");
  });

  it("exposes a package bin for upstream discovery", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(pkg.bin?.["understand-anything"]).toBe("dist/headless-understand.js");
  });

  it("names the requested headless semantic command in the generated prompt", () => {
    const prompt = buildHeadlessPrompt({
      repoAbsPath: "/repo",
      full: true,
    });

    expect(prompt).toContain("understand-anything semantic-graph /repo --full");
    expect(prompt).toContain("Required output files:");
  });

  it("uses a concise noninteractive fresh-run contract instead of the full interactive skill", () => {
    const prompt = buildHeadlessPrompt({
      repoAbsPath: "/repo",
      full: true,
    });

    expect(prompt).toContain("Headless execution contract");
    expect(prompt).toContain("Do not dispatch subagents");
    expect(prompt).toContain("Do not wait for user confirmation");
    expect(prompt).toContain("Write .understand-anything/knowledge-graph.json");
    expect(prompt).not.toContain("Use the installed skill instructions at:");
    expect(prompt).not.toContain("Run the real Understand-Anything /understand workflow end-to-end");
  });

  it("validates top-level semantic provenance from the raw graph artifact", () => {
    const repo = join(tmpdir(), `ua-headless-validate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(join(repo, ".understand-anything"), { recursive: true });
      writeFileSync(join(repo, ".understand-anything", "knowledge-graph.json"), `${JSON.stringify({
        provenance: "understand-anything-semantic",
        version: "1.0.0",
        project: {
          name: "fixture",
          languages: ["typescript"],
          frameworks: [],
          description: "fixture",
          analyzedAt: new Date().toISOString(),
          gitCommitHash: "abc123",
        },
        nodes: [
          {
            id: "file:src/index.ts",
            type: "file",
            name: "index.ts",
            filePath: "src/index.ts",
            summary: "Entry point.",
            tags: ["entry"],
            complexity: "simple",
          },
        ],
        edges: [],
        layers: [],
        tour: [],
      }, null, 2)}\n`);

      expect(validateSemanticGraph(repo)).toEqual({
        nodes: 1,
        edges: 0,
        provenance: "understand-anything-semantic",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("normalizes common headless LLM graph schema drift before validation", () => {
    const repo = join(tmpdir(), `ua-headless-normalize-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(join(repo, ".understand-anything"), { recursive: true });
      writeFileSync(join(repo, ".understand-anything", "knowledge-graph.json"), `${JSON.stringify({
        provenance: "understand-anything-semantic",
        version: 1,
        kind: "knowledge-graph",
        project: {
          name: "fixture",
          rootPath: repo,
          description: "Fixture project.",
          languages: ["TypeScript"],
          frameworks: [],
        },
        nodes: [
          {
            id: "project-root",
            type: "project",
            name: "fixture",
            summary: "Fixture project root.",
            tags: ["overview"],
            complexity: 1,
          },
          {
            id: "file:src/index.ts",
            type: "file",
            name: "index.ts",
            filePath: "src/index.ts",
            summary: "Entry point.",
            tags: ["entry"],
            complexity: 1,
          },
        ],
        edges: [
          {
            source: "project-root",
            target: "file:src/index.ts",
            type: "defines",
            direction: "outbound",
            weight: 2,
          },
        ],
        layers: [
          {
            id: "layer:overview",
            name: "Overview",
            summary: "Project overview.",
            nodeIds: ["project-root", "file:src/index.ts"],
          },
        ],
        tour: [
          {
            step: 1,
            title: "Entry Point",
            summary: "Start at the entry point.",
            nodeId: "file:src/index.ts",
          },
        ],
      }, null, 2)}\n`);

      expect(validateSemanticGraph(repo)).toEqual({
        nodes: 2,
        edges: 1,
        provenance: "understand-anything-semantic",
      });

      const graph = JSON.parse(readFileSync(join(repo, ".understand-anything", "knowledge-graph.json"), "utf8")) as {
        kind?: string;
        project?: { analyzedAt?: string; gitCommitHash?: string };
        nodes?: Array<{ type?: string; complexity?: string }>;
        edges?: Array<{ type?: string; direction?: string; weight?: number }>;
        layers?: Array<{ description?: string }>;
        tour?: Array<{ order?: number; description?: string; nodeIds?: string[] }>;
      };
      expect(graph.kind).toBe("codebase");
      expect(graph.project?.analyzedAt).toBeTruthy();
      expect(graph.project?.gitCommitHash).toBeTruthy();
      expect(graph.nodes?.[0]?.type).toBe("concept");
      expect(graph.nodes?.[0]?.complexity).toBe("simple");
      expect(graph.edges?.[0]?.type).toBe("contains");
      expect(graph.edges?.[0]?.direction).toBe("forward");
      expect(graph.edges?.[0]?.weight).toBe(1);
      expect(graph.layers?.[0]?.description).toBe("Project overview.");
      expect(graph.tour?.[0]?.order).toBe(1);
      expect(graph.tour?.[0]?.description).toBe("Start at the entry point.");
      expect(graph.tour?.[0]?.nodeIds).toEqual(["file:src/index.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("finalizes valid understand intermediates into a semantic knowledge graph", () => {
    const repo = join(tmpdir(), `ua-headless-finalize-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const intermediate = join(repo, ".understand-anything", "intermediate");
      mkdirSync(intermediate, { recursive: true });
      writeFileSync(join(intermediate, "assembled-graph.json"), `${JSON.stringify({
        nodes: [
          {
            id: "file:src/index.ts",
            type: "file",
            name: "index.ts",
            filePath: "src/index.ts",
            summary: "Semantic analysis identified the application entry point.",
            tags: ["entry-point"],
            complexity: "simple",
          },
        ],
        edges: [],
      }, null, 2)}\n`);
      writeFileSync(join(intermediate, "layers.json"), `${JSON.stringify([
        {
          id: "layer:entry",
          name: "Entry",
          description: "Entry point layer.",
          nodeIds: ["file:src/index.ts"],
        },
      ], null, 2)}\n`);
      writeFileSync(join(intermediate, "tour.json"), `${JSON.stringify([
        {
          order: 1,
          title: "Entry Point",
          description: "Start with the entry point.",
          nodeIds: ["file:src/index.ts"],
        },
      ], null, 2)}\n`);
      writeFileSync(join(intermediate, "scan-result.json"), `${JSON.stringify({
        name: "fixture",
        description: "Fixture project.",
        languages: ["typescript"],
        frameworks: [],
        files: [{ path: "src/index.ts" }],
      }, null, 2)}\n`);
      writeFileSync(join(intermediate, "assemble-review.json"), `${JSON.stringify({
        fixedSectionOk: true,
        nodesRecovered: 0,
        edgesRestored: 0,
      }, null, 2)}\n`);

      expect(finalizeSemanticGraphFromIntermediates(repo)).toEqual({
        nodes: 1,
        edges: 0,
        provenance: "understand-anything-semantic",
      });

      const graph = JSON.parse(readFileSync(join(repo, ".understand-anything", "knowledge-graph.json"), "utf8")) as {
        provenance?: string;
        project?: { name?: string };
        layers?: unknown[];
        tour?: unknown[];
      };
      expect(graph.provenance).toBe("understand-anything-semantic");
      expect(graph.project?.name).toBe("fixture");
      expect(graph.layers).toHaveLength(1);
      expect(graph.tour).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses to stamp graph-shaped files as semantic without understand workflow evidence", () => {
    const repo = join(tmpdir(), `ua-headless-reject-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const intermediate = join(repo, ".understand-anything", "intermediate");
      mkdirSync(intermediate, { recursive: true });
      writeFileSync(join(intermediate, "assembled-graph.json"), `${JSON.stringify({
        nodes: [
          {
            id: "file:src/index.ts",
            type: "file",
            name: "index.ts",
            filePath: "src/index.ts",
            summary: "A graph-shaped deterministic artifact.",
            tags: ["entry-point"],
            complexity: "simple",
          },
        ],
        edges: [],
      }, null, 2)}\n`);
      writeFileSync(join(intermediate, "layers.json"), "[]\n");
      writeFileSync(join(intermediate, "tour.json"), "[]\n");

      expect(() => finalizeSemanticGraphFromIntermediates(repo)).toThrow(
        /workflow evidence/,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes a machine-readable status artifact for dry runs", () => {
    const repo = join(tmpdir(), `ua-headless-status-dry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(repo, { recursive: true });
      runHeadless(parseHeadlessArgs([
        "semantic-graph",
        repo,
        "--dry-run",
        "--timeout-ms",
        "12345",
        "--model",
        "gpt-test",
      ]));

      const status = JSON.parse(readFileSync(headlessStatusPath(repo), "utf8")) as {
        schemaVersion?: number;
        status?: string;
        stage?: string;
        repoAbsPath?: string;
        timeoutMs?: number;
        model?: string;
      };
      expect(status.schemaVersion).toBe(1);
      expect(status.status).toBe("dry-run");
      expect(status.stage).toBe("prepared");
      expect(status.repoAbsPath).toBe(repo);
      expect(status.timeoutMs).toBe(12345);
      expect(status.model).toBe("gpt-test");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes semantic-ready status when finalizing retained understand intermediates", () => {
    const repo = join(tmpdir(), `ua-headless-status-finalize-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const intermediate = join(repo, ".understand-anything", "intermediate");
      mkdirSync(intermediate, { recursive: true });
      writeFileSync(join(intermediate, "assembled-graph.json"), `${JSON.stringify({
        nodes: [
          {
            id: "file:src/index.ts",
            type: "file",
            name: "index.ts",
            filePath: "src/index.ts",
            summary: "Semantic analysis identified the application entry point.",
            tags: ["entry-point"],
            complexity: "simple",
          },
        ],
        edges: [],
      }, null, 2)}\n`);
      writeFileSync(join(intermediate, "layers.json"), "[]\n");
      writeFileSync(join(intermediate, "tour.json"), "[]\n");
      writeFileSync(join(intermediate, "scan-result.json"), `${JSON.stringify({
        name: "fixture",
        description: "Fixture project.",
        languages: ["typescript"],
        frameworks: [],
        files: [{ path: "src/index.ts" }],
      }, null, 2)}\n`);
      writeFileSync(join(intermediate, "assemble-review.json"), `${JSON.stringify({
        fixedSectionOk: true,
      }, null, 2)}\n`);

      runHeadless(parseHeadlessArgs(["semantic-graph", repo, "--full"]));

      const status = JSON.parse(readFileSync(headlessStatusPath(repo), "utf8")) as {
        status?: string;
        stage?: string;
        finalizationMode?: string;
        nodes?: number;
        edges?: number;
        provenance?: string;
      };
      expect(status.status).toBe("semantic-ready");
      expect(status.stage).toBe("complete");
      expect(status.finalizationMode).toBe("intermediates");
      expect(status.nodes).toBe(1);
      expect(status.edges).toBe(0);
      expect(status.provenance).toBe("understand-anything-semantic");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
