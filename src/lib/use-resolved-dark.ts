import { useSyncExternalStore } from "react"
import { useTheme } from "@/components/theme-provider"

const query = "(prefers-color-scheme: dark)"

function subscribe(cb: () => void) {
  const mq = window.matchMedia(query)
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}

const getSystemDark = () => window.matchMedia(query).matches

/** Resolves the ThemeProvider theme ("system" included) to a boolean. */
export function useResolvedDark(): boolean {
  const { theme } = useTheme()
  const systemDark = useSyncExternalStore(subscribe, getSystemDark)
  return theme === "dark" || (theme === "system" && systemDark)
}
