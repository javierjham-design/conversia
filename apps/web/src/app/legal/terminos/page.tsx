export const metadata = { title: "Términos del servicio — TuBot" };

export default function TerminosPage() {
  return (
    <>
      <h1>Términos del servicio</h1>
      <p className="text-slate-500">Última actualización: 27 de julio de 2026</p>

      <p>
        Estos términos regulan el uso de <strong>TuBot</strong> (“la Plataforma”), un servicio de atención
        conversacional multi-tenant con WhatsApp Business y agentes de IA, operado por Servicios Digital-Dent SpA, RUT 77.911.025-7 (Chile). Al
        crear una cuenta o usar el servicio, la empresa cliente (“Tenant”) acepta estos términos.
      </p>

      <h2>1. El servicio</h2>
      <p>
        TuBot permite gestionar conversaciones de WhatsApp, configurar agentes de IA, flujos de trabajo y
        equipos, y conectar integraciones de terceros. Las funcionalidades pueden evolucionar con el tiempo.
      </p>

      <h2>2. Cuentas y acceso</h2>
      <p>
        El Tenant es responsable de la veracidad de sus datos de registro, de la confidencialidad de sus
        credenciales y de la actividad de los usuarios que habilite en su organización.
      </p>

      <h2>3. Uso aceptable</h2>
      <ul>
        <li>Cumplir las políticas de WhatsApp/Meta y la normativa aplicable.</li>
        <li>No enviar spam, contenido ilícito, engañoso ni no solicitado.</li>
        <li>No usar el servicio para vulnerar derechos de terceros ni la privacidad de las personas.</li>
        <li>Obtener el consentimiento necesario de los contactos antes de comunicarse con ellos.</li>
      </ul>
      <p>El incumplimiento puede derivar en la suspensión de la cuenta.</p>

      <h2>4. Agentes de IA</h2>
      <p>
        Las respuestas se generan con modelos de IA a partir de la configuración del Tenant y de las herramientas
        habilitadas. El Tenant es responsable del contenido que configura. Los agentes no entregan diagnósticos ni
        indicaciones clínicas.
      </p>

      <h2>5. Planes y pago</h2>
      <p>
        El uso del servicio está sujeto al plan contratado. TuBot asume ante Meta el costo de las
        conversaciones de WhatsApp y lo factura al Tenant dentro de su plan. Los precios, límites e impuestos
        aplicables se detallan en el panel de facturación.
      </p>

      <h2>6. Datos</h2>
      <p>
        El tratamiento de datos personales se rige por la{" "}
        <a href="/legal/privacidad">Política de privacidad</a>. El Tenant es responsable de los datos de sus
        contactos; TuBot actúa como encargada del tratamiento.
      </p>

      <h2>7. Disponibilidad</h2>
      <p>
        Procuramos alta disponibilidad, pero el servicio se presta “tal cual” y puede tener interrupciones por
        mantenimiento o causas fuera de nuestro control (incluida la infraestructura de terceros como Meta).
      </p>

      <h2>8. Limitación de responsabilidad</h2>
      <p>
        En la máxima medida permitida por la ley, TuBot no responde por daños indirectos o lucro cesante
        derivados del uso del servicio.
      </p>

      <h2>9. Terminación</h2>
      <p>
        Cualquiera de las partes puede terminar la relación conforme al plan contratado. Tras la terminación, los
        datos se tratan según la política de conservación y{" "}
        <a href="/legal/eliminacion-datos">eliminación de datos</a>.
      </p>

      <h2>10. Ley aplicable</h2>
      <p>Estos términos se rigen por las leyes de Chile.</p>

      <h2>11. Contacto</h2>
      <p>
        Servicios Digital-Dent SpA · RUT 77.911.025-7 · Manuel Montt 820 of. 21, Temuco, Chile ·{" "}
        <a href="mailto:soporte@tubot.cl">soporte@tubot.cl</a>
      </p>
    </>
  );
}
