import type { Conversation } from "./types";

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

/** Métricas operativas a partir de las conversaciones (lo que mira el FDE después del go-live). */
export function computeMetrics(convs: Conversation[]) {
  const turns = convs.flatMap((c) => c.turns);
  const latencies = turns.map((t) => t.latencyMs);
  const handedOff = convs.filter((c) => c.handoff || c.handoffHistory.length > 0);
  const byReason: Record<string, number> = {};
  for (const c of handedOff) {
    const r = (c.handoff ?? c.handoffHistory[0])!.reason;
    byReason[r] = (byReason[r] ?? 0) + 1;
  }
  const byIntent: Record<string, number> = {};
  for (const t of turns) byIntent[t.triage.intent] = (byIntent[t.triage.intent] ?? 0) + 1;
  const byStatus: Record<string, number> = {};
  for (const c of convs) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  const claimWaits = convs
    .map((c) => c.handoff ?? c.handoffHistory[0])
    .filter((h): h is NonNullable<typeof h> => !!h?.claimedAt)
    .map((h) => new Date(h.claimedAt!).getTime() - new Date(h.at).getTime());
  const flags: Record<string, number> = {};
  for (const t of turns) for (const f of t.guardrailFlags) flags[f] = (flags[f] ?? 0) + 1;
  const ragTurns = turns.filter((t) => t.rag);
  return {
    conversations: convs.length,
    turns: turns.length,
    containmentRate: convs.length ? Number(((convs.length - handedOff.length) / convs.length).toFixed(3)) : 0,
    handoffs: handedOff.length,
    handoffsByReason: byReason,
    turnsByIntent: byIntent,
    conversationsByStatus: byStatus,
    queuePending: byStatus.pending_human ?? 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    timeToClaimMs: { p50: percentile(claimWaits, 50), p95: percentile(claimWaits, 95) },
    guardrailFlags: flags,
    rag: {
      answers: ragTurns.filter((t) => !t.rag!.abstained).length,
      abstentions: ragTurns.filter((t) => t.rag!.abstained).length,
      blockedUngrounded: ragTurns.filter((t) => t.rag!.abstained && !t.rag!.grounded).length,
    },
  };
}

/** Exposición en formato Prometheus para scrapear o mandar a Grafana/Datadog. */
export function toPrometheus(m: ReturnType<typeof computeMetrics>): string {
  const lines = [
    "# TYPE oah_conversations_total gauge",
    `oah_conversations_total ${m.conversations}`,
    "# TYPE oah_turns_total gauge",
    `oah_turns_total ${m.turns}`,
    "# TYPE oah_containment_rate gauge",
    `oah_containment_rate ${m.containmentRate}`,
    "# TYPE oah_queue_pending gauge",
    `oah_queue_pending ${m.queuePending}`,
    "# TYPE oah_turn_latency_ms gauge",
    `oah_turn_latency_ms{quantile="0.5"} ${m.latencyMs.p50}`,
    `oah_turn_latency_ms{quantile="0.95"} ${m.latencyMs.p95}`,
    "# TYPE oah_handoffs_total gauge",
    ...Object.entries(m.handoffsByReason).map(([r, n]) => `oah_handoffs_total{reason="${r}"} ${n}`),
    "# TYPE oah_guardrail_flags_total gauge",
    ...Object.entries(m.guardrailFlags).map(([f, n]) => `oah_guardrail_flags_total{flag="${f}"} ${n}`),
  ];
  return `${lines.join("\n")}\n`;
}
