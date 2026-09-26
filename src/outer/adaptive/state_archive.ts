/**
 * Compatibility seam for historical adaptive StateRoot publications.
 *
 * The fresh ICLR codebases deliberately do not inherit legacy adaptive
 * campaign artifacts. New development uses the autonomous candidate graph and
 * the generic prospective version controller. Importing an old adaptive
 * StateRoot therefore fails closed instead of pulling the later R7/R8/R9
 * benchmark implementation into the generation-0 scientific baseline.
 */
export interface VerifiedAdaptiveStateArchive {
  archiveDir: string;
  sourceCommit: string;
  publicManifestHash: string;
  archiveSealHash: string;
  headOutcomeHash: string;
  campaignId: string;
  completedRounds: number[];
  decisions: Array<Record<string, any>>;
  retrospectiveExperiments: Array<Record<string, any>>;
  developerExplorations: Array<Record<string, any>>;
  epochResumes: Array<Record<string, any>>;
  retrospectiveIncumbents: Array<Record<string, any>>;
}

export async function verifyAdaptiveStateArchive(
  _archiveDir: string,
): Promise<VerifiedAdaptiveStateArchive> {
  throw new Error(
    "legacy adaptive StateRoot import is intentionally unavailable in the fresh ICLR genesis; use a new autonomous campaign and generic prospective evaluator contract",
  );
}
