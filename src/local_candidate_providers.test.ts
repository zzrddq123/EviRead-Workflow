import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashCanonical } from "./hash.js";
import { runInterProScanLocal, runOmaLocal } from "./local_candidate_providers.js";

test("local OMAmer preserves the manifest-reported donor scope without inventing a query-species gate", async () => {
  let called = false;
  const bundle = await runOmaLocal({
    sequence: "ACDEFGHIK",
    targetLineage: ["Eukaryota", "Viridiplantae"],
    mode: "local",
    env: {
      OMA_LOCAL_PYTHON: "/fixture/python",
      OMA_LOCAL_RUNNER: "/fixture/runner.py",
      OMA_LOCAL_BIN: "/fixture/omamer",
      OMA_LOCAL_DATABASE: "/fixture/LUCA.h5",
      OMA_LOCAL_STORE: "/fixture/oma.sqlite3",
      OMA_LOCAL_MANIFEST: "/fixture/manifest.json",
      GO_ONTOLOGY_OBO: "/fixture/go.obo",
    },
    dependencies: { run: async (_executable, args) => {
      called = true;
      const output = args[args.indexOf("--output") + 1]!;
      await writeFile(output, JSON.stringify({ candidate_sources: {
        providers: [{
          provider: "OMA", status: "completed", endpoint_or_path: "/fixture/LUCA.h5",
          release: "All.Jul2024;scope=LUCA", request_sha256: "a".repeat(64),
          payload_sha256: "b".repeat(64), cache_hit: false, reason: null,
        }],
        go_candidates: [],
      } }));
    } },
  });
  assert.equal(called, true);
  assert.match(bundle.candidate_sources.providers[0]?.release ?? "", /scope=LUCA/);
});

test("local OMAmer runner bundle is attached without a remote fallback", async () => {
  let observedArgs: string[] = [];
  const bundle = await runOmaLocal({
    sequence: "ACDEFGHIK",
    targetLineage: ["Eukaryota", "Metazoa", "Primates"],
    excludedAccessions: ["Q13526"],
    mode: "local",
    env: {
      OMA_LOCAL_PYTHON: "/fixture/python",
      OMA_LOCAL_RUNNER: "/fixture/runner.py",
      OMA_LOCAL_BIN: "/fixture/omamer",
      OMA_LOCAL_DATABASE: "/fixture/Primates.h5",
      OMA_LOCAL_STORE: "/fixture/oma.sqlite3",
      OMA_LOCAL_MANIFEST: "/fixture/manifest.json",
      GO_ONTOLOGY_OBO: "/fixture/go.obo",
    },
    dependencies: {
      run: async (_executable, args) => {
        observedArgs = args;
        const output = args[args.indexOf("--output") + 1]!;
        await writeFile(output, JSON.stringify({ candidate_sources: {
          providers: [{
            provider: "OMA", status: "completed", endpoint_or_path: "/fixture/Primates.h5",
            release: "All.Jul2024", request_sha256: "a".repeat(64), payload_sha256: "b".repeat(64), cache_hit: false, reason: null,
          }],
          go_candidates: [],
        } }));
      },
    },
  });
  assert.equal(bundle.candidate_sources.providers[0]?.status, "completed");
  assert.deepEqual(
    observedArgs.slice(observedArgs.indexOf("--exclude-accession"), observedArgs.indexOf("--exclude-accession") + 2),
    ["--exclude-accession", "Q13526"],
  );
});

test("local OMAmer failures expose only a diagnostic hash", async () => {
  const bundle = await runOmaLocal({
    sequence: "ACDEFGHIK",
    targetLineage: [],
    excludedAccessions: ["PRIVATE_ACCESSION"],
    mode: "local",
    env: {
      OMA_LOCAL_PYTHON: "/fixture/python",
      OMA_LOCAL_RUNNER: "/fixture/runner.py",
      OMA_LOCAL_BIN: "/fixture/omamer",
      OMA_LOCAL_DATABASE: "/fixture/LUCA.h5",
      OMA_LOCAL_STORE: "/fixture/oma.sqlite3",
      OMA_LOCAL_MANIFEST: "/fixture/manifest.json",
      GO_ONTOLOGY_OBO: "/fixture/go.obo",
    },
    dependencies: { run: async () => {
      throw new Error("Command failed: /Users/private/runner --exclude-accession PRIVATE_ACCESSION");
    } },
  });
  const reason = bundle.candidate_sources.providers[0]?.reason ?? "";
  assert.equal(bundle.candidate_sources.providers[0]?.status, "failed");
  assert.match(reason, /diagnostic_sha256=[a-f0-9]{64}/);
  assert.doesNotMatch(reason, /Users|PRIVATE_ACCESSION/);
});

test("local InterProScan requires a ready canonical historical manifest and parses TSV", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-interpro-test-"));
  try {
    const content = {
      schemaVersion: "pi-temporal-interproscan-manifest.v1",
      release: "5.75-106.0",
      status: "ready",
      availableAt: "2025-06-14",
    };
    const manifest = join(root, "manifest.json");
    await writeFile(manifest, JSON.stringify({ ...content, canonicalHash: hashCanonical(content) }));
    const bundle = await runInterProScanLocal({
      sequence: "ACDEFGHIK",
      mode: "local",
      env: {
        INTERPROSCAN_LOCAL_BIN: join(root, "interproscan.sh"),
        INTERPROSCAN_LOCAL_MANIFEST: manifest,
      },
      dependencies: {
        run: async (_executable, args) => {
          const output = args[args.indexOf("-o") + 1]!;
          await writeFile(output, [
            "anonymous_query", "md5", "9", "Pfam", "PF00001", "fixture", "1", "9", "1e-9", "T", "2025-06-14", "IPR000001", "fixture", "GO:0005515", "-",
          ].join("\t"));
        },
      },
    });
    assert.equal(bundle.candidate_sources.providers[0]?.release, "5.75-106.0");
    assert.equal(bundle.candidate_sources.go_candidates[0]?.go_id, "GO:0005515");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
