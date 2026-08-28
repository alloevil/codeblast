/**
 * L0/L1 提取器 — tsc API。
 *
 * 精度纪律（intent.md）：
 * - 调用边优先用 TypeChecker 精确解析（confidence=exact）。
 * - 接口/抽象方法调用：解析到声明后全连所有已知实现（confidence=conservative）。宁误报不漏报。
 * - 解析失败的调用（any、动态属性访问、eval 类）：写入 blind_spots，绝不静默丢弃。
 */
import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import type { Confidence, EdgeRow, NodeRow, BlindSpotRow } from "./schema";

export interface ExtractResult {
  nodes: NodeRow[];
  edges: EdgeRow[];
  blindSpots: BlindSpotRow[];
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\//;
/** node_modules 未链接时，把 workspace 包名映射注入 compilerOptions.paths，让 checker 可跨包解析。 */
function injectWorkspacePaths(base: ts.CompilerOptions, pkgs: Map<string, string>, rootDir: string): ts.CompilerOptions {
  if (pkgs.size === 0) return base;
  const options: ts.CompilerOptions = { ...base, baseUrl: base.baseUrl ?? rootDir, paths: { ...base.paths } };
  for (const [name, dir] of pkgs) {
    const rel = path.relative(options.baseUrl!, dir) || ".";
    options.paths![name] ??= [`${rel}/src/index.ts`, `${rel}/index.ts`];
    options.paths![`${name}/*`] ??= [`${rel}/src/*`, `${rel}/*`];
  }
  return options;
}
/** 仓库一级/二级目录里的 package.json → name 映射（yarn/pnpm 未链接 workspace 时的解析兜底）。 */
function discoverWorkspacePackages(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const tryAdd = (dir: string) => {
    const pj = path.join(dir, "package.json");
    if (!fs.existsSync(pj)) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (parsed && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string") {
        out.set(parsed.name, dir);
      }
    } catch { /* 坏 package.json 忽略 */ }
  };
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const dir = path.join(repoRoot, entry.name);
    tryAdd(dir);
    for (const sub of ["packages", "apps", "libs"].includes(entry.name) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (sub.isDirectory()) tryAdd(path.join(dir, sub.name));
    }
  }
  return out;
}

export class Extractor {
  private program: ts.Program;
  private checker: ts.TypeChecker;
  private rootDir: string;
  /** workspace 包名 → 包内入口目录（node_modules 未链接时的兜底解析）。 */
  private workspacePkgs = new Map<string, string>();
  /** interface/abstract 声明 id → 实现节点 id 列表（保守全连用），全仓收集。 */
  private implementers = new Map<string, string[]>();

  constructor(tsconfigPath: string, repoRoot?: string) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
    this.rootDir = repoRoot ?? path.dirname(path.resolve(tsconfigPath));
    this.workspacePkgs = discoverWorkspacePackages(this.rootDir);
    const options = injectWorkspacePaths(parsed.options, this.workspacePkgs, this.rootDir);
    this.program = ts.createProgram({ rootNames: parsed.fileNames, options });
    this.checker = this.program.getTypeChecker();
  }
  /** 兜底：给未被任何 tsconfig include 的散落文件（如 tsconfig 外的 test）建 program。 */
  static forFiles(fileNames: string[], baseTsconfigPath: string, repoRoot: string): Extractor {
    const configFile = ts.readConfigFile(baseTsconfigPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, path.dirname(baseTsconfigPath));
    const ex = Object.create(Extractor.prototype) as Extractor;
    ex.rootDir = repoRoot;
    ex.workspacePkgs = discoverWorkspacePackages(repoRoot);
    ex.implementers = new Map();
    ex.program = ts.createProgram({ rootNames: fileNames, options: injectWorkspacePaths(parsed.options, ex.workspacePkgs, repoRoot) });
    ex.checker = ex.program.getTypeChecker();
    return ex;
  }

  sourceFiles(): ts.SourceFile[] {
    return this.program
      .getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("node_modules"));
  }

  rel(fileName: string): string {
    return path.relative(this.rootDir, fileName);
  }

  /** 第一遍：全仓收集 implements/extends 关系，供保守全连查询。 */
  collectImplementers(): void {
    for (const sf of this.sourceFiles()) {
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node) && node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const typeNode of clause.types) {
              let sym = this.checker.getSymbolAtLocation(typeNode.expression);
              if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
              const decl = sym?.declarations?.[0];
              if (!decl) continue;
              const parentId = this.nodeIdOfDecl(decl);
              const classId = this.nodeIdOfDecl(node);
              if (parentId && classId) {
                const list = this.implementers.get(parentId) ?? [];
                list.push(classId);
                this.implementers.set(parentId, list);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  /** 提取单个文件的节点、边、盲区。 */
  extractFile(sf: ts.SourceFile): ExtractResult {
    const relPath = this.rel(sf.fileName);
    const isTest = TEST_FILE_RE.test(relPath);
    const nodes: NodeRow[] = [];
    const edges: EdgeRow[] = [];
    const blindSpots: BlindSpotRow[] = [];

    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const endLineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    // file 节点
    nodes.push({
      id: relPath, kind: "file", name: path.basename(relPath),
      file: relPath, line: 1, end_line: endLineOf(sf),
      exported: 0, signature: "", src_file: relPath,
    });

    // import 边（file → file）
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
        const spec = stmt.moduleSpecifier;
        if (spec && ts.isStringLiteral(spec)) {
          const resolved = this.resolveModule(spec.text, sf.fileName);
          if (resolved) {
            edges.push({
              src: relPath, dst: this.rel(resolved), kind: "imports",
              file: relPath, line: lineOf(stmt), confidence: "exact", src_file: relPath,
            });
          }
        } else if (spec) {
          blindSpots.push({ file: relPath, line: lineOf(stmt), reason: "non-literal module specifier", src_file: relPath });
        }
      }
    }

    // 可调用声明 → 节点；其函数体 → 调用边
    const enclosing: (string | undefined)[] = [];

    const declKindOf = (node: ts.Node): NodeRow["kind"] | undefined => {
      if (ts.isFunctionDeclaration(node)) return isTest ? "test" : "function";
      if (ts.isMethodDeclaration(node)) return "method";
      if (ts.isClassDeclaration(node)) return "class";
      if (ts.isInterfaceDeclaration(node)) return "interface";
      if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return "interface";
      // 顶层 const foo = () => {} / function 表达式
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) return isTest ? "test" : "function";
      return undefined;
    };

    const visit = (node: ts.Node) => {
      const kind = declKindOf(node);
      const id = kind ? this.nodeIdOfDecl(node) : undefined;

      if (kind && id) {
        const name = this.declName(node) ?? "<anonymous>";
        // 参数签名：可调用体的参数列表文本（API 面变化检测;evaluator 终验 3 例盲区）
        let signature = "";
        const fnLike = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
          ? node
          : ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? node.initializer
          : undefined;
        if (fnLike) signature = fnLike.parameters.map((p) => p.getText(sf)).join(", ").slice(0, 200);
        nodes.push({
          id, kind, name, file: relPath,
          line: lineOf(node), end_line: endLineOf(node),
          exported: this.isExported(node) ? 1 : 0, signature, src_file: relPath,
        });
        edges.push({
          src: relPath, dst: id, kind: "contains",
          file: relPath, line: lineOf(node), confidence: "exact", src_file: relPath,
        });
        // implements / extends 边
        if (ts.isClassDeclaration(node) && node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const ek = clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
            for (const t of clause.types) {
              let sym = this.checker.getSymbolAtLocation(t.expression);
              if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
              const decl = sym?.declarations?.[0];
              const dst = decl ? this.nodeIdOfDecl(decl) : undefined;
              if (dst) edges.push({ src: id, dst, kind: ek, file: relPath, line: lineOf(clause), confidence: "exact", src_file: relPath });
            }
          }
        }
      }

      if (kind && id) enclosing.push(id);

      // 调用表达式 → calls 边
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const caller = [...enclosing].reverse().find(Boolean) ?? relPath;
        // 动态 import()：字面量 → imports 边；变量 → 盲区
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            const resolved = this.resolveModule(arg.text, sf.fileName);
            if (resolved) {
              edges.push({
                src: relPath, dst: this.rel(resolved), kind: "imports",
                file: relPath, line: lineOf(node), confidence: "exact", src_file: relPath,
              });
            }
          } else {
            blindSpots.push({ file: relPath, line: lineOf(node), reason: `dynamic import: ${(arg?.getText() ?? "").slice(0, 80)}`, src_file: relPath });
          }
        } else {
          this.resolveCall(node, caller, relPath, lineOf(node), edges, blindSpots);
        }
      }

      ts.forEachChild(node, visit);
      if (kind && id) enclosing.pop();
    };
    visit(sf);

    // test 文件 → 源码的 calls 边，同步产出 tests 边（测试覆盖映射，M1 分级用）
    if (isTest) {
      for (const e of edges) {
        if (e.kind !== "calls") continue;
        const dstFile = e.dst.split("#")[0];
        if (dstFile === e.dst || TEST_FILE_RE.test(dstFile)) continue;
        edges.push({ ...e, kind: "tests" });
      }
    }

    return { nodes, edges, blindSpots };
  }

  /** 调用目标解析：exact → conservative（接口全连）→ blind。 */
  private resolveCall(
    call: ts.CallExpression | ts.NewExpression,
    caller: string, relPath: string, line: number,
    edges: EdgeRow[], blindSpots: BlindSpotRow[],
  ): void {
    const expr = call.expression;
    let sym = this.checker.getSymbolAtLocation(expr);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];

    if (!decl) {
      // 动态：obj[key]()、any 上的调用等
      // 解析完全失败时区分两类：标识符/属性链本身可解析但无声明（多为缺依赖的外部库）
      // vs 结构性动态调用（元素访问、call/apply/bind）。前者噪音，后者才是真盲区信号。
      const structural =
        ts.isElementAccessExpression(expr) ||
        (ts.isPropertyAccessExpression(expr) && ["call", "apply", "bind"].includes(expr.name.text));
      // 测试框架环境注入的全局（vitest/jest）：不指向仓内代码，独立分级，不算源码盲区
      let leftmost: ts.Node = expr;
      while (ts.isPropertyAccessExpression(leftmost) || ts.isCallExpression(leftmost) || ts.isNonNullExpression(leftmost)) {
        leftmost = leftmost.expression;
      }
      const rootName = ts.isIdentifier(leftmost) ? leftmost.text : undefined;
      const TEST_GLOBALS: Record<string, true> = {
        describe: true, it: true, test: true, expect: true, expectTypeOf: true,
        vi: true, jest: true, beforeEach: true, afterEach: true, beforeAll: true, afterAll: true, suite: true,
      };
      const reason = structural
        ? `dynamic call: ${expr.getText().slice(0, 80)}`
        : rootName && TEST_GLOBALS[rootName]
        ? `test-global: ${rootName}`
        : `unresolved call: ${expr.getText().slice(0, 80)}`;
      blindSpots.push({ file: relPath, line, reason, src_file: relPath });
      return;
    }
    const declFile = decl.getSourceFile();
    if (declFile.isDeclarationFile || declFile.fileName.includes("node_modules")) {
      // 外部库调用整体不入图，但子进程 API 是进程边界：可能执行仓内代码，必须记盲区
      const SUBPROCESS_APIS: Record<string, true> = {
        exec: true, execSync: true, execFile: true, execFileSync: true,
        spawn: true, spawnSync: true, fork: true,
      };
      const calleeName = sym?.name ?? "";
      if (SUBPROCESS_APIS[calleeName] && declFile.fileName.includes("child_process")) {
        blindSpots.push({ file: relPath, line, reason: `subprocess spawn: ${calleeName}`, src_file: relPath });
      }
      return;
    }

    const dst = this.nodeIdOfDecl(decl);
    if (!dst) return;

    const push = (target: string, confidence: Confidence) =>
      edges.push({ src: caller, dst: target, kind: "calls", file: relPath, line, confidence, src_file: relPath });

    // 接口方法 / 抽象方法：目标是声明，不是实现 → 保守全连所有实现
    const isAbstractTarget =
      ts.isMethodSignature(decl) ||
      (ts.isMethodDeclaration(decl) && !!(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract)) ||
      ts.isInterfaceDeclaration(decl.parent as ts.Node ?? decl);

    if (isAbstractTarget && ts.isMethodSignature(decl) && ts.isInterfaceDeclaration(decl.parent)) {
      const ifaceId = this.nodeIdOfDecl(decl.parent);
      const impls = ifaceId ? this.implementers.get(ifaceId) ?? [] : [];
      push(dst, "exact"); // 边指向声明本身，保留证据
      const methodName = decl.name.getText();
      for (const implClassId of impls) {
        // 实现方法 id = 类 id + 方法名（同构生成，不需再解析）
        push(`${implClassId}.${methodName}`, "conservative");
      }
      if (impls.length === 0) return;
      return;
    }

    push(dst, "exact");
  }

  private resolveModule(specifier: string, fromFile: string): string | undefined {
    const r = ts.resolveModuleName(specifier, fromFile, this.program.getCompilerOptions(), ts.sys);
    let resolved = r.resolvedModule?.resolvedFileName;
    if (!resolved) {
      // workspace 包名兜底：yarn 未链接时 tsc 解析不到,查包名映射
      const pkgName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      const pkgDir = this.workspacePkgs.get(pkgName);
      if (!pkgDir) return undefined;
      const sub = specifier.slice(pkgName.length).replace(/^\//, "");
      for (const cand of [
        path.join(pkgDir, sub || "index.ts"),
        path.join(pkgDir, sub, "index.ts"),
        path.join(pkgDir, "src", sub || "index.ts"),
        path.join(pkgDir, "src", sub, "index.ts"),
        path.join(pkgDir, sub + ".ts"),
      ]) {
        if (fs.existsSync(cand)) return cand;
      }
      return undefined;
    }
    // pnpm workspace: 包名导入经 node_modules 符号链接指回仓内 → realpath 穿透后再判断
    if (resolved.includes("node_modules")) {
      try {
        resolved = fs.realpathSync(resolved);
      } catch {
        return undefined;
      }
      if (resolved.includes("node_modules")) return undefined; // 真外部包
    }
    return path.relative(this.rootDir, resolved).startsWith("..") ? undefined : resolved;
  }

  /** 稳定节点 id：<relpath>#<qualifiedName>。方法 = <relpath>#<Class>.<method>。 */
  private nodeIdOfDecl(decl: ts.Node): string | undefined {
    const sf = decl.getSourceFile();
    const relPath = this.rel(sf.fileName);
    const name = this.declName(decl);
    if (!name) return undefined;
    if ((ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) && decl.parent && (ts.isClassDeclaration(decl.parent) || ts.isInterfaceDeclaration(decl.parent))) {
      const parentName = this.declName(decl.parent);
      return `${relPath}#${parentName}.${name}`;
    }
    return `${relPath}#${name}`;
  }

  private declName(decl: ts.Node): string | undefined {
    if (
      (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) ||
       ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isVariableDeclaration(decl) ||
       ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl)) &&
      decl.name && (ts.isIdentifier(decl.name) || ts.isStringLiteral(decl.name))
    ) return decl.name.text;
    return undefined;
  }

  private isExported(node: ts.Node): boolean {
    return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  }
}
