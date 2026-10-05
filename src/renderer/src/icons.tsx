// Small inline icon set (16px grid, stroke = currentColor).

type P = { size?: number; className?: string }

const Svg = ({ size = 16, className, children }: P & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </Svg>
)

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)

export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </Svg>
)

export const IconFolder = ({ open, ...p }: P & { open?: boolean }) => (
  <Svg {...p}>
    {open ? (
      <path d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7M2 12.5 3.8 7.7A1 1 0 0 1 4.7 7H14l-2 5.5H2Z" />
    ) : (
      <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z" />
    )}
  </Svg>
)

export const IconServer = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" strokeWidth={2} />
  </Svg>
)

export const IconChevron = ({ open, ...p }: P & { open?: boolean }) => (
  <Svg {...p}>
    <path d={open ? 'M4.5 6.5 8 10l3.5-3.5' : 'M6.5 4.5 10 8l-3.5 3.5'} />
  </Svg>
)

export const IconMore = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />
  </Svg>
)

export const IconCollapseAll = (p: P) => (
  <Svg {...p}>
    <path d="M5 3l3 3 3-3M5 13l3-3 3 3" />
  </Svg>
)

export const IconExpandAll = (p: P) => (
  <Svg {...p}>
    <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
  </Svg>
)

export const IconBolt = (p: P) => (
  <Svg {...p}>
    <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8l1-5.5Z" />
  </Svg>
)

export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </Svg>
)

export const IconPulse = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />
  </Svg>
)

export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M8 2 14.5 13.5h-13L8 2Z" />
    <path d="M8 6.5v3M8 11.5h.01" />
  </Svg>
)

export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Svg>
)

export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <path d="m3 4.5 3.5 3.5L3 11.5M8.5 11.5H13" />
  </Svg>
)

export const IconPlug = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0V4.5ZM8 11.5v3" />
  </Svg>
)

export const IconSidebar = (p: P) => (
  <Svg {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M6 2.5v11" />
  </Svg>
)

export const IconLogs = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.5h5.5L13 5v9.5H4z" />
    <path d="M9.5 1.5V5H13M6.5 8h4M6.5 10.5h4M6.5 13h2.5" />
  </Svg>
)
