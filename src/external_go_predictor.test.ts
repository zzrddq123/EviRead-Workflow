import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { withCanonicalHash, writeJson } from "./benchmark_io.js";
import {
  generateExternalGoPredictorOverlay,
  generateExternalGoPredictorGcnOverlay,
  loadExternalGoPredictorOverlay,
  loadExternalGoPredictorGcnOverlay,
  mergeCandidateOverlay,
  mergeGcnCandidateOverlay,
  validateExternalGoPredictorOverlay,
  validateExternalGoPredictorGcnOverlay,
  verifyLockedExternalGoPredictorOverlayReproduction,
  type ExternalGoPredictorGcnRunnerRequest,
  type GenerateExternalGoPredictorGcnOverlayInput,
  type ExternalGoPredictorRunnerRequest,
  type GenerateExternalGoPredictorOverlayInput,
} from "./external_go_predictor.js";
import { hashCanonical, sha256File, sha256Text } from "./hash.js";

const ASPECTS = ["molecular_function", "biological_process", "cellular_component"] as const;

interface FixtureCase {
  caseId: string;
  sequence: string;
  sequenceSha256: string;
  structure?: string;
  structureSha256?: string;
  evidence: Record<string, unknown>;
  episodeTrace: Record<string, unknown>;
}

interface Fixture {
  root: string;
  publicDir: string;
  batchDir: string;
  runnerPath: string;
  modelConfigPath: string;
  modelFiles: GenerateExternalGoPredictorOverlayInput["modelFiles"];
  baseFrozenEvidenceSetHash: string;
  cases: FixtureCase[];
  input: GenerateExternalGoPredictorOverlayInput;
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function validRunnerResult(request: ExternalGoPredictorRunnerRequest): unknown {
  return {
    schemaVersion: "pi-external-go-predictor-run-result.v1",
    exportMinimumScore: request.method.exportMinimumScore,
    // The adapter is allowed to return a different order. The overlay must be
    // projected back into the immutable public-manifest order.
    cases: [...request.cases].reverse().map((item, index) => ({
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      // Deliberately unsorted to exercise deterministic GO-ID normalization.
      predictions: index === 0
        ? [
            { goId: "GO:0000004", termName: "cellular fixture", aspect: "cellular_component", score: 0.75 },
            { goId: "GO:0000002", termName: "binding fixture", aspect: "molecular_function", score: 0.91 },
          ]
        : [
            { goId: "GO:0000003", termName: "process fixture", aspect: "biological_process", score: 0.63 },
            { goId: "GO:0000001", termName: "catalytic fixture", aspect: "molecular_function", score: 0.88 },
          ],
    })),
  };
}

async function makeFixture(withStructures = false): Promise<Fixture> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-external-go-"));
  const publicDir = join(root, "public");
  const batchDir = join(root, "batch");
  const definitions = [
    { caseId: "CASE_001_AAAAAAAA", sequence: "ACDEFGHIK" },
    { caseId: "CASE_002_BBBBBBBB", sequence: "MNPQRSTVWY" },
  ];
  const cases: FixtureCase[] = [];
  const publicCases = [];

  for (const definition of definitions) {
    const fasta = `>anonymous_query\n${definition.sequence}\n`;
    const relativeSequence = `cases/${definition.caseId}/sequence.fasta`;
    const sequencePath = join(publicDir, relativeSequence);
    await writeText(sequencePath, fasta);
    const sequenceSha256 = await sha256File(sequencePath);
    const relativeStructure = `cases/${definition.caseId}/structure.pdb`;
    const structurePath = join(publicDir, relativeStructure);
    let structureSha256: string | undefined;
    if (withStructures) {
      await writeText(structurePath, [
        "REMARK 999 ANONYMOUS TEST STRUCTURE",
        "ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 90.00           C",
        "END",
        "",
      ].join("\n"));
      structureSha256 = await sha256File(structurePath);
    }
    const evidence = {
      schema_version: "pi-function-evidence.v3",
      protein: {
        protein_id: definition.caseId,
        sequence_input_sha256: sequenceSha256,
      },
      candidate_sources: { providers: [], go_candidates: [] },
      evidence_ids: [`BASE-${definition.caseId}`],
    };
    const episodeTrace = {
      schemaVersion: "pi-function-episode.v3",
      outputHashes: { evidenceBundle: hashCanonical(evidence) },
    };
    cases.push({
      ...definition,
      sequenceSha256,
      ...(withStructures ? { structure: relativeStructure, structureSha256 } : {}),
      evidence,
      episodeTrace,
    });
    publicCases.push({
      caseId: definition.caseId,
      sequence: relativeSequence,
      structure: withStructures ? relativeStructure : null,
      sequenceSha256,
      structureSha256: structureSha256 ?? null,
      length: definition.sequence.length,
    });
  }

  const publicManifest = withCanonicalHash({
    schemaVersion: "pi-bioreason-public-suite.v2",
    suiteId: "external-go-fixture",
    seed: "external-go-fixture-seed",
    metric: "aspect_masked_flat_exact_smoke_v2",
    claimBoundary: "Test-only anonymous public inputs.",
    cases: publicCases,
  });
  await writeJson(join(publicDir, "manifest.json"), publicManifest);

  const startedAt = "2026-07-22T00:00:00.000Z";
  const finishedAt = "2026-07-22T00:01:00.000Z";
  const artifactRows = [];
  for (const item of cases) {
    const runDir = join(batchDir, "runs", item.caseId);
    await writeJson(join(runDir, "run_manifest.json"), {
      schemaVersion: "pi-function-run.v3",
      status: "completed",
      runId: `run-${item.caseId}`,
    });
    await writeJson(join(runDir, "evidence_manifest.json"), {
      schemaVersion: "pi-evidence-manifest.v1",
      status: "completed",
    });
    await writeJson(join(runDir, "evidence", "evidence_bundle.json"), item.evidence);
    await writeJson(join(runDir, "evidence", "blind_evidence_bundle.json"), {
      schema_version: "pi-function-evidence.v3",
      protein: { protein_id: item.caseId, sequence_input_sha256: item.sequenceSha256 },
    });
    await writeJson(join(runDir, "prediction", "go_predictions.json"), {
      schemaVersion: "pi-go-predictions.v1",
      predictions: [],
    });
    await writeJson(join(runDir, "prediction", "episode_trace.json"), item.episodeTrace);
    artifactRows.push({
      caseId: item.caseId,
      status: "completed" as const,
      validationOk: true,
      runManifestSha256: await sha256File(join(runDir, "run_manifest.json")),
      evidenceManifestSha256: await sha256File(join(runDir, "evidence_manifest.json")),
      evidenceBundleSha256: await sha256File(join(runDir, "evidence", "evidence_bundle.json")),
      blindEvidenceBundleSha256: await sha256File(join(runDir, "evidence", "blind_evidence_bundle.json")),
      goPredictionSha256: await sha256File(join(runDir, "prediction", "go_predictions.json")),
      remoteProviderCount: 1,
    });
  }

  const acquisitionPlanHash = sha256Text("external-go-acquisition-plan");
  const batchManifest = withCanonicalHash({
    schemaVersion: "pi-bioreason-batch.v2",
    suiteId: publicManifest.suiteId,
    publicManifestHash: publicManifest.canonicalHash,
    privateExclusionsHash: sha256Text("private-exclusions"),
    publicTargetContextHash: null,
    phylogenyMode: "optional",
    genomePath: "genomes/fixture.json",
    genomeHash: sha256Text("genome"),
    narrativeMode: "deterministic",
    identityExclusionPolicy: "trusted_private_accession_v1",
    configLabel: "external-go-fixture",
    configSha256: sha256Text("config"),
    evidenceAcquisitionPlanHash: acquisitionPlanHash,
    evidenceAcquisitionEpochId: "fixture-epoch",
    status: "completed",
    cases: cases.map((item) => ({
      caseId: item.caseId,
      split: "hidden",
      runDir: `runs/${item.caseId}`,
      status: "completed",
      startedAt,
      finishedAt,
      validationOk: true,
    })),
    startedAt,
    finishedAt,
  });
  await writeJson(join(batchDir, "batch_manifest.json"), batchManifest);

  const receipt = withCanonicalHash({
    schemaVersion: "pi-evidence-acquisition-receipt.v2",
    acquisitionPlanHash,
    patchBinding: null,
    batchManifestHash: batchManifest.canonicalHash,
    cacheManifestHash: sha256Text("remote-cache"),
    status: "completed",
    caseCount: artifactRows.length,
    completedCaseCount: artifactRows.length,
    cases: artifactRows,
    startedAt,
    finishedAt,
    claimBoundary: "Test-only receipt fixture.",
  });
  await writeJson(
    join(batchDir, "evaluation", "evaluator_private", "acquisition", "evidence_acquisition_receipt.json"),
    receipt,
  );

  const artifactById = new Map(artifactRows.map((item) => [item.caseId, item]));
  const baseFrozenEvidenceSetHash = hashCanonical({
    schemaVersion: "pi-cafa-frozen-evidence-set.v1",
    sourceBatchManifestHash: batchManifest.canonicalHash,
    receipts: cases.map((item) => ({
      caseId: item.caseId,
      fileSha256: artifactById.get(item.caseId)!.evidenceBundleSha256,
      canonicalHash: hashCanonical(item.evidence),
      episodeTraceHash: hashCanonical(item.episodeTrace),
    })),
  });

  const modelDir = join(root, "models");
  const runnerPath = join(root, "runner", "mdeepfri_predictor.py");
  const modelConfigPath = join(modelDir, "model_config.json");
  await writeText(runnerPath, [
    "import json, sys",
    "request = json.load(sys.stdin)",
    "cases = []",
    "for item in reversed(request['cases']):",
    "    cases.append({'caseId': item['caseId'], 'sequenceSha256': item['sequenceSha256'], 'predictions': [{'goId': 'GO:0000001', 'termName': 'fixture function', 'aspect': 'molecular_function', 'score': 0.5}]})",
    "json.dump({'schemaVersion': 'pi-external-go-predictor-run-result.v1', 'exportMinimumScore': request['method']['exportMinimumScore'], 'cases': cases}, sys.stdout)",
    "",
  ].join("\n"));
  await writeText(modelConfigPath, "{\"version\":\"fixture\"}\n");
  const modelFiles = await Promise.all(ASPECTS.map(async (aspect) => {
    const paramsPath = join(modelDir, `${aspect}.params.json`);
    const onnxPath = join(modelDir, `${aspect}.onnx`);
    await writeText(paramsPath, `{\"aspect\":\"${aspect}\"}\n`);
    await writeText(onnxPath, `fixture-${aspect}-onnx\n`);
    return { aspect, paramsPath, onnxPath };
  }));
  const input: GenerateExternalGoPredictorOverlayInput = {
    publicDir,
    batchDir,
    baseFrozenEvidenceSetHash,
    runnerPath,
    modelConfigPath,
    modelFiles,
    exportMinimumScore: 0.1,
    tool: {
      toolName: "deepfri-cnn-onnx-adapter",
      packageName: "onnxruntime",
      packageVersion: "1.16.3-test",
    },
  };
  return {
    root,
    publicDir,
    batchDir,
    runnerPath,
    modelConfigPath,
    modelFiles,
    baseFrozenEvidenceSetHash,
    cases,
    input,
  };
}

function validGcnRunnerResult(request: ExternalGoPredictorGcnRunnerRequest): unknown {
  return {
    schemaVersion: "pi-external-go-gcn-run-result.v1",
    exportMinimumScore: request.method.exportMinimumScore,
    cases: [...request.cases].reverse().map((item) => ({
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      structureSha256: item.structureSha256,
      predictions: [{
        goId: "GO:0000001",
        termName: "structure fixture function",
        aspect: "molecular_function",
        score: 0.61,
      }],
    })),
  };
}

interface LockedFixture {
  configPath: string;
  predictorId: "mdeepfri-cnn-v1" | "mdeepfri-gcn-v1";
  predictorLockSha256: string;
}

async function makeLockedFixture(
  fixture: Fixture,
  architecture: "cnn" | "gcn",
): Promise<LockedFixture> {
  const predictorId = architecture === "cnn" ? "mdeepfri-cnn-v1" : "mdeepfri-gcn-v1";
  const adapterName = architecture === "cnn"
    ? "deepfri-cnn-onnx-adapter" : "deepfri-gcn-onnx-adapter";
  const runnerRelative = "runner/mdeepfri_predictor.py";
  const requirementsRelative = "bootstrap/mdeepfri-requirements.lock.txt";
  const requirementsPath = join(fixture.root, requirementsRelative);
  await writeText(requirementsPath, "onnxruntime==1.16.3-test --hash=sha256:fixture\n");
  const requirementsSha256 = await sha256File(requirementsPath);
  const modelFileRecords = [];
  for (const item of fixture.modelFiles) {
    for (const [kind, path] of [["model_params", item.paramsPath], ["onnx", item.onnxPath]] as const) {
      modelFileRecords.push({
        aspect: item.aspect,
        kind,
        name: path.split("/").at(-1)!,
        sizeBytes: (await readFile(path)).length,
        sha256: await sha256File(path),
      });
    }
  }
  const lock = {
    schemaVersion: "pi-external-go-predictor-lock.v1",
    predictorId,
    supportedPlatforms: ["test"],
    adapter: {
      name: adapterName,
      sourcePath: runnerRelative,
      runnerSha256: await sha256File(fixture.runnerPath),
      runtimePackage: "onnxruntime",
      runtimeVersion: "1.16.3-test",
      implementation: "test",
    },
    runtime: {
      python: "3.11",
      requirementsPath: requirementsRelative,
      requirementsSha256,
      environmentPath: `.runtime/predictors/${predictorId}`,
      installManifestPath: `.runtime/${predictorId}-install-manifest.json`,
    },
    model: {
      family: "fixture",
      networkType: architecture === "cnn" ? "sequence_cnn" : "structure_gcn",
      ...(architecture === "gcn" ? {
        structureInput: {
          policy: "single_chain_exact_ca_v1",
          contactDistanceAngstrom: 10,
          sequenceStructureIdentity: "exact",
          atomSelection: "CA",
        },
      } : {}),
      config: {
        name: "model_config.json",
        sizeBytes: (await readFile(fixture.modelConfigPath)).length,
        sha256: await sha256File(fixture.modelConfigPath),
      },
      files: modelFileRecords,
    },
    claimBoundary: "Test-only predictor lock.",
  };
  const lockRelative = `bootstrap/${predictorId}.lock.json`;
  const lockPath = join(fixture.root, lockRelative);
  await writeJson(lockPath, lock);
  const predictorLockSha256 = await sha256File(lockPath);

  const pythonPath = join(fixture.root, ".runtime", "predictors", predictorId, "bin", "python");
  await writeText(pythonPath, "#!/bin/sh\nexit 99\n");
  await chmod(pythonPath, 0o755);
  await writeJson(join(fixture.root, ".runtime", `${predictorId}-install-manifest.json`), {
    schemaVersion: "pi-external-go-predictor-install.v1",
    createdAt: "2026-07-22T00:00:00.000Z",
    platform: "test",
    pythonVersion: "3.11.99",
    predictorLockSha256,
    requirementsPath: requirementsRelative,
    requirementsSha256,
    runnerPath: runnerRelative,
    runnerSha256: await sha256File(fixture.runnerPath),
    runtimePackage: "onnxruntime",
    runtimeVersion: "1.16.3-test",
    packages: [{ name: "onnxruntime", version: "1.16.3-test" }],
  });
  await writeJson(join(fixture.root, "bootstrap", "release.lock.json"), {
    schemaVersion: "pi-function-release-contract.v1",
    sourceBindings: [
      { name: "predictorLock", path: lockRelative, sha256: predictorLockSha256 },
      { name: "requirements", path: requirementsRelative, sha256: requirementsSha256 },
      { name: "runner", path: runnerRelative, sha256: await sha256File(fixture.runnerPath) },
    ],
  });

  const keyPrefix = architecture === "cnn" ? "MDEEPFRI" : "MDEEPFRI_GCN";
  const enabledKey = architecture === "cnn" ? "MDEEPFRI_CNN_ENABLED" : "MDEEPFRI_GCN_ENABLED";
  const lines = [
    `${enabledKey}=true`,
    `${keyPrefix}_PYTHON_BIN=${pythonPath}`,
    `${keyPrefix}_RUNNER=${fixture.runnerPath}`,
    `${keyPrefix}_MODEL_CONFIG=${fixture.modelConfigPath}`,
  ];
  const abbreviations = new Map([
    ["molecular_function", "MF"],
    ["biological_process", "BP"],
    ["cellular_component", "CC"],
  ]);
  for (const item of fixture.modelFiles) {
    const abbreviation = abbreviations.get(item.aspect)!;
    lines.push(`${keyPrefix}_${abbreviation}_PARAMS=${item.paramsPath}`);
    lines.push(`${keyPrefix}_${abbreviation}_ONNX=${item.onnxPath}`);
  }
  lines.push("PRIVATE_SECRET=super-private-token");
  const configPath = join(fixture.root, "config", "managed.env");
  await writeText(configPath, `${lines.join("\n")}\n`);
  return { configPath, predictorId, predictorLockSha256 };
}

const lockedRuntimeInspection = async (input: { packageName: string }): Promise<{
  pythonVersion: string;
  packageName: string;
  packageVersion: string;
}> => ({
  pythonVersion: "3.11.99",
  packageName: input.packageName,
  packageVersion: "1.16.3-test",
});

test("generates a receipt-bound, deterministic three-aspect mDeepFRI overlay", async () => {
  const fixture = await makeFixture();
  try {
    let observedRequest: ExternalGoPredictorRunnerRequest | undefined;
    const overlay = await generateExternalGoPredictorOverlay(fixture.input, {
      run: async (request) => {
        observedRequest = request;
        return validRunnerResult(request);
      },
    });

    assert.ok(observedRequest);
    assert.equal(observedRequest.schemaVersion, "pi-external-go-predictor-run-request.v1");
    assert.deepEqual(observedRequest.cases.map((item) => item.sequence), fixture.cases.map((item) => item.sequence));
    assert.deepEqual(observedRequest.artifacts.modelFiles.map((item) => item.aspect), ASPECTS);
    assert.equal(overlay.base.baseFrozenEvidenceSetHash, fixture.baseFrozenEvidenceSetHash);
    assert.deepEqual(overlay.cases.map((item) => item.caseId), fixture.cases.map((item) => item.caseId));
    assert.deepEqual(overlay.method.modelFiles.map((item) => item.aspect), ASPECTS);
    assert.equal(overlay.method.provider, "mDeepFRI");
    assert.equal(overlay.method.sourceType, "mdeepfri_cnn");
    assert.equal(overlay.method.annotationEvidenceCode, "MODEL");
    assert.equal(overlay.method.exportMinimumScore, 0.1);
    assert.deepEqual(overlay.cases[0].rawPredictions.map((item) => item.goId), ["GO:0000001", "GO:0000003"]);
    for (const item of overlay.cases) {
      assert.ok(item.candidates.length > 0);
      assert.ok(item.candidates.every((candidate) => candidate.provenance_root === item.dependencyRoot));
      assert.ok(item.candidates.every((candidate) => candidate.source_type === "mdeepfri_cnn"));
      assert.ok(item.candidates.every((candidate) => candidate.provider === "mDeepFRI"));
      assert.ok(item.candidates.every((candidate) => candidate.annotation_evidence_code === "MODEL"));
    }
    assert.doesNotThrow(() => validateExternalGoPredictorOverlay(overlay, {
      suiteId: "external-go-fixture",
      baseFrozenEvidenceSetHash: fixture.baseFrozenEvidenceSetHash,
      methodHash: overlay.method.methodHash,
      orderedPublicCases: overlay.base.orderedPublicCases,
    }));

    const overlayPath = join(fixture.root, "overlay.json");
    await writeJson(overlayPath, overlay);
    const loaded = await loadExternalGoPredictorOverlay(overlayPath, {
      publicManifestHash: overlay.base.publicManifestHash,
      baseBatchManifestHash: overlay.base.baseBatchManifestHash,
      acquisitionPlanHash: overlay.base.acquisitionPlanHash,
      acquisitionReceiptHash: overlay.base.acquisitionReceiptHash,
    });
    assert.deepEqual(loaded, overlay);
    await assert.rejects(
      loadExternalGoPredictorOverlay(overlayPath, { methodHash: "0".repeat(64) }),
      /methodHash binding mismatch/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("merges one overlay case without mutation or duplicate model evidence", async () => {
  const fixture = await makeFixture();
  try {
    const overlay = await generateExternalGoPredictorOverlay(fixture.input, {
      run: async (request) => validRunnerResult(request),
    });
    const base = structuredClone(fixture.cases[0].evidence);
    const snapshot = structuredClone(base);
    const merged = mergeCandidateOverlay(base, overlay, fixture.cases[0].caseId);
    assert.deepEqual(base, snapshot);
    const sources = merged.candidate_sources as {
      providers: Array<Record<string, unknown>>;
      go_candidates: Array<Record<string, unknown>>;
      external_predictor_overlay: Record<string, unknown>;
    };
    assert.equal(sources.providers.at(-1)?.provider, "mDeepFRI");
    assert.equal(sources.go_candidates.length, overlay.cases[0].candidates.length);
    assert.equal(sources.external_predictor_overlay.overlay_hash, overlay.canonicalHash);
    assert.deepEqual(
      sources.go_candidates.map((item) => item.provenance_root),
      Array(sources.go_candidates.length).fill(overlay.cases[0].dependencyRoot),
    );
    const evidenceIds = merged.evidence_ids as string[];
    assert.ok(overlay.cases[0].candidates.every((item) => evidenceIds.includes(item.evidence_id)));
    assert.throws(
      () => mergeCandidateOverlay(merged, overlay, fixture.cases[0].caseId),
      /already contains the mDeepFRI CNN overlay/,
    );
    assert.throws(
      () => mergeCandidateOverlay({ protein: { sequence_input_sha256: "f".repeat(64) } }, overlay, fixture.cases[0].caseId),
      /sequence hash does not match/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("default subprocess runner exchanges the strict anonymous JSON contract", async () => {
  const fixture = await makeFixture();
  try {
    const overlay = await generateExternalGoPredictorOverlay({
      ...fixture.input,
      runnerTimeoutMs: 10_000,
      runnerMaxStdoutBytes: 1024 * 1024,
    });
    assert.equal(overlay.caseCount, fixture.cases.length);
    assert.deepEqual(overlay.cases.map((item) => item.caseId), fixture.cases.map((item) => item.caseId));
    assert.ok(overlay.cases.every((item) => item.rawPredictions.length === 1));
    assert.ok(overlay.cases.every((item) => item.rawPredictions[0].score === 0.5));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("default subprocess runner isolates Python imports and sanitizes the host environment", async () => {
  const fixture = await makeFixture();
  const poisoned = {
    PYTHONPATH: process.env.PYTHONPATH,
    PYTHONHOME: process.env.PYTHONHOME,
    VIRTUAL_ENV: process.env.VIRTUAL_ENV,
    CONDA_PREFIX: process.env.CONDA_PREFIX,
    PIP_INDEX_URL: process.env.PIP_INDEX_URL,
  };
  try {
    process.env.PYTHONPATH = join(fixture.root, "shadow-modules");
    process.env.PYTHONHOME = join(fixture.root, "shadow-home");
    process.env.VIRTUAL_ENV = join(fixture.root, "shadow-venv");
    process.env.CONDA_PREFIX = join(fixture.root, "shadow-conda");
    process.env.PIP_INDEX_URL = "https://credentials.invalid/simple";
    await writeText(fixture.runnerPath, [
      "import json, os, sys",
      "if sys.flags.isolated != 1:",
      "    raise RuntimeError('python is not isolated')",
      "for name in ('PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PIP_INDEX_URL'):",
      "    if name in os.environ:",
      "        raise RuntimeError('inherited forbidden environment: ' + name)",
      "if os.environ.get('PYTHONNOUSERSITE') != '1':",
      "    raise RuntimeError('user site is not disabled')",
      "request = json.load(sys.stdin)",
      "cases = [{'caseId': item['caseId'], 'sequenceSha256': item['sequenceSha256'], 'predictions': [{'goId': 'GO:0000001', 'termName': 'fixture function', 'aspect': 'molecular_function', 'score': 0.5}]} for item in request['cases']]",
      "json.dump({'schemaVersion': 'pi-external-go-predictor-run-result.v1', 'exportMinimumScore': request['method']['exportMinimumScore'], 'cases': cases}, sys.stdout)",
      "",
    ].join("\n"));
    const overlay = await generateExternalGoPredictorOverlay({
      ...fixture.input,
      runnerTimeoutMs: 10_000,
      runnerMaxStdoutBytes: 1024 * 1024,
    });
    assert.equal(overlay.caseCount, fixture.cases.length);
  } finally {
    for (const [name, value] of Object.entries(poisoned)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed on malformed, incomplete, duplicated, or path-leaking runner output", async (context) => {
  const fixture = await makeFixture();
  try {
    await context.test("missing case", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as { schemaVersion: string; cases: unknown[] };
            result.cases.pop();
            return result;
          },
        }),
        /not an exact public-case cover/,
      );
    });
    await context.test("invalid GO identifier", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as {
              cases: Array<{ predictions: Array<{ goId: string }> }>;
            };
            result.cases[0].predictions[0].goId = "GO:BAD";
            return result;
          },
        }),
        /goId is invalid/,
      );
    });
    await context.test("out-of-range score", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as {
              cases: Array<{ predictions: Array<{ score: number }> }>;
            };
            result.cases[0].predictions[0].score = 1.01;
            return result;
          },
        }),
        /finite score in \[0,1\]/,
      );
    });
    await context.test("path-bearing label", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as {
              cases: Array<{ predictions: Array<{ termName: string }> }>;
            };
            result.cases[0].predictions[0].termName = "/Users/private/model.onnx";
            return result;
          },
        }),
        /contains a filesystem path/,
      );
    });
    await context.test("duplicate GO identifier", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as {
              cases: Array<{ predictions: Array<Record<string, unknown>> }>;
            };
            result.cases[0].predictions.push(structuredClone(result.cases[0].predictions[0]));
            return result;
          },
        }),
        /duplicate GO IDs/,
      );
    });
    await context.test("threshold echo mismatch", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as { exportMinimumScore: number };
            result.exportMinimumScore = 0.2;
            return result;
          },
        }),
        /invalid schemaVersion or case list/,
      );
    });
    await context.test("prediction below bound export floor", async () => {
      await assert.rejects(
        generateExternalGoPredictorOverlay(fixture.input, {
          run: async (request) => {
            const result = validRunnerResult(request) as {
              cases: Array<{ predictions: Array<{ score: number }> }>;
            };
            result.cases[0].predictions[0].score = 0.09;
            return result;
          },
        }),
        /below-floor score/,
      );
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects overlay tampering and unbound model or evidence inputs", async () => {
  const fixture = await makeFixture();
  try {
    const overlay = await generateExternalGoPredictorOverlay(fixture.input, {
      run: async (request) => validRunnerResult(request),
    });
    const tampered = structuredClone(overlay) as unknown as {
      cases: Array<{ candidates: Array<{ base_score: number }> }>;
    };
    tampered.cases[0].candidates[0].base_score = 0.001;
    assert.throws(() => validateExternalGoPredictorOverlay(tampered), /candidate projection is invalid/);

    await assert.rejects(
      generateExternalGoPredictorOverlay({ ...fixture.input, baseFrozenEvidenceSetHash: "0".repeat(64) }, {
        run: async (request) => validRunnerResult(request),
      }),
      /does not match the receipt-bound base evidence/,
    );
    await assert.rejects(
      generateExternalGoPredictorOverlay({ ...fixture.input, exportMinimumScore: Number.NaN }, {
        run: async (request) => validRunnerResult(request),
      }),
      /finite score in \[0,1\]/,
    );

    const outsideParams = join(fixture.root, "outside", "mf.params.json");
    await writeText(outsideParams, "{}\n");
    await assert.rejects(
      generateExternalGoPredictorOverlay({
        ...fixture.input,
        modelFiles: fixture.modelFiles.map((item, index) => index === 0
          ? { ...item, paramsPath: outsideParams }
          : item),
      }, { run: async (request) => validRunnerResult(request) }),
      /must share one directory/,
    );

    if (process.platform !== "win32") {
      const linkedRunner = join(fixture.root, "runner-link.py");
      await symlink(fixture.runnerPath, linkedRunner);
      await assert.rejects(
        generateExternalGoPredictorOverlay({ ...fixture.input, runnerPath: linkedRunner }, {
          run: async (request) => validRunnerResult(request),
        }),
        /symbolic link/,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("overlay JSON schema fixes the mDeepFRI CNN method and three-aspect order", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schemas", "external_go_predictor_overlay.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const definitions = schema.$defs as {
    method: { properties: Record<string, unknown> };
  };
  assert.deepEqual(definitions.method.properties.provider, { const: "mDeepFRI" });
  assert.deepEqual(definitions.method.properties.sourceType, { const: "mdeepfri_cnn" });
  assert.deepEqual(definitions.method.properties.annotationEvidenceCode, { const: "MODEL" });
  assert.deepEqual(definitions.method.properties.exportMinimumScore, {
    type: "number",
    minimum: 0,
    maximum: 1,
  });
  assert.equal(
    ((definitions.method.properties.modelFiles as { prefixItems: unknown[] }).prefixItems).length,
    3,
  );
});

test("generates and merges a structure-hash-bound mDeepFRI GCN overlay", async () => {
  const fixture = await makeFixture(true);
  try {
    let request: ExternalGoPredictorGcnRunnerRequest | undefined;
    const input: GenerateExternalGoPredictorGcnOverlayInput = {
      ...fixture.input,
      tool: {
        toolName: "deepfri-gcn-onnx-adapter",
        packageName: "onnxruntime",
        packageVersion: "1.16.3-test",
      },
    };
    const overlay = await generateExternalGoPredictorGcnOverlay(input, {
      run: async (value) => {
        request = value;
        return validGcnRunnerResult(value);
      },
    });
    assert.ok(request);
    assert.equal(request.schemaVersion, "pi-external-go-gcn-run-request.v1");
    assert.ok(request.cases.every((item) => item.structurePath.endsWith("structure.pdb")));
    assert.deepEqual(
      request.cases.map((item) => item.structureSha256),
      fixture.cases.map((item) => item.structureSha256),
    );
    assert.equal(overlay.method.architecture, "gcn");
    assert.equal(overlay.method.sourceType, "mdeepfri_gcn");
    assert.equal(overlay.method.structurePolicy, "single_chain_exact_ca_v1");
    assert.equal(overlay.method.contactThresholdAngstrom, 10);
    assert.ok(overlay.cases.every((item) => item.dependencyRoot.startsWith("mdeepfri-gcn:")));
    assert.ok(overlay.cases.every((item) => item.candidates.every((candidate) =>
      candidate.source_type === "mdeepfri_gcn" && candidate.evidence_id.startsWith("CAND-MDG-"))));
    assert.doesNotThrow(() => validateExternalGoPredictorGcnOverlay(overlay, {
      orderedPublicCases: overlay.base.orderedPublicCases,
      methodHash: overlay.method.methodHash,
    }));

    const output = join(fixture.root, "gcn-overlay.json");
    await writeJson(output, overlay);
    assert.deepEqual(await loadExternalGoPredictorGcnOverlay(output), overlay);

    const merged = mergeGcnCandidateOverlay(
      structuredClone(fixture.cases[0].evidence), overlay, fixture.cases[0].caseId,
    );
    const sources = merged.candidate_sources as {
      go_candidates: Array<{ source_type: string }>;
      external_predictor_overlay: { structure_sha256: string };
    };
    assert.ok(sources.go_candidates.every((item) => item.source_type === "mdeepfri_gcn"));
    assert.equal(sources.external_predictor_overlay.structure_sha256, fixture.cases[0].structureSha256);
    assert.throws(
      () => mergeGcnCandidateOverlay(merged, overlay, fixture.cases[0].caseId),
      /already contains an mDeepFRI learned overlay/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("structure GCN overlay fails closed on missing structures and structure-binding tampering", async () => {
  const sequenceOnly = await makeFixture();
  try {
    await assert.rejects(
      generateExternalGoPredictorGcnOverlay({
        ...sequenceOnly.input,
        tool: { toolName: "deepfri-gcn-onnx-adapter", packageName: "onnxruntime", packageVersion: "test" },
      }, { run: async (request) => validGcnRunnerResult(request) }),
      /requires a receipt-bound structure/,
    );
  } finally {
    await rm(sequenceOnly.root, { recursive: true, force: true });
  }

  const fixture = await makeFixture(true);
  try {
    const overlay = await generateExternalGoPredictorGcnOverlay({
      ...fixture.input,
      tool: { toolName: "deepfri-gcn-onnx-adapter", packageName: "onnxruntime", packageVersion: "test" },
    }, { run: async (request) => validGcnRunnerResult(request) });
    const tampered = structuredClone(overlay) as unknown as {
      cases: Array<{ structureSha256: string }>;
    };
    tampered.cases[0].structureSha256 = "0".repeat(64);
    assert.throws(
      () => validateExternalGoPredictorGcnOverlay(tampered),
      /case order\/binding is invalid/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GCN overlay schema fixes structure policy, model architecture, and source provenance", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schemas", "external_go_predictor_gcn_overlay.schema.json"), "utf8"),
  ) as { $defs: { method: { properties: Record<string, unknown> }; candidate: { properties: Record<string, unknown> } } };
  assert.deepEqual(schema.$defs.method.properties.architecture, { const: "gcn" });
  assert.deepEqual(schema.$defs.method.properties.structurePolicy, { const: "single_chain_exact_ca_v1" });
  assert.deepEqual(schema.$defs.method.properties.contactThresholdAngstrom, { const: 10 });
  assert.deepEqual(schema.$defs.method.properties.sourceType, { const: "mdeepfri_gcn" });
  assert.deepEqual(schema.$defs.candidate.properties.source_type, { const: "mdeepfri_gcn" });
});

test("repository-locked reproduction verifies exact CNN bytes and emits a path-free receipt", async () => {
  const fixture = await makeFixture();
  try {
    const locked = await makeLockedFixture(fixture, "cnn");
    const overlay = await generateExternalGoPredictorOverlay({
      ...fixture.input,
      tool: {
        toolName: "deepfri-cnn-onnx-adapter",
        packageName: "onnxruntime",
        packageVersion: "1.16.3-test",
      },
    }, { run: async (request) => validRunnerResult(request) });
    const result = await verifyLockedExternalGoPredictorOverlayReproduction({
      overlay,
      publicDir: fixture.publicDir,
      batchDir: fixture.batchDir,
      configPath: locked.configPath,
    }, {
      repositoryRootForTests: fixture.root,
      inspectRuntimePackage: lockedRuntimeInspection,
      cnnRun: async (request) => validRunnerResult(request),
    });
    assert.deepEqual(result.overlay, overlay);
    assert.equal(result.receipt.mode, "repository_locked_exact_reproduction_v1");
    assert.equal(result.receipt.predictorId, "mdeepfri-cnn-v1");
    assert.equal(result.receipt.predictorLockSha256, locked.predictorLockSha256);
    assert.equal(result.receipt.sourceOverlayHash, overlay.canonicalHash);
    assert.equal(result.receipt.reproducedOverlayHash, overlay.canonicalHash);
    assert.match(result.receipt.reproductionHash, /^[a-f0-9]{64}$/);
    assert.equal(result.receipt.labelAccess, "public_inputs_only");
    const receiptText = JSON.stringify(result.receipt);
    assert.doesNotMatch(receiptText, /\/private\/|managed\.env|SECRET=|super-private-token/);
    assert.doesNotMatch(receiptText, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repository-locked reproduction supports the structure GCN channel", async () => {
  const fixture = await makeFixture(true);
  try {
    const locked = await makeLockedFixture(fixture, "gcn");
    const overlay = await generateExternalGoPredictorGcnOverlay({
      ...fixture.input,
      tool: {
        toolName: "deepfri-gcn-onnx-adapter",
        packageName: "onnxruntime",
        packageVersion: "1.16.3-test",
      },
    }, { run: async (request) => validGcnRunnerResult(request) });
    const result = await verifyLockedExternalGoPredictorOverlayReproduction({
      overlay,
      publicDir: fixture.publicDir,
      batchDir: fixture.batchDir,
      configPath: locked.configPath,
    }, {
      repositoryRootForTests: fixture.root,
      inspectRuntimePackage: lockedRuntimeInspection,
      gcnRun: async (request) => validGcnRunnerResult(request),
    });
    assert.equal(result.receipt.predictorId, "mdeepfri-gcn-v1");
    assert.equal(result.receipt.architecture, "gcn");
    assert.equal(result.receipt.reproducedOverlayHash, overlay.canonicalHash);
    assert.deepEqual(result.overlay, overlay);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repository-locked reproduction rejects a fully re-hashed forged prediction overlay", async () => {
  const fixture = await makeFixture();
  try {
    const locked = await makeLockedFixture(fixture, "cnn");
    const forged = await generateExternalGoPredictorOverlay({
      ...fixture.input,
      tool: {
        toolName: "deepfri-cnn-onnx-adapter",
        packageName: "onnxruntime",
        packageVersion: "1.16.3-test",
      },
    }, {
      run: async (request) => {
        const output = validRunnerResult(request) as {
          cases: Array<{ predictions: Array<{ score: number }> }>;
        };
        output.cases[0].predictions[0].score = 0.777777;
        return output;
      },
    });
    assert.doesNotThrow(() => validateExternalGoPredictorOverlay(forged));
    await assert.rejects(
      verifyLockedExternalGoPredictorOverlayReproduction({
        overlay: forged,
        publicDir: fixture.publicDir,
        batchDir: fixture.batchDir,
        configPath: locked.configPath,
      }, {
        repositoryRootForTests: fixture.root,
        inspectRuntimePackage: lockedRuntimeInspection,
        cnnRun: async (request) => validRunnerResult(request),
      }),
      /failed repository-locked exact reproduction/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repository-locked reproduction fails closed on lock, runner, model, package, or config drift", async (t) => {
  const expectFailure = async (input: {
    mutate?: (fixture: Fixture, locked: LockedFixture) => Promise<void>;
    inspect?: typeof lockedRuntimeInspection;
    message: RegExp;
  }): Promise<void> => {
    const fixture = await makeFixture();
    try {
      const locked = await makeLockedFixture(fixture, "cnn");
      const overlay = await generateExternalGoPredictorOverlay({
        ...fixture.input,
        tool: {
          toolName: "deepfri-cnn-onnx-adapter",
          packageName: "onnxruntime",
          packageVersion: "1.16.3-test",
        },
      }, { run: async (request) => validRunnerResult(request) });
      await input.mutate?.(fixture, locked);
      await assert.rejects(
        verifyLockedExternalGoPredictorOverlayReproduction({
          overlay,
          publicDir: fixture.publicDir,
          batchDir: fixture.batchDir,
          configPath: locked.configPath,
        }, {
          repositoryRootForTests: fixture.root,
          inspectRuntimePackage: input.inspect ?? lockedRuntimeInspection,
          cnnRun: async (request) => validRunnerResult(request),
        }),
        input.message,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  };

  await t.test("release-bound predictor lock", async () => await expectFailure({
    mutate: async (fixture) => {
      const lockPath = join(fixture.root, "bootstrap", "mdeepfri-cnn-v1.lock.json");
      await writeText(lockPath, `${await readFile(lockPath, "utf8")}\n`);
    },
    message: /predictor lock is not SHA-256-bound/,
  }));
  await t.test("runner bytes", async () => await expectFailure({
    mutate: async (fixture) => await writeText(fixture.runnerPath, "# drifted runner\n"),
    message: /runner does not match the repository predictor lock/,
  }));
  await t.test("model bytes", async () => await expectFailure({
    mutate: async (fixture) => await writeText(fixture.modelFiles[0].onnxPath, "drifted model\n"),
    message: /managed predictor model does not match the repository predictor lock/,
  }));
  await t.test("installed package", async () => await expectFailure({
    inspect: async ({ packageName }) => ({
      pythonVersion: "3.11.99", packageName, packageVersion: "9.9.9",
    }),
    message: /runtime package or Python version is not lock-exact/,
  }));
  await t.test("managed config", async () => await expectFailure({
    mutate: async (_fixture, locked) => await writeText(locked.configPath, "MDEEPFRI_CNN_ENABLED=false\n"),
    message: /does not enable the repository CNN predictor/,
  }));
});
