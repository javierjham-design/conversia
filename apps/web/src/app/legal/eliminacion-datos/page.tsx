export const metadata = { title: "Eliminación de datos — TuBot" };

export default function EliminacionDatosPage() {
  return (
    <>
      <h1>Instrucciones de eliminación de datos</h1>
      <p className="text-ink-muted">Última actualización: 27 de julio de 2026</p>

      <p>
        En <strong>TuBot</strong> puedes solicitar la eliminación de los datos personales tratados a través de
        la Plataforma, incluidos los datos recibidos mediante WhatsApp Business.
      </p>

      <h2>Cómo solicitarla</h2>
      <ul>
        <li>
          <strong>Usuarios finales (contactos/pacientes):</strong> la empresa (Tenant) que te contactó es la
          responsable de tus datos. Puedes pedirle la eliminación directamente, o escribirnos a{" "}
          <a href="mailto:privacidad@tubot.cl">privacidad@tubot.cl</a> y coordinaremos con ella.
        </li>
        <li>
          <strong>Empresas cliente (Tenants):</strong> pueden solicitar la eliminación de su cuenta y de los datos
          asociados escribiendo a <a href="mailto:privacidad@tubot.cl">privacidad@tubot.cl</a> desde el
          correo del administrador de la cuenta.
        </li>
      </ul>

      <h2>Qué incluye</h2>
      <p>
        La eliminación abarca los datos de contacto, el historial de conversaciones y los metadatos asociados
        almacenados en la Plataforma, salvo aquello que debamos conservar por obligación legal o para resolver
        disputas y prevenir fraude.
      </p>

      <h2>Plazos</h2>
      <p>
        Confirmamos la recepción de la solicitud dentro de 5 días hábiles y completamos la eliminación en un plazo
        máximo de 30 días, informándote una vez finalizada.
      </p>

      <h2>Datos en terceros</h2>
      <p>
        Cuando corresponda, trasladamos la solicitud a los subencargados que hubieran tratado los datos (por
        ejemplo, la infraestructura de mensajería de Meta), conforme a sus procedimientos.
      </p>

      <h2>Contacto</h2>
      <p>
        <a href="mailto:privacidad@tubot.cl">privacidad@tubot.cl</a>
      </p>
    </>
  );
}
