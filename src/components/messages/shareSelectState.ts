import { create } from 'zustand'

type ShareSelectState = {
  sessionId: string | null
  selectedTurnIds: string[]
}

export const useShareSelect = create<ShareSelectState>(() => ({
  sessionId: null,
  selectedTurnIds: [],
}))

export const enterShareSelect = (sessionId: string, initialTurnId: string) => {
  useShareSelect.setState({
    sessionId,
    selectedTurnIds: initialTurnId ? [initialTurnId] : [],
  })
}

export const toggleShareTurn = (turnId: string) => {
  useShareSelect.setState((state) => {
    const exists = state.selectedTurnIds.includes(turnId)
    return {
      selectedTurnIds: exists
        ? state.selectedTurnIds.filter((id) => id !== turnId)
        : [...state.selectedTurnIds, turnId],
    }
  })
}

export const setAllShareTurns = (turnIds: string[]) => {
  useShareSelect.setState({ selectedTurnIds: turnIds })
}

export const exitShareSelect = () => {
  useShareSelect.setState({ sessionId: null, selectedTurnIds: [] })
}
