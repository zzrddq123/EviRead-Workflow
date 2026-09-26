import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  completeRsiEvaluationFromResultFile,
  createDetachedRsiWorktree,
  inspectRsiVersionGraph,
  openRsiEvaluationFromProtocolFile,
  prepareRsiPrimaryCheckout,
  publishRsiAdaptiveEvaluationFromStateRoot,
  publishRsiEvaluationFromResultFile,
  recordRsiDeveloperExploration,
  recordRsiEpochResume,
  recordRsiDecision,
  recordRsiRetrospectiveExperiment,
  recordRsiRetrospectiveIncumbent,
  registerRsiCodeVersion,
  renderRsiVersionTree,
  writeRsiExplorationTree,
  writeRsiHistoryArtifact,
  type RsiDecisionAction,
  type RsiEvaluationResultKind,
} from "./rsi_version_graph.js";
import {
  createRsiRetrospectiveArchive,
  verifyRsiRetrospectiveArchive,
  type RsiRetrospectiveArchiveSpec,
} from "./rsi_retrospective_archive.js";

function parseOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (!raw.startsWith("--")) {
      throw new Error(`unexpected RSI version positional argument: ${raw}`);
    }
    const separator = raw.indexOf("=");
    const name = separator < 0 ? raw : raw.slice(0, separator);
    if (!allowed.has(name)) throw new Error(`unknown RSI version option: ${name}`);
    if (options.has(name)) throw new Error(`duplicate RSI version option: ${name}`);
    const value = separator < 0 ? args[index + 1] : raw.slice(separator + 1);
    if (!value || (separator < 0 && value.startsWith("--"))) {
      throw new Error(`${name} requires a value`);
    }
    options.set(name, value);
    if (separator < 0) index += 1;
  }
  return options;
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function repository(options: ReadonlyMap<string, string>): string {
  const value = required(options, "--repo");
  if (!isAbsolute(value)) {
    throw new Error("--repo must be an explicit absolute path");
  }
  return resolve(value);
}

function remote(options: ReadonlyMap<string, string>): string {
  return required(options, "--remote");
}

function common(...extra: string[]): Set<string> {
  return new Set(["--repo", "--remote", ...extra]);
}

export interface RsiStableControllerBinding
  extends Record<string, unknown> {
  bundleHash: string;
  bundleRoot: string;
  manifestPath: string;
  runnerPath: string;
  nodeExecutablePath: string;
  invocation: readonly [string, string];
  controllerSourceRef: string;
  controllerSourceCommit: string;
  controllerSourceTree: string;
  reusedExistingBundle: boolean;
}

export async function rsiVersionCommand(
  command: string,
  args: string[],
  runtime: {
    stableController?: RsiStableControllerBinding;
  } = {},
): Promise<number> {
  if (command === "rsi-retrospective-archive-create") {
    const options = parseOptions(args, new Set([
      "--source-root",
      "--spec",
      "--output-dir",
    ]));
    const specPath = resolve(required(options, "--spec"));
    let spec: RsiRetrospectiveArchiveSpec;
    try {
      spec = JSON.parse(
        await readFile(specPath, "utf8"),
      ) as RsiRetrospectiveArchiveSpec;
    } catch {
      throw new Error(
        "--spec must name a readable retrospective archive JSON specification",
      );
    }
    const result = await createRsiRetrospectiveArchive({
      sourceRoot: resolve(required(options, "--source-root")),
      outputDir: resolve(required(options, "--output-dir")),
      spec,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "rsi-retrospective-archive-verify") {
    const options = parseOptions(args, new Set(["--archive-dir"]));
    const result = await verifyRsiRetrospectiveArchive(
      resolve(required(options, "--archive-dir")),
    );
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "rsi-version-register") {
    const options = parseOptions(args, common(
      "--version-id",
      "--parent-version",
      "--change-summary",
      "--hypothesis",
      "--verification-receipt",
      "--developer-context",
      "--developer-exploration",
      "--epoch-resume",
      "--retrospective-incumbent",
    ));
    const result = await registerRsiCodeVersion({
      repositoryRoot: repository(options),
      versionId: required(options, "--version-id"),
      parentVersionId: options.get("--parent-version"),
      changeSummary: required(options, "--change-summary"),
      hypothesis: required(options, "--hypothesis"),
      verificationReceiptPath: resolve(required(options, "--verification-receipt")),
      developerContextPath: options.has("--developer-context")
        ? resolve(required(options, "--developer-context"))
        : undefined,
      developerExplorationId: options.get("--developer-exploration"),
      epochResumeId: options.get("--epoch-resume"),
      retrospectiveIncumbentId:
        options.get("--retrospective-incumbent"),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      versionId: result.manifest.versionId,
      sourceCommit: result.manifest.sourceCommit,
      sourceTree: result.manifest.sourceTree,
      manifestHash: result.manifest.canonicalHash,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
      parentVersionId: result.manifest.parent?.versionId ?? null,
      developerExplorationId:
        result.manifest.developmentPlan?.schemaVersion
            === "pi-rsi-developer-exploration.v1"
          ? result.manifest.developmentPlan.explorationId
          : null,
      epochResumeId:
        result.manifest.developmentPlan?.schemaVersion
            === "pi-rsi-epoch-resume.v1"
          ? result.manifest.developmentPlan.resumeId
          : null,
      retrospectiveIncumbentId:
        result.manifest.developmentPlan?.schemaVersion
            === "pi-rsi-retrospective-incumbent.v1"
          ? result.manifest.developmentPlan.adoptionId
          : null,
      developerPlanHash:
        result.manifest.developmentPlan?.planHash ?? null,
      publishedRemote: remote(options),
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-evaluation-open") {
    const options = parseOptions(args, common(
      "--version-id",
      "--evaluation-id",
      "--protocol-id",
      "--protocol-file",
    ));
    const result = await openRsiEvaluationFromProtocolFile({
      repositoryRoot: repository(options),
      versionId: required(options, "--version-id"),
      evaluationId: required(options, "--evaluation-id"),
      protocolId: required(options, "--protocol-id"),
      protocolPath: resolve(required(options, "--protocol-file")),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      evaluationId: result.manifest.evaluationId,
      versionId: result.manifest.version.versionId,
      openingHash: result.manifest.canonicalHash,
      protocol: result.manifest.protocol,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
      state: result.manifest.state,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-evaluation-complete") {
    const options = parseOptions(args, common(
      "--evaluation-id",
      "--result-kind",
      "--result-file",
      "--state-root-dir",
      "--claim-boundary",
    ));
    const kind = required(options, "--result-kind") as RsiEvaluationResultKind;
    if (!["adaptive_development", "software_verification", "frozen_replay"].includes(kind)) {
      throw new Error("--result-kind is unsupported");
    }
    const result = await completeRsiEvaluationFromResultFile({
      repositoryRoot: repository(options),
      evaluationId: required(options, "--evaluation-id"),
      resultKind: kind,
      resultPath: resolve(required(options, "--result-file")),
      stateRoot: options.has("--state-root-dir")
        ? { archiveDir: resolve(required(options, "--state-root-dir")) }
        : undefined,
      claimBoundary: required(options, "--claim-boundary"),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      evaluationId: result.manifest.evaluationId,
      versionId: result.manifest.version.versionId,
      resultManifestHash: result.manifest.canonicalHash,
      result: result.manifest.result,
      stateRoot: result.manifest.stateRoot,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
      state: result.manifest.state,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-evaluation-publish") {
    const options = parseOptions(args, common(
      "--evaluation-id",
      "--publication-mode",
      "--result-file",
      "--state-root-dir",
      "--claim-boundary",
    ));
    const publicationMode = required(options, "--publication-mode");
    if (publicationMode !== "prospective"
      && publicationMode !== "retrospective_legacy") {
      throw new Error(
        "--publication-mode must be prospective or retrospective_legacy",
      );
    }
    if (options.has("--result-file") === options.has("--state-root-dir")) {
      throw new Error(
        "exactly one of --result-file or --state-root-dir is required",
      );
    }
    const commonInput = {
      repositoryRoot: repository(options),
      evaluationId: required(options, "--evaluation-id"),
      publicationMode,
      claimBoundary: required(options, "--claim-boundary"),
      remote: remote(options),
    } as const;
    const result = options.has("--state-root-dir")
      ? await publishRsiAdaptiveEvaluationFromStateRoot({
        ...commonInput,
        stateRootArchiveDir: resolve(required(options, "--state-root-dir")),
      })
      : await publishRsiEvaluationFromResultFile({
        ...commonInput,
        resultPath: resolve(required(options, "--result-file")),
      });
    console.log(JSON.stringify({
      evaluationId: result.manifest.evaluationId,
      versionId: result.manifest.version.versionId,
      publicationHash: result.manifest.canonicalHash,
      publicationMode: result.manifest.publicationMode,
      summaryKind: result.manifest.publicSummary.kind,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-decide") {
    const options = parseOptions(args, common(
      "--decision-id",
      "--evaluation-id",
      "--action",
      "--selected-version",
      "--rationale",
    ));
    const action = required(options, "--action") as RsiDecisionAction;
    if (action !== "continue" && action !== "backtrack"
      && action !== "retain") {
      throw new Error("--action must be continue, backtrack, or retain");
    }
    const result = await recordRsiDecision({
      repositoryRoot: repository(options),
      decisionId: required(options, "--decision-id"),
      evaluationId: required(options, "--evaluation-id"),
      action,
      selectedVersionId: required(options, "--selected-version"),
      rationale: required(options, "--rationale"),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      decisionId: result.manifest.decisionId,
      decisionHash: result.manifest.canonicalHash,
      action: result.manifest.action,
      selectionBefore: result.manifest.selectionBefore.versionId,
      candidateVersion: result.manifest.candidateVersion.versionId,
      selectedVersion: result.manifest.selectedVersion.versionId,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-exploration-record") {
    const options = parseOptions(args, common(
      "--exploration-id",
      "--plan-spec",
    ));
    const result = await recordRsiDeveloperExploration({
      repositoryRoot: repository(options),
      explorationId: required(options, "--exploration-id"),
      planSpecPath: resolve(required(options, "--plan-spec")),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      explorationId: result.manifest.explorationId,
      sourceVersionId: result.manifest.sourceVersion.versionId,
      baseVersionId: result.manifest.baseVersion.versionId,
      evaluationId: result.manifest.evaluation.evaluationId,
      action: result.manifest.nextOptimizationPlan.action,
      plannedVersionId:
        result.manifest.nextOptimizationPlan.plannedVersionId,
      evaluationAnalysisHash:
        result.manifest.evaluationAnalysis.canonicalHash,
      developerPlanHash:
        result.manifest.nextOptimizationPlan.canonicalHash,
      manifestHash: result.manifest.canonicalHash,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-retrospective-record") {
    const options = parseOptions(args, common(
      "--record-id",
      "--receipt",
      "--archive-seal-hash",
      "--archive-public-manifest-hash",
    ));
    const result = await recordRsiRetrospectiveExperiment({
      repositoryRoot: repository(options),
      recordId: required(options, "--record-id"),
      receiptPath: resolve(required(options, "--receipt")),
      archiveSealHash: required(options, "--archive-seal-hash"),
      archivePublicManifestHash:
        required(options, "--archive-public-manifest-hash"),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      recordId: result.manifest.recordId,
      recordCommit: result.manifest.recordCommit.sourceCommit,
      evaluatedCommit: result.manifest.evaluatedSource.sourceCommit,
      receipt: result.manifest.receipt,
      selectedVersionId:
        result.manifest.formalSelection.selectedVersion.versionId,
      localGateOutcome: result.manifest.experiment.localGateOutcome,
      archive: result.manifest.archive,
      manifestHash: result.manifest.canonicalHash,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-epoch-resume") {
    const options = parseOptions(args, common(
      "--resume-id",
      "--spec",
    ));
    const result = await recordRsiEpochResume({
      repositoryRoot: repository(options),
      resumeId: required(options, "--resume-id"),
      specPath: resolve(required(options, "--spec")),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      resumeId: result.manifest.resumeId,
      epochId: result.manifest.nextEpoch.epochId,
      terminalExplorationId:
        result.manifest.terminalStop.explorationId,
      selectedVersionId:
        result.manifest.selectedVersion.versionId,
      baseVersionId: result.manifest.baseVersion.versionId,
      plannedVersionId: result.manifest.nextEpoch.plannedVersionId,
      planHash: result.manifest.nextEpoch.planHash,
      manifestHash: result.manifest.canonicalHash,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-incumbent-adopt") {
    const options = parseOptions(args, common(
      "--adoption-id",
      "--spec",
    ));
    const result = await recordRsiRetrospectiveIncumbent({
      repositoryRoot: repository(options),
      adoptionId: required(options, "--adoption-id"),
      specPath: resolve(required(options, "--spec")),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      adoptionId: result.manifest.adoptionId,
      currentBestVersionId:
        result.manifest.incumbentVersion.versionId,
      lastProspectivelySelectedVersionId:
        result.manifest.formalSelection.selectedVersion.versionId,
      selectedVersionId:
        result.manifest.formalSelection.selectedVersion.versionId,
      operationalIncumbentVersionId:
        result.manifest.incumbentVersion.versionId,
      plannedVersionId:
        result.manifest.nextCandidate.plannedVersionId,
      evidence: result.manifest.evidence,
      planHash: result.manifest.nextCandidate.planHash,
      manifestHash: result.manifest.canonicalHash,
      tagRef: result.ref,
      tagObjectId: result.tagObjectId,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-exploration-export") {
    const options = parseOptions(args, common("--output-dir"));
    const graph = await inspectRsiVersionGraph(
      repository(options),
      remote(options),
    );
    const result = await writeRsiExplorationTree({
      graph,
      outputDir: resolve(required(options, "--output-dir")),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "rsi-version-fork") {
    const options = parseOptions(args, common(
      "--from-version",
      "--developer-exploration",
      "--worktree",
      "--developer-context-output",
    ));
    const result = await createDetachedRsiWorktree({
      repositoryRoot: repository(options),
      fromVersionId: required(options, "--from-version"),
      developerExplorationId:
        required(options, "--developer-exploration"),
      worktreePath: resolve(required(options, "--worktree")),
      developerContextOutputPath: options.has("--developer-context-output")
        ? resolve(required(options, "--developer-context-output"))
        : undefined,
      remote: remote(options),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "rsi-version-prepare") {
    const options = parseOptions(args, common(
      "--from-version",
      "--developer-exploration",
      "--retrospective-incumbent",
      "--branch",
      "--developer-context-output",
    ));
    const repositoryRoot = repository(options);
    const developerContextOutputPath = required(
      options,
      "--developer-context-output",
    );
    if (!isAbsolute(developerContextOutputPath)) {
      throw new Error(
        "--developer-context-output must be an explicit absolute path",
      );
    }
    if (!runtime.stableController) {
      throw new Error(
        "rsi-version-prepare requires a verified stable controller bundle",
      );
    }
    const result = await prepareRsiPrimaryCheckout({
      repositoryRoot,
      developerExplorationId:
        options.get("--developer-exploration"),
      retrospectiveIncumbentId:
        options.get("--retrospective-incumbent"),
      branchName: required(options, "--branch"),
      developerContextOutputPath:
        resolve(developerContextOutputPath),
      expectedFromVersionId: options.get("--from-version"),
      remote: remote(options),
    });
    console.log(JSON.stringify({
      ...result,
      stableController: runtime.stableController,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-developer-context"
    || command === "rsi-version-paper-export") {
    const options = parseOptions(args, new Set([
      "--repo",
      "--remote",
      "--format",
      "--output",
    ]));
    const graph = await inspectRsiVersionGraph(
      repository(options),
      remote(options),
    );
    const format = options.get("--format")
      ?? (command === "rsi-version-developer-context" ? "json" : "markdown");
    if ((command === "rsi-version-developer-context" && format !== "json")
      || (command === "rsi-version-paper-export"
        && format !== "json" && format !== "markdown")) {
      throw new Error(
        command === "rsi-version-developer-context"
          ? "--format must be json"
          : "--format must be json or markdown",
      );
    }
    const kind = command === "rsi-version-developer-context"
      ? "developer_context"
      : format === "json"
        ? "paper_json"
        : "paper_markdown";
    const result = await writeRsiHistoryArtifact({
      graph,
      kind,
      outputPath: resolve(required(options, "--output")),
    });
    console.log(JSON.stringify({
      kind,
      ...result,
      eventCount: graph.events.length,
      currentBestVersionId: graph.currentBestVersionId,
      lastProspectivelySelectedVersionId:
        graph.selectedVersionId,
      selectedVersionId: graph.selectedVersionId,
      operationalIncumbentVersionId:
        graph.operationalIncumbentVersionId,
      proteinEvaluationIncompleteVersionIds:
        graph.proteinEvaluationIncompleteVersionIds,
      unreflectedTerminalVersionIds:
        graph.unreflectedTerminalVersionIds,
      readyForNextVersion: graph.readyForNextVersion,
      historyComplete: graph.historyComplete,
      evaluationComplete: graph.evaluationComplete,
      paperComplete: graph.paperComplete,
    }, null, 2));
    return 0;
  }
  if (command === "rsi-version-tree" || command === "rsi-version-verify") {
    const options = parseOptions(args, new Set([
      "--repo",
      "--remote",
      "--format",
    ]));
    const format = options.get("--format") ?? (command === "rsi-version-tree" ? "text" : "json");
    if (format !== "text" && format !== "json") {
      throw new Error("--format must be text or json");
    }
    const graph = await inspectRsiVersionGraph(
      repository(options),
      remote(options),
    );
    if (format === "text") {
      console.log(renderRsiVersionTree(graph));
    } else {
      console.log(JSON.stringify({
        ok: true,
        rootVersionId: graph.rootVersionId,
        currentBestVersionId: graph.currentBestVersionId,
        lastProspectivelySelectedVersionId:
          graph.selectedVersionId,
        selectedVersionId: graph.selectedVersionId,
        operationalIncumbentVersionId:
          graph.operationalIncumbentVersionId,
        decisionHeadId: graph.decisionHeadId,
        versionCount: graph.versions.length,
        evaluationOpeningCount: graph.evaluationOpenings.length,
        evaluationResultCount: graph.evaluationResults.length,
        evaluationPublicationCount: graph.evaluationPublications.length,
        decisionCount: graph.decisions.length,
        developerExplorationCount:
          graph.developerExplorations.length,
        epochResumeCount: graph.epochResumes.length,
        retrospectiveExperimentCount:
          graph.retrospectiveExperiments.length,
        retrospectiveIncumbentCount:
          graph.retrospectiveIncumbents.length,
        eventCount: graph.events.length,
        incompleteEvaluationIds: graph.incompleteEvaluationIds,
        unpublishedEvaluationIds: graph.unpublishedEvaluationIds,
        undecidedEvaluationIds: graph.undecidedEvaluationIds,
        unevaluatedVersionIds: graph.unevaluatedVersionIds,
        unresolvedVersionIds: graph.unresolvedVersionIds,
        retrospectivelyAdoptedVersionIds:
          graph.retrospectivelyAdoptedVersionIds,
        proteinEvaluationIncompleteVersionIds:
          graph.proteinEvaluationIncompleteVersionIds,
        unreflectedTerminalVersionIds:
          graph.unreflectedTerminalVersionIds,
        readyForNextVersion: graph.readyForNextVersion,
        historyComplete: graph.historyComplete,
        evaluationComplete: graph.evaluationComplete,
        paperComplete: graph.paperComplete,
        versions: graph.versions.map((item) => ({
          versionId: item.manifest.versionId,
          parentVersionId: item.manifest.parent?.versionId ?? null,
          sourceCommit: item.manifest.sourceCommit,
          sourceTree: item.manifest.sourceTree,
          manifestHash: item.manifest.canonicalHash,
          tagObjectId: item.tagObjectId,
        })),
        retrospectiveExperiments:
          graph.retrospectiveExperiments.map((item) => ({
            recordId: item.manifest.recordId,
            recordCommit: item.manifest.recordCommit.sourceCommit,
            evaluatedCommit:
              item.manifest.evaluatedSource.sourceCommit,
            selectedVersionId:
              item.manifest.formalSelection.selectedVersion.versionId,
            localGateOutcome:
              item.manifest.experiment.localGateOutcome,
            manifestHash: item.manifest.canonicalHash,
            tagObjectId: item.tagObjectId,
          })),
        epochResumes:
          graph.epochResumes.map((item) => ({
            resumeId: item.manifest.resumeId,
            epochId: item.manifest.nextEpoch.epochId,
            terminalExplorationId:
              item.manifest.terminalStop.explorationId,
            selectedVersionId:
              item.manifest.selectedVersion.versionId,
            baseVersionId: item.manifest.baseVersion.versionId,
            plannedVersionId:
              item.manifest.nextEpoch.plannedVersionId,
            manifestHash: item.manifest.canonicalHash,
            tagObjectId: item.tagObjectId,
          })),
        retrospectiveIncumbents:
          graph.retrospectiveIncumbents.map((item) => ({
            adoptionId: item.manifest.adoptionId,
            selectedVersionId:
              item.manifest.formalSelection.selectedVersion.versionId,
            operationalIncumbentVersionId:
              item.manifest.incumbentVersion.versionId,
            plannedVersionId:
              item.manifest.nextCandidate.plannedVersionId,
            planHash: item.manifest.nextCandidate.planHash,
            manifestHash: item.manifest.canonicalHash,
            tagObjectId: item.tagObjectId,
          })),
      }, null, 2));
    }
    return 0;
  }
  throw new Error(`unsupported RSI version command: ${command}`);
}
