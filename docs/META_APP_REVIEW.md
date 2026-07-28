# App Review de Meta — convertir CONVERSIA en Proveedor de Tecnología

Objetivo: habilitar que **otros negocios (tenants) conecten su propio WhatsApp** desde nuestro panel con
**Embedded Signup** (flujo tipo Respond), sin crear apps ni pegar tokens. Para eso Meta exige **Acceso Avanzado**
a los permisos de WhatsApp, que se obtiene por **App Review**.

**Marca comercial:** TuBot (dominio `tubot.cl`). **App de Meta:** actualmente llamada `CONVERSIA` · App ID
`2024917441656687` · Business: Digital-Dent Temuco (verificado ✅). *(Opcional pero recomendado: renombrar la app
de Meta a "TuBot" en Configuración → Básica, para consistencia en el popup de Embedded Signup.)*

> ⚠️ Las URLs `https://www.tubot.cl/...` requieren que el dominio esté **apuntado a Railway** (dominio personalizado
> en el servicio `web` + CNAME en el DNS). Hasta entonces, las páginas siguen accesibles en la URL de Railway.

## Decisión de negocio (2026-07-27)
La **plataforma cobra directo a los tenants y paga directo a Meta** las conversaciones de WhatsApp; el tenant
solo le paga a la plataforma. Implica que, al conectar la línea de crédito de WhatsApp, el método de pago ante
Meta es el **de la plataforma**, no el del tenant. (Modelo Tech Provider, como Respond.)

## Permisos que se solicitan
| Permiso | Para qué | Acceso |
|---|---|---|
| `whatsapp_business_messaging` | Enviar y recibir mensajes en nombre del tenant | Avanzado (App Review) |
| `whatsapp_business_management` | Gestionar WABA/números/plantillas y el Embedded Signup | Avanzado (App Review) |

## Prerrequisitos (checklist antes de enviar)
- [x] Verificación del negocio (Meta) — **hecha**.
- [x] Producto WhatsApp agregado a la app — **hecho**.
- [ ] **Páginas legales publicadas** (ya creadas en el panel; requieren deploy):
  - Privacidad: `https://www.tubot.cl/legal/privacidad`
  - Términos: `https://www.tubot.cl/legal/terminos`
  - Eliminación de datos: `https://www.tubot.cl/legal/eliminacion-datos`
- [ ] En **Configuración de la app → Básica**: pegar esas 3 URLs (privacidad, condiciones, eliminación de datos),
      elegir **Categoría** y subir **ícono** de la app.
- [ ] Completar razón social / dirección reales en las páginas legales (hoy con placeholders).
- [ ] App en modo **Live** (interruptor superior) — requiere privacidad + negocio verificado.
- [ ] **Registro como Proveedor de tecnología** (WhatsApp → Configuración de la API → "Registro de proveedores de
      tecnología").
- [ ] **Embedded Signup** implementado y demostrable (lo construye Claude — ver abajo).

## Textos para el formulario de App Review (copiar/pegar)

**Descripción general del caso de uso:**
> TuBot es una plataforma SaaS multi-tenant de atención al cliente por WhatsApp. Cada empresa cliente conecta
> su propia cuenta de WhatsApp Business mediante Embedded Signup y gestiona sus conversaciones con agentes de IA y
> su equipo humano. TuBot envía y recibe mensajes en nombre de cada empresa y administra sus números,
> plantillas y suscripciones de webhook.

**Justificación `whatsapp_business_messaging`:**
> Lo usamos para enviar y recibir los mensajes de WhatsApp de cada empresa cliente dentro de su ventana de
> atención: recibimos los mensajes entrantes por webhook y respondemos con agentes de IA o con el equipo humano
> del cliente desde nuestra bandeja.

**Justificación `whatsapp_business_management`:**
> Lo usamos para el Embedded Signup (conectar la WhatsApp Business Account del cliente), registrar la suscripción
> de webhook del número, consultar el estado/calidad del número y gestionar plantillas de mensaje.

**Instrucciones para el revisor (test steps):**
> 1. Ingresar al panel de demostración: `https://www.tubot.cl` con las credenciales de
>    prueba provistas en el campo de credenciales.
> 2. Ir a **Canales → Conectar canal → WhatsApp Cloud → Conectar con Meta** para ver el flujo de Embedded Signup.
> 3. Ir a **Bandeja**: se muestra una conversación real de WhatsApp con respuesta automática del agente de IA.
> 4. Enviar un mensaje desde WhatsApp al número conectado y observar la respuesta en la bandeja.

## Guion del screencast (Meta exige video)
1. Mostrar el panel y el botón **Conectar con Meta** en Canales.
2. Ejecutar el **Embedded Signup**: seleccionar/crear WABA y número, autorizar.
3. Mostrar el número ya conectado en Canales.
4. Enviar un WhatsApp real al número → mostrar el mensaje entrante en la **Bandeja** y la **respuesta del agente**.
5. Mostrar brevemente las páginas de **privacidad** y **eliminación de datos**.

## Qué construye Claude (🤖) para que la revisión pase limpio
- **Botón "Conectar con Meta" (Embedded Signup)** en la página de Canales: SDK JS de Meta (`FB.login` con la
  configuración de WhatsApp Embedded Signup) + endpoint de intercambio de `code` → token por WABA.
- **Token por-canal** (hoy el worker usa el token global): guardar y usar el token de cada WABA conectada.
- Requiere de tu lado: crear la **"configuración de Embedded Signup"** en la app (Meta genera un `configuration_id`
  que necesito para el SDK).

## Pasos para enviar (los haces tú en el dashboard de Meta)
1. Deploy de las páginas legales (aprobar el push).
2. Completar Básica (URLs legales + categoría + ícono) y pasar la app a **Live**.
3. Completar **Registro de proveedores de tecnología**.
4. Ir a **Revisión de la app → Permisos y funciones**, solicitar `whatsapp_business_messaging` y
   `whatsapp_business_management`, pegar las justificaciones, subir el screencast y las credenciales de prueba.
5. Enviar. Meta suele responder en **días**; se puede iterar si piden ajustes.

> Nota honesta: los requisitos y pantallas exactas de Meta cambian con el tiempo; seguir también las indicaciones
> que muestre el propio dashboard. Este documento cubre la sustancia y los textos.
