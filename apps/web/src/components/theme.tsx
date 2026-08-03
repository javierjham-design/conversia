"use client";

/** Tema claro/oscuro persistido por usuario (localStorage), con respeto inicial
 *  a prefers-color-scheme. El no-flash lo aplica un script en el layout raíz. */
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "./ui";

type Theme = "light" | "dark";
const KEY = "tubot-theme";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("light");
  useEffect(() => {
    setThemeState(currentTheme());
  }, []);
  const setTheme = (t: Theme) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* modo incógnito sin storage */
    }
    setThemeState(t);
  };
  return [theme, setTheme];
}

/** Botón de cambio de tema (sol/luna) para el header. */
export function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
  const [theme, setTheme] = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      className={cn(
        "flex items-center gap-2 rounded-control px-2.5 py-2 text-navy-300 transition-colors hover:bg-navy-800 hover:text-white",
        collapsed && "justify-center",
      )}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
      {!collapsed && <span className="text-13">{isDark ? "Modo claro" : "Modo oscuro"}</span>}
    </button>
  );
}
