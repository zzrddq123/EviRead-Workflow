#!/usr/bin/env node

import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { enforceNarrativeDisclosures, narrativeDisclosureProblems, runCritic, runSynthesizer } from "./agents.js";
import { canonicalAccession } from "./accession.js";
import {
  buildBlindEvidenceView,
  buildBlindGoView,
  goPolicyAdmittedCandidateEvidenceIds,
} from "./blind.js";
import { attachCandidateSources, collectConfiguredCandidateSources, trustedTargetLineageFromEvidence } from "./candidate_stage.js";
import { loadPredictionRuntimeEnv, loadRuntimeEnv, option, PROJECT_ROOT, sanitizeId, timestampId } from "./config.js";
import { buildDeterministicNarrative, deterministicAudit, deterministicReview } from "./deterministic.js";
import { loadGenome } from "./genome.js";
import { inferGoPredictions, writeGoTsv } from "./go.js";
import {
  applyGOJudgeResult,
  applyGOScoreFusion,
  buildGOJudgeBinding,
  runGOEvidenceJudge,
  type GOJudgeExecutionAudit,
} from "./go_judge.js";
import {
  buildGoOntologySnapshot,
  loadGoBasicObo,
  parseGoOntologySnapshot,
} from "./go_ontology.js";
import { hashCanonical, sha256File, sha256Text } from "./hash.js";
import { parseFastaSequence, prepareAnonymousInputs } from "./input.js";
import {
  assertLearnedPredictorCompleteness,
  learnedPredictorBindingFromEvidenceBundle,
} from "./learned_predictor_contract.js";
import { configureSdkNetwork } from "./network.js";
import { sanitizePersistedError, sanitizePiSessionFiles } from "./privacy.js";
import { writeReports } from "./report.js";
import {
  applySemanticGOJudgeResult,
  buildSemanticGOJudgeBinding,
  renderSemanticPredictionTsv,
  runSemanticGOJudge,
  semanticPredictionRows,
} from "./semantic_go_judge.js";
import { doctorEvidenceBackend, runEvidencePipeline } from "./runner.js";
import { loadReadArtifact, mergeReadBundle } from "./eviread_read.js";
import { attachBioLM } from "./biolm.js";
import { assertModelOnlyEnvironment, loadModelOnlyEvidence } from "./model_only_profile.js";
import type {
  AgentAudit,
  CriticReview,
  EpisodeStep,
  EpisodeTrace,
  FinalPrediction,
  FunctionPrediction,
  NarrativeMode,
  PhylogenyMode,
  TargetMode,
} from "./types.js";
import { validateRunArtifacts } from "./validate.js";
import { z86BridgeCommand } from "./z86_bridge.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function usage(): string {
  return `Pi Function + GO Prediction Agent MVP

Commands:
  ./pi-agent doctor [--config config/managed.env]
  ./pi-agent predict --sequence query.fasta [--structure model.pdb]
      [--target-mode anonymous|named-uncharacterized] [--protein-id ID]
      [--exclude-accession ACCESSION[,ACCESSION...]]
      [--query-taxon-id 9606] [--phylogeny-mode optional|required]
      [--genome genomes/human-v0005-mainline-semantic-reasoner-r9.json]
      [--go-ontology .databases/gene_ontology/go-basic.obo]
      [--narrative-mode pi|deterministic] [--biolm-evidence evidence/biolm.json]
      [--config config/managed.env]
  ./pi-agent predict --input-dir /path/to/protein [the same optional flags]
  ./pi-agent validate --run-dir runs/<run-id>
  ./pi-agent z86-bridge prepare-inputs --benchmark /path/to/z86-function-198-pair-clean-v2 --output-root /tmp/z86-inputs
  ./pi-agent z86-bridge export --benchmark /path/to/z86-function-198-pair-clean-v2 --runs-root /path/to/runs --predictions /tmp/predictions
  ./pi-agent z86-bridge evaluate --benchmark /path/to/z86-function-198-pair-clean-v2 --private /path/to/private --predictions /tmp/predictions --output /tmp/aggregate.json

The default genome requires the unchanged r08 Pi semantic GO decision and fails closed if it cannot run. --narrative-mode controls only the downstream report.
Anonymous mode is the default. It replaces FASTA/PDB identity metadata before any evidence tool runs and derives an opaque ID from sequence content.
A positive NCBI TaxID may be declared in either target mode; it does not disclose or authorize use of a protein accession/name. Taxonomy is never inferred from search hits.
`;
}

function validEvidenceIds(bundle: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(bundle.evidence_ids) ? bundle.evidence_ids.map(String) : []);
}

function citationProblems(prediction: FunctionPrediction, bundle: Record<string, unknown>): string[] {
  const valid = validEvidenceIds(bundle);
  const cited = [
    ...prediction.keyEvidence.map((item) => item.evidenceId),
    ...prediction.alternatives.flatMap((item) => item.evidenceIds),
  ];
  const unknown = cited.filter((id) => !valid.has(id));
  const problems: string[] = [];
  if (cited.length === 0) problems.push("Prediction has no key evidence citations.");
  if (unknown.length > 0) problems.push(`Unknown evidence IDs: ${[...new Set(unknown)].join(", ")}`);
  return problems;
}

function positiveIntegerOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function narrativeModeOption(args: string[], fallback: NarrativeMode): NarrativeMode {
  const value = option(args, "--narrative-mode") ?? fallback;
  if (value !== "pi" && value !== "deterministic") throw new Error("--narrative-mode must be pi or deterministic");
  return value;
}

function targetModeOption(args: string[]): TargetMode {
  const value = option(args, "--target-mode") ?? "anonymous";
  if (value === "anonymous") return "anonymous";
  if (value === "named-uncharacterized" || value === "named_uncharacterized") return "named_uncharacterized";
  throw new Error("--target-mode must be anonymous or named-uncharacterized");
}

function phylogenyModeOption(args: string[]): PhylogenyMode {
  const value = option(args, "--phylogeny-mode") ?? "optional";
  if (value === "optional" || value === "required") return value;
  throw new Error("--phylogeny-mode must be optional or required");
}

function normalizeExcludedAccessions(values: readonly string[]): string[] {
  return [...new Set(values
    .flatMap((value) => value.split(","))
    .map(canonicalAccession)
    .filter(Boolean))].sort();
}

function excludedAccessionsOption(args: string[]): string[] {
  return normalizeExcludedAccessions([option(args, "--exclude-accession") ?? ""]);
}

/**
 * Evaluator-owned inputs which may affect only deterministic evidence/GO
 * quarantine. They are deliberately not representable by a public benchmark
 * case or forwarded to either Pi agent.
 */
export interface TrustedPredictionContext {
  evidenceExclusionAccessions?: readonly string[];
  /** Evaluator-only binding; ordinary predict CLI arguments cannot populate it. */
  evidenceAcquisition?: {
    planHash: string;
    epochId: string;
  };
}

async function episodeStep<T>(
  episode: EpisodeTrace,
  name: string,
  action: () => Promise<T>,
  summarize: (value: T) => { evidenceIds?: string[]; outputHashes?: Record<string, string>; note?: string } = () => ({}),
): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const value = await action();
    const summary = summarize(value);
    episode.steps.push({
      name,
      status: "completed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      evidenceIds: [...new Set(summary.evidenceIds ?? [])],
      outputHashes: summary.outputHashes ?? {},
      note: summary.note,
    });
    return value;
  } catch (error) {
    episode.steps.push({
      name,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      evidenceIds: [],
      outputHashes: {},
      note: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function predict(args: string[], trustedContext: TrustedPredictionContext = {}): Promise<number> {
  if (trustedContext.evidenceAcquisition
    && (!/^[a-f0-9]{64}$/.test(trustedContext.evidenceAcquisition.planHash)
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(trustedContext.evidenceAcquisition.epochId))) {
    throw new Error("trusted evidence acquisition binding is invalid");
  }
  const managedConfig = join(PROJECT_ROOT, "config", "managed.env");
  const defaultConfig = await exists(managedConfig) ? managedConfig : join(PROJECT_ROOT, "config", "local.env");
  const configPath = resolve(option(args, "--config") ?? defaultConfig);
  const inputDirOption = option(args, "--input-dir");
  const inputDir = inputDirOption ? resolve(inputDirOption) : undefined;
  const sequenceArgument = option(args, "--sequence") ?? (inputDir ? join(inputDir, "sequence.fasta") : undefined);
  if (!sequenceArgument) throw new Error("Provide --input-dir or --sequence; --structure is optional");
  const sequenceSource = resolve(sequenceArgument);
  const structureArgument = option(args, "--structure") ?? (inputDir && await exists(join(inputDir, "structure.pdb")) ? join(inputDir, "structure.pdb") : undefined);
  const structureSource = structureArgument ? resolve(structureArgument) : undefined;
  if (!(await exists(sequenceSource))) throw new Error(`Sequence input not found: ${sequenceSource}`);
  if (structureSource && !(await exists(structureSource))) throw new Error(`Structure input not found: ${structureSource}`);
  if (!(await exists(configPath))) throw new Error(`Runtime config not found: ${configPath}`);

  const genomePath = resolve(option(args, "--genome") ?? join(PROJECT_ROOT, "genomes", "codebase1-model-only.json"));
  if (!(await exists(genomePath))) throw new Error(`Genome not found: ${genomePath}`);
  const genome = await loadGenome(genomePath);
  const narrativeMode = narrativeModeOption(args, genome.genome.narrativePolicy.defaultMode);
  const targetMode = targetModeOption(args);
  const queryTaxonId = positiveIntegerOption(args, "--query-taxon-id");
  const phylogenyMode = phylogenyModeOption(args);
  const runtimeEnv = loadPredictionRuntimeEnv(configPath);
  if (runtimeEnv.EVIREAD_REQUIRE_SEMANTIC_GO_AGENT === "1"
    && genome.genome.goPolicy.goJudgePolicy?.mode !== "semantic_reasoning") {
    throw new Error("CodeBase1 requires the unified semantic GO Agent stage; the selected genome is not semantic_reasoning");
  }
  configureSdkNetwork(runtimeEnv);
  const liveLearnedPolicy = genome.genome.goPolicy.learnedPredictorPolicy;
  if (liveLearnedPolicy?.mode === "candidate_channel"
    && (!["deepgoplus_cnn", "deepgoplus_hybrid"].includes(
      liveLearnedPolicy.allowedSources[0],
    )
      || (liveLearnedPolicy.allowedSources[0] === "deepgoplus_cnn"
        ? runtimeEnv.DEEPGOPLUS_MODE?.trim().toLowerCase() !== "local"
        : (runtimeEnv.DEEPGOPLUS_HYBRID_MODE
          ?? runtimeEnv.DEEPGOPLUS_MODE)?.trim().toLowerCase() !== "local"))) {
    assertLearnedPredictorCompleteness({
      genome: genome.genome,
      binding: null,
      boundary: "live prediction",
    });
  }
  const ontologyConfigured = option(args, "--go-ontology") ?? runtimeEnv.GO_ONTOLOGY_OBO;
  const ontologyPath = ontologyConfigured ? resolve(ontologyConfigured) : undefined;
  if (genome.genome.goPolicy.ontologyPolicy?.mode === "ancestor_closure"
    && (!ontologyPath || !(await exists(ontologyPath)))) {
    throw new Error("This genome requires a pinned go-basic.obo; provide --go-ontology or GO_ONTOLOGY_OBO in the runtime config");
  }

  const sequence = parseFastaSequence(await readFile(sequenceSource, "utf8")).sequence;
  const opaqueId = `ANON_${sha256Text(sequence).slice(0, 12).toUpperCase()}`;
  const requestedProteinId = option(args, "--protein-id");
  if (targetMode === "named_uncharacterized" && !requestedProteinId) {
    throw new Error("--protein-id is required for --target-mode named-uncharacterized");
  }
  const proteinId = targetMode === "anonymous" ? opaqueId : sanitizeId(requestedProteinId ?? "");
  const excludedAccessions = normalizeExcludedAccessions([
    ...excludedAccessionsOption(args),
    ...(trustedContext.evidenceExclusionAccessions ?? []),
  ]);
  const requestedRunName = option(args, "--run-name");
  const runId = sanitizeId(requestedRunName ?? `${proteinId}_${timestampId()}`);
  const runDir = resolve(option(args, "--run-dir") ?? join(PROJECT_ROOT, "runs", runId));
  if (await exists(join(runDir, "run_manifest.json"))) {
    throw new Error(`Run directory already contains a manifest: ${runDir}. Choose another --run-name or --run-dir.`);
  }
  const predictionDir = join(runDir, "prediction");
  await mkdir(predictionDir, { recursive: true });
  const prepared = await prepareAnonymousInputs({
    sequenceSource,
    structureSource,
    stagingDir: join(runDir, "_prepared_input"),
    targetMode,
    requestedProteinId: proteinId,
    queryTaxonId,
    phylogenyMode,
  });
  const targetContext = prepared.targetContext;
  const sequencePath = prepared.sequencePath;
  const structurePath = prepared.structurePath;
  await writeJson(join(runDir, "input", "redaction_report.json"), prepared.redactionReport);
  await writeJson(join(predictionDir, "agent_genome.json"), genome);

  const startedAt = new Date().toISOString();
  const episode: EpisodeTrace = {
    schemaVersion: "pi-function-episode.v3",
    episodeId: `${runId}:${genome.genomeHash.slice(0, 12)}`,
    runId,
    status: "failed",
    genomeId: genome.genome.genomeId,
    genomeHash: genome.genomeHash,
    narrativeMode,
    target: {
      proteinId,
      targetMode,
      queryTaxonId: queryTaxonId ?? null,
      targetContext,
      sequenceSha256: await sha256File(sequencePath),
      structureSha256: structurePath ? await sha256File(structurePath) : null,
    },
    steps: [],
    outputHashes: {},
    biologicalFeedback: {
      status: "unavailable",
      eligibleForEvolution: false,
      reason: "No delayed experimental or curator feedback was supplied; this generation-0 episode cannot train or promote an offspring.",
    },
    promotionDecision: "not_evaluated",
    startedAt,
    finishedAt: startedAt,
  };

  const runManifestPath = join(runDir, "run_manifest.json");
  const manifest: Record<string, unknown> = {
    schemaVersion: "pi-function-run.v4",
    harness: "codex-cli",
    agentModel: "openai-codex/gpt-5.6-sol",
    agentThinkingLevel: "high",
    status: "running",
    runId,
    proteinId,
    targetMode,
    identityPolicy: "temporal_t0_v1",
    excludedAccessionCount: excludedAccessions.length,
    queryTaxonId: queryTaxonId ?? null,
    targetContext,
    narrativeMode,
    evidenceAcquisition: trustedContext.evidenceAcquisition ? {
      planHash: trustedContext.evidenceAcquisition.planHash,
      epochId: trustedContext.evidenceAcquisition.epochId,
    } : null,
    genome: {
      path: "prediction/agent_genome.json",
      sourceLabel: relative(PROJECT_ROOT, genomePath).startsWith("..") ? basename(genomePath) : relative(PROJECT_ROOT, genomePath),
      genomeId: genome.genome.genomeId,
      genomeHash: genome.genomeHash,
      immutableContractHash: genome.immutableContractHash,
    },
    startedAt,
    inputs: {
      sequence: "input/sequence.fasta",
      structure: structurePath ? "input/structure.pdb" : null,
      sequenceSha256: episode.target.sequenceSha256,
      structureSha256: episode.target.structureSha256,
      sourceIdentityMetadata: "discarded_before_tools",
      redactionReport: "input/redaction_report.json",
    },
    stages: {},
  };
  await writeJson(runManifestPath, manifest);

  let persistedSensitiveIdentities = [...excludedAccessions];

  try {
    console.log(`\n[1/7] Deterministic similarity, structure, domain, and candidate evidence: ${proteinId}`);
    const evidenceBundle = await episodeStep(
      episode,
      "collect_fixed_evidence",
      async () => {
        const modelOnly = runtimeEnv.EVIREAD_PROFILE === "model_only";
        let fixedBundle;
        if (modelOnly) {
          assertModelOnlyEnvironment(runtimeEnv);
          await mkdir(join(runDir, "input"), { recursive: true });
          await writeFile(join(runDir, "input", "sequence.fasta"), `>anonymous_query\n${sequence.match(/.{1,80}/g)?.join("\n") ?? sequence}\n`, "utf8");
          if (structurePath) await copyFile(structurePath, join(runDir, "input", "structure.pdb"));
          await writeJson(join(runDir, "input", "redaction_report.json"), {
            schemaVersion: "pi-input-redaction.v2",
            targetMode: "anonymous",
            targetContext: { taxon: { taxonId: null, provenance: "unavailable" }, phylogeny: { mode: "optional", status: "unavailable_missing_taxon" } },
            sourceIdentityMetadataRetained: false,
            fastaHeadersRemoved: 1,
            pdbMetadataLinesRemoved: 0,
            structureConfidenceHintRetained: false,
            sequenceLength: sequence.length,
            structureAvailable: Boolean(structurePath),
          });
          const readArtifactPath = option(args, "--biolm-evidence") ?? runtimeEnv.EVIREAD_BIOLM_EVIDENCE;
          if (readArtifactPath) {
            fixedBundle = await loadModelOnlyEvidence({
              artifactPath: resolve(readArtifactPath),
              runDir,
              sequenceSha256: sha256Text(sequence),
              sequenceLength: sequence.length,
              sequenceInputSha256: await sha256File(join(runDir, "input", "sequence.fasta")),
              structureInputSha256: structurePath ? await sha256File(structurePath) : null,
              proteinId,
            });
          } else if (runtimeEnv.BIOLM_ONLINE === "1") {
            fixedBundle = await attachBioLM({ sequencePath, structurePath, proteinId, queryTaxonId, excludedAccessions, runDir, env: runtimeEnv });
          } else {
            throw new Error("CodeBase1 requires --biolm-evidence, EVIREAD_BIOLM_EVIDENCE, or BIOLM_ONLINE=1");
          }
          await writeJson(join(runDir, "evidence_manifest.json"), {
            schema_version: "pi-function-evidence-manifest.v1",
            profile: "eviread-codebase1-biolm-only.v1",
            status: "completed",
            tools_executed: [],
            models: ["esm2", "esmc", "protrek"],
            evidence_bundle: "evidence/evidence_bundle.json",
          });
        } else {
          fixedBundle = await runEvidencePipeline({ configPath, sequencePath, structurePath, proteinId, queryTaxonId, excludedAccessions, runDir });
          const readArtifactPath = option(args, "--biolm-evidence") ?? runtimeEnv.EVIREAD_BIOLM_EVIDENCE;
          if (readArtifactPath) {
            const read = await loadReadArtifact({ artifactPath: resolve(readArtifactPath), runDir, expectedSequenceSha256: sha256Text(sequence) });
            fixedBundle = mergeReadBundle(fixedBundle, read.bundle) as typeof fixedBundle;
            await writeFile(join(runDir, "evidence", "eviread_read.txt"), read.text, "utf8");
          }
        }
        const fixedProtein = fixedBundle.protein && typeof fixedBundle.protein === "object" && !Array.isArray(fixedBundle.protein)
          ? fixedBundle.protein as Record<string, unknown>
          : {};
        const targetLineage = trustedTargetLineageFromEvidence(fixedProtein);
        const candidateExcludedAccessions = normalizeExcludedAccessions([
          ...excludedAccessions,
          ...(Array.isArray(fixedProtein.query_like_accessions)
            ? fixedProtein.query_like_accessions.map(String)
            : []),
        ]);
        const candidates = modelOnly
          ? { providers: [], go_candidates: [] }
          : await collectConfiguredCandidateSources({
            sequence,
            targetTaxonId: targetContext.taxon.taxonId,
            targetLineage,
            excludedAccessions: candidateExcludedAccessions,
            requestedLearnedSource: liveLearnedPolicy?.mode === "candidate_channel"
              ? liveLearnedPolicy.allowedSources[0]
              : null,
            baseFrozenEvidenceSetHash: hashCanonical(fixedBundle),
            env: runtimeEnv,
          });
        const merged = modelOnly ? fixedBundle : attachCandidateSources(fixedBundle, candidates as Parameters<typeof attachCandidateSources>[1]);
        assertLearnedPredictorCompleteness({
          genome: genome.genome,
          binding: learnedPredictorBindingFromEvidenceBundle(merged),
          boundary: "live prediction",
        });
        await writeJson(join(runDir, "evidence", "evidence_bundle.json"), merged);
        return merged;
      },
      (bundle) => ({
        evidenceIds: [],
        outputHashes: { evidenceBundle: hashCanonical(bundle) },
        note: "Full fixed and opt-in remote candidate evidence is hash-bound here; identity-bearing query-like evidence remains quarantined from public/Pi views.",
      }),
    );
    const candidateSourceObject = evidenceBundle.candidate_sources && typeof evidenceBundle.candidate_sources === "object" && !Array.isArray(evidenceBundle.candidate_sources)
      ? evidenceBundle.candidate_sources as Record<string, unknown>
      : {};
    const candidateProviders = Array.isArray(candidateSourceObject.providers) ? candidateSourceObject.providers : [];
    const candidateRows = Array.isArray(candidateSourceObject.go_candidates) ? candidateSourceObject.go_candidates : [];
    (manifest.stages as Record<string, unknown>).evidence = {
      status: "completed",
      bundle: "evidence/evidence_bundle.json",
      candidateProviders,
      candidateCount: candidateRows.length,
    };
    await writeJson(runManifestPath, manifest);

    console.log("\n[2/7] Authoritative GO inference and bounded evidence judgment");
    const goPrediction = await episodeStep(
      episode,
      "infer_go",
      async () => {
        let ontology;
        let ontologySnapshot: Record<string, unknown> | undefined;
        if (genome.genome.goPolicy.ontologyPolicy?.mode === "ancestor_closure") {
          const fullOntology = await loadGoBasicObo(ontologyPath!);
          const annotations = Array.isArray(evidenceBundle.uniprot_annotations)
            ? evidenceBundle.uniprot_annotations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
            : [];
          const annotationGoIds = annotations.flatMap((annotation) => Array.isArray(annotation.go_terms)
            ? annotation.go_terms.flatMap((item) => item && typeof item === "object" && !Array.isArray(item)
              ? [String((item as Record<string, unknown>).id ?? "")]
              : [])
            : []);
          const candidateGoIds = candidateRows.flatMap((item) => item && typeof item === "object" && !Array.isArray(item)
            ? [String((item as Record<string, unknown>).go_id ?? "")]
            : []);
          const snapshot = buildGoOntologySnapshot(
            fullOntology,
            [...annotationGoIds, ...candidateGoIds],
            genome.genome.goPolicy.ontologyPolicy.maxDepth,
          );
          ontologySnapshot = snapshot as unknown as Record<string, unknown>;
          await writeJson(join(predictionDir, "go_ontology_snapshot.json"), snapshot);
          ontology = parseGoOntologySnapshot(snapshot);
        }
        let value = inferGoPredictions({
          proteinId,
          bundle: evidenceBundle,
          genome,
          queryTaxonId: episode.target.queryTaxonId,
          targetContext,
          targetMode,
          excludedAccessions,
          identityPolicy: "temporal_t0_v1",
          ontology,
          // Keep the scientific core pure while this orchestration boundary
          // records the exact bounded judge view and structured result.
          goJudgeMode: "disabled",
        });
        const judgePolicy = genome.genome.goPolicy.goJudgePolicy;
        if (judgePolicy?.mode === "evidence_consistency") {
          const binding = buildGOJudgeBinding(
            value,
            judgePolicy.maxCandidates,
            judgePolicy.candidateBudgetMode ?? "global_ranked_v1",
          );
          if (binding) {
            const configuredJudgeMode = judgePolicy.executionMode ?? "deterministic";
            if (configuredJudgeMode === "pi" && narrativeMode !== "pi") {
              throw new Error("A genome-bound Pi GO judge requires --narrative-mode pi; deterministic mode cannot silently substitute its behavior.");
            }
            let judgeResult;
            let fallbackReason: string | null = null;
            const judgeAudits: GOJudgeExecutionAudit[] = [];
            try {
              judgeResult = await runGOEvidenceJudge({
                projectRoot: PROJECT_ROOT,
                mode: configuredJudgeMode,
                view: binding.view,
                onAudit: (audit) => judgeAudits.push(audit),
              });
            } catch (error) {
              if (configuredJudgeMode !== "pi") throw error;
              fallbackReason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
              judgeResult = await runGOEvidenceJudge({
                projectRoot: PROJECT_ROOT,
                mode: "deterministic",
                view: binding.view,
                onAudit: (audit) => judgeAudits.push(audit),
              });
            }
            value = applyGOJudgeResult({
              prediction: value,
              binding,
              result: judgeResult,
              maxSelectedTermsPerAspect: genome.genome.goPolicy.maxSelectedTermsPerAspect,
              requestedMode: configuredJudgeMode,
              candidateRetentionMode: judgePolicy.candidateRetentionMode ?? "fail_closed_v1",
              fallbackReason,
            });
            // Neither artifact contains GO identifiers or the host-only
            // candidate-token reverse map. Validation reconstructs that map
            // from the bound evidence and genome.
            await writeJson(join(predictionDir, "go_judge_view.json"), binding.view);
            await writeJson(join(predictionDir, "go_judge_result.json"), judgeResult);
            const judgeAuditContent = {
              schemaVersion: "go-evidence-judge-audit-v1" as const,
              attempts: judgeAudits,
            };
            await writeJson(join(predictionDir, "go_judge_audit.json"), {
              ...judgeAuditContent,
              canonicalHash: hashCanonical(judgeAuditContent),
            });
          }
        } else if (judgePolicy?.mode === "semantic_reasoning") {
          if (!ontologySnapshot) throw new Error("The default semantic reasoning path requires a pinned GO ontology snapshot");
          const semanticBlindEvidence = buildBlindEvidenceView(
            evidenceBundle,
            value.queryLikeAccessions,
            goPolicyAdmittedCandidateEvidenceIds(value),
          );
          const binding = buildSemanticGOJudgeBinding({
            prediction: value,
            blindEvidenceBundle: semanticBlindEvidence,
            ontologySnapshot,
            maxCandidates: Number(judgePolicy.maxCandidates),
            maxDonorContexts: Number(judgePolicy.maxDonorContexts),
          });
          await writeJson(join(predictionDir, "semantic_go_judge_view.json"), binding.view);
          // Mandatory and fail-closed: unlike the legacy bounded judge, this
          // default path never substitutes a deterministic result.
          const semanticResult = await runSemanticGOJudge({
            projectRoot: PROJECT_ROOT,
            binding,
            modelProvider: judgePolicy.modelProvider,
            modelId: judgePolicy.modelId,
            thinkingLevel: judgePolicy.thinkingLevel,
          });
          await writeJson(join(predictionDir, "semantic_go_judge_result.json"), semanticResult);
          const semanticRows = semanticPredictionRows({ targetId: proteinId, binding, result: semanticResult });
          await writeFile(
            join(predictionDir, "semantic_go_score_surface.tsv"),
            renderSemanticPredictionTsv(semanticRows),
            "utf8",
          );
          value = applySemanticGOJudgeResult({
            prediction: value,
            binding,
            result: semanticResult,
            maxSelectedTermsPerAspect: genome.genome.goPolicy.maxSelectedTermsPerAspect,
            maxCandidates: Number(judgePolicy.maxCandidates),
            maxDonorContexts: Number(judgePolicy.maxDonorContexts),
          });
        }
        const scoreFusionPolicy = genome.genome.goPolicy.scoreFusionPolicy;
        if (scoreFusionPolicy?.mode === "deepgoplus_anchor_v1") {
          value = applyGOScoreFusion({
            prediction: value,
            policy: scoreFusionPolicy,
            maxSelectedTermsPerAspect: genome.genome.goPolicy.maxSelectedTermsPerAspect,
          });
        }
        await writeJson(join(predictionDir, "go_predictions.json"), value);
        await writeGoTsv(join(predictionDir, "go_predictions.tsv"), value);
        return value;
      },
      (value) => ({ evidenceIds: [...new Set(value.terms.flatMap((term) => term.evidenceIds))].sort(), outputHashes: { goPrediction: value.canonicalHash } }),
    );
    (manifest.stages as Record<string, unknown>).goInference = {
      status: "completed",
      methodId: goPrediction.methodId,
      quarantinedGoCount: goPrediction.quarantinedGoIds.length,
      queryLikeRecordCount: goPrediction.queryLikeAccessions.length,
      predictedGoIds: goPrediction.predictedGoIds,
      canonicalHash: goPrediction.canonicalHash,
      ontologySnapshot: goPrediction.ontologyBinding ? "prediction/go_ontology_snapshot.json" : null,
      ontologyBinding: goPrediction.ontologyBinding ?? null,
      goJudge: goPrediction.goJudgeStatus ?? { requestedMode: "disabled", judgedCandidateCount: 0 },
      semanticGoJudge: goPrediction.semanticGoJudgeStatus ?? { modeUsed: "disabled", candidateCount: 0, acceptedCount: 0 },
      ...(goPrediction.goJudgeStatus ? {
        goJudgeArtifacts: {
          view: "prediction/go_judge_view.json",
          viewSha256: await sha256File(join(predictionDir, "go_judge_view.json")),
          result: "prediction/go_judge_result.json",
          resultSha256: await sha256File(join(predictionDir, "go_judge_result.json")),
          audit: "prediction/go_judge_audit.json",
          auditSha256: await sha256File(join(predictionDir, "go_judge_audit.json")),
        },
      } : {}),
      ...(goPrediction.semanticGoJudgeStatus ? {
        semanticGoJudgeArtifacts: {
          view: "prediction/semantic_go_judge_view.json",
          viewSha256: await sha256File(join(predictionDir, "semantic_go_judge_view.json")),
          result: "prediction/semantic_go_judge_result.json",
          resultSha256: await sha256File(join(predictionDir, "semantic_go_judge_result.json")),
          scoreSurface: "prediction/semantic_go_score_surface.tsv",
          scoreSurfaceSha256: await sha256File(join(predictionDir, "semantic_go_score_surface.tsv")),
        },
      } : {}),
    };
    persistedSensitiveIdentities = [...new Set([
      ...persistedSensitiveIdentities,
      ...goPrediction.queryLikeAccessions,
    ])];
    const blindEvidenceBundle = buildBlindEvidenceView(
      evidenceBundle,
      goPrediction.queryLikeAccessions,
      goPolicyAdmittedCandidateEvidenceIds(goPrediction),
    );
    const blindGoPrediction = buildBlindGoView(goPrediction);
    await writeJson(join(runDir, "evidence", "blind_evidence_bundle.json"), blindEvidenceBundle);
    await writeJson(join(predictionDir, "blind_go_view.json"), blindGoPrediction);
    await writeJson(runManifestPath, manifest);

    let synthesisValue: FunctionPrediction;
    let critiqueValue: CriticReview;
    const audits: AgentAudit[] = [];
    let revisionCount = 0;

    if (narrativeMode === "deterministic") {
      console.log("\n[3/7] Explicit deterministic narrative mode");
      synthesisValue = await episodeStep(
        episode,
        "synthesize_narrative",
        async () => enforceNarrativeDisclosures(
          buildDeterministicNarrative(proteinId, blindGoPrediction, blindEvidenceBundle),
          blindEvidenceBundle,
          blindGoPrediction,
        ),
        (value) => ({ evidenceIds: value.keyEvidence.map((item) => item.evidenceId), outputHashes: { narrative: hashCanonical(value) }, note: "Explicit deterministic mode; no provider fallback occurred." }),
      );
      console.log("\n[4/7] Deterministic narrative contract review");
      critiqueValue = await episodeStep(
        episode,
        "review_narrative",
        async () => deterministicReview(synthesisValue),
        (value) => ({ evidenceIds: synthesisValue.keyEvidence.map((item) => item.evidenceId), outputHashes: { critic: hashCanonical(value) }, note: "Contract validation only; not an independent scientific critic." }),
      );
      audits.push(deterministicAudit("synthesizer"), deterministicAudit("critic"));
      await writeJson(join(predictionDir, "synthesis_initial.json"), synthesisValue);
      await writeJson(join(predictionDir, "critic_review_initial.json"), critiqueValue);
      (manifest.stages as Record<string, unknown>).synthesisInitial = { status: "completed", mode: "deterministic", audit: audits[0] };
      (manifest.stages as Record<string, unknown>).criticInitial = { status: "completed", mode: "deterministic_contract", approved: critiqueValue.approved, audit: audits[1] };
      (manifest.stages as Record<string, unknown>).revision = { status: "skipped", reason: "deterministic narrative has no generative revision loop" };
      console.log("\n[5/7] Revision skipped in explicit deterministic mode");
    } else {
      console.log("\n[3/7] Pi SDK narrative synthesis AgentSession");
      let synthesis = await episodeStep(
        episode,
        "synthesize_narrative",
        () => runSynthesizer({ projectRoot: PROJECT_ROOT, runDir, evidenceBundle: blindEvidenceBundle, goPrediction: blindGoPrediction, label: "synthesis_initial" }),
        (value) => ({ evidenceIds: value.value.keyEvidence.map((item) => item.evidenceId), outputHashes: { narrative: hashCanonical(value.value) } }),
      );
      synthesisValue = synthesis.value;
      await writeJson(join(predictionDir, "synthesis_initial.json"), synthesisValue);
      audits.push(synthesis.audit);
      (manifest.stages as Record<string, unknown>).synthesisInitial = { status: "completed", audit: synthesis.audit };
      await writeJson(runManifestPath, manifest);

      console.log("\n[4/7] Pi SDK independent narrative critic AgentSession");
      let critique = await episodeStep(
        episode,
        "review_narrative",
        () => runCritic({ projectRoot: PROJECT_ROOT, runDir, evidenceBundle: blindEvidenceBundle, goPrediction: blindGoPrediction, prediction: synthesisValue, label: "critic_initial" }),
        (value) => ({ evidenceIds: synthesisValue.keyEvidence.map((item) => item.evidenceId), outputHashes: { critic: hashCanonical(value.value) } }),
      );
      critiqueValue = critique.value;
      await writeJson(join(predictionDir, "critic_review_initial.json"), critiqueValue);
      audits.push(critique.audit);
      (manifest.stages as Record<string, unknown>).criticInitial = { status: "completed", approved: critiqueValue.approved, audit: critique.audit };
      await writeJson(runManifestPath, manifest);

      let deterministicProblems = citationProblems(synthesisValue, blindEvidenceBundle);
      while ((!critiqueValue.approved || deterministicProblems.length > 0) && revisionCount < genome.genome.narrativePolicy.maxRevisionCycles) {
        revisionCount += 1;
        console.log(`\n[5/7] Controlled narrative revision ${revisionCount}/${genome.genome.narrativePolicy.maxRevisionCycles} and re-review`);
        const augmentedCritique: CriticReview = {
          ...critiqueValue,
          approved: false,
          citationIssues: [...critiqueValue.citationIssues, ...deterministicProblems],
          requiredRevisions: [...critiqueValue.requiredRevisions, ...deterministicProblems],
        };
        const suffix = revisionCount === 1 ? "revision" : `revision_${revisionCount}`;
        synthesis = await episodeStep(
          episode,
          `revise_narrative_${revisionCount}`,
          () => runSynthesizer({
            projectRoot: PROJECT_ROOT,
            runDir,
            evidenceBundle: blindEvidenceBundle,
            goPrediction: blindGoPrediction,
            previousPrediction: synthesisValue,
            criticReview: augmentedCritique,
            label: `synthesis_${suffix}`,
          }),
          (value) => ({ evidenceIds: value.value.keyEvidence.map((item) => item.evidenceId), outputHashes: { narrative: hashCanonical(value.value) } }),
        );
        synthesisValue = synthesis.value;
        await writeJson(join(predictionDir, `synthesis_${suffix}.json`), synthesisValue);
        critique = await episodeStep(
          episode,
          `review_revision_${revisionCount}`,
          () => runCritic({
            projectRoot: PROJECT_ROOT,
            runDir,
            evidenceBundle: blindEvidenceBundle,
            goPrediction: blindGoPrediction,
            prediction: synthesisValue,
            label: `critic_${suffix}`,
          }),
          (value) => ({ evidenceIds: synthesisValue.keyEvidence.map((item) => item.evidenceId), outputHashes: { critic: hashCanonical(value.value) } }),
        );
        critiqueValue = critique.value;
        await writeJson(join(predictionDir, `critic_review_${suffix}.json`), critiqueValue);
        audits.push(synthesis.audit, critique.audit);
        (manifest.stages as Record<string, unknown>)[revisionCount === 1 ? "revision" : `revision${revisionCount}`] = {
          status: "completed",
          approved: critiqueValue.approved,
          synthesisAudit: synthesis.audit,
          criticAudit: critique.audit,
        };
        await writeJson(runManifestPath, manifest);
        deterministicProblems = citationProblems(synthesisValue, blindEvidenceBundle);
      }
      if (revisionCount === 0) {
        console.log("\n[5/7] Revision not required; initial critic approved the narrative");
        (manifest.stages as Record<string, unknown>).revision = { status: "skipped", reason: "initial critic approved" };
      }
    }

    const finalCitationProblems = citationProblems(synthesisValue, blindEvidenceBundle);
    if (finalCitationProblems.length > 0) throw new Error(`Final narrative failed citation validation: ${finalCitationProblems.join("; ")}`);
    const finalDisclosureProblems = narrativeDisclosureProblems(synthesisValue, blindEvidenceBundle, blindGoPrediction);
    if (finalDisclosureProblems.length > 0) throw new Error(`Final narrative failed disclosure validation: ${finalDisclosureProblems.join("; ")}`);
    if (!critiqueValue.approved) throw new Error(`Final critic did not approve narrative: ${critiqueValue.requiredRevisions.join("; ")}`);
    await sanitizePiSessionFiles(runDir, PROJECT_ROOT);

    console.log("\n[6/7] Deterministic assembly of final function + GO result and reports");
    const finalPrediction: FinalPrediction = {
      ...synthesisValue,
      schemaVersion: "pi-function-prediction.v4",
      proteinId,
      targetMode,
      targetContext,
      narrativeMode,
      goPrediction: blindGoPrediction,
    };
    await writeJson(join(predictionDir, "final_prediction.json"), finalPrediction);
    await writeJson(join(predictionDir, "critic_review.json"), critiqueValue);
    await writeJson(join(predictionDir, "agent_audit.json"), audits);
    const reports = await writeReports({
      runDir,
      runId,
      prediction: finalPrediction,
      critic: critiqueValue,
      bundle: blindEvidenceBundle,
      audits,
      genome,
      quarantinedRecordCount: goPrediction.queryLikeAccessions.length,
    });
    (manifest.stages as Record<string, unknown>).report = {
      status: "completed",
      markdown: "prediction/function_prediction_report.md",
      html: "prediction/function_prediction_report.html",
    };

    episode.steps.push({
      name: "assemble_outputs",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      evidenceIds: finalPrediction.keyEvidence.map((item) => item.evidenceId),
      outputHashes: { finalPrediction: hashCanonical(finalPrediction), criticReview: hashCanonical(critiqueValue) },
      note: "The locked GO object was assembled by deterministic host gates plus any recorded bounded categorical judge result, then injected after narrative review.",
    } satisfies EpisodeStep);
    episode.status = "completed";
    episode.finishedAt = new Date().toISOString();
    episode.outputHashes = {
      genome: genome.genomeHash,
      goPredictionAudit: goPrediction.canonicalHash,
      ...(goPrediction.goJudgeStatus ? {
        goJudgeView: await sha256File(join(predictionDir, "go_judge_view.json")),
        goJudgeResult: await sha256File(join(predictionDir, "go_judge_result.json")),
        goJudgeAudit: await sha256File(join(predictionDir, "go_judge_audit.json")),
      } : {}),
      ...(goPrediction.semanticGoJudgeStatus ? {
        semanticGoJudgeView: await sha256File(join(predictionDir, "semantic_go_judge_view.json")),
        semanticGoJudgeResult: await sha256File(join(predictionDir, "semantic_go_judge_result.json")),
        semanticGoScoreSurface: await sha256File(join(predictionDir, "semantic_go_score_surface.tsv")),
      } : {}),
      blindGoPrediction: blindGoPrediction.canonicalHash,
      blindEvidenceBundle: hashCanonical(blindEvidenceBundle),
      goTsv: await sha256File(join(predictionDir, "go_predictions.tsv")),
      evidenceBundle: hashCanonical(evidenceBundle),
      evidenceManifest: await sha256File(join(runDir, "evidence_manifest.json")),
      finalPrediction: await sha256File(join(predictionDir, "final_prediction.json")),
      criticReview: await sha256File(join(predictionDir, "critic_review.json")),
      agentAudit: await sha256File(join(predictionDir, "agent_audit.json")),
      markdownReport: await sha256File(reports.markdown),
      htmlReport: await sha256File(reports.html),
    };
    await writeJson(join(predictionDir, "episode_trace.json"), episode);

    manifest.status = "completed";
    manifest.finishedAt = new Date().toISOString();
    manifest.outputs = {
      evidenceBundle: "evidence/evidence_bundle.json",
      blindEvidenceBundle: "evidence/blind_evidence_bundle.json",
      goAudit: "prediction/go_predictions.json",
      goPrediction: "prediction/blind_go_view.json",
      goTsv: "prediction/go_predictions.tsv",
      ...(goPrediction.goJudgeStatus ? {
        goJudgeView: "prediction/go_judge_view.json",
        goJudgeResult: "prediction/go_judge_result.json",
        goJudgeAudit: "prediction/go_judge_audit.json",
      } : {}),
      ...(goPrediction.semanticGoJudgeStatus ? {
        semanticGoJudgeView: "prediction/semantic_go_judge_view.json",
        semanticGoJudgeResult: "prediction/semantic_go_judge_result.json",
        semanticGoScoreSurface: "prediction/semantic_go_score_surface.tsv",
      } : {}),
      prediction: "prediction/final_prediction.json",
      critic: "prediction/critic_review.json",
      genome: "prediction/agent_genome.json",
      episode: "prediction/episode_trace.json",
      markdownReport: "prediction/function_prediction_report.md",
      htmlReport: "prediction/function_prediction_report.html",
      redactionReport: "input/redaction_report.json",
    };
    await writeJson(runManifestPath, manifest);

    console.log("\n[7/7] Validating hashes, GO decisions, provenance, genome, episode, and reports");
    const validation = await validateRunArtifacts(runDir);
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.ok) throw new Error(`Generated run failed artifact validation: ${validation.issues.join("; ")}`);

    console.log(`\nPipeline completed successfully.\nRun: ${runDir}\nPrediction: ${finalPrediction.mostLikelyFunction}\nConfidence: ${finalPrediction.confidence}\nQuarantined query GO: ${goPrediction.quarantinedGoIds.join(", ") || "none"}\nPredicted GO: ${goPrediction.predictedGoIds.join(", ") || "abstained"}\nReport: ${reports.markdown}`);
    return 0;
  } catch (error) {
    const persistedError = sanitizePersistedError(
      error instanceof Error ? error.message : String(error),
      persistedSensitiveIdentities,
      [runDir, PROJECT_ROOT, process.env.HOME],
    );
    episode.status = "failed";
    episode.finishedAt = new Date().toISOString();
    for (const step of episode.steps) {
      if (step.status === "failed" && typeof step.note === "string") {
        step.note = sanitizePersistedError(
          step.note,
          persistedSensitiveIdentities,
          [runDir, PROJECT_ROOT, process.env.HOME],
        );
      }
    }
    await writeJson(join(predictionDir, "episode_trace.json"), episode);
    manifest.status = "failed";
    manifest.finishedAt = new Date().toISOString();
    manifest.error = persistedError;
    await writeJson(runManifestPath, manifest);
    throw error;
  }
}

export async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return 0;
  }
  if (command === "doctor") {
    const managedConfig = join(PROJECT_ROOT, "config", "managed.env");
    const configPath = resolve(option(args, "--config") ?? (await exists(managedConfig) ? managedConfig : join(PROJECT_ROOT, "config", "local.env")));
    configureSdkNetwork(loadRuntimeEnv(configPath));
    return await doctorEvidenceBackend(configPath);
  }
  if (command === "validate") {
    const runDir = option(args, "--run-dir");
    if (!runDir) throw new Error("validate requires --run-dir");
    const validation = await validateRunArtifacts(resolve(runDir));
    console.log(JSON.stringify(validation, null, 2));
    return validation.ok ? 0 : 1;
  }
  if (command === "predict") return await predict(args);
  if (command === "z86-bridge") return await z86BridgeCommand(args);
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

const invokedAsProgram = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedAsProgram) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`\nERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
