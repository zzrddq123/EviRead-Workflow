import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Text } from "./hash.js";
import type { PhylogenyMode, TargetContext, TargetMode } from "./types.js";

const AMINO_ACIDS = new Set("ABCDEFGHIKLMNPQRSTVWXYZOUJ");
export interface PreparedInputs {
  proteinId: string;
  targetMode: TargetMode;
  targetContext: TargetContext;
  sequencePath: string;
  structurePath?: string;
  sequenceSha256: string;
  structureSha256: string | null;
  sequenceContentSha256: string;
  structureAvailable: boolean;
  redactionReport: {
    schemaVersion: "pi-input-redaction.v2";
    targetMode: TargetMode;
    targetContext: TargetContext;
    sourceIdentityMetadataRetained: false;
    fastaHeadersRemoved: number;
    pdbMetadataLinesRemoved: number;
    structureConfidenceHintRetained: boolean;
    sequenceLength: number;
    structureAvailable: boolean;
  };
}

export function prepareTargetContext(input: {
  queryTaxonId?: number;
  phylogenyMode?: PhylogenyMode;
}): TargetContext {
  const phylogenyMode = input.phylogenyMode ?? "optional";
  if (phylogenyMode !== "optional" && phylogenyMode !== "required") {
    throw new Error("phylogeny mode must be optional or required");
  }
  if (
    input.queryTaxonId !== undefined
    && (!Number.isInteger(input.queryTaxonId) || input.queryTaxonId <= 0)
  ) {
    throw new Error("query taxon ID must be a positive integer");
  }
  if (phylogenyMode === "required" && input.queryTaxonId === undefined) {
    throw new Error("phylogeny mode required needs a declared positive query taxon ID");
  }
  return {
    taxon: input.queryTaxonId === undefined
      ? { taxonId: null, provenance: "unavailable" }
      : { taxonId: input.queryTaxonId, provenance: "provided" },
    phylogeny: input.queryTaxonId === undefined
      ? { mode: phylogenyMode, status: "unavailable_missing_taxon" }
      : { mode: phylogenyMode, status: "requested" },
  };
}

export function parseFastaSequence(source: string): { sequence: string; headerCount: number } {
  const chunks: string[] = [];
  let headerCount = 0;
  let sawSequence = false;
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(">")) {
      headerCount += 1;
      if (headerCount > 1 || sawSequence) throw new Error("Exactly one FASTA sequence is supported");
      continue;
    }
    sawSequence = true;
    chunks.push(line);
  }
  const sequence = chunks.join("").toUpperCase().replace(/\*/g, "");
  if (!sequence) throw new Error("The FASTA input contains no amino-acid sequence");
  const invalid = [...new Set([...sequence].filter((value) => !AMINO_ACIDS.has(value)))].sort();
  if (invalid.length > 0) throw new Error(`Invalid amino-acid characters: ${invalid.join("")}`);
  return { sequence, headerCount };
}

export function canonicalFasta(sequence: string): string {
  const lines = sequence.match(/.{1,80}/g) ?? [];
  return `>anonymous_query\n${lines.join("\n")}\n`;
}

export function canonicalPdb(source: string): { text: string; removed: number; confidenceHint: boolean } {
  const normalized = source.replace(/\r\n?/g, "\n");
  const confidenceHint = /ALPHAFOLD/i.test(normalized.slice(0, 20_000));
  const safe: string[] = [];
  let removed = 0;
  let coordinateCount = 0;
  for (const line of normalized.split("\n")) {
    if (!line) continue;
    const record = line.padEnd(6).slice(0, 6);
    if (record === "ATOM  " || record === "HETATM") {
      const fixed = line.padEnd(80).slice(0, 80);
      // PDB columns 73-76 are a free-form segment identifier and columns >80 are
      // non-standard. Blank both identity-capable regions while retaining the
      // element/charge fields in columns 77-80.
      safe.push(`${fixed.slice(0, 72)}    ${fixed.slice(76, 80)}`.trimEnd());
      coordinateCount += 1;
      continue;
    }
    if (record === "MODEL ") {
      const modelNumber = Number.parseInt(line.slice(10, 14).trim(), 10);
      safe.push(Number.isInteger(modelNumber) ? `MODEL     ${String(modelNumber).padStart(4)}` : "MODEL        1");
      continue;
    }
    if (record === "ENDMDL") {
      safe.push("ENDMDL");
      continue;
    }
    if (record === "TER   ") {
      safe.push("TER");
      continue;
    }
    if (record === "END   ") {
      continue;
    }
    {
      removed += 1;
      continue;
    }
  }
  if (coordinateCount === 0) throw new Error("The structure input contains no ATOM/HETATM coordinates");
  const prefix = confidenceHint ? ["REMARK 999 ANONYMOUS INPUT; ALPHAFOLD_PLDDT B-FACTORS RETAINED"] : [];
  return { text: `${[...prefix, ...safe, "END"].join("\n")}\n`, removed, confidenceHint };
}

export async function prepareAnonymousInputs(input: {
  sequenceSource: string;
  structureSource?: string;
  stagingDir: string;
  targetMode: TargetMode;
  requestedProteinId?: string;
  queryTaxonId?: number;
  phylogenyMode?: PhylogenyMode;
}): Promise<PreparedInputs> {
  const targetContext = prepareTargetContext({
    queryTaxonId: input.queryTaxonId,
    phylogenyMode: input.phylogenyMode,
  });
  const rawFasta = await readFile(input.sequenceSource, "utf8");
  const { sequence, headerCount } = parseFastaSequence(rawFasta);
  const sequenceContentSha256 = sha256Text(sequence);
  const proteinId = input.targetMode === "anonymous"
    ? `ANON_${sequenceContentSha256.slice(0, 12).toUpperCase()}`
    : (input.requestedProteinId?.trim() || "");
  if (!proteinId) throw new Error("--protein-id is required for --target-mode named-uncharacterized");

  await mkdir(input.stagingDir, { recursive: true });
  const sequencePath = join(input.stagingDir, "sequence.fasta");
  const sequenceText = canonicalFasta(sequence);
  await writeFile(sequencePath, sequenceText, "utf8");

  let structurePath: string | undefined;
  let structureSha256: string | null = null;
  let pdbMetadataLinesRemoved = 0;
  let structureConfidenceHintRetained = false;
  if (input.structureSource) {
    const rawPdb = await readFile(input.structureSource, "utf8");
    const sanitized = canonicalPdb(rawPdb);
    structurePath = join(input.stagingDir, "structure.pdb");
    await writeFile(structurePath, sanitized.text, "utf8");
    structureSha256 = sha256Text(sanitized.text);
    pdbMetadataLinesRemoved = sanitized.removed;
    structureConfidenceHintRetained = sanitized.confidenceHint;
  }

  return {
    proteinId,
    targetMode: input.targetMode,
    targetContext,
    sequencePath,
    structurePath,
    sequenceSha256: sha256Text(sequenceText),
    structureSha256,
    sequenceContentSha256,
    structureAvailable: structurePath !== undefined,
    redactionReport: {
      schemaVersion: "pi-input-redaction.v2",
      targetMode: input.targetMode,
      targetContext,
      sourceIdentityMetadataRetained: false,
      fastaHeadersRemoved: headerCount,
      pdbMetadataLinesRemoved,
      structureConfidenceHintRetained,
      sequenceLength: sequence.length,
      structureAvailable: structurePath !== undefined,
    },
  };
}
