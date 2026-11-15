// Small inline icon set (16px grid, stroke = currentColor).

import { useId } from 'react'

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
  // Two-tone and filled: a lighter back with its tab, a solid front (tilted when open).
  <Svg {...p}>
    <g stroke="none" fill="currentColor">
      <path
        opacity={0.45}
        d="M1.75 4.25c0-.83.67-1.5 1.5-1.5H6.1c.4 0 .78.16 1.06.44L8.2 4.25h4.55c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5Z"
      />
      {open ? (
        <path d="M3.55 7.1c.19-.54.7-.9 1.27-.9h9.38c.62 0 1.06.6.88 1.2l-1.2 4.2c-.18.65-.78 1.1-1.45 1.1H2.6c-.52 0-.88-.51-.71-1Z" />
      ) : (
        <path d="M1.75 7c0-.69.56-1.25 1.25-1.25h10c.69 0 1.25.56 1.25 1.25v4.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5Z" />
      )}
    </g>
  </Svg>
)

export const IconServer = (p: P) => {
  // Two-tone and filled like the folder: a lighter top unit, a solid bottom one,
  // each with a status light and vent slots punched through.
  const id = useId()
  return (
    <Svg {...p}>
      <mask id={id}>
        <rect width="16" height="16" fill="#fff" stroke="none" />
        <g stroke="#000" strokeWidth={1.3}>
          <path d="M4.6 4.85h.01M4.6 11.15h.01" strokeWidth={1.9} />
          <path d="M8 4.85h4M8 11.15h4" />
        </g>
      </mask>
      <g stroke="none" fill="currentColor" mask={`url(#${id})`}>
        <rect opacity={0.5} x="1.75" y="2.1" width="12.5" height="5.5" rx="1.6" />
        <rect x="1.75" y="8.4" width="12.5" height="5.5" rx="1.6" />
      </g>
    </Svg>
  )
}

export const IconChevron = ({ open, ...p }: P & { open?: boolean }) => (
  <Svg {...p}>
    <path d={open ? 'M4.5 6.5 8 10l3.5-3.5' : 'M6.5 4.5 10 8l-3.5 3.5'} />
  </Svg>
)

export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 4.5 6 8l3.5 3.5" />
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

export const IconSplit = (p: P) => (
  <Svg {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M8 2.5v11M10.5 8h2.5" />
  </Svg>
)

export const IconSplitDown = (p: P) => (
  <Svg {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M1.5 8h13" />
  </Svg>
)

export const IconMaximize = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Svg>
)

export const IconLogs = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.5h5.5L13 5v9.5H4z" />
    <path d="M9.5 1.5V5H13M6.5 8h4M6.5 10.5h4M6.5 13h2.5" />
  </Svg>
)

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m3 8.5 3 3 7-7" />
  </Svg>
)

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />
  </Svg>
)

export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M8 10.5V2M4.5 5.5 8 2l3.5 3.5M2.5 13.5h11" />
  </Svg>
)

/** Arrows both ways: files going to and from this Mac (TFTP). */
export const IconTransfer = (p: P) => (
  <Svg {...p}>
    <path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" />
  </Svg>
)

export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 2.5 13.5 5.5 6 13H3v-3l7.5-7.5ZM9 4l3 3" />
  </Svg>
)

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </Svg>
)

export const IconWifi = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 6a9.5 9.5 0 0 1 13 0M3.75 8.5a6.3 6.3 0 0 1 8.5 0M6 11a3 3 0 0 1 4 0M8 13.25h.01" />
  </Svg>
)

/** An Ethernet jack. */
export const IconEthernet = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11v6.5h-2.5v2.5H5V11H2.5Z" />
    <path d="M5.5 7v1.5M8 7v1.5M10.5 7v1.5" />
  </Svg>
)

export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.75 13 3.5v4c0 3.2-2.2 5.6-5 6.75C5.2 13.1 3 10.7 3 7.5v-4Z" />
  </Svg>
)

export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3" />
  </Svg>
)

export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </Svg>
)
