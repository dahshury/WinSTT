## Command: Library Integration Parity Audit (Reference Repo vs. Our Repo)

## Goal

Given:

- a **library** (name + package id),
- a **reference implementation root** (an “official” example repo or canonical usage inside this monorepo),
- and a **scan root** (where our current implementation lives),

perform a **complete, evidence-backed parity audit** that answers:

1. Are we using the library **only via official, recommended patterns**? If not: **where, why, and how to fix** (no workarounds).
2. Are we enforcing **end-to-end type safety** across the entire usage path (inputs → processing → outputs)? If not: **where exactly**.
3. Is the library **fully wired and leveraged** (core features, reliability/observability hooks, lifecycle management)? If not: **what’s missing** and **what to implement**.

This command is designed to be reusable across any library (e.g. BullMQ, Redis, OpenAI SDK, Prisma, etc.).

## Role

You are a **senior engineer** doing a production-grade integration review. You must be:

- rigorous (no guessing),
- exhaustive within scope,
- and biased toward **root-cause fixes** (no wrappers/adapters/legacy compatibility layers unless the library itself requires an adapter boundary).

## Inputs You Will Receive (You must request anything missing)

- **Library name**: e.g. `bullmq`
- **Library package identifier** (if different): e.g. `@scope/pkg`
- **Reference root**: e.g. `examples/bullmq`
- **Scan root**: e.g. `server/`
- **Optional constraints**:
	- runtime (node version, queue backend, infra constraints)
	- “do we want to refactor now or only produce a plan?”

## Hard Rules (Non-Negotiable)

### 0) Context7 MCP documentation (MANDATORY)

- You MUST use Context7 MCP to fetch library documentation.
- Do NOT rely on memory for library APIs.
- Make multiple Context7 calls with different topics/keywords until you can confidently describe:
	- official primitives and lifecycle (init/start/stop)
	- error handling and retry patterns
	- observability/telemetry hooks
	- typing story (generics, payload typing, serialization)
	- recommended project structure and configuration patterns

### 1) Evidence-only claims

- Every claim about our code MUST be backed by **actual code quotes with line ranges**.
- Every claim about "official patterns" MUST be backed by:
	- a quote from the **reference root** (preferred), and/or
	- a quote from **Context7 docs** (required when the reference is incomplete).

### 2) No legacy compatibility, no band-aids

- Do NOT add wrappers/adapters purely to avoid refactoring.
- Do NOT keep “old + new” side-by-side.
- Fix the root cause in the real implementation and update call sites immediately.

### 3) Type safety is the default

- No `any`, no unsafe casts, no unvalidated parsing/IO.
- All payloads crossing boundaries must be typed and validated:
	- env/config
	- JSON serialization
	- queue/event payloads
	- DB results and API payloads (as relevant)

## Required Workflow (Follow in Order)

### Phase 1: Baseline the “Official” Way (Reference + Docs)

1. **Inventory reference root**
	- List key files and entrypoints.
	- Extract the “intended” integration patterns:
		- initialization/configuration
		- creating/using core primitives (queues/clients/workers/etc.)
		- lifecycle management and shutdown
		- error handling/retries/backoff
		- observability hooks (events, metrics)
		- typing approach (generics, payload types)

2. **Context7 documentation pull**
	- Resolve the library id using Context7 MCP.
	- Fetch docs for multiple topics (at minimum):
		- "getting started" / "core concepts"
		- "configuration"
		- "typing" / "typescript"
		- "errors/retries"
		- "events/observability"
		- "shutdown" / "graceful close"
	- Produce a short "Official Baseline" section summarizing canonical usage.

**Output artifact (in your final report):**

- A table of “Official Patterns” with:
	- pattern name
	- where shown (reference path + line range and/or Context7 doc section)
	- what the pattern guarantees (reliability/typing/behavior)

### Phase 2: Map Our Current Implementation (Scan Root)

1. **Enumerate all usage locations**
	- Find every import/require of the library or its key primitives.
	- Find related config and wiring:
		- env vars
		- DI providers/modules
		- connection/client creation
		- scheduling/cron/repeat usage
		- startup/shutdown hooks
		- processors/handlers

2. **Create an “Integration Map”**
	- A file-by-file table of all participating code:
		- file path
		- responsibility
		- exported members relevant to the library
		- exact line ranges for library integration points

3. **Trace end-to-end flows**
	- Identify at least:
		- how a unit of work is created (enqueue/trigger)
		- how it is processed (worker/consumer)
		- how results/errors are handled
		- how observability signals are emitted or missing
	- Include diagrams (mermaid allowed).

### Phase 3: Parity Comparison (Official vs. Ours)

For each official pattern from Phase 1:

- Mark status: **Implemented | Partially Implemented | Missing | Misused**
- If not “Implemented”, produce:
	- exact locations in our code (file + line ranges)
	- what we’re doing instead
	- why it’s wrong/risky (behavioral mismatch, reliability gap, type unsafety)
	- the precise fix (what code must change)

Also identify “extra” patterns we have that are not official:

- Are they harmless?
- Are they risky?
- Should they be deleted and replaced with official patterns?

### Phase 4: Type Safety Audit (End-to-End)

Audit type safety along the entire usage path and produce a **Type Safety Report**:

- **Inputs**: how payloads are created (types, validation, narrowing)
- **Serialization boundary**: how payloads are encoded/decoded (schema validation required)
- **Processing**: typed function boundaries, error types, result typing
- **Outputs**: persistence, API responses, events emitted

You MUST identify:

- any `any`, `unknown` without narrowing, unsafe casts, `as` misuse
- any untyped dynamic data (e.g. JSON parsed without schema)
- any implicit “stringly typed” protocol (magic strings without typed mapping)
- any “runtime-only” failures that should have been compile-time failures

For each issue: provide a fix that increases compile-time guarantees (types + schemas + invariants).

### Phase 5: “Full Potential” Audit (Wiring + Features)

Using only what’s shown in:

- the **reference root** and
- **Context7 docs**,

identify important library capabilities we are not using but should consider, such as:

- reliability primitives (retries/backoff/dedup/idempotency hooks)
- lifecycle and graceful shutdown
- observability (events/metrics/logging hooks)
- concurrency controls and rate limiting
- test tooling / local dev ergonomics

For each capability:

- explain the value
- show where official docs/reference demonstrate it
- show whether/how we currently implement it (or not)
- propose a concrete implementation plan (or justified non-adoption)

### Phase 6: Deliverable Plan (and Optional Execution)

1. **Refactor/Implementation Plan**
	- Provide a prioritized plan that:
		- removes non-official patterns
		- rewires to official recommended patterns
		- strengthens type safety end-to-end
		- adds missing “full potential” wiring
	- No deprecations, no dual systems, no wrappers.

2. **Execution policy**
	- If the user explicitly says to execute, you MUST:
		- create a todo list (one item per change)
		- implement changes
		- update all call sites
		- add/adjust tests where appropriate
		- ensure typecheck/lint passes per repo conventions

## Required Output (Single Markdown File)

Write a report to:

- `/docs/library-integration-audit-[library]-[scan-root]-YYYY-MM-DD.md`

The report MUST include these sections in order:

1. **Inputs**
2. **Official Baseline (Reference + Context7)**
3. **Our Integration Map (Scan Root)**
4. **Parity Findings (Table)**
5. **Type Safety Report (Table)**
6. **Full Potential Findings (Table)**
7. **Proposed Refactor/Implementation Plan**
8. **Open Questions / Assumptions**

### Table Requirements

You MUST use tables heavily. At minimum include:

- **Parity Findings Table** columns:
	- Pattern
	- Official Source (ref/doc)
	- Our Source (file:lines)
	- Status
	- Risk
	- Exact Fix

- **Type Safety Table** columns:
	- Boundary
	- Current Types
	- Runtime Validation?
	- Issue
	- Fix
	- Files/Lines

- **Full Potential Table** columns:
	- Capability
	- Official Source (ref/doc)
	- Current State
	- Impact
	- Plan (adopt / reject + reason)

## Start Here (What you ask the user at runtime)

Before doing anything, ask for:

- Library name + package id
- Reference root path
- Scan root path
- Whether to: “audit only” or “audit + execute changes”



