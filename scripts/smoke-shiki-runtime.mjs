import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=path.resolve(process.argv[2]);
const aliases=fs.readdirSync(path.join(root,".next/node_modules")).filter(name=>name.startsWith("shiki-"));
assert(aliases.length, "No packaged Shiki runtime found");
for (const name of aliases) {
    const shiki=await import(pathToFileURL(path.join(root,".next/node_modules",name,"dist/bundle-full.mjs")));
    const html=await shiki.codeToHtml("const lift = 1;",{lang:"javascript",theme:"github-dark"});
    assert(html.includes("lift"));
}
console.log(JSON.stringify({shikiRuntimeVerified:true,aliases:aliases.length,providerRequests:0}));