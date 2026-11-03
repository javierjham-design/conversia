import type { Metadata } from "next";
import { LEGAL, LegalShell } from "../_config";

export const metadata: Metadata = {
  title: "Política de Privacidad · Conversia",
  description: "Cómo Conversia trata los datos personales.",
};

export default function Privacidad() {
  return (
    <LegalShell title="Política de Privacidad">
      <p>
        Esta Política explica cómo {LEGAL.razonSocial} (RUT {LEGAL.rut}, domicilio en {LEGAL.domicilio}), responsable del
        servicio {LEGAL.marca} (el &ldquo;Servicio&rdquo;), trata los datos personales, conforme a la Ley N° 19.628 sobre
        Protección de la Vida Privada y demás normativa chilena aplicable.
      </p>

      <h2>1. Roles: responsable y encargado</h2>
      <ul>
        <li><strong>Datos de la cuenta del Cliente</strong> (quien contrata {LEGAL.marca}): somos responsables del tratamiento.</li>
        <li><strong>Datos de los clientes finales</strong> (las personas que conversan con el asistente del Cliente): el <strong>Cliente es el responsable</strong> y {LEGAL.marca} actúa como <strong>encargado</strong>, tratándolos por cuenta del Cliente, según sus instrucciones y los Términos.</li>
      </ul>

      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li><strong>De la cuenta:</strong> nombre, correo, teléfono, empresa, país, credenciales (cifradas) y preferencias.</li>
        <li><strong>De uso y facturación:</strong> plan, consumo de conversaciones, pagos (procesados por pasarelas externas; no almacenamos los datos completos de tarjetas), registros de actividad y auditoría.</li>
        <li><strong>De las conversaciones:</strong> mensajes entrantes y salientes, números de teléfono, nombres de perfil, contenido y metadatos necesarios para operar el canal y el asistente.</li>
        <li><strong>Técnicos:</strong> dirección IP, identificadores de sesión y datos del dispositivo/navegador necesarios para seguridad y funcionamiento.</li>
      </ul>

      <h2>3. Para qué los usamos</h2>
      <ul>
        <li>Prestar y operar el Servicio (atención, agenda, contactos, cobros).</li>
        <li>Procesar pagos y emitir comprobantes.</li>
        <li>Seguridad, prevención de fraude y abuso, y cumplimiento legal.</li>
        <li>Soporte, avisos operativos y mejoras del Servicio.</li>
        <li>Generar respuestas del asistente mediante proveedores de inteligencia artificial.</li>
      </ul>

      <h2>4. WhatsApp / Meta y otros canales</h2>
      <p>
        Para operar por WhatsApp Business Platform intercambiamos con Meta los datos estrictamente necesarios (por ejemplo,
        número y contenido del mensaje). El tratamiento por parte de Meta se rige además por sus propias políticas. Usted debe
        asegurarse de contar con base legal y consentimiento para contactar a sus clientes finales.
      </p>
      {/* M0 — el registro va a pedir el WhatsApp del dueño como obligatorio (M3), con un check
          de consentimiento. Lo que se promete en ese check tiene que estar explicado acá. */}
      <p>
        <strong>Su WhatsApp, el del registro.</strong> Al crear su cuenta le pedimos su número de celular. Lo usamos para
        <strong> ayudarle a dejar su asistente andando</strong> (por ejemplo, escribirle si quedó a medio camino conectando su
        WhatsApp o si su prueba está por terminar) y para soporte. Es un consentimiento <strong>separado y explícito</strong>:
        usted lo acepta con una casilla al registrarse, y guardamos la fecha y el texto exacto que aceptó. Puede revocarlo en
        cualquier momento respondiendo <em>&ldquo;no&rdquo;</em> o <em>&ldquo;basta&rdquo;</em> a cualquiera de esos mensajes, o
        escribiendo a <a href={`mailto:${LEGAL.emailPrivacidad}`}>{LEGAL.emailPrivacidad}</a>; dejaremos de escribirle y eso no
        afecta su servicio. Nunca cedemos su número a terceros con fines publicitarios.
      </p>

      {/* Sección exigida por Google para verificar la app que pide permisos de Calendar:
          qué datos se leen, para qué, y la declaración de Limited Use. Debe quedar en una
          URL pública y estable, porque es la que se declara en la consola de Google. */}
      <h2 id="google">5. Google Calendar (uso de datos de Google)</h2>
      <p>
        Si usted conecta su cuenta de Google Calendar, pedimos los permisos mínimos para que su agenda funcione:{" "}
        <em>ver</em> y <em>administrar eventos</em> de los calendarios que usted elija. La conexión es voluntaria y se puede
        desconectar en cualquier momento desde la Agenda, lo que revoca nuestro acceso.
      </p>
      <p><strong>Qué leemos:</strong> los eventos y las horas ocupadas únicamente de los calendarios que usted selecciona.</p>
      <p>
        <strong>Para qué:</strong> solo para agendar sin choques. Las horas que usted ya tiene ocupadas en Google dejan de
        ofrecerse a sus clientes, y las citas tomadas en Conversia aparecen en su calendario. No leemos ningún otro calendario
        ni otro servicio de Google.
      </p>
      <p>
        <strong>Qué NO hacemos:</strong> no usamos los datos de Google para publicidad ni para perfilar personas, no los
        vendemos ni los cedemos a terceros con fines comerciales, y no los usamos para entrenar modelos de inteligencia
        artificial. El contenido de sus eventos personales no se muestra en el panel: solo el bloque de tiempo ocupado.
      </p>
      <p>
        El uso y la transferencia de la información recibida de las API de Google se ajusta a la{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">
          Google API Services User Data Policy
        </a>
        , incluidos los requisitos de uso limitado (<em>Limited Use requirements</em>).
      </p>

      <h2>6. Proveedores (encargados)</h2>
      <p>
        Nos apoyamos en proveedores que tratan datos por nuestra cuenta bajo obligaciones de confidencialidad y seguridad, entre
        ellos: alojamiento e infraestructura en la nube, pasarelas de pago, proveedores de modelos de inteligencia artificial y
        servicio de correo transaccional. Solo acceden a lo necesario para su función.
      </p>

      <h2>7. Inteligencia artificial</h2>
      <p>
        El contenido de las conversaciones puede enviarse a proveedores de IA para generar respuestas. Seleccionamos proveedores
        con compromisos de confidencialidad y, cuando está disponible, de no uso de los datos para entrenar sus modelos. No
        vendemos datos personales.
      </p>

      <h2>8. Transferencias internacionales</h2>
      <p>
        Algunos proveedores pueden alojar o procesar datos fuera de Chile. En esos casos adoptamos resguardos razonables para
        proteger la información conforme a la normativa aplicable.
      </p>

      <h2>9. Conservación</h2>
      <p>
        Conservamos los datos mientras exista la cuenta y por los plazos necesarios para cumplir obligaciones legales, contables
        y de seguridad. Los datos de las conversaciones se conservan según la configuración del Cliente y los plazos de retención
        del Servicio; tras la baja de la cuenta se eliminan o anonimizan en los plazos informados, salvo obligación legal de
        conservarlos.
      </p>

      <h2>10. Seguridad</h2>
      <p>
        Aplicamos medidas técnicas y organizativas razonables: cifrado de credenciales, control de acceso por organización
        (aislamiento multiinquilino), verificación en dos pasos para administradores y registros de auditoría. Ningún sistema es
        100% infalible; ante un incidente relevante actuaremos conforme a la ley.
      </p>

      <h2>11. Sus derechos</h2>
      <p>
        Usted puede ejercer los derechos de acceso, rectificación, cancelación (eliminación) y oposición respecto de sus datos,
        así como solicitar información sobre su tratamiento, escribiendo a{" "}
        <a href={`mailto:${LEGAL.emailPrivacidad}`}>{LEGAL.emailPrivacidad}</a>. Si usted es un cliente final que fue contactado
        por un negocio que usa {LEGAL.marca}, diríjase a ese negocio (responsable de sus datos); también podemos encauzar su
        solicitud hacia él.
      </p>

      {/* M0 — esta sección decía solo "cookies necesarias" y aclaraba "no usamos cookies de
          publicidad de terceros EN EL PANEL". Con las campañas de Meta entran al sitio público
          el Pixel y la Conversions API, así que acá se declara qué se instala, para qué, cuánto
          dura y cómo oponerse. Redactado para la Ley 21.719 (vigente desde diciembre de 2026),
          que exige consentimiento previo e informado para lo no esencial. */}
      <h2 id="cookies">12. Cookies y medición publicitaria</h2>
      <p>
        <strong>Cookies necesarias (siempre activas).</strong> Almacenamiento local y cookies estrictamente necesarias para
        iniciar sesión, mantener su sesión y recordar sus preferencias de tema e idioma. Sin ellas el Servicio no funciona, por
        lo que no requieren consentimiento. <strong>En el panel y en el asistente no instalamos cookies publicitarias.</strong>
      </p>
      <p>
        <strong>Cookies de medición (solo si usted las acepta).</strong> En las páginas públicas de {LEGAL.marca} —portada,
        páginas por rubro, precios y el generador— podemos instalar el <strong>Pixel de Meta</strong> para medir el resultado de
        nuestra publicidad: saber cuántas personas que vieron un anuncio terminan creando una cuenta. Esto instala las cookies
        <strong> <code>_fbp</code></strong> (identificador del navegador, duración 90 días) y <strong><code>_fbc</code></strong>{" "}
        (guarda el identificador <code>fbclid</code> del anuncio por el que llegó, duración 90 días), y nuestra propia cookie{" "}
        <strong><code>cv_attr</code></strong> (duración 90 días), que conserva de qué anuncio o campaña vino la visita para
        atribuir el registro.
      </p>
      <p>
        <strong>Al aterrizar le preguntamos.</strong> Con <em>&ldquo;Solo necesarias&rdquo;</em> el Pixel <strong>no se
        carga</strong> y no se instala ninguna de esas cookies. Puede cambiar de opinión cuando quiera desde el mismo aviso, y
        borrar las cookies ya instaladas desde su navegador. Rechazar no limita en nada el uso del Servicio.
      </p>
      <p>
        <strong>Medición desde nuestro servidor (Conversions API).</strong> Además enviamos a Meta, desde nuestros servidores,
        los hitos de nuestro propio embudo comercial (por ejemplo, que se creó una cuenta o que se activó un plan), para medir el
        rendimiento de la publicidad. Cuando esto ocurre, los datos de contacto que se envían van <strong>cifrados con una
        función de hash irreversible</strong> (su correo y su teléfono nunca viajan legibles). Si usted eligió{" "}
        <em>&ldquo;Solo necesarias&rdquo;</em>, este envío igual puede ocurrir —porque no depende de cookies— pero{" "}
        <strong>sin</strong> los identificadores <code>_fbp</code> y <code>_fbc</code>. Estos envíos se refieren a{" "}
        <strong>usted como cliente de {LEGAL.marca}</strong>; nunca enviamos datos de los clientes finales que conversan con su
        asistente. Puede oponerse escribiendo a{" "}
        <a href={`mailto:${LEGAL.emailPrivacidad}`}>{LEGAL.emailPrivacidad}</a>.
      </p>

      <h2>13. Menores</h2>
      <p>El Servicio está dirigido a negocios y no a menores de edad. No recopilamos conscientemente datos de menores.</p>

      <h2>14. Cambios</h2>
      <p>
        Podemos actualizar esta Política. Los cambios relevantes se comunicarán por el Servicio o por correo. La fecha de última
        actualización figura al inicio.
      </p>

      <h2>15. Contacto</h2>
      <p>
        Responsable de datos: {LEGAL.razonSocial}. Consultas y ejercicio de derechos:{" "}
        <a href={`mailto:${LEGAL.emailPrivacidad}`}>{LEGAL.emailPrivacidad}</a>.
      </p>
    </LegalShell>
  );
}
