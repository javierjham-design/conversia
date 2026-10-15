import type { Metadata } from "next";
import { LEGAL, LegalShell } from "./_config";

export const metadata: Metadata = {
  title: "Legal · Conversia",
  description: "Documentos legales de Conversia.",
};

export default function LegalIndex() {
  return (
    <LegalShell title="Legal">
      <p>Documentos que regulan el uso de {LEGAL.marca}.</p>
      <ul>
        <li><a href="/legal/terminos">Términos y Condiciones</a> — condiciones de uso del servicio, planes y cobro por conversación.</li>
        <li><a href="/legal/privacidad">Política de Privacidad</a> — cómo tratamos los datos personales (Ley N° 19.628).</li>
      </ul>
      <p className="text-dim" style={{ fontSize: 13 }}>
        ¿Dudas? Escríbenos a <a href={`mailto:${LEGAL.emailContacto}`}>{LEGAL.emailContacto}</a>.
      </p>
    </LegalShell>
  );
}
