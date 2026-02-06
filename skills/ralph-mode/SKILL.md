---
name: ralph-mode
description: Autonomous development loops with iteration, backpressure gates, and completion criteria. Use for sustained coding sessions that require multiple iterations, test validation, and structured progress tracking. Supports Next.js, Python, FastAPI, and GPU workloads with Ralph Wiggum methodology adapted for OpenClaw.
---

# Ralph Mode - Autonomous Development Loops

Ralph Mode implements the Ralph Wiggum technique adapted for OpenClaw: autonomous task completion through continuous iteration with backpressure gates, completion criteria, and structured planning.

## When to Use

Use Ralph Mode when:
- Building features that require multiple iterations and refinement
- Working on complex projects with acceptance criteria to validate
- Need automated testing, linting, or typecheck gates
- Want to track progress across many iterations systematically
- Prefer autonomous loops over manual turn-by-turn guidance

## Core Principles

### Three-Phase Workflow

**Phase 1: Requirements Definition**
- Document specs in `specs/` (one file per topic of concern)
- Define acceptance criteria (observable, verifiable outcomes)
- Create implementation plan with prioritized tasks

**Phase 2: Planning**
- Gap analysis: compare specs against existing code
- Generate `IMPLEMENTATION_PLAN.md` with prioritized tasks
- No implementation during this phase

**Phase 3: Building (Iterative)**
- Pick one task from plan per iteration
- Implement, validate, update plan, commit
- Continue until all tasks complete or criteria met

### Backpressure Gates

Reject incomplete work automatically through validation:

**Programmatic Gates (Always use these):**
- Tests: `[test command]` - Must pass before committing
- Typecheck: `[typecheck command]` - Catch type errors early
- Lint: `[lint command]` - Enforce code quality
- Build: `[build command]` - Verify integration

**Subjective Gates (Use for UX, design, quality):**
- LLM-as-judge reviews for tone, aesthetics, usability
- Binary pass/fail - converges through iteration
- Only add after programmatic gates work reliably

### Context Efficiency

- One task per iteration = fresh context each time
- Spawn sub-agents for exploration, not main context
- Lean prompts = smart zone (~40-60% utilization)
- Plans are disposable - regenerate cheap vs. salvage

## File Structure

Create this structure for each Ralph Mode project:

```
project-root/
├── IMPLEMENTATION_PLAN.md     # Shared state, updated each iteration
├── AGENTS.md                  # Build/test/lint commands (~60 lines)
├── specs/                     # Requirements (one file per topic)
│   ├── topic-a.md
│   └── topic-b.md
├── src/                        # Application code
└── src/lib/                    # Shared utilities
```

### IMPLEMENTATION_PLAN.md

Priority task list - single source of truth. Format:

```markdown
# Implementation Plan

## In Progress
- [ ] Task name (iteration N)
  - Notes: discoveries, bugs, blockers

## Completed
- [x] Task name (iteration N)

## Backlog
- [ ] Future task
```

### Topic Scope Test

Can you describe the topic in one sentence without "and"?
- ✅ "User authentication with JWT and session management"
- ❌ "Auth, profiles, and billing" → 3 topics

### AGENTS.md - Operational Guide

Succinct guide for running the project. Keep under 60 lines:

```markdown
# Project Operations

## Build Commands
npm run dev      # Development server
npm run build     # Production build

## Validation
npm run test      # All tests
npm run lint      # ESLint
npm run typecheck  # TypeScript
npm run e2e       # E2E tests

## Operational Notes
- Tests must pass before committing
- Typecheck failures block commits
- Use existing utilities from src/lib over ad-hoc copies
```

## Hats (Personas)

Specialized roles for different tasks:

**Hat: Architect** (`@architect`)
- High-level design, data modeling, API contracts
- Focus: patterns, scalability, maintainability

**Hat: Implementer** (`@implementer`)
- Write code, implement features, fix bugs
- Focus: correctness, performance, test coverage

**Hat: Tester** (`@tester`)
- Test authoring, validation, edge cases
- Focus: coverage, reliability, reproducibility

**Hat: Reviewer** (`@reviewer`)
- Code reviews, PR feedback, quality assessment
- Focus: style, readability, adherence to specs

**Usage:**
```
"Spawn a sub-agent with @architect hat to design the data model"
```

## Loop Mechanics

### Outer Loop (You coordinate)

Your job as main agent: engineer setup, observe, course-correct.

1. **Don't allocate work to main context** - Spawn sub-agents
2. **Let Ralph Ralph** - LLM will self-identify, self-correct
3. **Use protection** - Sandbox is your security boundary
4. **Plan is disposable** - Regenerate when wrong/stale
5. **Move outside the loop** - Sit and watch, don't micromanage

### Inner Loop (Sub-agent executes)

Each sub-agent iteration:
1. **Study** - Read plan, specs, relevant code
2. **Select** - Pick most important uncompleted task
3. **Implement** - Write code, one task only
4. **Validate** - Run tests, lint, typecheck (backpressure)
5. **Update** - Mark task done, note discoveries, commit
6. **Exit** - Next iteration starts fresh

### Stopping Conditions

Loop ends when:
- ✅ All IMPLEMENTATION_PLAN.md tasks completed
- ✅ All acceptance criteria met
- ✅ Tests passing, no blocking issues
- ⚠️ Max iterations reached (configure limit)
- 🛑 Manual stop (Ctrl+C)

## Completion Criteria

Define success upfront - avoid "seems done" ambiguity.

### Programmatic (Measurable)
- All tests pass: `[test_command]` returns 0
- Typecheck passes: No TypeScript errors
- Build succeeds: Production bundle created
- Coverage threshold: e.g., 80%+

### Subjective (LLM-as-Judge)
For quality criteria that resist automation:

```markdown
## Completion Check - UX Quality
Criteria: Navigation is intuitive, primary actions are discoverable
Test: User can complete core flow without confusion

## Completion Check - Design Quality
Criteria: Visual hierarchy is clear, brand consistency maintained
Test: Layout follows established patterns
```

Run LLM-as-judge sub-agent for binary pass/fail.

## Technology-Specific Patterns

### Next.js Full Stack

```
specs/
├── authentication.md
├── database.md
└── api-routes.md

src/
├── app/                    # App Router
├── components/              # React components
├── lib/                    # Utilities (db, auth, helpers)
└── types/                   # TypeScript types

AGENTS.md:
  Build: npm run dev
  Test: npm run test
  Typecheck: npx tsc --noEmit
  Lint: npm run lint
```

### Python (Scripts/Notebooks/FastAPI)

```
specs/
├── data-pipeline.md
├── model-training.md
└── api-endpoints.md

src/
├── pipeline.py
├── models/
├── api/
└── tests/

AGENTS.md:
  Build: python -m src.main
  Test: pytest
  Typecheck: mypy src/
  Lint: ruff check src/
```

### GPU Workloads

```
specs/
├── model-architecture.md
├── training-data.md
└── inference-pipeline.md

src/
├── models/
├── training/
├── inference/
└── utils/

AGENTS.md:
  Train: python train.py
  Test: pytest tests/
  Lint: ruff check src/
  GPU Check: nvidia-smi
```

## Quick Start Command

Start a Ralph Mode session:

```
"Start Ralph Mode for my project at ~/projects/my-app. I want to implement user authentication with JWT.
```

I will:
1. Create IMPLEMENTATION_PLAN.md with prioritized tasks
2. Spawn sub-agents for iterative implementation
3. Apply backpressure gates (test, lint, typecheck)
4. Track progress and announce completion

## Operational Learnings

When Ralph patterns emerge, update AGENTS.md:

```markdown
## Discovered Patterns

- When adding API routes, also add to OpenAPI spec
- Use existing db utilities from src/lib/db over direct calls
- Test files must be co-located with implementation
```

## Escape Hatches

When trajectory goes wrong:
- **Ctrl+C** - Stop loop immediately
- **Regenerate plan** - "Discard IMPLEMENTATION_PLAN.md and re-plan"
- **Reset** - "Git reset to last known good state"
- **Scope down** - Create smaller scoped plan for specific work

## Advanced: LLM-as-Judge Fixture

For subjective criteria (tone, aesthetics, UX):

Create `src/lib/llm-review.ts`:

```typescript
interface ReviewResult {
  pass: boolean;
  feedback?: string;
}

async function createReview(config: {
  criteria: string;
  artifact: string; // text or screenshot path
}): Promise<ReviewResult>;
```

Sub-agents discover and use this pattern for binary pass/fail checks.

## Memory Updates

After each Ralph Mode session, document:

```markdown
## [Date] Ralph Mode Session

**Project:** [project-name]
**Duration:** [iterations]
**Outcome:** success / partial / blocked
**Learnings:**
- What worked well
- What needs adjustment
- Patterns to add to AGENTS.md
```
