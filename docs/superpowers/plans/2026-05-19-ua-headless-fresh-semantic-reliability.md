# UA Headless Fresh Semantic Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `understand-anything semantic-graph <target> --full` reliably complete a fresh bounded target without relying on retained intermediates.

**Architecture:** Keep retained-intermediate finalization unchanged. Replace the fresh-run prompt with a headless execution contract that is explicit, noninteractive, and concise enough for nested Codex to complete the real semantic workflow without subagent dispatch or dashboard launch. The generated artifact must still be validated by provenance and schema, and status output remains advisory evidence only.

**Tech Stack:** TypeScript, Vitest, Node.js, Codex CLI, Understand-Anything core graph validation.

---

## Current State

- Djinn PR #31 is merged on `main` with advisory `headless-status.json` parsing and semantic provenance gating.
- Djinn accepts retained-intermediate UA finalization through `verify:graph-semantic-command`.
- Fresh nested Codex UA generation now succeeds for tiny and small bounded targets after the local UA changes in this plan.
- Earlier baseline failure: a fresh nested Codex UA proof on `/tmp/djinn-headless-status-proof-20260519-jaoSaV` failed before writing `.understand-anything/knowledge-graph.json`.
- The failed fresh run wrote:
  - `.understand-anything/headless-status.json` with `status: failed`;
  - `.understand-anything/intermediate/scan-result.json`;
  - `.understand-anything/tmp/ua-project-scan.js`;
  - no `knowledge-graph.json`.
- Root cause class:
  - The old headless prompt delegated to the full `/understand` skill, which is optimized for interactive agents and subagents.
  - The nested Codex run read a very large skill file, entered subagent-oriented phases, and stopped after scanning.
  - The first compact-prompt rerun produced all artifacts, but the LLM graph had schema drift (`kind: "knowledge-graph"`, invalid `project` node type, numeric complexity, `direction: "outbound"`, noncanonical edge type, `layer.summary`, and `tour.nodeId`).
- Implemented fix class:
  - Compact fresh-run prompt: one nested Codex run, no subagents, no confirmation waits, no dashboard.
  - Mechanical schema normalization before core validation, only when the artifact already declares `provenance: "understand-anything-semantic"`.
  - Existing core validation still decides acceptance.

## Decisions

- Do not relabel deterministic/helper output as semantic.
- Do not use `headless-status.json` for semantic acceptance.
- Do not weaken `validateSemanticGraph`.
- Do not remove retained-intermediate finalization; it remains the reliable recovery path.
- Fresh headless execution should use a compact noninteractive prompt and must still require nested Codex to write the semantic graph artifact.
- A fresh proof is accepted only when `knowledge-graph.json` validates and declares `understand-anything-semantic` provenance.
- Mechanical normalization is allowed only after semantic provenance is present and only to canonicalize schema drift; it must not synthesize semantic provenance or replace missing semantic artifacts.

## Open Questions

- How broad should fresh-run reliability be before upstream publication? For this milestone, one tiny bounded repo and one small multi-file bounded repo now pass. Whole-monorepo generation remains out of scope.
- Should the full interactive `/understand` skill eventually get a first-class `--headless` mode? That is likely the clean long-term upstream shape, but this milestone can harden the owned headless command first.

## Blockers

- Nested Codex can still be variable. The prompt now avoids confirmation pauses, dashboard launch, and subagent-only instructions, but final repeated quality gates should still be run before merging/publishing.
- Larger repositories may still require retained intermediates or explicit batching. Whole-monorepo semantic generation remains out of scope.

## Milestones

### Milestone 1: Red Test for Fresh Headless Contract

**Files:**
- Modify: `understand-anything-plugin/src/__tests__/headless-understand.test.ts`
- Modify: `understand-anything-plugin/src/headless-understand.ts`

- [x] **Step 1: Add a failing test that the fresh headless prompt is noninteractive and does not route through the full skill**

Expected assertions:
- prompt contains `Headless execution contract`;
- prompt contains `Do not dispatch subagents`;
- prompt contains `Do not wait for user confirmation`;
- prompt contains `Write .understand-anything/knowledge-graph.json`;
- prompt does not ask nested Codex to read the full `SKILL.md`.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm --filter @understand-anything/skill test -- --run src/__tests__/headless-understand.test.ts
```

Observed: failed on `expected ... to contain 'Headless execution contract'`.

- [x] **Step 3: Implement the compact fresh-run prompt**

Modify `buildHeadlessPrompt` so fresh Codex receives a concise, self-contained contract:
- create `.understand-anything/intermediate` and `.understand-anything/tmp`;
- scan tracked files in the bounded target;
- generate semantic nodes/edges/layers/tour from source content;
- write intermediate evidence (`scan-result.json`, `batch-0.json`, `assembled-graph.json`, `layers.json`, `tour.json`, `assemble-review.json`);
- write final `.understand-anything/knowledge-graph.json` with top-level `provenance: "understand-anything-semantic"`;
- do not launch dashboard, ask questions, or use deterministic fallback.

- [x] **Step 4: Re-run the test and verify it passes**

Observed:

```bash
pnpm --filter @understand-anything/skill test -- --run src/__tests__/headless-understand.test.ts
```

Result: 47 test files passed, 785 tests passed after the prompt-contract change.

### Milestone 1.5: Schema Drift Normalization

**Files:**
- Modify: `understand-anything-plugin/src/headless-understand.ts`
- Modify: `understand-anything-plugin/src/__tests__/headless-understand.test.ts`

- [x] **Step 1: Add a failing schema-drift test**

The test writes a semantic graph with common LLM drift:
- numeric `version`;
- `kind: "knowledge-graph"`;
- missing `project.analyzedAt`;
- missing `project.gitCommitHash`;
- `type: "project"`;
- numeric complexity;
- `edge.type: "defines"`;
- `edge.direction: "outbound"`;
- `edge.weight: 2`;
- `layer.summary`;
- `tour.step`, `tour.summary`, and `tour.nodeId`.

Observed red result:

```text
Invalid knowledge graph: Missing or invalid project metadata
```

- [x] **Step 2: Add mechanical normalization before validation**

Implementation:
- only runs when raw graph provenance is already `understand-anything-semantic`;
- rewrites `version` to string;
- rewrites `kind` to `codebase` unless it is already `knowledge`;
- fills required project metadata;
- maps invalid node types to `concept` or `file`;
- maps numeric/string complexity to `simple`/`moderate`/`complex`;
- maps common edge drift (`defines`, `outbound`, overweight values);
- maps `layer.summary` to `description`;
- maps `tour.nodeId`/`step`/`summary` to canonical `nodeIds`/`order`/`description`;
- filters dangling references;
- writes the normalized graph back before calling core `loadGraph(..., { validate: true })`.

- [x] **Step 3: Re-run tests**

Observed:

```bash
pnpm --filter @understand-anything/skill test -- --run src/__tests__/headless-understand.test.ts
```

Result: 47 test files passed, 786 tests passed.

### Milestone 2: Fresh Tiny Target Proof

**Files:**
- Modify: `understand-anything-plugin/src/headless-understand.ts`
- Modify: `understand-anything-plugin/src/__tests__/headless-understand.test.ts`
- Modify: `docs/superpowers/plans/2026-05-19-ua-headless-fresh-semantic-reliability.md`

- [x] **Step 1: Build the plugin**

Run:

```bash
pnpm --filter @understand-anything/skill build
```

Observed: TypeScript build passed.

- [x] **Step 2: Run fresh tiny proof directly**

Create a tiny target and run:

```bash
node /Users/leozealous/.understand-anything/repo/understand-anything-plugin/dist/headless-understand.js semantic-graph <target> --full --timeout-ms 900000 --model gpt-5.4-mini
```

Expected:
- command exits 0;
- `.understand-anything/knowledge-graph.json` exists;
- `headless-status.json` has `status: semantic-ready`, `stage: complete`, `finalizationMode: codex`;
- graph provenance is `understand-anything-semantic`.

Observed direct UA proof:
- target: `/tmp/ua-headless-fresh-tiny-20260519-q9L12s`;
- command exited 0;
- node count: 3;
- edge count: 2;
- provenance: `understand-anything-semantic`;
- headless status: `status: semantic-ready`, `stage: complete`, `finalizationMode: codex`.

- [x] **Step 3: Run through Djinn verifier**

Run from Djinn:

```bash
DJINN_UA_SEMANTIC_GRAPH_COMMAND='node /Users/leozealous/.understand-anything/repo/understand-anything-plugin/dist/headless-understand.js semantic-graph <target> --full --timeout-ms 900000 --model gpt-5.4-mini' bun run verify:graph-semantic-command -- <target> --timeout-ms 960000 --focus src/index.ts
```

Expected: `semantic-ready`, provenance `understand-anything-semantic`, advisory `headlessStatus.finalizationMode: codex`.

Observed Djinn verifier proof:
- target: `/tmp/djinn-ua-fresh-tiny-20260519-kglliF`;
- exit code: 0;
- status: `semantic-ready`;
- node count: 3;
- edge count: 2;
- provenance source: `understand-anything-semantic`;
- advisory `headlessStatus.status: semantic-ready`;
- advisory `headlessStatus.stage: complete`;
- advisory `headlessStatus.finalizationMode: codex`;
- focus `src/index.ts`: 2 matched nodes, 2 touching edges.

### Milestone 3: Small Multi-File Target Proof

**Files:**
- Modify only if Milestone 2 exposes defects.
- Update this plan with evidence.

- [x] **Step 1: Create a small bounded target with 3-5 files**

Include at least:
- `src/index.ts`;
- `src/math.ts`;
- `src/math.test.ts`;
- `package.json`;

- [x] **Step 2: Run fresh headless command**

Expected:
- exits 0;
- graph has multiple nodes;
- at least one relationship edge exists;
- provenance is semantic.

- [x] **Step 3: Run Djinn verifier**

Expected:
- `semantic-ready`;
- richness warnings remain advisory;
- `headlessStatus.finalizationMode` is `codex`.

Observed Djinn verifier proof:
- target: `/tmp/djinn-ua-fresh-small-20260519-VBgEtz`;
- exit code: 0;
- status: `semantic-ready`;
- node count: 6;
- edge count: 6;
- provenance source: `understand-anything-semantic`;
- advisory `headlessStatus.status: semantic-ready`;
- advisory `headlessStatus.stage: complete`;
- advisory `headlessStatus.finalizationMode: codex`;
- edge types: `calls`, `contains`, `imports`, `related`;
- focus `src/index.ts`: 2 matched nodes, 3 touching edges;
- focus `src/math.ts`: 2 matched nodes, 5 touching edges;
- focus `src/__tests__/math.test.ts`: 1 matched node, 2 touching edges;
- semantic richness recommendations: none.

### Milestone 4: Documentation and Handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-05-19-ua-headless-fresh-semantic-reliability.md`
- Modify if needed in Djinn docs after a Djinn branch is opened.

- [x] **Step 1: Record exact proof commands and outcomes**

Include target paths, command classes, exit statuses, provenance, node/edge counts, and status artifact fields.

- [x] **Step 2: Record remaining last-mile gates**

Last quality pass should include:
- UA focused test;
- UA build;
- Djinn unset-command gate;
- Djinn fresh tiny verifier proof;
- Djinn fresh multi-file verifier proof;
- `printenv DJINN_UA_SEMANTIC_GRAPH_COMMAND` remains unset.

Final repeated quality pass:
- `pnpm --filter @understand-anything/skill test -- --run src/__tests__/headless-understand.test.ts`: passed, 47 files / 786 tests.
- `pnpm --filter @understand-anything/skill build`: passed.
- Djinn unset-command gate on `/tmp/djinn-ua-final-unset-20260519-Yecr4M`: exited 1 with `not-configured`.
- Djinn fresh tiny verifier proof on `/tmp/djinn-ua-final-fresh-tiny-20260519-RlqsVH`: `semantic-ready`, 4 nodes / 4 edges, provenance `understand-anything-semantic`, advisory `headlessStatus.finalizationMode: codex`.
- Djinn fresh small multi-file verifier proof on `/tmp/djinn-ua-final-fresh-small-20260519-wpSnkr`: `semantic-ready`, 6 nodes / 7 edges, provenance `understand-anything-semantic`, advisory `headlessStatus.finalizationMode: codex`, focus coverage for `src/index.ts`, `src/math.ts`, and `src/__tests__/math.test.ts`.
- `printenv DJINN_UA_SEMANTIC_GRAPH_COMMAND || echo not-configured`: `not-configured`.

## Quality Gates

Mid-project gate:
- The new prompt-contract test fails before implementation and passes after implementation. Status: passed.
- Schema-drift test fails before implementation and passes after implementation. Status: passed.
- UA build passes. Status: passed.
- Fresh tiny proof succeeds directly through UA. Status: passed.

Completion gate:
- Fresh tiny and small multi-file targets both pass through Djinn `verify:graph-semantic-command`. Status: passed and repeated.
- Both show `provenanceSource: understand-anything-semantic`. Status: passed and repeated.
- Both show advisory `headlessStatus.finalizationMode: codex`. Status: passed and repeated.
- Global `DJINN_UA_SEMANTIC_GRAPH_COMMAND` remains unset. Status: passed.

## Last-Mile Boundary

Stop in front of the final quality pass when:
- code and docs are updated. Status: reached.
- local UA tests/build pass. Status: reached once.
- direct fresh UA proof passes at least once. Status: reached.
- Djinn verifier proofs for tiny and small targets pass once. Status: reached.
- final repeated quality pass remains. Status: complete.

## 2026-05-20 Handoff

Current state:
- Branch `ua-headless-semantic-command` is the owned Djinn dependency branch.
- Latest commit: `3d21427 docs: record final headless semantic gates`.
- Runtime hardening commit: `bf661c3 fix: harden headless semantic fresh runs`.
- Branch was pushed to the owned fork remote `fork` (`https://github.com/LeoMaslyak/Understand-Anything.git`).
- No upstream PR was created to `Lum1104/Understand-Anything`.

Completed:
- Fresh headless semantic runs use the compact noninteractive prompt.
- Retained-intermediate finalization remains unchanged.
- Common post-semantic schema drift is normalized only after the graph already declares `provenance: "understand-anything-semantic"`.
- Focused test/build and Djinn verifier gates passed and were recorded in Djinn PR #32.

Remaining:
- Decide how Djinn should consume this owned branch reproducibly: pinned fork commit, packaged artifact, submodule, or documented local clone contract.
- Current Djinn local install check passed from `/Users/leozealous/zealous/.worktrees/djinn-ua-handoff-20260520/apps/djinn` with `DJINN_UA_CLONE_ROOT=/Users/leozealous/.understand-anything/repo bun run verify:graph-ua-local-install`; result included `readyForFullSemanticCommand: true` and `headless-semantic-entrypoint: ok=true`.
- If a larger target becomes required, run it as a bounded proof with an explicit inline semantic command and enough timeout budget; do not attempt whole-monorepo generation as a default gate.

Guardrails:
- Do not create upstream PRs to `Lum1104/Understand-Anything` unless the operator explicitly changes policy.
- Do not use `.understand-anything/headless-status.json` as semantic acceptance evidence.
- Do not synthesize or stamp semantic provenance onto deterministic/helper output.
- Keep `DJINN_UA_SEMANTIC_GRAPH_COMMAND` globally unset; configure it inline only for bounded proof commands.
