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

## Etapa 2 — Experiencia: Convi, protagonista del montaje

### Lo que cambió para el dueño

El copiloto tenía forma de burbuja de soporte: un ícono genérico abajo a la derecha que
había que descubrir. Ahora es **Convi**, un personaje con cara, nombre y progreso visible.

- **Avatar propio** en SVG inline, con cinco estados: saludando, pensando, hablando,
  celebrando y preocupado cuando algo falló. Todos los colores salen de los tokens de
  `globals.css`, así que sigue el tema claro/oscuro y el acento que el dueño eligió.
- **Se presenta solo en la primera entrada** del montaje: en escritorio como panel
  **acoplado** (el contenido se corre, Convi no tapa la pantalla que está explicando) y en
  móvil **compacto** —saludo y progreso en una barra baja— expandible al toque.
- **Barra de progreso** con los pasos clicables y los minutos que faltan: *"Paso 3 de 7 ·
  faltan ~12 min"*.
- **Si lo cierran, el acceso lleva el avatar con su anillo de progreso**, no un ícono
  genérico: el dueño ve cuánto le falta sin abrir nada.
- **Vuelve a ofrecer ayuda cuando la pantalla queda quieta** más de un minuto en un paso
  pendiente, una sola vez por paso.
- **Al terminar el montaje avisa de lo importante** sin que le pregunten: saldo agotado o
  bajo, canal caído, citas por confirmar en 48 horas.
- **Chips sugeridos dinámicos** según el paso pendiente (antes eran tres frases fijas).

### Decisiones

- **El panel de escritorio se acopla, no se superpone.** Un panel que tapa la pantalla que
  está explicando es un estorbo: con Convi abierto, el armazón corre el contenido a la
  derecha. En móvil no hay a dónde correrse, y una hoja a pantalla casi completa en la
  primera entrada le esconde el panel justo cuando quiere verlo, así que ahí se presenta
  compacto y se expande cuando él decide.
- **Se abre solo UNA vez por sesión y respeta el cierre.** Un panel que se abre en cada
  navegación no acompaña, molesta.
- **El umbral de saldo bajo se calcula sobre el número, no sobre la frase**, y es distinto
  por unidad: 100 créditos se van en unas pocas respuestas y 100 conversaciones no. Parsear
  el texto se rompía al cambiar una palabra.
- **Los avisos no muestran el error técnico.** "Hubo un problema con tu WhatsApp, ¿lo reviso
  contigo?" en lugar del mensaje que devolvió Meta.
- **Los minutos por paso estiman la tarea, no el clic.** Conectar WhatsApp pasa por el
  diálogo de Meta y la prueba depende de que el dueño agarre otro teléfono. Prefiero
  quedarme corto: decir "2 min" a algo que toma 6 es peor que no decir nada. Un test
  comprueba que el total del montaje queda entre 10 y 30 minutos.

### Bug encontrado y arreglado por el camino

**El copiloto se quedó ciego al saldo de los clientes de Créditos IA.** CRE 2 cambió la
unidad de cobro, pero la consulta de saldo del copiloto siguió mirando solo
`conversationDebitsWallet`: un cliente con plan de créditos veía el saldo **en blanco** en
el copiloto, justo el cliente al que el saldo le importa más porque se le gasta por
respuesta del bot. Ahora cubre las dos unidades y las nombra como corresponde. Reintroducir
la regresión tumba 3 tests.

### Qué NO entró

- El **Playwright "dueño nuevo desde cero" medido de punta a punta** es la Etapa 4. Lo que
  sí hice fue actualizar las tres jornadas del dueño que tocan el copiloto, así que la
  presentación de Convi, su progreso y su elegibilidad por marca se verifican en navegador
  real (desktop + iphone) en cada PR.

### Verificación

**api 601/601** (12 nuevos), **conversia-web 62/62** (35 nuevos), build de conversia-web
completo, jornadas A/B/D actualizadas y verdes en el job `dueno`. El guardián del saldo lo
rompí a propósito para verlo fallar. **Sin migraciones.**

## Etapa 4 — Medición y pruebas (#564)

### El embudo tenía un paso invisible

Al embudo del super admin le faltaba **"publicaron su asistente"**, que es justo el paso
donde el cliente se atascaba antes de COP 0: el bot existía pero seguía en borrador, sin
atender a nadie. Sin esa fila, entre "se registraron" y "conectaron su WhatsApp" había una
caída sin explicación.

Además había quedado **ciego al plan de Créditos IA**: la etapa "activaron" solo contaba el
plan por conversación, así que el día que se encienda el catálogo nuevo el embudo habría
mostrado una caída de conversión que no ocurrió.

Y ahora mide el **tiempo hasta "bot activo"** por **mediana, no promedio**: una sola cuenta
que tardó tres semanas movería el promedio a un número que no describe a nadie.

### Señales a Meta Ads: preparadas y apagadas

Cuenta creada (`CompleteRegistration`), bot atendiendo (evento propio) y plan activado
(`Purchase`, con su valor en CLP, que es lo que le permite a Meta optimizar por ingreso y no
por volumen).

**Nacen apagadas** (`FUNNEL_CAPI_ENABLED=false`) y es una decisión, no una omisión: mandarle
eventos a Meta es irreversible —entrenan el modelo del conjunto de anuncios— y hacerlo con
datos de prueba o duplicados ensucia la cuenta publicitaria de una forma que no se limpia.
La decisión de qué se manda y cuándo queda escrita, versionada y con tests; el dueño la
enciende cuando la campaña esté lista.

Son idempotentes por organización y hito, con el sello escrito **antes** de encolar: si el
proceso muere entre medio preferimos perder una señal a mandar un `Purchase` dos veces,
porque un valor contado doble le enseña a Meta que ese público paga el doble de lo que paga.
Un `Purchase` sin valor no se manda: un evento de compra con valor 0 le enseñaría que ese
público no vale nada, que es peor que no mandarlo.

### Jornada H: el recorrido completo, medido

`jornada-h-de-cero-a-activo.spec.ts` recorre en un navegador real, de punta a punta:
registro → Convi se presenta solo → datos del negocio y horario por el formulario →
servicios con precio → quien atiende con su horario → asistente publicado → canal con
asistente asignado → un cliente escribe y el bot responde → el saldo baja → el panel lo
refleja. En escritorio y en móvil, con el tiempo total y por hito adjunto al reporte.

**Corre en cada PR**, no solo de noche: la promesa del producto es "tu asistente andando en
minutos" y un recorrido que nadie mira se degrada sin que nadie se entere. El tiempo se
**adjunta, no se afirma con un tope**: un umbral duro en CI convierte una máquina lenta en un
build rojo y enseña a ignorar la suite.

Lo que la jornada no hace, y por qué: la conexión con Meta y el cobro usan el canal MOCK y
el proveedor de pago falso del sim. Levantar el popup real de Meta o cobrar de verdad en un
test es imposible, y fingirlo con un mock que siempre dice sí no probaría nada que no
prueben ya las jornadas B (popup bloqueado) y G (retornos de la pasarela).

### Verificación

api 636/636, worker 467/467, builds completos. Los dos guardianes nuevos se rompieron a
propósito para verlos fallar. **Sin migraciones.**
