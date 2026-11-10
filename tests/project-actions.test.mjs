import assert from "node:assert/strict";
import test from "node:test";
import { projectActions, projectActionLabel, projectActionPrompt } from "../public/project-actions.js";

const context = Object.freeze({
  repositoryName: "example-project",
  repositoryPath: "projects/example-project",
  branch: "feature/example",
  counts: Object.freeze({ total: 6, staged: 2, untracked: 1 }),
});

test("all five project actions carry project context and their safety instruction", () => {
  const instructions = {
    review_changes: /Do not modify files unless I explicitly approve\./,
    explain_diff: /Do not modify files\./,
    run_checks: /Report the exact commands and results\. Avoid destructive commands and ask before anything risky\./,
    prepare_commit: /Do not commit unless I explicitly approve\./,
    continue_work: /First inspect status and context, then propose the next safe step before making risky changes\./,
  };
  assert.deepEqual(projectActions.map(({ id }) => id).sort(), Object.keys(instructions).sort());
  for (const { id, label } of projectActions) {
    const prompt = projectActionPrompt(id, context);
    assert.match(prompt, /^Project: example-project\nPath: projects\/example-project\nBranch: feature\/example\nChanges: 6 total, 2 staged, 1 untracked\n\n/);
    assert.match(prompt, instructions[id]);
    assert.equal(projectActionLabel(id), label);
  }
});

test("missing context and unknown actions fall back to a read-only review", () => {
  const fallback = projectActionPrompt("review_changes");
  assert.match(fallback, /^Project: this project\nBranch: current branch\nChanges: 0 total, 0 staged, 0 untracked\n/);
  assert.equal(projectActionPrompt("unknown", null), fallback);
  assert.equal(projectActionPrompt(undefined, {}), fallback);
  assert.equal(projectActionLabel("future_action"), "future action");
  assert.equal(projectActionLabel(null), "");
});
