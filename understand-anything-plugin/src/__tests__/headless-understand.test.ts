import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCodexArgs,
  buildHeadlessPrompt,
  finalizeSemanticGraphFromIntermediates,
  parseHeadlessArgs,
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

  it("builds a Codex invocation that runs the real understand workflow headlessly", () => {
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
    expect(args.at(-1)).toContain("Run the real Understand-Anything /understand workflow end-to-end");
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

  it("names the upstream skill path in the generated prompt", () => {
    const prompt = buildHeadlessPrompt({
      repoAbsPath: "/repo",
      full: true,
    });

    expect(prompt).toContain("understand-anything-plugin/skills/understand/SKILL.md");
    expect(prompt).toContain("/understand /repo --full");
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
});
