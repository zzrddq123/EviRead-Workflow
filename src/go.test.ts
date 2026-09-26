import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { buildBlindGoView } from "./blind.js";
import { buildDeterministicNarrative } from "./deterministic.js";
import { loadGenome } from "./genome.js";
import { inferGoPredictions } from "./go.js";
import { buildGOJudgeBinding } from "./go_judge.js";
import { parseGoBasicObo } from "./go_ontology.js";
import { hashCanonical } from "./hash.js";
import { goPolicyContractIssues, goSelectionContractIssues } from "./validate.js";

function annotation(accession: string, proteinName: string, taxonId: number, goTerms: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    evidence_id: `ANN-UP-${accession}`,
    accession,
    retrieval_status: "completed",
    protein_name: proteinName,
    organism: taxonId === 9606 ? "Homo sapiens" : "Mus musculus",
    organism_taxon_id: taxonId,
    organism_lineage: ["Eukaryota", "Metazoa", "Chordata", "Mammalia"],
    go_terms: goTerms,
  };
}

function go(id: string, term: string, aspect: string, evidenceCode: string, referenceId?: string): Record<string, unknown> {
  return {
    id,
    name: term,
    term: `${aspect === "molecular_function" ? "F" : aspect === "biological_process" ? "P" : "C"}:${term}`,
    aspect,
    evidence_code: evidenceCode,
    references: referenceId ? [{ source: "PubMed", reference_id: referenceId, eco_id: "ECO:0000314" }] : [],
  };
}

function fixture(sharedGefRoot = false): Record<string, unknown> {
  const structureHits = [
    { evidence_id: "STR-FULL-SP-LOW", reference_database: "swissprot", scope: "full_length", accession: "D1", probability: 1, query_tm_score: 0.2, query_coverage: 1, target_coverage: 0.5 },
    { evidence_id: "STR-FULL-SP-D1", reference_database: "swissprot", scope: "full_length", accession: "D1", probability: 1, query_tm_score: 0.6, query_coverage: 1, target_coverage: 0.5 },
    { evidence_id: "STR-FULL-SP-D2", reference_database: "swissprot", scope: "full_length", accession: "D2", probability: 1, query_tm_score: 0.55, query_coverage: 1, target_coverage: 0.5 },
  ];
  const annotations = [
    annotation("O60268", "Uncharacterized protein KIAA0513", 9606, [go("GO:0005737", "cytoplasm", "cellular_component", "IEA")]),
    annotation("D1", "MAP kinase-activating death domain protein", 9606, [
      go("GO:0005085", "guanyl-nucleotide exchange factor activity", "molecular_function", "IDA", "111"),
      go("GO:0097194", "execution phase of apoptosis", "biological_process", "IDA", "333"),
    ]),
    annotation("D2", "Myotubularin-related protein 5", 10090, [
      go("GO:0005085", "guanyl-nucleotide exchange factor activity", "molecular_function", "IDA", sharedGefRoot ? "111" : "222"),
      go("GO:0097194", "execution phase of apoptosis", "biological_process", "IDA", "444"),
    ]),
  ];
  return {
    protein: { header: "sp|O60268|K0513_HUMAN OS=Homo sapiens OX=9606", query_taxon_id: 9606 },
    sequence_hits: [
      { evidence_id: "SEQ-SELF", accession: "O60268", percent_identity: 100, query_coverage: 1, subject_coverage: 1, alignment_length: 411, subject_length: 411 },
    ],
    structure_hits: structureHits,
    uniprot_annotations: annotations,
    evidence_ids: [
      "SEQ-SELF", "STR-FULL-SP-LOW", "STR-FULL-SP-D1", "STR-FULL-SP-D2",
      "ANN-UP-O60268", "ANN-UP-D1", "ANN-UP-D2",
    ],
  };
}

test("canonical hashing is stable across object key order", () => {
  assert.equal(hashCanonical({ b: 2, a: { d: 4, c: 3 } }), hashCanonical({ a: { c: 3, d: 4 }, b: 2 }));
});

test("GO inference retains identical-sequence donor evidence alongside independent MF transfer", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const result = inferGoPredictions({ proteinId: "O60268", bundle: fixture(), genome, queryTaxonId: 9606 });
  const cytoplasm = result.terms.find((term) => term.goId === "GO:0005737");
  const gef = result.terms.find((term) => term.goId === "GO:0005085");
  const apoptosis = result.terms.find((term) => term.goId === "GO:0097194");
  assert.ok(cytoplasm?.donorSupports.some(support => support.accession === "O60268"));
  assert.equal(gef?.decision, "transfer_hypothesis");
  assert.equal(gef?.confidenceLabel, "low_heuristic");
  assert.equal(gef?.donorSupports.length, 2);
  assert.equal(gef?.donorSupports.find((support) => support.accession === "D1")?.matchEvidenceIds[0], "STR-FULL-SP-D1");
  assert.equal(apoptosis?.decision, "abstained");
  assert.match(apoptosis?.reasons.join(" ") ?? "", /Structure-only transfer is disabled/);
  assert.deepEqual(result.quarantinedGoIds, []);
  assert.deepEqual(result.queryLikeAccessions, []);
  assert.deepEqual(result.predictedGoIds, ["GO:0005085"]);
  assert.equal(result.canonicalHash.length, 64);

  const narrative = buildDeterministicNarrative("O60268", result);
  assert.equal(narrative.confidence, "low");
  assert.match(narrative.mostLikelyFunction, /guan.*exchange factor/i);
  assert.ok(narrative.keyEvidence.length >= 3);
});

test("broad UniProt50 structure hits remain eligible without promoting context-only ClusteredNR IDs", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  const d1 = (bundle.structure_hits as Array<Record<string, unknown>>)
    .find((hit) => hit.accession === "D1" && hit.evidence_id === "STR-FULL-SP-D1");
  if (d1) {
    d1.reference_database = "uniprot";
    d1.remote_database = "afdb50";
  }
  (bundle.sequence_hits as Array<Record<string, unknown>>).push({
    evidence_id: "SEQ-CONTEXT-ONLY",
    accession: "WP_012345",
    annotation_eligible: false,
    percent_identity: 90,
    query_coverage: 1,
    subject_coverage: 1,
    alignment_length: 400,
    subject_length: 400,
  });
  (bundle.uniprot_annotations as Array<Record<string, unknown>>).push(
    annotation("WP_012345", "Context-only enzyme label", 10090, [
      go("GO:0016787", "hydrolase activity", "molecular_function", "IDA", "context-only"),
    ]),
  );
  (bundle.evidence_ids as string[]).push("SEQ-CONTEXT-ONLY", "ANN-UP-WP_012345");

  const result = inferGoPredictions({ proteinId: "ANON_BROAD", bundle, genome, queryTaxonId: 9606 });
  const gef = result.terms.find((term) => term.goId === "GO:0005085");
  assert.ok(gef?.donorSupports.some((support) => support.accession === "D1"));
  assert.equal(result.terms.find((term) => term.goId === "GO:0016787"), undefined);
});

test("identical ClusteredNR aliases remain ordinary donor evidence", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  bundle.sequence_hits = [{
    evidence_id: "SEQ-ALIASED-SELF",
    accession: "O60268",
    provider_primary_accession: "XP_OTHER.1",
    alias_accessions: ["O60268"],
    aliases: [
      { id: "ref|WP_012345.1|", accession: "WP_012345.1" },
      { id: "sp|O60268|QUERY", accession: "O60268" },
    ],
    percent_identity: 100,
    query_coverage: 1,
    subject_coverage: 1,
    alignment_length: 411,
    subject_length: 411,
  }];
  const result = inferGoPredictions({ proteinId: "ANON_ALIAS", bundle, genome, queryTaxonId: 9606 });
  assert.deepEqual(result.queryLikeAccessions, []);
  assert.deepEqual(result.quarantinedGoIds, []);
  assert.ok(result.terms.some(term => term.donorSupports.some(donor => donor.accession === "O60268")));
});

test("ordinary GO transfer uses normalized ordered lineage overlap and preserves missing-lineage semantics", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const missingBundle = fixture();
  const missing = inferGoPredictions({ proteinId: "ANON_LINEAGE", bundle: missingBundle, genome, queryTaxonId: 9606 });
  const missingSupport = missing.terms.find((term) => term.goId === "GO:0005085")
    ?.donorSupports.find((support) => support.accession === "D2");
  assert.equal(missingSupport?.lineageStatus, "unavailable");
  assert.equal(missingSupport?.lineageFactor, 1);

  const normalizedBundle = fixture();
  (normalizedBundle.protein as Record<string, unknown>).query_lineage_source = "declared_taxid_lookup";
  (normalizedBundle.protein as Record<string, unknown>).query_lineage = [
    "root", " EUKARYOTA ", "Metazoa", "Chordata", "Mammalia", "Mammalia",
  ];
  const d2 = (normalizedBundle.uniprot_annotations as Array<Record<string, unknown>>)
    .find((item) => item.accession === "D2");
  if (d2) d2.organism_lineage = ["cellular organisms", "eukaryota", " metazoa ", "chordata", "mammalia"];
  const normalized = inferGoPredictions({ proteinId: "ANON_LINEAGE", bundle: normalizedBundle, genome, queryTaxonId: 9606 });
  const normalizedSupport = normalized.terms.find((term) => term.goId === "GO:0005085")
    ?.donorSupports.find((support) => support.accession === "D2");
  assert.equal(normalizedSupport?.lineageStatus, "applied");
  assert.equal(normalizedSupport?.lineageFactor, 1);
});

test("GO inference abstains when structure donors share one annotation provenance root", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture(true);
  const result = inferGoPredictions({ proteinId: "O60268", bundle, genome, queryTaxonId: 9606 });
  const independent = inferGoPredictions({ proteinId: "O60268", bundle: fixture(false), genome, queryTaxonId: 9606 });
  const gef = result.terms.find((term) => term.goId === "GO:0005085");
  const independentGef = independent.terms.find((term) => term.goId === "GO:0005085");
  assert.equal(gef?.decision, "abstained");
  assert.equal(gef?.selected, false);
  assert.deepEqual(result.predictedGoIds, []);
  assert.match(gef?.reasons.join(" ") ?? "", /Only 1 independent donor-group\/provenance-root pair/);
  assert.ok((gef?.rawScore ?? 1) < (independentGef?.rawScore ?? 0), "shared-root donor groups must collapse before score fusion");

  const narrative = buildDeterministicNarrative("O60268", result, bundle);
  assert.match(narrative.mostLikelyFunction, /unresolved.*leading hypothesis/i);
  assert.match(narrative.functionalDescription, /abstention rather than a predicted GO label/i);
  assert.ok(narrative.keyEvidence.length > 0);
});

test("a negligible sequence match cannot unlock structure-dominated BP transfer", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  const hits = bundle.structure_hits as Array<Record<string, unknown>>;
  const d1 = hits.find((hit) => hit.evidence_id === "STR-FULL-SP-D1");
  const d2 = hits.find((hit) => hit.evidence_id === "STR-FULL-SP-D2");
  if (d1) d1.query_tm_score = 0.05;
  if (d2) d2.target_coverage = 1;
  (bundle.sequence_hits as unknown[]).push({
    evidence_id: "SEQ-WEAK-D1", accession: "D1", percent_identity: 10,
    query_coverage: 1, subject_coverage: 1, alignment_length: 411, subject_length: 411,
  });
  (bundle.evidence_ids as string[]).push("SEQ-WEAK-D1");
  const result = inferGoPredictions({ proteinId: "O60268", bundle, genome, queryTaxonId: 9606 });
  const apoptosis = result.terms.find((term) => term.goId === "GO:0097194");
  assert.ok((apoptosis?.phylogenyAdjustedScore ?? 0) >= genome.genome.goPolicy.thresholds.biological_process);
  assert.equal(apoptosis?.decision, "abstained");
  assert.match(apoptosis?.reasons.join(" ") ?? "", /Structure-only transfer is disabled/);
});

test("a stronger structure match does not erase qualifying sequence support for BP", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  genome.genome.goPolicy.sequenceEligibilityMode = "retained_sequence";
  genome.genomeHash = hashCanonical(genome.genome);
  const bundle = fixture();
  const d1 = (bundle.structure_hits as Array<Record<string, unknown>>)
    .find((hit) => hit.evidence_id === "STR-FULL-SP-D1");
  if (d1) {
    d1.query_coverage = 1;
    d1.target_coverage = 1;
    d1.query_tm_score = 0.8;
  }
  (bundle.sequence_hits as unknown[]).push({
    evidence_id: "SEQ-D1", accession: "D1", percent_identity: 40,
    query_coverage: 1, subject_coverage: 1, alignment_length: 411, subject_length: 411,
  });
  (bundle.evidence_ids as string[]).push("SEQ-D1");
  const result = inferGoPredictions({ proteinId: "O60268", bundle, genome, queryTaxonId: 9606 });
  const apoptosis = result.terms.find((term) => term.goId === "GO:0097194");
  const donor = apoptosis?.donorSupports.find((support) => support.accession === "D1");
  assert.equal(donor?.matchMode, "full_structure");
  assert.equal(donor?.hasSequence, true);
  assert.equal(donor?.sequenceSimilarityScore, 0.4);
  assert.deepEqual(donor?.matchEvidenceIds, ["SEQ-D1", "STR-FULL-SP-D1"]);
  assert.equal(apoptosis?.decision, "transfer_hypothesis");
});

test("a PDB Foldseek hit can transfer through a frozen T0 UniProt sequence bridge", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  bundle.structure_hits = (bundle.structure_hits as Array<Record<string, unknown>>)
    .filter((hit) => hit.accession !== "D1");
  (bundle.structure_hits as Array<Record<string, unknown>>).push({
    evidence_id: "STR-PDB-BRIDGED-D1",
    reference_database: "pdb",
    accession: "1ABC",
    annotation_accession: "D1",
    annotation_mapping: {
      method: "pdb_chain_sequence_to_frozen_t0_swissprot_blast",
      percent_identity: 97,
      query_coverage: 1,
    },
    scope: "full_length",
    probability: 1,
    query_tm_score: 0.8,
    query_coverage: 1,
    target_coverage: 1,
  });
  (bundle.evidence_ids as string[]).push("STR-PDB-BRIDGED-D1");
  const result = inferGoPredictions({ proteinId: "O60268", bundle, genome, queryTaxonId: 9606 });
  const apoptosis = result.terms.find((term) => term.goId === "GO:0097194");
  const donor = apoptosis?.donorSupports.find((support) => support.accession === "D1");
  assert.equal(donor?.matchMode, "full_structure");
  assert.ok(donor?.matchEvidenceIds.includes("STR-PDB-BRIDGED-D1"));
});

test("99% and 100% identity remain eligible in temporal and strict-blind modes", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  for (const percent_identity of [99, 99.9, 100]) {
    for (const identityPolicy of ["temporal_t0_v1", "strict_blind_v1"] as const) {
      const bundle = fixture();
      (bundle.protein as Record<string, unknown>).header = "anonymous query";
      (bundle.sequence_hits as Array<Record<string, unknown>>)[0]!.percent_identity = percent_identity;
      const result = inferGoPredictions({ proteinId: "query-protein", bundle, genome, queryTaxonId: 9606, identityPolicy });
      assert.deepEqual(result.quarantinedGoIds, []);
      assert.deepEqual(result.queryLikeAccessions, []);
      assert.ok(result.terms.flatMap(term => term.donorSupports).some(support => support.accession === "O60268"));
    }
  }
});

test("a query_like structure/annotation record is quarantined without an exact BLAST row", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  bundle.sequence_hits = [];
  const selfStructure = {
    evidence_id: "STR-SELF-FLAGGED",
    reference_database: "swissprot",
    scope: "full_length",
    accession: "O60268",
    probability: 1,
    query_tm_score: 1,
    query_coverage: 1,
    target_coverage: 1,
    query_like: true,
  };
  (bundle.structure_hits as Array<Record<string, unknown>>).push(selfStructure);
  const queryAnnotation = (bundle.uniprot_annotations as Array<Record<string, unknown>>)
    .find((item) => item.accession === "O60268");
  if (queryAnnotation) queryAnnotation.query_like = true;
  const result = inferGoPredictions({ identityPolicy: "strict_blind_v1", proteinId: "query-protein", bundle, genome, queryTaxonId: 9606 });
  assert.deepEqual(result.queryLikeAccessions, ["O60268"]);
  assert.deepEqual(result.quarantinedGoIds, ["GO:0005737"]);
  assert.ok(result.terms.flatMap((term) => term.donorSupports).every((support) => support.accession !== "O60268"));
});

test("trusted target accession quarantines its annotation when automatic self-detection misses", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  bundle.sequence_hits = [];
  const result = inferGoPredictions({ identityPolicy: "strict_blind_v1",
    proteinId: "ANON_FIXTURE",
    bundle,
    genome,
    targetMode: "anonymous",
    excludedAccessions: ["sp|O60268.3|K0513_HUMAN"],
  });
  assert.deepEqual(result.explicitlyExcludedAccessions, ["O60268"]);
  assert.deepEqual(result.queryLikeAccessions, ["O60268"]);
  assert.deepEqual(result.quarantinedGoIds, ["GO:0005737"]);
  assert.ok(result.terms.flatMap((term) => term.donorSupports).every((support) => support.accession !== "O60268"));
});

test("named-uncharacterized mode can independently re-predict a GO term also present on the quarantined query record", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle = fixture();
  const queryAnnotation = (bundle.uniprot_annotations as Array<Record<string, unknown>>)
    .find((item) => item.accession === "O60268");
  (queryAnnotation?.go_terms as Array<Record<string, unknown>>).push(
    go("GO:0005085", "guanyl-nucleotide exchange factor activity", "molecular_function", "IDA", "QUERY-ONLY"),
  );
  const result = inferGoPredictions({ identityPolicy: "strict_blind_v1",
    proteinId: "KIAA0513",
    bundle,
    genome,
    queryTaxonId: 9606,
    targetMode: "named_uncharacterized",
    excludedAccessions: ["O60268"],
  });
  assert.ok(result.quarantinedGoIds.includes("GO:0005085"));
  assert.ok(result.predictedGoIds.includes("GO:0005085"));
  const predicted = result.terms.find((term) => term.goId === "GO:0005085");
  assert.deepEqual(predicted?.donorSupports.map((support) => support.accession).sort(), ["D1", "D2"]);
});

test("deterministic total abstention still emits a cited, reviewable result", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const bundle: Record<string, unknown> = {
    protein: { header: "unknown query", query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [{ evidence_id: "STR-ONLY", reference_database: "swissprot", accession: "D0", scope: "full_length", probability: 0.2, query_tm_score: 0.2, query_coverage: 0.2, target_coverage: 0.2 }],
    domain_segments: [],
    uniprot_annotations: [],
    evidence_ids: ["STR-ONLY"],
  };
  const result = inferGoPredictions({ proteinId: "query-protein", bundle, genome, queryTaxonId: 9606 });
  assert.deepEqual(result.terms, []);
  const narrative = buildDeterministicNarrative("query-protein", result, bundle);
  assert.equal(narrative.confidence, "insufficient");
  assert.equal(narrative.keyEvidence[0]?.evidenceId, "STR-ONLY");
});

test("GO inference is permutation-stable", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const first = fixture();
  const second = fixture();
  (second.structure_hits as unknown[]).reverse();
  (second.uniprot_annotations as unknown[]).reverse();
  const one = inferGoPredictions({ proteinId: "O60268", bundle: first, genome, queryTaxonId: 9606 });
  const two = inferGoPredictions({ proteinId: "O60268", bundle: second, genome, queryTaxonId: 9606 });
  assert.equal(one.canonicalHash, two.canonicalHash);
});

test("pinned GO closure adds only safe non-root ancestors and records source provenance", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "ancestor_closure",
    maxDepth: 3,
    scoreDecay: 0.9,
    excludeRoots: true,
    relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const ontology = parseGoBasicObo(`format-version: 1.2
data-version: releases/2026-07-01

[Term]
id: GO:0003674
name: molecular_function
namespace: molecular_function

[Term]
id: GO:0005085
name: guanyl-nucleotide exchange factor activity
namespace: molecular_function
is_a: GO:0005100

[Term]
id: GO:0005100
name: signaling receptor binding
namespace: molecular_function
is_a: GO:0003674

[Term]
id: GO:9999999
name: unrelated activity
namespace: molecular_function
is_a: GO:0003674
`);
  const result = inferGoPredictions({
    proteinId: "ANON_FIXTURE",
    bundle: fixture(),
    genome,
    queryTaxonId: 9606,
    ontology,
  });
  const parent = result.terms.find((term) => term.goId === "GO:0005100");
  assert.equal(result.dagProjectionStatus, "ancestor_closure_applied");
  assert.equal(result.ontologyBinding?.sourceSha256, ontology.sha256);
  assert.equal(parent?.candidateOrigin, "ontology_ancestor");
  assert.deepEqual(parent?.sourceGoIds, ["GO:0005085"]);
  assert.equal(parent?.ontologyDepth, 1);
  assert.ok(parent?.donorSupports.every((support) => support.sourceGoId === "GO:0005085" && support.ontologyDepth === 1));
  assert.equal(result.terms.some((term) => term.goId === "GO:0003674"), false, "ontology roots stay excluded");
  assert.equal(result.terms.some((term) => term.goId === "GO:9999999"), false, "the GO graph does not invent unrelated leaf candidates");
  const explicitRootBundle = fixture();
  const rootDonor = (explicitRootBundle.uniprot_annotations as Array<Record<string, unknown>>)
    .find((item) => item.accession === "D1");
  (rootDonor?.go_terms as Array<Record<string, unknown>>).push(
    go("GO:0003674", "molecular_function", "molecular_function", "IDA", "root"),
  );
  const explicitRoot = inferGoPredictions({
    proteinId: "ANON_EXPLICIT_ROOT",
    bundle: explicitRootBundle,
    genome,
    queryTaxonId: 9606,
    ontology,
  });
  assert.equal(
    explicitRoot.terms.some((term) => term.goId === "GO:0003674"),
    false,
    "an explicitly supplied root is not a predictive GO label",
  );

  genome.genome.goPolicy.selectionPolicy = { mode: "evidence_frontier_v1" };
  genome.genome.goPolicy.maxSelectedTermsPerAspect = 1;
  genome.genomeHash = hashCanonical(genome.genome);
  const frontier = inferGoPredictions({
    proteinId: "ANON_FRONTIER",
    bundle: fixture(),
    genome,
    queryTaxonId: 9606,
    ontology,
  });
  assert.equal(frontier.selectionPolicyMode, "evidence_frontier_v1");
  assert.equal(frontier.terms.find((term) => term.goId === "GO:0005085")?.selectionRole, "primary_direct");
  assert.equal(frontier.terms.find((term) => term.goId === "GO:0005100")?.selectionRole, "entailed_ancestor");
  assert.deepEqual(frontier.predictedGoIds, ["GO:0005085", "GO:0005100"], "ancestor closure is dynamic and does not spend the one direct-hypothesis slot");
  assert.deepEqual(
    goSelectionContractIssues(frontier, genome.genome),
    [],
    "the deploy-time validator must accept a source-bound ancestor outside the one direct-hypothesis slot",
  );

  const tampered = structuredClone(frontier);
  const tamperedAncestor = tampered.terms.find((term) => term.goId === "GO:0005100");
  if (tamperedAncestor) tamperedAncestor.sourceGoIds = ["GO:9999999"];
  assert.ok(
    goSelectionContractIssues(tampered, genome.genome).some((issue) => issue.includes("not entailed")),
    "the threshold/cap exception must fail closed when its selected direct source is missing",
  );
});

function remoteCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    go_id: "GO:0005488",
    term_name: "binding",
    aspect: "molecular_function",
    source_type: "interpro",
    source_id: "IPR000001",
    mapping_id: "interproscan:IPR000001:GO:0005488",
    provider: "InterProScan",
    provider_release: "99.0",
    provider_payload_sha256: "c".repeat(64),
    evidence_id: "CAND-IPR-001",
    provenance_root: "query-domain:1-100",
    base_score: 0.8,
    query_coverage: 0.6,
    domain_range: "1-100",
    query_like: false,
    annotation_evidence_code: "IEA",
    donor_accession: null,
    phylogeny: null,
    ...overrides,
  };
}

function ontologyGateFixture() {
  return parseGoBasicObo(`format-version: 1.2
data-version: releases/2026-07-01

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

[Term]
id: GO:0032527
name: obsolete fixture activity
namespace: molecular_function
is_obsolete: true
`);
}

test("a supplied ontology quarantines unknown and obsolete direct annotations before scoring", async () => {
  const pinnedGenome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  pinnedGenome.genome.goPolicy.ontologyPolicy = {
    mode: "ancestor_closure",
    maxDepth: 8,
    scoreDecay: 1,
    excludeRoots: true,
    relations: ["is_a", "part_of"],
  };
  pinnedGenome.genomeHash = hashCanonical(pinnedGenome.genome);
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [{
      evidence_id: "SEQ-DIRECT-ONTOLOGY-GATE",
      accession: "D1",
      percent_identity: 80,
      query_coverage: 1,
      alignment_length: 100,
      subject_length: 100,
    }],
    structure_hits: [],
    uniprot_annotations: [annotation("D1", "ontology gate donor", 9606, [
      go("GO:0032527", "obsolete fixture activity", "molecular_function", "IDA", "obsolete"),
      go("GO:9999998", "unknown fixture activity", "molecular_function", "IDA", "unknown"),
    ])],
    evidence_ids: ["SEQ-DIRECT-ONTOLOGY-GATE", "ANN-UP-D1"],
  };

  const pinned = inferGoPredictions({
    proteinId: "ANON_DIRECT_ONTOLOGY_GATE",
    bundle,
    genome: pinnedGenome,
    queryTaxonId: 9606,
    ontology: ontologyGateFixture(),
  });
  assert.deepEqual(pinned.terms, [], "unresolved ontology IDs are not retained as scored abstentions");
  assert.deepEqual(pinned.predictedGoIds, []);
  assert.deepEqual(pinned.ontologyQuarantinedGoIds, ["GO:0032527", "GO:9999998"]);
  assert.deepEqual(pinned.quarantinedGoIds, [], "ontology rejection does not masquerade as query-identity quarantine");

  const legacyGenome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const legacy = inferGoPredictions({
    proteinId: "ANON_DIRECT_LEGACY",
    bundle,
    genome: legacyGenome,
    queryTaxonId: 9606,
  });
  assert.deepEqual(legacy.predictedGoIds, ["GO:0032527", "GO:9999998"]);
  assert.equal(legacy.ontologyQuarantinedGoIds, undefined, "no-ontology replay preserves the legacy output contract");
});

test("a supplied ontology quarantines unresolved candidate-source GO IDs before admission", async () => {
  const pinnedGenome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    candidate_sources: {
      providers: [],
      go_candidates: [
        remoteCandidate({ go_id: "GO:0032527", mapping_id: "interproscan:IPR000001:GO:0032527" }),
        remoteCandidate({
          go_id: "GO:9999998",
          source_id: "IPR000002",
          mapping_id: "interproscan:IPR000002:GO:9999998",
          evidence_id: "CAND-IPR-002",
          provenance_root: "query-domain:101-200",
        }),
      ],
    },
    evidence_ids: ["CAND-IPR-001", "CAND-IPR-002"],
  };

  const pinned = inferGoPredictions({
    proteinId: "ANON_CANDIDATE_ONTOLOGY_GATE",
    bundle,
    genome: pinnedGenome,
    queryTaxonId: 9606,
    ontology: ontologyGateFixture(),
  });
  assert.deepEqual(pinned.terms, []);
  assert.deepEqual(pinned.ontologyQuarantinedGoIds, ["GO:0032527", "GO:9999998"]);
  assert.equal(pinned.candidateSources.candidateCount, 2);
  assert.equal(pinned.candidateSources.admittedCandidateCount, 0);
  assert.equal(pinned.candidateSources.selectionEligibleCandidateCount, 0);
  assert.deepEqual(
    pinned.candidateSources.sourceStats?.find((item) => item.sourceType === "interpro"),
    { sourceType: "interpro", normalized: 2, admitted: 0, selectionEligible: 0, novelToDirectPool: 0, selectedTerms: 0 },
    "normalization remains auditable even though ontology-invalid candidates never enter the score pool",
  );

  const legacyGenome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  legacyGenome.genome.goPolicy.ontologyPolicy = { mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"] };
  legacyGenome.genomeHash = hashCanonical(legacyGenome.genome);
  const legacy = inferGoPredictions({
    proteinId: "ANON_CANDIDATE_LEGACY",
    bundle,
    genome: legacyGenome,
    queryTaxonId: 9606,
  });
  assert.deepEqual(legacy.predictedGoIds, ["GO:0032527", "GO:9999998"]);
  assert.equal(legacy.candidateSources.admittedCandidateCount, 2);
});

test("query-like ontology-invalid IDs remain identity-only quarantine and are removed from blind views", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [{
      ...annotation("QUERY1", "private query-like donor", 9606, [
        go("GO:0032527", "obsolete private activity", "molecular_function", "IDA", "private"),
      ]),
      query_like: true,
    }],
    candidate_sources: {
      providers: [],
      go_candidates: [remoteCandidate({
        go_id: "GO:9999998",
        mapping_id: "interproscan:IPR000001:GO:9999998",
        query_like: true,
      })],
    },
    evidence_ids: ["ANN-UP-QUERY1", "CAND-IPR-001"],
  };
  const audit = inferGoPredictions({ identityPolicy: "strict_blind_v1",
    proteinId: "ANON_IDENTITY_DOMINATES",
    bundle,
    genome,
    queryTaxonId: 9606,
    ontology: ontologyGateFixture(),
  });
  assert.deepEqual(audit.quarantinedGoIds, ["GO:0032527", "GO:9999998"]);
  assert.deepEqual(audit.ontologyQuarantinedGoIds, [], "ontology rejection cannot reveal query-like GO IDs through a second channel");
  assert.deepEqual(audit.terms, []);

  const blind = buildBlindGoView(audit);
  assert.deepEqual(blind.quarantinedGoIds, []);
  assert.deepEqual(blind.ontologyQuarantinedGoIds, []);
  assert.doesNotMatch(JSON.stringify(blind), /GO:0032527|GO:9999998|QUERY1/);
});

test("an ontology cannot affect inference without a genome-bound ancestor-closure policy", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  assert.throws(() => inferGoPredictions({
    proteinId: "ANON_UNBOUND_ONTOLOGY",
    bundle: { protein: {}, sequence_hits: [], structure_hits: [], uniprot_annotations: [] },
    genome,
    ontology: ontologyGateFixture(),
  }), /requires a genome-bound ancestor_closure policy/);
});

test("active ontology alt IDs canonicalize across direct and candidate-source channels", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [{
      evidence_id: "SEQ-ALT-DONOR",
      accession: "D1",
      percent_identity: 80,
      query_coverage: 1,
      alignment_length: 100,
      subject_length: 100,
    }],
    structure_hits: [],
    uniprot_annotations: [annotation("D1", "active alt-ID donor", 9606, [
      go("GO:1234567", "legacy binding name", "molecular_function", "IDA", "alt-id"),
    ])],
    candidate_sources: {
      providers: [],
      go_candidates: [remoteCandidate({ go_id: "GO:1234567", mapping_id: "interproscan:IPR000001:GO:1234567" })],
    },
    evidence_ids: ["SEQ-ALT-DONOR", "ANN-UP-D1", "CAND-IPR-001"],
  };
  const result = inferGoPredictions({
    proteinId: "ANON_ACTIVE_ALT_ID",
    bundle,
    genome,
    queryTaxonId: 9606,
    ontology: ontologyGateFixture(),
  });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.decision, "transfer_hypothesis");
  assert.equal(binding?.termName, "binding", "the active ontology name replaces stale provider labels");
  assert.equal(binding?.donorSupports.some((support) => support.candidateSourceType === "interpro"), true);
  assert.equal(binding?.donorSupports.some((support) => support.accession === "D1"), true);
  assert.deepEqual(binding?.sourceGoIds, ["GO:0005488"]);
  assert.equal(result.terms.some((term) => term.goId === "GO:1234567"), false);
  assert.deepEqual(result.predictedGoIds, ["GO:0005488"]);
  assert.deepEqual(result.ontologyQuarantinedGoIds, []);
});

test("storage-light domain mapping creates a new MF candidate while correlated signatures count once", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.ontologyPolicy = { mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"] };
  genome.genomeHash = hashCanonical(genome.genome);
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    candidate_sources: {
      providers: [{ provider: "InterProScan", status: "completed", endpoint_or_path: "https://example", release: "99.0", request_sha256: "d".repeat(64), payload_sha256: "c".repeat(64), cache_hit: false, reason: null }],
      go_candidates: [
        remoteCandidate(),
        remoteCandidate({ source_type: "pfam", source_id: "PF00001", mapping_id: "interproscan:PF00001:GO:0005488", evidence_id: "CAND-PFAM-001", base_score: 0.7 }),
      ],
    },
    evidence_ids: ["CAND-IPR-001", "CAND-PFAM-001"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_CANDIDATE", bundle, genome, queryTaxonId: 9606 });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.candidateOrigin, "direct_candidate_source");
  assert.equal(binding?.decision, "transfer_hypothesis");
  assert.equal(binding?.phylogenyAdjustedScore, 0.252, "one correlated query domain contributes once after the bounded candidate-weight floor");
  assert.equal(binding?.donorSupports.every((support) => support.evidenceWeight === 0.45), true);
  assert.equal(result.candidateSources.appliedCandidateCount, 2);
});

test("candidate support below the GO-term threshold remains a hard blocker even when structure aggregation clears it", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genome.goPolicy.thresholds.biological_process = 0.3;
  genome.genomeHash = hashCanonical(genome.genome);
  const candidate = remoteCandidate({
    go_id: "GO:0008152",
    term_name: "metabolic process",
    aspect: "biological_process",
    mapping_id: "interproscan:IPR000001:GO:0008152",
    base_score: 0.5,
  });
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [{
      evidence_id: "STR-BP-CANDIDATE-THRESHOLD",
      reference_database: "swissprot",
      scope: "full_length",
      accession: "D1",
      probability: 1,
      query_tm_score: 0.8,
      query_coverage: 1,
      target_coverage: 1,
    }],
    uniprot_annotations: [annotation("D1", "structure-only BP donor", 9606, [
      go("GO:0008152", "metabolic process", "biological_process", "IDA", "structure-root-1"),
    ])],
    candidate_sources: {
      providers: [{
        provider: "InterProScan",
        status: "completed",
        endpoint_or_path: "https://example",
        release: "99.0",
        request_sha256: "d".repeat(64),
        payload_sha256: "c".repeat(64),
        cache_hit: false,
        reason: null,
      }],
      go_candidates: [candidate],
    },
    evidence_ids: ["STR-BP-CANDIDATE-THRESHOLD", "ANN-UP-D1", "CAND-IPR-001"],
  };
  const result = inferGoPredictions({
    proteinId: "ANON_CANDIDATE_TERM_THRESHOLD",
    bundle,
    genome,
    queryTaxonId: 9606,
  });
  const term = result.terms.find((item) => item.goId === "GO:0008152");
  assert.ok((term?.phylogenyAdjustedScore ?? 0) >= 0.3, "mixed aggregate clears the GO threshold");
  assert.equal(term?.decision, "abstained");
  assert.ok(term?.selectionBlockers?.includes("candidate_term_threshold"));
  assert.ok(term?.reasons.some((reason) => reason.includes("No selection-eligible candidate support clears")));
});

test("hash-bound learned sequence candidates use their own gate and one model provenance root", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["mdeepfri_cnn"],
    allowedAspects: ["molecular_function", "biological_process", "cellular_component"],
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const learned = remoteCandidate({
    source_type: "mdeepfri_cnn",
    source_id: "mdeepfri_cnn:modelhash",
    mapping_id: "mdeepfri_cnn:GO:0005488",
    provider: "mDeepFRI",
    provider_release: "mdeepfri@1.1.10",
    evidence_id: "CAND-MDF-001",
    provenance_root: `mdeepfri:${"d".repeat(64)}`,
    base_score: 0.3,
    query_coverage: null,
    domain_range: null,
    annotation_evidence_code: "MODEL",
  });
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 }, sequence_hits: [], structure_hits: [], uniprot_annotations: [],
    candidate_sources: {
      providers: [{
        provider: "mDeepFRI", status: "completed", endpoint_or_path: "local:model-bound:deadbeef",
        release: "mdeepfri@1.1.10", request_sha256: "a".repeat(64), payload_sha256: "c".repeat(64),
        cache_hit: false, reason: null,
      }],
      go_candidates: [learned],
    },
    evidence_ids: ["CAND-MDF-001"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_LEARNED", bundle, genome, queryTaxonId: 9606 });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.decision, "transfer_hypothesis");
  assert.equal(binding?.donorSupports[0]?.matchMode, "learned_sequence");
  assert.equal(binding?.donorSupports[0]?.evidenceWeight, 1);
  assert.deepEqual(binding?.donorSupports[0]?.provenanceRoots, [`mdeepfri:${"d".repeat(64)}`]);
  assert.equal(result.candidateSources.sourceStats?.find((item) => item.sourceType === "mdeepfri_cnn")?.selectedTerms, 1);

  genome.genome.goPolicy.learnedPredictorPolicy.minimumScore = 0.4;
  genome.genomeHash = hashCanonical(genome.genome);
  const belowFloor = inferGoPredictions({ proteinId: "ANON_LEARNED", bundle, genome, queryTaxonId: 9606 });
  assert.equal(belowFloor.terms.find((term) => term.goId === "GO:0005488")?.decision, "abstained");
  assert.equal(belowFloor.candidateSources.selectionEligibleCandidateCount, 0);

  const directOnly = inferGoPredictions({
    proteinId: "ANON_LEARNED_MIXED", bundle: fixture(), genome, queryTaxonId: 9606,
  });
  const mixedBundle = fixture();
  const belowFloorMixed = remoteCandidate({
    go_id: "GO:0005085",
    term_name: "guanyl-nucleotide exchange factor activity",
    source_type: "mdeepfri_cnn",
    source_id: "mdeepfri_cnn:modelhash",
    mapping_id: "mdeepfri_cnn:GO:0005085",
    provider: "mDeepFRI",
    provider_release: "onnxruntime@1.16.3",
    evidence_id: "CAND-MDF-BELOW-MIXED",
    provenance_root: `mdeepfri:${"e".repeat(64)}`,
    base_score: 0.3,
    query_coverage: null,
    domain_range: null,
    annotation_evidence_code: "MODEL",
  });
  mixedBundle.candidate_sources = {
    providers: [{
      provider: "mDeepFRI", status: "completed", endpoint_or_path: "local:model-bound:deadbeef",
      release: "onnxruntime@1.16.3", request_sha256: "a".repeat(64), payload_sha256: "c".repeat(64),
      cache_hit: false, reason: null,
    }],
    go_candidates: [belowFloorMixed],
  };
  (mixedBundle.evidence_ids as string[]).push("CAND-MDF-BELOW-MIXED");
  const mixed = inferGoPredictions({
    proteinId: "ANON_LEARNED_MIXED", bundle: mixedBundle, genome, queryTaxonId: 9606,
  });
  const directTerm = directOnly.terms.find((term) => term.goId === "GO:0005085");
  const mixedTerm = mixed.terms.find((term) => term.goId === "GO:0005085");
  const retainedAuditSupport = mixedTerm?.donorSupports.find(
    (support) => support.candidateSourceType === "mdeepfri_cnn",
  );
  assert.equal(retainedAuditSupport?.candidateSelectionEligible, false);
  assert.equal(retainedAuditSupport?.rawSupport, 0);
  assert.equal(retainedAuditSupport?.adjustedSupport, 0);
  assert.equal(mixedTerm?.rawScore, directTerm?.rawScore);
  assert.equal(mixedTerm?.phylogenyAdjustedScore, directTerm?.phylogenyAdjustedScore);
  assert.equal(mixedTerm?.selected, directTerm?.selected);
  assert.equal(mixedTerm?.decision, directTerm?.decision);
  assert.deepEqual(mixed.predictedGoIds, directOnly.predictedGoIds);
  assert.deepEqual(mixed.goJudgeStatus, directOnly.goJudgeStatus);
  assert.equal(buildGOJudgeBinding(mixed), undefined);
  assert.equal(
    mixed.candidateSources.sourceStats?.find((item) => item.sourceType === "mdeepfri_cnn")?.selectedTerms,
    0,
  );
});

test("hash-bound structure GCN candidates remain a distinct learned-structure channel", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["mdeepfri_gcn"],
    allowedAspects: ["molecular_function"],
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const root = `mdeepfri-gcn:${"d".repeat(64)}`;
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 }, sequence_hits: [], structure_hits: [], uniprot_annotations: [],
    candidate_sources: {
      providers: [{
        provider: "mDeepFRI", status: "completed", endpoint_or_path: "local:model-bound:deadbeef",
        release: "onnxruntime@1.16.3", request_sha256: "a".repeat(64), payload_sha256: "c".repeat(64),
        cache_hit: false, reason: null,
      }],
      go_candidates: [remoteCandidate({
        source_type: "mdeepfri_gcn",
        source_id: "mdeepfri_gcn:modelhash",
        mapping_id: "mdeepfri_gcn:GO:0005488",
        provider: "mDeepFRI",
        provider_release: "onnxruntime@1.16.3",
        evidence_id: "CAND-MDG-001",
        provenance_root: root,
        base_score: 0.3,
        query_coverage: null,
        domain_range: null,
        annotation_evidence_code: "MODEL",
      })],
    },
    evidence_ids: ["CAND-MDG-001"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_GCN", bundle, genome, queryTaxonId: 9606 });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.decision, "transfer_hypothesis");
  assert.equal(binding?.donorSupports[0]?.matchMode, "learned_structure");
  assert.equal(binding?.donorSupports[0]?.candidateSourceType, "mdeepfri_gcn");
  assert.deepEqual(binding?.donorSupports[0]?.provenanceRoots, [root]);
  assert.equal(result.candidateSources.sourceStats?.find((item) => item.sourceType === "mdeepfri_gcn")?.selectedTerms, 1);
  assert.equal(result.candidateSources.sourceStats?.find((item) => item.sourceType === "mdeepfri_cnn")?.normalized, 0);
});

test("DeepGOPlus CNN candidates use the learned score scale without homology double counting", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_cnn"],
    allowedAspects: ["molecular_function"],
    minimumScore: 0.2,
    scoreScale: 0.5,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const root = `deepgoplus-cnn:${"d".repeat(64)}`;
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 }, sequence_hits: [], structure_hits: [], uniprot_annotations: [],
    candidate_sources: {
      providers: [{
        provider: "DeepGOPlus", status: "completed", endpoint_or_path: "local:model-bound:deadbeef",
        release: "1.0.2;data-1.0.28", request_sha256: "a".repeat(64), payload_sha256: "c".repeat(64),
        cache_hit: false, reason: null,
      }],
      go_candidates: [remoteCandidate({
        source_type: "deepgoplus_cnn",
        source_id: "deepgoplus_cnn:modelhash",
        mapping_id: "deepgoplus_cnn:GO:0005488",
        provider: "DeepGOPlus",
        provider_release: "1.0.2;data-1.0.28",
        evidence_id: "CAND-DGP-001",
        provenance_root: root,
        base_score: 0.6,
        query_coverage: null,
        domain_range: null,
        annotation_evidence_code: "MODEL",
      })],
    },
    evidence_ids: ["CAND-DGP-001"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_DEEPGOPLUS", bundle, genome, queryTaxonId: 9606 });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.decision, "transfer_hypothesis");
  assert.equal(binding?.phylogenyAdjustedScore, 0.21, "one learned provenance root retains the host 0.7 fusion factor");
  assert.equal(binding?.donorSupports[0]?.evidenceWeight, 0.5);
  assert.equal(binding?.donorSupports[0]?.matchMode, "learned_sequence");
  assert.equal(binding?.donorSupports[0]?.sourceProvider, "DeepGOPlus");
  assert.deepEqual(binding?.donorSupports[0]?.provenanceRoots, [root]);
  assert.equal(result.candidateSources.sourceStats?.find(
    (item) => item.sourceType === "deepgoplus_cnn",
  )?.selectedTerms, 1);
});

test("DeepGOPlus hybrid is max-combined as one correlated prior and receives only host-safe closure", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_hybrid"],
    allowedAspects: ["molecular_function"],
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "ancestor_closure",
    maxDepth: 8,
    scoreDecay: 0.5,
    excludeRoots: true,
    relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const ontology = parseGoBasicObo(`format-version: 1.2
data-version: releases/hybrid-test

[Term]
id: GO:0003674
name: molecular_function
namespace: molecular_function

[Term]
id: GO:0005488
name: binding
namespace: molecular_function
is_a: GO:0003674

[Term]
id: GO:0005085
name: guanyl-nucleotide exchange factor activity
namespace: molecular_function
is_a: GO:0005488
`);
  const root = `deepgoplus-hybrid:${"d".repeat(64)}`;
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [{
      evidence_id: "SEQ-HYBRID-CORRELATED",
      accession: "D1",
      percent_identity: 80,
      query_coverage: 1,
      alignment_length: 100,
      subject_length: 100,
      score: 0.8,
    }],
    structure_hits: [],
    uniprot_annotations: [annotation("D1", "host homology donor", 9606, [
      go("GO:0005085", "guanyl-nucleotide exchange factor activity", "molecular_function", "IDA", "111"),
    ])],
    candidate_sources: {
      providers: [{
        provider: "DeepGOPlus",
        status: "completed",
        endpoint_or_path: "local:hybrid-bound:deadbeef",
        release: "1.0.2;data-1.0.28",
        request_sha256: "a".repeat(64),
        payload_sha256: "c".repeat(64),
        cache_hit: false,
        reason: null,
      }],
      go_candidates: [remoteCandidate({
        go_id: "GO:0005085",
        term_name: "guanyl-nucleotide exchange factor activity",
        source_type: "deepgoplus_hybrid",
        source_id: "deepgoplus_hybrid:methodhash",
        mapping_id: "deepgoplus_hybrid:GO:0005085",
        provider: "DeepGOPlus",
        provider_release: "1.0.2;data-1.0.28",
        evidence_id: "CAND-DGPH-001",
        provenance_root: root,
        base_score: 0.6,
        query_coverage: null,
        domain_range: null,
        annotation_evidence_code: "MODEL_HOMOLOGY",
      })],
    },
    evidence_ids: ["SEQ-HYBRID-CORRELATED", "ANN-UP-D1", "CAND-DGPH-001"],
  };
  const result = inferGoPredictions({
    proteinId: "ANON_DEEPGOPLUS_HYBRID",
    bundle,
    genome,
    queryTaxonId: 9606,
    ontology,
  });
  const child = result.terms.find((term) => term.goId === "GO:0005085");
  assert.equal(
    child?.phylogenyAdjustedScore,
    0.6,
    "host-only one-component score is 0.56; correlated hybrid uses max(0.56, 0.60), not an added 0.2 vote",
  );
  const parent = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(
    parent?.donorSupports.some(
      (support) => support.candidateSourceType === "deepgoplus_hybrid",
    ),
    true,
    "the adapter exposes direct agent-safe scores, so the host derives the pinned safe closure",
  );
  assert.equal(parent?.phylogenyAdjustedScore, 0.3);
  const namespaceRoot = result.terms.find((term) => term.goId === "GO:0003674");
  assert.equal(
    namespaceRoot?.donorSupports.some(
      (support) => support.candidateSourceType === "deepgoplus_hybrid",
    ) ?? false,
    false,
    "hybrid closure excludes namespace roots even when the general ontology policy permits roots",
  );
  assert.match(result.methodSummary, /correlation-aware prior/);
  assert.match(result.methodSummary, /safe is_a\/part_of closure/);
});

test("DeepGOPlus hybrid namespace roots are rejected even without an ontology snapshot", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_hybrid"],
    allowedAspects: ["molecular_function", "biological_process", "cellular_component"],
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const roots = [
    ["GO:0003674", "molecular_function"],
    ["GO:0008150", "biological_process"],
    ["GO:0005575", "cellular_component"],
  ] as const;
  const candidates = roots.map(([goId, aspect], index) => remoteCandidate({
    go_id: goId,
    term_name: `${aspect} root`,
    aspect,
    source_type: "deepgoplus_hybrid",
    source_id: "deepgoplus_hybrid:methodhash",
    mapping_id: `deepgoplus_hybrid:${goId}`,
    provider: "DeepGOPlus",
    provider_release: "1.0.2;data-1.0.28",
    evidence_id: `CAND-DGPH-ROOT-${index + 1}`,
    provenance_root: `deepgoplus-hybrid:${"d".repeat(64)}`,
    base_score: 0.99,
    query_coverage: null,
    domain_range: null,
    annotation_evidence_code: "MODEL_HOMOLOGY",
  }));
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    candidate_sources: { providers: [], go_candidates: candidates },
    evidence_ids: candidates.map((candidate) => candidate.evidence_id),
  };
  const result = inferGoPredictions({
    proteinId: "ANON_DEEPGOPLUS_ROOTS",
    bundle,
    genome,
    queryTaxonId: 9606,
  });
  assert.deepEqual(result.terms, []);
  assert.deepEqual(result.predictedGoIds, []);
  assert.equal(
    result.candidateSources.sourceStats?.find(
      (item) => item.sourceType === "deepgoplus_hybrid",
    )?.normalized,
    3,
  );
  assert.equal(result.candidateSources.appliedCandidateCount, 0);
});

test("DeepGOPlus hybrid cannot manufacture a second ordinary structure donor group", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_hybrid"],
    allowedAspects: ["molecular_function"],
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genome.goPolicy.thresholds.molecular_function = 0.3;
  genome.genome.goPolicy.minimumDonorGroupSupport = 0.18;
  genome.genome.goPolicy.minimumIndependentProvenanceRoots = 2;
  genome.genome.goPolicy.requireTwoStructureDonorGroups = true;
  genome.genomeHash = hashCanonical(genome.genome);
  const hybrid = remoteCandidate({
    go_id: "GO:0005488",
    term_name: "binding",
    source_type: "deepgoplus_hybrid",
    source_id: "deepgoplus_hybrid:methodhash",
    mapping_id: "deepgoplus_hybrid:GO:0005488",
    provider: "DeepGOPlus",
    provider_release: "1.0.2;data-1.0.28",
    evidence_id: "CAND-DGPH-STRUCTURE-GUARD",
    provenance_root: `deepgoplus-hybrid:${"e".repeat(64)}`,
    base_score: 0.25,
    query_coverage: null,
    domain_range: null,
    annotation_evidence_code: "MODEL_HOMOLOGY",
  });
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [{
      evidence_id: "STR-ONLY-D1",
      reference_database: "swissprot",
      scope: "full_length",
      accession: "D1",
      probability: 1,
      query_tm_score: 0.8,
      query_coverage: 1,
      target_coverage: 1,
    }],
    uniprot_annotations: [annotation("D1", "single structure donor", 9606, [
      go("GO:0005488", "binding", "molecular_function", "IDA", "structure-root-1"),
    ])],
    candidate_sources: { providers: [], go_candidates: [hybrid] },
    evidence_ids: ["STR-ONLY-D1", "ANN-UP-D1", "CAND-DGPH-STRUCTURE-GUARD"],
  };
  const result = inferGoPredictions({
    proteinId: "ANON_DEEPGOPLUS_STRUCTURE_GUARD",
    bundle,
    genome,
    queryTaxonId: 9606,
  });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.phylogenyAdjustedScore, 0.56);
  assert.equal(binding?.decision, "abstained");
  assert.ok(binding?.selectionBlockers?.includes("insufficient_structure_groups"));
  assert.ok(binding?.selectionBlockers?.includes("insufficient_provenance_roots"));
  assert.deepEqual(goPolicyContractIssues(result, genome.genome), []);

  const tampered = structuredClone(result);
  const tamperedBinding = tampered.terms.find((term) => term.goId === "GO:0005488");
  if (tamperedBinding) {
    tamperedBinding.selected = true;
    tamperedBinding.decision = "transfer_hypothesis";
  }
  const issues = goPolicyContractIssues(tampered, genome.genome);
  assert.ok(
    issues.some((issue) => /lacks two material donor groups/.test(issue)),
    issues.join("\n"),
  );
  assert.ok(
    issues.some((issue) => /lacks independent provenance roots/.test(issue)),
    issues.join("\n"),
  );
});

test("identical DeepGOPlus hybrid donor stays eligible and resolves active GO alt IDs", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_hybrid"],
    allowedAspects: ["molecular_function"],
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const candidate = remoteCandidate({
    go_id: "GO:1234567",
    term_name: "legacy binding name",
    source_type: "deepgoplus_hybrid",
    source_id: "deepgoplus_hybrid:methodhash",
    mapping_id: "deepgoplus_hybrid:GO:1234567",
    provider: "DeepGOPlus",
    provider_release: "1.0.2;data-1.0.28",
    evidence_id: "CAND-DGPH-QUERY-LIKE",
    provenance_root: `deepgoplus-hybrid:${"f".repeat(64)}`,
    base_score: 0.9,
    query_coverage: null,
    domain_range: null,
    annotation_evidence_code: "MODEL_HOMOLOGY",
    donor_accession: "SELF.1",
  });
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [{
      evidence_id: "SEQ-SELF-ALIAS",
      accession: "SELF.2",
      percent_identity: 100,
      query_coverage: 1,
      subject_coverage: 1,
      alignment_length: 100,
      subject_length: 100,
    }],
    structure_hits: [],
    uniprot_annotations: [],
    candidate_sources: { providers: [], go_candidates: [candidate] },
    evidence_ids: ["SEQ-SELF-ALIAS", "CAND-DGPH-QUERY-LIKE"],
  };
  const ontology = ontologyGateFixture();
  const result = inferGoPredictions({
    proteinId: "ANON_DEEPGOPLUS_QUERY_LIKE",
    bundle,
    genome,
    queryTaxonId: 9606,
    ontology,
  });
  assert.deepEqual(result.queryLikeAccessions, []);
  assert.deepEqual(result.quarantinedGoIds, []);
  assert.ok(result.terms.some(term => term.goId === "GO:0005488"));
});

test("learned rescue routing stays inactive when donor annotations already cover the aspect", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["mdeepfri_cnn"],
    allowedAspects: ["molecular_function"],
    activationMode: "direct_annotation_gap_only",
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const bundle = fixture();
  bundle.candidate_sources = {
    providers: [{
      provider: "mDeepFRI", status: "completed", endpoint_or_path: "local:model-bound:deadbeef",
      release: "onnxruntime@1.16.3", request_sha256: "a".repeat(64), payload_sha256: "c".repeat(64),
      cache_hit: false, reason: null,
    }],
    go_candidates: [remoteCandidate({
      source_type: "mdeepfri_cnn",
      source_id: "mdeepfri_cnn:modelhash",
      mapping_id: "mdeepfri_cnn:GO:0005488",
      provider: "mDeepFRI",
      provider_release: "onnxruntime@1.16.3",
      evidence_id: "CAND-MDF-GAP-001",
      provenance_root: `mdeepfri:${"d".repeat(64)}`,
      base_score: 0.8,
      query_coverage: null,
      domain_range: null,
      annotation_evidence_code: "MODEL",
    })],
  };
  (bundle.evidence_ids as string[]).push("CAND-MDF-GAP-001");

  const result = inferGoPredictions({ proteinId: "ANON_GAP_ROUTING", bundle, genome, queryTaxonId: 9606 });
  const learnedStats = result.candidateSources.sourceStats?.find((item) => item.sourceType === "mdeepfri_cnn");
  assert.equal(learnedStats?.normalized, 1);
  assert.equal(learnedStats?.admitted, 0);
  assert.equal(result.terms.some((term) => term.donorSupports.some(
    (support) => support.candidateSourceType === "mdeepfri_cnn",
  )), false);
});

test("prediction-gap rescue and learned top-k are host-only deterministic gates", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_cnn"],
    allowedAspects: ["molecular_function"],
    activationMode: "prediction_aspect_gap_only",
    maxCandidatesPerAspect: 1,
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genomeHash = hashCanonical(genome.genome);
  const root = `deepgoplus-cnn:${"f".repeat(64)}`;
  const candidates = [
    remoteCandidate({
      go_id: "GO:0005488",
      term_name: "binding",
      source_type: "deepgoplus_cnn",
      source_id: "deepgoplus_cnn:modelhash",
      mapping_id: "deepgoplus_cnn:GO:0005488",
      provider: "DeepGOPlus",
      provider_release: "1.0.2;data-1.0.28",
      evidence_id: "CAND-DGP-TOP",
      provenance_root: root,
      base_score: 0.8,
      query_coverage: null,
      domain_range: null,
      annotation_evidence_code: "MODEL",
    }),
    remoteCandidate({
      go_id: "GO:0005085",
      term_name: "guanyl-nucleotide exchange factor activity",
      source_type: "deepgoplus_cnn",
      source_id: "deepgoplus_cnn:modelhash",
      mapping_id: "deepgoplus_cnn:GO:0005085",
      provider: "DeepGOPlus",
      provider_release: "1.0.2;data-1.0.28",
      evidence_id: "CAND-DGP-SECOND",
      provenance_root: root,
      base_score: 0.7,
      query_coverage: null,
      domain_range: null,
      annotation_evidence_code: "MODEL",
    }),
  ];
  const learnedOnly: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    candidate_sources: {
      providers: [{
        provider: "DeepGOPlus", status: "completed", endpoint_or_path: "local:model-bound",
        release: "1.0.2;data-1.0.28", request_sha256: "a".repeat(64),
        payload_sha256: "c".repeat(64), cache_hit: false, reason: null,
      }],
      go_candidates: candidates,
    },
    evidence_ids: ["CAND-DGP-TOP", "CAND-DGP-SECOND"],
  };
  const rescue = inferGoPredictions({
    proteinId: "ANON_PREDICTION_GAP", bundle: learnedOnly, genome, queryTaxonId: 9606,
  });
  const learnedStats = rescue.candidateSources.sourceStats?.find(
    (item) => item.sourceType === "deepgoplus_cnn",
  );
  assert.equal(learnedStats?.normalized, 2);
  assert.equal(learnedStats?.admitted, 1);
  assert.equal(rescue.terms.some((term) => term.goId === "GO:0005488"), true);
  assert.equal(rescue.terms.some((term) => term.goId === "GO:0005085"), false);
  assert.match(rescue.methodSummary, /no positive host-baseline hypothesis/);
  assert.match(rescue.methodSummary, /capped at 1 direct row/);

  const coveredBundle = fixture();
  coveredBundle.candidate_sources = (learnedOnly.candidate_sources as Record<string, unknown>);
  (coveredBundle.evidence_ids as string[]).push("CAND-DGP-TOP", "CAND-DGP-SECOND");
  const covered = inferGoPredictions({
    proteinId: "ANON_PREDICTION_COVERED", bundle: coveredBundle, genome, queryTaxonId: 9606,
  });
  const coveredStats = covered.candidateSources.sourceStats?.find(
    (item) => item.sourceType === "deepgoplus_cnn",
  );
  assert.equal(coveredStats?.normalized, 2);
  assert.equal(coveredStats?.admitted, 0);
  assert.equal(covered.terms.some((term) => term.donorSupports.some(
    (support) => support.candidateSourceType === "deepgoplus_cnn",
  )), false);
});

test("host-term agreement boosts only existing MF hypotheses and leaves BP/CC unchanged", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.candidateSourcePolicy!.mode = "disabled";
  genome.genome.goPolicy.ontologyPolicy = {
    mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"],
  };
  genome.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_hybrid"],
    allowedAspects: ["molecular_function"],
    activationMode: "host_term_agreement_only",
    maxCandidatesPerAspect: 1,
    minimumScore: 0.2,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  genome.genomeHash = hashCanonical(genome.genome);

  const bundle = fixture();
  const root = `deepgoplus-hybrid:${"e".repeat(64)}`;
  bundle.candidate_sources = {
    providers: [{
      provider: "DeepGOPlus", status: "completed", endpoint_or_path: "local:model-bound",
      release: "1.0.2;data-1.0.28", request_sha256: "a".repeat(64),
      payload_sha256: "c".repeat(64), cache_hit: false, reason: null,
    }],
    go_candidates: [
      remoteCandidate({
        go_id: "GO:0005488",
        term_name: "binding",
        source_type: "deepgoplus_hybrid",
        source_id: "deepgoplus_hybrid:modelhash",
        mapping_id: "deepgoplus_hybrid:GO:0005488",
        provider: "DeepGOPlus",
        provider_release: "1.0.2;data-1.0.28",
        evidence_id: "CAND-DGPH-NOVEL",
        provenance_root: root,
        base_score: 0.99,
        query_coverage: null,
        domain_range: null,
        annotation_evidence_code: "MODEL_HOMOLOGY",
      }),
      remoteCandidate({
        go_id: "GO:0005085",
        term_name: "guanyl-nucleotide exchange factor activity",
        source_type: "deepgoplus_hybrid",
        source_id: "deepgoplus_hybrid:modelhash",
        mapping_id: "deepgoplus_hybrid:GO:0005085",
        provider: "DeepGOPlus",
        provider_release: "1.0.2;data-1.0.28",
        evidence_id: "CAND-DGPH-AGREEMENT",
        provenance_root: root,
        base_score: 0.8,
        query_coverage: null,
        domain_range: null,
        annotation_evidence_code: "MODEL_HOMOLOGY",
      }),
    ],
  };
  (bundle.evidence_ids as string[]).push("CAND-DGPH-NOVEL", "CAND-DGPH-AGREEMENT");

  const baselineGenome = structuredClone(genome);
  baselineGenome.genome.goPolicy.learnedPredictorPolicy!.mode = "disabled";
  baselineGenome.genomeHash = hashCanonical(baselineGenome.genome);
  const baseline = inferGoPredictions({
    proteinId: "ANON_HOST_TERM_BASELINE", bundle, genome: baselineGenome, queryTaxonId: 9606,
  });
  const result = inferGoPredictions({
    proteinId: "ANON_HOST_TERM_AGREEMENT", bundle, genome, queryTaxonId: 9606,
  });

  const learnedStats = result.candidateSources.sourceStats?.find(
    (item) => item.sourceType === "deepgoplus_hybrid",
  );
  assert.equal(learnedStats?.normalized, 2);
  assert.equal(learnedStats?.admitted, 1);
  assert.equal(result.terms.some((term) => term.goId === "GO:0005488"), false);
  assert.equal(result.terms.find((term) => term.goId === "GO:0005085")?.donorSupports.some(
    (support) => support.candidateSourceType === "deepgoplus_hybrid",
  ), true);
  const aspectProjection = (prediction: typeof baseline, aspect: "biological_process" | "cellular_component") =>
    prediction.terms
      .filter((term) => term.aspect === aspect)
      .map((term) => ({
        goId: term.goId,
        score: term.judgeAdjustedScore ?? term.phylogenyAdjustedScore,
        decision: term.decision,
        selected: term.selected,
      }));
  assert.deepEqual(
    aspectProjection(result, "biological_process"),
    aspectProjection(baseline, "biological_process"),
  );
  assert.deepEqual(
    aspectProjection(result, "cellular_component"),
    aspectProjection(baseline, "cellular_component"),
  );
  assert.match(result.methodSummary, /only for GO terms already proposed by the positive host-only baseline/);
  assert.match(result.methodSummary, /capped at 1 direct row/);
});

test("candidate-source aspect allowlist keeps broad candidates out of protected aspects", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.ontologyPolicy = { mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"] };
  genome.genome.goPolicy.candidateSourcePolicy!.allowedAspects = ["biological_process", "cellular_component"];
  genome.genomeHash = hashCanonical(genome.genome);
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    candidate_sources: {
      providers: [],
      go_candidates: [
        remoteCandidate(),
        remoteCandidate({
          go_id: "GO:0097194",
          term_name: "execution phase of apoptosis",
          aspect: "biological_process",
          mapping_id: "interproscan:IPR000002:GO:0097194",
          evidence_id: "CAND-IPR-002",
          provenance_root: "query-domain:101-200",
        }),
      ],
    },
    evidence_ids: ["CAND-IPR-001", "CAND-IPR-002"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_ASPECT_FILTER", bundle, genome, queryTaxonId: 9606 });
  assert.equal(result.terms.some((term) => term.goId === "GO:0005488"), false);
  assert.equal(result.terms.find((term) => term.goId === "GO:0097194")?.decision, "transfer_hypothesis");
  assert.equal(result.candidateSources.appliedCandidateCount, 1);
});

test("orthology relation precedes taxonomic proximity and post-duplication paralog leaf transfer abstains", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.ontologyPolicy = { mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"] };
  genome.genomeHash = hashCanonical(genome.genome);
  const phylogeny = {
    provider: "OMA",
    provider_release: "2026-01",
    provider_payload_sha256: "e".repeat(64),
    evidence_id: "ORTH-OMA-001",
    provenance_root: "OMA:HOG:001",
    target_taxon_id: 9606,
    target_lineage: [],
    donor_taxon_id: 10090,
    donor_lineage: [],
    relation: "post_duplication_paralog",
    evolutionary_distance: 0.1,
    hog_id: "HOG:001",
    query_like: false,
  };
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 },
    sequence_hits: [], structure_hits: [], uniprot_annotations: [],
    candidate_sources: {
      providers: [{ provider: "OMA", status: "completed", endpoint_or_path: "https://example", release: "2026-01", request_sha256: "f".repeat(64), payload_sha256: "e".repeat(64), cache_hit: false, reason: null }],
      go_candidates: [remoteCandidate({
        source_type: "oma_ortholog", source_id: "OMA:DONOR", mapping_id: "oma:DONOR:GO:0005488", provider: "OMA",
        provider_release: "2026-01", provider_payload_sha256: "e".repeat(64), evidence_id: "CAND-OMA-001", provenance_root: "OMA:HOG:001",
        base_score: 0.95, query_coverage: 0.95, annotation_evidence_code: "EXP", donor_accession: "DONOR1", phylogeny,
      })],
    },
    evidence_ids: ["CAND-OMA-001"],
  };
  const paralog = inferGoPredictions({ proteinId: "ANON_ORTH", bundle, genome, queryTaxonId: 9606 });
  const binding = paralog.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.decision, "abstained");
  assert.match(binding?.reasons.join(" ") ?? "", /broad ancestor or abstention/);

  ((bundle.candidate_sources as Record<string, unknown>).go_candidates as Array<Record<string, unknown>>)[0].phylogeny = { ...phylogeny, relation: "one_to_one" };
  const ortholog = inferGoPredictions({ proteinId: "ANON_ORTH", bundle, genome, queryTaxonId: 9606 });
  assert.equal(ortholog.terms.find((term) => term.goId === "GO:0005488")?.decision, "transfer_hypothesis");
});

test("query-like direct candidate is quarantined before GO scoring", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.ontologyPolicy = { mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"] };
  genome.genomeHash = hashCanonical(genome.genome);
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 }, sequence_hits: [], structure_hits: [], uniprot_annotations: [],
    candidate_sources: { providers: [], go_candidates: [remoteCandidate({ query_like: true })] },
    evidence_ids: ["CAND-IPR-001"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_SELF", bundle, genome, queryTaxonId: 9606 });
  assert.deepEqual(result.predictedGoIds, []);
  assert.deepEqual(result.quarantinedGoIds, ["GO:0005488"]);
});

test("a valid below-floor provider hypothesis stays visible in the candidate pool as an abstention", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "storage-light-v07.json"));
  genome.genome.goPolicy.ontologyPolicy = { mode: "disabled", maxDepth: 8, scoreDecay: 1, excludeRoots: true, relations: ["is_a", "part_of"] };
  genome.genome.goPolicy.candidateSourcePolicy!.allowedSources = ["interpro", "pfam", "panther", "ec", "oma_ortholog", "oma_fastmap"];
  genome.genomeHash = hashCanonical(genome.genome);
  const bundle: Record<string, unknown> = {
    protein: { query_taxon_id: 9606 }, sequence_hits: [], structure_hits: [], uniprot_annotations: [],
    candidate_sources: {
      providers: [],
      go_candidates: [
        remoteCandidate({
          source_type: "oma_fastmap",
          source_id: "SAFE00001",
          mapping_id: "oma-fastmap:SAFE00001:GO:0005488",
          provider: "OMA",
          evidence_id: "CAND-OMA-FASTMAP-001",
          provenance_root: "oma-fastmap-donor:SAFE00001",
          base_score: 0.2,
          query_coverage: 0.1,
          donor_accession: "SAFE00001",
        }),
        remoteCandidate({
          source_type: "oma_fastmap",
          source_id: "SAFE00002",
          mapping_id: "oma-fastmap:SAFE00002:GO:0005488",
          provider: "OMA",
          evidence_id: "CAND-OMA-FASTMAP-002",
          provenance_root: "oma-fastmap-donor:SAFE00002",
          base_score: 0.19,
          query_coverage: 0.09,
          donor_accession: "SAFE00002",
        }),
      ],
    },
    evidence_ids: ["CAND-OMA-FASTMAP-001", "CAND-OMA-FASTMAP-002"],
  };
  const result = inferGoPredictions({ proteinId: "ANON_POOL", bundle, genome, queryTaxonId: 9606 });
  const binding = result.terms.find((term) => term.goId === "GO:0005488");
  assert.equal(binding?.decision, "abstained");
  assert.equal(binding?.donorSupports[0]?.candidateSelectionEligible, false);
  assert.equal(binding?.donorSupports[0]?.evidenceWeight, 0.3, "an ineligible IEA candidate is not raised to the configured weight floor");
  assert.match(binding?.reasons.join(" ") ?? "", /remain in the pool/i);
  assert.equal(result.candidateSources.candidateCount, 2);
  assert.equal(result.candidateSources.admittedCandidateCount, 2);
  assert.equal(result.candidateSources.selectionEligibleCandidateCount, 0);
  assert.equal(
    result.candidateSources.sourceStats?.find((item) => item.sourceType === "oma_fastmap")?.novelToDirectPool,
    1,
    "duplicate donor rows for one canonical GO term count as one novel term",
  );
});

test("bounded GO judge leaves direct-only baseline terms outside its scope", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  genome.genome.goPolicy.goJudgePolicy = { mode: "evidence_consistency", maxCandidates: 128 };
  genome.genomeHash = hashCanonical(genome.genome);
  const base = inferGoPredictions({
    proteinId: "ANON_JUDGE",
    bundle: fixture(),
    genome,
    queryTaxonId: 9606,
    goJudgeMode: "disabled",
  });
  const binding = buildGOJudgeBinding(base, 128);
  assert.equal(binding, undefined);

  const judged = inferGoPredictions({ proteinId: "ANON_JUDGE", bundle: fixture(), genome, queryTaxonId: 9606 });
  const baseMf = base.terms.find((term) => term.goId === "GO:0005085")!;
  const judgedMf = judged.terms.find((term) => term.goId === "GO:0005085")!;
  assert.equal(judgedMf.rawScore, baseMf.rawScore);
  assert.equal(judgedMf.phylogenyAdjustedScore, baseMf.phylogenyAdjustedScore);
  assert.equal(judgedMf.agentJudgment, undefined);
  assert.equal(judgedMf.judgeAdjustedScore, undefined);
  assert.equal(judgedMf.selected, baseMf.selected);
  const judgedBp = judged.terms.find((term) => term.goId === "GO:0097194")!;
  assert.deepEqual(judgedBp, base.terms.find((term) => term.goId === "GO:0097194"));
  assert.equal(judged.goJudgeStatus, undefined);
});

test("deterministic replay refuses a genome-bound Pi judge instead of evaluating a surrogate", async () => {
  const genome = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  genome.genome.goPolicy.goJudgePolicy = {
    mode: "evidence_consistency",
    executionMode: "pi",
    maxCandidates: 128,
  };
  genome.genomeHash = hashCanonical(genome.genome);
  assert.throws(() => inferGoPredictions({
    proteinId: "ANON_PI_JUDGE",
    bundle: fixture(),
    genome,
    queryTaxonId: 9606,
  }), /cannot be evaluated by the synchronous deterministic replay path/);
});
