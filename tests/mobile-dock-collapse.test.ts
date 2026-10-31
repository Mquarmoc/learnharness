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