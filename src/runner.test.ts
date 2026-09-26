import assert from "node:assert/strict";
import test from "node:test";

import { sha256Text } from "./hash.js";
import { validateEvidenceResponse } from "./runner.js";

const sequenceText = ">anonymous_query\nMKTAYIAK\n";

function input(queryTaxonId?: number, returnedTaxonId: number | null = queryTaxonId ?? null, source = queryTaxonId === undefined ? "unavailable" : "cli") {
  return {
    bundle: {
      schema_version: "pi-function-evidence.v3",
      protein: {
        protein_id: "ANON_TEST",
        sequence_input_sha256: sha256Text(sequenceText),
        structure_input_sha256: null,
        structure_available: false,
        query_taxon_id: returnedTaxonId,
        query_taxon_id_source: source,
      },
      evidence_ids: ["INTRINSIC-SEQ-01"],
    },
    manifest: { status: "completed" },
    proteinId: "ANON_TEST",
    queryTaxonId,
    sequenceText,
  };
}

test("evidence response preserves explicitly unavailable target taxonomy", () => {
  assert.doesNotThrow(() => validateEvidenceResponse(input()));
  assert.throws(
    () => validateEvidenceResponse(input(undefined, 9606, "matched_hit")),
    /inferred a query taxon although none was declared/,
  );
});

test("evidence response binds a provided anonymous TaxID to caller provenance", () => {
  assert.doesNotThrow(() => validateEvidenceResponse(input(9606)));
  assert.throws(
    () => validateEvidenceResponse(input(9606, 10090, "cli")),
    /does not match the requested taxon/,
  );
  assert.throws(
    () => validateEvidenceResponse(input(9606, 9606, "matched_hit")),
    /did not preserve caller-provided query taxon provenance/,
  );
});
