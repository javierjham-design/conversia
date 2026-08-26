/**
 * Avatares de los agentes de IA (B2.6): en vez del selector de emoji, una
 * biblioteca de 18 avatares = ícono de rol (una sola familia de línea, lucide) +
 * color de la paleta categórica. Cada agente elige uno para identificarse.
 *
 * Compatibilidad: el id del avatar se guarda en el mismo campo `config.emoji`.
 * Si el valor guardado es un emoji antiguo (no un id conocido), se muestra el
 * emoji en un tile neutro; si está vacío, cae al avatar por defecto (bot).
 */
import {
  Bell,
  Bot,
  Briefcase,
  CalendarDays,
  Coffee,
  Headset,
  Heart,
  Lightbulb,
  MessageCircle,
  Phone,
  Rocket,
  ShoppingBag,
  ShoppingCart,
  Smile,
  Sparkles,
  Stethoscope,
  UserRound,
  Zap,
  type LucideIcon,
} from "lucide-react";

interface AvatarDef {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** variable CSS de la paleta categórica */
  color: string;
}

export const AGENT_AVATARS: AvatarDef[] = [
  { id: "bot", label: "Bot", Icon: Bot, color: "--color-cat-1" },
  { id: "recepcion", label: "Recepción", Icon: Bell, color: "--color-cat-2" },
  { id: "ventas", label: "Ventas", Icon: ShoppingBag, color: "--color-cat-3" },
  { id: "agenda", label: "Agenda", Icon: CalendarDays, color: "--color-cat-6" },
  { id: "soporte", label: "Soporte", Icon: Headset, color: "--color-cat-4" },
  { id: "salud", label: "Salud", Icon: Stethoscope, color: "--color-cat-2" },
  { id: "sonrisa", label: "Sonrisa", Icon: Smile, color: "--color-cat-5" },
  { id: "mensajes", label: "Mensajes", Icon: MessageCircle, color: "--color-cat-1" },
  { id: "ideas", label: "Ideas", Icon: Lightbulb, color: "--color-cat-3" },
  { id: "estrella", label: "Estrella", Icon: Sparkles, color: "--color-cat-8" },
  { id: "carrito", label: "Carrito", Icon: ShoppingCart, color: "--color-cat-7" },
  { id: "telefono", label: "Teléfono", Icon: Phone, color: "--color-cat-6" },
  { id: "persona", label: "Persona", Icon: UserRound, color: "--color-cat-5" },
  { id: "corazon", label: "Corazón", Icon: Heart, color: "--color-cat-4" },
  { id: "cohete", label: "Cohete", Icon: Rocket, color: "--color-cat-8" },
  { id: "maletin", label: "Negocios", Icon: Briefcase, color: "--color-cat-1" },
  { id: "cafe", label: "Café", Icon: Coffee, color: "--color-cat-3" },
  { id: "rayo", label: "Rápido", Icon: Zap, color: "--color-cat-6" },
];

const BY_ID = new Map(AGENT_AVATARS.map((a) => [a.id, a]));

/** ¿El valor guardado es un id de avatar de la biblioteca? */
export function isAvatarId(value: string | null | undefined): boolean {
  return !!value && BY_ID.has(value);
}

const SIZES = { sm: 28, md: 36, lg: 44 } as const;

/**
 * Renderiza el avatar de un agente por su valor guardado (`config.emoji`):
 * id de la biblioteca → ícono en círculo de color; emoji antiguo → emoji en
 * tile neutro; vacío → avatar por defecto (bot).
 */
export function AgentAvatar({
  value,
  size = "md",
  className,
}: {
  value?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  const def = (value && BY_ID.get(value)) || (!value ? BY_ID.get("bot") : null);
  if (def) {
    const { Icon, color } = def;
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full text-white ${className ?? ""}`}
        style={{ width: px, height: px, background: `var(${color})` }}
        aria-hidden
      >
        <Icon size={Math.round(px * 0.52)} strokeWidth={2} />
      </span>
    );
  }
  // Valor antiguo (emoji escrito por el usuario): se conserva en tile neutro.
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-app ${className ?? ""}`}
      style={{ width: px, height: px, fontSize: Math.round(px * 0.5) }}
      aria-hidden
    >
      {value}
    </span>
  );
}

/** Cuadrícula selectora de avatar (reemplaza el selector de emoji del agente). */
export function AgentAvatarPicker({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {AGENT_AVATARS.map((a) => {
        const active = value === a.id;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onChange(a.id)}
            title={a.label}
            aria-label={a.label}
            aria-pressed={active}
            className={`rounded-full p-0.5 transition-shadow ${active ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-panel" : "hover:ring-2 hover:ring-line-strong"}`}
          >
            <AgentAvatar value={a.id} size="md" />
          </button>
        );
      })}
    </div>
  );
}
