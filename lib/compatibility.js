export const supportedVersions = Object.freeze({
  node: Object.freeze({ min: "22.19.0", maxExclusive: "25.0.0", label: "Node.js 22.19 through 24.x" }),
  openclaw: Object.freeze({ min: "2026.9.4", maxExclusive: "2026.10.0", label: "OpenClaw 2026.9.4 through 2026.9.x" }),
  git: Object.freeze({ min: "2.39.0", maxExclusive: null, label: "Git 2.39 or newer" }),
  tailscale: Object.freeze({ min: "1.70.0", maxExclusive: null, label: "Tailscale 1.70 or newer" }),
});

export function parseNumericVersion(value) {
  const match = String(value || "").match(/(?:^|\D)(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3] || "0", 10)];
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function versionIsSupported(version, range) {
  const parsed = Array.isArray(version) ? version : parseNumericVersion(version);
  const minimum = parseNumericVersion(range.min);
  const maximum = range.maxExclusive ? parseNumericVersion(range.maxExclusive) : null;
  if (!parsed || !minimum) return false;
  return compareVersions(parsed, minimum) >= 0 && (!maximum || compareVersions(parsed, maximum) < 0);
}

export function normalizedVersion(value) {
  const parsed = parseNumericVersion(value);
  return parsed ? parsed.join(".") : "unknown";
}
