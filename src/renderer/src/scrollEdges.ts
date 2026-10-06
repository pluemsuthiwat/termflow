import { useEffect, useState, type RefObject } from 'react'

export interface ScrollEdges {
  /** More content before the visible part (left / above). */
  start: boolean
  /** More content after the visible part (right / below). */
  end: boolean
}

/** Which sides of a scroll container have hidden content; tracks scrolling, resizing and content changes. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, axis: 'x' | 'y'): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const pos = axis === 'x' ? el.scrollLeft : el.scrollTop
      const view = axis === 'x' ? el.clientWidth : el.clientHeight
      const total = axis === 'x' ? el.scrollWidth : el.scrollHeight
      const start = pos > 1
      const end = pos + view < total - 1
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // Items added, removed or renamed change the content size without resizing the container itself.
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      mo.disconnect()
    }
  }, [ref, axis])

  return edges
}

/** Class names for a `.scroll-fade` container. */
export const fadeClass = (e: ScrollEdges): string => `${e.start ? ' more-start' : ''}${e.end ? ' more-end' : ''}`
