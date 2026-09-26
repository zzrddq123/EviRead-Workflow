import assert from "node:assert/strict";
import test from "node:test";

import {
  attachCandidateSources,
  candidateStageConfigFromEnv,
  collectConfiguredCandidateSources,
  trustedTargetLineageFromEvidence,
} from "./candidate_stage.js";
import type { RemoteFetch } from "./remote_candidate_providers.js";

test("candidate provider configuration is opt-in and fail-closed", () => {
  const disabled = candidateStageConfigFromEnv({});
  assert.equal(disabled.interproMode, "disabled");
  assert.equal(disabled.omaMode, "disabled");
  assert.equal(disabled.omaFastMapMode, "disabled");
  const split = candidateStageConfigFromEnv({ CANDIDATE_PROVIDER_MODE: "remote", OMA_MODE: "disabled" });
  assert.equal(split.interproMode, "remote");
  assert.equal(split.omaMode, "disabled");
  assert.throws(() => candidateStageConfigFromEnv({ CANDIDATE_PROVIDER_MODE: "automatic" }), /disabled, local, or remote/);
  assert.throws(() => candidateStageConfigFromEnv({ OMA_MIN_QUERY_COVERAGE: "1.2" }), /\[0, 1\]/);
});

test("candidate attachment binds direct and phylogeny evidence IDs", () => {
  const output = attachCandidateSources({ evidence_ids: ["SEQ-1"], schema_version: "pi-function-evidence.v3" }, {
    candidate_sources: {
      providers: [],
      go_candidates: [{
        schema_version: "pi-go-candidate.v1",
        go_id: "GO:0005488",
        term_name: "binding",
        aspect: "molecular_function",
        source_type: "oma_ortholog",
        source_id: "HOG:1",
        mapping_id: "fixture",
        provider: "OMA",
        provider_release: "fixture",
        provider_payload_sha256: "a".repeat(64),
        evidence_id: "CAND-1",
        provenance_root: "HOG:1",
        base_score: 0.8,
        query_coverage: 1,
        domain_range: null,
        query_like: false,
        annotation_evidence_code: "IEA",
        donor_accession: "DONOR",
        phylogeny: { evidence_id: "PHY-1" },
      }],
    },
  });
  assert.deepEqual(output.evidence_ids, ["SEQ-1", "CAND-1", "PHY-1"]);
});

test("configured collection emits explicit disabled provider records without network access", async () => {
  const fetch: RemoteFetch = async () => { throw new Error("network must remain disabled"); };
  const result = await collectConfiguredCandidateSources({
    sequence: "ACDEFGHIKLMNPQRSTVWY",
    targetTaxonId: 9606,
    targetLineage: ["cellular organisms", "Eukaryota", "Homo sapiens"],
    excludedAccessions: ["P12345"],
    env: {},
    dependencies: { fetch },
  });
  assert.deepEqual(result.candidate_sources.providers.map((item) => [item.provider, item.status]), [
    ["InterProScan", "disabled"],
    ["OMA", "disabled"],
    ["OMA", "disabled"],
  ]);
  assert.deepEqual(result.candidate_sources.go_candidates, []);
});

test("local DeepGOPlus is not touched unless the active genome requests its source", async () => {
  let runCalls = 0;
  const result = await collectConfiguredCandidateSources({
    sequence: "ACDEFGHIKLMNPQRSTVWY",
    targetTaxonId: null,
    excludedAccessions: [],
    env: {
      DEEPGOPLUS_MODE: "local",
      DEEPGOPLUS_MODEL: "/must/not/be/read/model.h5",
      DEEPGOPLUS_TERMS: "/must/not/be/read/terms.pkl",
      DEEPGOPLUS_ONTOLOGY: "/must/not/be/read/go.obo",
    },
    requestedLearnedSource: null,
    deepGoPlusDependencies: {
      run: async () => {
        runCalls += 1;
        throw new Error("unrequested DeepGOPlus subprocess must not run");
      },
    },
  });
  assert.equal(runCalls, 0);
  assert.equal(
    result.candidate_sources.providers.some((provider) => provider.provider === "DeepGOPlus"),
    false,
  );
});

test("a different learned source cannot accidentally activate local DeepGOPlus", async () => {
  let runCalls = 0;
  await collectConfiguredCandidateSources({
    sequence: "ACDEFGHIKLMNPQRSTVWY",
    targetTaxonId: null,
    excludedAccessions: [],
    env: { DEEPGOPLUS_MODE: "local" },
    requestedLearnedSource: "mdeepfri_cnn",
    deepGoPlusDependencies: {
      run: async () => {
        runCalls += 1;
        throw new Error("mDeepFRI genome must not activate DeepGOPlus");
      },
    },
  });
  assert.equal(runCalls, 0);
});

test("only direct or frozen-consensus target lineage can be forwarded to candidate providers", () => {
  const lineage = ["cellular organisms", "Eukaryota", "Homo sapiens"];
  assert.deepEqual(trustedTargetLineageFromEvidence({
    query_lineage_source: "target_taxonomy_provider",
    query_lineage: lineage,
  }), lineage);
  assert.deepEqual(trustedTargetLineageFromEvidence({
    query_lineage_source: "declared_taxid_lookup",
    query_lineage: lineage,
  }), lineage);
  assert.deepEqual(trustedTargetLineageFromEvidence({
    query_lineage_source: "frozen_donor_consensus",
    query_lineage: lineage,
  }), lineage);
  assert.deepEqual(trustedTargetLineageFromEvidence({
    query_lineage_source: "matched_uniprot_annotation",
    query_lineage: lineage,
  }), []);
});

test("configured collection forwards the trusted target lineage to OMA scope validation", async () => {
  const calls: string[] = [];
  const fetch: RemoteFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/version/")) {
      return new Response(JSON.stringify({ oma_version: "Viruses.Fixture", api_version: "1.11" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("database-scope mismatch must stop before a candidate lookup");
  };
  const result = await collectConfiguredCandidateSources({
    sequence: "ACDEFGHIKLMNPQRSTVWY",
    targetTaxonId: 9606,
    targetLineage: ["cellular organisms", "Eukaryota", "Homo sapiens"],
    excludedAccessions: [],
    env: {
      CANDIDATE_PROVIDER_MODE: "disabled",
      OMA_MODE: "remote",
      OMA_REST_URL: "https://oma.fixture/api",
    },
    dependencies: { fetch },
  });
  assert.equal(result.candidate_sources.providers.find((item) => item.endpoint_or_path === "https://oma.fixture/api")?.status, "unavailable");
  assert.match(result.candidate_sources.providers.find((item) => item.endpoint_or_path === "https://oma.fixture/api")?.reason ?? "", /virus-only.*target lineage/i);
  assert.deepEqual(calls, ["https://oma.fixture/api/version/"]);
});
