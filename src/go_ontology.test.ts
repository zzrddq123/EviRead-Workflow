import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ancestorsOf,
  buildGoOntologySnapshot,
  loadGoBasicObo,
  parseGoBasicObo,
  parseGoOntologySnapshot,
  resolveGoId,
  resolveGoTerm,
} from "./go_ontology.js";

const HEADER = `format-version: 1.2
data-version: releases/2026-07-01
ontology: go
`;

const STANZAS = {
  mfRoot: `[Term]
id: GO:0003674
name: molecular_function
namespace: molecular_function
`,
  bpRoot: `[Term]
id: GO:0008150
name: biological_process
namespace: biological_process
`,
  parent: `[Term]
id: GO:1234001
name: catalytic parent
namespace: molecular_function
is_a: GO:0003674 ! molecular_function
`,
  secondaryParent: `[Term]
id: GO:1234002
name: binding parent
namespace: molecular_function
is_a: GO:0003674 ! molecular_function
`,
  child: `[Term]
id: GO:1234003
name: child activity
namespace: molecular_function
alt_id: GO:9234003
relationship: regulates GO:1234002 ! unsafe and ignored
relationship: part_of GO:1234002 ! safe
is_a: GO:1234001 ! catalytic parent
is_a: GO:1234001 ! duplicate is harmless
is_a: GO:9999999 ! missing parent is filtered
`,
  crossNamespace: `[Term]
id: GO:1234004
name: synthetic cross namespace term
namespace: molecular_function
is_a: GO:0008150 ! deliberately malformed cross-namespace edge
`,
  obsolete: `[Term]
id: GO:1234999
name: obsolete activity
namespace: molecular_function
alt_id: GO:9234999
is_obsolete: true
`,
  typedef: `[Typedef]
id: part_of
name: part of
`,
};

function obo(order: Array<keyof typeof STANZAS> = [
  "mfRoot",
  "bpRoot",
  "parent",
  "secondaryParent",
  "child",
  "crossNamespace",
  "obsolete",
  "typedef",
]): string {
  return `${HEADER}\n${order.map((key) => STANZAS[key]).join("\n")}`;
}

function semanticSnapshot(source: string): unknown {
  const ontology = parseGoBasicObo(source);
  return {
    dataVersion: ontology.dataVersion,
    terms: [...ontology.terms.entries()],
    altIds: [...ontology.altIdToId.entries()],
    ancestors: ancestorsOf(ontology, "GO:9234003", { excludeRoots: false }),
  };
}

test("parses active go-basic terms, safe relations, alt IDs, version, and exact SHA-256", () => {
  const source = obo();
  const ontology = parseGoBasicObo(source);
  assert.equal(ontology.dataVersion, "releases/2026-07-01");
  assert.equal(ontology.sha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(ontology.terms.size, 6);
  assert.equal(ontology.terms.has("GO:1234999"), false);
  assert.equal(resolveGoId(ontology, "GO:9234003"), "GO:1234003");
  assert.equal(resolveGoId(ontology, "GO:9234999"), undefined);
  assert.deepEqual(resolveGoTerm(ontology, "GO:9234003"), {
    id: "GO:1234003",
    name: "child activity",
    namespace: "molecular_function",
    altIds: ["GO:9234003"],
    parents: [
      { parentId: "GO:1234001", relation: "is_a" },
      { parentId: "GO:1234002", relation: "part_of" },
    ],
  });
});

test("ancestor traversal is depth-bounded, root-excluding, alt-aware, and deterministic", () => {
  const ontology = parseGoBasicObo(obo());
  assert.deepEqual(ancestorsOf(ontology, "GO:9234003"), [
    { id: "GO:1234001", name: "catalytic parent", namespace: "molecular_function", depth: 1 },
    { id: "GO:1234002", name: "binding parent", namespace: "molecular_function", depth: 1 },
  ]);
  assert.deepEqual(ancestorsOf(ontology, "GO:1234003", { maxDepth: 1, excludeRoots: false }), [
    { id: "GO:1234001", name: "catalytic parent", namespace: "molecular_function", depth: 1 },
    { id: "GO:1234002", name: "binding parent", namespace: "molecular_function", depth: 1 },
  ]);
  assert.deepEqual(ancestorsOf(ontology, "GO:1234003", { maxDepth: 2, excludeRoots: false }), [
    { id: "GO:1234001", name: "catalytic parent", namespace: "molecular_function", depth: 1 },
    { id: "GO:1234002", name: "binding parent", namespace: "molecular_function", depth: 1 },
    { id: "GO:0003674", name: "molecular_function", namespace: "molecular_function", depth: 2 },
  ]);
  assert.deepEqual(ancestorsOf(ontology, "GO:1234003", { maxDepth: 0 }), []);
  assert.deepEqual(ancestorsOf(ontology, "GO:7654321"), []);
  assert.throws(() => ancestorsOf(ontology, "GO:1234003", { maxDepth: -1 }), /non-negative/);
});

test("same-namespace traversal is safe by default and may be explicitly relaxed", () => {
  const ontology = parseGoBasicObo(obo());
  assert.deepEqual(ancestorsOf(ontology, "GO:1234004", { excludeRoots: false }), []);
  assert.deepEqual(ancestorsOf(ontology, "GO:1234004", {
    sameNamespace: false,
    excludeRoots: false,
  }), [
    { id: "GO:0008150", name: "biological_process", namespace: "biological_process", depth: 1 },
  ]);
  assert.deepEqual(ancestorsOf(ontology, "GO:1234004", { sameNamespace: false }), []);
});

test("cycles are harmless and each ancestor uses its shortest depth", () => {
  const source = `${HEADER}
[Term]
id: GO:1111111
name: one
namespace: molecular_function
is_a: GO:2222222

[Term]
id: GO:2222222
name: two
namespace: molecular_function
is_a: GO:1111111
is_a: GO:3333333

[Term]
id: GO:3333333
name: three
namespace: molecular_function
`;
  const ontology = parseGoBasicObo(source);
  assert.deepEqual(ancestorsOf(ontology, "GO:1111111", { maxDepth: 100 }), [
    { id: "GO:2222222", name: "two", namespace: "molecular_function", depth: 1 },
    { id: "GO:3333333", name: "three", namespace: "molecular_function", depth: 2 },
  ]);
});

test("semantic maps and ancestor output are stable under stanza permutation", () => {
  const forward = obo();
  const reverse = obo([
    "typedef",
    "obsolete",
    "crossNamespace",
    "child",
    "secondaryParent",
    "parent",
    "bpRoot",
    "mfRoot",
  ]);
  assert.deepEqual(semanticSnapshot(reverse), semanticSnapshot(forward));
  // The integrity hash intentionally pins exact source bytes, not normalized semantics.
  assert.notEqual(parseGoBasicObo(reverse).sha256, parseGoBasicObo(forward).sha256);
});

test("loader hashes exact bytes and parser fails closed on ambiguous metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-ontology-"));
  try {
    const path = join(directory, "go-basic.obo");
    const source = obo().replace(/\n/g, "\r\n");
    await writeFile(path, source);
    const ontology = await loadGoBasicObo(path);
    assert.equal(ontology.sha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(ontology.terms.get("GO:1234003")?.name, "child activity");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.throws(() => parseGoBasicObo("format-version: 1.2\n"), /missing a data-version/);
  assert.throws(() => parseGoBasicObo(`${HEADER}data-version: another-release\n`), /conflicting data-version/);
  assert.throws(() => parseGoBasicObo(`${HEADER}\n[Term]\nid: GO:1234567\nname: incomplete\n`), /missing id, name, or namespace/);
});

test("compact semantic snapshots retain source identity and only bounded required ancestors", () => {
  const full = parseGoBasicObo(obo());
  const snapshot = buildGoOntologySnapshot(full, ["GO:9234003"], 1);
  assert.equal(snapshot.sourceSha256, full.sha256);
  assert.deepEqual(snapshot.terms.map((term) => term.id), ["GO:1234001", "GO:1234002", "GO:1234003"]);
  const restored = parseGoOntologySnapshot(snapshot);
  assert.equal(restored.sha256, full.sha256);
  assert.deepEqual(ancestorsOf(restored, "GO:9234003", { maxDepth: 1 }), [
    { id: "GO:1234001", name: "catalytic parent", namespace: "molecular_function", depth: 1 },
    { id: "GO:1234002", name: "binding parent", namespace: "molecular_function", depth: 1 },
  ]);
  assert.throws(() => parseGoOntologySnapshot({ ...snapshot, sourceSha256: "0".repeat(64) }), /canonical hash/);
});
