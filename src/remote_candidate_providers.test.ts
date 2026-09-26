import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCandidateSourceBundle } from "./candidate_sources.js";
import {
  MemoryRemoteCandidateCache,
  collectRemoteCandidateSources,
  parseExternal2Go,
  parseInterProScanTsv,
  runInterProScanRemote,
  runOmaFastMapRemote,
  runOmaRemote,
  type RemoteFetch,
} from "./remote_candidate_providers.js";

const SEQUENCE = "ACDEFGHIKLMNPQRSTVWY";

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("official external2go tables expand an InterPro signature without target identity", () => {
  const mappings = parseExternal2Go([
    "!version date: fixture",
    "InterPro:IPR000001 Fixture integrated entry > GO:DNA binding ; GO:0003677",
    "Pfam:PF00001 Fixture family > GO:signaling ; GO:0023052",
  ].join("\n"));
  const tsv = [
    "ANON", "md5", String(SEQUENCE.length), "Pfam", "PF00001", "Fixture domain",
    "2", "18", "1e-20", "T", "18-07-2026", "IPR000001", "Fixture integrated entry", "-", "-",
  ].join("\t");
  const candidates = parseInterProScanTsv(tsv, {
    queryLength: SEQUENCE.length,
    release: "fixture+external2go",
    payloadSha256: "a".repeat(64),
    externalMappings: mappings,
  });
  assert.deepEqual(candidates.map((item) => [item.source_type, item.source_id, item.go_id]), [
    ["interpro", "IPR000001", "GO:0003677"],
    ["pfam", "PF00001", "GO:0023052"],
  ]);
  assert.equal(candidates.every((item) => item.mapping_id.startsWith("external2go:")), true);
});

test("InterProScan submits, polls within budget, parses direct GO mappings, and replays cache", async () => {
  const cache = new MemoryRemoteCandidateCache();
  const calls: string[] = [];
  let statusPolls = 0;
  const tsv = [
    "EMBOSS_001",
    "md5",
    String(SEQUENCE.length),
    "Pfam",
    "PF00001",
    "Fixture domain",
    "2",
    "18",
    "1e-20",
    "T",
    "18-07-2026",
    "IPR000001",
    "Fixture integrated entry",
    "Molecular Function: binding (GO:0005488)|Biological Process: signaling (GO:0023052)",
    "-",
  ].join("\t");
  const fetch: RemoteFetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/run")) {
      assert.equal(init?.method, "POST");
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("goterms"), "true");
      assert.equal(body.get("sequence"), SEQUENCE);
      assert.equal(body.get("appl"), "Gene3d,Panther,PfamA");
      return new Response("job-1");
    }
    if (url.endsWith("/status/job-1")) {
      statusPolls += 1;
      return new Response(statusPolls === 1 ? "RUNNING" : "FINISHED");
    }
    if (url.endsWith("/result/job-1/tsv")) return new Response(`${tsv}\n`);
    throw new Error("unexpected fixture URL");
  };
  const config = {
    mode: "remote" as const,
    email: "fixture@example.org",
    baseUrl: "https://interpro.fixture/rest/iprscan5",
    pollIntervalMs: 0,
    maxPolls: 3,
    releaseLabel: "fixture-99",
  };
  const first = await runInterProScanRemote({ sequence: SEQUENCE }, config, { fetch, cache, sleep: async () => undefined });
  const normalized = normalizeCandidateSourceBundle(first as unknown as Record<string, unknown>);
  assert.equal(normalized.providers[0]?.status, "completed");
  assert.equal(normalized.providers[0]?.cacheHit, false);
  assert.equal(normalized.providers[0]?.payloadSha256?.length, 64);
  assert.deepEqual(normalized.candidates.map((item) => [item.goId, item.aspect]), [
    ["GO:0005488", "molecular_function"],
    ["GO:0023052", "biological_process"],
  ]);
  assert.equal(normalized.candidates[0]?.sourceType, "pfam");
  assert.equal(normalized.candidates[0]?.domainRange, "2-18");

  const replay = await runInterProScanRemote({ sequence: SEQUENCE }, config, {
    cache,
    fetch: async () => { throw new Error("cache replay must not access the network"); },
  });
  assert.equal(replay.candidate_sources.providers[0]?.cache_hit, true);
  assert.deepEqual(replay.candidate_sources.go_candidates, first.candidate_sources.go_candidates);
  assert.equal(calls.length, 4);
});

test("InterProScan reports bounded poll exhaustion as unavailable and a terminal provider error as failed", async () => {
  const running: RemoteFetch = async (url) => url.endsWith("/run") ? new Response("job-running") : new Response("RUNNING");
  const unavailable = await runInterProScanRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    email: "fixture@example.org",
    baseUrl: "https://interpro.fixture/rest/iprscan5",
    maxPolls: 2,
    pollIntervalMs: 0,
  }, { fetch: running, sleep: async () => undefined });
  assert.equal(unavailable.candidate_sources.providers[0]?.status, "unavailable");
  assert.match(unavailable.candidate_sources.providers[0]?.reason ?? "", /poll budget/i);

  const failed: RemoteFetch = async (url) => url.endsWith("/run") ? new Response("job-failed") : new Response("ERROR");
  const failure = await runInterProScanRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    email: "fixture@example.org",
    baseUrl: "https://interpro.fixture/rest/iprscan5",
    maxPolls: 1,
    pollIntervalMs: 0,
  }, { fetch: failed });
  assert.equal(failure.candidate_sources.providers[0]?.status, "failed");
  assert.match(failure.candidate_sources.providers[0]?.reason ?? "", /terminal job failure/i);
});

test("OMA rejects a high-identity short local alignment before any ortholog lookup", async () => {
  const calls: string[] = [];
  const fetch: RemoteFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/version/")) return responseJson({ oma_version: "fixture", api_version: "1" });
    if (url.includes("/sequence/?")) {
      return responseJson({
        identified_by: "approximate match",
        targets: [{
          entry_nr: 100,
          omaid: "QUERY00001",
          canonicalid: "QUERY_CANONICAL",
          alignment_score: 99,
          alignment: ["ACDEFG", "ACDEFG"],
        }],
      });
    }
    throw new Error("ortholog endpoint must not be called for a weak local mapping");
  };
  const result = await runOmaRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
    minQueryCoverage: 0.65,
    minIdentity: 0.25,
  }, { fetch });
  assert.equal(result.candidate_sources.providers[0]?.status, "unavailable");
  assert.match(result.candidate_sources.providers[0]?.reason ?? "", /coverage and identity floors/i);
  assert.equal(calls.some((url) => url.includes("/orthologs/")), false);
});

test("virus-only OMA rejects missing or non-viral target lineages before strict candidate lookup", async () => {
  for (const targetLineage of [undefined, ["root", "Eukaryota", "Metazoa"]]) {
    const calls: string[] = [];
    const fetch: RemoteFetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/version/")) return responseJson({ oma_version: "Viruses.Fixture", api_version: "1.11" });
      throw new Error("strict OMA candidate endpoints must remain unopened for a database-scope mismatch");
    };
    const result = await runOmaRemote({ sequence: SEQUENCE, targetLineage }, {
      mode: "remote",
      baseUrl: "https://oma.fixture/api",
    }, { fetch });
    assert.equal(result.candidate_sources.providers[0]?.status, "unavailable");
    assert.match(result.candidate_sources.providers[0]?.reason ?? "", /virus-only.*target lineage/i);
    assert.equal(result.candidate_sources.go_candidates.length, 0);
    assert.deepEqual(calls, ["https://oma.fixture/api/version/"]);
  }
});

test("OMA never reads anchor GO, quarantines exact self records, and retains relation/HOG/taxon metadata", async () => {
  const cache = new MemoryRemoteCandidateCache();
  let persistedPayload = "";
  const inspectedCache = {
    get: (key: string) => cache.get(key),
    set: async (key: string, entry: Parameters<MemoryRemoteCandidateCache["set"]>[1]) => {
      persistedPayload = entry.payload;
      await cache.set(key, entry);
    },
  };
  const calls: string[] = [];
  const anchorMd5 = "638ef73a7502450731f6bfb2c2dd8747";
  const fetch: RemoteFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/version/")) return responseJson({ oma_version: "All.Fixture", api_version: "1.11" });
    if (url.includes("/sequence/?")) {
      return responseJson({
        identified_by: "exact match",
        targets: [{
          entry_nr: 100,
          omaid: "QUERY00001",
          canonicalid: "QUERY_CANONICAL",
          sequence_md5: anchorMd5,
          sequence: SEQUENCE,
          alignment_score: 500,
          protein_name: "must not persist",
          gene_ontology: [{ GO_term: "GO:9999999", name: "target-only label" }],
        }],
      });
    }
    if (url.endsWith("/protein/100/orthologs/")) {
      return responseJson([
        { entry_nr: 100, omaid: "QUERY00001", canonicalid: "QUERY_CANONICAL", sequence_md5: anchorMd5, rel_type: "1:1", score: 999 },
        { entry_nr: 200, omaid: "SPONE00001", canonicalid: "DONOR_ONE", sequence_md5: "different-1", oma_hog_id: "HOG:0001.1a", rel_type: "1:1", distance: 0.2, score: 400 },
        { entry_nr: 300, omaid: "SPTWO00001", canonicalid: "DONOR_TWO", sequence_md5: "different-2", oma_hog_id: "HOG:0001.2b", rel_type: "post-duplication paralog", distance: 1.5, score: 200 },
      ]);
    }
    if (url.endsWith("/protein/200/")) return responseJson({ entry_nr: 200, sequence: "YYYYYYYYYYYYYYYYYYYY" });
    if (url.endsWith("/protein/300/")) return responseJson({ entry_nr: 300, sequence: "WWWWWWWWWWWWWWWWWWWW" });
    if (url.endsWith("/protein/200/gene_ontology/")) {
      return responseJson([{ entry_nr: 200, GO_term: "GO:0005488", name: "binding", aspect: "molecular_function", evidence: "EXP", reference: "PMID:1" }]);
    }
    if (url.endsWith("/protein/300/gene_ontology/")) {
      return responseJson([{ entry_nr: 300, GO_term: "GO:0023052", name: "signaling", aspect: "biological_process", evidence: "IEA", reference: "GO_REF:1" }]);
    }
    if (url.endsWith("/genome/SPONE/")) {
      return responseJson({ code: "SPONE", taxon_id: 11, lineage: ["species one", "clade", "root"] });
    }
    if (url.endsWith("/genome/SPTWO/")) {
      return responseJson({ code: "SPTWO", taxon_id: 22, lineage: ["species two", "clade", "root"] });
    }
    throw new Error(`unexpected fixture URL: ${url.replace(/query=[^&]+/, "query=<redacted>")}`);
  };
  const config = {
    mode: "remote" as const,
    baseUrl: "https://oma.fixture/api",
    minQueryCoverage: 0.9,
    minIdentity: 0.9,
    maxConcurrentRequests: 2,
  };
  const first = await runOmaRemote({ sequence: SEQUENCE, targetTaxonId: 9606, targetLineage: ["root", "eukaryota", "human"] }, config, { fetch, cache: inspectedCache });
  const normalized = normalizeCandidateSourceBundle(first as unknown as Record<string, unknown>);
  assert.equal(normalized.providers[0]?.status, "completed");
  assert.match(normalized.providers[0]?.reason ?? "", /1 query-like ortholog/i);
  assert.equal(calls.some((url) => url.includes("/protein/100/gene_ontology/")), false);
  assert.doesNotMatch(persistedPayload, /GO:9999999|target-only label|must not persist|QUERY_CANONICAL/);
  assert.equal(normalized.candidates.length, 2);
  const oneToOne = normalized.candidates.find((item) => item.goId === "GO:0005488");
  const paralog = normalized.candidates.find((item) => item.goId === "GO:0023052");
  assert.equal(oneToOne?.phylogeny?.relation, "one_to_one");
  assert.equal(oneToOne?.phylogeny?.donorTaxonId, 11);
  assert.deepEqual(oneToOne?.phylogeny?.donorLineage, ["root", "clade", "species one"]);
  assert.equal(oneToOne?.phylogeny?.hogId, "HOG:0001.1a");
  assert.equal(paralog?.phylogeny?.relation, "post_duplication_paralog");
  assert.ok((oneToOne?.baseScore ?? 0) > (paralog?.baseScore ?? 1));

  const replay = await runOmaRemote({ sequence: SEQUENCE, targetTaxonId: 9606, targetLineage: ["root", "eukaryota", "human"] }, config, {
    cache,
    fetch: async () => { throw new Error("cache replay must not access the network"); },
  });
  assert.equal(replay.candidate_sources.providers[0]?.cache_hit, true);
  assert.deepEqual(replay.candidate_sources.go_candidates, first.candidate_sources.go_candidates);
});

test("OMA verifies every donor sequence before GO and fail-closes near-self or unverifiable donors", async () => {
  const query = "A".repeat(100);
  const calls: string[] = [];
  const fetch: RemoteFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/version/")) return responseJson({ oma_version: "All.Fixture", api_version: "1.11" });
    if (url.includes("/sequence/?")) {
      return responseJson({
        identified_by: "exact match",
        targets: [{
          entry_nr: 100,
          omaid: "QUERY00001",
          canonicalid: "QUERY_CANONICAL",
          sequence_md5: "anchor-md5",
          sequence: query,
          alignment_score: 500,
        }],
      });
    }
    if (url.endsWith("/protein/100/orthologs/")) {
      return responseJson([
        { entry_nr: 200, omaid: "NEARX00001", canonicalid: "DIFFERENT_ALIAS", sequence_md5: "near-md5", rel_type: "1:1", score: 500 },
        { entry_nr: 300, omaid: "SAFEX00001", canonicalid: "SAFE_DONOR", sequence_md5: "safe-md5", rel_type: "1:1", score: 400 },
        { entry_nr: 400, omaid: "EMPTY00001", canonicalid: "NO_SEQUENCE", sequence_md5: "empty-md5", rel_type: "1:1", score: 300 },
      ]);
    }
    // The near-self donor differs by one residue (99% identity at full dual
    // coverage) despite having unrelated identifiers and must be quarantined.
    if (url.endsWith("/protein/200/")) return responseJson({ entry_nr: 200, sequence: `${"A".repeat(99)}C` });
    if (url.endsWith("/protein/300/")) return responseJson({ entry_nr: 300, sequence: "C".repeat(100) });
    if (url.endsWith("/protein/400/")) return responseJson({ entry_nr: 400, protein_name: "missing sequence" });
    if (url.endsWith("/protein/300/gene_ontology/")) {
      return responseJson([{ GO_term: "GO:0005488", name: "binding", aspect: "molecular_function", evidence: "EXP" }]);
    }
    if (url.endsWith("/genome/SAFEX/")) return responseJson({ taxon_id: 22, lineage: ["safe species", "root"] });
    if (url.includes("/protein/200/gene_ontology/") || url.includes("/protein/400/gene_ontology/")) {
      throw new Error("GO must never be requested before a donor passes sequence verification");
    }
    throw new Error(`unexpected fixture URL: ${url.replace(/query=[^&]+/, "query=<redacted>")}`);
  };

  const result = await runOmaRemote({ sequence: query, targetTaxonId: 9606 }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
    minQueryCoverage: 0.9,
    minIdentity: 0.9,
    maxConcurrentRequests: 3,
  }, { fetch });
  const normalized = normalizeCandidateSourceBundle(result as unknown as Record<string, unknown>);
  assert.equal(normalized.providers[0]?.status, "completed");
  assert.match(normalized.providers[0]?.reason ?? "", /1 query-like ortholog/i);
  assert.match(normalized.providers[0]?.reason ?? "", /1 donor sequence verification/i);
  assert.deepEqual(normalized.candidates.map((item) => item.donorAccession), ["SAFE_DONOR"]);
  assert.equal(calls.some((url) => url.includes("/protein/200/gene_ontology/")), false);
  assert.equal(calls.some((url) => url.includes("/protein/400/gene_ontology/")), false);
});

test("OMA FastMap emits weak single-donor candidates without pretending its raw score is identity or phylogeny", async () => {
  const calls: string[] = [];
  const fetch: RemoteFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/version/")) return responseJson({ oma_version: "Fixture.FastMap", api_version: "1.11" });
    if (url.includes("/sequence/?")) return responseJson({ identified_by: "approximate match", targets: [] });
    if (url.includes("/function/?")) return responseJson([
      { DB: "OMA_FastMap", GO_ID: "GO:0005488", Evidence: "IEA", With: "Approx:SAFE00001:72.4139", Aspect: "F", GO_name: "binding" },
      { DB: "OMA_FastMap", GO_ID: "GO:0023052", Evidence: "IEA", With: "Approx:SAFE00001:72.4139", Aspect: "P", GO_name: "signaling" },
    ]);
    if (url.endsWith("/protein/SAFE00001/")) {
      return responseJson({ omaid: "SAFE00001", canonicalid: "SAFE_CANONICAL", sequence: "Y".repeat(SEQUENCE.length) });
    }
    throw new Error(`unexpected fixture URL: ${url.replace(/query=[^&]+/, "query=<redacted>")}`);
  };
  const result = await runOmaFastMapRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
  }, { fetch });
  const normalized = normalizeCandidateSourceBundle(result as unknown as Record<string, unknown>);
  assert.equal(normalized.providers[0]?.status, "completed");
  assert.equal(normalized.candidates.length, 2);
  assert.equal(normalized.candidates.every((item) => item.sourceType === "oma_fastmap"), true);
  assert.equal(new Set(normalized.candidates.map((item) => item.provenanceRoot)).size, 1);
  assert.equal(normalized.candidates.every((item) => item.phylogeny === null), true);
  assert.ok((normalized.candidates[0]?.baseScore ?? 0) > 0.35 && (normalized.candidates[0]?.baseScore ?? 1) < 0.45);
  assert.equal(normalized.candidates[0]?.queryCoverage, null);
  assert.equal(calls.some((url) => url.includes("/function/?")), true);
});

test("OMA FastMap quarantines a versioned declared accession through the donor canonical alias", async () => {
  const fetch: RemoteFetch = async (url) => {
    if (url.endsWith("/version/")) return responseJson({ oma_version: "Fixture.FastMap", api_version: "1.11" });
    if (url.includes("/sequence/?")) return responseJson({ identified_by: "approximate match", targets: [] });
    if (url.includes("/function/?")) return responseJson([
      { DB: "OMA_FastMap", GO_ID: "GO:0005488", Evidence: "IEA", With: "Approx:SAFE00001:72.4139", Aspect: "F", GO_name: "binding" },
    ]);
    if (url.endsWith("/protein/SAFE00001/")) {
      return responseJson({ omaid: "SAFE00001", canonicalid: "Q9XYZ1", sequence: "Y".repeat(SEQUENCE.length) });
    }
    throw new Error(`unexpected fixture URL: ${url.replace(/query=[^&]+/, "query=<redacted>")}`);
  };
  const result = await runOmaFastMapRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
    queryLikeAccessions: ["sp|Q9XYZ1.2|QUERY"],
  }, { fetch });

  assert.equal(result.candidate_sources.providers[0]?.status, "unavailable");
  assert.match(result.candidate_sources.providers[0]?.reason ?? "", /donor aliases matched/i);
  assert.deepEqual(result.candidate_sources.go_candidates, []);
});

test("virus-only OMA rejects missing or non-viral target lineages before FastMap candidate lookup", async () => {
  for (const targetLineage of [undefined, ["root", "Eukaryota", "Metazoa"]]) {
    const calls: string[] = [];
    const fetch: RemoteFetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/version/")) return responseJson({ oma_version: "Corona.Fixture", api_version: "1.11" });
      throw new Error("FastMap candidate endpoints must remain unopened for a database-scope mismatch");
    };
    const result = await runOmaFastMapRemote({ sequence: SEQUENCE, targetLineage }, {
      mode: "remote",
      baseUrl: "https://oma.fixture/api",
    }, { fetch });
    assert.equal(result.candidate_sources.providers[0]?.status, "unavailable");
    assert.match(result.candidate_sources.providers[0]?.reason ?? "", /virus-only.*target lineage/i);
    assert.equal(result.candidate_sources.go_candidates.length, 0);
    assert.deepEqual(calls, ["https://oma.fixture/api/version/"]);
  }
});

test("viral target lineages may accept candidates from virus-only strict OMA and FastMap", async () => {
  const targetLineage = ["Viruses", "Riboviria", "Orthornavirae"];
  const strict = await runOmaRemote({ sequence: SEQUENCE, targetLineage }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
    minQueryCoverage: 0.9,
    minIdentity: 0.9,
  }, { fetch: async (url) => {
    if (url.endsWith("/version/")) return responseJson({ oma_version: "Viruses.Fixture", api_version: "1.11" });
    if (url.includes("/sequence/?")) return responseJson({
      identified_by: "exact match",
      targets: [{ entry_nr: 100, omaid: "QUERY00001", sequence: SEQUENCE, alignment: [SEQUENCE, SEQUENCE] }],
    });
    if (url.endsWith("/protein/100/orthologs/")) {
      return responseJson([{ entry_nr: 200, omaid: "VIRUS00001", canonicalid: "VIRAL_DONOR", rel_type: "1:1", score: 400 }]);
    }
    if (url.endsWith("/protein/200/")) return responseJson({ entry_nr: 200, sequence: "Y".repeat(SEQUENCE.length) });
    if (url.endsWith("/protein/200/gene_ontology/")) {
      return responseJson([{ GO_term: "GO:0005488", name: "binding", aspect: "molecular_function", evidence: "EXP" }]);
    }
    if (url.endsWith("/genome/VIRUS/")) return responseJson({ taxon_id: 10239, lineage: ["Viruses"] });
    throw new Error(`unexpected strict viral fixture URL: ${url.replace(/query=[^&]+/, "query=<redacted>")}`);
  } });
  assert.equal(strict.candidate_sources.providers[0]?.status, "completed");
  assert.deepEqual(strict.candidate_sources.go_candidates.map((item) => item.go_id), ["GO:0005488"]);

  const fastMap = await runOmaFastMapRemote({ sequence: SEQUENCE, targetLineage }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
  }, { fetch: async (url) => {
    if (url.endsWith("/version/")) return responseJson({ oma_version: "Corona.Fixture", api_version: "1.11" });
    if (url.includes("/sequence/?")) return responseJson({ identified_by: "approximate match", targets: [] });
    if (url.includes("/function/?")) {
      return responseJson([{ GO_ID: "GO:0023052", With: "Approx:SAFE00001:72.4139", Aspect: "P", GO_name: "signaling" }]);
    }
    if (url.endsWith("/protein/SAFE00001/")) {
      return responseJson({ omaid: "SAFE00001", canonicalid: "SAFE_CANONICAL", sequence: "Y".repeat(SEQUENCE.length) });
    }
    throw new Error(`unexpected FastMap viral fixture URL: ${url.replace(/query=[^&]+/, "query=<redacted>")}`);
  } });
  assert.equal(fastMap.candidate_sources.providers[0]?.status, "completed");
  assert.deepEqual(fastMap.candidate_sources.go_candidates.map((item) => item.go_id), ["GO:0023052"]);
});

test("OMA FastMap preflight quarantines near-exact targets before the GO endpoint", async () => {
  const calls: string[] = [];
  const fetch: RemoteFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/version/")) return responseJson({ oma_version: "Fixture.FastMap", api_version: "1.11" });
    if (url.includes("/sequence/?")) return responseJson({
      identified_by: "exact match",
      targets: [{ entry_nr: 100, omaid: "QUERY00001", sequence: SEQUENCE, alignment: [SEQUENCE, SEQUENCE] }],
    });
    throw new Error("FastMap function endpoint must remain unopened for a target-like sequence");
  };
  const result = await runOmaFastMapRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
  }, { fetch });
  assert.equal(result.candidate_sources.providers[0]?.status, "unavailable");
  assert.match(result.candidate_sources.providers[0]?.reason ?? "", /near-exact full-length target mapping/i);
  assert.equal(calls.some((url) => url.includes("/function/?")), false);
});

test("remote request timeout is explicit and provider collection preserves disabled state", async () => {
  const timeoutFetch: RemoteFetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const timeout = await runOmaRemote({ sequence: SEQUENCE }, {
    mode: "remote",
    baseUrl: "https://oma.fixture/api",
    requestTimeoutMs: 2,
  }, { fetch: timeoutFetch });
  assert.equal(timeout.candidate_sources.providers[0]?.status, "unavailable");
  assert.match(timeout.candidate_sources.providers[0]?.reason ?? "", /timeout/i);

  let calls = 0;
  const disabled = await collectRemoteCandidateSources({
    sequence: { sequence: SEQUENCE },
    interpro: { mode: "disabled" },
    oma: { mode: "disabled" },
    dependencies: { fetch: async () => { calls += 1; return new Response("unexpected"); } },
  });
  assert.equal(calls, 0);
  assert.deepEqual(disabled.candidate_sources.providers.map((item) => [item.provider, item.status]), [
    ["InterProScan", "disabled"],
    ["OMA", "disabled"],
    ["OMA", "disabled"],
  ]);
});
