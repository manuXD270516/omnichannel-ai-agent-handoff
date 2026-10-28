# ADR 0001 · El supervisor y el guardrail son código, no un LLM

- Estado: aceptada
- Fecha: 2026-10-27

## Contexto

Decidir cuándo una conversación pasa a un humano y qué no puede decir o hacer la IA son las decisiones con más riesgo del sistema: un handoff tardío genera clientes enojados; una promesa de pago fuera de política es plata perdida o un reclamo. Una opción común es un "agente supervisor" LLM que lea la conversación y decida.

## Decisión

- El **router** (intención, idioma, urgencia, sentimiento, confianza) y la **extracción de argumentos** sí usan el LLM, con salida estructurada validada por zod.
- El **supervisor** es una función pura con reglas ordenadas por prioridad (`src/core/supervisor.ts`), parametrizadas por el playbook: pedido explícito, inyección, idioma, urgencia, sentimiento negativo sostenido, baja confianza con reintento, intención deshabilitada o siempre humana, pedido fuera de política, respuesta bloqueada y N turnos sin resolver.
- El **guardrail** (redacción de PII, inyección, montos sin respaldo, compromisos no autorizados, fuga de prompt) también es determinístico.
- Las reglas de negocio (límites de promesas) se aplican **dentro del tool**, antes de tocar el ERP, no en el prompt.

Nota de la iteración con `qwen2.5:7b`: un modelo real puede clasificar "¿venden heladeras?" como `other` con confianza alta. Por eso la regla de baja confianza también cubre la intención `other` (fuera de alcance): primero pide aclaración y, si se repite, deriva.

## Consecuencias

- Auditables: el cliente lee las reglas en su playbook y en un archivo de 100 líneas; cada decisión queda en la traza con su motivo.
- Testeables con unit tests y con la suite golden; el gate de violaciones de política = 0 es alcanzable con cualquier modelo porque no depende de él.
- Costo: las reglas no capturan matices (sarcasmo, enojo implícito). Se compensa con señales del router (sentimiento, `wantsHuman`) que alimentan las reglas, y con revisión semanal de derivaciones.
