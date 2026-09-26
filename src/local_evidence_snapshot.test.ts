import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertLocalEvidenceSnapshot,
  buildLocalEvidenceSnapshot,
} from "./local_evidence_snapshot.js";
import { hashCanonical } from "./hash.js";

function rehashSnapshot(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { canonicalHash: _ignored, ...content } = value;
  return { ...content, canonicalHash: hashCanonical(content) };
}

async function fixture(): Promise<{
  root: string;
  config: string;
  ontology: string;
  blastPrefix: string;
  swissPrefix: string;
  pdbPrefix: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-local-snapshot-"));
  const bin = join(root, "bin");
  const databases = join(root, "databases");
  await mkdir(bin, { recursive: true });
  await mkdir(databases, { recursive: true });
  const tool = async (name: string, output: string): Promise<string> => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
    await chmod(path, 0o755);
    return path;
  };
  const python = await tool("python", "Python 3.11.13");
  const blastp = await tool("blastp", "blastp: 2.17.0+");
  const blastdbcmd = await tool("blastdbcmd", "blastdbcmd: 2.17.0+");
  const foldseek = await tool("foldseek", "foldseek-test-hash");
  const blastPrefix = join(databases, "uniprot_sprot");
  const swissPrefix = join(databases, "afdb_swissprot");
  const pdbPrefix = join(databases, "pdb");
  await writeFile(`${blastPrefix}.pin`, "blast-index\n", "utf8");
  await writeFile(`${blastPrefix}.psq`, "blast-sequences\n", "utf8");
  await writeFile(swissPrefix, "foldseek-swissprot\n", "utf8");
  await writeFile(`${swissPrefix}.index`, "foldseek-swissprot-index\n", "utf8");
  await writeFile(pdbPrefix, "foldseek-pdb\n", "utf8");
  await writeFile(`${pdbPrefix}_taxonomy`, "taxonomy\n", "utf8");
  await symlink("pdb_taxonomy", `${pdbPrefix}_seq_taxonomy`);
  const ontology = join(root, "go-basic.obo");
  await writeFile(ontology, "format-version: 1.2\ndata-version: test/releases/2026-07-21\n", "utf8");
  const profile = join(root, "resource-profile.json");
  const profileContent = {
    schemaVersion: "pi-external-resource-profile.v1",
    profileId: "strict_t0",
    mode: "strict_t0_evidence_plane",
    knowledgeCutoff: "2025-09-04",
    networkPolicy: "biological_network_disabled",
    resources: [],
    candidateProviders: {},
  };
  await writeFile(profile, JSON.stringify({
    ...profileContent,
    canonicalHash: hashCanonical(profileContent),
  }), "utf8");
  const config = join(root, "local.env");
  await writeFile(config, [
    "EVIDENCE_PROFILE=sequence_structure",
    "SEQUENCE_SEARCH_BACKEND=local",
    "STRUCTURE_SEARCH_BACKEND=local",
    `TEMPORAL_RESOURCE_PROFILE=${profile}`,
    `PYTHON_BIN=${python}`,
    `BLASTP_BIN=${blastp}`,
    `BLASTDBCMD_BIN=${blastdbcmd}`,
    `BLAST_DB=${blastPrefix}`,
    `FOLDSEEK_BIN=${foldseek}`,
    `FOLDSEEK_SWISSPROT_DB=${swissPrefix}`,
    `FOLDSEEK_PDB_DB=${pdbPrefix}`,
    `GO_ONTOLOGY_OBO=${ontology}`,
    "MERIZO_ROOT=",
    "CHAINSAW_ROOT=",
    "TOP_K=8",
    "ANNOTATION_LIMIT=16",
    "CANDIDATE_PROVIDER_MODE=remote",
  ].join("\n") + "\n", "utf8");
  return { root, config, ontology, blastPrefix, swissPrefix, pdbPrefix };
}

test("local developer snapshot full-hashes tools/databases and redacts every path", async () => {
  const value = await fixture();
  try {
    const first = await buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology });
    const second = await buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology });
    assert.deepEqual(second, first);
    assert.equal(assertLocalEvidenceSnapshot(first), first);
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, new RegExp(value.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /\/Users\/|\/home\//);
    const pdb = first.databases.find((item) => item.label === "foldseek_pdb");
    assert.deepEqual(pdb?.files.find((item) => item.kind === "symlink"), {
      name: "pdb_seq_taxonomy",
      kind: "symlink",
      linkTarget: "pdb_taxonomy",
      sizeBytes: 9,
      sha256: pdb?.files.find((item) => item.name === "pdb_taxonomy")?.sha256,
    });
    assert.ok(first.databases.every((database) => database.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("local developer snapshot changes when any database byte changes", async () => {
  const value = await fixture();
  try {
    const before = await buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology });
    await writeFile(`${value.blastPrefix}.psq`, "changed-sequences\n", "utf8");
    const after = await buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology });
    assert.notEqual(after.canonicalHash, before.canonicalHash);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("local snapshot assertion cross-binds runtime flags and exact provider label sets", async () => {
  const value = await fixture();
  try {
    const snapshot = await buildLocalEvidenceSnapshot({
      configPath: value.config,
      ontologyPath: value.ontology,
    });
    const forged = (overrides: Record<string, unknown>) =>
      rehashSnapshot({ ...snapshot, ...overrides });
    const forgedDatabase = (
      database: (typeof snapshot.databases)[number],
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => {
      const { sourceHash: _ignored, ...content } = database;
      const updated = { ...content, ...overrides };
      return { ...updated, sourceHash: hashCanonical(updated) };
    };

    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        runtimeContract: {
          ...snapshot.runtimeContract,
          sequenceSearchBackend: "ncbi",
        },
      })),
      /runtime contract is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        runtimeContract: {
          ...snapshot.runtimeContract,
          pdbEnabled: 1,
        },
      })),
      /runtime contract is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        runtimeContract: {
          ...snapshot.runtimeContract,
          pdbEnabled: false,
        },
      })),
      /runtime\/database configuration is inconsistent/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        runtimeContract: {
          ...snapshot.runtimeContract,
          merizoEnabled: true,
        },
      })),
      /runtime\/optional-tool configuration is inconsistent/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        databases: [
          snapshot.databases[0],
          snapshot.databases[1],
          snapshot.databases[1],
        ],
      })),
      /database set is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        databases: [
          forgedDatabase(snapshot.databases[0], {
            files: [],
            fileCount: 0,
            totalBytes: 0,
          }),
          snapshot.databases[1],
          snapshot.databases[2],
        ],
      })),
      /database accounting is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        databases: [
          forgedDatabase(snapshot.databases[0], {
            files: [
              {
                ...snapshot.databases[0].files[0],
                kind: "device",
              },
              ...snapshot.databases[0].files.slice(1),
            ],
          }),
          snapshot.databases[1],
          snapshot.databases[2],
        ],
      })),
      /database file is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        databases: [
          forgedDatabase(snapshot.databases[0], {
            files: [
              snapshot.databases[0].files[0],
              snapshot.databases[0].files[0],
            ],
            fileCount: 2,
            totalBytes: snapshot.databases[0].files[0]!.sizeBytes * 2,
          }),
          snapshot.databases[1],
          snapshot.databases[2],
        ],
      })),
      /database accounting is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        tools: [
          snapshot.tools[0],
          snapshot.tools[1],
          snapshot.tools[2],
          snapshot.tools[2],
        ],
      })),
      /tool set is invalid/,
    );
    assert.throws(
      () => assertLocalEvidenceSnapshot(forged({
        optionalTools: [
          snapshot.optionalTools[0],
          snapshot.optionalTools[0],
        ],
      })),
      /optional-tool set is invalid/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("local developer snapshot rejects absolute, escaping, and dangling database symlinks", async () => {
  for (const target of ["/etc/hosts", "../escape", "pdb_missing"] as const) {
    const value = await fixture();
    try {
      const link = `${value.pdbPrefix}_bad_${target.replace(/[^a-z]+/gi, "_")}`;
      await symlink(target, link);
      await assert.rejects(
        () => buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology }),
        /relative target|escapes|dangling or cyclic/,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("local developer snapshot cannot be selected implicitly", async () => {
  const value = await fixture();
  try {
    const body = await readFile(value.config, "utf8");
    await writeFile(value.config, body.replace("SEQUENCE_SEARCH_BACKEND=local", "SEQUENCE_SEARCH_BACKEND=ncbi"), "utf8");
    await assert.rejects(
      () => buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology }),
      /explicit local search backends/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
