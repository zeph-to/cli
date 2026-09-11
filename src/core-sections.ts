/**
 * Slice one `### ` section out of a generated rule core (zeph-core.generated.ts).
 *
 * The core is one string per audience, assembled upstream from
 * plugin/docs/CORE_RULES.md. Two consumers need single sections of it:
 * templates.ts, which builds the NORMAL-only rule file for agents whose
 * prompt-submit hook can announce REMOTE, and remote-hook.ts, which injects
 * the REMOTE sections on the turn that enters it — the twin of the plugin's
 * zeph-remote.sh reading CORE_RULES.md on entry.
 *
 * Headings are matched by title prefix (`Sticky REMOTE mode`), not by the
 * `(Rule N)` suffix: the extractor renumbers per audience, so the number is
 * not stable across cores. A heading the core does not carry throws — every
 * caller passes a literal, so the throw surfaces at import time in the tests
 * rather than as a silently empty rule file.
 */
export const coreSection = (core: string, heading: string): string => {
  const sections = core.split(/^(?=### )/m).map((s) => s.trim());
  const found = sections.filter((s) => s.startsWith(`### ${heading}`));
  if (found.length !== 1) {
    throw new Error(`core section "${heading}" ${found.length ? 'is ambiguous' : 'not found'} in the generated core`);
  }
  return found[0];
};
