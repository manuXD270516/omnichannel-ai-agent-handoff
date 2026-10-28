# Plantilla de discovery técnico y de negocio

Uso: primera y segunda reunión con el cliente (operaciones + TI). La salida de este documento es un **borrador de playbook** (`playbooks/<cliente>.yaml`), una lista de integraciones con dueño y fecha, y un set inicial de conversaciones golden. Si una respuesta no cambia el playbook, la integración o la suite de evaluación, probablemente sobra.

## 1. Objetivo y métrica de éxito

- ¿Qué problema concreto tienen hoy? (tiempo de espera, costo por contacto, abandono, picos estacionales, cobertura fuera de horario).
- ¿Cuál es **la** métrica que va a decidir si esto funcionó? Contención, AHT, CSAT, recupero de deuda, visitas mal agendadas. Una principal y dos secundarias, como máximo.
- Línea base actual y fuente del dato (reporte del contact center, CRM, WFM).
- ¿Qué resultado haría que lo apaguen? (ej. quejas por promesas mal registradas). Eso se vuelve un gate.

## 2. Volumen y demanda

- Contactos por día y por canal (WhatsApp, voz, email, web). Picos por hora y por día del mes (vencimientos).
- Top 10 de motivos de contacto con su porcentaje. Pedir **una muestra real anonimizada** de 200 a 500 conversaciones y transcripciones.
- Idiomas, variantes regionales, uso de audios e imágenes en WhatsApp.
- Porcentaje de contactos de clientes no identificados (número que no es del titular).

## 3. Qué resuelve la IA y qué no

Para cada motivo del top 10:

| Motivo | ¿La IA lo resuelve de punta a punta? | Sistema involucrado | Regla de negocio | ¿Cuándo siempre va a un humano? |
|---|---|---|---|---|
| Consulta de deuda | | ERP | | |
| Promesa de pago | | ERP | monto máx., plazo máx., mora máx. | |
| Falla técnica | | KB, NOC | | riesgo eléctrico |
| Visita técnica | | Agenda / FSM | zonas, franjas | sin cobertura |
| Baja | | CRM | | **siempre** |

- Acciones con efecto (registrar, agendar, modificar): ¿quién aprueba hoy?, ¿qué límites tiene un agente humano N1? La IA no debería tener más permisos que un N1.
- Temas prohibidos o sensibles (reclamos legales, defensa del consumidor, datos de salud).

## 4. Derivación a humanos

- Colas existentes, horarios, dotación y SLA de primera respuesta por cola.
- Qué necesita ver el agente humano para no repreguntar: datos del CRM, saldo, últimos pasos, motivo.
- Herramienta actual del agente (consola del CRM, Zendesk, Front, propia). ¿Ahí va el resumen o en nuestra bandeja?
- Reglas de derivación que ya aplican hoy en el IVR o el bot actual. Umbrales aceptables: ¿cuántos turnos sin resolver?, ¿se deriva al primer enojo?
- Fuera de horario: ¿se promete un callback?, ¿hay guardia?

## 5. Integraciones

Para cada sistema: tipo (CRM, ERP, agenda, KB, NOC), producto y versión, API disponible (REST, SOAP, SQL, archivo), autenticación, ambiente de pruebas, límites de rate, latencia típica, dueño técnico y tiempos de habilitación de credenciales.

- **Identificación del cliente:** ¿por teléfono?, ¿qué pasa con números compartidos? ¿Se puede pedir un dato de validación sin exponer PII?
- **Escrituras:** idempotencia, qué pasa si la API responde timeout pero la operación quedó hecha.
- **WhatsApp:** ¿tienen WABA y número verificado? ¿Quién es el BSP? Plantillas aprobadas (encuesta, recordatorio de pago), ventana de 24 h, opt-in.
- **Voz:** proveedor de telefonía/IVR, ASR/TTS, cómo se hace la transferencia (SIP REFER, número de cola).

## 6. Datos, seguridad y cumplimiento

- Datos personales que circulan (DNI, tarjeta, email). Qué se puede guardar, dónde y por cuánto tiempo. Ley local (AR 25.326, PE 29733, etc.).
- ¿Pueden salir datos a un LLM de terceros? ¿Con qué región y retención? Si no, ¿modelo propio/local?
- Revisión de seguridad del cliente: pentest, cuestionario, SSO para la bandeja.

## 7. Contenido y tono

- Base de conocimiento: dónde está, quién la mantiene, cada cuánto cambia. Pedir los documentos reales.
- Tono y trato (vos/tú/usted), nombre del asistente, firma, emojis sí o no, largo máximo.
- Frases que nunca se dicen (promesas de bonificación, plazos de reparación).

## 8. Operación después del go-live

- Quién revisa conversaciones derivadas y con qué frecuencia. Canal de feedback (etiquetas en la bandeja).
- Dashboards que ya usan; si quieren las métricas en su herramienta (Prometheus, Datadog, BI).
- Proceso de cambio: quién aprueba un cambio de playbook, ventana de despliegue.

## Salida del discovery (checklist)

- [ ] Métrica principal, línea base y umbral de éxito acordados.
- [ ] Borrador de `playbooks/<cliente>.yaml` validado con `pnpm bundle`.
- [ ] Matriz de integraciones con dueño y fecha de credenciales.
- [ ] 40+ conversaciones golden derivadas de la muestra real (anonimizadas).
- [ ] Reglas de derivación y colas confirmadas por operaciones.
- [ ] Revisión de privacidad: qué PII se redacta y qué proveedor de LLM se puede usar.
