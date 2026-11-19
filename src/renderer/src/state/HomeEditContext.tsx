import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * Whether the Home tab is in customize mode. The header owns the button and
 * the dashboard draws the toolbar and card controls, so the flag lives here.
 */
const HomeEditContext = createContext<{
  editing: boolean
  setEditing: (value: boolean | ((current: boolean) => boolean)) => void
}>({ editing: false, setEditing: () => undefined })

export function HomeEditProvider({ children }: { children: ReactNode }) {
  const [editing, setEditing] = useState(false)
  const value = useMemo(() => ({ editing, setEditing }), [editing])
  return <HomeEditContext.Provider value={value}>{children}</HomeEditContext.Provider>
}

export function useHomeEdit() {
  return useContext(HomeEditContext)
}
