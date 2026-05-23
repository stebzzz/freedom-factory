"use client";

import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="w-[48px] h-[26px]" />;

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="theme-toggle flex items-center"
      aria-label="Toggle theme"
    >
      <Sun
        size={12}
        className="absolute left-[6px] transition-opacity"
        style={{ opacity: theme === "dark" ? 0.3 : 1, color: theme === "dark" ? "var(--text-tertiary)" : "#fff" }}
      />
      <Moon
        size={12}
        className="absolute right-[6px] transition-opacity"
        style={{ opacity: theme === "dark" ? 1 : 0.3, color: theme === "dark" ? "#fff" : "var(--text-tertiary)" }}
      />
    </button>
  );
}
