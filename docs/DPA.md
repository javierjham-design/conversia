# Acuerdo de Tratamiento de Datos (DPA) — borrador

> ⚠️ **BORRADOR. No es asesoría legal.** Este documento debe **revisarlo un
> abogado** antes de usarse con clientes. Las secciones marcan claramente qué está
> **respaldado por el producto** (se puede afirmar sin mentir) y qué es
> **compromiso contractual** que el abogado debe validar/ajustar.

## Partes
- **Encargado del tratamiento (Processor):** Servicios Digital-Dent SpA (RUT
  77.911.025-7), operador de **TuBot** ("TuBot").
- **Responsable del tratamiento (Controller):** la empresa cliente ("Cliente" /
  "Tenant") que contrata TuBot.

TuBot trata datos personales de los usuarios finales del Cliente (sus contactos)
**por cuenta y según las instrucciones** del Cliente, únicamente para prestar el
servicio de atención conversacional por WhatsApp con IA.

## Objeto y duración
El tratamiento dura mientras esté vigente el contrato de servicio. Al terminar, el
Cliente puede exportar sus datos; luego se eliminan o anonimizan según la política
acordada.

## Naturaleza y finalidad del tratamiento
Atender, calificar, agendar y responder mensajes de WhatsApp; automatizaciones
(flujos); generación de respuestas con IA; reportería operativa. TuBot **no** usa
los datos del Cliente para fines propios ni para entrenar modelos.

## Tipos de datos y titulares
- Titulares: usuarios finales (contactos) del Cliente y usuarios operadores.
- Datos: identificación de contacto (nombre, teléfono, email), contenido de los
  mensajes y sus transcripciones, metadatos de conversación, y los datos que el
  Cliente decida capturar en campos personalizados. El Cliente **no** debe enviar
  categorías especiales (salud, datos financieros) salvo que tenga base de licitud
  propia y lo configure bajo su responsabilidad.

---

## (a) Lo que el PRODUCTO ya cumple técnicamente — se puede afirmar

Verificable en el sistema hoy:

1. **Aislamiento entre clientes**: RLS por organización en todas las tablas
   (probado en CI y verificado); un Cliente nunca ve datos de otro.
2. **Cifrado en tránsito** (HTTPS) y **cifrado en reposo de credenciales/secretos**
   sensibles (AES-256-GCM); las contraseñas se guardan con hash (bcrypt).
3. **Control de acceso por roles** (RBAC) y **MFA (2FA)** disponible, exigible a
   administradores.
4. **Retención configurable** por el Cliente (conversaciones/mensajes y
   transcripciones: 6/12/24 meses o indefinido) con **purga automática** periódica.
5. **Derecho de acceso**: exportación de todos los datos de un contacto (JSON).
6. **Derecho de supresión**: borrado a solicitud del titular que elimina
   conversaciones, mensajes, transcripciones, campos y etiquetas, y **anonimiza** la
   ficha; queda registrado en auditoría (quién y cuándo).
7. **Registro de auditoría** de acciones sensibles y **registro de eventos** de
   integración sanitizado (sin secretos).
8. **Subencargados declarados** (ver política de privacidad): Meta (WhatsApp),
   Anthropic (IA), OpenAI (transcripción), Railway (hosting), Cloudflare (red).
9. **Respaldos** de la base de datos y **procedimiento de recuperación probado**
   (RTO ~5 min al tamaño actual; ver `docs/DISASTER_RECOVERY.md`).
10. **Webhooks entrantes con firma** verificada; **no** se comparte el contenido con
    terceros fuera de los subencargados.

## (b) Compromisos CONTRACTUALES — requieren revisión de abogado

No los afirmes como "hechos técnicos"; son obligaciones a pactar y sostener:

1. **Rol y instrucciones**: TuBot actúa solo según instrucciones documentadas del
   Cliente; alcance exacto y límites → redacción legal.
2. **Confidencialidad** del personal con acceso a datos.
3. **Notificación de incidentes de seguridad**: plazo comprometido (p. ej. "sin
   demora indebida / dentro de X horas de confirmarlo") y canal. *Hoy el producto
   registra y detecta incidentes, pero el compromiso de plazo es contractual.*
4. **Subprocesadores**: derecho del Cliente a ser informado de altas/bajas y a
   objetar; lista mantenida y notificación de cambios.
5. **Transferencias internacionales**: base legal y salvaguardas para el
   procesamiento fuera de Chile (EE. UU.). → cláusulas a validar.
6. **Asistencia al Responsable**: cooperar en solicitudes de titulares y en
   evaluaciones de impacto. *El producto da las herramientas (export/borrado); el
   compromiso de asistencia y plazos es contractual.*
7. **Devolución/eliminación al terminar** el contrato: qué se devuelve, en qué
   formato y en qué plazo se elimina.
8. **Auditoría/derecho de inspección** del Cliente sobre el Encargado y sus medidas.
9. **Responsabilidad y límites** (indemnidad, topes) → decisión de negocio + legal.
10. **Ley aplicable y jurisdicción** (Chile; Ley N° 21.719 y su reglamento).
11. **Categorías especiales**: si algún Cliente tratará datos sensibles (salud,
    financieros), cláusulas y medidas adicionales específicas.

---

## Estado de la política de privacidad (gaps y correcciones)
- ✅ **Corregido**: subencargados ahora incluyen **OpenAI** (transcripción) y
  **Cloudflare** (red), además de Meta/Anthropic/Railway.
- ✅ **Corregido**: sección de **conservación/retención/eliminación** describe la
  política configurable y los derechos de acceso y supresión (respaldados por el
  producto).
- ⚖️ **Pendiente de abogado**: los plazos de **notificación de incidentes**, el
  detalle de **transferencias internacionales**, y la redacción del **DPA** como
  anexo del contrato de servicio. La política declara los derechos bajo la
  **Ley N° 21.719**; su interpretación y las obligaciones ante la Agencia de
  Protección de Datos deben validarse legalmente.

## Recomendación de retención por defecto
Dejar el default en **indefinido** (no borrar sin decisión del Cliente) evita
pérdidas accidentales, pero **para datos sensibles conviene un plazo acotado**.
Sugerencia comercial: ofrecer **12 meses** como valor recomendado en el onboarding,
explicando que se puede cambiar. Decisión de negocio del dueño.
