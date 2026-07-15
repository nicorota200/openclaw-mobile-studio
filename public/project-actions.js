export const projectActions = [
  { id: "review_changes", label: "Review", hint: "risk and next steps" },
  { id: "explain_diff", label: "Explain", hint: "current diff" },
  { id: "run_checks", label: "Check", hint: "safe tests" },
  { id: "prepare_commit", label: "Commit plan", hint: "message and staging" },
  { id: "continue_work", label: "Continue", hint: "resume safely" },
];

export function projectActionLabel(action) {
  return projectActions.find((item) => item.id === action)?.label || String(action || "").replace(/_/g, " ");
}

export function projectActionPrompt(action, context) {
  const repo = context?.repositoryName || "this project";
  const path = context?.repositoryPath || "";
  const branch = context?.branch || "current branch";
  const counts = context?.counts || {};
  const summary = [
    `Project: ${repo}`,
    path ? `Path: ${path}` : "",
    `Branch: ${branch}`,
    `Changes: ${counts.total || 0} total, ${counts.staged || 0} staged, ${counts.untracked || 0} untracked`,
  ]
    .filter(Boolean)
    .join("\n");
  const prompts = {
    review_changes: `${summary}\n\nReview the current changes. Summarize changed files, behavioral risk, missing tests, and recommended next steps. Do not modify files unless I explicitly approve.`,
    explain_diff: `${summary}\n\nExplain the current diff in practical terms. Focus on what changed, why it matters, and what I should verify. Do not modify files.`,
    run_checks: `${summary}\n\nInspect the project tooling and run the safest relevant checks for this repository. Report the exact commands and results. Avoid destructive commands and ask before anything risky.`,
    prepare_commit: `${summary}\n\nPrepare a commit plan. Suggest what should be staged, what should stay out, and a concise commit message. Do not commit unless I explicitly approve.`,
    continue_work: `${summary}\n\nContinue work on this repository from the current state. First inspect status and context, then propose the next safe step before making risky changes.`,
  };
  return prompts[action] || prompts.review_changes;
}
