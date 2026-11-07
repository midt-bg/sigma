// The audit gate of the declarations job (scripts/related-persons-job.mjs). A link the audit will not vouch
// for stays off the surface and the update goes on: the build is loaded once more without it and audited
// again — a few times, since a reload can surface a finding of its own. Only a defect that names no link,
// a finding that withholding did not remove, or a fourth failing audit stops the run.

/**
 * @param {{ audit: () => void, verdict: () => { links?: string[], structural?: number } | null,
 *           reload: (links: string[], pass: number) => void, maxReloads?: number }} io
 * @returns {string[]} the links withheld from this build
 */
export function auditUntilClean({ audit, verdict, reload, maxReloads = 3 }) {
  const withheld = new Set();
  for (let pass = 1; ; pass++) {
    try {
      audit();
      return [...withheld];
    } catch (error) {
      const found = verdict();
      const fresh = (found?.links ?? []).filter((key) => !withheld.has(key));
      if (error.signal || !fresh.length || found.structural || pass > maxReloads) throw error;
      for (const key of fresh) withheld.add(key);
      reload([...withheld], pass);
    }
  }
}
