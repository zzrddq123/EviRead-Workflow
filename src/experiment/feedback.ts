import { hashCanonical } from "../hash.js";
import type { FeedbackPolicy } from "./contracts.js";

export interface DeveloperFeedbackView extends Record<string, unknown> {
  schemaVersion: "pi-rsi-developer-feedback-view.v1";
  evaluationId: string;
  policy: FeedbackPolicy;
  primary: Record<string, unknown>;
  aggregateMetrics: unknown[];
  decision: "continue" | "stop";
  budgetRemaining: Record<string, unknown>;
  structuredDiagnostic?: Record<string, unknown>;
  privateEvaluationHash: string;
  canonicalHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GO_ID = /GO:\d{7}/i;
const ACCESSION = /(?:^|[^A-Z0-9])(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?(?=$|[^A-Z0-9])/;
const CASE_ID = /(?:^|[^A-Z0-9])(?:CASE|TARGET|PROTEIN)(?:[_-][A-Z0-9]+)+(?=$|[^A-Z0-9])/i;
const FORBIDDEN_KEY = /(?:^|_)(?:gold|answer|accession|protein|target|sequence|structure|private|per_?target|go_?id)(?:$|_)/i;
const FORBIDDEN_PATH = /(?:^|[\/._-])(?:private|evaluator[_-]?private|gold)(?:$|[\/._-])/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function assertDeveloperSafe(value: unknown, label = "developer feedback"): void {
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) { current.forEach((entry, index) => visit(entry, `${path}[${index}]`)); return; }
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        if (FORBIDDEN_KEY.test(key)) throw new Error(`${label} contains forbidden key at ${path}.${key}`);
        visit(entry, `${path}.${key}`);
      }
      return;
    }
    if (typeof current === "string" && (GO_ID.test(current) || ACCESSION.test(current) || CASE_ID.test(current) || FORBIDDEN_PATH.test(current))) throw new Error(`${label} contains identifier/private-like text at ${path}`);
  };
  visit(value, label);
}

export function renderDeveloperFeedback(privateEvaluation: unknown, policy: FeedbackPolicy): DeveloperFeedbackView {
  const item = object(privateEvaluation, "private evaluation");
  const { canonicalHash, ...body } = item;
  if (item.schemaVersion !== "pi-rsi-private-evaluation.v1" || typeof canonicalHash !== "string" || !HASH.test(canonicalHash) || canonicalHash !== hashCanonical(body)) throw new Error("private evaluation identity/hash mismatch");
  if (typeof item.evaluationId !== "string" || !ID.test(item.evaluationId)) throw new Error("private evaluationId is invalid");
  const primary = object(item.primary, "private evaluation.primary");
  if (!Array.isArray(item.aggregateMetrics)) throw new Error("private evaluation aggregateMetrics must be an array");
  if (item.decision !== "continue" && item.decision !== "stop") throw new Error("private evaluation decision is invalid");
  const budgetRemaining = object(item.budgetRemaining, "private evaluation.budgetRemaining");
  const diagnostic = item.structuredDiagnostic === undefined ? undefined : object(item.structuredDiagnostic, "private evaluation.structuredDiagnostic");
  if (policy === "structured_diagnostic" && !diagnostic) throw new Error("structured_diagnostic policy requires a structuredDiagnostic object");
  const content = {
    schemaVersion: "pi-rsi-developer-feedback-view.v1" as const,
    evaluationId: item.evaluationId,
    policy,
    primary: structuredClone(primary),
    aggregateMetrics: structuredClone(item.aggregateMetrics),
    decision: item.decision as "continue" | "stop",
    budgetRemaining: structuredClone(budgetRemaining),
    ...(policy === "structured_diagnostic" ? { structuredDiagnostic: structuredClone(diagnostic!) } : {}),
    privateEvaluationHash: canonicalHash,
  };
  assertDeveloperSafe(content);
  return { ...content, canonicalHash: hashCanonical(content) };
}

export function assertDeveloperFeedbackView(value: unknown): DeveloperFeedbackView {
  const item = object(value, "developer feedback view");
  const { canonicalHash, ...body } = item;
  if (item.schemaVersion !== "pi-rsi-developer-feedback-view.v1" || typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(body) || !["metric_only", "structured_diagnostic"].includes(String(item.policy)) || typeof item.privateEvaluationHash !== "string" || !HASH.test(item.privateEvaluationHash)) throw new Error("developer feedback view identity/hash mismatch");
  assertDeveloperSafe(body);
  return item as DeveloperFeedbackView;
}
