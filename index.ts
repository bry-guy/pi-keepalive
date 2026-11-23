import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";

export type Spec = [cmd: string, args: string[], stdin?: "pipe"];

// Every inhibitor wraps `$hold`, which polls until pi exits, so a crashed pi never leaves one behind.
const HOLD = `hold='while kill -0 "$PI_PID" 2>/dev/null; do sleep 5; done'\n`;
const sh = (body: string): Spec => ["sh", ["-c", HOLD + body]];
const run = (tool: string, flags: string, guard = "") => `${guard}command -v ${tool} >/dev/null && exec ${tool} ${flags} sh -c "$hold"`;

/** Lines tried in order by `auto`; each `exec`s on success, so the first available tool wins. */
const DARWIN: Record<string, string> = { caffeinate: run("caffeinate", "-i") };
const LINUX: Record<string, string> = {
	"systemd-inhibit": run("systemd-inhibit", `--what=idle:sleep --who=pi --why="Agent running"`, "[ -d /run/systemd/system ] && "),
	"elogind-inhibit": run("elogind-inhibit", `--what=idle:sleep --who=pi --why="Agent running"`),
	"gnome-session-inhibit": run("gnome-session-inhibit", `--inhibit suspend:idle --reason "Agent running"`),
	"kde-inhibit": run("kde-inhibit", "--power --screenSaver"),
};

// Windows sleep is blocked per thread and released when this PowerShell process exits.
const ps = (wait: string) => [
	"-NoProfile", "-Command",
	`Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
		`[W.P]::SetThreadExecutionState(0x80000001) | Out-Null; ${wait}`,
];

/**
 * Picks the inhibitor for a platform key (`process.platform`, or `wsl`).
 * PI_KEEPALIVE_<KEY> beats PI_KEEPALIVE beats settings["pi-keepalive"] (a string, or an object keyed by platform).
 */
export function resolve(settings: unknown, env: Record<string, string | undefined>, platform: string): Spec | undefined {
	const own = (settings as Record<string, unknown> | undefined)?.["pi-keepalive"];
	const fromSettings = typeof own === "string" ? own : (own as Record<string, unknown> | undefined)?.[platform];
	const choice = (env[`PI_KEEPALIVE_${platform.toUpperCase()}`] ?? env.PI_KEEPALIVE ?? (typeof fromSettings === "string" ? fromSettings : "auto")).trim();
	if (choice === "off") return undefined;
	const preset = choice === "auto" || choice === "powershell";
	if (platform === "win32") return ["powershell", preset ? ps("Wait-Process -Id $env:PI_PID") : ["-NoProfile", "-Command", choice]];
	// WSL: the Windows host sleeps, not the VM. PowerShell exits when pi closes its stdin pipe.
	if (platform === "wsl") return preset ? ["powershell.exe", ps("[Console]::In.ReadToEnd() | Out-Null"), "pipe"] : sh(choice);
	const lines = platform === "darwin" ? DARWIN : LINUX;
	return sh(choice === "auto" ? Object.values(lines).join("\n") : Object.hasOwn(lines, choice) ? lines[choice] : choice);
}

function loadSettings(): unknown {
	try {
		return JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json"), "utf8"));
	} catch {
		return {};
	}
}

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** Parses a linger duration (`"30m"`, `"1h"`, `"90s"`, `"1h30m"`, ms number, or `"0"` / `"off"`). Invalid values return 0. */
export function parseDuration(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
	if (typeof value !== "string") return 0;
	const raw = value.trim().toLowerCase();
	if (!raw || raw === "0" || raw === "off" || raw === "false") return 0;
	if (/^\d+$/.test(raw)) return Number(raw);
	let total = 0;
	let consumed = 0;
	for (const match of raw.matchAll(/(\d+)(ms|s|m|h)/g)) {
		if (match.index !== consumed) return 0;
		total += Number(match[1]) * UNITS[match[2]];
		consumed += match[0].length;
	}
	return consumed === raw.length ? total : 0;
}

/** How long (ms) to keep the inhibitor alive after a turn ends or pauses on a dialog. PI_KEEPALIVE_LINGER beats settings. */
export function resolveLingerMs(settings: unknown, env: Record<string, string | undefined>): number {
	if (env.PI_KEEPALIVE_LINGER !== undefined) return parseDuration(env.PI_KEEPALIVE_LINGER);
	const own = (settings as Record<string, unknown> | undefined)?.["pi-keepalive"];
	if (own && typeof own === "object") return parseDuration((own as Record<string, unknown>).linger);
	return 0;
}

/** Swappable so tests can count spawns without racing real processes. */
export const deps = { spawn };

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | undefined;
	let lingerTimer: ReturnType<typeof setTimeout> | undefined;
	const clearLinger = () => {
		if (lingerTimer) {
			clearTimeout(lingerTimer);
			lingerTimer = undefined;
		}
	};
	const stop = () => {
		clearLinger();
		const pid = child?.pid;
		if (pid && child?.exitCode === null && child.signalCode === null) {
			try { process.platform === "win32" ? child.kill() : process.kill(-pid); } catch {}
		}
		child = undefined;
	};
	const start = () => {
		clearLinger();
		const platform = process.platform === "linux" && /microsoft/i.test(release()) ? "wsl" : process.platform;
		const spec = resolve(loadSettings(), process.env, platform);
		if (!spec) return;
		const [cmd, args, stdin = "ignore"] = spec;
		child = deps.spawn(cmd, args, {
			stdio: [stdin, "ignore", "ignore"],
			env: { ...process.env, PI_PID: String(process.pid) },
			detached: process.platform !== "win32", // own process group, so stop() also ends the inhibitor's children
			windowsHide: true,
		});
		child.on("error", () => {}); // tool missing: run without inhibition
		child.unref();
		(child.stdin as { unref?: () => void } | null)?.unref?.();
	};
	const release = () => {
		const lingerMs = resolveLingerMs(loadSettings(), process.env);
		if (lingerMs <= 0) {
			stop();
			return;
		}
		if (!child) return;
		clearLinger();
		lingerTimer = setTimeout(() => {
			lingerTimer = undefined;
			if (!turn || waiting) stop();
		}, lingerMs);
		lingerTimer.unref?.();
	};

	// A turn waiting on a dialog is waiting on you, not working: release (or linger, if configured) until answered.
	let turn = false;
	let waiting = false;
	pi.on("agent_start", async () => { turn = true; waiting = false; clearLinger(); if (!child) start(); });
	pi.on("ui_prompt_start", async () => { waiting = true; release(); });
	pi.on("ui_prompt_end", async () => { waiting = false; clearLinger(); if (turn && !child) start(); });
	pi.on("agent_end", async () => { turn = false; waiting = false; release(); });
	pi.on("session_shutdown", async () => { turn = false; waiting = false; stop(); });
}
