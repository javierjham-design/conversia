# Glosario de TuBot — un solo nombre para cada cosa

Fuente de la verdad de nomenclatura visible (menú, breadcrumb, títulos, botones,
mensajes y correos). Bloque 2 del programa de armonización (2026-08-25). Las
claves internas (slugs, rutas, eventos) NO se renombran: la traducción vive en
la capa de presentación.

## Entidades

| Concepto | Nombre único | Notas |
|---|---|---|
| Personas que escriben o se registran | **Clientes** (módulo) / **contacto** (registro individual) | El VOCABULARIO por rubro (Configuración → Rubro y personalización) puede cambiarlo (p. ej. «Pacientes»); el vocabulario es LA fuente para menú y breadcrumb. «Lead» solo dentro del contexto del embudo/Tablero. |
| Vista kanban del embudo | **Tablero** | Es una vista del módulo de personas, no un módulo aparte. El ítem de menú «CRM» lleva al Tablero. |
| Automatizaciones | **Flujos** | Título «Flujos», botón «+ Crear flujo». «Workflow» no aparece en la UI. |
| Bots de IA | **Agentes IA** | Igual en menú, título y textos. La página de ajustes globales es «Ajustes de IA». |
| Conexiones de conversación | **Canales** | WhatsApp, Instagram, Messenger. |
| Todo lo demás conectable | **Integraciones** | Frontera escrita en ambas páginas. |
| Redes de Meta | **Instagram** / **Messenger** | Nunca «Instagram Direct» ni «Facebook Messenger». |

## Estados y acciones

| Caso | Forma única |
|---|---|
| Conexión operativa | **«Conectado»** (canal) / **«Conectada»** (integración) — concordancia de género con el sustantivo visible; nunca «activo» en minúscula como estado de conexión |
| Guardar | **«Guardar cambios»** en todos los formularios (salvo acciones distintas de guardar, p. ej. «Publicar») |
| Próximas funciones | **«Próximamente»** |
| Paginación | **«N / página»** — un solo componente |

## Formatos

| Dato | Regla |
|---|---|
| Fecha/hora | Helper único: hoy «HH:mm», ayer «ayer HH:mm», mismo año «DD mmm», resto «DD-MM-AAAA» (es-CL) |
| Teléfono | E.164 legible: «+56 9 8269 9572» |
| Números | `toLocaleString("es-CL")` + `.tnum` en tablas |

## Vocabulario por rubro (fuente única)

`useTerm()` (layout) lee `personalization.vocabulary`. Términos: contacto/s,
servicio/s, profesional/es, cita/s, sucursal/es (plural agregado en B2). Toda
etiqueta de esas entidades pasa por `useTerm` — no se escriben a mano.
