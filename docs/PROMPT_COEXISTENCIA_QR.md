# PROMPT DE DESARROLLO — Coexistencia QR (conectar el número actual del cliente sin perder su app)

**Contexto de negocio.** El mayor punto de fricción del montaje Conversia es el alta de
WABA (SIMULACION_200_2026-10.md §4). La escalera decidida: (1) número de prueba al
registrarse, (2) **Coexistencia**: el cliente conecta el número que YA usa en la app
WhatsApp Business escaneando un QR — sin perder el teléfono, los chats ni la app — y
(3) Embedded Signup completo para número dedicado. Este prompt pide la pieza (2), la de
mayor impacto en conversión de onboarding.

**Qué es (Meta).** El "coexistence mode" del Cloud API permite onboardear un número que
está activo en la app WhatsApp Business: el Embedded Signup se lanza con el
`featureType` de onboarding de la app de negocio (`whatsapp_business_app_onboarding`),
Meta muestra un QR, el cliente lo escanea desde su app (como vincular un dispositivo) y
el número queda conectado al Cloud API **y sigue funcionando en su teléfono**. Opcional:
sincronización del historial de chats reciente y de contactos. VERIFICAR contra la doc
vigente de Meta (Embedded Signup → Coexistence / SMB app onboarding): nombres exactos de
parámetros, países soportados y límites (p. ej. mensajería desde la app vs. API,
plantillas, y los webhooks de eco `smb_message_echoes`).

## Alcance

1. **Backend (`apps/api`)** — reusar la infraestructura de `assisted-setup`
   (generate-link / authorize / status) agregando el modo coexistencia:
   - `POST /assisted-setup/coexistence/start`: genera la sesión de Embedded Signup con el
     featureType de coexistencia y devuelve la config/URL para el popup (misma mecánica
     que `meta/embedded-config`).
   - Callback/confirmación: al volver del popup, registrar el número (phone_number_id,
     waba_id) como `channel_connection` tipo WHATSAPP con `meta.coexistence=true`,
     disparar el registro del número si aplica y encolar la sync de plantillas existente.
   - Webhooks: aceptar y persistir los ecos de mensajes enviados DESDE la app del cliente
     (`smb_message_echoes` o equivalente) como mensajes OUTBOUND de origen "app" —
     la Bandeja debe mostrar la conversación completa aunque el dueño conteste a mano
     desde su teléfono. El dedupe por wamid ya existe; reusarlo.
   - El contador de free tier y el débito de conversaciones V2 aplican igual (mismo
     phone_number_id); nada especial que construir ahí.
2. **Panel del cliente (`apps/conversia-web`)** — en Canales y en el checklist de
   onboarding, tarjeta "Conecta tu WhatsApp actual (recomendado)": explica que el número
   sigue en su teléfono, botón que abre el popup/QR, estados (esperando escaneo →
   conectado → error con reintento). La opción "número dedicado" (Embedded Signup normal,
   Bloque A de PROMPT_AJUSTES_CANAL_ASISTENTE.md) queda como secundaria en la misma
   pantalla.
3. **Asistente in-app**: el paso "Conecta tu WhatsApp" del checklist y el tool
   `verEstado` deben reflejar la vía coexistencia (CTA al nuevo flujo) y el asistente
   debe saber explicarla (conocimiento del Bloque B).
4. **Super admin**: columna/flag de coexistencia en la vista de canales del tenant +
   excepción a la cola si la vinculación falla.

## Criterios de aceptación (sandbox)

- Con una WABA de prueba del Tech Provider: iniciar coexistencia desde el panel, escanear
  el QR con un número que corre la app WhatsApp Business, y que el canal quede `active`
  con `coexistence=true`, sin tocar el teléfono del cliente.
- Mensaje entrante → el bot responde por API; respuesta manual desde la APP del cliente →
  aparece en la Bandeja como saliente (eco), sin duplicar con el dedupe de wamid.
- El free tier del número y el débito V2 funcionan igual que en un canal normal (probar
  con el harness mock si no hay número real: simular el eco).
- TuBot intacto: nada de esto cambia canales existentes ni flujos de TuBot.
- Fallos de Meta (QR expirado, número no elegible, país no soportado) → mensaje claro en
  el panel + excepción en la cola del super admin, nunca un 500.

## Fuera de alcance

Migración de historial completo, multi-dispositivo avanzado, y el botón del Embedded
Signup dedicado (eso es el Bloque A ya especificado). No tocar funcionalidad TuBot.
