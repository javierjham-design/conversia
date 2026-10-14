> **[2026-10-07] Superado por `CONVERSIA_V2.md`** (estructura completa del rediseño tras investigación de mercado de pricing por créditos y onboarding instantáneo). Este doc queda como registro del primer análisis.

# CONVERSIA AUTOMÁTICO — Rediseño hacia un producto autooperado por créditos

**Fecha:** 2026-10-07
**Pedido de Javier:** reestructurar Conversia a algo más automático y accesible — no tan complejo de armar como TuBot, cobro por créditos de uso en vez de (o además de) planes, y automatización máxima: prácticamente cero intervención manual del equipo.
**Tesis del rediseño:** no se bota nada de lo construido. El cambio es reemplazar al HUMANO del modelo llave-en-mano por el SISTEMA (paquete vertical + entrevista del bot + auto-QA + auto-publicación), y pasar el cobro a consumo con auto-recarga. Conversia deja de ser "te lo armamos" y pasa a ser **"se arma solo"** — que sigue siendo lo contrario de TuBot ("ármalo tú con herramientas pro").

---

## 1. DIAGNÓSTICO: dónde hay manos humanas hoy, y cómo se eliminan

| # | Intervención manual hoy | Automatización que la reemplaza | Base ya construida |
|---|---|---|---|
| 1 | Venta por agente comercial / alta por wizard de consola (operador) | Registro autoservicio por vertical desde la landing (`?vertical=`) — ya existe; vuelve a ser la vía principal | F2 ✓ |
| 2 | Implementación: servicios, precios, horarios, FAQ cargados por el equipo | **Entrevista conversacional del bot de implementación** (web o WhatsApp) que llena todo con las tools F8 + **precarga por scraping** (leerWeb sobre la web/Instagram del negocio) + defaults del paquete vertical | F8 + tool leerWeb + paquetes ✓ |
| 3 | Redacción/ajuste del prompt del agente | El paquete trae el prompt del rubro; la entrevista solo inyecta variables del negocio (nombre, tono, servicios). Ajustes posteriores: el dueño se lo pide a su propio bot (F8) o a soporte IA (F7) | F2/F6 ✓ |
| 4 | Revisión y publicación del agente (GO-LIVE por operador) | **Auto-QA**: el simulador corre la batería de escenarios del vertical (agendar, precio, reagendar, urgencia→humano…) y si pasa, **auto-publica**; si falla, reintenta con corrección automática y solo escala a humano tras N fallos | probador/test + reliability-monitor como base |
| 5 | Conexión WhatsApp guiada por el equipo | Embedded Signup in-app con wizard propio + verificación automática de salud del número; estado visible y reintentos guiados por el bot | canal ✓, falta pulir UX |
| 6 | Creación de plantillas HSM "con guía" | **Creación automática por API de Meta** (message_templates se crean vía API): el paquete trae las plantillas del rubro con variables, se suben solas y se monitorea su aprobación | template-guide ✓, falta el POST a Meta |
| 7 | Cobro del setup por link manual + gate de entrega | Desaparece el setup fee como gate humano (ver §3): activación por primer pago de créditos, automática | billing ✓ |
| 8 | Cobranza/renovaciones/suspensión | Ya automáticas (dunning, suspensión, fusible) + **auto-recarga de créditos** al cruzar umbral (cobro automático a la tarjeta guardada, con tope mensual configurable por el cliente) | Flow tarjeta guardada ✓, falta auto-recarga |
| 9 | Soporte | Agente IA primero (F7) con contexto total (F10); humano solo por derivación | ✓ |
| 10 | Operación diaria del equipo (revisar tenants) | La consola pasa de "operar clientes" a **gestión por excepción**: una cola única de alertas (bot fallando, créditos agotados sin recarga, número enfermo, margen negativo) — nadie mira fichas si no hay alerta | F10 ✓, falta la cola |

**Resultado:** el camino feliz (registro → entrevista → auto-QA → WhatsApp → operar → recargar) no toca a ningún humano del equipo. El equipo solo ve excepciones.

## 2. EL NUEVO ALTA (el "se arma solo", minuto a minuto)

1. Registro en la landing con rubro (2 min) → org creada con paquete vertical instalado (agente en borrador, flujos, etapas, servicios de ejemplo, HSM del rubro).
2. "Cuéntale a tu asistente sobre tu negocio": chat de entrevista (el mismo widget F7, modo implementación) — pide la web/Instagram y PRECARGA servicios/precios/horarios por scraping; el dueño corrige conversando ("el corte vale 12 mil", "los lunes no abrimos"). Todo escribe por tools F8 auditadas.
3. Auto-QA: el sistema corre los escenarios del vertical contra el agente configurado; verde → publica el agente y activa flujos base; rojo → autocorrige (reintento con feedback) y si persiste, ticket al equipo (excepción).
4. Conectar WhatsApp (Embedded Signup) cuando el dueño quiera — mientras tanto, **modo web**: el bot ya atiende en un link público de prueba/página de reservas para que vea valor ANTES de conectar Meta.
5. Plantillas HSM del rubro se crean solas por API; aprobadas → recordatorios activos.
6. Primer pago (créditos iniciales o activación, §3) → operación plena. Sin gate humano.

## 3. COBRO POR CRÉDITOS (propuesta)

**Principio:** un solo medidor que el cliente ya entiende (créditos) para TODO el consumo variable, con auto-recarga. La infraestructura es la bolsa actual + pesos por categoría (ya por marca) — se EXTIENDE, no se reemplaza.

**Unidad:** 1 crédito ≈ $20 CLP de valor de referencia. Débitos (pesos configurables sin deploy, como hoy):
- Mensaje de servicio (respuesta del bot sobre free tier Meta): 1
- Plantilla utilidad/auth: 1 · Plantilla marketing: 4 (como hoy)
- **Conversación IA atendida (nueva categoría):** 2–3 por conversación/día (cubre costo del modelo con margen; peso mayor si el vertical usa modelo premium)
- Acciones premium (difusión gestionada, etc.): peso propio

**Estructura (recomendada — híbrido estilo Twilio/OpenAI):**
- **Base de plataforma $29.900–39.900/mes** (mantiene WABA, número, hosting, soporte IA; incluye ~500 créditos). Evita el "SaaS gratis que cuesta plata" y cubre el costo fijo por tenant; sigue siendo 2–4x más accesible que el plan anterior.
- **Créditos por sobre**: $21.900/500 (ya existe) + sobres mayores con descuento leve ($39.900/1.000, $89.900/2.500).
- **Auto-recarga ON por defecto** (configurable): al caer bajo 100 créditos, compra el sobre elegido con la tarjeta guardada; tope mensual de gasto definido por el cliente. Avisos 80%/recarga como hoy.
- Alternativa evaluada (puro prepago sin base): máxima accesibilidad pero ingresos volátiles, churn silencioso y costo fijo por tenant sin cubrir — descartada salvo que Javier la prefiera.
- **El tier humano no muere:** "Conversia Gestionado" (implementación + gestión por el equipo) queda como SERVICIO OPCIONAL premium sobre el mismo producto (su precio actual), para quien lo pague — deja de ser el camino por defecto.

**Qué pasa con lo ya sembrado:** planes conversia_funcionando/gestionado se mantienen para quien los tenga; el nuevo default del registro es "Base + créditos". El versionado de planes (E4) ya lo permite sin romper nada.

## 4. PROS / CONTRAS DEL REDISEÑO

**Pros:** CAC y fricción mínimos (probar sin hablar con nadie, incluso antes de conectar WhatsApp) · margen operativo real (cero horas-hombre por alta; el COGS humano del modelo anterior desaparece) · escala sin equipo · ingresos alineados al valor (quien más usa, más paga) · auto-recarga = cobranza sin gestión · lo construido se reusa casi todo.
**Contras / riesgos y mitigación:** ingresos menos predecibles que suscripción (→ la base mensual amortigua) · abuso/costo IA en cuentas chicas (→ peso de conversación IA + fusibles existentes + modelo económico por defecto con upgrade de modelo como consumo premium) · clientes que se quedan a medio configurar (→ la entrevista retoma sola por WhatsApp/email: "te falta 1 paso para activar tu asistente") · calidad sin revisión humana (→ auto-QA obligatorio + monitoreo continuo con canario por tenant + kill-switch automático si la calidad cae) · se parece más a TuBot (→ diferenciación clara: en Conversia NADIE configura con editores — se conversa; TuBot sigue siendo la herramienta pro DIY).

## 5. QUÉ CAMBIA DE LO PLANIFICADO (impacto en el plan vigente)

- **B6 (ciclo de vida)**: se reescribe — vuelve el autoservicio, sin trial 7+7 de TuBot pero con "modo prueba por créditos de regalo" (p. ej. 100 créditos al registrarse, bot en modo web, sin tarjeta) y activación por primer pago. El gate de entrega humano queda SOLO para el tier Gestionado.
- **F10 (consola)**: sigue entera, pero su página principal pasa a ser la COLA DE EXCEPCIONES; el wizard de alta queda para Gestionado/ventas asistidas.
- **F5/COSTOS §0**: nueva estructura de cobro (base + créditos + auto-recarga); CONVERSIA_COSTOS.md se actualizará tras decidir §6.
- **R1/R2/B1–B8**: siguen válidos tal cual (son producto, no modelo de cobro). B6 es el único sub-bloque que muta.
- Nueva serie de prompts **C (automatización)**: C1 cobro por créditos + auto-recarga · C2 entrevista de implementación + scraping · C3 auto-QA + auto-publicación + canario por tenant · C4 HSM por API de Meta · C5 modo web/link público de prueba · C6 cola de excepciones en consola. (Se redactan al cerrar las decisiones de §6.)

## 6. DECISIONES PARA CERRAR (de Javier)

1. **Modelo de cobro**: híbrido base $29.900–39.900 + créditos (recomendado) · puro prepago sin base · o base aún menor.
2. **Tier Gestionado humano**: se mantiene como opcional premium (recomendado) o se elimina.
3. **Prueba gratis**: créditos de regalo al registro (¿100?) con bot en modo web y sin tarjeta — ¿sí/no y cuántos?
4. **Peso de la conversación IA** y modelo por defecto (económico con upgrade premium como consumo) — propuesta: peso 2, gpt-4o-mini/haiku default, sonnet como "asistente plus" peso 4.
