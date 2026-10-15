# CONVERSIA V2 — Estructura completa: plataforma amena, bots que se arman solos, cobro por créditos

**Fecha:** 2026-10-07 · Supersede el enfoque comercial de `CONVERSIA_COSTOS.md` §0 y absorbe `CONVERSIA_AUTOMATICO.md`. Basado en dos investigaciones de mercado de esta fecha: (1) pricing por créditos/uso en 16 plataformas AI (Intercom Fin, Tidio, Chatbase, Lovable, Cursor, Replit, OpenAI, Twilio, Make, Zapier, BSPs…) con sus errores documentados ("credit anxiety", backlash de Cursor jun-2025, correcciones de Lovable/Replit 2026); (2) onboarding instantáneo (Chatbase, Fin, Durable, Lovable, Landbot, ManyChat, Shopify/Canva, HighLevel) + benchmarks PLG y **WhatsApp Coexistence** (conexión por QR manteniendo número y chats).

**El concepto en una frase:** *"Tu recepcionista IA se arma solo: pruébalo en 60 segundos, conéctalo cuando quieras, y paga por conversación atendida."*

---

## 1. EL VIAJE DEL CLIENTE (de visitante a bot operando — sin tocar a nadie del equipo)

**Regla de oro (benchmark):** wow en <2 minutos, sin cuenta; canal difícil AL FINAL; pago DESPUÉS del primer resultado. TTV best-in-class <5 min convierte 13–16% visita→signup vs 7–8%.

1. **Landing con el generador VIVO (sin login)** — un solo bloque: chips de rubro (Barbería, Dental, Estética, Taller, Veterinaria…) + "nombre de tu negocio" + opcional "tu web o Instagram". Patrón Durable/Lovable: el producto ES la portada.
2. **Construcción narrada (15–30 s)** — "Leyendo tu Instagram… cargando servicios de barbería… configurando tu agenda…". Si dio URL se scrapea (leerWeb) nombre/servicios/precios/horarios; si no, datos demo del paquete vertical. La espera se siente como construcción (patrón Lovable/Chatbase).
3. **WOW: simulador de WhatsApp jugable en pantalla** — UI idéntica a WhatsApp; el visitante chatea con SU bot, que saluda con el nombre de su negocio, cotiza y agenda una hora de prueba. Sin cuenta, sin tarjeta.
4. **Registro para GUARDAR** (Google/email, 5 s). Al entrar, el bot ya está (cero empty state — patrón Canva/Zendesk). Sin tarjeta.
5. **Checklist de activación (5 ítems, auto-completables, patrón Shopify):** ✅ Bot creado · ▢ Pruébalo en tu WhatsApp · ▢ Ajusta servicios y precios · ▢ Conecta tu número · ▢ Comparte tu link.
6. **"Pruébalo en TU WhatsApp" (patrón Landbot):** QR → chat con un número de prueba de la plataforma; el dueño vive su bot en su teléfono real en 1 minuto. Segundo wow, aún sin Meta.
7. **Edición conversacional, no formularios:** el propio bot entrevista al dueño en ese chat ("¿Cuánto cobras el corte? ¿Atiendes sábados?") y se auto-configura vía tools F8 (auditadas). La consola/configurador quedan para el equipo y casos avanzados.
8. **Conectar el canal (el paso duro, al final, con dos vías):**
   - **Coexistence (la vía estrella 2026):** "¿Ya usas WhatsApp Business en tu teléfono? Escanea este QR" — conserva número, chats y contactos (requisitos: app ≥2.24.17 + página de Facebook). Reduce el alta de días a minutos.
   - Embedded Signup clásico para número nuevo.
   - **Modo copiloto la primera semana (patrón HighLevel Suggestive):** el bot sugiere y el dueño aprueba con un toque; pasar a autopiloto cuando confíe. Mata el miedo a "soltar la IA".
9. **Auto-QA antes de autopiloto:** batería de escenarios del vertical corre sola (agendar, precios, reagendar, urgencia→humano); verde = publica; rojo = autocorrige y solo escala a humano como excepción.
10. **Pago tras el primer resultado:** gratis las primeras **30 conversaciones reales** (sin tarjeta); el upgrade aparece cuando el bot ya trabajó ("Tu bot atendió 28 conversaciones y agendó 9 horas — actívalo completo"). NUNCA cortar el loop justo tras la activación (anti-ejemplo Lovable).

## 2. MODELO DE COBRO V2 (créditos con fluidez, sin las trampas documentadas)

**Unidad: 1 crédito = 1 conversación atendida por el bot** (ventana de 24 h de Meta = frontera que el cliente ya conoce). Absorbe los mensajes de servicio y la IA de esa conversación — la pyme cuenta "clientes atendidos", no tokens ni mensajes (el error de legibilidad de Make/Chatbase). Costo variable real CL ≈ USD 0,03–0,05/conversación → precio ≈ **CLP 150–250/conversación** (margen 3–5x; 3x más barato que Tidio Lyro USD 0,70).

| Componente | Propuesta (CLP + IVA) | Racional |
|---|---|---|
| **Base de plataforma** | **$18.900/mes, incluye 100 conversaciones** (valor facial ~$20.000: "se paga sola") | MRR + ancla psicológica + cubre número/hosting/soporte IA; sin ella el prepago puro da churn silencioso e ingresos volátiles |
| Pack 400 conversaciones | **$84.900** (~$212 c/u) | corregido 2026-10-14 tras el cálculo a máximo uso (§2.1): el precio anterior ($112) quedaba BAJO el costo Meta de una conversación fuera del free tier |
| Pack 1.000 | **$199.900** (~$200 c/u) | ídem |
| Recarga suelta 100 | **$21.900** — mismo precio unitario aprox. | sin castigo por recargar (la queja contra el top-up 2x de Lovable) |
| **Auto-recarga** | Umbral configurable ("quedan 20 → compra 100") **con TOPE mensual de gasto** elegido por el cliente | el patrón OpenAI/Lovable: el tope convierte la auto-recarga de débito-sorpresa en tranquilidad |
| **Rollover** | Créditos del plan ruedan **2 meses**; comprados, 12 meses | patrón Lovable/OpenAI: elimina "pagué y lo perdí" sin regalar inventario |
| **Al llegar a 0** | Avisos al 75% y 90% (WhatsApp al dueño) → en 0, **gracia de 20 conversaciones** que se descuenta de la próxima recarga + respuesta de respaldo + derivación a humano. **El bot JAMÁS queda mudo de golpe** | el peor fallo documentado (Voiceflow); patrón Zapier "sigue y factura después" |
| Difusiones/marketing | FUERA del crédito-conversación: costo Meta transparente + fee fijo pequeño por mensaje (patrón Gupshup $0,001; nunca markup opaco estilo Wati) | passthrough transparente = argumento de venta |
| Gestionado humano | Add-on opcional ($149.900+/mes, lo ya construido) para quien quiera equipo | no se bota el tier premium; deja de ser el default |
| Gratis | 30 conversaciones de regalo al registro, sin tarjeta; modo web/número de prueba ilimitado con marca Conversia | tarjeta después del wow (benchmark pyme) |

**Transparencia radical (antídoto a la credit anxiety, la barrera #1 de adopción según el field report de Metronome):** medidor siempre visible "conversaciones usadas/restantes", historial por conversación, estimador ("con tu ritmo, este pack dura ~6 semanas"), y simulador de migración para clientes existentes ("con tu uso del mes pasado habrías pagado $X") + **grandfathering**: nadie es forzado a migrar (no repetir Cursor jun-2025: facturas sorpresa → disculpa del CEO + reembolsos).

### §2.1 Economía a MÁXIMO uso (cálculo 2026-10-14 — fija los precios de arriba)

**Costo marginal NUESTRO por conversación en Chile (fuera del free tier de Meta):**
respuestas del bot × $19 CLP (servicio entregado) + IA + recordatorios + pasarela.
Con el invariante "una respuesta por turno" (E4), el rango real es 6–10 respuestas:

| Respuestas/conv | Meta | IA (4o-mini) | Utilidad prorrateada | **Costo marginal** |
|---|---|---|---|---|
| 6 | $114 | $5 | $11 | **~$130** |
| 8 (base de cálculo) | $152 | $5 | $11 | **~$168** |
| 12 (tope blando) | $228 | $10 | $11 | **~$249** |

Dentro del free tier (1.000 mensajes de servicio gratis/mes por número ≈ las
primeras ~125 conversaciones a 8 respuestas): costo marginal ≈ **$16–21** (solo IA
+ utilidad). Por eso la BASE de $18.900/100 es segura (margen ~70%) y lo crítico
es el precio de los packs: a $112–85/conv (propuesta original) el pack 400 daba
**margen −10%** y el de 1.000 **−54%** a consumo pleno. Con los precios corregidos:

| Escenario a consumo PLENO (8 resp/conv) | Ingreso | Costo total (Meta+IA+util+Flow 3,8%+infra) | **Margen** |
|---|---|---|---|
| Base sola (100 conv — dentro del free tier) | $18.900 | ~$5.300 | **~$13.600 (72%)** |
| Base + pack 400 (500 conv) | $103.800 | ~$71.700 | **~$32.100 (31%)** |
| Base + pack 1.000 (1.100 conv) | $218.800 | ~$177.000 | **~$41.800 (19%)** |
| Sensibilidad: mismos escenarios a 6 resp/conv | — | — | 75% · 42% · **35%** |
| Sensibilidad: a 12 resp/conv (si no hay guardrail) | — | — | 55% · −5% · −23% |

**Conclusiones no negociables que esto impone (van en V2-0/V2-1):**
1. Precios de packs ≥ $200/conv (los de la tabla §2). LATAM: en CO/MX el costo
   Meta es 3–25x menor → margen muy superior con el mismo precio USD.
2. **GUARDRAIL ECONÓMICO de respuestas por conversación**: objetivo ≤8 (prompts
   concisos del paquete + E4 ya vigente); tope blando 12/día por conversación →
   el bot pasa a modo resumen y agrupa; es la variable que decide el margen.
3. **Telemetría de margen por conversación** (el ledger ya guarda costUsd): alerta
   a la cola de excepciones si el costo medio/conv de un tenant supera $180.
4. Asistente Plus (crédito x2 ≈ $400–440/conv): cubre sonnet incluso a 12
   respuestas ($150 IA + $228 Meta ≈ $378) — el x2 es correcto, no bajarlo.
5. Gracia de 20 conv: exposición máxima ~$3.400 por tenant (aceptable); difusiones
   siempre a costo Meta + fee (neutras al margen).

**Ejemplo (clínica dental, 300 conversaciones/mes):** base $18.900 + pack 400 $44.900 ≈ $63.800/mes → costo variable nuestro ≈ $9.000–15.000 → margen ~70–75%; al cliente cada paciente atendido le cuesta ~$160 — menos que un click de Meta Ads. Mes con campaña (600 conv.): rollover + auto-recarga con su tope. Sin sorpresas y sin bot caído.

## 3. QUÉ SE REUSA, QUÉ MUTA, QUÉ ES NUEVO

**Se reusa intacto (el motor ya en producción):** paquetes verticales + catálogo de rubros · bolsa/ledger con pesos por marca (la contabilidad del crédito-conversación se apoya en el contador de conversaciones E3 ya construido) · tools F8 (la entrevista escribe por ahí) · soporte F7 con ticket · configurador de agentes en consola (R2) · caja F9 · diseño Nocturna completo · Hoy/bandeja/agenda (R1/B).
**Muta:** F5/COSTOS §0 → este modelo (planes actuales quedan grandfathered) · B6 → autoservicio con 30 conv. gratis y activación por primer pago (el gate humano queda solo en Gestionado) · F10 home → cola de excepciones (nadie revisa fichas sin alerta) · la "entrevista de implementación" pasa de humano/wizard a conversación del bot.
**Nuevo (la serie V2 de desarrollo):**
- **V2-1 Crédito-conversación**: nueva categoría de wallet "conversación" (debita 1 al contar la conversación del período — reusa `countConversationOnce` de E3), packs/rollover/gracia/avisos, degradación elegante.
- **V2-2 Auto-recarga capada**: cargo automático Flow con umbral + tope mensual, idempotente y auditado (los 3 incidentes de Twilio son la advertencia: idempotencia + auditoría + e-mail de cada recarga).
- **V2-3 Landing generador + simulador web**: generador en la portada (rubro+nombre+URL), construcción narrada con scraping, simulador WhatsApp jugable sin cuenta, registro-para-guardar con el bot ya vivo.
- **V2-4 Número de prueba "en TU WhatsApp"**: pool de número(s) de la plataforma + QR; enruta cada chat de prueba a la org correcta por código; ahí mismo corre la entrevista conversacional.
- **V2-5 Coexistence + copiloto**: alta de canal por QR (requisitos y fallback a embedded signup) + modo Suggestive (el dueño aprueba respuestas la primera semana) en la bandeja.
- **V2-6 Auto-QA y auto-publicación**: batería de escenarios por vertical (simulador existente), autocorrección con reintento, publicación automática, canario continuo por tenant + kill-switch a copiloto si la calidad cae.
- **V2-7 HSM por API**: creación automática de las plantillas del rubro vía API de Meta + monitoreo de aprobación.
- **V2-8 Checklist de activación + cola de excepciones**: checklist event-driven (patrón Shopify) en el panel; home de consola = cola única de alertas (bot fallando, saldo 0 sin recarga, número enfermo, margen negativo).
- **V2-9 Migración y grandfathering**: simulador "tu uso del mes pasado", opt-in de clientes actuales, sandbox/demo intactos.
(Los prompts detallados de V2-1…V2-9 se redactan al estilo R/B cuando Javier apruebe esta estructura.)

## 4. KPIs DEL NUEVO FUNNEL (instrumentar desde el día 1)
% visitantes que chatean con el simulador → % registro → % que prueba en su WhatsApp → % que conecta número (Coexistence vs signup) → % que activa pago tras las 30 gratis → TTV mediano (target: wow <2 min, canal <24 h) → conversaciones/tenant/mes → tasa de auto-recarga y de topes alcanzados → excepciones/100 tenants (la métrica de "cero intervención").

## 5. RIESGOS PRINCIPALES Y SU MITIGACIÓN
1. **Credit anxiety** → tope de gasto + rollover + medidor radical + unidad legible (conversación). 2. **Bot mudo en 0** → gracia + fallback + derivación. 3. **Abuso del gratis/número de prueba** → verificación de teléfono, límites por IP/dispositivo, marca de agua "Demo por Conversia". 4. **Coexistence no disponible para un cliente** (app vieja, sin página FB) → vía clásica guiada por el bot. 5. **Costo IA por conversación** → modelo económico por defecto; "Asistente Plus" (modelo premium) como multiplicador de crédito (x2) opt-in. 6. **Canibalizar TuBot** → TuBot sigue siendo la herramienta PRO configurable (agencias/power users); Conversia es "se arma solo" — mensajes y públicos distintos. 7. **Ingresos** → la base de $18.900 sostiene MRR; el crecimiento viene del consumo (modelo que creció 126% en el top-500 SaaS en 2025).

## 6. DECISIONES PARA APROBAR (y pasamos a los prompts V2)
1. Números del §2 (base $18.900/100 · packs 400/1.000 · $150–250 por conversación) — ¿ok o ajustamos?
2. 30 conversaciones gratis sin tarjeta — ¿ok?
3. Gestionado como add-on premium — ¿se mantiene (recomendado)?
4. "Asistente Plus" (modelo premium = crédito x2) — ¿se incluye de partida o después?
