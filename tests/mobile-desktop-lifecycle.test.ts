import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { test } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const source = readFileSync(mainFile, "utf8");
const realRequire = createRequire(mainFile);
function fixture(options: { timers?: boolean; startupFailure?: boolean } = {}) {
    const windows: FakeWindow[] = [];
    class FakeWindow extends EventEmitter {
        visible = false;
        focused = false;
        webContents = { on() {}, setWindowOpenHandler() {} };
        constructor(_options: unknown) { super(); windows.push(this); }
        loadURL() {}
        show() { this.visible = true; }
        hide() { this.visible = false; }
        focus() { this.focused = true; }
        isMinimized() { return false; }
        static getAllWindows() { return windows; }
    }
    const exits: number[] = [];
    const app = Object.assign(new EventEmitter(), {
        setName() {}, requestSingleInstanceLock: () => Boolean(options.startupFailure), quit() {},
        exit: (code: number) => exits.push(code),
        whenReady: () => options.startupFailure ? Promise.reject(new Error("Synthetic startup failure")) : new Promise(() => {}),
        getPath: () => "unused-test-profile",
    });
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill() { child.emit("exit", null, "SIGTERM"); },
    });
    const electron = { app, BrowserWindow: FakeWindow,
        session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } };
    const context = vm.createContext({
        require: (id: string) => {
            if (id === "electron") return electron;
            if (id === "node:child_process") return { spawn: () => child };
            if (id === "node:fs") return { mkdirSync() {}, appendFileSync() {} };
            if (id === "./chatgpt-ipc.cjs") return { attachChatGPTChild: () => ({ dispose() {} }) };
            if (id === "./subscription-ipc.cjs") return { attachSubscriptionChild: () => ({ dispose() {} }) };
            return realRequire(id);
        },
        process: { platform: "win32", resourcesPath: "synthetic-resources", execPath: "synthetic-electron", argv: [], env: { LH_MOBILE_AUTO_START: "1" }, on() {} },
        __dirname: dirname(mainFile), console: { log() {} }, setTimeout: options.timers ? setTimeout : () => {},
    });
    vm.runInContext(source, context, { filename: mainFile });
    return { app, windows, child, exits, context, run: (code: string) => vm.runInContext(code, context) };
}

test("background startup stays hidden and an explicit reopen shows the existing window", () => {
    const f = fixture();
    f.run('createWindow("http://127.0.0.1:9000", true)');
    f.windows[0]!.emit("ready-to-show");
    assert.equal(f.windows[0]!.visible, false);
    f.run("showDesktop()");
    assert.equal(f.windows[0]!.visible, true);
    assert.equal(f.windows[0]!.focused, true);
    assert.equal(f.windows.length, 1);
});

test("closing an enabled desktop hides it; explicit Quit still closes the host", () => {
    const f = fixture();
    f.run('mobileCompanion = { close: async () => {} }; createWindow("http://127.0.0.1:9000"); main()');
    const win = f.windows[0]!;
    win.emit("ready-to-show");
    let prevented = false;
    win.emit("close", { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(win.visible, false);
    f.app.emit("before-quit");
    prevented = false;
    win.emit("close", { preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
});

test("desktop-only closing retains its ordinary behavior", () => {
    const f = fixture();
    f.run('createWindow("http://127.0.0.1:9000")');
    f.windows[0]!.emit("ready-to-show");
    let prevented = false;
    f.windows[0]!.emit("close", { preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
});

test("an unexpected backend exit requests scheduler recovery but intentional shutdown does not", async () => {
    const failed = fixture();
    await failed.run('startServer("9000")');
    failed.child.emit("exit", 1, null);
    assert.deepEqual(failed.exits, [1]);
    const stopped = fixture();
    await stopped.run('startServer("9000")');
    stopped.run("killServer()");
    assert.deepEqual(stopped.exits, []);
});


test("startup probes a cheap asset and accepts an available server", async () => {
    const server = http.createServer((req, res) => {
        assert.equal(req.url, "/favicon.ico");
        res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address() as { port: number };
        const f = fixture({ timers: true });
        assert.equal(await f.run('waitUntilUp("http://127.0.0.1:' + address.port + '", 1000)'), true);
    } finally { server.closeAllConnections(); server.close(); }
});

test("a connected but stalled startup probe has a real deadline", async () => {
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address() as { port: number };
        const f = fixture({ timers: true });
        await assert.rejects(f.run('waitUntilUp("http://127.0.0.1:' + address.port + '", 50)'), /server never answered/);
    } finally { server.closeAllConnections(); server.close(); }
});

test("startup rejection exits with failure instead of leaving a silent resident host", async () => {
    const f = fixture({ startupFailure: true });
    await new Promise(setImmediate);
    assert.deepEqual(f.exits, [1]);
});
