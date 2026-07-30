export const metadata = { title: "Política de privacidad — TuBot" };

export default function PrivacidadPage() {
  return (
    <>
      <h1>Política de privacidad</h1>
      <p className="text-slate-500">Última actualización: 27 de julio de 2026</p>

      <p>
        Esta política describe cómo <strong>TuBot</strong> (“la Plataforma”, “nosotros”) trata los datos
        personales al prestar un servicio de atención conversacional multi-tenant que integra WhatsApp Business
        y agentes de inteligencia artificial. TuBot es operada por Servicios Digital-Dent SpA (RUT 77.911.025-7), con
        domicilio en Manuel Montt 820 of. 21, Temuco, Región de La Araucanía (Chile). Para consultas de privacidad: {""}
        <a href="mailto:privacidad@tubot.cl">privacidad@tubot.cl</a>.
      </p>

      <h2>1. Roles</h2>
      <p>
        Cada empresa cliente (“Tenant”) que contrata TuBot es la <strong>responsable</strong> de los datos de
        sus propios contactos y pacientes. TuBot actúa como <strong>encargada del tratamiento</strong> (data
        processor) por cuenta del Tenant, procesando esos datos solo para prestar el servicio conforme a sus
        instrucciones y a esta política.
      </p>

      <h2>2. Datos que tratamos</h2>
      <ul>
        <li>
          <strong>Datos de la cuenta del Tenant:</strong> nombre, correo, organización, rol y credenciales de
          acceso (contraseñas almacenadas con hash, nunca en texto plano).
        </li>
        <li>
          <strong>Mensajes y contactos de WhatsApp:</strong> contenido de los mensajes intercambiados, número de
          teléfono, nombre de perfil y metadatos de entrega, necesarios para prestar la atención conversacional.
        </li>
        <li>
          <strong>Datos operativos:</strong> registros de uso, eventos de auditoría y métricas para seguridad,
          facturación y soporte.
        </li>
      </ul>
      <p>
        No solicitamos datos sensibles de salud a los usuarios finales; los agentes de IA están instruidos para no
        entregar diagnósticos ni indicaciones clínicas.
      </p>

      <h2>3. Finalidades</h2>
      <ul>
        <li>Prestar el servicio de atención por WhatsApp y responder con agentes de IA.</li>
        <li>Enrutar cada conversación al Tenant correspondiente y a su equipo.</li>
        <li>Facturación, soporte, seguridad y prevención de abuso.</li>
      </ul>

      <h2>4. WhatsApp y Meta</h2>
      <p>
        TuBot utiliza la Plataforma de WhatsApp Business (WhatsApp Cloud API) de Meta Platforms, Inc. El envío
        y la recepción de mensajes se realizan a través de la infraestructura de Meta, sujeta a sus propias
        políticas. TuBot recibe los mensajes entrantes mediante webhooks firmados y no comparte el contenido
        con terceros salvo los subencargados indicados abajo.
      </p>

      <h2>5. Subencargados</h2>
      <p>Nos apoyamos en proveedores que tratan datos por cuenta nuestra bajo contrato:</p>
      <ul>
        <li>
          <strong>Meta Platforms</strong> — mensajería de WhatsApp Business.
        </li>
        <li>
          <strong>Anthropic</strong> — modelos de IA que generan las respuestas (se envía el contexto necesario de
          la conversación).
        </li>
        <li>
          <strong>Railway</strong> — alojamiento de la aplicación y la base de datos.
        </li>
      </ul>
      <p>
        Algunos proveedores procesan datos fuera de Chile (por ejemplo, en EE. UU.). Adoptamos salvaguardas
        contractuales para dichas transferencias.
      </p>

      <h2>6. Conservación</h2>
      <p>
        Conservamos los datos mientras el Tenant mantenga su cuenta activa y por el plazo necesario para cumplir
        obligaciones legales. El Tenant puede solicitar la eliminación según se indica en{" "}
        <a href="/legal/eliminacion-datos">Eliminación de datos</a>.
      </p>

      <h2>7. Seguridad</h2>
      <p>
        Aplicamos aislamiento estricto entre Tenants (a nivel de base de datos), cifrado en tránsito, cifrado de
        credenciales sensibles en reposo, control de acceso por roles y registros de auditoría. Ningún método es
        100 % infalible, pero mantenemos controles acordes al riesgo y un proceso de respuesta a incidentes.
      </p>

      <h2>8. Tus derechos</h2>
      <p>
        Conforme a la Ley N° 21.719 de Chile (y, cuando aplique, al RGPD europeo), las personas pueden solicitar
        acceso, rectificación, eliminación y oposición respecto de sus datos. Las solicitudes de usuarios finales
        se canalizan a través del Tenant responsable; también puedes escribirnos a{" "}
        <a href="mailto:privacidad@tubot.cl">privacidad@tubot.cl</a>.
      </p>

      <h2>9. Menores</h2>
      <p>El servicio está dirigido a empresas y no a menores de edad como usuarios directos.</p>

      <h2>10. Cambios</h2>
      <p>
        Podemos actualizar esta política; publicaremos la versión vigente en esta página con su fecha de
        actualización.
      </p>

      <h2>11. Contacto</h2>
      <p>
        Servicios Digital-Dent SpA · RUT 77.911.025-7 · Manuel Montt 820 of. 21, Temuco, Chile ·{" "}
        <a href="mailto:privacidad@tubot.cl">privacidad@tubot.cl</a>
      </p>
    </>
  );
}
