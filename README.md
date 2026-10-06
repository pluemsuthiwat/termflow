# Termflow

SSH client for macOS aimed at network work (Electron + React + xterm.js + ssh2).

## Run

```sh
npm install
npm run dev      # development, hot reload
npm run build    # production build into out/
```

## Tests

```sh
npm test         # build + Playwright end-to-end suite
```

The suite drives the real Electron app against an in-process fake SSH device
(`tests/helpers.ts`): password / keyboard-interactive / OTP / publickey / agent auth,
legacy-only algorithms (incl. IOS 12.2-style group1-sha1), host-key trust and change, security lockdown, session logs, 6 MB output,
resize, tabs, host CRUD, groups and dashboard, quick connect and the sidebar. Each test uses a fresh
temp data dir. Set `TERMFLOW_EXECUTABLE` to run the same suite against a packaged app.

Serial tests use `@serialport/binding-mock` (`TERMFLOW_SERIAL_MOCK=1`).

Not covered automatically: real network devices, real USB console cables and drivers, the first-time macOS Keychain
prompt, and agents configured only in a shell profile (e.g. 1Password).

## Where data is stored

`~/Library/Application Support/Termflow/` (button "Open data folder" in the app):

| File | Contents |
|---|---|
| `hosts.json` | host list — name, IP, port, user, group, auth method, key path. No secrets. |
| `groups.json` | group paths such as `Site A/Building 1` (so empty groups are kept) |
| `secrets.json` | passwords / key passphrases, encrypted with Electron `safeStorage` (key held in macOS Keychain) |
| `known_hosts.json` | trusted host-key fingerprints (`host:port` → SHA256) |
| `logs/` | plain-text session logs for hosts with "Log session" on (owner-only, may contain device configs) |

Private keys are referenced by path (e.g. `~/.ssh/id_ed25519`), never copied.
Set `TERMFLOW_DATA_DIR` to use a different data directory.

## Features

- Dashboard (⌘0): summary tiles, quick connect, recent hosts, colour-coded group tiles you drill into (breadcrumb), grid or table view of hosts, filter with group path, ⋯ menus for hosts and groups
- Sidebar: one box to search or connect (`user@host:port`, ⌘K), folder tree with right-click / ⋯ menus (connect, edit, duplicate, delete, add subgroup, rename), keyboard navigation, collapse all
- Password, private key, and ssh-agent auth; keyboard-interactive (Cisco/Juniper/TACACS/RADIUS, OTP)
- Password is checked before a tab opens: a wrong one is reported in the dialog (one attempt per click, no AAA lockout), and a rejected saved password can be replaced right there
- Old devices just work, no setting: legacy algorithms (DH group14/gex/group1-sha1, aes-cbc/3des-cbc/blowfish/arcfour, ssh-dss, hmac-sha1-96/md5) are offered after the modern ones, so modern devices still negotiate modern crypto. Hosts that needed them get a `legacy` badge automatically
- Trust-on-first-use host key check, loud warning when a key changes
- Tabs (⌘1–9, ⌘W), keepalive every 15 s, Enter to reconnect
- Session log to file with ANSI codes stripped
- Console (serial): detects USB console cables (callout `/dev/cu.*` devices, built-in Mac ports hidden) and notices when one is plugged in; quick connect at 9600 8N1 or any baud; saved console hosts (baud, data bits, parity, stop bits, flow control) that find the cable again by USB serial number if its path changes; Send Break (⌘B) for ROMMON / password recovery

## Security

- Saved passwords / passphrases are encrypted with `safeStorage` (Keychain); if Keychain encryption is unavailable they are not saved at all, never stored in plain text. The renderer never receives a saved secret, only whether one exists.
- Data folder and logs are owner-only (`0700` folders, `0600` files).
- Electron: `contextIsolation`, `sandbox`, no Node in the page, strict CSP. The window can only show the app's own page (links, dropped files and redirects are blocked), `window.open` only hands `http(s)` links to the browser, and every IPC call is refused unless it comes from the app page's top frame. Web permissions are denied; DevTools are disabled in packaged builds.
- SSH: trust-on-first-use host keys with a loud warning when a key changes. Algorithm negotiation is covered by the key-exchange hash, so offering legacy algorithms last can't be used to downgrade a modern device.
- Session logs are plain text and contain whatever the device printed (e.g. `show run`); treat them like config backups.

## Next

SFTP, port forwarding / jump host, snippets, import from `~/.ssh/config`, packaged `.app`.

## License

[MIT](LICENSE)
