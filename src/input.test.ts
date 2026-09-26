import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildBlindEvidenceView,
  buildBlindGoView,
  goPolicyAdmittedCandidateEvidenceIds,
} from "./blind.js";
import { canonicalAccession } from "./accession.js";
import type { GOPredictionSet } from "./types.js";
import {
  canonicalFasta,
  canonicalPdb,
  parseFastaSequence,
  prepareAnonymousInputs,
  prepareTargetContext,
} from "./input.js";

test("provider-decorated and versioned accessions share one canonical identity", () => {
  assert.equal(canonicalAccession("NP_612355.1"), "NP_612355");
  assert.equal(canonicalAccession("ref|NP_612355.1|"), "NP_612355");
  assert.equal(canonicalAccession("sp|O60268.2|K0513_HUMAN"), "O60268");
  assert.equal(canonicalAccession("Q9BDB7-2"), "Q9BDB7-2");
});

test("target context defaults to optional phylogeny with explicit unavailable taxonomy", () => {
  assert.deepEqual(prepareTargetContext({}), {
    taxon: { taxonId: null, provenance: "unavailable" },
    phylogeny: { mode: "optional", status: "unavailable_missing_taxon" },
  });
});

test("anonymous target context accepts a declared positive TaxID without an identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-target-context-"));
  try {
    const sequenceSource = join(root, "source.fasta");
    await writeFile(sequenceSource, ">sp|SECRET1|PRIVATE_NAME OS=Homo sapiens OX=9606\nMKTAYIAKQRQISFVK\n", "utf8");
    const prepared = await prepareAnonymousInputs({
      sequenceSource,
      stagingDir: join(root, "prepared"),
      targetMode: "anonymous",
      queryTaxonId: 9606,
      phylogenyMode: "required",
    });
    assert.match(prepared.proteinId, /^ANON_[A-F0-9]{12}$/);
    assert.deepEqual(prepared.targetContext, {
      taxon: { taxonId: 9606, provenance: "provided" },
      phylogeny: { mode: "required", status: "requested" },
    });
    assert.equal(prepared.redactionReport.schemaVersion, "pi-input-redaction.v2");
    const canonical = await readFile(prepared.sequencePath, "utf8");
    assert.doesNotMatch(canonical, /SECRET1|PRIVATE_NAME|Homo sapiens|9606/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target context rejects invalid TaxIDs and required phylogeny without TaxID", () => {
  for (const queryTaxonId of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => prepareTargetContext({ queryTaxonId }), /positive integer/);
  }
  assert.throws(
    () => prepareTargetContext({ phylogenyMode: "required" }),
    /required needs a declared positive query taxon ID/,
  );
});

test("FASTA canonicalization discards identity and taxon metadata while preserving sequence", () => {
  const source = ">sp|O60268|K0513_HUMAN OS=Homo sapiens OX=9606\nMKTAYIAK\nQRQISFVK\n";
  const parsed = parseFastaSequence(source);
  const canonical = canonicalFasta(parsed.sequence);
  assert.equal(parsed.sequence, "MKTAYIAKQRQISFVK");
  assert.equal(canonical, ">anonymous_query\nMKTAYIAKQRQISFVK\n");
  assert.doesNotMatch(canonical, /O60268|KIAA|HUMAN|9606/);
});

test("FASTA parser rejects multiple records even when headers are adjacent", () => {
  assert.throws(
    () => parseFastaSequence(">first\n>second\nMKTAYIAK\n"),
    /Exactly one FASTA sequence/,
  );
});

test("PDB canonicalization removes identity records and retains coordinates and pLDDT B-factors", () => {
  const atom = "ATOM      1  CA  MET A   1      11.104  13.207   8.123  1.00 87.50      O602 C  QUERY_NAME";
  const source = [
    "HEADER    ALPHAFOLD O60268 MODEL",
    "TITLE     KIAA0513",
    "COMPND    MOL_ID: 1; MOLECULE: KIAA0513;",
    "SOURCE    ORGANISM_TAXID: 9606;",
    "DBREF  1ABC A    1   411  UNP    O60268",
    atom,
    "END",
  ].join("\n");
  const canonical = canonicalPdb(source);
  assert.match(canonical.text, /ALPHAFOLD_PLDDT/);
  assert.match(canonical.text, /87\.50/);
  assert.match(canonical.text, /^ATOM/m);
  assert.doesNotMatch(canonical.text, /O60268|O602|QUERY_NAME|KIAA0513|ORGANISM_TAXID|DBREF/);
  assert.equal(canonicalPdb(canonical.text).text, canonical.text);
  assert.equal(canonical.removed, 5);
});

test("blind evidence view removes exact-query hits and annotations before narrative inference", () => {
  const bundle = {
    protein: { header: "anonymous_query", query_like_accessions: ["O60268"] },
    sequence_hits: [
      { evidence_id: "SEQ-SELF", accession: "O60268", query_like: true },
      { evidence_id: "SEQ-DONOR", accession: "D1" },
    ],
    structure_hits: [{ evidence_id: "STR-SELF", accession: "O60268", query_like: true }],
    uniprot_annotations: [
      { evidence_id: "ANN-UP-O60268", accession: "O60268", query_like: true, go_terms: [{ id: "GO:0000001" }] },
      { evidence_id: "ANN-UP-D1", accession: "D1", function: ["Interacts with O60268 in a frozen donor record."] },
    ],
    intrinsic_evidence: [{ evidence_id: "INTRINSIC-SEQ-01", kind: "sequence_summary" }],
    negative_search_evidence: [],
    pdb_annotations: [],
    domain_segments: [],
    runtime: {
      tool_versions: { blastp: "blastp 2.16.0" },
      annotation_cache_inventory: { files: [{ path: "cache/annotations/uniprot_O60268.json" }] },
      database_inventories: { blast: { prefix: "/private/db/O60268" } },
    },
    evidence_ids: ["SEQ-SELF", "SEQ-DONOR", "STR-SELF", "ANN-UP-O60268", "ANN-UP-D1"],
  };
  const view = buildBlindEvidenceView(bundle, ["O60268"], []);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /O60268|GO:0000001|SEQ-SELF|STR-SELF/);
  assert.match(serialized, /SEQ-DONOR|ANN-UP-D1/);
  assert.match(serialized, /INTRINSIC-SEQ-01/);
  assert.deepEqual((view.runtime as Record<string, unknown>).tool_versions, { blastp: "blastp 2.16.0" });
});

test("blind evidence redacts query-like accessions embedded in retained donor prose", () => {
  const bundle = {
    protein: { header: "anonymous_query", query_like_accessions: ["Q13526"] },
    sequence_hits: [{ evidence_id: "SEQ-DONOR", accession: "D1" }],
    structure_hits: [], pdb_annotations: [], domain_segments: [],
    negative_search_evidence: [], intrinsic_evidence: [], runtime: {},
    uniprot_annotations: [{
      evidence_id: "ANN-UP-D1",
      accession: "D1",
      function: "Independent donor note citing UniProtKB:Q13526 and Q13526.",
      record_sha256: "0f1f8a0000000000000000000000000000000000000000000000000000000000",
    }],
    evidence_ids: ["SEQ-DONOR", "ANN-UP-D1"],
  };
  const view = buildBlindEvidenceView(bundle, ["Q13526", "1F8A"], []);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /Q13526/);
  assert.match(serialized, /query-like identity redacted/);
  assert.match(serialized, /0f1f8a0/, "an accession-like hex substring inside a hash is not identity metadata");
});

test("blind evidence removes an entire broad hit when any provider alias is query-like", () => {
  const bundle = {
    protein: { header: "anonymous_query", query_like_accessions: ["WP_012345"] },
    sequence_hits: [{
      evidence_id: "SEQ-ALIASED-SELF",
      accession: "O60268",
      provider_primary_accession: "XP_OTHER.1",
      alias_accessions: ["O60268"],
      aliases: [
        { id: "ref|WP_012345.1|", accession: "WP_012345.1" },
        { id: "sp|O60268|QUERY", accession: "O60268" },
      ],
    }],
    structure_hits: [], uniprot_annotations: [], pdb_annotations: [], domain_segments: [],
    negative_search_evidence: [], intrinsic_evidence: [], evidence_ids: ["SEQ-ALIASED-SELF"], runtime: {},
  };
  const view = buildBlindEvidenceView(bundle, ["ref|WP_012345.1|"], []);
  assert.deepEqual(view.sequence_hits, []);
  assert.doesNotMatch(JSON.stringify(view), /O60268|WP_012345|SEQ-ALIASED-SELF/);
});

test("blind evidence exposes only direct candidates admitted by authoritative GO policy", () => {
  const candidate = (evidenceId: string, goId: string) => ({
    evidence_id: evidenceId,
    go_id: goId,
    provider: "DeepGOPlus",
    source_type: "deepgoplus_cnn",
    donor_accession: null,
    query_like: false,
    phylogeny: null,
  });
  const bundle = {
    protein: { header: "anonymous_query" },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    pdb_annotations: [],
    domain_segments: [],
    negative_search_evidence: [],
    intrinsic_evidence: [],
    runtime: {},
    candidate_sources: {
      providers: [{ provider: "DeepGOPlus", status: "completed" }],
      go_candidates: [
        candidate("CAND-ADMITTED", "GO:0000001"),
        candidate("CAND-BELOW-FLOOR", "GO:0000002"),
        candidate("CAND-ASPECT-EXCLUDED", "GO:0000003"),
        candidate("CAND-LEAF-FORBIDDEN", "GO:0000004"),
      ],
    },
    evidence_ids: [
      "CAND-ADMITTED",
      "CAND-BELOW-FLOOR",
      "CAND-ASPECT-EXCLUDED",
      "CAND-LEAF-FORBIDDEN",
    ],
  };
  const go = {
    terms: [
      {
        goId: "GO:0000001",
        selected: false,
        evidenceCode: "MODEL",
        evidenceIds: ["CAND-ADMITTED"],
        donorSupports: [
        {
          annotationEvidenceId: "CAND-ADMITTED",
          matchEvidenceIds: ["CAND-ADMITTED"],
          evidenceCode: "MODEL",
          candidateSourceType: "deepgoplus_cnn",
          candidateSelectionEligible: true,
          leafTransferAllowed: true,
          ontologyDepth: 0,
        },
        ],
      },
      {
        goId: "GO:0000002",
        selected: false,
        evidenceCode: "MODEL",
        evidenceIds: ["CAND-BELOW-FLOOR"],
        donorSupports: [
        {
          annotationEvidenceId: "CAND-BELOW-FLOOR",
          matchEvidenceIds: ["CAND-BELOW-FLOOR"],
          evidenceCode: "MODEL",
          candidateSourceType: "deepgoplus_cnn",
          candidateSelectionEligible: false,
          leafTransferAllowed: true,
          ontologyDepth: 0,
        },
        ],
      },
      {
        goId: "GO:0000004",
        selected: false,
        evidenceCode: "MODEL",
        evidenceIds: ["CAND-LEAF-FORBIDDEN"],
        donorSupports: [
        {
          annotationEvidenceId: "CAND-LEAF-FORBIDDEN",
          matchEvidenceIds: ["CAND-LEAF-FORBIDDEN"],
          evidenceCode: "MODEL",
          candidateSourceType: "deepgoplus_cnn",
          candidateSelectionEligible: true,
          leafTransferAllowed: false,
          ontologyDepth: 0,
        },
        {
          annotationEvidenceId: "CAND-LEAF-FORBIDDEN",
          matchEvidenceIds: ["CAND-LEAF-FORBIDDEN"],
          evidenceCode: "MODEL",
          candidateSourceType: "deepgoplus_cnn",
          candidateSelectionEligible: true,
          leafTransferAllowed: true,
          ontologyDepth: 1,
        },
        ],
      },
    ],
  } as unknown as Pick<GOPredictionSet, "terms">;
  const original = structuredClone(bundle);
  const admitted = goPolicyAdmittedCandidateEvidenceIds(go);
  assert.deepEqual(admitted, ["CAND-ADMITTED", "CAND-LEAF-FORBIDDEN"]);
  const view = buildBlindEvidenceView(bundle, [], admitted);
  assert.deepEqual(
    (view.candidate_sources as Record<string, unknown>).go_candidates,
    [
      candidate("CAND-ADMITTED", "GO:0000001"),
      candidate("CAND-LEAF-FORBIDDEN", "GO:0000004"),
    ],
  );
  assert.deepEqual(view.evidence_ids, ["CAND-ADMITTED", "CAND-LEAF-FORBIDDEN"]);
  const blindGo = buildBlindGoView(go as unknown as GOPredictionSet);
  assert.deepEqual(blindGo.terms.map((term) => term.goId), ["GO:0000001", "GO:0000004"]);
  assert.doesNotMatch(JSON.stringify(blindGo), /GO:0000002|CAND-BELOW-FLOOR/);
  assert.deepEqual(bundle, original, "blind policy projection must not mutate private candidates");
});

test("blind removal audit counts query-like learned candidate rows without donor accessions", () => {
  const bundle = {
    protein: { header: "anonymous_query", query_like_accessions: ["SELF"] },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    pdb_annotations: [],
    domain_segments: [],
    negative_search_evidence: [],
    intrinsic_evidence: [],
    runtime: {},
    candidate_sources: {
      providers: [{ provider: "DeepGOPlus", status: "completed" }],
      deepgoplus_receipt: {
        exact_training_sequence_match_count: 0,
        near_exact_training_sequence_match_count: 1,
        top_diamond_donors: [{
          subjectId: "QUERY_LIKE_SUBJECT",
          accession: "ALIAS_NOT_ON_EXCLUSION_LIST",
          taxonId: "9606",
          nearExact: true,
        }],
      },
      go_candidates: [{
        evidence_id: "CAND-DGPH-QUERY-LIKE",
        go_id: "GO:0005488",
        provider: "DeepGOPlus",
        source_type: "deepgoplus_hybrid",
        donor_accession: null,
        query_like: true,
        phylogeny: null,
      }],
    },
    evidence_ids: ["CAND-DGPH-QUERY-LIKE"],
  };
  const view = buildBlindEvidenceView(bundle, ["SELF"], []);
  assert.deepEqual(
    (view.candidate_sources as Record<string, unknown>).go_candidates,
    [],
  );
  const audit = view.blind_view as Record<string, unknown>;
  assert.equal(audit.candidate_query_like_records_removed, 1);
  assert.equal(
    audit.query_like_records_removed,
    2,
    "the legacy accession count plus the donor-less candidate row are both disclosed",
  );
  assert.doesNotMatch(
    JSON.stringify(view),
    /CAND-DGPH-QUERY-LIKE|GO:0005488|QUERY_LIKE_SUBJECT|ALIAS_NOT_ON_EXCLUSION_LIST|top_diamond_donors|deepgoplus_receipt/,
  );
});

test("blind evidence removes nested query citations while preserving an independent donor", () => {
  const bundle = {
    protein: { header: "anonymous_query", query_like_accessions: ["NP_612355.1"] },
    sequence_hits: [], structure_hits: [], pdb_annotations: [], domain_segments: [],
    negative_search_evidence: [], intrinsic_evidence: [], runtime: {},
    uniprot_annotations: [{
      evidence_id: "ANN-UP-D1",
      accession: "D1",
      catalytic_activity: ["query-derived catalytic claim"],
      structured_xrefs: {
        item_count: 2,
        ec_numbers: [
          {
            id: "3.1.26.n2",
            evidences: [{ source: "UniProtKB", reference_id: "ref|NP_612355.7|" }],
            provenance: [{ provider: "UniProtKB", record_accession: "sp|NP_612355.9|QUERY" }],
          },
          {
            id: "1.2.3.4",
            evidences: [{ source: "PubMed", reference_id: "15105377" }],
            provenance: [{ provider: "UniProtKB", record_accession: "D1" }],
          },
        ],
      },
    }],
    evidence_ids: ["ANN-UP-D1"],
  };
  const original = structuredClone(bundle);
  const view = buildBlindEvidenceView(bundle, ["NP_612355.1"], []);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /NP_612355|QUERY|3\.1\.26\.n2|query-derived catalytic claim/);
  assert.match(serialized, /ANN-UP-D1|D1|1\.2\.3\.4|15105377/);
  const annotation = (view.uniprot_annotations as Array<Record<string, unknown>>)[0];
  const xrefs = annotation.structured_xrefs as Record<string, unknown>;
  assert.equal(xrefs.item_count, 1);
  assert.equal((xrefs.ec_numbers as unknown[]).length, 1);
  assert.equal(annotation.catalytic_activity, undefined);
  assert.deepEqual(bundle, original, "blind projection must not mutate private evidence");
  assert.notStrictEqual(annotation, bundle.uniprot_annotations[0]);
  assert.notStrictEqual(xrefs.ec_numbers, bundle.uniprot_annotations[0].structured_xrefs.ec_numbers);
});

test("blind GO view removes trusted target accession before Pi or reporting", () => {
  const audit = {
    schemaVersion: "pi-go-prediction.v3",
    proteinId: "ANON_123",
    targetMode: "anonymous",
    identityPolicy: "strict_blind_v1",
    queryAccession: null,
    queryLikeAccessions: ["SECRET1"],
    explicitlyExcludedAccessions: ["SECRET1"],
    queryTaxonId: null,
    queryLineage: [],
    targetContext: {
      taxon: { taxonId: null, provenance: "unavailable" },
      phylogeny: { mode: "optional", status: "unavailable_missing_taxon" },
    },
    genomeId: "fixture",
    genomeHash: "a".repeat(64),
    methodId: "fixture",
    methodSummary: "fixture",
    calibrationStatus: "unavailable",
    dagProjectionStatus: "not_applied",
    candidateSources: { bundleHash: "b".repeat(64), providers: [], candidateCount: 0, appliedCandidateCount: 0 },
    phylogenyStatus: { mode: "disabled", targetTaxonStatus: "unavailable", evidenceCount: 0, appliedCount: 0, quarantinedCount: 0 },
    taxonConstraintStatus: "unavailable",
    thresholds: { molecular_function: 0.5, biological_process: 0.5, cellular_component: 0.5 },
    quarantinedGoIds: ["GO:0000001"],
    predictedGoIds: [],
    terms: [],
    canonicalHash: "source-audit-hash",
    limitations: ["fixture"],
  } satisfies GOPredictionSet;
  const view = buildBlindGoView(audit);
  assert.doesNotMatch(JSON.stringify(view), /SECRET1|GO:0000001/);
  assert.deepEqual(view.explicitlyExcludedAccessions, []);
  assert.deepEqual(view.queryLikeAccessions, []);
  assert.equal(
    Object.prototype.hasOwnProperty.call(view, "ontologyQuarantinedGoIds"),
    false,
    "a blind view of a legacy source must not gain a new optional field and hash shape",
  );

  const ontologyAudit: GOPredictionSet = {
    ...audit,
    ontologyQuarantinedGoIds: ["GO:0000002"],
  };
  const ontologyView = buildBlindGoView(ontologyAudit);
  assert.deepEqual(ontologyView.ontologyQuarantinedGoIds, []);
  assert.doesNotMatch(JSON.stringify(ontologyView), /GO:0000002/);
});
