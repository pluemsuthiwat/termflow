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
npm test         # build + Playwright end-to-end suite (79 cases)
```

The suite drives the real Electron app against an in-process fake SSH device
(`tests/helpers.ts`): password / keyboard-interactive / OTP / publickey / agent auth,
legacy-only algorithms, host-key trust and change, session logs, 6 MB output,
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
| `logs/` | plain-text session logs for hosts with "Log session" on |

Private keys are referenced by path (e.g. `~/.ssh/id_ed25519`), never copied.
Set `TERMFLOW_DATA_DIR` to use a different data directory.

## Features

- Dashboard (⌘0): summary tiles, quick connect, recent hosts, colour-coded group tiles you drill into (breadcrumb), grid or table view of hosts, filter with group path, ⋯ menus for hosts and groups
- Sidebar: one box to search or connect (`user@host:port`, ⌘K), folder tree with right-click / ⋯ menus (connect, edit, duplicate, delete, add subgroup, rename), keyboard navigation, collapse all
- Password, private key, and ssh-agent auth; keyboard-interactive with up to 3 retries (Cisco/Juniper/TACACS/RADIUS, OTP)
- Per-host **Legacy algorithms** toggle: DH group1/group14-sha1, group-exchange-sha1, aes-cbc/3des-cbc, ssh-dss, hmac-sha1-96/md5
- Trust-on-first-use host key check, loud warning when a key changes
- Tabs (⌘1–9, ⌘W), keepalive every 15 s, Enter to reconnect
- Session log to file with ANSI codes stripped
- Console (serial): detects USB console cables (callout `/dev/cu.*` devices, built-in Mac ports hidden) and notices when one is plugged in; quick connect at 9600 8N1 or any baud; saved console hosts (baud, data bits, parity, stop bits, flow control) that find the cable again by USB serial number if its path changes; Send Break (⌘B) for ROMMON / password recovery

## Next

SFTP, port forwarding / jump host, snippets, import from `~/.ssh/config`, packaged `.app`.

## License

[MIT](LICENSE)
