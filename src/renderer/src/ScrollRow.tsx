import { useEffect, useRef, type ReactNode } from 'react'
import { IconBack, IconChevron } from './icons'
import { fadeClass, useScrollEdges } from './scrollEdges'

/**
 * Horizontal strip with no visible scrollbar. Faded edges and arrow buttons show
 * on whichever side has more to see; a vertical mouse wheel scrolls it sideways.
 */
export default function ScrollRow({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const more = useScrollEdges(ref, 'x')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Trackpads already scroll sideways; only translate a plain vertical wheel.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return
      const before = el.scrollLeft
      el.scrollLeft += e.deltaY
      // Let the page scroll once the strip is at its end.
      if (el.scrollLeft !== before) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const page = (dir: 1 | -1) => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <div className="scroll-row">
      <div className={`scroll-fade scroll-fade-x${fadeClass(more)} ${className ?? ''}`} ref={ref}>
        {children}
      </div>
      {more.start && (
        <button className="scroll-arrow left" tabIndex={-1} aria-label="Scroll left" onClick={() => page(-1)}>
          <IconBack size={14} />
        </button>
      )}
      {more.end && (
        <button className="scroll-arrow right" tabIndex={-1} aria-label="Scroll right" onClick={() => page(1)}>
          <IconChevron size={14} />
        </button>
      )}
    </div>
  )
}
