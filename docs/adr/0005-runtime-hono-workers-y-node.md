# ADR 0005 · Hono sobre Workers y Node con el mismo núcleo

- Estado: aceptada
- Fecha: 2026-10-27

## Contexto

Algunos clientes aceptan correr en la nube (Cloudflare) y otros exigen on-premise o su propia VM. Mantener dos versiones duplica el trabajo de cada cliente.

## Decisión

- App en Hono, construida por `buildRuntime()` (`src/runtime.ts`) con dependencias inyectadas: store, proveedor de LLM, integraciones, sender del canal y reloj.
- Dos entradas finas: `src/node.ts` (SQLite nativo `node:sqlite`, sin dependencias nativas) y `src/worker.ts` (D1). El SQL es el mismo (`SqlStore` sobre una interfaz `SqlExec`).
- Firma de webhooks con WebCrypto, sin `node:crypto`, para que corra en ambos.
- Playbooks, KB y dashboard se empaquetan como módulos TS en build.
- El reloj es inyectable: las evals fijan la fecha y son reproducibles.

## Consecuencias

- Probado localmente con `wrangler dev` (workerd + D1 local) y con `wrangler deploy --dry-run` en CI; no se desplegó a una cuenta real.
- El webhook hoy procesa en línea y responde al terminar. Para volumen real en Workers conviene encolar (Cloudflare Queues) y responder 200 de inmediato; está documentado en el runbook.
- Las integraciones mock viven en memoria del proceso o isolate: sirven para demo, no para producción.
