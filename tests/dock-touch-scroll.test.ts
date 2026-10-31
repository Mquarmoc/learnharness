import { test } from "node:test";
import assert from "node:assert/strict";
import { bindDockTouchScroll } from "../lib/dock-touch-scroll";

function fixture() {
    const handlers = new Map<string, (event: any) => void>();
    const root = { addEventListener: (name: string, fn: any) => handlers.set(name, fn), removeEventListener: (name: string) => handlers.delete(name) };
    const transcript = { scrollTop: 300 };
    const target = { parentElement: root, scrollHeight: 50, clientHeight: 50, scrollTop: 0, closest: () => null };
    const cleanup = bindDockTouchScroll(root as any, transcript as any);
    const event = (y: number, extra = {}) => ({ target, touches: [{ clientY: y, clientX: 10 }], preventDefault() { this.prevented = true; }, prevented: false, ...extra });
    const start = (y = 100) => handlers.get("touchstart")!(event(y));
    const move = (y: number, extra = {}) => { const e = event(y, extra); handlers.get("touchmove")!(e); return e; };
    return { handlers, transcript, target, cleanup, start, move };
}

test("downward swipe on answer panel scrolls to earlier lesson text", () => {
    const f = fixture(); f.start(); const e = f.move(140);
    assert.equal(f.transcript.scrollTop, 260); assert.equal(e.prevented, true);
    f.cleanup(); assert.equal(f.handlers.size, 0);
});
test("nested question scrolling stays native until its edge", () => {
    const f = fixture(); Object.assign(f.target, { scrollHeight: 400, clientHeight: 100, scrollTop: 50 });
    f.start(); assert.equal(f.move(120).prevented, false); assert.equal(f.transcript.scrollTop, 300);
    f.target.scrollTop = 0; assert.equal(f.move(140).prevented, true); assert.equal(f.transcript.scrollTop, 280);
});
test("horizontal slider gestures and multi-touch are not consumed", () => {
    const f = fixture(); f.start(); assert.equal(f.move(101, { touches: [{ clientY: 101, clientX: 80 }] }).prevented, false);
    assert.equal(f.move(120, { touches: [{ clientY: 120 }, { clientY: 100 }] }).prevented, false);
    assert.equal(f.transcript.scrollTop, 300);
});
test("ending a gesture stops forwarding stale movements", () => {
    const f = fixture(); f.start(); f.handlers.get("touchend")!({});
    assert.equal(f.move(150).prevented, false); assert.equal(f.transcript.scrollTop, 300);
});