export const FLAT_EXACT_SMOKE_METRIC_ID = "flat_exact_smoke_v1" as const;
export const ASPECT_MASKED_FLAT_EXACT_SMOKE_METRIC_ID = "aspect_masked_flat_exact_smoke_v2" as const;

export type BenchmarkMetricId =
  | typeof FLAT_EXACT_SMOKE_METRIC_ID
  | typeof ASPECT_MASKED_FLAT_EXACT_SMOKE_METRIC_ID;

export const BENCHMARK_GO_ASPECTS = [
  "molecular_function",
  "biological_process",
  "cellular_component",
] as const;

export type BenchmarkGOAspect = typeof BENCHMARK_GO_ASPECTS[number];

export interface BenchmarkGoldTerm {
  goId: string;
  aspect: BenchmarkGOAspect;
}

export interface BenchmarkGoldCase {
  proteinId: string;
  terms: BenchmarkGoldTerm[];
  /** Ontologies for which this case has an evaluable target, rather than a missing/null label. */
  scoredAspects?: BenchmarkGOAspect[];
}

export interface BenchmarkPredictionTerm {
  goId: string;
  aspect: BenchmarkGOAspect;
  selected: boolean;
  phylogenyAdjustedScore: number | null;
}

export interface BenchmarkPredictionCase {
  proteinId: string;
  terms: BenchmarkPredictionTerm[];
}

export interface BenchmarkMetricCounts {
  proteinCount: number;
  goldPositiveProteinCount: number;
  coveredProteinCount: number;
  abstainedProteinCount: number;
  goldTermCount: number;
  selectedTermCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
}

export interface OperationalSetMetrics {
  precision: number;
  recall: number;
  f1: number;
  meanProteinF1: number;
  coverage: number;
  abstentionRate: number;
  counts: BenchmarkMetricCounts;
}

export interface RankingFmaxMetrics {
  /** False when the scope contains no gold-positive terms. */
  evaluable: boolean;
  fmax: number;
  threshold: number | null;
  precision: number;
  recall: number;
  evaluatedThresholdCount: number;
  positiveCandidateTermCount: number;
}

export interface BenchmarkScopeMetrics {
  operational: OperationalSetMetrics;
  ranking: RankingFmaxMetrics;
}

export interface FlatExactSmokeEvaluation {
  metricId: BenchmarkMetricId;
  /** Sorted IDs bind comparisons to the same anonymous benchmark cases. */
  proteinIds: string[];
  aspects: Record<BenchmarkGOAspect, BenchmarkScopeMetrics>;
  overall: BenchmarkScopeMetrics;
}

export interface PromotionGuardrails {
  minimumOverallFmaxGain: number;
  maximumAspectFmaxDrop: number;
  maximumOperationalF1Drop: number;
  maximumCoverageDrop: number;
}

export interface PromotionMetricDeltas {
  rankingFmax: number;
  operationalF1: number;
  coverage: number;
}

export interface PromotionComparison {
  metricId: BenchmarkMetricId;
  passed: boolean;
  reasons: string[];
  deltas: {
    overall: PromotionMetricDeltas;
    aspects: Record<BenchmarkGOAspect, PromotionMetricDeltas>;
  };
}

interface NormalizedCase {
  proteinId: string;
  goldTerms: BenchmarkGoldTerm[];
  predictionTerms: BenchmarkPredictionTerm[];
  scoredAspects: BenchmarkGOAspect[];
}

interface ConfusionCounts {
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
}

const GO_ID = /^GO:\d{7}$/;
const COMPARISON_EPSILON = 1e-12;

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1FromCounts(counts: ConfusionCounts): number {
  return safeRatio(
    2 * counts.truePositiveCount,
    2 * counts.truePositiveCount + counts.falsePositiveCount + counts.falseNegativeCount,
  );
}

function precisionFromCounts(counts: ConfusionCounts): number {
  return safeRatio(counts.truePositiveCount, counts.truePositiveCount + counts.falsePositiveCount);
}

function recallFromCounts(counts: ConfusionCounts): number {
  return safeRatio(counts.truePositiveCount, counts.truePositiveCount + counts.falseNegativeCount);
}

function assertProteinId(proteinId: string, label: string): void {
  if (typeof proteinId !== "string" || proteinId.trim() === "") throw new Error(`${label} proteinId is required`);
}

function assertTerm(term: BenchmarkGoldTerm | BenchmarkPredictionTerm, label: string): void {
  if (!GO_ID.test(term.goId)) throw new Error(`${label} has invalid GO ID: ${term.goId}`);
  if (!(BENCHMARK_GO_ASPECTS as readonly string[]).includes(term.aspect)) {
    throw new Error(`${label} has invalid GO aspect: ${String(term.aspect)}`);
  }
}

function normalizeCases(
  goldCases: readonly BenchmarkGoldCase[],
  predictionCases: readonly BenchmarkPredictionCase[],
  requireAspectMasks: boolean,
): NormalizedCase[] {
  const goldByProtein = new Map<string, {
    terms: BenchmarkGoldTerm[];
    scoredAspects: BenchmarkGOAspect[];
  }>();
  for (const goldCase of goldCases) {
    assertProteinId(goldCase.proteinId, "gold case");
    if (goldByProtein.has(goldCase.proteinId)) throw new Error(`Duplicate gold proteinId: ${goldCase.proteinId}`);
    const scoredAspects = requireAspectMasks
      ? goldCase.scoredAspects
      : [...BENCHMARK_GO_ASPECTS];
    if (!scoredAspects || scoredAspects.length === 0) {
      throw new Error(`Aspect-masked evaluation requires at least one scored aspect for ${goldCase.proteinId}`);
    }
    const scoredAspectSet = new Set<BenchmarkGOAspect>();
    for (const aspect of scoredAspects) {
      if (!(BENCHMARK_GO_ASPECTS as readonly string[]).includes(aspect)) {
        throw new Error(`Gold case ${goldCase.proteinId} has invalid scored aspect: ${String(aspect)}`);
      }
      if (scoredAspectSet.has(aspect)) {
        throw new Error(`Gold case ${goldCase.proteinId} has duplicate scored aspect: ${aspect}`);
      }
      scoredAspectSet.add(aspect);
    }
    const seen = new Set<string>();
    for (const term of goldCase.terms) {
      assertTerm(term, `gold case ${goldCase.proteinId}`);
      if (requireAspectMasks && !scoredAspectSet.has(term.aspect)) {
        throw new Error(`Gold term ${term.goId} is outside the scored aspects for ${goldCase.proteinId}`);
      }
      const key = termKey(term);
      if (seen.has(key)) throw new Error(`Duplicate gold term for ${goldCase.proteinId}: ${term.goId}`);
      seen.add(key);
    }
    goldByProtein.set(goldCase.proteinId, {
      terms: [...goldCase.terms],
      scoredAspects: [...scoredAspectSet],
    });
  }

  const predictionsByProtein = new Map<string, BenchmarkPredictionTerm[]>();
  for (const predictionCase of predictionCases) {
    assertProteinId(predictionCase.proteinId, "prediction case");
    if (!goldByProtein.has(predictionCase.proteinId)) {
      throw new Error(`Prediction proteinId is absent from gold cases: ${predictionCase.proteinId}`);
    }
    if (predictionsByProtein.has(predictionCase.proteinId)) {
      throw new Error(`Duplicate prediction proteinId: ${predictionCase.proteinId}`);
    }
    const seen = new Set<string>();
    for (const term of predictionCase.terms) {
      assertTerm(term, `prediction case ${predictionCase.proteinId}`);
      if (typeof term.selected !== "boolean") throw new Error(`Prediction selected flag must be boolean: ${term.goId}`);
      if (term.phylogenyAdjustedScore !== null
        && (!Number.isFinite(term.phylogenyAdjustedScore)
          || term.phylogenyAdjustedScore < 0
          || term.phylogenyAdjustedScore > 1)) {
        throw new Error(`Prediction score must be null or within [0,1]: ${term.goId}`);
      }
      const key = termKey(term);
      if (seen.has(key)) throw new Error(`Duplicate prediction term for ${predictionCase.proteinId}: ${term.goId}`);
      seen.add(key);
    }
    predictionsByProtein.set(predictionCase.proteinId, [...predictionCase.terms]);
  }

  return [...goldByProtein.keys()].sort().map((proteinId) => ({
    proteinId,
    goldTerms: goldByProtein.get(proteinId)?.terms ?? [],
    predictionTerms: predictionsByProtein.get(proteinId) ?? [],
    scoredAspects: goldByProtein.get(proteinId)?.scoredAspects ?? [],
  }));
}

function termKey(term: Pick<BenchmarkGoldTerm, "goId" | "aspect">): string {
  return `${term.aspect}\u0000${term.goId}`;
}

function termsForAspect<T extends BenchmarkGoldTerm>(terms: readonly T[], aspect?: BenchmarkGOAspect): T[] {
  return aspect === undefined ? [...terms] : terms.filter((term) => term.aspect === aspect);
}

function confusion(gold: ReadonlySet<string>, predicted: ReadonlySet<string>): ConfusionCounts {
  let truePositiveCount = 0;
  for (const key of predicted) if (gold.has(key)) truePositiveCount += 1;
  return {
    truePositiveCount,
    falsePositiveCount: predicted.size - truePositiveCount,
    falseNegativeCount: gold.size - truePositiveCount,
  };
}

function selectedKeys(
  terms: readonly BenchmarkPredictionTerm[],
  aspect: BenchmarkGOAspect | undefined,
  threshold?: number,
): Set<string> {
  return new Set(termsForAspect(terms, aspect)
    .filter((term) => threshold === undefined
      ? term.selected
      : term.phylogenyAdjustedScore !== null && term.phylogenyAdjustedScore > 0
        && term.phylogenyAdjustedScore >= threshold)
    .map(termKey));
}

function goldKeys(terms: readonly BenchmarkGoldTerm[], aspect?: BenchmarkGOAspect): Set<string> {
  return new Set(termsForAspect(terms, aspect).map(termKey));
}

function operationalMetrics(
  cases: readonly NormalizedCase[],
  aspect: BenchmarkGOAspect | undefined,
  threshold?: number,
): OperationalSetMetrics {
  let truePositiveCount = 0;
  let falsePositiveCount = 0;
  let falseNegativeCount = 0;
  let goldTermCount = 0;
  let selectedTermCount = 0;
  let goldPositiveProteinCount = 0;
  let coveredProteinCount = 0;
  let proteinF1Sum = 0;

  for (const benchmarkCase of cases) {
    const gold = goldKeys(benchmarkCase.goldTerms, aspect);
    const selected = selectedKeys(benchmarkCase.predictionTerms, aspect, threshold);
    const counts = confusion(gold, selected);
    truePositiveCount += counts.truePositiveCount;
    falsePositiveCount += counts.falsePositiveCount;
    falseNegativeCount += counts.falseNegativeCount;
    goldTermCount += gold.size;
    selectedTermCount += selected.size;
    if (gold.size > 0) goldPositiveProteinCount += 1;
    if (selected.size > 0) coveredProteinCount += 1;
    // The zero-denominator convention is zero, including empty-vs-empty cases.
    // This avoids inflating a sparse benchmark merely because neither side has a term.
    proteinF1Sum += f1FromCounts(counts);
  }

  const counts: BenchmarkMetricCounts = {
    proteinCount: cases.length,
    goldPositiveProteinCount,
    coveredProteinCount,
    abstainedProteinCount: cases.length - coveredProteinCount,
    goldTermCount,
    selectedTermCount,
    truePositiveCount,
    falsePositiveCount,
    falseNegativeCount,
  };
  const aggregate = { truePositiveCount, falsePositiveCount, falseNegativeCount };
  return {
    precision: precisionFromCounts(aggregate),
    recall: recallFromCounts(aggregate),
    f1: f1FromCounts(aggregate),
    meanProteinF1: safeRatio(proteinF1Sum, cases.length),
    coverage: safeRatio(coveredProteinCount, cases.length),
    abstentionRate: safeRatio(cases.length - coveredProteinCount, cases.length),
    counts,
  };
}

function rankingFmax(cases: readonly NormalizedCase[], aspect?: BenchmarkGOAspect): RankingFmaxMetrics {
  const positiveScores = cases.flatMap((benchmarkCase) => termsForAspect(benchmarkCase.predictionTerms, aspect)
    .flatMap((term) => term.phylogenyAdjustedScore !== null && term.phylogenyAdjustedScore > 0
      ? [term.phylogenyAdjustedScore]
      : []));
  const thresholds = [...new Set(positiveScores)].sort((left, right) => right - left);
  const goldTermCount = cases.reduce(
    (sum, benchmarkCase) => sum + termsForAspect(benchmarkCase.goldTerms, aspect).length,
    0,
  );
  if (goldTermCount === 0) {
    return {
      evaluable: false,
      fmax: 0,
      threshold: null,
      precision: 0,
      recall: 0,
      evaluatedThresholdCount: 0,
      positiveCandidateTermCount: positiveScores.length,
    };
  }

  let bestF1 = 0;
  let bestThreshold: number | null = null;
  let bestPrecision = 0;
  let bestRecall = 0;
  for (const threshold of thresholds) {
    const metrics = operationalMetrics(cases, aspect, threshold);
    // Thresholds are descending, so a tie intentionally retains the higher,
    // more conservative threshold.
    if (bestThreshold === null || metrics.f1 > bestF1) {
      bestF1 = metrics.f1;
      bestThreshold = threshold;
      bestPrecision = metrics.precision;
      bestRecall = metrics.recall;
    }
  }
  return {
    evaluable: true,
    fmax: bestF1,
    threshold: bestThreshold,
    precision: bestPrecision,
    recall: bestRecall,
    evaluatedThresholdCount: thresholds.length,
    positiveCandidateTermCount: positiveScores.length,
  };
}

function scopeMetrics(cases: readonly NormalizedCase[], aspect?: BenchmarkGOAspect): BenchmarkScopeMetrics {
  return {
    operational: operationalMetrics(cases, aspect),
    ranking: rankingFmax(cases, aspect),
  };
}

function aspectMaskedScopeCases(
  cases: readonly NormalizedCase[],
  aspect?: BenchmarkGOAspect,
): NormalizedCase[] {
  if (aspect !== undefined) {
    return cases.filter((benchmarkCase) => benchmarkCase.scoredAspects.includes(aspect));
  }
  return cases.map((benchmarkCase) => {
    const scored = new Set(benchmarkCase.scoredAspects);
    return {
      ...benchmarkCase,
      goldTerms: benchmarkCase.goldTerms.filter((term) => scored.has(term.aspect)),
      predictionTerms: benchmarkCase.predictionTerms.filter((term) => scored.has(term.aspect)),
    };
  });
}

/**
 * Evaluate exact GO IDs without GO-DAG propagation, obsolete-ID remapping, or
 * information-content weighting. This smoke metric must not be reported as a
 * CAFA hierarchical metric.
 */
export function evaluateFlatExactSmoke(
  goldCases: readonly BenchmarkGoldCase[],
  predictionCases: readonly BenchmarkPredictionCase[],
): FlatExactSmokeEvaluation {
  const cases = normalizeCases(goldCases, predictionCases, false);
  return {
    metricId: FLAT_EXACT_SMOKE_METRIC_ID,
    proteinIds: cases.map((item) => item.proteinId),
    aspects: {
      molecular_function: scopeMetrics(cases, "molecular_function"),
      biological_process: scopeMetrics(cases, "biological_process"),
      cellular_component: scopeMetrics(cases, "cellular_component"),
    },
    overall: scopeMetrics(cases),
  };
}

/**
 * Evaluate exact GO IDs only in ontologies explicitly marked as scored for
 * each protein. Predictions in a missing/null target ontology are ignored,
 * rather than treated as false positives. This remains a flat smoke metric,
 * not a GO-DAG/CAFA metric.
 */
export function evaluateAspectMaskedFlatExactSmoke(
  goldCases: readonly BenchmarkGoldCase[],
  predictionCases: readonly BenchmarkPredictionCase[],
): FlatExactSmokeEvaluation {
  const cases = normalizeCases(goldCases, predictionCases, true);
  return {
    metricId: ASPECT_MASKED_FLAT_EXACT_SMOKE_METRIC_ID,
    proteinIds: cases.map((item) => item.proteinId),
    aspects: {
      molecular_function: scopeMetrics(
        aspectMaskedScopeCases(cases, "molecular_function"),
        "molecular_function",
      ),
      biological_process: scopeMetrics(
        aspectMaskedScopeCases(cases, "biological_process"),
        "biological_process",
      ),
      cellular_component: scopeMetrics(
        aspectMaskedScopeCases(cases, "cellular_component"),
        "cellular_component",
      ),
    },
    overall: scopeMetrics(aspectMaskedScopeCases(cases)),
  };
}

function assertGuardrail(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function assertComparable(
  champion: FlatExactSmokeEvaluation,
  candidate: FlatExactSmokeEvaluation,
): void {
  const supported = new Set<BenchmarkMetricId>([
    FLAT_EXACT_SMOKE_METRIC_ID,
    ASPECT_MASKED_FLAT_EXACT_SMOKE_METRIC_ID,
  ]);
  if (!supported.has(champion.metricId) || !supported.has(candidate.metricId)) {
    throw new Error("Promotion comparison received an unsupported metric ID");
  }
  if (champion.metricId !== candidate.metricId) {
    throw new Error("Promotion comparison requires identical metric IDs");
  }
  if (champion.proteinIds.length !== candidate.proteinIds.length
    || champion.proteinIds.some((proteinId, index) => candidate.proteinIds[index] !== proteinId)) {
    throw new Error("Promotion comparison requires identical benchmark protein IDs");
  }
  for (const aspect of BENCHMARK_GO_ASPECTS) {
    const championCounts = champion.aspects[aspect].operational.counts;
    const candidateCounts = candidate.aspects[aspect].operational.counts;
    if (championCounts.proteinCount !== candidateCounts.proteinCount
      || championCounts.goldTermCount !== candidateCounts.goldTermCount
      || championCounts.goldPositiveProteinCount !== candidateCounts.goldPositiveProteinCount) {
      throw new Error(`Promotion comparison requires identical ${aspect} gold cases`);
    }
  }
}

function metricDeltas(
  champion: BenchmarkScopeMetrics,
  candidate: BenchmarkScopeMetrics,
): PromotionMetricDeltas {
  return {
    rankingFmax: candidate.ranking.fmax - champion.ranking.fmax,
    operationalF1: candidate.operational.f1 - champion.operational.f1,
    coverage: candidate.operational.coverage - champion.operational.coverage,
  };
}

function formatted(value: number): string {
  return value.toFixed(6);
}

/** Compare one preselected candidate with its champion under frozen guardrails. */
export function compareFlatExactSmokeForPromotion(
  champion: FlatExactSmokeEvaluation,
  candidate: FlatExactSmokeEvaluation,
  guardrails: PromotionGuardrails,
): PromotionComparison {
  assertComparable(champion, candidate);
  assertGuardrail(guardrails.minimumOverallFmaxGain, "minimumOverallFmaxGain");
  assertGuardrail(guardrails.maximumAspectFmaxDrop, "maximumAspectFmaxDrop");
  assertGuardrail(guardrails.maximumOperationalF1Drop, "maximumOperationalF1Drop");
  assertGuardrail(guardrails.maximumCoverageDrop, "maximumCoverageDrop");

  const overall = metricDeltas(champion.overall, candidate.overall);
  const aspects = Object.fromEntries(BENCHMARK_GO_ASPECTS.map((aspect) => [
    aspect,
    metricDeltas(champion.aspects[aspect], candidate.aspects[aspect]),
  ])) as Record<BenchmarkGOAspect, PromotionMetricDeltas>;
  const reasons: string[] = [];

  if (!candidate.overall.ranking.evaluable) {
    reasons.push("overall ranking Fmax is not evaluable because the benchmark has no gold terms");
  } else if (overall.rankingFmax + COMPARISON_EPSILON < guardrails.minimumOverallFmaxGain) {
    reasons.push(`overall ranking Fmax gain ${formatted(overall.rankingFmax)} is below required ${formatted(guardrails.minimumOverallFmaxGain)}`);
  }
  if (overall.operationalF1 + guardrails.maximumOperationalF1Drop < -COMPARISON_EPSILON) {
    reasons.push(`overall operational F1 dropped ${formatted(-overall.operationalF1)} beyond allowed ${formatted(guardrails.maximumOperationalF1Drop)}`);
  }
  if (overall.coverage + guardrails.maximumCoverageDrop < -COMPARISON_EPSILON) {
    reasons.push(`overall coverage dropped ${formatted(-overall.coverage)} beyond allowed ${formatted(guardrails.maximumCoverageDrop)}`);
  }

  for (const aspect of BENCHMARK_GO_ASPECTS) {
    if (champion.aspects[aspect].operational.counts.goldTermCount === 0) continue;
    const delta = aspects[aspect];
    if (delta.rankingFmax + guardrails.maximumAspectFmaxDrop < -COMPARISON_EPSILON) {
      reasons.push(`${aspect} ranking Fmax dropped ${formatted(-delta.rankingFmax)} beyond allowed ${formatted(guardrails.maximumAspectFmaxDrop)}`);
    }
    if (delta.operationalF1 + guardrails.maximumOperationalF1Drop < -COMPARISON_EPSILON) {
      reasons.push(`${aspect} operational F1 dropped ${formatted(-delta.operationalF1)} beyond allowed ${formatted(guardrails.maximumOperationalF1Drop)}`);
    }
  }

  return {
    metricId: champion.metricId,
    passed: reasons.length === 0,
    reasons,
    deltas: { overall, aspects },
  };
}
