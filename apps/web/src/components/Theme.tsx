import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

export function Theme() {
  const [choice, setChoice] = useState<string | null>(() => {
    try {
      return localStorage.getItem("silo-theme")
    } catch {
      return null
    }
  })
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  )
  const dark = choice === "dark" || (choice !== "light" && systemDark)
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)")
    const update = () => setSystemDark(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light"
  }, [dark])
  return (
    <button
      className='flex items-center gap-2 text-sm font-normal'
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        const value = dark ? "light" : "dark"
        setChoice(value)
        try {
          localStorage.setItem("silo-theme", value)
        } catch {
          /* I keep the preference in memory when browser storage is unavailable. */
        }
      }}
    >
      {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
      <span className='hidden sm:inline'>{dark ? "Light" : "Dark"}</span>
    </button>
  )
}
