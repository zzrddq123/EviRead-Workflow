import assert from "node:assert/strict";
import test from "node:test";

import { fuseCandidateScores, normalizeCandidateSourceBundle, parseGOAssociationMapping } from "./candidate_sources.js";

const HASH = "a".repeat(64);

test("GO association mapping parser accepts official comment-oriented formats", () => {
  const interpro = parseGOAssociationMapping(`!date: 2026-01-01\nInterPro:IPR000001 Kringle > GO:binding ; GO:0005488\n`, "InterPro");
  const pfam = parseGOAssociationMapping(`Pfam:PF00001 7tm_1 > GO:G protein-coupled receptor activity ; GO:0004930\n`, "Pfam");
  const ec = parseGOAssociationMapping(`EC:1.1.1.- > GO:oxidoreductase activity ; GO:0016491\n`, "EC");
  assert.deepEqual(interpro.map((item) => [item.sourceId, item.goId]), [["IPR000001", "GO:0005488"]]);
  assert.equal(pfam[0]?.sourceId, "PF00001");
  assert.equal(ec[0]?.sourceId, "1.1.1.-");
});

test("candidate bundle is deterministic, validates provenance, and deduplicates exact mapping roots", () => {
  const candidate = {
    go_id: "GO:0005488",
    term_name: "binding",
    aspect: "MF",
    source_type: "interpro",
    source_id: "IPR000001",
    mapping_id: "interpro2go:IPR000001:GO:0005488",
    provider: "InterProScan",
    provider_release: "99.0",
    provider_payload_sha256: HASH,
    evidence_id: "CAND-IPR-001",
    provenance_root: "query-domain:1-100",
    base_score: 0.8,
    query_coverage: 0.5,
    domain_range: "1-100",
    query_like: false,
    annotation_evidence_code: "IEA",
    donor_accession: null,
    phylogeny: null,
  };
  const bundle = normalizeCandidateSourceBundle({
    candidate_sources: {
      providers: [{ provider: "InterProScan", status: "completed", endpoint_or_path: "https://example", release: "99.0", request_sha256: HASH, payload_sha256: HASH, cache_hit: false, reason: null }],
      go_candidates: [candidate, { ...candidate }, { ...candidate, go_id: "bad" }],
    },
  });
  assert.equal(bundle.candidates.length, 1);
  assert.equal(bundle.candidates[0]?.aspect, "molecular_function");
  assert.equal(bundle.canonicalHash.length, 64);
});

test("correlated InterPro and Pfam mappings from one domain count once", () => {
  const base = {
    schemaVersion: "pi-go-candidate.v1" as const,
    goId: "GO:0005488",
    termName: "binding",
    aspect: "molecular_function" as const,
    sourceType: "interpro" as const,
    sourceId: "IPR000001",
    mappingId: "map-1",
    provider: "InterProScan" as const,
    providerRelease: "99.0",
    providerPayloadSha256: HASH,
    evidenceId: "E1",
    provenanceRoot: "query-domain:1-100",
    baseScore: 0.8,
    queryCoverage: 0.5,
    domainRange: "1-100",
    queryLike: false,
    annotationEvidenceCode: "IEA",
    donorAccession: null,
    phylogeny: null,
  };
  assert.equal(fuseCandidateScores([base, { ...base, sourceType: "pfam", sourceId: "PF00001", mappingId: "map-2", evidenceId: "E2", baseScore: 0.7 }]), 0.56);
  assert.equal(fuseCandidateScores([base, { ...base, provenanceRoot: "query-domain:150-220", evidenceId: "E3", baseScore: 0.7 }]), 0.7);
});
