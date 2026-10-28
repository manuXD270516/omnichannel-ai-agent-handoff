# Runbook de implementación: de discovery a go-live y monitoreo

Pensado para un FDE que implementa este núcleo en un cliente nuevo. Cada fase tiene una salida verificable; no se pasa a la siguiente sin ella.

## Fase 0 · Discovery (semana 1)

- Completar `docs/discovery-template.md` con operaciones y TI.
- **Salida:** borrador de playbook, matriz de integraciones, muestra anonimizada de conversaciones.

## Fase 1 · Playbook y suite golden (semana 1-2)

1. Copiar un playbook existente: `cp playbooks/fibrasur.yaml playbooks/<cliente>.yaml`.
2. Ajustar intenciones habilitadas, reglas de facturación, umbrales de handoff, horarios, tono y canales.
3. Cargar la KB del cliente en `kb/<colección>/*.md` (un `##` por pasaje citable).
4. `pnpm bundle` valida el playbook contra el schema: si falla, el error dice qué campo.
5. Convertir la muestra real en escenarios golden (`evals/golden/<cliente>.json`), incluyendo **handoffs que deben ocurrir y que no deben ocurrir**, PII, inyección y pedidos fuera de política.
- **Salida:** `pnpm eval` corre la suite nueva (aunque todavía falle).

## Fase 2 · Integraciones (semana 2-3)

1. Implementar los adaptadores reales detrás de `CrmAdapter`, `ErpAdapter` y `CalendarAdapter` (`src/integrations/types.ts`). Ejemplo: `src/integrations/hubspot.ts`.
2. Tests de contrato contra el sandbox del cliente: mismas aserciones que los mocks.
3. Escrituras idempotentes (clave de idempotencia por conversación + turno) y timeouts explícitos.
4. Elegir el adaptador en el playbook (`integrations.crm.adapter`) y cargar credenciales como secretos.
- **Salida:** la suite golden corre contra el sandbox con los mismos gates.

## Fase 3 · Modelo y calidad (semana 3)

1. Correr la suite con el proveedor elegido: `pnpm eval -- --provider ollama --model <modelo>` o el proveedor que apruebe el cliente.
2. Analizar fallas por categoría (`evals/reports/<proveedor>.md`): intención, argumentos, handoff, groundedness.
3. Iterar prompts, umbrales del playbook o reglas deterministas. Cada cambio se valida con la suite completa (sin regresiones).
- **Salida:** gates superados, en particular **violaciones de política = 0**.

## Fase 4 · Canales

### WhatsApp Cloud API
1. En Meta for Developers: app con producto WhatsApp, número de producción del cliente, `phone_number_id` en el playbook.
2. Secretos: `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` (token de sistema, no temporal).
3. Configurar el webhook `https://<host>/webhooks/whatsapp` con el verify token y suscribir el campo `messages`.
4. `WHATSAPP_MODE=live`. Probar con un número de test antes de abrir tráfico.
5. Plantillas aprobadas para mensajes fuera de la ventana de 24 h (encuesta CSAT, callback fuera de horario).

### Voz
1. El proveedor de telefonía/ASR envía cada enunciado a `POST /channels/voice/<tenant>`.
2. La respuesta trae `say` (para TTS) y `action: transfer` con `transferTo` cuando el supervisor deriva.

## Fase 5 · Despliegue

### Cloudflare Workers (recomendado)
```bash
pnpm exec wrangler login                 # cuenta del cliente o la nuestra
pnpm exec wrangler d1 create oah-db      # copiar el database_id a wrangler.toml
pnpm exec wrangler secret put WHATSAPP_APP_SECRET
pnpm exec wrangler secret put WHATSAPP_VERIFY_TOKEN
pnpm exec wrangler secret put WHATSAPP_ACCESS_TOKEN
pnpm exec wrangler secret put DASHBOARD_TOKEN
pnpm worker:deploy
```
- Proteger `/dashboard` y `/api/*` con Cloudflare Access (SSO del cliente) además del token.
- Para volumen alto: mover el procesamiento del webhook a Cloudflare Queues y responder 200 de inmediato (Meta reintenta si tarda).

### Node (on-premise o VM del cliente)
```bash
pnpm install --frozen-lockfile
LLM_PROVIDER=... DB_PATH=/var/lib/oah/app.db pnpm start
```

## Fase 6 · Go-live controlado

1. **Shadow mode** (1 semana): la IA procesa pero un humano responde; se compara intención y decisión de handoff.
2. **Piloto** con un porcentaje del tráfico o una sola intención (ej. consulta de deuda).
3. Criterios de rollback acordados: violaciones de política > 0, contención por debajo de la línea base, CSAT en caída. Rollback = quitar intenciones de `intents.enabled` en el playbook (esas consultas pasan a la cola humana por `intent_disabled`) o volver al despliegue anterior.

## Fase 7 · Monitoreo e iteración

- `GET /metrics` (Prometheus): contención, handoffs por motivo, cola pendiente, latencia p50/p95, flags del guardrail.
- `GET /api/conversations/:id/traces`: traza por turno (router, especialista, tools, guardrail, supervisor).
- Revisión semanal: 20 conversaciones derivadas y 20 contenidas al azar. Cada error real se agrega como escenario golden **antes** de corregirlo.
- Alertas: cola pendiente fuera de SLA, tasa de `policy_violation` > 0, errores de salida del LLM, latencia p95.

## Productización

Cuando algo se repite en dos clientes (una regla, un adaptador, una métrica), se mueve al núcleo o al schema del playbook. Lo específico de un cliente vive solo en su playbook, su KB, sus adaptadores y su suite golden.
