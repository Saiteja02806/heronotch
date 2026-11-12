import { useCallback } from 'react'
import { useApp } from '../state/AppContext'

export function useVaultPicker() {
  const { update, showToast, setPage } = useApp()

  const chooseVault = useCallback(async (): Promise<string | null> => {
    try {
      const chosen = await window.notch.obsidian.chooseVault()
      if (!chosen) return null
      update({ settings: { vaultPath: chosen }, notes: { lastPath: null } })
      showToast('Vault connected', chosen.split(/[\\/]/).filter(Boolean).pop() || chosen, 'success')
      setPage('notes')
      return chosen
    } catch (error) {
      showToast(
        'Could not open vault',
        error instanceof Error ? error.message : 'Choose a folder that contains your Obsidian vault.',
        'error'
      )
      return null
    }
  }, [update, showToast, setPage])

  return { chooseVault }
}
