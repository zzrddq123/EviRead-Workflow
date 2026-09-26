import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { option, PROJECT_ROOT } from "./config.js";
import { hashCanonical, sha256File, sha256Text } from "./hash.js";

const execFileAsync = promisify(execFile);

const GROUPS = ["group_1", "group_2", "group_3", "group_4"] as const;
type Z86Group = typeof GROUPS[number];
type ScoreSurface = "final" | "evidence";
type Z86Subcommand = "prepare-inputs" | "export" | "evaluate";

interface TargetRecord {
  group: Z86Group;
  groupOrder: number;
  proteinId: string;
  relativePath?: string;
  sequenceSha256?: string;
  structureSha256?: string;
}

interface ExportCaseReceipt {
  targetId: string;
  status: "completed" | "missing_abstention";
  runManifestSha256?: string;
  goPredictionSha256?: string;
  exportedUniqueTerms?: number;
  eligibleCandidateRows?: number;
  operationalSelectedTerms?: number;
}

interface GroupExportReceipt {
  group: Z86Group;
  targetCount: number;
  completedRunCount: number;
  missingAbstentionCount: number;
  rowCount: number;
  predictionFile: { path: string; sha256: string };
  cases: ExportCaseReceipt[];
}

function usage(): string {
  return `Z86 benchmark bridge

Commands:
  ./pi-agent z86-bridge prepare-inputs --benchmark /path/to/z86-function-198-pair-clean-v2 --output-root /tmp/z86-inputs [--groups group_4] [--limit-per-group 2]
  ./pi-agent z86-bridge export --benchmark /path/to/z86-function-198-pair-clean-v2 --runs-root /path/to/runs --predictions /tmp/predictions --receipt /tmp/export.json [--groups group_1,group_2,group_3,group_4] [--score-surface final|evidence] [--allow-missing]
  ./pi-agent z86-bridge evaluate --benchmark /path/to/z86-function-198-pair-clean-v2 --private /path/to/private --predictions /tmp/predictions --output /tmp/aggregate.json [--track gold_v1|gold_v2]

The bridge exports target_id/go_id/score TSV files for the canonical Z86 evaluator. It reads only run outputs and public benchmark resources unless --private is supplied to evaluate.`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function parseGroups(value: string | undefined, defaultGroups: readonly Z86Group[] = GROUPS): Z86Group[] {
  if (!value) return [...defaultGroups];
  const groups = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (groups.length === 0) throw new Error("--groups must not be empty");
  for (const group of groups) {
    if (!(GROUPS as readonly string[]).includes(group)) throw new Error(`unsupported Z86 group: ${group}`);
  }
  return [...new Set(groups)] as Z86Group[];
}

function groupOrderValue(value: string): number {
  const numberValue = Number.parseInt(value, 10);
  if (!Number.isInteger(numberValue) || numberValue <= 0) throw new Error(`invalid group order: ${value}`);
  return numberValue;
}

export async function loadTargetRecords(benchmarkRoot: string): Promise<TargetRecord[]> {
  const tablePath = join(resolve(benchmarkRoot), "resources", "target_structure_groups.tsv");
  const text = await readFile(tablePath, "utf8");
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Z86 target structure table is empty");
  const header = lines[0]!.split("\t");
  const index = Object.fromEntries(header.map((name, offset) => [name, offset]));
  for (const required of ["group", "groupOrder", "proteinId"]) {
    if (!(required in index)) throw new Error(`Z86 target structure table missing column: ${required}`);
  }
  const records: TargetRecord[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const row = raw.split("\t");
    const group = row[index.group!] as Z86Group;
    if (!(GROUPS as readonly string[]).includes(group)) throw new Error(`unsupported Z86 group in table: ${group}`);
    const proteinId = row[index.proteinId!] ?? "";
    if (!/^Z69T\d+$/.test(proteinId)) throw new Error(`invalid Z86 target ID: ${proteinId}`);
    if (seen.has(proteinId)) throw new Error(`duplicate Z86 target ID: ${proteinId}`);
    seen.add(proteinId);
    records.push({
      group,
      groupOrder: groupOrderValue(row[index.groupOrder!] ?? ""),
      proteinId,
      relativePath: index.relativePath === undefined ? undefined : row[index.relativePath],
      sequenceSha256: index.sequenceSha256 === undefined ? undefined : row[index.sequenceSha256],
      structureSha256: index.sha256 === undefined ? undefined : row[index.sha256],
    });
  }
  return records.sort((left, right) => left.group.localeCompare(right.group) || left.groupOrder - right.groupOrder);
}

function targetsByGroup(records: readonly TargetRecord[], groups: readonly Z86Group[]): Map<Z86Group, TargetRecord[]> {
  const requested = new Set(groups);
  const output = new Map<Z86Group, TargetRecord[]>();
  for (const group of groups) output.set(group, []);
  for (const record of records) {
    if (requested.has(record.group)) output.get(record.group)!.push(record);
  }
  return output;
}

const THREE_TO_ONE: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  SEC: "U", PYL: "O", ASX: "B", GLX: "Z", XLE: "J", UNK: "X",
};

function decodeModelCifSequence(raw: string): string {
  const tokens = [...raw.matchAll(/\(([A-Za-z0-9]{3})\)|([A-Z])/g)];
  const sequence = tokens.map((match) => {
    if (match[1]) return THREE_TO_ONE[match[1].toUpperCase()] ?? "X";
    return match[2] ?? "X";
  }).join("");
  if (!sequence) throw new Error("mmCIF sequence block is empty");
  return sequence;
}

export function extractModelCifCanonicalSequence(text: string): string {
  const start = text.indexOf("_entity_poly.pdbx_seq_one_letter_code");
  if (start < 0) throw new Error("mmCIF lacks an entity polymer sequence block");
  const nextSection = text.indexOf("\n#", start);
  const section = text.slice(start, nextSection < 0 ? undefined : nextSection);
  const blocks = [...section.matchAll(/\n;([\s\S]*?)\n;/g)]
    .map((match) => decodeModelCifSequence(match[1]))
    .sort((left, right) => [...left].filter((value) => value === "X").length - [...right].filter((value) => value === "X").length);
  if (blocks.length > 0) return blocks[0]!;
  const inline = section.match(/_entity_poly\.pdbx_seq_one_letter_code_can\s+([^\n]+)/)
    ?? section.match(/_entity_poly\.pdbx_seq_one_letter_code\s+([^\n]+)/);
  if (inline) return decodeModelCifSequence(inline[1]);
  throw new Error("mmCIF lacks an entity polymer sequence block");
}

function fastaText(sequence: string): string {
  const lines = sequence.match(/.{1,80}/g) ?? [];
  return `>anonymous_query\n${lines.join("\n")}\n`;
}

export async function prepareZ86Inputs(args: string[]): Promise<number> {
  const benchmarkRoot = resolve(option(args, "--benchmark") ?? "");
  const outputRoot = resolve(option(args, "--output-root") ?? "");
  if (!benchmarkRoot || benchmarkRoot === PROJECT_ROOT) throw new Error("prepare-inputs requires --benchmark");
  if (!outputRoot || outputRoot === PROJECT_ROOT) throw new Error("prepare-inputs requires --output-root");
  const groups = parseGroups(option(args, "--groups"));
  const limitValue = option(args, "--limit-per-group");
  const limitPerGroup = limitValue === undefined ? null : Number.parseInt(limitValue, 10);
  if (limitPerGroup !== null && (!Number.isInteger(limitPerGroup) || limitPerGroup < 1)) throw new Error("--limit-per-group must be a positive integer");
  const records = targetsByGroup(await loadTargetRecords(benchmarkRoot), groups);
  const written: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const selected = (records.get(group) ?? []).slice(0, limitPerGroup ?? undefined);
    for (const record of selected) {
      if (!record.relativePath) throw new Error(`Z86 target ${record.proteinId} lacks a structure relativePath`);
      const structureSource = join(benchmarkRoot, "resources", record.relativePath);
      const sequence = extractModelCifCanonicalSequence(await readFile(structureSource, "utf8"));
      if (record.sequenceSha256 && sha256Text(sequence) !== record.sequenceSha256) {
        throw new Error(`sequence hash mismatch for ${record.proteinId}`);
      }
      const caseDir = join(outputRoot, group, record.proteinId);
      await mkdir(caseDir, { recursive: true });
      await writeFile(join(caseDir, "sequence.fasta"), fastaText(sequence), "utf8");
      await copyFile(structureSource, join(caseDir, basename(structureSource)));
      written.push({
        targetId: record.proteinId,
        group,
        groupOrder: record.groupOrder,
        inputDir: relative(outputRoot, caseDir),
        sequenceFastaSha256: await sha256File(join(caseDir, "sequence.fasta")),
        sequenceContentSha256: sha256Text(sequence),
        structureFile: basename(structureSource),
        structureSha256: await sha256File(join(caseDir, basename(structureSource))),
        predictionCommand: `./pi-agent predict --input-dir ${caseDir} --run-name ${record.proteinId} --config <config.env>`,
      });
    }
  }
  const body = {
    schemaVersion: "pi-z86-bridge-inputs.v1",
    suiteId: "z86-function-198-pair-clean-v2",
    benchmarkRoot: relative(PROJECT_ROOT, benchmarkRoot).startsWith("..") ? benchmarkRoot : relative(PROJECT_ROOT, benchmarkRoot),
    groups,
    targetCount: written.length,
    inputs: written,
    note: "FASTA headers are anonymous. The copied mmCIF companion structures are retained for operator inspection; the current R09 predict input sanitizer accepts PDB ATOM/HETATM coordinates, so sequence-only prediction is the portable default unless a mmCIF-to-PDB conversion step is supplied.",
  };
  await writeJson(join(outputRoot, "z86_inputs_manifest.json"), { ...body, canonicalHash: hashCanonical(body) });
  console.log(`Prepared ${written.length} Z86 input case(s) under ${outputRoot}`);
  return 0;
}

function finiteScore(value: unknown, label: string): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) throw new Error(`${label} score is outside [0,1]`);
  return value;
}

function termScore(term: Record<string, unknown>, surface: ScoreSurface): number | null {
  const keys = surface === "evidence"
    ? ["judgeAdjustedScore", "phylogenyAdjustedScore", "rawScore"]
    : ["fusionAdjustedScore", "semanticAdjustedScore", "judgeAdjustedScore", "phylogenyAdjustedScore", "rawScore"];
  for (const key of keys) {
    const score = finiteScore(term[key], key);
    if (score !== null) return score;
  }
  return null;
}

async function readRunPrediction(runDir: string, targetId: string, scoreSurface: ScoreSurface): Promise<{ rows: Map<string, number>; receipt: ExportCaseReceipt }> {
  const manifestPath = join(runDir, "run_manifest.json");
  const predictionPath = join(runDir, "prediction", "go_predictions.json");
  const manifest = await readJson<Record<string, unknown>>(manifestPath);
  if (manifest.status !== "completed") throw new Error(`${targetId} run is not completed`);
  if (manifest.runId !== targetId) throw new Error(`${targetId} run is not target-bound; use --run-name ${targetId} when predicting benchmark cases`);
  const prediction = await readJson<Record<string, unknown>>(predictionPath);
  if (prediction.schemaVersion !== "pi-go-prediction.v2" && prediction.schemaVersion !== "pi-go-prediction.v3") {
    throw new Error(`${targetId} has unsupported GO prediction schema`);
  }
  if ((prediction.identityPolicy !== "strict_blind_v1" && prediction.identityPolicy !== "temporal_t0_v1") || prediction.targetMode !== "anonymous" || prediction.queryAccession !== null) {
    throw new Error(`${targetId} authoritative GO prediction has an unsupported identity policy`);
  }
  const rows = new Map<string, number>();
  let eligibleCandidateRows = 0;
  let operationalSelectedTerms = 0;
  const terms = Array.isArray(prediction.terms) ? prediction.terms : [];
  for (const rawTerm of terms) {
    if (!rawTerm || typeof rawTerm !== "object" || Array.isArray(rawTerm)) continue;
    const term = rawTerm as Record<string, unknown>;
    if (term.decision !== "transfer_hypothesis") continue;
    if (term.preBudgetEligible === false) continue;
    const goId = term.goId;
    if (typeof goId !== "string" || !/^GO:\d{7}$/.test(goId)) continue;
    const score = termScore(term, scoreSurface);
    if (score === null) continue;
    eligibleCandidateRows += 1;
    if (term.selected === true) operationalSelectedTerms += 1;
    rows.set(goId, Math.max(rows.get(goId) ?? 0, score));
  }
  return {
    rows,
    receipt: {
      targetId,
      status: "completed",
      runManifestSha256: await sha256File(manifestPath),
      goPredictionSha256: await sha256File(predictionPath),
      exportedUniqueTerms: rows.size,
      eligibleCandidateRows,
      operationalSelectedTerms,
    },
  };
}

export async function exportZ86Predictions(args: string[]): Promise<number> {
  const benchmarkRoot = resolve(option(args, "--benchmark") ?? "");
  const runsRoot = resolve(option(args, "--runs-root") ?? "");
  const predictionsRoot = resolve(option(args, "--predictions") ?? "");
  const receiptPath = resolve(option(args, "--receipt") ?? join(predictionsRoot, "z86_bridge_export_receipt.json"));
  if (!benchmarkRoot || benchmarkRoot === PROJECT_ROOT) throw new Error("export requires --benchmark");
  if (!runsRoot || runsRoot === PROJECT_ROOT) throw new Error("export requires --runs-root");
  if (!predictionsRoot || predictionsRoot === PROJECT_ROOT) throw new Error("export requires --predictions");
  const groups = parseGroups(option(args, "--groups"));
  const surface = (option(args, "--score-surface") ?? "final") as ScoreSurface;
  if (surface !== "final" && surface !== "evidence") throw new Error("--score-surface must be final or evidence");
  const allowMissing = args.includes("--allow-missing");
  const records = targetsByGroup(await loadTargetRecords(benchmarkRoot), groups);
  await mkdir(predictionsRoot, { recursive: true });
  const groupReceipts: GroupExportReceipt[] = [];
  for (const group of groups) {
    const targetRecords = records.get(group) ?? [];
    const rows: Array<[string, string, number]> = [];
    const cases: ExportCaseReceipt[] = [];
    for (const record of targetRecords) {
      const runDir = join(runsRoot, record.proteinId);
      if (!(await exists(join(runDir, "prediction", "go_predictions.json")))) {
        if (!allowMissing) throw new Error(`missing completed run for ${record.proteinId}: ${runDir}`);
        cases.push({ targetId: record.proteinId, status: "missing_abstention" });
        continue;
      }
      const { rows: predictionRows, receipt } = await readRunPrediction(runDir, record.proteinId, surface);
      for (const [goId, score] of predictionRows) rows.push([record.proteinId, goId, score]);
      cases.push(receipt);
    }
    rows.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
    const outputPath = join(predictionsRoot, `${group}.tsv`);
    await writeFile(
      outputPath,
      "target_id\tgo_id\tscore\n" + rows.map(([targetId, goId, score]) => `${targetId}\t${goId}\t${score.toFixed(9)}`).join("\n") + (rows.length ? "\n" : ""),
      "utf8",
    );
    groupReceipts.push({
      group,
      targetCount: targetRecords.length,
      completedRunCount: cases.filter((item) => item.status === "completed").length,
      missingAbstentionCount: cases.filter((item) => item.status === "missing_abstention").length,
      rowCount: rows.length,
      predictionFile: { path: relative(predictionsRoot, outputPath), sha256: await sha256File(outputPath) },
      cases,
    });
  }
  const body = {
    schemaVersion: "pi-z86-bridge-export.v1",
    suiteId: "z86-function-198-pair-clean-v2",
    scoreSurface: surface,
    benchmarkRoot: relative(PROJECT_ROOT, benchmarkRoot).startsWith("..") ? benchmarkRoot : relative(PROJECT_ROOT, benchmarkRoot),
    runsRoot: relative(PROJECT_ROOT, runsRoot).startsWith("..") ? runsRoot : relative(PROJECT_ROOT, runsRoot),
    predictionsRoot: relative(PROJECT_ROOT, predictionsRoot).startsWith("..") ? predictionsRoot : relative(PROJECT_ROOT, predictionsRoot),
    groups: groupReceipts,
  };
  await writeJson(receiptPath, { ...body, canonicalHash: hashCanonical(body) });
  console.log(`Exported Z86 prediction TSVs to ${predictionsRoot}`);
  console.log(`Export receipt: ${receiptPath}`);
  return 0;
}

export async function evaluateZ86Predictions(args: string[]): Promise<number> {
  const benchmarkRoot = resolve(option(args, "--benchmark") ?? "");
  const privateRoot = resolve(option(args, "--private") ?? "");
  const predictionsRoot = resolve(option(args, "--predictions") ?? "");
  const outputPath = resolve(option(args, "--output") ?? "");
  if (!benchmarkRoot || benchmarkRoot === PROJECT_ROOT) throw new Error("evaluate requires --benchmark");
  if (!privateRoot || privateRoot === PROJECT_ROOT) throw new Error("evaluate requires --private");
  if (!predictionsRoot || predictionsRoot === PROJECT_ROOT) throw new Error("evaluate requires --predictions");
  if (!outputPath || outputPath === PROJECT_ROOT) throw new Error("evaluate requires --output");
  const track = option(args, "--track") ?? "gold_v1";
  if (track !== "gold_v1" && track !== "gold_v2") throw new Error("--track must be gold_v1 or gold_v2");
  const python = option(args, "--python") ?? "python3";
  const evaluator = join(benchmarkRoot, "evaluator", "evaluate_candidate.py");
  const commandArgs = [evaluator, "--private", privateRoot, "--predictions", predictionsRoot, "--track", track, "--output", outputPath];
  try {
    const result = await execFileAsync(python, commandArgs, { cwd: benchmarkRoot, maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`Z86 canonical evaluator failed${detail ? `: ${detail.slice(0, 2000)}` : ""}`);
  }
  const aggregate = await readJson<Record<string, unknown>>(outputPath);
  console.log(JSON.stringify({ metric: aggregate.metric, primaryObjectiveEligible: aggregate.primaryObjectiveEligible, output: outputPath }, null, 2));
  return 0;
}

export async function z86BridgeCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    console.log(usage());
    return 0;
  }
  if (!["prepare-inputs", "export", "evaluate"].includes(subcommand)) throw new Error(`Unknown z86-bridge command: ${subcommand}\n\n${usage()}`);
  if ((subcommand as Z86Subcommand) === "prepare-inputs") return await prepareZ86Inputs(rest);
  if ((subcommand as Z86Subcommand) === "export") return await exportZ86Predictions(rest);
  return await evaluateZ86Predictions(rest);
}
