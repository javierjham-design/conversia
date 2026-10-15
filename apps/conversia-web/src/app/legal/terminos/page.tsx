import type { Metadata } from "next";
import { LEGAL, LegalShell } from "../_config";

export const metadata: Metadata = {
  title: "Términos y Condiciones · Conversia",
  description: "Términos y condiciones de uso del servicio Conversia.",
};

export default function Terminos() {
  return (
    <LegalShell title="Términos y Condiciones">
      <p>
        Estos Términos y Condiciones (los &ldquo;Términos&rdquo;) regulan el acceso y uso de {LEGAL.marca} (el
        &ldquo;Servicio&rdquo;), una plataforma de atención conversacional por WhatsApp y otros canales con asistentes de
        inteligencia artificial, operada por {LEGAL.razonSocial}, RUT {LEGAL.rut}, con domicilio en {LEGAL.domicilio} (en
        adelante, &ldquo;nosotros&rdquo; o el &ldquo;Prestador&rdquo;). Al crear una cuenta o usar el Servicio, usted (el
        &ldquo;Cliente&rdquo;) acepta estos Términos. Si no está de acuerdo, no use el Servicio.
      </p>

      <h2>1. Descripción del Servicio</h2>
      <p>
        {LEGAL.marca} permite configurar asistentes automatizados que atienden conversaciones con sus clientes finales por
        WhatsApp (u otros canales habilitados), agendar, responder consultas y gestionar contactos. El Servicio se presta
        &ldquo;tal cual&rdquo; y se mejora de forma continua; algunas funciones pueden cambiar, agregarse o retirarse.
      </p>

      <h2>2. Cuenta y registro</h2>
      <ul>
        <li>Debe entregar información veraz y mantenerla actualizada. Es responsable de la confidencialidad de sus credenciales y de toda actividad en su cuenta.</li>
        <li>Debe ser mayor de edad y tener facultades para obligar a la empresa o negocio que representa.</li>
        <li>Puede habilitar verificación en dos pasos y gestionar los usuarios de su organización; usted responde por el uso que hagan.</li>
      </ul>

      <h2>3. Prueba gratuita y activación</h2>
      <p>
        El Servicio puede ofrecer una cantidad inicial de conversaciones <strong>gratuitas</strong> para probar, sin requerir
        medio de pago. Agotadas, el asistente puede quedar temporalmente en modo asistido (copiloto) y luego en pausa hasta
        que usted active un plan de pago. <strong>Sus datos no se eliminan por no activar</strong>; se conservan conforme a la
        Política de Privacidad y a los plazos de retención vigentes.
      </p>

      <h2>4. Planes, cobro por conversación y pagos</h2>
      <ul>
        <li>El modelo de cobro principal es <strong>por conversación atendida</strong>: una conversación equivale a la atención del asistente dentro de la ventana de 24 horas definida por el canal de mensajería. El plan incluye una cantidad de conversaciones por período y usted puede adquirir packs o recargas adicionales.</li>
        <li>Los precios se muestran en el Servicio antes de contratar, en pesos chilenos (CLP) o dólares (USD) según corresponda, e incluyen o excluyen impuestos según se indique. Los pagos se procesan mediante proveedores de pago externos.</li>
        <li>Las conversaciones compradas y las incluidas tienen reglas de vigencia y expiración que se informan en el Servicio. El Prestador puede ajustar precios a futuro; los cambios no afectan períodos ya pagados.</li>
        <li>Salvo que la ley obligue a lo contrario, los montos pagados no son reembolsables una vez prestado el Servicio del período.</li>
      </ul>

      <h2>5. Uso aceptable</h2>
      <p>Usted se obliga a no usar el Servicio para:</p>
      <ul>
        <li>Enviar spam, mensajes no solicitados o comunicaciones que infrinjan las políticas de WhatsApp/Meta u otros canales.</li>
        <li>Actividades ilícitas, engañosas, fraudulentas, o que vulneren derechos de terceros o la normativa aplicable.</li>
        <li>Recolectar o tratar datos personales sin base legal, o contactar personas que hayan solicitado no ser contactadas.</li>
        <li>Intentar vulnerar la seguridad del Servicio, revender el acceso sin autorización, o sobrecargar la infraestructura.</li>
      </ul>
      <p>El incumplimiento puede derivar en suspensión o término de la cuenta, sin perjuicio de las acciones legales que correspondan.</p>

      <h2>6. Canales de terceros (WhatsApp / Meta) y proveedores</h2>
      <p>
        El Servicio se integra con plataformas de terceros (por ejemplo, WhatsApp Business Platform de Meta) y con proveedores
        de pago, alojamiento e inteligencia artificial. El uso de esos canales está además sujeto a sus propios términos y
        políticas. El Prestador no responde por cambios, interrupciones o decisiones de dichos terceros.
      </p>

      <h2>7. Inteligencia artificial</h2>
      <p>
        El asistente genera respuestas automáticas que pueden contener errores. Usted es responsable de revisar la
        configuración, supervisar la operación y definir cuándo derivar a una persona. El Servicio incluye salvaguardas (por
        ejemplo, no inventar precios y derivar ante urgencias), pero <strong>no garantiza exactitud</strong> de cada respuesta.
        Las decisiones de su negocio basadas en el asistente son de su exclusiva responsabilidad.
      </p>

      <h2>8. Datos y privacidad</h2>
      <p>
        El tratamiento de datos personales se rige por la <a href="/legal/privacidad">Política de Privacidad</a>. Respecto de
        los datos de sus clientes finales, usted actúa como responsable del tratamiento y el Prestador como encargado que los
        trata por su cuenta y según sus instrucciones y estos Términos.
      </p>

      <h2>9. Propiedad intelectual</h2>
      <p>
        El Servicio, su software, marcas y contenidos son del Prestador o sus licenciantes. Usted conserva la titularidad de
        sus contenidos y datos. Nos otorga una licencia limitada para alojarlos y procesarlos con el único fin de prestarle el
        Servicio.
      </p>

      <h2>10. Disponibilidad y soporte</h2>
      <p>
        Procuramos una alta disponibilidad, pero el Servicio puede tener mantenimientos o interrupciones. No se garantiza
        operación ininterrumpida ni libre de errores. El soporte se presta por los canales informados en el Servicio.
      </p>

      <h2>11. Limitación de responsabilidad</h2>
      <p>
        En la máxima medida permitida por la ley, el Prestador no responde por daños indirectos, lucro cesante, pérdida de
        datos o de oportunidades. La responsabilidad total acumulada del Prestador se limita a los montos efectivamente pagados
        por usted en los 3 meses anteriores al hecho que origina el reclamo. Nada en estos Términos excluye responsabilidades
        que la ley no permita excluir.
      </p>

      <h2>12. Suspensión y término</h2>
      <p>
        Usted puede cancelar cuando quiera desde el Servicio; la cuenta sigue activa hasta el fin del período pagado. El
        Prestador puede suspender o terminar el Servicio ante incumplimiento de estos Términos, impago, o riesgo de seguridad.
        Tras el término, los datos se conservan o eliminan según la Política de Privacidad.
      </p>

      <h2>13. Cambios a los Términos</h2>
      <p>
        Podemos modificar estos Términos. Los cambios relevantes se comunicarán por el Servicio o por correo. El uso posterior
        implica su aceptación. La fecha de última actualización figura al inicio.
      </p>

      <h2>14. Ley aplicable y jurisdicción</h2>
      <p>
        Estos Términos se rigen por las leyes de la República de Chile. Cualquier controversia se someterá a los tribunales
        competentes de {LEGAL.comunaJurisdiccion}, Chile, sin perjuicio de los derechos que la ley reconozca a los
        consumidores.
      </p>

      <h2>15. Contacto</h2>
      <p>
        Dudas sobre estos Términos: <a href={`mailto:${LEGAL.emailContacto}`}>{LEGAL.emailContacto}</a>.
      </p>
    </LegalShell>
  );
}
