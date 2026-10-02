# Tenant comercial de Conversia (F6-2)

La organización desde la que opera el **bot que vende Conversia** (marca `conversia`).
Espejo del tenant comercial de TuBot (ver `docs/TUBOT_TENANT.md`), con prompts base
propios y **sin ORG_ID hardcodeado** (se resuelve por slug).

## Agentes

| slug | kind | rol | tools |
|---|---|---|---|
| `comercial` | sales | Vende Conversia; conoce SOLO los planes Conversia (vía `getPlanes`); cierra enviando el enlace de **alta de autoservicio** `app.conversia.cl/registro?vertical=` (D7) y transfiere a implementación | getPlanes, updateContactFields, updateLeadStatus, addTag, searchKnowledgeBase, transferToAgent, transferToHuman |
| `implementacion` | custom (Opus) | Acompaña el **montaje** paso a paso tras el alta; deja registro del avance | updateContactFields, addInternalNote, searchKnowledgeBase, triggerWorkflow, transferToHuman (+ tools de montaje en F6-3) |
| `soporte` | support | Soporte post-venta con base de conocimiento; deriva a persona o a otro agente | searchKnowledgeBase, addInternalNote, transferToAgent, transferToHuman |

La fuente de verdad de los prompts es el script
`packages/database/scripts/seed-conversia-comercial.mjs` (idempotente, prod-safe).

## Sembrar / actualizar (prod-safe, no toca otros tenants)

```bash
cd packages/database
DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/seed-conversia-comercial.mjs
# opcional: CONVERSIA_COMMERCIAL_SLUG=conversia CONVERSIA_COMMERCIAL_NAME="Conversia"
```

Crea/actualiza la org (brand=conversia) + roles + estados de lead + los 3 agentes
(versión PUBLISHED). **No conecta WhatsApp**: el número con Meta se conecta al final,
cuando la plataforma esté 100% lista. Para recibir leads reales falta ese paso.

## Pendiente
- **F6-3**: tools de montaje (`installVerticalPackage`, `upsertKnowledge`, `publishFlow`)
  para el agente de implementación + pantalla de **autorización de montaje** en el panel.
- Afinar prompts por rubro cuando esté el estudio de mercado de rubros.
