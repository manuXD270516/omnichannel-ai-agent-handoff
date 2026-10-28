# ADR 0004 · RAG léxico (BM25) con citas y abstención

- Estado: aceptada
- Fecha: 2026-10-27

## Contexto

El agente técnico responde sobre procedimientos (luces del módem, reinicio, clave del wifi). Las KB de soporte de un ISP son chicas (decenas a cientos de pasajes) y muy literales. Una respuesta inventada ("cambiá el DNS a…") es peor que no responder.

## Decisión

- Recuperación BM25 con stemming liviano en español, sobre pasajes `##` de markdown. Corre igual en Node, Workers y CI, sin GPU ni servicio externo.
- Tres compuertas antes de responder: score mínimo de recuperación (`kb.minScore` en el playbook), citas que existan entre los pasajes recuperados y soporte léxico de la respuesta en los pasajes citados (≥ 0,5). Si alguna falla, el agente se abstiene y ofrece un humano; la abstención cuenta como turno sin resolver para la regla de N turnos.
- La respuesta incluye la fuente citada.
- **Decodificación restringida de citas:** el schema de salida se arma por llamada con `citations: enum(ids recuperados)` y `maxItems: 3`. En la primera corrida con `qwen2.5:7b` el array libre hacía que el modelo repitiera ids inventados hasta agotar tokens (timeouts de 120 s y "token repeat limit"); con el enum el problema desapareció. Además se acota `num_predict` y, si el LLM falla igual, el agente se abstiene en vez de responder con un error.

## Consecuencias

- Groundedness medible y explicable; la métrica separa "respuestas del modelo con respaldo" de "abstenciones correctas".
- Límite conocido: sinónimos que no comparten raíz léxica ("router" vs "módem") pueden quedar sin recuperar. Cuando la KB de un cliente crezca o tenga mucho vocabulario variable, se reemplaza `KbIndex` por embeddings (Cloudflare Vectorize, pgvector o `mxbai-embed-large` local) detrás de la misma interfaz `search()`.
