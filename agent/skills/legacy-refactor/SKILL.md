---
name: legacy-refactor
description: >
  Legacy-code refactoring workflow. Centered on the tester/sugar-tester -> refactorer loop,
  aligned with existing orchestrator, TDD, and Legacy Code Exemption rules.
---

# Legacy Code Refactoring Workflow

This skill defines the dedicated workflow for structural changes in risky legacy code. It is distinct from normal desired-behavior TDD: the goal here is to preserve current behavior first, then improve structure safely.

---

## 1. Purpose

Use this workflow for behavior-preserving refactors in legacy areas with high coupling, weak boundaries, or low confidence. Safety comes from a tight characterization-test-first loop:

1. Freeze current behavior with baseline tests.
2. Make one small structural change.
3. Re-run the same baseline immediately.
4. Stop on any regression.

---

## 2. When to Use vs. When Not to Use

### When to Use
- Technical-debt reduction in legacy code.
- Preparing a legacy area for later feature work by creating safer seams.
- Extracting, simplifying, renaming, or de-duplicating behavior that must stay equivalent.

### When Not to Use
- New features or bug fixes that change intended behavior. Use the normal TDD workflow.
- Small direct fixes where desired behavior is known and practical RED-first tests can be written.
- Large rewrites that cannot be decomposed into small behavior-preserving steps.

---

## 3. Agent Routing

- `scout` — map boundaries, side effects, callers, and practical test seams.
- `tester` or `sugar-tester` — assess testability and, when practical, write characterization tests that lock down current behavior.
- `refactorer` — make small structural edits only after a passing characterization baseline exists.
- `tester` or `sugar-tester` — re-run the characterization baseline after each refactor step.
- `codereviewer` or `critic` — optional final review for design quality and scope control.

Use `sugar-tester` only for SugarCRM/SuiteCRM projects under the existing detection rules. Otherwise use `tester`.

---

## 4. Workflow Stages

### Stage 1: Recon and Testability Assessment
Dispatch `scout` to identify:
- target files and call sites
- side effects, globals, hidden inputs, and external dependencies
- whether existing test infrastructure provides a practical characterization path

Then dispatch `tester` or `sugar-tester` to classify the target:
- **Practical characterization path exists** — continue to Stage 2.
- **No practical characterization path** — use the Legacy Code Exemption path in Stage 4.

### Stage 2: Characterization Baseline
Before any structural edit:
1. Write characterization tests for what the code does today, not what it should do.
2. Cover observable inputs, outputs, side effects, and error paths.
3. Confirm the characterization tests pass on the unmodified code.

No refactoring starts until this baseline is GREEN.

### Stage 3: Refactor Loop
The legacy-refactor loop is:
- tester/sugar-tester establishes GREEN baseline
- refactorer makes one small behavior-preserving change
- tester/sugar-tester re-runs the characterization baseline

Outcomes:
- **GREEN** — continue with the next small step.
- **RED** — stop the pipeline at once, revert to the last known green state, and reassess. A refactor regression is a stop condition, not a normal RED/GREEN retry cycle.

Do not convert a failed refactor step into feature work or bug-fix work inside the same loop.

### Stage 4: Legacy Code Exemption Path
If meaningful characterization tests are not practical because the code is too tightly coupled, requires broad unrelated setup, or would need risky seam creation:
- In interactive contexts, ask the user to confirm the bypass.
- In non-interactive contexts, log the reason and proceed.
- Use the smallest safe change only.
- Prefer `worker` for minimal corrective edits; use `refactorer` only if the task is still strictly structural.
- Provide a manual verification plan and clearly state residual risk.

This is a minimal-change exemption path, not permission for broad refactoring without tests.

### Stage 5: Final Verification and Review
After the final green baseline:
- run the relevant characterization suite again
- run any additional focused checks that already exist for the touched area
- optionally dispatch `codereviewer` or `critic` for scope and design review

---

## 5. Decision Gates and Stop Conditions

### Decision Gates
- **Testability gate**: Is there a practical way to characterize the current behavior?
- **Baseline gate**: Do the characterization tests pass before refactoring?
- **Equivalence gate**: Does each refactor step preserve the characterization baseline?

### Stop Conditions
- Any characterization regression after a refactor step.
- Discovery that the next step requires unrelated feature behavior changes.
- Discovery that adequate characterization would require broad risky setup not justified by the task.
- User-visible bug preservation conflicts that require an explicit product decision.

When stopped on regression, return to the last known green state before proceeding with any smaller follow-up step.

---

## 6. Characterization-Test Guidance

- Test observed reality, not desired behavior.
- Favor black-box assertions over internal implementation checks.
- Keep tests focused on stable observable contracts.
- Include key quirks if callers depend on them.
- Record uncharacterized areas explicitly so later work does not assume coverage that is not there.

---

## 7. Outputs

At completion, provide:
1. Refactored source changes, limited to behavior-preserving structural work.
2. New characterization tests when a practical test path existed.
3. Verification status showing the baseline remained green.
4. Any Legacy Code Exemption reason, minimal-change justification, and residual risks when tests were not practical.
