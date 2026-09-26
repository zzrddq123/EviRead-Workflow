import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { loadGenome } from "./genome.js";
import { parseGoBasicObo } from "./go_ontology.js";
import { hashCanonical } from "./hash.js";
import {
  containsAccessionToken,
  goPolicyContractIssues,
  goQuarantineContractIssues,
  guardedStrictGoRecompute,
} from "./validate.js";

test("identity scan distinguishes a PDB token from the same bytes inside a hash", () => {
  assert.equal(
    containsAccessionToken(
      "\"blindEvidenceBundle\":\"6b70915d0f44d4385c52d58c14c84e5\"",
      "5D0F",
    ),
    false,
  );
  assert.equal(
    containsAccessionToken("{\"source\":\"rcsb_5D0F.json\"}", "5D0F"),
    true,
  );
  assert.equal(
    containsAccessionToken("{\"donor\":\"sp|Q59MN2|protein\"}", "Q59MN2"),
    true,
  );
});

test("strict validation reports an incomplete learned history without donor-only recomputation", async () => {
  const learned = structuredClone(await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json")));
  learned.genome.genomeId = "historical-learned-binding-fixture";
  learned.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["mdeepfri_cnn"],
    allowedAspects: ["molecular_function"],
    minimumScore: 0.1,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  learned.genomeHash = hashCanonical(learned.genome);
  let recomputeCalls = 0;
  const missing = guardedStrictGoRecompute({
    genome: learned,
    evidenceBundle: { candidate_sources: { providers: [], go_candidates: [] } },
    recompute: () => {
      recomputeCalls += 1;
      return "must-not-run";
    },
  });
  assert.match(
    missing.completenessIssue ?? "",
    /Learned predictor completeness violation in strict artifact recomputation.*no hash-bound/,
  );
  assert.equal(recomputeCalls, 0);

  const complete = guardedStrictGoRecompute({
    genome: learned,
    evidenceBundle: {
      candidate_sources: {
        providers: [{ provider: "mDeepFRI", status: "completed" }],
        go_candidates: [],
        external_predictor_overlay: {
          overlay_hash: "a".repeat(64),
          method_hash: "b".repeat(64),
          prediction_set_hash: "c".repeat(64),
          base_frozen_evidence_set_hash: "d".repeat(64),
          case_hash: "e".repeat(64),
        },
      },
    },
    recompute: () => {
      recomputeCalls += 1;
      return "recomputed";
    },
  });
  assert.equal(complete.value, "recomputed");
  assert.equal(complete.completenessIssue, undefined);
  assert.equal(recomputeCalls, 1);
});

function weightIssues(eligibility: boolean | undefined, evidenceWeight: number): string[] {
  const rawSupport = Number((0.4 * evidenceWeight).toFixed(6));
  const termScore = Number((0.7 * rawSupport).toFixed(6));
  const support: Record<string, unknown> = {
    candidateSourceType: "interpro",
    evidenceCode: "IEA",
    evidenceWeight,
    similarityScore: 0.4,
    lineageFactor: 1,
    rawSupport,
    adjustedSupport: rawSupport,
    donorGroup: "candidate:interpro:fixture",
    provenanceRoots: ["interpro:fixture"],
  };
  if (eligibility !== undefined) support.candidateSelectionEligible = eligibility;
  const go = {
    thresholds: { molecular_function: 0.5 },
    terms: [{
      goId: "GO:0005488",
      aspect: "molecular_function",
      selected: false,
      rawScore: termScore,
      phylogenyAdjustedScore: termScore,
      donorSupports: [support],
    }],
  };
  const genome = {
    goPolicy: {
      maxSelectedTermsPerAspect: 10,
      evidenceWeights: { IEA: 0.3 },
      unknownEvidenceWeight: 0.1,
      minimumDonorGroupSupport: 0.1,
      minimumIndependentProvenanceRoots: 1,
      requireTwoStructureDonorGroups: false,
      candidateSourcePolicy: { mode: "storage_light", minimumEvidenceWeight: 0.75, requireIndependentRoots: 1 },
    },
  };
  return goPolicyContractIssues(go, genome).filter((issue) => /evidence weight does not match genome policy/.test(issue));
}

test("GO policy validator applies the candidate weight floor only to eligible candidates", () => {
  assert.deepEqual(weightIssues(false, 0.3), []);
  assert.deepEqual(weightIssues(true, 0.75), []);
  assert.deepEqual(weightIssues(undefined, 0.75), [], "legacy candidate supports without eligibility retain floor semantics");
  assert.equal(weightIssues(false, 0.75).length, 1);
  assert.equal(weightIssues(true, 0.3).length, 1);
});

test("GO quarantine validator includes direct and near-exact learned candidates using active GO IDs", () => {
  const ontology = parseGoBasicObo(`format-version: 1.2
data-version: releases/quarantine-validator

[Term]
id: GO:0003674
name: molecular_function
namespace: molecular_function

[Term]
id: GO:0005488
name: binding
namespace: molecular_function
alt_id: GO:1234567
is_a: GO:0003674
`);
  const candidate = (
    evidenceId: string,
    queryLike: boolean,
    donorAccession: string | null,
  ): Record<string, unknown> => ({
    go_id: "GO:1234567",
    term_name: "legacy binding",
    aspect: "molecular_function",
    source_type: "deepgoplus_hybrid",
    source_id: "deepgoplus_hybrid:methodhash",
    mapping_id: `deepgoplus_hybrid:${evidenceId}`,
    provider: "DeepGOPlus",
    provider_release: "1.0.2;data-1.0.28",
    provider_payload_sha256: "c".repeat(64),
    evidence_id: evidenceId,
    provenance_root: `deepgoplus-hybrid:${evidenceId}`,
    base_score: 0.9,
    query_coverage: null,
    domain_range: null,
    query_like: queryLike,
    annotation_evidence_code: "MODEL_HOMOLOGY",
    donor_accession: donorAccession,
    phylogeny: null,
  });
  const bundle = {
    uniprot_annotations: [],
    candidate_sources: {
      providers: [],
      go_candidates: [
        candidate("CAND-DIRECT-QUERY-LIKE", true, null),
        candidate("CAND-NEAR-QUERY-LIKE", false, "SELF.7"),
      ],
    },
  };
  const genome = {
    goPolicy: {
      learnedPredictorPolicy: {
        mode: "candidate_channel",
        allowedSources: ["deepgoplus_hybrid"],
      },
      candidateSourcePolicy: { mode: "disabled", allowedSources: [] },
      phylogenyPolicy: { mode: "disabled" },
    },
  };
  const validGo = {
    queryLikeAccessions: ["SELF"],
    quarantinedGoIds: ["GO:0005488"],
  };
  assert.deepEqual(
    goQuarantineContractIssues(validGo, bundle, genome, ontology),
    [],
  );
  assert.match(
    goQuarantineContractIssues(
      { ...validGo, quarantinedGoIds: ["GO:1234567"] },
      bundle,
      genome,
      ontology,
    )[0] ?? "",
    /candidate-source records/,
  );
});
