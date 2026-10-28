# COPILOTO DE MONTAJE — resultados

Entregable de `docs/PROMPT_COPILOTO_MONTAJE.md`. Una sección por etapa, con lo que quedó
hecho, lo que decidí y lo que falta.

## Etapa 0 — Que el camino hasta "bot activo y pagado" exista

Cerrada en **#550** (y el bug del aviso de pago que quedó abierto ahí, en **#560**). El
detalle está en la fila 3 de `docs/PLAN_EJECUCION_LANZAMIENTO.md`.

De los dos pendientes que esa etapa dejó anotados:

- **El aviso de "Pago recibido" nunca aparecía** al volver de la pasarela → cerrado en #560.
  La causa no estaba en la pantalla de cobros sino en el PWA: `PwaManager` recargaba la
  página en cada `controllerchange`, y en la PRIMERA visita de cada cliente el service
  worker se activa y llama a `clients.claim()`, así que toma el control de una pestaña que
  no tenía ninguno → recarga. La pantalla alcanzaba a mostrar el aviso y a limpiar la query;
  la recarga traía `/cobros` sin query y el aviso moría. Arreglo de una línea (recargar solo
  si ANTES había controlador), que de paso elimina un recargue espurio en la primera visita
  de todo cliente. El caso de la jornada G volvió a estar activo.
- **`/ajustes` no tenía formulario de datos del negocio** → cerrado en esta etapa (abajo).

## Etapa 1 — Protocolo de acciones: el copiloto actúa

### Lo que cambió para el dueño

Antes el copiloto conversaba: sabía en qué paso estaba el montaje y le explicaba al dueño
qué tocar y dónde. El dueño tenía que leer la indicación, encontrar la pantalla y acertar.
Ahora el copiloto **hace**:

- **Navega y resalta.** Cuando propone un paso, lleva al dueño a la pantalla y le marca el
  control con un globo explicativo (`acompañarPaso`).
- **Completa los datos del negocio** (nombre, rubro, dirección, descripción) y **el horario
  de atención**, entendiendo lo que se le dicta ("lunes a viernes de 9 a 18", "6pm").
- **Arma la agenda**: suma a quien atiende con su horario semanal y ajusta el bloque entre
  horas y la anticipación mínima.
- **Arma el asistente de punta a punta**: lista las plantillas del rubro, lo crea, le ajusta
  tono/reglas/preguntas frecuentes, **lo prueba** con un mensaje de cliente y lo **publica**.
- **Diagnostica WhatsApp** antes de hablar de conectar nada, y entrega el botón con el camino
  correcto ya elegido.
- **Publica la página del negocio** con los datos ya cargados.

### Decisiones

- **El servidor decide las acciones, no el texto del modelo.** El modelo elige la
  herramienta; el servidor decide qué acción corresponde y la pasa por una lista blanca
  (`apps/api/src/assistant/actions.ts`): `navigate` solo a rutas que existen en
  conversia-web, `highlight` solo a elementos con `data-copilot` conocido, botón externo
  solo `https`. Una respuesta alucinada no puede mandar al cliente a un 404 ni fabricar un
  botón de pago. Dos tests recorren el árbol real de páginas y el código de la web, así que
  renombrar una pantalla o borrar un anclaje falla en CI.
- **Pagar y conectar WhatsApp siguen siendo un clic del dueño.** No es preferencia de
  diseño: el navegador bloquea el popup de Meta si no nace de un clic, y cobrar sin que lo
  toque él no se hace. El copiloto diagnostica y entrega el botón.
- **El copiloto nunca toca el modelo de IA.** Un asistente creado desde plantilla nace con
  el modelo que fija la plataforma, **ignorando el que traiga la plantilla**: en Conversia el
  modelo multiplica el consumo de Créditos IA (CRE 1 §4), y una plantilla vieja con un modelo
  caro le cambiaría el costo al cliente sin que nadie lo decidiera. Hay un test que falla si
  eso se invierte.
- **Publicar está condicionado a que la prueba pase.** `publicarAsistente` corre la batería
  y, si algo falla, NO publica y dice qué revisar: es mejor un asistente en borrador que uno
  atendiendo mal.
- **Modelo propio del copiloto** (`ASSISTANT_MODEL`, separado de `AI_DEFAULT_MODEL`), 8
  rondas de herramientas y 1.200 tokens de salida. Con 4 rondas se quedaba a mitad de camino
  al armar un asistente (ver estado → listar plantillas → crearlo → probarlo → publicarlo).
  Vacío = usa el default del proveedor, así que no hace falta tocar entorno para desplegar.
- **El costo del montaje lo paga Conversia, no el cliente.** Se registra en `usage_events`
  con `meta.source="copilot_setup"` y NO en `ai_requests`, que es la unidad de cobro de los
  Créditos IA: dejarlo ahí sería invitar a que algún día se le debite al tenant el copiloto
  que lo ayudó a montarse. (`AiPurpose` tampoco tiene un valor para el copiloto, y agregarlo
  sería una migración de enum.)
- **Un solo escritor de los datos del negocio** (`organizations/business-data.ts`), usado por
  la herramienta del copiloto y por el formulario del panel. Con dos escritores, el nombre en
  `organization.name`, el rubro en `settings.general.industry` y la dirección en
  `settings.business.direccion` se desincronizan solo.
- **El horario se edita como lista de tramos por día**, no como un rango único: la
  organización guarda hasta 4 por día y los negocios que cierran a mediodía usan dos. Un
  formulario de un solo rango habría borrado el segundo tramo en silencio al guardar.

### Bug encontrado y arreglado por el camino

**`PUT /settings/hours` rechazaba TODOS los horarios reales.** Las tres expresiones de
validación decían `d{2}` en vez de `\d{2}` —"la letra d dos veces"—, así que `"09:00"` no
pasaba y el endpoint respondía "Horario inválido" para cualquier horario, mientras `"dd:dd"`
sí pasaba. Como el paso bloqueante nº1 exige `businessHours.hours`, **el montaje era
imposible de terminar desde el panel**: el horario solo lo podía dejar el instalador de
rubros. Era, además, la otra mitad del pendiente de COP 0 (`/ajustes` no tenía el formulario
y el endpoint que habría usado estaba roto). Las dos direcciones quedaron con test, y
verifiqué que reintroducir el bug tumba 6 tests.

### Qué NO entró

- **Chips sugeridos dinámicos, avatar "Convi", modo montaje acoplado y coach marks
  permanentes**: son la Etapa 2, no esta.
- **Playwright "dueño nuevo desde cero"**: la Etapa 4 pide el recorrido completo medido. Las
  herramientas de esta etapa quedan cubiertas por tests unitarios (permisos, tenant,
  validación, protocolo de acciones) tal como pide el cierre de la Etapa 1.

### Verificación

`typecheck` + `build` + tests en verde: **api 589/589** (75 nuevos), **conversia-web 27/27**
(15 nuevos), build de conversia-web completo. Los cuatro guardianes nuevos los rompí a
propósito para ver que fallan: ruta inexistente en la lista blanca, `data-copilot` borrado de
la web, plantilla pisando el modelo de la plataforma y enlace externo convertido en enlace.

**Sin migraciones.** TuBot no se toca: el asistente está gateado a `brand=conversia` desde
antes (`assertConversia` responde 404 al resto).
