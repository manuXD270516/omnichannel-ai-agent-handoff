# ADR 0002 · Playbook por cliente validado con schema

- Estado: aceptada
- Fecha: 2026-10-27

## Contexto

En un modelo FDE, cada cliente nuevo tiende a generar un fork: "este cliente no hace promesas", "este deriva todo lo urgente", "este trata de usted". Si esas diferencias viven en código, el costo de cada implementación crece y los arreglos no llegan a todos.

## Decisión

Todo lo que cambia entre clientes vive en `playbooks/<cliente>.yaml`, validado con un schema zod (`src/core/playbook.ts`) en build: intenciones habilitadas, reglas de facturación, umbrales y reglas de handoff, horarios y mensajes de derivación, tono y trato, adaptadores de integración, colección de KB y configuración de canales. `scripts/bundle-config.ts` valida y empaqueta playbooks y KB en un módulo TS, así Workers (sin filesystem) y Node usan el mismo artefacto.

Dos tenants de ejemplo prueban la idea: Fibrasur (vos, ARS, promesas automáticas, deriva solo urgencia crítica) y AndesLink (usted, PEN, sin promesas automáticas, deriva urgencia alta y al primer intento de inyección). La suite golden incluye el **mismo mensaje** con resultados distintos según el tenant.

## Consecuencias

- Un playbook inválido rompe el build y CI, no producción.
- Agregar una regla nueva al schema obliga a definir su default: queda documentada para todos los clientes.
- Límite: lo que no entra en el schema (un flujo de negocio nuevo) sigue requiriendo código; la regla es que se mueve al núcleo cuando lo piden dos clientes.
