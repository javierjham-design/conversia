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

      <h2>5. Proveedores (encargados)</h2>
      <p>
        Nos apoyamos en proveedores que tratan datos por nuestra cuenta bajo obligaciones de confidencialidad y seguridad, entre
        ellos: alojamiento e infraestructura en la nube, pasarelas de pago, proveedores de modelos de inteligencia artificial y
        servicio de correo transaccional. Solo acceden a lo necesario para su función.
      </p>

      <h2>6. Inteligencia artificial</h2>
      <p>
        El contenido de las conversaciones puede enviarse a proveedores de IA para generar respuestas. Seleccionamos proveedores
        con compromisos de confidencialidad y, cuando está disponible, de no uso de los datos para entrenar sus modelos. No
        vendemos datos personales.
      </p>

      <h2>7. Transferencias internacionales</h2>
      <p>
        Algunos proveedores pueden alojar o procesar datos fuera de Chile. En esos casos adoptamos resguardos razonables para
        proteger la información conforme a la normativa aplicable.
      </p>

      <h2>8. Conservación</h2>
      <p>
        Conservamos los datos mientras exista la cuenta y por los plazos necesarios para cumplir obligaciones legales, contables
        y de seguridad. Los datos de las conversaciones se conservan según la configuración del Cliente y los plazos de retención
        del Servicio; tras la baja de la cuenta se eliminan o anonimizan en los plazos informados, salvo obligación legal de
        conservarlos.
      </p>

      <h2>9. Seguridad</h2>
      <p>
        Aplicamos medidas técnicas y organizativas razonables: cifrado de credenciales, control de acceso por organización
        (aislamiento multiinquilino), verificación en dos pasos para administradores y registros de auditoría. Ningún sistema es
        100% infalible; ante un incidente relevante actuaremos conforme a la ley.
      </p>

      <h2>10. Sus derechos</h2>
      <p>
        Usted puede ejercer los derechos de acceso, rectificación, cancelación (eliminación) y oposición respecto de sus datos,
        así como solicitar información sobre su tratamiento, escribiendo a{" "}
        <a href={`mailto:${LEGAL.emailPrivacidad}`}>{LEGAL.emailPrivacidad}</a>. Si usted es un cliente final que fue contactado
        por un negocio que usa {LEGAL.marca}, diríjase a ese negocio (responsable de sus datos); también podemos encauzar su
        solicitud hacia él.
      </p>

      <h2>11. Cookies</h2>
      <p>
        Usamos almacenamiento local y cookies estrictamente necesarias para iniciar sesión y mantener su preferencia de tema e
        idioma. No usamos cookies de publicidad de terceros en el panel.
      </p>

      <h2>12. Menores</h2>
      <p>El Servicio está dirigido a negocios y no a menores de edad. No recopilamos conscientemente datos de menores.</p>

      <h2>13. Cambios</h2>
      <p>
        Podemos actualizar esta Política. Los cambios relevantes se comunicarán por el Servicio o por correo. La fecha de última
        actualización figura al inicio.
      </p>

      <h2>14. Contacto</h2>
      <p>
        Responsable de datos: {LEGAL.razonSocial}. Consultas y ejercicio de derechos:{" "}
        <a href={`mailto:${LEGAL.emailPrivacidad}`}>{LEGAL.emailPrivacidad}</a>.
      </p>
    </LegalShell>
  );
}
