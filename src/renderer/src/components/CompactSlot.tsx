import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const CompactSlotContext = createContext<{
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
} | null>(null)

export function CompactSlotProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return <CompactSlotContext.Provider value={{ node, setNode }}>{children}</CompactSlotContext.Provider>
}

export function CompactSlot() {
  const slot = useContext(CompactSlotContext)
  return <div className="compact-footer-extra" ref={slot?.setNode} />
}

export function CompactSlotPortal({ children }: { children: ReactNode }) {
  const node = useContext(CompactSlotContext)?.node
  if (!node) return null
  return createPortal(children, node)
}
