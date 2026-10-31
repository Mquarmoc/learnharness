import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source=fs.readFileSync(new URL("../components/chat.tsx",import.meta.url),"utf8");
const callback=source.match(/const onScroll = \(\) => \{([\s\S]*?)\n\t\t\};/)?.[1];
assert(callback,"Dock scroll callback missing");
function scroll(mobile:boolean) {
    const changed:boolean[]=[];
    vm.runInNewContext(`(() => {${callback}})()`,{
        mobile, pendingRef:{current:true}, geometryAtRef:{current:0},growthAtRef:{current:0},
        el:{scrollHeight:1000,clientHeight:400,scrollTop:0}, expandedRef:{current:true},
        COLLAPSE_DIST:120,EXPAND_DIST:40,expandIntentRef:{current:false},atBottomRef:{current:false},
        setExpanded:(value:boolean)=>changed.push(value),
    });
    return changed;
}
test("scrolling back on a phone leaves the question panel open",()=>assert.deepEqual(scroll(true),[]));
test("desktop scrolling retains automatic question collapse",()=>assert.deepEqual(scroll(false),[false]));
const anchor = source.match(/function anchorMobileQuestion\(\) \{([\s\S]*?)\n\t\}, \[/)?.[1];
assert(anchor, "Mobile mount/reveal anchor missing");
function mountInline(practice = false) {
 const frames = new Map<number, () => void>();
 const scroller = { scrollTop: 400, getBoundingClientRect: () => ({ top: 200 }) };
 let stopped = 0;
 const cleanup = vm.runInNewContext(`(() => {${anchor}})()`, {
  mobile: true, expanded: true, pendingId: practice ? null : "question",
  practice: practice ? { toolCallId: "practice" } : null,
  initialPendingRef: { current: practice ? null : "question" },
  stopScroll: () => { stopped++; },
  scrollRef: { current: scroller },
  blockRef: { current: { getBoundingClientRect: () => ({ top: 600 }) } },
  requestAnimationFrame: (fn: () => void) => { frames.set(1, fn); return 1; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
 });
 return { frames, scroller, cleanup, stopped };
}
for (const practice of [false, true]) test(`initial long ${practice ? "practice" : "question"} anchors its heading in the transcript`, () => {
 const f = mountInline(practice);
 assert.equal(f.stopped, 1, "bottom-follow must stop before positioning the question");
 assert.equal(f.frames.size, 1, "the initial pending form must not be skipped");
 assert.equal(f.scroller.scrollTop, 400);
 f.frames.get(1)!();
 assert.equal(f.scroller.scrollTop, 800);
 f.cleanup();
});
test("unmount cancels pending mobile positioning", () => {
 const f = mountInline();
 f.cleanup();
 assert.equal(f.frames.size, 0);
 assert.equal(f.scroller.scrollTop, 400);
});
