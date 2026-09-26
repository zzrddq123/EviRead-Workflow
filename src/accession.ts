const PROVIDER_PREFIXES = new Set(["SP", "TR", "REF", "GB", "EMB", "DBJ", "PIR", "PRF"]);

export function canonicalAccession(input: unknown): string {
  const raw = String(input ?? "").trim().toUpperCase();
  const parts = raw.split("|");
  const value = parts.length >= 2 && PROVIDER_PREFIXES.has(parts[0]) ? parts[1] : raw;
  return value.split(".", 1)[0];
}

export function canonicalAccessions(values: readonly unknown[]): string[] {
  return [...new Set(values.map(canonicalAccession).filter(Boolean))].sort();
}
