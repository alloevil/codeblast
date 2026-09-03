import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Extractor } from "../src/extract";

/** 临时 TS 小工程：接口 + 两个实现、跨文件调用、动态调用、子进程调用、测试文件。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-extract-"));
const typeRoots = path.join(import.meta.dir, "..", "node_modules", "@types");
const LIB = `export interface Greeter { greet(n: string): string }
export class EnGreeter implements Greeter { greet(n: string) { return "hi " + n; } }
export class FrGreeter implements Greeter { greet(n: string) { return "salut " + n; } }
export function helper(x: number): number { return x + 1; }
export interface Encoder { encode(d: unknown): string;
  decode(d: string): unknown }
export type Mode = "a" | "b";
export const jsonEncoder: Encoder = { encode: JSON.stringify, decode: JSON.parse };
const localConst = { x: 1 };
export class Box { static from(v: unknown): Box { return new Box(); } private hide() {} }
export function outer() { const inner = { y: 2 }; const handle = mk(); handle(); const f = () => 1; f(); return inner; }
function mk(): () => void { return () => {}; }
`;
/** 第三方包（node_modules）依赖了本仓 workspace 包 @ws/core：外部包回流边场景。 */
const REENTRY = `import "third-party-lib";
import { helper } from "./lib";
export function useThird() { helper(2); }
`;
const MAIN = `import { helper, type Greeter } from "./lib";
import { execSync } from "node:child_process";
export function run(g: Greeter, obj: Record<string, () => void>, key: string) {
  helper(1);
  g.greet("x");
  obj[key]();
  execSync("true");
}
`;
const TEST = `import { run } from "./main";
export function checkRun() { run(null as any, {}, "k"); }
`;

let ex: Extractor;
let byFile: Map<string, ReturnType<Extractor["extractFile"]>>;

beforeAll(() => {
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["node"], typeRoots: [typeRoots] },
    include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/lib.ts"), LIB);
  fs.writeFileSync(path.join(root, "src/main.ts"), MAIN);
  fs.writeFileSync(path.join(root, "src/main.test.ts"), TEST);
  fs.writeFileSync(path.join(root, "src/reentry.ts"), REENTRY);
  fs.mkdirSync(path.join(root, "packages/core/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages/core/package.json"), JSON.stringify({ name: "@ws/core" }));
  fs.writeFileSync(path.join(root, "packages/core/src/index.ts"), "export const core = 1;\n");
  fs.mkdirSync(path.join(root, "node_modules/third-party-lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/third-party-lib/package.json"), JSON.stringify({ name: "third-party-lib", main: "index.js", dependencies: { "@ws/core": "*", "left-pad": "*" } }));
  fs.writeFileSync(path.join(root, "node_modules/third-party-lib/index.js"), "module.exports = {};\n");
  ex = new Extractor(path.join(root, "tsconfig.json"), root);
  ex.collectImplementers();
  byFile = new Map(ex.sourceFiles().map((sf) => [ex.rel(sf.fileName), ex.extractFile(sf)]));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("extract (integration-lite)", () => {
  test("exact calls edge carries callsite file:line and points at the resolved declaration id", () => {
    const e = byFile.get("src/main.ts")!.edges.find((e) => e.kind === "calls" && e.dst === "src/lib.ts#helper");
    expect(e).toMatchObject({ src: "src/main.ts#run", file: "src/main.ts", line: 4, confidence: "exact" });
  });

  test("interface method call fans out conservatively to every implementer, plus exact edge to the declaration", () => {
    const calls = byFile.get("src/main.ts")!.edges.filter((e) => e.kind === "calls" && e.line === 5);
    const byDst = Object.fromEntries(calls.map((e) => [e.dst, e.confidence]));
    expect(byDst).toEqual({
      "src/lib.ts#Greeter.greet": "exact",
      "src/lib.ts#EnGreeter.greet": "conservative",
      "src/lib.ts#FrGreeter.greet": "conservative",
    });
  });

  test("obj[key]() is recorded as a 'dynamic call' blind spot, never silently dropped", () => {
    const bs = byFile.get("src/main.ts")!.blindSpots.find((b) => b.line === 6);
    expect(bs?.reason).toBe("dynamic call: obj[key]");
  });

  test("child_process.execSync is recorded as a 'subprocess spawn' blind spot (process boundary)", () => {
    const bs = byFile.get("src/main.ts")!.blindSpots.find((b) => b.line === 7);
    expect(bs?.reason).toBe("subprocess spawn: execSync");
  });

  test("imports edge + named binding row (star=0, names enumerated) for `import { helper, type Greeter }`", () => {
    const r = byFile.get("src/main.ts")!;
    expect(r.edges.find((e) => e.kind === "imports" && e.dst === "src/lib.ts")).toMatchObject({ src: "src/main.ts", line: 1 });
    const b = r.bindings.find((b) => b.imported === "src/lib.ts");
    expect(b).toMatchObject({ importer: "src/main.ts", star: 0 });
    expect(b!.names.split(",").sort()).toEqual(["Greeter", "helper"]);
  });

  test("exported callable node records exported=1 and parameter-list signature text", () => {
    const n = byFile.get("src/main.ts")!.nodes.find((n) => n.id === "src/main.ts#run");
    expect(n).toMatchObject({ kind: "function", exported: 1, signature: "g: Greeter, obj: Record<string, () => void>, key: string" });
  });

  test("interface / type alias signature = normalised member text, so field additions surface as signatureChanged", () => {
    const lib = byFile.get("src/lib.ts")!.nodes;
    expect(lib.find((n) => n.id === "src/lib.ts#Encoder")).toMatchObject({ kind: "interface", exported: 1, signature: "encode(d: unknown): string; decode(d: string): unknown" });
    expect(lib.find((n) => n.id === "src/lib.ts#Mode")?.signature).toBe('"a" | "b"');
  });

  test("top-level exported non-function const becomes kind=const with its type annotation; local/non-exported consts do not", () => {
    const lib = byFile.get("src/lib.ts")!.nodes;
    expect(lib.find((n) => n.id === "src/lib.ts#jsonEncoder")).toMatchObject({ kind: "const", exported: 1, signature: "Encoder" });
    expect(lib.find((n) => n.name === "localConst")).toBeUndefined();
    expect(lib.find((n) => n.name === "inner")).toBeUndefined();
  });

  test("method exported bit inherits from the enclosing exported class, except private/protected members", () => {
    const lib = byFile.get("src/lib.ts")!.nodes;
    expect(lib.find((n) => n.id === "src/lib.ts#Box.from")).toMatchObject({ kind: "method", exported: 1, signature: "v: unknown" });
    expect(lib.find((n) => n.id === "src/lib.ts#Box.hide")?.exported).toBe(0);
  });

  test("external package whose package.json depends on a workspace package yields a conservative imports edge back into the workspace entry", () => {
    const r = byFile.get("src/reentry.ts")!;
    const re = r.edges.filter((e) => e.kind === "imports" && e.confidence === "conservative");
    expect(re).toEqual([{ src: "src/reentry.ts", dst: "packages/core/src/index.ts", kind: "imports", file: "src/reentry.ts", line: 1, confidence: "conservative", src_file: "src/reentry.ts" }]);
    // 仓内 import 不受影响,仍是 exact
    expect(r.edges.find((e) => e.kind === "imports" && e.dst === "src/lib.ts")?.confidence).toBe("exact");
  });

  test("calls to closure-local non-function variables emit neither a dangling edge nor a blind spot; local arrow fns still resolve", () => {
    const r = byFile.get("src/lib.ts")!;
    const fromOuter = r.edges.filter((e) => e.kind === "calls" && e.src === "src/lib.ts#outer").map((e) => e.dst).sort();
    expect(fromOuter).toEqual(["src/lib.ts#f", "src/lib.ts#mk"]);
    expect(r.blindSpots.filter((b) => b.line === 11)).toEqual([]); // outer 所在行
  });

  test("implements edges emitted from class heritage clauses", () => {
    const impl = byFile.get("src/lib.ts")!.edges.filter((e) => e.kind === "implements").map((e) => e.src).sort();
    expect(impl).toEqual(["src/lib.ts#EnGreeter", "src/lib.ts#FrGreeter"]);
  });

  test("test file: functions become kind=test and calls into source are mirrored as tests edges", () => {
    const r = byFile.get("src/main.test.ts")!;
    expect(r.nodes.find((n) => n.id === "src/main.test.ts#checkRun")?.kind).toBe("test");
    expect(r.edges.find((e) => e.kind === "tests")).toMatchObject({ src: "src/main.test.ts#checkRun", dst: "src/main.ts#run" });
  });

  test("Extractor.forFiles initialises every instance field the constructor does (Object.create gotcha)", () => {
    const viaCtor = ex; // beforeAll 已建 program
    const viaFor = Extractor.forFiles([path.join(root, "src/main.ts")], path.join(root, "tsconfig.json"), root);
    viaFor.ensureProgram();
    expect(Object.keys(viaFor).sort()).toEqual(Object.keys(viaCtor).sort());
    for (const k of Object.keys(viaCtor)) expect((viaFor as any)[k]).toBeDefined();
    // 且可实际提取（pendingBindings.clear / implementers.get 不会在 undefined 上崩）
    const sf = viaFor.sourceFiles().find((s) => viaFor.rel(s.fileName) === "src/main.ts")!;
    expect(viaFor.extractFile(sf).edges.some((e) => e.dst === "src/lib.ts#helper")).toBe(true);
  });

  test("fileNames() precheck excludes .d.ts, matching the isDeclarationFile filter used at extraction", () => {
    fs.writeFileSync(path.join(root, "src/globals.d.ts"), "declare const G: number;");
    const names = new Extractor(path.join(root, "tsconfig.json"), root).fileNames();
    expect(names.some((f) => f.endsWith(".d.ts"))).toBe(false);
    expect(names.some((f) => f.endsWith("main.ts"))).toBe(true);
  });
});
