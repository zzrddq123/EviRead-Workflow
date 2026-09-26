import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { hashCanonical } from "./hash.js";

/** The three namespaces defined by the Gene Ontology. */
export type GONamespace = "molecular_function" | "biological_process" | "cellular_component";

/** Relations that are safe for true-path propagation in go-basic.obo. */
export type GOParentRelation = "is_a" | "part_of";

export interface GOParentEdge {
  parentId: string;
  relation: GOParentRelation;
}

export interface GOTerm {
  id: string;
  name: string;
  namespace: GONamespace;
  altIds: readonly string[];
  parents: readonly GOParentEdge[];
}

export interface GOOntology {
  /** The exact data-version value from the OBO header. */
  dataVersion: string;
  /** SHA-256 of the exact source bytes, for release pinning and audit. */
  sha256: string;
  /** Active terms only, inserted in ascending canonical GO ID order. */
  terms: ReadonlyMap<string, GOTerm>;
  /** Active alternative GO ID -> canonical GO ID, in ascending alt-ID order. */
  altIdToId: ReadonlyMap<string, string>;
}

export interface GOAncestor {
  id: string;
  name: string;
  namespace: GONamespace;
  /** Length of the shortest safe-parent path from the query term. */
  depth: number;
}

export interface GOAncestorOptions {
  /** Maximum number of parent edges to traverse. Defaults to 32. */
  maxDepth?: number;
  /** Reject cross-namespace edges. Defaults to true. */
  sameNamespace?: boolean;
  /** Omit the three ontology roots from the result. Defaults to true. */
  excludeRoots?: boolean;
}

export interface GOOntologySnapshot {
  schemaVersion: "pi-go-ontology-snapshot.v1";
  dataVersion: string;
  sourceSha256: string;
  terms: GOTerm[];
  altIdToId: Record<string, string>;
  canonicalHash: string;
}

const GO_ID = /^GO:\d{7}$/;

export const GO_ROOT_IDS = Object.freeze({
  molecular_function: "GO:0003674",
  biological_process: "GO:0008150",
  cellular_component: "GO:0005575",
} satisfies Record<GONamespace, string>);

const ROOT_IDS = new Set<string>(Object.values(GO_ROOT_IDS));
const NAMESPACES = new Set<GONamespace>([
  "molecular_function",
  "biological_process",
  "cellular_component",
]);

interface RawTerm {
  id?: string;
  name?: string;
  namespace?: GONamespace;
  altIds: string[];
  parents: GOParentEdge[];
  obsolete: boolean;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function edgeKey(edge: GOParentEdge): string {
  return `${edge.parentId}\u0000${edge.relation}`;
}

function uniqueSortedEdges(edges: readonly GOParentEdge[]): GOParentEdge[] {
  const byKey = new Map(edges.map((edge) => [edgeKey(edge), edge]));
  return [...byKey.values()]
    .sort((left, right) => compareText(left.parentId, right.parentId)
      || compareText(left.relation, right.relation));
}

function parseGoId(value: string): string | undefined {
  const candidate = value.trim().split(/\s+/, 1)[0];
  return candidate && GO_ID.test(candidate) ? candidate : undefined;
}

function parseTermStanza(lines: readonly string[]): RawTerm {
  const raw: RawTerm = { altIds: [], parents: [], obsolete: false };
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const tag = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (tag === "id") {
      const id = parseGoId(value);
      if (id) raw.id = id;
    } else if (tag === "name") {
      raw.name = value;
    } else if (tag === "namespace" && NAMESPACES.has(value as GONamespace)) {
      raw.namespace = value as GONamespace;
    } else if (tag === "alt_id") {
      const altId = parseGoId(value);
      if (altId) raw.altIds.push(altId);
    } else if (tag === "is_a") {
      const parentId = parseGoId(value);
      if (parentId) raw.parents.push({ parentId, relation: "is_a" });
    } else if (tag === "relationship") {
      // go-basic includes other relationship types. Only part_of is safe for
      // upward GO propagation; regulates and its variants are intentionally ignored.
      const match = /^part_of\s+(GO:\d{7})(?:\s|$)/.exec(value);
      if (match) raw.parents.push({ parentId: match[1], relation: "part_of" });
    } else if (tag === "is_obsolete") {
      raw.obsolete = value.toLowerCase() === "true";
    }
  }
  return raw;
}

function sourceBytes(source: string | Uint8Array): Buffer {
  return typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
}

/**
 * Parse a pinned official go-basic.obo snapshot.
 *
 * The source hash covers the exact bytes. Semantic collections are sorted so
 * term-stanza and edge permutation cannot affect inference output.
 */
export function parseGoBasicObo(source: string | Uint8Array): GOOntology {
  const bytes = sourceBytes(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);

  const dataVersions: string[] = [];
  const rawTerms: RawTerm[] = [];
  let stanzaType = "header";
  let stanzaLines: string[] = [];

  const flush = (): void => {
    if (stanzaType === "Term") rawTerms.push(parseTermStanza(stanzaLines));
    stanzaLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const stanza = /^\[([^\]]+)\]$/.exec(line);
    if (stanza) {
      flush();
      stanzaType = stanza[1];
      continue;
    }
    if (stanzaType === "header") {
      const match = /^data-version:\s*(.+?)\s*$/.exec(line);
      if (match) dataVersions.push(match[1]);
    } else {
      stanzaLines.push(line);
    }
  }
  flush();

  const distinctVersions = uniqueSorted(dataVersions);
  if (distinctVersions.length !== 1) {
    throw new Error(distinctVersions.length === 0
      ? "go-basic.obo is missing a data-version header"
      : `go-basic.obo has conflicting data-version headers: ${distinctVersions.join(", ")}`);
  }

  const active = rawTerms.filter((term) => !term.obsolete);
  const invalid = active
    .filter((term) => !term.id || !term.name || !term.namespace)
    .map((term) => term.id ?? "<missing id>")
    .sort();
  if (invalid.length > 0) {
    throw new Error(`active GO term is missing id, name, or namespace: ${invalid.join(", ")}`);
  }

  const rawById = new Map<string, RawTerm>();
  for (const term of [...active].sort((left, right) => compareText(left.id!, right.id!))) {
    if (rawById.has(term.id!)) throw new Error(`duplicate active GO term: ${term.id}`);
    rawById.set(term.id!, term);
  }

  const canonicalIds = new Set(rawById.keys());
  const altIdToId = new Map<string, string>();
  for (const [id, term] of rawById) {
    for (const altId of uniqueSorted(term.altIds)) {
      if (canonicalIds.has(altId)) throw new Error(`GO alt_id is also an active canonical id: ${altId}`);
      const previous = altIdToId.get(altId);
      if (previous && previous !== id) {
        throw new Error(`GO alt_id ${altId} belongs to both ${previous} and ${id}`);
      }
      altIdToId.set(altId, id);
    }
  }

  const orderedAltIds = new Map([...altIdToId.entries()]
    .sort(([left], [right]) => compareText(left, right)));
  const terms = new Map<string, GOTerm>();
  for (const [id, raw] of rawById) {
    const parents = uniqueSortedEdges(raw.parents
      .map((edge) => ({
        relation: edge.relation,
        parentId: orderedAltIds.get(edge.parentId) ?? edge.parentId,
      }))
      // Missing and obsolete parents cannot be safely propagated.
      .filter((edge) => edge.parentId !== id && canonicalIds.has(edge.parentId)))
      .map((edge) => Object.freeze(edge));
    terms.set(id, Object.freeze({
      id,
      name: raw.name!,
      namespace: raw.namespace!,
      altIds: Object.freeze(uniqueSorted(raw.altIds)),
      parents: Object.freeze(parents),
    }));
  }

  return Object.freeze({
    dataVersion: distinctVersions[0],
    sha256,
    terms,
    altIdToId: orderedAltIds,
  });
}

/** Load and parse an OBO file without normalizing its bytes before hashing. */
export async function loadGoBasicObo(path: string | URL): Promise<GOOntology> {
  return parseGoBasicObo(await readFile(path));
}

/**
 * Build a compact, content-hashed semantic snapshot containing the requested
 * direct terms and every safe ancestor needed by a bounded closure. The
 * original OBO byte hash remains the scientific resource identity.
 */
export function buildGoOntologySnapshot(
  ontology: GOOntology,
  seedGoIds: readonly string[],
  maxDepth: number,
): GOOntologySnapshot {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) {
    throw new Error("GO ontology snapshot maxDepth must be an integer from 0 to 32");
  }
  const included = new Set<string>();
  for (const seed of [...new Set(seedGoIds)].sort(compareText)) {
    const canonical = resolveGoId(ontology, seed);
    if (!canonical) continue;
    included.add(canonical);
    for (const ancestor of ancestorsOf(ontology, canonical, {
      maxDepth,
      sameNamespace: true,
      excludeRoots: false,
    })) included.add(ancestor.id);
  }
  const terms = [...included].sort(compareText).map((id) => {
    const term = ontology.terms.get(id)!;
    return {
      ...term,
      altIds: [...term.altIds],
      parents: term.parents
        .filter((edge) => included.has(edge.parentId))
        .map((edge) => ({ ...edge })),
    };
  });
  const altIdToId = Object.fromEntries([...ontology.altIdToId.entries()]
    .filter(([, id]) => included.has(id))
    .sort(([left], [right]) => compareText(left, right)));
  const content = {
    schemaVersion: "pi-go-ontology-snapshot.v1" as const,
    dataVersion: ontology.dataVersion,
    sourceSha256: ontology.sha256,
    terms,
    altIdToId,
  };
  return { ...content, canonicalHash: hashCanonical(content) };
}

export function parseGoOntologySnapshot(value: unknown): GOOntology {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GO ontology snapshot must be an object");
  const snapshot = value as Partial<GOOntologySnapshot>;
  const { canonicalHash, ...content } = snapshot;
  if (snapshot.schemaVersion !== "pi-go-ontology-snapshot.v1"
    || typeof canonicalHash !== "string"
    || canonicalHash !== hashCanonical(content)) {
    throw new Error("GO ontology snapshot canonical hash is invalid");
  }
  if (typeof snapshot.dataVersion !== "string" || !snapshot.dataVersion
    || typeof snapshot.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.sourceSha256)
    || !Array.isArray(snapshot.terms)
    || !snapshot.altIdToId || typeof snapshot.altIdToId !== "object" || Array.isArray(snapshot.altIdToId)) {
    throw new Error("GO ontology snapshot fields are invalid");
  }
  const terms = new Map<string, GOTerm>();
  for (const raw of snapshot.terms) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("GO ontology snapshot term is invalid");
    const term = raw as GOTerm;
    if (!GO_ID.test(term.id) || typeof term.name !== "string" || !NAMESPACES.has(term.namespace)
      || !Array.isArray(term.altIds) || !Array.isArray(term.parents)) {
      throw new Error("GO ontology snapshot term fields are invalid");
    }
    if (terms.has(term.id)) throw new Error(`duplicate GO ontology snapshot term: ${term.id}`);
    const parents = uniqueSortedEdges(term.parents.map((edge) => {
      if (!GO_ID.test(edge.parentId) || (edge.relation !== "is_a" && edge.relation !== "part_of")) {
        throw new Error(`invalid GO ontology snapshot edge: ${term.id}`);
      }
      return { parentId: edge.parentId, relation: edge.relation };
    }));
    terms.set(term.id, Object.freeze({
      id: term.id,
      name: term.name,
      namespace: term.namespace,
      altIds: Object.freeze(uniqueSorted(term.altIds)),
      parents: Object.freeze(parents),
    }));
  }
  const orderedTerms = new Map([...terms.entries()].sort(([left], [right]) => compareText(left, right)));
  const altIdToId = new Map<string, string>();
  for (const [altId, id] of Object.entries(snapshot.altIdToId)) {
    if (!GO_ID.test(altId) || !GO_ID.test(id) || !orderedTerms.has(id)) {
      throw new Error(`invalid GO ontology snapshot alt ID: ${altId}`);
    }
    altIdToId.set(altId, id);
  }
  for (const term of orderedTerms.values()) {
    for (const edge of term.parents) if (!orderedTerms.has(edge.parentId)) {
      throw new Error(`GO ontology snapshot edge has missing parent: ${term.id}/${edge.parentId}`);
    }
  }
  return Object.freeze({
    dataVersion: snapshot.dataVersion,
    sha256: snapshot.sourceSha256,
    terms: orderedTerms,
    altIdToId: new Map([...altIdToId.entries()].sort(([left], [right]) => compareText(left, right))),
  });
}

export async function loadGoOntologySnapshot(path: string | URL): Promise<GOOntology> {
  return parseGoOntologySnapshot(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/** Resolve a canonical or active alt_id; obsolete and unknown IDs return undefined. */
export function resolveGoId(ontology: GOOntology, goId: string): string | undefined {
  if (ontology.terms.has(goId)) return goId;
  return ontology.altIdToId.get(goId);
}

/** Resolve a canonical or active alt_id to its active term. */
export function resolveGoTerm(ontology: GOOntology, goId: string): GOTerm | undefined {
  const canonical = resolveGoId(ontology, goId);
  return canonical ? ontology.terms.get(canonical) : undefined;
}

/**
 * Return safe ancestors at their shortest distance from a GO term.
 *
 * Breadth-first traversal and explicit best-depth tracking make cycles harmless.
 * Results are ordered by depth and then GO ID, independent of OBO stanza order.
 */
export function ancestorsOf(
  ontology: GOOntology,
  goId: string,
  options: GOAncestorOptions = {},
): GOAncestor[] {
  const maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`maxDepth must be a non-negative safe integer, got ${String(maxDepth)}`);
  }
  if (maxDepth === 0) return [];

  const startId = resolveGoId(ontology, goId);
  if (!startId) return [];
  const start = ontology.terms.get(startId)!;
  const sameNamespace = options.sameNamespace ?? true;
  const excludeRoots = options.excludeRoots ?? true;
  const bestDepth = new Map<string, number>([[startId, 0]]);
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current.depth >= maxDepth) continue;
    const term = ontology.terms.get(current.id);
    if (!term) continue;
    for (const edge of term.parents) {
      const parent = ontology.terms.get(edge.parentId);
      if (!parent || (sameNamespace && parent.namespace !== start.namespace)) continue;
      const depth = current.depth + 1;
      const previous = bestDepth.get(parent.id);
      if (previous !== undefined && previous <= depth) continue;
      bestDepth.set(parent.id, depth);
      queue.push({ id: parent.id, depth });
    }
  }

  return [...bestDepth.entries()]
    .filter(([id, depth]) => depth > 0 && (!excludeRoots || !ROOT_IDS.has(id)))
    .map(([id, depth]) => {
      const term = ontology.terms.get(id)!;
      return { id, name: term.name, namespace: term.namespace, depth };
    })
    .sort((left, right) => left.depth - right.depth || compareText(left.id, right.id));
}

/** Descriptive alias intended for prediction-pipeline call sites. */
export const getGoAncestors = ancestorsOf;
