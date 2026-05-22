"use client"

import { useEffect, useState } from "react"

type ThemeMode = "light" | "dark"

const STORAGE_KEY = "fcuno-theme-mode"

function resolveStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark"
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === "light" || stored === "dark") return stored
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>("dark")

  useEffect(() => {
    const next = resolveStoredTheme()
    setTheme(next)
    document.documentElement.dataset.theme = next
  }, [])

  function toggleTheme() {
    const next: ThemeMode = theme === "dark" ? "light" : "dark"
    setTheme(next)
    document.documentElement.dataset.theme = next
    window.localStorage.setItem(STORAGE_KEY, next)
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="fc-theme-toggle"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  )
}
