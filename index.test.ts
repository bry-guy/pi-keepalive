import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "./index.ts";

const script = (spec: ReturnType<typeof resolve>) => spec?.[1][1] ?? "";

test("auto by default: linux tries every inhibitor, darwin uses caffeinate", () => {
	const linux = script(resolve({}, {}, "linux"));
	for (const tool of ["systemd-inhibit", "elogind-inhibit", "gnome-session-inhibit", "kde-inhibit"]) assert.match(linux, new RegExp(`exec ${tool}`));
	assert.match(script(resolve(undefined, {}, "darwin")), /exec caffeinate -i sh -c "\$hold"/);
});

test("unknown platforms use the linux chain", () => {
	assert.equal(script(resolve({}, {}, "freebsd")), script(resolve({}, {}, "linux")));
});

test("preset runs only that inhibitor; other strings run as a custom command", () => {
	const kde = script(resolve({ "pi-keepalive": "kde-inhibit" }, {}, "linux"));
	assert.match(kde, /kde-inhibit/);
	assert.doesNotMatch(kde, /systemd-inhibit/);
	assert.match(script(resolve({ "pi-keepalive": "my-tool $hold" }, {}, "linux")), /\nmy-tool \$hold$/);
	assert.match(script(resolve({ "pi-keepalive": "constructor" }, {}, "linux")), /\nconstructor$/);
});

test("settings: string applies everywhere, object is per platform", () => {
	assert.equal(resolve({ "pi-keepalive": "off" }, {}, "darwin"), undefined);
	const settings = { "pi-keepalive": { linux: "off" } };
	assert.equal(resolve(settings, {}, "linux"), undefined);
	assert.ok(resolve(settings, {}, "darwin"));
});

test("PI_KEEPALIVE_<PLATFORM> beats PI_KEEPALIVE beats settings", () => {
	const settings = { "pi-keepalive": "off" };
	assert.ok(resolve(settings, { PI_KEEPALIVE: "auto" }, "linux"));
	assert.equal(resolve({}, { PI_KEEPALIVE: "auto", PI_KEEPALIVE_LINUX: "off" }, "linux"), undefined);
	assert.ok(resolve(settings, { PI_KEEPALIVE: "off", PI_KEEPALIVE_DARWIN: "auto" }, "darwin"));
});

test("windows and wsl use PowerShell; wsl ends on stdin close", () => {
	const [cmd, args, stdin] = resolve({}, {}, "win32")!;
	assert.equal(cmd, "powershell");
	assert.match(args[2], /SetThreadExecutionState\(0x80000001\).*Wait-Process -Id \$env:PI_PID/);
	assert.equal(stdin, undefined);
	const wsl = resolve({ "pi-keepalive": { wsl: "powershell" } }, {}, "wsl")!;
	assert.deepEqual([wsl[0], wsl[2]], ["powershell.exe", "pipe"]);
	assert.deepEqual(resolve({}, { PI_KEEPALIVE_WIN32: "custom" }, "win32"), ["powershell", ["-NoProfile", "-Command", "custom"]]);
	assert.equal(resolve({}, { PI_KEEPALIVE_WSL: "x" }, "wsl")![0], "sh");
});

test("a dialog pauses the inhibitor for the rest of the turn; outside a turn it never starts", async () => {
	const { default: keepalive, deps } = await import("./index.ts");
	const handlers = new Map<string, () => Promise<void>>();
	keepalive({ on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler) } as never);
	const saved = process.env.PI_KEEPALIVE;
	process.env.PI_KEEPALIVE = "true"; // any non-off command, so user settings can't disable it
	let starts = 0;
	const realSpawn = deps.spawn;
	// No pid, so stop() has nothing to kill; spawns are counted synchronously instead of via a child process.
	deps.spawn = (() => { starts++; return { exitCode: null, signalCode: null, stdin: null, on() {}, unref() {} }; }) as never;
	const fire = (event: string) => handlers.get(event)!();
	try {
		await fire("agent_start");
		assert.equal(starts, 1);
		await fire("ui_prompt_start");
		await fire("ui_prompt_end");
		assert.equal(starts, 2, "resumed after the answer");
		await fire("agent_end");
		await fire("ui_prompt_start");
		await fire("ui_prompt_end");
		assert.equal(starts, 2, "no turn, no inhibitor");
	} finally {
		await handlers.get("session_shutdown")!();
		deps.spawn = realSpawn;
		if (saved === undefined) delete process.env.PI_KEEPALIVE;
		else process.env.PI_KEEPALIVE = saved;
	}
});
