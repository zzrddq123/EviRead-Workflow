import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, hashCanonical, sha256Text } from "./hash.js";
import { canonicalAccession } from "./accession.js";
import { normalizeOmaRelation, type OrthologyRelation } from "./phylogeny.js";

export const DEFAULT_INTERPROSCAN_REST_URL = "https://www.ebi.ac.uk/Tools/services/rest/iprscan5";
export const DEFAULT_OMA_REST_URL = "https://omabrowser.org/api";
export const DEFAULT_EXTERNAL2GO_BASE_URL = "https://current.geneontology.org/ontology/external2go";

export type RemoteProviderMode = "disabled" | "remote";
export type RemoteFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RemoteCacheEntry {
  schemaVersion: "pi-remote-candidate-cache.v1";
  provider: "InterProScan" | "OMA";
  requestSha256: string;
  release: string;
  payload: string;
  payloadSha256: string;
}

export interface RemoteCandidateCache {
  get(key: string): Promise<RemoteCacheEntry | undefined>;
  set(key: string, entry: RemoteCacheEntry): Promise<void>;
}

export class MemoryRemoteCandidateCache implements RemoteCandidateCache {
  readonly #entries = new Map<string, RemoteCacheEntry>();

  async get(key: string): Promise<RemoteCacheEntry | undefined> {
    const entry = this.#entries.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  async set(key: string, entry: RemoteCacheEntry): Promise<void> {
    this.#entries.set(key, structuredClone(entry));
  }
}

/**
 * A small response cache suitable for the storage-light profile. Keys are
 * hashes, payload integrity is checked on every replay, and raw sequences are
 * never used as filenames.
 */
export class DirectoryRemoteCandidateCache implements RemoteCandidateCache {
  constructor(readonly directory: string) {}

  async get(key: string): Promise<RemoteCacheEntry | undefined> {
    if (!/^[0-9a-f]{64}$/.test(key)) return undefined;
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, `${key}.json`), "utf8")) as Partial<RemoteCacheEntry>;
      if (parsed.schemaVersion !== "pi-remote-candidate-cache.v1"
        || (parsed.provider !== "InterProScan" && parsed.provider !== "OMA")
        || typeof parsed.requestSha256 !== "string"
        || typeof parsed.release !== "string"
        || typeof parsed.payload !== "string"
        || typeof parsed.payloadSha256 !== "string"
        || sha256Text(parsed.payload) !== parsed.payloadSha256) return undefined;
      return parsed as RemoteCacheEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  async set(key: string, entry: RemoteCacheEntry): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Remote cache key must be a SHA-256 digest.");
    if (sha256Text(entry.payload) !== entry.payloadSha256) throw new Error("Remote cache payload digest mismatch.");
    await mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, `${key}.json`);
    const temporary = path.join(this.directory, `${key}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${canonicalJson(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  }
}

export interface RemoteProviderDependencies {
  fetch?: RemoteFetch;
  cache?: RemoteCandidateCache;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface InterProScanRemoteConfig {
  mode: RemoteProviderMode;
  email?: string;
  baseUrl?: string;
  applications?: string[];
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  releaseLabel?: string;
  /** Fetch the small official GO Consortium InterPro/Pfam mapping tables. */
  useExternal2Go?: boolean;
  external2GoBaseUrl?: string;
}

export interface OmaRemoteConfig {
  mode: RemoteProviderMode;
  baseUrl?: string;
  requestTimeoutMs?: number;
  minQueryCoverage?: number;
  minIdentity?: number;
  maxOrthologs?: number;
  maxConcurrentRequests?: number;
  queryLikeAccessions?: string[];
}

export interface OmaFastMapRemoteConfig {
  mode: RemoteProviderMode;
  baseUrl?: string;
  requestTimeoutMs?: number;
  /** Upper bound on GO rows retained from the single FastMap donor. */
  maxCandidates?: number;
  queryLikeAccessions?: string[];
}

export interface RemoteSequenceInput {
  sequence: string;
  targetTaxonId?: number | null;
  targetLineage?: string[];
}

export interface SnakeCaseProviderRecord {
  provider: "InterProScan" | "OMA" | "DeepGOPlus";
  status: "completed" | "unavailable" | "failed" | "disabled";
  endpoint_or_path: string;
  release: string | null;
  request_sha256: string | null;
  payload_sha256: string | null;
  cache_hit: boolean;
  reason: string | null;
}

export interface SnakeCaseGOCandidate {
  schema_version: "pi-go-candidate.v1";
  go_id: string;
  term_name: string;
  aspect: string;
  source_type: "interpro" | "pfam" | "panther" | "oma_ortholog" | "oma_fastmap" | "deepgoplus_cnn" | "deepgoplus_hybrid";
  source_id: string;
  mapping_id: string;
  provider: "InterProScan" | "OMA" | "DeepGOPlus";
  provider_release: string;
  provider_payload_sha256: string;
  evidence_id: string;
  provenance_root: string;
  base_score: number;
  query_coverage: number | null;
  domain_range: string | null;
  query_like: boolean;
  annotation_evidence_code: string;
  donor_accession: string | null;
  phylogeny: Record<string, unknown> | null;
}

export interface SnakeCaseCandidateSourceBundle {
  candidate_sources: {
    providers: SnakeCaseProviderRecord[];
    go_candidates: SnakeCaseGOCandidate[];
    /** Present only for the opt-in hash-bound DeepGOPlus learned channel. */
    deepgoplus_receipt?: Record<string, unknown>;
  };
}

class RemoteProviderError extends Error {
  constructor(readonly kind: "unavailable" | "failed", message: string) {
    super(message);
    this.name = "RemoteProviderError";
  }
}

interface TextReply {
  text: string;
  headers: Headers;
}

interface OmaAnchor {
  entryNr: string;
  omaId: string;
  canonicalId: string;
  sequenceMd5: string;
  coverage: number;
  identity: number;
  score: number;
}

interface OmaAnchorSummary {
  coverage: number;
  identity: number;
  score: number;
}

interface OmaAggregate {
  version: unknown;
  identification: unknown;
  anchor: OmaAnchorSummary;
  orthologs: unknown[];
  donors: Array<{
    ortholog: unknown;
    genome: unknown;
    go: unknown;
  }>;
  quarantinedCount: number;
  incompleteCount: number;
}

const OMA_QUERY_LIKE_IDENTITY = 0.99;
const OMA_QUERY_LIKE_QUERY_COVERAGE = 0.95;
const OMA_QUERY_LIKE_TARGET_COVERAGE = 0.95;
const OMA_SEQUENCE_GUARD_MAX_CELLS = 5_000_000;
const OMA_DATABASE_SCOPE_GUARD_VERSION = "virus-only-target-lineage.v1";

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function sanitizeSequence(value: string): string {
  const sequence = value.replace(/\s+/g, "").replace(/\*$/, "").toUpperCase();
  if (sequence.length === 0 || !/^[A-Z]+$/.test(sequence)) {
    throw new RemoteProviderError("failed", "The remote provider input was not a plain amino-acid sequence.");
  }
  return sequence;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round6(value: number): number {
  return Math.round(clamp01(value) * 1_000_000) / 1_000_000;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (Array.isArray(object?.results)) return object.results;
  if (Array.isArray(object?.targets)) return object.targets;
  return [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function normalizeAccession(value: unknown): string {
  return text(value).toUpperCase();
}

function md5(value: string): string {
  // OMA exposes sequence_md5; MD5 is used only as an equality key, never for security.
  return createHash("md5").update(value).digest("hex");
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${pathname.replace(/^\/+/, "")}`;
}

function providerError(error: unknown): RemoteProviderError {
  if (error instanceof RemoteProviderError) return error;
  if (error instanceof Error && (error.name === "AbortError" || /abort|timeout/i.test(error.message))) {
    return new RemoteProviderError("unavailable", "The remote provider request exceeded its bounded timeout.");
  }
  return new RemoteProviderError("unavailable", "The remote provider could not be reached.");
}

async function requestText(
  fetchFn: RemoteFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<TextReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new RemoteProviderError(
        transient ? "unavailable" : "failed",
        transient ? "The remote provider returned a transient HTTP failure." : "The remote provider rejected the bounded request.",
      );
    }
    return { text: await response.text(), headers: response.headers };
  } catch (error) {
    throw providerError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(fetchFn: RemoteFetch, url: string, timeoutMs: number): Promise<unknown> {
  const response = await requestText(fetchFn, url, { headers: { Accept: "application/json" } }, timeoutMs);
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new RemoteProviderError("failed", "The remote provider returned malformed JSON.");
  }
}

function emptyBundle(recordValue: SnakeCaseProviderRecord): SnakeCaseCandidateSourceBundle {
  return { candidate_sources: { providers: [recordValue], go_candidates: [] } };
}

function failureBundle(
  provider: SnakeCaseProviderRecord["provider"],
  endpointOrPath: string,
  requestSha256: string | null,
  error: RemoteProviderError,
): SnakeCaseCandidateSourceBundle {
  return emptyBundle({
    provider,
    status: error.kind,
    endpoint_or_path: endpointOrPath,
    release: null,
    request_sha256: requestSha256,
    payload_sha256: null,
    cache_hit: false,
    reason: error.message,
  });
}

function disabledBundle(provider: SnakeCaseProviderRecord["provider"], baseUrl: string): SnakeCaseCandidateSourceBundle {
  return emptyBundle({
    provider,
    status: "disabled",
    endpoint_or_path: baseUrl,
    release: null,
    request_sha256: null,
    payload_sha256: null,
    cache_hit: false,
    reason: "Remote access is opt-in and was not enabled for this provider.",
  });
}

function validCacheEntry(
  entry: RemoteCacheEntry | undefined,
  provider: RemoteCacheEntry["provider"],
  requestSha256: string,
): entry is RemoteCacheEntry {
  return entry !== undefined
    && entry.schemaVersion === "pi-remote-candidate-cache.v1"
    && entry.provider === provider
    && entry.requestSha256 === requestSha256
    && /^[0-9a-f]{64}$/.test(entry.payloadSha256)
    && sha256Text(entry.payload) === entry.payloadSha256;
}

function interProSource(analysis: string, signature: string, interPro: string): {
  sourceType: SnakeCaseGOCandidate["source_type"];
  sourceId: string;
} {
  if (/pfam/i.test(analysis) || /^PF\d+$/i.test(signature)) return { sourceType: "pfam", sourceId: signature.toUpperCase() };
  if (/panther/i.test(analysis) || /^PTHR/i.test(signature)) return { sourceType: "panther", sourceId: signature.toUpperCase() };
  if (/^IPR\d+$/i.test(interPro)) return { sourceType: "interpro", sourceId: interPro.toUpperCase() };
  return { sourceType: "interpro", sourceId: signature.toUpperCase() };
}

function parseAspect(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("molecular function")) return "molecular_function";
  if (normalized.includes("biological process")) return "biological_process";
  if (normalized.includes("cellular component")) return "cellular_component";
  return "unknown";
}

function parseInterProGoField(value: string): Array<{ goId: string; termName: string; aspect: string }> {
  const rows: Array<{ goId: string; termName: string; aspect: string }> = [];
  for (const chunk of value.split("|")) {
    const matches = chunk.match(/GO:\d{7}/gi) ?? [];
    for (const matched of matches) {
      const goId = matched.toUpperCase();
      const prefix = chunk.slice(0, chunk.toUpperCase().indexOf(goId)).replace(/[;:(>\s-]+$/g, "").trim();
      const termName = prefix.replace(/^(molecular function|biological process|cellular component)\s*[:>-]?\s*/i, "").trim();
      rows.push({ goId, termName: termName || "name unavailable", aspect: parseAspect(chunk) });
    }
  }
  return [...new Map(rows.map((item) => [item.goId, item])).values()].sort((left, right) => left.goId.localeCompare(right.goId));
}

export interface External2GoMapping {
  database: "InterPro" | "Pfam";
  sourceId: string;
  goId: string;
  termName: string;
}

/** Parse the GO Consortium external2go line format without trusting comments. */
export function parseExternal2Go(payload: string): External2GoMapping[] {
  const mappings: External2GoMapping[] = [];
  for (const rawLine of payload.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!")) continue;
    const match = line.match(/^(InterPro|Pfam):([^\s]+)\s+.*?>\s+GO:(.*?)\s*;\s*(GO:\d{7})\s*$/i);
    if (!match) continue;
    const database = /^interpro$/i.test(match[1] ?? "") ? "InterPro" : "Pfam";
    const sourceId = (match[2] ?? "").toUpperCase();
    const termName = (match[3] ?? "").trim() || "name unavailable";
    const goId = (match[4] ?? "").toUpperCase();
    if (!sourceId || !/^GO:\d{7}$/.test(goId)) continue;
    mappings.push({ database, sourceId, goId, termName });
  }
  return [...new Map(mappings.map((item) => [`${item.database}:${item.sourceId}:${item.goId}`, item])).values()]
    .sort((left, right) => left.database.localeCompare(right.database)
      || left.sourceId.localeCompare(right.sourceId)
      || left.goId.localeCompare(right.goId));
}

export function parseInterProScanTsv(
  payload: string,
  input: {
    queryLength: number;
    release: string;
    payloadSha256: string;
    externalMappings?: readonly External2GoMapping[];
  },
): SnakeCaseGOCandidate[] {
  const candidates: SnakeCaseGOCandidate[] = [];
  const mappingsBySource = new Map<string, External2GoMapping[]>();
  for (const mapping of input.externalMappings ?? []) {
    const key = `${mapping.database}:${mapping.sourceId}`;
    const current = mappingsBySource.get(key) ?? [];
    current.push(mapping);
    mappingsBySource.set(key, current);
  }
  for (const rawLine of payload.replace(/\r\n?/g, "\n").split("\n")) {
    if (!rawLine.trim() || rawLine.startsWith("#")) continue;
    const columns = rawLine.split("\t");
    // Official InterProScan TSV columns are: query, MD5, length, analysis,
    // signature accession/description, start/end, score, status, date,
    // InterPro accession/description, GO, pathways.
    if (columns.length < 14) continue;
    const analysis = columns[3]?.trim() ?? "";
    const signature = columns[4]?.trim() ?? "";
    const start = positiveInteger(columns[6]);
    const end = positiveInteger(columns[7]);
    const interPro = columns[11]?.trim() && /^IPR\d+$/i.test(columns[11].trim()) ? columns[11].trim() : "";
    // Official TSV puts GO terms after the InterPro accession/description. Be
    // tolerant of extra columns while never interpreting non-GO text as a term.
    const goField = columns.slice(13).filter((item) => /GO:\d{7}/i.test(item)).join("|");
    if (!signature || start === null || end === null || end < start) continue;
    const source = interProSource(analysis, signature, interPro);
    const coverage = round6((end - start + 1) / Math.max(1, input.queryLength));
    const provenanceRoot = `query-domain:${start}-${end}`;
    const direct = parseInterProGoField(goField).map((go) => ({
      ...go,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      mappingId: `interproscan:${source.sourceId}:${go.goId}`,
    }));
    const external = [
      ...(interPro ? mappingsBySource.get(`InterPro:${interPro.toUpperCase()}`) ?? [] : []),
      ...(/^PF\d+$/i.test(signature) ? mappingsBySource.get(`Pfam:${signature.toUpperCase()}`) ?? [] : []),
    ].map((mapping) => ({
      goId: mapping.goId,
      termName: mapping.termName,
      aspect: "unknown",
      sourceType: mapping.database === "Pfam" ? "pfam" as const : "interpro" as const,
      sourceId: mapping.sourceId,
      mappingId: `external2go:${mapping.database.toLowerCase()}:${mapping.sourceId}:${mapping.goId}`,
    }));
    const mappedTerms = [...new Map([...direct, ...external]
      .map((item) => [`${item.sourceType}:${item.sourceId}:${item.goId}`, item])).values()];
    for (const go of mappedTerms) {
      const token = hashCanonical({ provider: "InterProScan", sourceId: go.sourceId, goId: go.goId, start, end, payload: input.payloadSha256 });
      candidates.push({
        schema_version: "pi-go-candidate.v1",
        go_id: go.goId,
        term_name: go.termName,
        aspect: go.aspect,
        source_type: go.sourceType,
        source_id: go.sourceId,
        mapping_id: go.mappingId,
        provider: "InterProScan",
        provider_release: input.release,
        provider_payload_sha256: input.payloadSha256,
        evidence_id: `CAND-IPR-${token.slice(0, 16)}`,
        provenance_root: provenanceRoot,
        base_score: round6((go.sourceType === "interpro" ? 0.82 : 0.76) * (0.75 + 0.25 * coverage)),
        query_coverage: coverage,
        domain_range: `${start}-${end}`,
        query_like: false,
        annotation_evidence_code: "IEA",
        donor_accession: null,
        phylogeny: null,
      });
    }
  }
  return [...new Map(candidates.map((item) => [
    `${item.go_id}:${item.source_type}:${item.source_id}:${item.provenance_root}`,
    item,
  ])).values()].sort((left, right) => left.go_id.localeCompare(right.go_id)
    || left.provenance_root.localeCompare(right.provenance_root)
    || left.source_id.localeCompare(right.source_id));
}

interface LoadedExternal2Go {
  mappings: External2GoMapping[];
  release: string;
  payloadSha256: string;
}

function external2GoRelease(payload: string): string {
  const version = payload.match(/^!version date:\s*(.+)$/mi)?.[1]?.trim();
  return version ? `go-external2go-${version.replace(/\s+/g, "_")}` : "go-external2go-current";
}

async function loadExternal2Go(
  config: InterProScanRemoteConfig,
  fetchFn: RemoteFetch,
  dependencies: RemoteProviderDependencies,
): Promise<LoadedExternal2Go | undefined> {
  if (config.useExternal2Go !== true) return undefined;
  const baseUrl = normalizeBaseUrl(config.external2GoBaseUrl ?? DEFAULT_EXTERNAL2GO_BASE_URL);
  const requestSha256 = hashCanonical({ provider: "GO-external2go", baseUrl, files: ["interpro2go", "pfam2go"] });
  const cacheKey = sha256Text(`InterProScan:${requestSha256}`);
  const cached = await dependencies.cache?.get(cacheKey);
  if (validCacheEntry(cached, "InterProScan", requestSha256)) {
    try {
      const parsed = JSON.parse(cached.payload) as { interpro2go?: unknown; pfam2go?: unknown };
      if (typeof parsed.interpro2go === "string" && typeof parsed.pfam2go === "string") {
        return {
          mappings: [...parseExternal2Go(parsed.interpro2go), ...parseExternal2Go(parsed.pfam2go)],
          release: cached.release,
          payloadSha256: cached.payloadSha256,
        };
      }
    } catch {
      // Treat a malformed cache entry as a miss and refresh from the authority.
    }
  }
  try {
    const timeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000);
    const [interpro, pfam] = await Promise.all([
      requestText(fetchFn, endpoint(baseUrl, "interpro2go"), { headers: { Accept: "text/plain" } }, timeoutMs),
      requestText(fetchFn, endpoint(baseUrl, "pfam2go"), { headers: { Accept: "text/plain" } }, timeoutMs),
    ]);
    const payload = canonicalJson({ interpro2go: interpro.text, pfam2go: pfam.text });
    const payloadSha256 = sha256Text(payload);
    const release = external2GoRelease(interpro.text);
    await dependencies.cache?.set(cacheKey, {
      schemaVersion: "pi-remote-candidate-cache.v1",
      provider: "InterProScan",
      requestSha256,
      release,
      payload,
      payloadSha256,
    });
    return {
      mappings: [...parseExternal2Go(interpro.text), ...parseExternal2Go(pfam.text)],
      release,
      payloadSha256,
    };
  } catch {
    // External2GO expands coverage but is not allowed to turn an otherwise
    // valid InterProScan result into a hard failure.
    return undefined;
  }
}

function interProCompletedBundle(input: {
  baseUrl: string;
  requestSha256: string;
  release: string;
  payload: string;
  queryLength: number;
  cacheHit: boolean;
  external2Go?: LoadedExternal2Go;
}): SnakeCaseCandidateSourceBundle {
  const rawPayloadSha256 = sha256Text(input.payload);
  const payloadSha256 = input.external2Go
    ? hashCanonical({ interProScanPayloadSha256: rawPayloadSha256, external2GoPayloadSha256: input.external2Go.payloadSha256 })
    : rawPayloadSha256;
  const release = input.external2Go ? `${input.release}+${input.external2Go.release}` : input.release;
  return {
    candidate_sources: {
      providers: [{
        provider: "InterProScan",
        status: "completed",
        endpoint_or_path: input.baseUrl,
        release,
        request_sha256: input.requestSha256,
        payload_sha256: payloadSha256,
        cache_hit: input.cacheHit,
        reason: null,
      }],
      go_candidates: parseInterProScanTsv(input.payload, {
        queryLength: input.queryLength,
        release,
        payloadSha256,
        externalMappings: input.external2Go?.mappings,
      }),
    },
  };
}

export async function runInterProScanRemote(
  rawInput: RemoteSequenceInput,
  config: InterProScanRemoteConfig,
  dependencies: RemoteProviderDependencies = {},
): Promise<SnakeCaseCandidateSourceBundle> {
  const baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_INTERPROSCAN_REST_URL);
  if (config.mode !== "remote") return disabledBundle("InterProScan", baseUrl);
  let sequence: string;
  try {
    sequence = sanitizeSequence(rawInput.sequence);
  } catch (error) {
    return failureBundle("InterProScan", baseUrl, null, providerError(error));
  }
  // These are the case-sensitive values advertised by Job Dispatcher's
  // /parameterdetails/appl endpoint (labels differ from submitted values).
  const applications = [...new Set(config.applications ?? ["PfamA", "Panther", "Gene3d"])].sort();
  const release = config.releaseLabel?.trim() || "ebi-job-dispatcher-current";
  const requestSha256 = hashCanonical({
    provider: "InterProScan",
    baseUrl,
    sequenceSha256: sha256Text(sequence),
    applications,
    goterms: true,
    stype: "p",
  });
  const cacheKey = sha256Text(`InterProScan:${requestSha256}`);
  const fetchFn: RemoteFetch = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const external2Go = await loadExternal2Go(config, fetchFn, dependencies);
  const cached = await dependencies.cache?.get(cacheKey);
  if (validCacheEntry(cached, "InterProScan", requestSha256)) {
    return interProCompletedBundle({ baseUrl, requestSha256, release: cached.release, payload: cached.payload, queryLength: sequence.length, cacheHit: true, external2Go });
  }
  if (!config.email?.trim() || !/^\S+@\S+\.\S+$/.test(config.email.trim())) {
    return failureBundle("InterProScan", baseUrl, requestSha256, new RemoteProviderError("failed", "InterProScan remote mode requires a valid contact email."));
  }
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000);
  const maxPolls = Math.max(1, Math.floor(config.maxPolls ?? 90));
  const pollIntervalMs = Math.max(0, config.pollIntervalMs ?? 5_000);
  try {
    const body = new URLSearchParams({
      email: config.email.trim(),
      title: `anonymous-${sha256Text(sequence).slice(0, 12)}`,
      stype: "p",
      sequence,
      goterms: "true",
      pathways: "false",
      appl: applications.join(","),
    });
    const submitted = await requestText(fetchFn, endpoint(baseUrl, "run"), {
      method: "POST",
      headers: { Accept: "text/plain", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, requestTimeoutMs);
    const jobId = submitted.text.trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(jobId)) throw new RemoteProviderError("failed", "InterProScan returned an invalid job handle.");
    let finished = false;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (poll > 0 && pollIntervalMs > 0) await sleep(pollIntervalMs);
      const status = (await requestText(fetchFn, endpoint(baseUrl, `status/${encodeURIComponent(jobId)}`), {
        headers: { Accept: "text/plain" },
      }, requestTimeoutMs)).text.trim().toUpperCase();
      if (status === "FINISHED") {
        finished = true;
        break;
      }
      if (["ERROR", "FAILURE", "NOT_FOUND"].includes(status)) {
        throw new RemoteProviderError("failed", "InterProScan reported a terminal job failure.");
      }
      if (!["PENDING", "RUNNING", "QUEUED", "WAITING"].includes(status)) {
        throw new RemoteProviderError("failed", "InterProScan returned an unknown job status.");
      }
    }
    if (!finished) throw new RemoteProviderError("unavailable", "InterProScan did not finish within the configured poll budget.");
    const result = await requestText(fetchFn, endpoint(baseUrl, `result/${encodeURIComponent(jobId)}/tsv`), {
      headers: { Accept: "text/tab-separated-values, text/plain" },
    }, requestTimeoutMs);
    const payloadSha256 = sha256Text(result.text);
    await dependencies.cache?.set(cacheKey, {
      schemaVersion: "pi-remote-candidate-cache.v1",
      provider: "InterProScan",
      requestSha256,
      release,
      payload: result.text,
      payloadSha256,
    });
    return interProCompletedBundle({ baseUrl, requestSha256, release, payload: result.text, queryLength: sequence.length, cacheHit: false, external2Go });
  } catch (error) {
    return failureBundle("InterProScan", baseUrl, requestSha256, providerError(error));
  }
}

function alignedMetrics(query: string, target: Record<string, unknown>, identifiedBy: string): { coverage: number; identity: number } {
  const alignment = Array.isArray(target.alignment) ? target.alignment.map(text) : [];
  const queryAligned = alignment[0] ?? "";
  const targetAligned = alignment[1] ?? "";
  if (queryAligned && targetAligned) {
    const width = Math.min(queryAligned.length, targetAligned.length);
    let queryResidues = 0;
    let compared = 0;
    let matches = 0;
    for (let index = 0; index < width; index += 1) {
      const left = queryAligned[index]?.toUpperCase();
      const right = targetAligned[index]?.toUpperCase();
      const leftResidue = left !== "-" && left !== "_" && left !== ".";
      const rightResidue = right !== "-" && right !== "_" && right !== ".";
      if (leftResidue) queryResidues += 1;
      if (leftResidue && rightResidue) {
        compared += 1;
        if (left === right) matches += 1;
      }
    }
    return { coverage: round6(queryResidues / Math.max(1, query.length)), identity: round6(matches / Math.max(1, compared)) };
  }
  const targetSequence = text(target.sequence).replace(/\s+/g, "").toUpperCase();
  if (/exact/i.test(identifiedBy) && targetSequence === query) return { coverage: 1, identity: 1 };
  const alignedLength = positiveInteger(target.alignment_length ?? target.align_length ?? target.overlap_length);
  const coverage = target.query_coverage !== undefined
    ? clamp01(finiteNumber(target.query_coverage))
    : (alignedLength === null ? 0 : clamp01(alignedLength / Math.max(1, query.length)));
  const identityRaw = finiteNumber(target.identity ?? target.sequence_identity ?? target.identity_percentage, 0);
  return { coverage: round6(coverage > 1 ? coverage / 100 : coverage), identity: round6(identityRaw > 1 ? identityRaw / 100 : identityRaw) };
}

function identifyOmaAnchor(
  payload: unknown,
  sequence: string,
  minimumCoverage: number,
  minimumIdentity: number,
): OmaAnchor | undefined {
  const root = record(payload);
  const targets = arrayPayload(root?.targets ?? payload);
  const identifiedBy = text(root?.identified_by ?? root?.identifiedBy);
  const anchors = targets.map((item): OmaAnchor | undefined => {
    const target = record(item);
    if (!target) return undefined;
    const entryNr = String(positiveInteger(target.entry_nr ?? target.entryNr) ?? "");
    if (!entryNr) return undefined;
    const metrics = alignedMetrics(sequence, target, identifiedBy);
    return {
      entryNr,
      omaId: normalizeAccession(target.omaid ?? target.oma_id),
      canonicalId: canonicalAccession(target.canonicalid ?? target.canonical_id),
      sequenceMd5: text(target.sequence_md5).toLowerCase(),
      coverage: metrics.coverage,
      identity: metrics.identity,
      score: finiteNumber(target.alignment_score ?? target.score, 0),
    };
  }).filter((item): item is OmaAnchor => item !== undefined)
    .filter((item) => item.coverage >= minimumCoverage && item.identity >= minimumIdentity)
    .sort((left, right) => right.coverage - left.coverage
      || right.identity - left.identity
      || right.score - left.score
      || Number(left.entryNr) - Number(right.entryNr));
  return anchors[0];
}

function omaRelease(version: unknown): string {
  const item = record(version);
  const oma = text(item?.oma_version ?? item?.omaVersion) || "unversioned";
  const api = text(item?.api_version ?? item?.apiVersion);
  return api ? `${oma};api-${api}` : oma;
}

function omaDatabaseScopeError(versionOrRelease: unknown, targetLineage: readonly string[]): RemoteProviderError | undefined {
  const release = typeof versionOrRelease === "string" ? versionOrRelease : omaRelease(versionOrRelease);
  const databaseRelease = release.split(";", 1)[0]?.trim() ?? "";
  const virusOnly = /^(?:viruses?|viral|corona(?:virus(?:es)?)?)(?:$|[.\s_:/-])/i.test(databaseRelease);
  const viralTarget = targetLineage.some((item) => {
    const lineage = item.trim();
    return /(?:^|[^a-z])(?:viruses?|viral|coronaviruses?)(?:[^a-z]|$)|(?:viria|virae|viricota|viricetes|virales|viridae|virinae|virus)$/i.test(lineage);
  });
  if (!virusOnly || viralTarget) return undefined;
  return new RemoteProviderError(
    "unavailable",
    "The OMA database release is virus-only, but the declared target lineage is missing or non-viral.",
  );
}

function orthologSort(left: unknown, right: unknown): number {
  const a = record(left) ?? {};
  const b = record(right) ?? {};
  const relationRank = (value: unknown): number => {
    const relation = normalizeOmaRelation(text(value));
    return ({ one_to_one: 0, one_to_many: 1, many_to_one: 1, coortholog: 2, many_to_many: 3, unresolved_ortholog: 4, post_duplication_paralog: 5 } as Record<OrthologyRelation, number>)[relation];
  };
  return relationRank(a.rel_type ?? a.relation) - relationRank(b.rel_type ?? b.relation)
    || finiteNumber(b.score, 0) - finiteNumber(a.score, 0)
    || finiteNumber(a.distance, Number.MAX_SAFE_INTEGER) - finiteNumber(b.distance, Number.MAX_SAFE_INTEGER)
    || finiteNumber(a.entry_nr ?? a.entryNr, Number.MAX_SAFE_INTEGER) - finiteNumber(b.entry_nr ?? b.entryNr, Number.MAX_SAFE_INTEGER);
}

function queryLikeOrtholog(
  ortholog: Record<string, unknown>,
  anchor: OmaAnchor,
  queryMd5: string,
  queryLikeAccessions: Set<string>,
): boolean {
  const entry = String(positiveInteger(ortholog.entry_nr ?? ortholog.entryNr) ?? "");
  const omaId = normalizeAccession(ortholog.omaid ?? ortholog.oma_id);
  const canonicalId = canonicalAccession(ortholog.canonicalid ?? ortholog.canonical_id);
  const sequenceMd5 = text(ortholog.sequence_md5).toLowerCase();
  return entry === anchor.entryNr
    || (!!omaId && omaId === anchor.omaId)
    || (!!canonicalId && canonicalId === anchor.canonicalId)
    || (!!sequenceMd5 && (sequenceMd5 === queryMd5 || sequenceMd5 === anchor.sequenceMd5))
    || (!!omaId && queryLikeAccessions.has(omaId))
    || (!!canonicalId && queryLikeAccessions.has(canonicalId));
}

type OmaSequenceDisposition = "query_like" | "distinct" | "unverifiable";

function omaProteinRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value);
  if (direct) return direct;
  return arrayPayload(value).map(record).find((item) => item !== undefined);
}

function omaProteinSequence(value: unknown): string | undefined {
  const item = omaProteinRecord(value);
  const nestedProtein = record(item?.protein);
  const raw = text(item?.sequence ?? item?.protein_sequence ?? nestedProtein?.sequence);
  if (!raw) return undefined;
  try {
    return sanitizeSequence(raw);
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed near-self guard for OMA donors.
 *
 * GO may only be requested after the donor's own sequence has been fetched.
 * The band contains every alignment capable of meeting both 95% coverage
 * floors. A banded LCS is deliberately conservative: it may quarantine an
 * ambiguous donor, but it cannot admit a donor that has a >=99%-identical,
 * dual-high-coverage alignment hidden behind a different accession/isoform.
 */
function omaSequenceDisposition(query: string, donor: string): OmaSequenceDisposition {
  const queryLength = query.length;
  const donorLength = donor.length;
  const requiredPairs = Math.max(
    Math.ceil(OMA_QUERY_LIKE_QUERY_COVERAGE * queryLength),
    Math.ceil(OMA_QUERY_LIKE_TARGET_COVERAGE * donorLength),
  );
  if (requiredPairs > Math.min(queryLength, donorLength)) return "distinct";

  const requiredMatches = Math.ceil(OMA_QUERY_LIKE_IDENTITY * requiredPairs);
  const totalGapAllowance = queryLength + donorLength - (2 * requiredPairs);
  const band = Math.max(Math.abs(queryLength - donorLength), totalGapAllowance);
  const estimatedCells = (Math.min(queryLength, donorLength) + 1) * ((2 * band) + 1);
  if (!Number.isSafeInteger(estimatedCells) || estimatedCells > OMA_SEQUENCE_GUARD_MAX_CELLS) {
    return "unverifiable";
  }

  // Use the shorter string for rows to keep the number of Map allocations
  // bounded. Coverage thresholds and LCS are symmetric.
  const rows = queryLength <= donorLength ? query : donor;
  const columns = queryLength <= donorLength ? donor : query;
  let previous = new Map<number, number>();
  for (let column = 0; column <= Math.min(columns.length, band); column += 1) previous.set(column, 0);

  for (let row = 1; row <= rows.length; row += 1) {
    const current = new Map<number, number>();
    const firstColumn = Math.max(0, row - band);
    const lastColumn = Math.min(columns.length, row + band);
    if (firstColumn === 0) current.set(0, 0);
    for (let column = Math.max(1, firstColumn); column <= lastColumn; column += 1) {
      let best = -1;
      const above = previous.get(column);
      if (above !== undefined) best = Math.max(best, above);
      const left = current.get(column - 1);
      if (left !== undefined) best = Math.max(best, left);
      const diagonal = previous.get(column - 1);
      if (diagonal !== undefined && rows[row - 1] === columns[column - 1]) best = Math.max(best, diagonal + 1);
      if (best >= 0) current.set(column, best);
    }
    previous = current;
  }
  const maximumMatches = previous.get(columns.length);
  if (maximumMatches === undefined) return "unverifiable";
  return maximumMatches >= requiredMatches ? "query_like" : "distinct";
}

async function mapLimit<T, R>(values: readonly T[], limit: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) break;
      output[index] = await task(values[index] as T);
    }
  });
  await Promise.all(workers);
  return output;
}

async function fetchOmaAggregate(input: {
  fetchFn: RemoteFetch;
  baseUrl: string;
  sequence: string;
  targetLineage: string[];
  requestTimeoutMs: number;
  minQueryCoverage: number;
  minIdentity: number;
  maxOrthologs: number;
  maxConcurrentRequests: number;
  queryLikeAccessions: Set<string>;
}): Promise<OmaAggregate> {
  const version = await requestJson(input.fetchFn, endpoint(input.baseUrl, "version/"), input.requestTimeoutMs);
  const scopeError = omaDatabaseScopeError(version, input.targetLineage);
  if (scopeError) throw scopeError;
  const search = new URL(endpoint(input.baseUrl, "sequence/"));
  search.searchParams.set("query", input.sequence);
  search.searchParams.set("search", "mixed");
  search.searchParams.set("full_length", "true");
  const identification = await requestJson(input.fetchFn, search.toString(), input.requestTimeoutMs);
  const anchor = identifyOmaAnchor(identification, input.sequence, input.minQueryCoverage, input.minIdentity);
  if (!anchor) {
    throw new RemoteProviderError("unavailable", "OMA returned no full-length sequence mapping above the configured coverage and identity floors.");
  }
  const orthologPayload = await requestJson(input.fetchFn, endpoint(input.baseUrl, `protein/${encodeURIComponent(anchor.entryNr)}/orthologs/`), input.requestTimeoutMs);
  const queryMd5 = md5(input.sequence);
  let quarantinedCount = 0;
  const retained = arrayPayload(orthologPayload).sort(orthologSort).filter((value) => {
    const item = record(value);
    if (!item || positiveInteger(item.entry_nr ?? item.entryNr) === null) return false;
    if (queryLikeOrtholog(item, anchor, queryMd5, input.queryLikeAccessions)) {
      quarantinedCount += 1;
      return false;
    }
    return true;
  }).slice(0, input.maxOrthologs);
  const genomeRequests = new Map<string, Promise<unknown>>();
  let incompleteCount = 0;
  const donorResults = await mapLimit(retained, input.maxConcurrentRequests, async (ortholog) => {
    const item = record(ortholog) ?? {};
    const entryNr = String(positiveInteger(item.entry_nr ?? item.entryNr) ?? "");
    const omaId = normalizeAccession(item.omaid ?? item.oma_id);
    try {
      // A different OMA entry/accession can still be an alias or near-identical
      // isoform of the query. Fetch and verify the donor sequence before its GO
      // endpoint is ever touched. Missing/invalid/too-expensive verification is
      // fail-closed and therefore cannot leak a target-like annotation.
      const detail = await requestJson(input.fetchFn, endpoint(input.baseUrl, `protein/${encodeURIComponent(entryNr)}/`), input.requestTimeoutMs);
      const detailRecord = omaProteinRecord(detail) ?? {};
      if (queryLikeOrtholog({ ...item, ...detailRecord }, anchor, queryMd5, input.queryLikeAccessions)) {
        quarantinedCount += 1;
        return undefined;
      }
      const donorSequence = omaProteinSequence(detail);
      if (!donorSequence) {
        incompleteCount += 1;
        return undefined;
      }
      const disposition = omaSequenceDisposition(input.sequence, donorSequence);
      if (disposition === "query_like") {
        quarantinedCount += 1;
        return undefined;
      }
      if (disposition === "unverifiable") {
        incompleteCount += 1;
        return undefined;
      }

      // Deliberately request GO only for sequence-verified, non-query-like
      // orthologs. The mapped anchor's GO endpoint is never touched.
      const go = await requestJson(input.fetchFn, endpoint(input.baseUrl, `protein/${encodeURIComponent(entryNr)}/gene_ontology/`), input.requestTimeoutMs);
      const speciesCode = omaId.slice(0, 5);
      let genome: unknown = {};
      if (speciesCode) {
        const pending = genomeRequests.get(speciesCode)
          ?? requestJson(input.fetchFn, endpoint(input.baseUrl, `genome/${encodeURIComponent(speciesCode)}/`), input.requestTimeoutMs);
        genomeRequests.set(speciesCode, pending);
        genome = await pending;
      }
      return { ortholog, genome, go };
    } catch {
      incompleteCount += 1;
      return undefined;
    }
  });
  const donors = donorResults.filter((item): item is OmaAggregate["donors"][number] => item !== undefined);
  if (retained.length > 0 && donors.length === 0) {
    throw new RemoteProviderError("unavailable", "OMA identified an anchor, but no donor passed sequence verification with available ortholog annotations.");
  }
  return {
    version,
    // The sequence-identification response can embed the mapped target's GO,
    // cross-references, sequence, and name. Persist only aggregate diagnostics:
    // target identity and existing target labels must not enter the cache.
    identification: {
      identifiedBy: text(record(identification)?.identified_by ?? record(identification)?.identifiedBy),
      targetCount: arrayPayload(record(identification)?.targets ?? identification).length,
    },
    anchor: { coverage: anchor.coverage, identity: anchor.identity, score: anchor.score },
    orthologs: donors.map((item) => item.ortholog),
    donors,
    quarantinedCount,
    incompleteCount,
  };
}

function omaBaseScore(relation: OrthologyRelation, coverage: number, identity: number): number {
  const relationWeight: Record<OrthologyRelation, number> = {
    one_to_one: 0.92,
    one_to_many: 0.78,
    many_to_one: 0.78,
    many_to_many: 0.64,
    coortholog: 0.72,
    unresolved_ortholog: 0.52,
    post_duplication_paralog: 0.25,
  };
  return round6(relationWeight[relation] * (0.7 + 0.3 * coverage) * (0.7 + 0.3 * identity));
}

function parseOmaAggregate(input: {
  aggregate: OmaAggregate;
  targetTaxonId: number | null;
  targetLineage: string[];
  release: string;
  payloadSha256: string;
}): SnakeCaseGOCandidate[] {
  const candidates: SnakeCaseGOCandidate[] = [];
  for (const donor of input.aggregate.donors) {
    const ortholog = record(donor.ortholog) ?? {};
    const genome = record(donor.genome) ?? {};
    const entryNr = String(positiveInteger(ortholog.entry_nr ?? ortholog.entryNr) ?? "");
    const omaId = normalizeAccession(ortholog.omaid ?? ortholog.oma_id);
    const canonicalId = canonicalAccession(ortholog.canonicalid ?? ortholog.canonical_id);
    const donorAccession = canonicalId || omaId || `OMA-ENTRY-${entryNr}`;
    const hogId = text(ortholog.oma_hog_id ?? ortholog.hog_id) || null;
    const relation = normalizeOmaRelation(text(ortholog.rel_type ?? ortholog.relation));
    const distanceValue = ortholog.distance === null || ortholog.distance === undefined ? null : finiteNumber(ortholog.distance, -1);
    const distance = distanceValue !== null && distanceValue >= 0 ? distanceValue : null;
    const donorTaxonId = positiveInteger(genome.taxon_id ?? genome.taxonId);
    // OMA returns species-to-root; the rest of the pipeline uses root-to-tip.
    const donorLineage = stringArray(genome.lineage).reverse();
    const provenanceRoot = `oma-clade:${hogId ?? `taxon-${donorTaxonId ?? "unknown"}`}`;
    for (const rawGo of arrayPayload(donor.go)) {
      const go = record(rawGo);
      if (!go) continue;
      const goId = text(go.GO_term ?? go.go_term ?? go.goId).toUpperCase();
      if (!/^GO:\d{7}$/.test(goId)) continue;
      const aspect = text(go.aspect) || "unknown";
      const evidenceCode = text(go.evidence).toUpperCase() || "IEA";
      const token = hashCanonical({ provider: "OMA", donor: donorAccession, goId, relation, payload: input.payloadSha256 });
      const phylogenyToken = hashCanonical({ provider: "OMA", donor: donorAccession, hogId, relation, payload: input.payloadSha256 });
      candidates.push({
        schema_version: "pi-go-candidate.v1",
        go_id: goId,
        term_name: text(go.name) || "name unavailable",
        aspect,
        source_type: "oma_ortholog",
        source_id: hogId ?? donorAccession,
        mapping_id: `oma-ortholog:${donorAccession}:${goId}`,
        provider: "OMA",
        provider_release: input.release,
        provider_payload_sha256: input.payloadSha256,
        evidence_id: `CAND-OMA-${token.slice(0, 16)}`,
        provenance_root: provenanceRoot,
        base_score: omaBaseScore(relation, input.aggregate.anchor.coverage, input.aggregate.anchor.identity),
        query_coverage: input.aggregate.anchor.coverage,
        domain_range: null,
        query_like: false,
        annotation_evidence_code: evidenceCode,
        donor_accession: donorAccession,
        phylogeny: {
          schema_version: "pi-phylogeny-evidence.v1",
          provider: "OMA",
          provider_release: input.release,
          provider_payload_sha256: input.payloadSha256,
          evidence_id: `PHY-OMA-${phylogenyToken.slice(0, 16)}`,
          provenance_root: provenanceRoot,
          target_taxon_id: input.targetTaxonId,
          target_lineage: input.targetLineage,
          donor_taxon_id: donorTaxonId,
          donor_lineage: donorLineage,
          relation,
          evolutionary_distance: distance,
          hog_id: hogId,
          query_like: false,
        },
      });
    }
  }
  return candidates.sort((left, right) => left.go_id.localeCompare(right.go_id)
    || left.provenance_root.localeCompare(right.provenance_root)
    || (left.donor_accession ?? "").localeCompare(right.donor_accession ?? ""));
}

function parseCachedOmaAggregate(payload: string): OmaAggregate {
  try {
    const parsed = JSON.parse(payload) as Partial<OmaAggregate>;
    if (!record(parsed.anchor) || !Array.isArray(parsed.orthologs) || !Array.isArray(parsed.donors)) {
      throw new Error("bad cache");
    }
    return parsed as OmaAggregate;
  } catch {
    throw new RemoteProviderError("failed", "The OMA cache entry was malformed.");
  }
}

function omaCompletedBundle(input: {
  baseUrl: string;
  requestSha256: string;
  aggregate: OmaAggregate;
  release: string;
  payload: string;
  targetTaxonId: number | null;
  targetLineage: string[];
  cacheHit: boolean;
}): SnakeCaseCandidateSourceBundle {
  const payloadSha256 = sha256Text(input.payload);
  const detailCount = input.aggregate.incompleteCount;
  const quarantineCount = input.aggregate.quarantinedCount;
  const reasons: string[] = [];
  if (quarantineCount > 0) reasons.push(`${quarantineCount} query-like ortholog record(s) were quarantined before GO retrieval.`);
  if (detailCount > 0) reasons.push(`${detailCount} donor sequence verification or ortholog annotation request(s) were unavailable and excluded.`);
  return {
    candidate_sources: {
      providers: [{
        provider: "OMA",
        status: "completed",
        endpoint_or_path: input.baseUrl,
        release: input.release,
        request_sha256: input.requestSha256,
        payload_sha256: payloadSha256,
        cache_hit: input.cacheHit,
        reason: reasons.join(" ") || null,
      }],
      go_candidates: parseOmaAggregate({
        aggregate: input.aggregate,
        targetTaxonId: input.targetTaxonId,
        targetLineage: input.targetLineage,
        release: input.release,
        payloadSha256,
      }),
    },
  };
}

export async function runOmaRemote(
  rawInput: RemoteSequenceInput,
  config: OmaRemoteConfig,
  dependencies: RemoteProviderDependencies = {},
): Promise<SnakeCaseCandidateSourceBundle> {
  const baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_OMA_REST_URL);
  if (config.mode !== "remote") return disabledBundle("OMA", baseUrl);
  let sequence: string;
  try {
    sequence = sanitizeSequence(rawInput.sequence);
  } catch (error) {
    return failureBundle("OMA", baseUrl, null, providerError(error));
  }
  const minQueryCoverage = clamp01(config.minQueryCoverage ?? 0.65);
  const minIdentity = clamp01(config.minIdentity ?? 0.25);
  const maxOrthologs = Math.max(1, Math.min(100, Math.floor(config.maxOrthologs ?? 25)));
  const maxConcurrentRequests = Math.max(1, Math.min(8, Math.floor(config.maxConcurrentRequests ?? 4)));
  const queryLikeAccessions = new Set((config.queryLikeAccessions ?? []).map(canonicalAccession).filter(Boolean));
  const targetTaxonId = positiveInteger(rawInput.targetTaxonId) ?? null;
  const targetLineage = (rawInput.targetLineage ?? []).map((item) => item.trim()).filter(Boolean);
  const requestSha256 = hashCanonical({
    provider: "OMA",
    baseUrl,
    sequenceSha256: sha256Text(sequence),
    search: "mixed",
    fullLength: true,
    minQueryCoverage,
    minIdentity,
    maxOrthologs,
    donorSequenceGuard: {
      algorithm: "banded-lcs.v1",
      identity: OMA_QUERY_LIKE_IDENTITY,
      queryCoverage: OMA_QUERY_LIKE_QUERY_COVERAGE,
      targetCoverage: OMA_QUERY_LIKE_TARGET_COVERAGE,
      sequenceRequiredBeforeGo: true,
      maxCells: OMA_SEQUENCE_GUARD_MAX_CELLS,
    },
    databaseScopeGuard: OMA_DATABASE_SCOPE_GUARD_VERSION,
    queryLikeBindingSha256: hashCanonical([...queryLikeAccessions].sort()),
    targetTaxonId,
    targetLineage,
  });
  const cacheKey = sha256Text(`OMA:${requestSha256}`);
  const cached = await dependencies.cache?.get(cacheKey);
  if (validCacheEntry(cached, "OMA", requestSha256)) {
    try {
      const aggregate = parseCachedOmaAggregate(cached.payload);
      const scopeError = omaDatabaseScopeError(cached.release, targetLineage)
        ?? omaDatabaseScopeError(aggregate.version, targetLineage);
      if (scopeError) return failureBundle("OMA", baseUrl, requestSha256, scopeError);
      return omaCompletedBundle({ baseUrl, requestSha256, aggregate, release: cached.release, payload: cached.payload, targetTaxonId, targetLineage, cacheHit: true });
    } catch {
      // A corrupt-but-well-hashed payload is ignored and refreshed remotely.
    }
  }
  const fetchFn: RemoteFetch = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000);
  try {
    const aggregate = await fetchOmaAggregate({
      fetchFn,
      baseUrl,
      sequence,
      targetLineage,
      requestTimeoutMs,
      minQueryCoverage,
      minIdentity,
      maxOrthologs,
      maxConcurrentRequests,
      queryLikeAccessions,
    });
    const release = omaRelease(aggregate.version);
    const payload = canonicalJson(aggregate);
    const payloadSha256 = sha256Text(payload);
    if (aggregate.incompleteCount === 0) {
      await dependencies.cache?.set(cacheKey, {
        schemaVersion: "pi-remote-candidate-cache.v1",
        provider: "OMA",
        requestSha256,
        release,
        payload,
        payloadSha256,
      });
    }
    return omaCompletedBundle({ baseUrl, requestSha256, aggregate, release, payload, targetTaxonId, targetLineage, cacheHit: false });
  } catch (error) {
    return failureBundle("OMA", baseUrl, requestSha256, providerError(error));
  }
}

interface OmaFastMapRow {
  goId: string;
  termName: string;
  aspect: string;
}

interface OmaFastMapAggregate {
  version: unknown;
  donorId: string;
  donorCanonicalId: string;
  rawAlignmentScore: number;
  rows: OmaFastMapRow[];
}

function parseOmaFastMapWith(value: unknown): { mode: "Exact" | "Approx"; donorId: string; rawAlignmentScore: number } | undefined {
  const raw = text(value);
  const match = raw.match(/^(Exact|Approx):([^:]+)(?::([0-9]+(?:\.[0-9]+)?))?$/i);
  if (!match) return undefined;
  const mode = /^exact$/i.test(match[1] ?? "") ? "Exact" as const : "Approx" as const;
  const donorId = normalizeAccession(match[2]);
  const parsed = match[3] === undefined ? (mode === "Exact" ? Number.POSITIVE_INFINITY : Number.NaN) : Number(match[3]);
  if (!donorId || (mode === "Approx" && (!Number.isFinite(parsed) || parsed < 0))) return undefined;
  return { mode, donorId, rawAlignmentScore: parsed };
}

function omaFastMapAspect(value: unknown): string {
  const normalized = text(value).toUpperCase();
  if (normalized === "F" || normalized === "MF" || normalized === "MOLECULAR_FUNCTION") return "molecular_function";
  if (normalized === "P" || normalized === "BP" || normalized === "BIOLOGICAL_PROCESS") return "biological_process";
  if (normalized === "C" || normalized === "CC" || normalized === "CELLULAR_COMPONENT") return "cellular_component";
  return "unknown";
}

function omaFastMapBaseScore(rawAlignmentScore: number): number {
  // OMA's value is a local PAM100 raw score, not identity, coverage, or a
  // probability. Keep the transformation deliberately weak and bounded; the
  // downstream selector must combine it with independent evidence.
  const ratio = rawAlignmentScore / (rawAlignmentScore + 150);
  return round6(0.25 + (0.35 * ratio));
}

function parseCachedOmaFastMapAggregate(payload: string): OmaFastMapAggregate {
  try {
    const parsed = JSON.parse(payload) as Partial<OmaFastMapAggregate>;
    if (!text(parsed.donorId)
      || !Number.isFinite(Number(parsed.rawAlignmentScore))
      || !Array.isArray(parsed.rows)) throw new Error("bad cache");
    return parsed as OmaFastMapAggregate;
  } catch {
    throw new RemoteProviderError("failed", "The OMA FastMap cache entry was malformed.");
  }
}

function parseOmaFastMapAggregate(input: {
  aggregate: OmaFastMapAggregate;
  release: string;
  payloadSha256: string;
}): SnakeCaseGOCandidate[] {
  const provenanceRoot = `oma-fastmap-donor:${input.aggregate.donorId}`;
  const baseScore = omaFastMapBaseScore(input.aggregate.rawAlignmentScore);
  return input.aggregate.rows.map((row): SnakeCaseGOCandidate => {
    const token = hashCanonical({
      provider: "OMA_FastMap",
      donor: input.aggregate.donorId,
      goId: row.goId,
      rawAlignmentScore: input.aggregate.rawAlignmentScore,
      payload: input.payloadSha256,
    });
    return {
      schema_version: "pi-go-candidate.v1",
      go_id: row.goId,
      term_name: row.termName,
      aspect: row.aspect,
      source_type: "oma_fastmap",
      source_id: input.aggregate.donorId,
      mapping_id: `oma-fastmap:${input.aggregate.donorId}:${row.goId}`,
      provider: "OMA",
      provider_release: input.release,
      provider_payload_sha256: input.payloadSha256,
      evidence_id: `CAND-OMA-FASTMAP-${token.slice(0, 16)}`,
      provenance_root: provenanceRoot,
      base_score: baseScore,
      query_coverage: null,
      domain_range: null,
      query_like: false,
      annotation_evidence_code: "IEA",
      donor_accession: input.aggregate.donorCanonicalId || input.aggregate.donorId,
      phylogeny: null,
    };
  }).sort((left, right) => left.go_id.localeCompare(right.go_id));
}

function omaFastMapCompletedBundle(input: {
  baseUrl: string;
  requestSha256: string;
  aggregate: OmaFastMapAggregate;
  release: string;
  payload: string;
  cacheHit: boolean;
}): SnakeCaseCandidateSourceBundle {
  const payloadSha256 = sha256Text(input.payload);
  return {
    candidate_sources: {
      providers: [{
        provider: "OMA",
        status: "completed",
        endpoint_or_path: endpoint(input.baseUrl, "function/"),
        release: input.release,
        request_sha256: input.requestSha256,
        payload_sha256: payloadSha256,
        cache_hit: input.cacheHit,
        reason: "OMA FastMap is a single-donor, local-alignment GO hypothesis source; all returned terms share one provenance root and are not orthology evidence.",
      }],
      go_candidates: parseOmaFastMapAggregate({ aggregate: input.aggregate, release: input.release, payloadSha256 }),
    },
  };
}

/**
 * High-recall arbitrary-sequence GO hypotheses from OMA FastMap.
 *
 * This is intentionally separate from runOmaRemote: FastMap transfers terms
 * from one locally similar donor and does not establish an orthology relation.
 * A near-exact query or donor is quarantined and never cached as candidate
 * evidence. Raw alignment scores are never presented as percentages.
 */
export async function runOmaFastMapRemote(
  rawInput: RemoteSequenceInput,
  config: OmaFastMapRemoteConfig,
  dependencies: RemoteProviderDependencies = {},
): Promise<SnakeCaseCandidateSourceBundle> {
  const baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_OMA_REST_URL);
  const functionUrl = endpoint(baseUrl, "function/");
  if (config.mode !== "remote") return disabledBundle("OMA", functionUrl);
  let sequence: string;
  try {
    sequence = sanitizeSequence(rawInput.sequence);
  } catch (error) {
    return failureBundle("OMA", functionUrl, null, providerError(error));
  }
  const queryLikeAccessions = new Set((config.queryLikeAccessions ?? []).map(canonicalAccession).filter(Boolean));
  const targetLineage = (rawInput.targetLineage ?? []).map((item) => item.trim()).filter(Boolean);
  const maxCandidates = Math.max(1, Math.min(250, Math.floor(config.maxCandidates ?? 120)));
  const requestSha256 = hashCanonical({
    provider: "OMA_FastMap",
    baseUrl,
    sequenceSha256: sha256Text(sequence),
    maxCandidates,
    donorSequenceGuard: {
      algorithm: "banded-lcs.v1",
      identity: OMA_QUERY_LIKE_IDENTITY,
      queryCoverage: OMA_QUERY_LIKE_QUERY_COVERAGE,
      targetCoverage: OMA_QUERY_LIKE_TARGET_COVERAGE,
      sequenceRequired: true,
      maxCells: OMA_SEQUENCE_GUARD_MAX_CELLS,
    },
    databaseScopeGuard: OMA_DATABASE_SCOPE_GUARD_VERSION,
    queryLikeBindingSha256: hashCanonical([...queryLikeAccessions].sort()),
    targetLineage,
  });
  const cacheKey = sha256Text(`OMA-FastMap:${requestSha256}`);
  const cached = await dependencies.cache?.get(cacheKey);
  if (validCacheEntry(cached, "OMA", requestSha256)) {
    try {
      const aggregate = parseCachedOmaFastMapAggregate(cached.payload);
      const scopeError = omaDatabaseScopeError(cached.release, targetLineage)
        ?? omaDatabaseScopeError(aggregate.version, targetLineage);
      if (scopeError) return failureBundle("OMA", functionUrl, requestSha256, scopeError);
      return omaFastMapCompletedBundle({ baseUrl, requestSha256, aggregate, release: cached.release, payload: cached.payload, cacheHit: true });
    } catch {
      // Refresh a corrupt-but-well-hashed entry.
    }
  }

  const fetchFn: RemoteFetch = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000);
  try {
    const version = await requestJson(fetchFn, endpoint(baseUrl, "version/"), requestTimeoutMs);
    const scopeError = omaDatabaseScopeError(version, targetLineage);
    if (scopeError) throw scopeError;

    // Preflight blocks exact/full-length target mappings before the GO
    // projection endpoint is touched. It is a leakage guard, not a transfer
    // threshold for non-query candidates.
    const search = new URL(endpoint(baseUrl, "sequence/"));
    search.searchParams.set("query", sequence);
    search.searchParams.set("search", "mixed");
    search.searchParams.set("full_length", "true");
    const identification = await requestJson(fetchFn, search.toString(), requestTimeoutMs);
    if (identifyOmaAnchor(identification, sequence, OMA_QUERY_LIKE_QUERY_COVERAGE, OMA_QUERY_LIKE_IDENTITY)) {
      throw new RemoteProviderError("unavailable", "OMA FastMap was not queried because OMA detected a near-exact full-length target mapping; target-like GO labels remain quarantined.");
    }

    const url = new URL(functionUrl);
    url.searchParams.set("query", sequence);
    const rawRows = arrayPayload(await requestJson(fetchFn, url.toString(), requestTimeoutMs));
    if (rawRows.length === 0) {
      const aggregate: OmaFastMapAggregate = { version, donorId: "NO_DONOR", donorCanonicalId: "", rawAlignmentScore: 0, rows: [] };
      const release = omaRelease(version);
      const payload = canonicalJson(aggregate);
      return omaFastMapCompletedBundle({ baseUrl, requestSha256, aggregate, release, payload, cacheHit: false });
    }

    const parsedRows = rawRows.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
    const withRecords = parsedRows.map((row) => parseOmaFastMapWith(row.With ?? row.with)).filter((item): item is NonNullable<typeof item> => item !== undefined);
    if (withRecords.length === 0) throw new RemoteProviderError("failed", "OMA FastMap returned no parseable donor provenance.");
    const donorKeys = new Set(withRecords.map((item) => `${item.mode}:${item.donorId}:${item.rawAlignmentScore}`));
    if (donorKeys.size !== 1) throw new RemoteProviderError("failed", "OMA FastMap returned inconsistent single-donor provenance.");
    const donor = withRecords[0]!;
    if (donor.mode === "Exact" || queryLikeAccessions.has(donor.donorId)) {
      throw new RemoteProviderError("unavailable", "OMA FastMap returned an exact or declared query-like donor; its GO rows were quarantined.");
    }

    const detail = await requestJson(fetchFn, endpoint(baseUrl, `protein/${encodeURIComponent(donor.donorId)}/`), requestTimeoutMs);
    const detailRecord = omaProteinRecord(detail) ?? {};
    const donorCanonicalId = canonicalAccession(detailRecord.canonicalid ?? detailRecord.canonical_id);
    const donorOmaId = normalizeAccession(detailRecord.omaid ?? detailRecord.oma_id) || donor.donorId;
    if (queryLikeAccessions.has(donorCanonicalId) || queryLikeAccessions.has(donorOmaId)) {
      throw new RemoteProviderError("unavailable", "OMA FastMap donor aliases matched a declared query-like accession; its GO rows were quarantined.");
    }
    const donorSequence = omaProteinSequence(detail);
    if (!donorSequence) throw new RemoteProviderError("unavailable", "OMA FastMap donor sequence was unavailable, so target-like leakage could not be excluded.");
    const disposition = omaSequenceDisposition(sequence, donorSequence);
    if (disposition !== "distinct") {
      throw new RemoteProviderError("unavailable", disposition === "query_like"
        ? "OMA FastMap donor was near-identical to the query; its GO rows were quarantined."
        : "OMA FastMap donor identity could not be verified within the bounded guard budget.");
    }

    const uniqueRows = [...new Map(parsedRows.flatMap((row): Array<[string, OmaFastMapRow]> => {
      const goId = text(row.GO_ID ?? row.go_id ?? row.GO_term).toUpperCase();
      const aspect = omaFastMapAspect(row.Aspect ?? row.aspect);
      if (!/^GO:\d{7}$/.test(goId) || aspect === "unknown") return [];
      return [[goId, { goId, termName: text(row.GO_name ?? row.go_name ?? row.name) || "name unavailable", aspect }]];
    })).values()].sort((left, right) => left.goId.localeCompare(right.goId)).slice(0, maxCandidates);
    const aggregate: OmaFastMapAggregate = {
      version,
      donorId: donorOmaId,
      donorCanonicalId,
      rawAlignmentScore: donor.rawAlignmentScore,
      rows: uniqueRows,
    };
    const release = omaRelease(version);
    const payload = canonicalJson(aggregate);
    await dependencies.cache?.set(cacheKey, {
      schemaVersion: "pi-remote-candidate-cache.v1",
      provider: "OMA",
      requestSha256,
      release,
      payload,
      payloadSha256: sha256Text(payload),
    });
    return omaFastMapCompletedBundle({ baseUrl, requestSha256, aggregate, release, payload, cacheHit: false });
  } catch (error) {
    return failureBundle("OMA", functionUrl, requestSha256, providerError(error));
  }
}

export function mergeRemoteCandidateBundles(bundles: readonly SnakeCaseCandidateSourceBundle[]): SnakeCaseCandidateSourceBundle {
  const providers = bundles.flatMap((bundle) => bundle.candidate_sources.providers)
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.endpoint_or_path.localeCompare(right.endpoint_or_path));
  const goCandidates = bundles.flatMap((bundle) => bundle.candidate_sources.go_candidates)
    .sort((left, right) => left.go_id.localeCompare(right.go_id)
      || left.provenance_root.localeCompare(right.provenance_root)
      || left.evidence_id.localeCompare(right.evidence_id));
  return { candidate_sources: { providers, go_candidates: goCandidates } };
}

export async function collectRemoteCandidateSources(input: {
  sequence: RemoteSequenceInput;
  interpro: InterProScanRemoteConfig;
  oma: OmaRemoteConfig;
  omaFastMap?: OmaFastMapRemoteConfig;
  dependencies?: RemoteProviderDependencies;
}): Promise<SnakeCaseCandidateSourceBundle> {
  const [interpro, oma, omaFastMap] = await Promise.all([
    runInterProScanRemote(input.sequence, input.interpro, input.dependencies),
    runOmaRemote(input.sequence, input.oma, input.dependencies),
    runOmaFastMapRemote(input.sequence, input.omaFastMap ?? { mode: "disabled" }, input.dependencies),
  ]);
  return mergeRemoteCandidateBundles([interpro, oma, omaFastMap]);
}
