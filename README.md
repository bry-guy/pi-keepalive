# pi-keepalive

A [pi](https://github.com/earendil-works/pi) extension that keeps your machine from sleeping while the agent is working. It starts an OS sleep inhibitor at `agent_start` and stops it at `agent_end`, so the machine can sleep normally between turns.

| Platform | Default (`auto`) |
|---|---|
| macOS | `caffeinate -i` |
| Linux, BSD | first available of `systemd-inhibit`, `elogind-inhibit`, `gnome-session-inhibit`, `kde-inhibit` |
| Windows | PowerShell `SetThreadExecutionState` |
| WSL | Windows PowerShell on the host (`powershell.exe`), since the host is what sleeps |

If no inhibitor is available, the extension does nothing. It never blocks pi or shows errors. Each inhibitor also exits within a few seconds if pi dies.

## Install

```sh
pi install git:github.com/bry-guy/pi-keepalive
```

## Configuration

Set `pi-keepalive` in `~/.pi/agent/settings.json`, either as one value for every platform or as per-platform values. The platform keys are `darwin`, `linux`, `win32`, `wsl`, or any other `process.platform` value.

```json
{ "pi-keepalive": { "darwin": "auto", "linux": "systemd-inhibit", "wsl": "off" } }
```

Environment variables override settings: `PI_KEEPALIVE_<PLATFORM>` (e.g. `PI_KEEPALIVE_LINUX`) wins over `PI_KEEPALIVE`, which wins over `settings.json`.

| Value | Meaning |
|---|---|
| `auto` | Default. Use the first available inhibitor from the table above. |
| `off` | Disable. |
| A preset | Use only that one: `caffeinate`, `systemd-inhibit`, `elogind-inhibit`, `gnome-session-inhibit`, `kde-inhibit`, or `powershell` (Windows/WSL). |
| Anything else | Custom command, run with `sh -c` (Windows: `powershell -Command`). It must keep running until stopped. On POSIX it runs in its own process group, which is killed when the turn ends. `$hold` is a shell command that blocks until pi exits, and `PI_PID` holds pi's PID. Example: `exec my-inhibitor sh -c "$hold"`. |

## Caveats

- **Linux:** `systemd-inhibit` can be denied by polkit outside a local desktop session (e.g. over SSH). In containers and on headless servers there is usually nothing to inhibit, so the extension does nothing.
- **WSL:** needs Windows interop, with `powershell.exe` on `PATH`.
- **Windows:** PowerShell's Constrained Language Mode (AppLocker/WDAC) blocks `Add-Type`.
- Settings are read at the start of each turn, so changes apply without a restart.

## Test

```sh
npm test
```
