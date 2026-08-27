"""
codeblast Python 提取器 — 方案 B（高置信边 only）。

只产出静态确定的东西：
- 节点: file / class / function / method（test 文件的可调用体记 kind=test）
- 边:   imports（file→file，含 from-import）/ contains / extends（类继承）
        calls —— 仅两类高置信:
          1) 同文件直接名字调用 foo() → 本文件的 def foo
          2) self.method() → 本类或基类（仓内可解析时）的 method
- 盲区: 属性链调用 obj.m()（obj 非 self）、getattr/eval/exec、动态 import、
        星号 import —— 全部显式记录。Python 无函数级零漏报承诺（intent.md 方案 B）。

stdout: JSON {files:[{path, hash, nodes, edges, blind_spots}]}
用法: python3 py_extract.py <repo_root>
"""
import ast
import hashlib
import json
import os
import sys

SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist",
             "build", ".idea", ".vscode", ".pytest_cache", "site-packages", "egg-info"}
TEST_MARKERS = ("test_", "_test.py", "conftest.py")


def is_test_file(rel_path):
    base = os.path.basename(rel_path)
    return base.startswith("test") or base.endswith("_test.py") or "/tests/" in rel_path.replace(os.sep, "/")


def module_to_path(module, level, cur_rel_dir, repo_root, py_files):
    """from .. import / import a.b.c → 仓内文件相对路径（找不到返回 None = 外部包）。"""
    if level > 0:  # 相对导入
        parts = cur_rel_dir.split(os.sep) if cur_rel_dir else []
        if level - 1 > 0:
            parts = parts[: -(level - 1)] if level - 1 <= len(parts) else []
        base = parts + (module.split(".") if module else [])
    else:
        base = module.split(".") if module else []
    if not base:
        return None
    for suffix in (os.path.join(*base) + ".py", os.path.join(*base, "__init__.py")):
        if suffix in py_files:
            return suffix
    return None


class FileExtractor(ast.NodeVisitor):
    def __init__(self, rel_path, repo_root, py_files, source):
        self.rel = rel_path
        self.repo_root = repo_root
        self.py_files = py_files
        self.is_test = is_test_file(rel_path)
        self.nodes = []
        self.edges = []
        self.blind = []
        self.scope = []          # 类/函数名栈
        self.local_defs = {}     # 名字 → 节点 id（本文件顶层 def/class）
        self.class_methods = {}  # 类名 → {方法名 → 节点 id}
        end = len(source.splitlines()) or 1
        self.nodes.append(dict(id=rel_path, kind="file", name=os.path.basename(rel_path),
                               file=rel_path, line=1, end_line=end, exported=0, src_file=rel_path))

    # ---------- 定义 ----------
    def qualname(self, name):
        return self.rel + "#" + ".".join(self.scope + [name]) if self.scope else f"{self.rel}#{name}"

    def visit_ClassDef(self, node):
        cid = self.qualname(node.name)
        self.nodes.append(dict(id=cid, kind="class", name=node.name, file=self.rel,
                               line=node.lineno, end_line=node.end_lineno or node.lineno,
                               exported=int(not node.name.startswith("_")), src_file=self.rel))
        self.edges.append(dict(src=self.rel, dst=cid, kind="contains", file=self.rel,
                               line=node.lineno, confidence="exact", src_file=self.rel))
        if not self.scope:
            self.local_defs[node.name] = cid
        self.class_methods.setdefault(node.name, {})
        for base in node.bases:  # extends 边：仅可解析为本文件顶层类名的
            if isinstance(base, ast.Name) and base.id in self.local_defs:
                self.edges.append(dict(src=cid, dst=self.local_defs[base.id], kind="extends",
                                       file=self.rel, line=node.lineno, confidence="exact", src_file=self.rel))
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def _visit_func(self, node):
        fid = self.qualname(node.name)
        in_class = bool(self.scope) and self.scope[-1] in self.class_methods
        kind = "test" if self.is_test else ("method" if in_class else "function")
        self.nodes.append(dict(id=fid, kind=kind, name=node.name, file=self.rel,
                               line=node.lineno, end_line=node.end_lineno or node.lineno,
                               exported=int(not node.name.startswith("_")), src_file=self.rel))
        self.edges.append(dict(src=self.rel, dst=fid, kind="contains", file=self.rel,
                               line=node.lineno, confidence="exact", src_file=self.rel))
        if not self.scope:
            self.local_defs[node.name] = fid
        elif in_class:
            self.class_methods[self.scope[-1]][node.name] = fid
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    visit_FunctionDef = _visit_func
    visit_AsyncFunctionDef = _visit_func

    # ---------- import ----------
    def visit_Import(self, node):
        for alias in node.names:
            dst = module_to_path(alias.name, 0, os.path.dirname(self.rel), self.repo_root, self.py_files)
            if dst:
                self.edges.append(dict(src=self.rel, dst=dst, kind="imports", file=self.rel,
                                       line=node.lineno, confidence="exact", src_file=self.rel))

    def visit_ImportFrom(self, node):
        if any(a.name == "*" for a in node.names):
            self.blind.append(dict(file=self.rel, line=node.lineno,
                                   reason=f"star import: from {node.module or '.'} import *", src_file=self.rel))
        dst = module_to_path(node.module or "", node.level, os.path.dirname(self.rel), self.repo_root, self.py_files)
        if dst:
            self.edges.append(dict(src=self.rel, dst=dst, kind="imports", file=self.rel,
                                   line=node.lineno, confidence="exact", src_file=self.rel))

    # ---------- 调用 ----------
    def current_caller(self):
        if not self.scope:
            return self.rel
        # 栈顶回溯出完整限定 id
        return f"{self.rel}#{'.'.join(self.scope)}"

    def visit_Call(self, node):
        caller = self.current_caller()
        f = node.func
        if isinstance(f, ast.Name):
            if f.id in ("eval", "exec", "getattr", "__import__"):
                self.blind.append(dict(file=self.rel, line=node.lineno,
                                       reason=f"dynamic call: {f.id}()", src_file=self.rel))
            elif f.id in self.local_defs:  # 高置信 1：本文件顶层名字
                self.edges.append(dict(src=caller, dst=self.local_defs[f.id], kind="calls",
                                       file=self.rel, line=node.lineno, confidence="exact", src_file=self.rel))
            # 其余名字调用（import 进来的/内建）：文件级由 imports 边兜底，不记函数级边也不记盲区
        elif isinstance(f, ast.Attribute):
            if isinstance(f.value, ast.Name) and f.value.id == "self" and len(self.scope) >= 2:
                cls = self.scope[0]
                mid = self.class_methods.get(cls, {}).get(f.attr)
                if mid:  # 高置信 2：self.method → 本类方法
                    self.edges.append(dict(src=caller, dst=mid, kind="calls", file=self.rel,
                                           line=node.lineno, confidence="exact", src_file=self.rel))
                else:  # 基类方法或动态 → 盲区
                    self.blind.append(dict(file=self.rel, line=node.lineno,
                                           reason=f"unresolved self call: self.{f.attr}()", src_file=self.rel))
            else:  # obj.method() —— Python 无类型信息，原理性盲区
                chain = ast.unparse(f)[:80] if hasattr(ast, "unparse") else f.attr
                self.blind.append(dict(file=self.rel, line=node.lineno,
                                       reason=f"attribute call: {chain}()", src_file=self.rel))
        self.generic_visit(node)


def main():
    repo_root = os.path.abspath(sys.argv[1])
    py_files = set()
    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith(".egg-info")]
        for fn in filenames:
            if fn.endswith(".py"):
                py_files.add(os.path.relpath(os.path.join(dirpath, fn), repo_root))

    out = []
    for rel in sorted(py_files):
        abs_path = os.path.join(repo_root, rel)
        try:
            source = open(abs_path, encoding="utf-8", errors="replace").read()
            tree = ast.parse(source)
        except SyntaxError as e:
            out.append(dict(path=rel, hash="", parse_error=str(e), nodes=[], edges=[], blind_spots=[
                dict(file=rel, line=e.lineno or 1, reason=f"syntax error: {e.msg}", src_file=rel)]))
            continue
        ex = FileExtractor(rel, repo_root, py_files, source)
        ex.visit(tree)
        out.append(dict(path=rel, hash=hashlib.sha1(source.encode()).hexdigest(),
                        nodes=ex.nodes, edges=ex.edges, blind_spots=ex.blind))
    json.dump({"files": out}, sys.stdout)


if __name__ == "__main__":
    main()
