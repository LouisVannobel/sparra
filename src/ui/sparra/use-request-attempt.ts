import { useEffect, useRef } from 'react'

// The current component owns one attempt; replacement and unmount retire it.
export function useRequestAttempt() {
  const generation = useRef(0), controller = useRef<AbortController | null>(null)
  useEffect(() => () => { generation.current++; controller.current?.abort() }, [])
  return () => {
    controller.current?.abort()
    const owned = new AbortController(), id = ++generation.current
    controller.current = owned
    return { signal: owned.signal, live: () => !owned.signal.aborted && generation.current === id }
  }
}
