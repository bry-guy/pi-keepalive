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

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | undefined;
	const stop = () => {
		const pid = child?.pid;
		if (pid && child?.exitCode === null && child.signalCode === null) {
			try { process.platform === "win32" ? child.kill() : process.kill(-pid); } catch {}
		}
		child = undefined;
	};
	const start = () => {
		const platform = process.platform === "linux" && /microsoft/i.test(release()) ? "wsl" : process.platform;
		const spec = resolve(loadSettings(), process.env, platform);
		if (!spec) return;
		const [cmd, args, stdin = "ignore"] = spec;
		child = spawn(cmd, args, {
			stdio: [stdin, "ignore", "ignore"],
			env: { ...process.env, PI_PID: String(process.pid) },
			detached: process.platform !== "win32", // own process group, so stop() also ends the inhibitor's children
			windowsHide: true,
		});
		child.on("error", () => {}); // tool missing: run without inhibition
		child.unref();
		(child.stdin as { unref?: () => void } | null)?.unref?.();
	};

	pi.on("agent_start", async () => { stop(); start(); });
	pi.on("agent_end", async () => stop());
	pi.on("session_shutdown", async () => stop());
}
