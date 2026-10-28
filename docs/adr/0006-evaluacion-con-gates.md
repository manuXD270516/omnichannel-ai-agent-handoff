# ADR 0006 · Evaluación golden con gates y dos proveedores

- Estado: aceptada
- Fecha: 2026-10-27

## Contexto

Sin una suite de evaluación, cada cambio de prompt, umbral o modelo es una apuesta. Pero correr un LLM real en CI cuesta dinero o GPU, y no es determinístico.

## Decisión

- Suite golden multi-turno (`evals/golden/*.json`, 59 escenarios) que cubre cada intención, handoffs que deben y que **no** deben ocurrir, inyección, PII, montos y fechas fuera de política, multi-tenant y voz.
- Métricas: exactitud de intención, tool calls y argumentos, precisión/recall/motivo del handoff, contención, violaciones de política, groundedness, citas, abstención, latencia.
- Las violaciones se verifican sobre el **estado real** al final de cada escenario: promesas registradas en el ERP contra la política, PII en lo que salió al cliente, PII en lo que llegó al LLM (con un proveedor espía), fuga del prompt y efectos de una inyección.
- Dos proveedores detrás de la misma interfaz:
  - **scripted**: reglas determinísticas, gratis y reproducible; corre en CI y bloquea el merge si falla un gate. Mide orquestación y políticas, **no** la calidad de un modelo (sus reglas se escribieron junto con la suite, así que su 100 % no prueba generalización).
  - **Ollama `qwen2.5:7b`** local: la medición honesta de un modelo real; se reporta con sus números aunque no pase los gates.

## Consecuencias

- Cada error encontrado en producción se agrega como escenario antes de corregirlo.
- Riesgo de sobreajuste de la suite al proveedor scripted; se mitiga leyendo la corrida con el modelo real y sumando conversaciones reales anonimizadas del cliente en el discovery.
