# Decisión: multi-entidad por contacto (mascotas, vehículos) — F2

**Problema (catálogo §3):** algunos rubros tienen una o varias sub-entidades colgando del
contacto: **veterinaria** → mascotas (nombre, especie, raza, nacimiento, peso) y **taller**
→ vehículos (patente, marca, modelo, año, próximo mantenimiento). La patente/mascota es la
"llave" de la ficha y puede haber varias por contacto.

**Decisión (mecanismo MÍNIMO, sin tablas nuevas):** la plantilla del rubro **declara el
esquema** de la colección en `definition.customEntities`, y los datos por contacto se
guardan como un **array JSON en `contact.meta.<entidad>`** (el modelo `Contact` ya tiene
`meta Json`). No se crean tablas ni modelos nuevos.

```jsonc
// en vertical-templates.json → definition.customEntities
"customEntities": {
  "mascotas": { "label": "Mascotas", "fields": ["nombre","especie","raza","fecha_nacimiento","peso"], "repeatable": true }
}
// en runtime → contact.meta
{ "mascotas": [ { "nombre": "Toby", "especie": "perro", "raza": "quiltro", "peso": "12" } ] }
```

**Por qué así:**
- Cero migraciones de datos y cero acoplamiento: cada rubro define su colección sin tocar
  el esquema (regla "todo sale de la plantilla").
- `Contact.meta` ya es el payload flexible del contacto; las sub-entidades son datos del
  contacto, no entidades transaccionales (no requieren FKs ni índices propios hoy).
- Para campos simples de un solo valor (previsión, convenio, comuna) se usa
  `definition.customFields` + los modelos `CustomFieldDefinition`/`CustomFieldValue`
  existentes; las colecciones repetibles van por `customEntities`/`meta`.

**Alcance actual:** se **declara** el esquema en las plantillas (veterinaria, taller) y se
reserva la clave en `meta`. La **UI/herramientas** para capturar y editar estas colecciones
(y, si la recurrencia lo exige, promover `taller.vehiculos`/`veterinaria.mascotas` a una
tabla ligera con recordatorios por entidad) quedan en la cola **post-F4**, junto con
"clases grupales con cupos" (gimnasio) y "estado de orden con 1 toque" (taller) — catálogo §4.

**Si en el futuro se necesita consultar/recordar por sub-entidad a escala** (p. ej. "vacunas
por vencer esta semana" sobre miles de mascotas), se evaluará una tabla ligera
`contact_entities (id, contact_id, kind, data jsonb, next_due_at)`; hoy el array en `meta`
es suficiente y es la opción reversible/barata.
