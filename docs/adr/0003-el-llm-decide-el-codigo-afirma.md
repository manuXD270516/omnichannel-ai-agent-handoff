# ADR 0003 · El LLM decide y extrae; el código afirma hechos

- Estado: aceptada
- Fecha: 2026-10-27

## Contexto

Los errores más caros de un agente de atención no son de tono sino de hechos: un saldo mal dicho, una fecha de promesa inventada, un turno que no existe. Además, para clientes en LATAM es razonable usar modelos chicos o locales por costo y privacidad, y esos modelos fallan más en aritmética y en datos.

## Decisión

- El LLM elige el tool y extrae argumentos en un JSON validado con zod (con un reintento devolviendo el error al modelo).
- El `customerId` nunca lo elige el modelo: sale de la identidad del canal (CRM por teléfono).
- **Grounding de argumentos:** si el cliente no mencionó una fecha o un monto, el valor que propone el modelo se descarta (`mentionsDate` / `mentionsAmount`) y se pregunta. Esto salió de la corrida con `qwen2.5:7b`, que completaba fechas que nadie dijo.
- Al router se le pasa el **estado de la conversación** (turnos ofrecidos, visita ofrecida, intención anterior) para que interprete respuestas cortas como "el 2" o "sí" sin adivinar.
- Al modelo se le da un **calendario resuelto** de los próximos días en vez de pedirle aritmética de fechas.
- Las respuestas transaccionales (saldos, promesas, turnos) se arman con plantillas a partir del resultado del tool, en el trato del playbook. El LLM redacta solo respuestas de la KB (con citas) y el resumen para el humano.
- El guardrail de salida bloquea cualquier monto que no esté en los hechos del turno.

## Consecuencias

- Las respuestas transaccionales son menos "conversacionales", pero nunca dicen un número que el ERP no devolvió.
- Cambiar de modelo (local, OpenAI, Anthropic) no cambia la corrección de los hechos, solo la calidad de clasificación y extracción, que mide la suite golden.
