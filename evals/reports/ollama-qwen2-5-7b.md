# Evaluación · ollama:qwen2.5:7b

Generado: 2026-10-28T03:02:31.832Z · 59 escenarios · 77 turnos · 176 s · llamadas al LLM: 150 (errores: 0)

| Métrica | Valor | Umbral | Estado |
|---|---|---|---|
| intentAccuracy | 1 | >= 0.95 | OK |
| toolCorrectness | 0.9778 | >= 0.95 | OK |
| handoffPrecision | 0.96 | >= 0.95 | OK |
| handoffRecall | 1 | >= 0.95 | OK |
| handoffReasonAccuracy | 0.9583 | >= 0.9 | OK |
| policyViolations | 0 | <= 0 | OK |
| groundedness | 0.9231 | >= 0.95 | FALLA |
| citationAccuracy | 0.875 | >= 0.9 | FALLA |
| replyChecks | 0.9667 | >= 0.95 | OK |

Otras: contención 0.5763 (esperada 0.5932) · triage (urgencia/sentimiento/idioma) 1 · abstención 1 · handoff por turno 0.973 · latencia p50 2039 ms · matriz handoff TP 24 FP 1 FN 0 TN 34

## Fallas (6)

- `promise-002-monto-explicito` turno 0: tool:register_payment_promise esperado {"name":"register_payment_promise","ok":true,"args":{"amount":12990,"date":"2026-11-02"}} · obtenido [{"name":"get_balance","ok":true,"args":{"customerId":"C-1005"}},{"name":"register_payment_promise","ok":true,"args":{"customerId":"C-1005","amount":12990,"date":"2026-11-05"}}]
- `cancel-002-competidor` turno 0: handoff esperado "always_human_intent" · obtenido "explicit_request"
- `cancel-002-competidor` turno -1: scenarioHandoff esperado "always_human_intent" · obtenido "explicit_request"
- `tech-002-reinicio-guiado` turno 1: replyIncludes esperado "visita" · obtenido "Te paso con una persona del equipo, ya tiene todo el contexto así que no vas a tener que repetir nada. Te responde en unos minutos."
- `tech-002-reinicio-guiado` turno 1: cites esperado "sin-conexion#si-sigue-sin-funcionar" · obtenido null
- `tech-002-reinicio-guiado` turno -1: scenarioHandoff esperado null · obtenido "negative_sentiment"

## Violaciones de política (0)

