"""BCK Patcher - local patch tool for the WallSpectrum bot. Standard library only.
Keep this file in the same folder as server.js, package.json and public/index.html (the WALLSPECTRUM LIVE Node app).
This file can patch itself too (tick "tool"); close and start the patcher again afterwards to use the new version.
Run: double-click start_patcher.bat (or: python patcher.py).
Self test (no bot files needed): python patcher.py --selftest
Check YOUR bot files against the lite logic: python patcher.py --check

Payload modes (same logic as the extension's patch workspace):
  U user instruction | P patch-format prompt | S source code | L lite (big files are not sent whole)
  - L on + big file + plain instruction  -> INDEX: a list of numbered parts, no code. Paste to the AI.
  - add @part3 / @functionName tags      -> LITE: only those parts (plus small files in full).
  - @auto                                -> LITE: the parts that best match the words of the instruction.
  - L off, or only small files           -> FULL: every selected file in full.
Patch blocks may start with a line  ==== FILE: name ====  to name the file they belong to.

AUTO MODE (the lightning button in the bar, ON by default; the page must be open and focused so it can read the clipboard):
  - copy an AI reply that asks for parts (@part3 / @name) -> the payload with those parts is built and copied by itself.
    The original request is kept and every part asked for so far is added, round after round, until the AI can write the patch.
  - copy an AI reply that holds a patch -> it is applied by itself (all blocks or none, backup first).
  - a failed patch, or a crash on startup after a patch -> an error report with the real code is copied for the AI (3 tries)."""
import os, sys, re, json, time, shutil, threading, subprocess, atexit, collections, webbrowser, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCHER = Path(__file__).resolve().name
FILES = ["server.js", "public/index.html", "package.json", PATCHER]  # repo-relative paths, same layout as the GitHub repo
BOT = "server.js"
RUN_HASH = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()  # the version that is running now
BK = HERE / "backups"
PORT = 8801  # the patcher page (the old FFT patcher uses 8800, so both can run together)
APP_PORT = 3901  # first port tried for the preview of the Node app
BOOT = str(time.time())
SIG = "\u200b\u200b\u200b"
LOCK = threading.RLock()
S = {"proc": None, "port": None, "gen": 0, "reload": 0, "err": "", "log": collections.deque(maxlen=400)}
NODE = shutil.which("node")
NPM = shutil.which("npm")
_SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)
_JS_TYPES = ("", "text/javascript", "application/javascript", "javascript/worker")


def _node_check(code, label, line_off=0):
    """node --check on a piece of JavaScript. Returns '' when fine (or when node is not installed)."""
    if not NODE:
        return ""
    tmp = HERE / ("_chk_%d.js" % os.getpid())
    try:
        tmp.write_bytes(code.encode("utf-8"))
        r = subprocess.run([NODE, "--check", str(tmp)], capture_output=True, text=True, timeout=30, cwd=str(HERE))
    except (subprocess.TimeoutExpired, OSError):
        return ""
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    if r.returncode == 0:
        return ""
    err = (r.stderr or "").strip().split("\n")
    ln = re.search(r":(\d+)\s*$", err[0]) if err else None
    msg = next((l for l in err if "Error" in l), err[-1] if err else "syntax error")
    where = (" line %d" % (int(ln.group(1)) + line_off)) if ln else ""
    return "%s%s: %s" % (label, where, msg.strip())


def syntax_problem(name, text):
    """'' when the file parses, otherwise a one-line reason. Checks server.js, the inline scripts of the page and package.json."""
    if name.endswith(".json"):
        try:
            json.loads(text)
        except ValueError as e:
            return "%s is not valid JSON: %s" % (name, e)
        return ""
    if name.endswith(".js"):
        return _node_check(text, name)
    if name.endswith(".html"):
        for m in _SCRIPT_RE.finditer(text):
            attrs = m.group(1)
            if re.search(r"\bsrc\s*=", attrs, re.I):
                continue
            tm = re.search(r"type\s*=\s*[\"']?([^\"'\s>]+)", attrs, re.I)
            if (tm.group(1).lower() if tm else "") not in _JS_TYPES:
                continue
            bad = _node_check(m.group(2), name + " <script>", text.count("\n", 0, m.start(2)))
            if bad:
                return bad
    return ""


def free_port(start):
    import socket
    for p in range(start, start + 60):
        sk = socket.socket()
        try:
            sk.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            sk.close()
    return start

SUPER = """Reply with ONLY code blocks of Find-and-Replace patches. Inside one code block put the OLD code, then a line with exactly ===SPLIT===, then the NEW code. For several independent changes separate each OLD===SPLIT===NEW pair with a line ===BLOCK=== (all in the same code block).
Rules:
- The files below are one project; each starts with "==== FILE: name ====". OLD must be copied EXACTLY (same indentation and spacing) and must match exactly ONE place. Add a few surrounding lines so it is unique.
- For every patch put a line ==== FILE: name ==== directly before its OLD code (inside the code block). OLD then only has to be unique inside that file. Never put FILE or PART header lines inside the OLD or NEW code itself.
- Large files may be shown only in parts ("=== PART n ..."). Copy OLD only from the code shown and never include PART lines.
- Keep the indentation style of the file (2 spaces in server.js and index.html, never tabs) and keep NEW consistent with the code around it.
- Do not rewrite or reformat code you are not changing. All other behaviour must stay exactly as it is.
- If a name, route or value is shared between server.js (the Node backend: /status, /ticks, ...) and public/index.html, change every place so they stay in sync.
- Never declare the same variable twice in one scope. In JavaScript use var (not const/let) inside any function or block that runs more than once. Make sure no bracket or parenthesis is left unclosed.
- No explanations, warnings or comments about the patch inside the code blocks. If you have a concern, write it in plain text BEFORE the code block.
- ROOT-CAUSE RULE: never patch from a guess. Before any patch, trace the cause end to end: what produces the behaviour, what calls, overrides, saves or restores it, and what runs it at startup. If any link of that chain is not in the code shown, reply with ONLY the @names of the parts you need and NO patch.
- Once the cause is confirmed, give ONE definitive set of blocks (no alternatives, no apply-this-if options), preceded by at most one plain sentence naming the confirmed cause.
- Surgeries you must handle: swap a value, excision (delete cleanly), injection (bolt on a feature), interceptor (add a check inside an existing process), migration (move logic or a button), refactor (faster formula or loop), sweep (rename everywhere it appears), database bump (saved settings must not crash on old data), link shift (APIs, URLs, tokens), sync (if you change a Web Worker, fix the main script too), layer fix (hidden or unclickable UI).
Request:"""


# ───────────────────────── files / patch parsing ─────────────────────────
def load():
    files, crlf = {}, {}
    for n in FILES:
        t = (HERE / n).read_bytes().decode("utf-8")
        crlf[n] = "\r\n" in t
        files[n] = t.replace("\r\n", "\n")
    return files, crlf


FILE_HDR = re.compile(r"^[ \t]*={3,}\s*FILE:\s*(.+?)\s*={3,}[ \t]*\n?", re.I | re.M)
SPLIT_RE = re.compile(r"={3}\s*SPLIT\s*={3}")
BLOCK_RE = re.compile(r"={3}\s*BLOCK[^=\n]*={3}")
FENCE_RE = re.compile(r"^[ \t]*\x60{3}[^\n]*\n(.*?)^[ \t]*\x60{3}[ \t]*$", re.M | re.S)


def parse(text):
    """-> list of (old, new, file_name_or_None, file_hint_or_None).
    file_name = a ==== FILE: x ==== line inside this block. file_hint = the last file named in an earlier block."""
    t = text.replace("\r\n", "\n").replace("\u200b", "")
    fenced = [m.group(1) for m in FENCE_RE.finditer(t) if SPLIT_RE.search(m.group(1))]
    if fenced:
        t = ("\n" + "=" * 3 + "BLOCK" + "=" * 3 + "\n").join(fenced)
    else:
        t = re.sub(r"^```\w*\n?", "", t, flags=re.M)
    t = re.sub(r"//\s*(OLD|NEW)\s*CHUNK\s*", "", t, flags=re.I)
    out, carry = [], None
    for unit in BLOCK_RE.split(t):
        fname = None
        fm = FILE_HDR.search(unit)
        if fm:
            fname = fm.group(1).strip()
            unit = unit[:fm.start()] + unit[fm.end():]
        m = SPLIT_RE.search(unit)
        if not m:
            if fname:
                carry = fname
            continue
        old, new = unit[:m.start()].strip("\n").rstrip(), unit[m.end():].strip("\n").rstrip()
        out.append((old, new, fname, carry))
        if fname:
            carry = fname
    return out


def resolve_name(files, nm):
    if not nm:
        return None
    full = nm.replace("\\", "/").strip().lstrip("./").lower()
    for n in files:
        if n.lower() == full:
            return n
    base = full.split("/")[-1]
    for n in files:
        if n.replace("\\", "/").split("/")[-1].lower() == base:
            return n
    return None


def locate(files, old, only=None):
    pool = {only: files[only]} if only else files
    hits = []
    for n, s in pool.items():
        i = s.find(old)
        while i != -1:
            hits.append((n, i, i + len(old)))
            i = s.find(old, i + 1)
    if hits:
        return hits
    rx = re.compile("[ \t]*\n".join(re.escape(l.rstrip()) for l in old.split("\n")))  # tolerate trailing spaces only
    for n, s in pool.items():
        hits += [(n, m.start(), m.end()) for m in rx.finditer(s)]
    if hits:
        return hits
    want = [l.replace("\u00a0", " ").strip() for l in old.split("\n")]
    k = len(want)
    for n, s in pool.items():
        lines = s.split("\n")
        norm = [l.replace("\u00a0", " ").strip() for l in lines]
        pos, offs = 0, []
        for l in lines:
            offs.append(pos)
            pos += len(l) + 1
        for i in range(len(lines) - k + 1):
            if norm[i] == want[0] and norm[i:i + k] == want:
                hits.append((n, offs[i], offs[i + k - 1] + len(lines[i + k - 1])))
    return hits


def _find_line(pool, w):
    for n, s in pool.items():
        for i, l in enumerate(s.split("\n")):
            if w in l:
                return n, i
    return None


def near_miss(files, old, only=None):
    """Where OLD stops matching, plus the real file text there (the CURRENT CODE part of the error report)."""
    pool = {only: files[only]} if only in files else files
    want = [l.strip() for l in old.split("\n")]
    j0 = next((j for j, w in enumerate(want) if w), 0)
    total = len(want) - j0
    best_run, best_n, best_i = 0, None, 0
    for n, s in pool.items():
        norm = [l.strip() for l in s.split("\n")]
        for i, l in enumerate(norm):
            if l != want[j0]:
                continue
            run = 0
            while run < total and i + run < len(norm) and norm[i + run] == want[j0 + run]:
                run += 1
            if run > best_run:
                best_run, best_n, best_i = run, n, i
    if best_n is None:
        for w in sorted({x for x in want if len(x) >= 15}, key=len, reverse=True)[:6]:
            at = _find_line(pool, w)
            if at:
                lines = pool[at[0]].split("\n")
                return "\nThe start of OLD matches no code, but one of its longer lines exists at %s line %d.\nCURRENT CODE around it:\n%s" % (at[0], at[1] + 1, "\n".join(l[:200] for l in lines[max(0, at[1] - 3):at[1] + 12]))
        return "\nNo line of the OLD block exists in the file. Copy OLD from the code shown."
    lines = pool[best_n].split("\n")
    nxt = lines[best_i + best_run].strip() if best_i + best_run < len(lines) else "(end of file)"
    if best_run >= total:
        head = "All OLD lines match when indentation is ignored, so the difference is inside a line (tabs, spaces or hidden characters)."
    else:
        head = "The first %d of %d OLD lines match; OLD line %d differs.\nOLD line:  %s\nFILE line: %s" % (best_run, total, best_run + 1, want[j0 + best_run][:200], nxt[:200])
    return "\nClosest match: %s line %d. %s\nCURRENT CODE (copy the OLD text from here exactly):\n%s" % (best_n, best_i + 1, head, "\n".join(l[:200] for l in lines[best_i:best_i + min(40, total + 3)]))


def hit_context(files, hits, show=3):
    out = []
    for n, a, b in hits[:show]:
        ln = files[n].count("\n", 0, a) + 1
        before = [x.strip()[:120] for x in files[n].split("\n")[max(0, ln - 4):ln - 1] if x.strip()][-2:]
        out.append("  %s line %d, preceded by: %s" % (n, ln, " | ".join(before) or "(start of file)"))
    return "\n".join(out)


def apply_blocks(files, blocks):
    """Applies every block to the files dict (in memory). Returns the set of changed file names."""
    changed = set()
    for k, (old, new, fname, hint) in enumerate(blocks, 1):
        if not old:
            raise ValueError("Block %d has an empty OLD part." % k)
        only = resolve_name(files, fname)
        hits, where = [], "any file"
        if only:
            hits, where = locate(files, old, only), only
        else:
            h = resolve_name(files, hint)
            if h:
                hits = locate(files, old, h)
            if not hits:
                hits = locate(files, old)
        if not hits:
            raise ValueError("Block %d: OLD text not found in %s:\n\"%s%s\"%s" % (k, where, old[:140], "..." if len(old) > 140 else "", near_miss(files, old, only or resolve_name(files, hint))))
        if len(hits) > 1:
            raise ValueError("Block %d: OLD text matches %d places (%s).\nSend a bigger, more unique chunk (or add a ==== FILE: name ==== line).\n%s" % (k, len(hits), ", ".join(sorted({h[0] for h in hits})), hit_context(files, hits)))
        n, a, b = hits[0]
        seg = files[n][a:b]
        fi = seg[:len(seg) - len(seg.lstrip(" \t"))]
        oi = old[:len(old) - len(old.lstrip(" \t"))]
        if fi != oi:
            if fi.startswith(oi):
                add = fi[len(oi):]
                new = "\n".join((add + l) if l.strip() else l for l in new.split("\n"))
            elif oi.startswith(fi):
                cut = len(oi) - len(fi)
                new = "\n".join(l[cut:] if l[:cut].strip() == "" else l for l in new.split("\n"))
        files[n] = files[n][:a] + new + files[n][b:]
        changed.add(n)
    return changed


def selfcheck(text):
    """New patcher.py must load (top-level code runs, main(), PAGE ... exist) before it replaces the running one."""
    tmp = HERE / ("_chk_" + PATCHER)
    code = ("import runpy,sys;g=runpy.run_path(sys.argv[1],run_name='fft_check');"
            "m=[k for k in ('main','PAGE','apply_patch','load','FILES','H') if k not in g];"
            "sys.exit('missing: '+', '.join(m) if m else 0)")
    try:
        tmp.write_bytes(text.encode("utf-8"))
        r = subprocess.run([sys.executable, "-c", code, str(tmp)], capture_output=True, text=True, timeout=30, cwd=str(HERE))
    except subprocess.TimeoutExpired:
        raise ValueError("%s did not finish loading in 30 s - nothing was changed." % PATCHER)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    if r.returncode != 0:
        raise ValueError("%s fails to load - nothing was changed.\n%s" % (PATCHER, (r.stderr or "").strip()[-600:]))


def stale():
    try:
        return hashlib.sha256((HERE / PATCHER).read_bytes()).hexdigest() != RUN_HASH
    except OSError:
        return False


def apply_patch(text):
    blocks = parse(text)
    if not blocks:
        raise ValueError("No valid patch found in the clipboard.\n\nExpected: [==== FILE: name ====] OLD code, a line ===SPLIT===, NEW code.\nSeveral patches: separate each pair with ===BLOCK===.")
    files, crlf = load()
    before = dict(files)
    changed = apply_blocks(files, blocks)
    for n in changed:
        if n.endswith(".py"):
            try:
                compile(files[n], n, "exec")  # parse only, nothing is executed
            except SyntaxError as e:
                raise ValueError("%s would not parse - nothing was changed.\nLine %s: %s\n%s" % (n, e.lineno, e.msg, (e.text or "").strip()))
        bad = syntax_problem(n, files[n])
        if bad:
            raise ValueError("%s would not parse - nothing was changed.\n%s" % (n, bad))
    if PATCHER in changed:
        selfcheck(files[PATCHER])
    ts = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % int(time.time() % 1 * 1000)
    d = BK / ts
    d.mkdir(parents=True)
    for n in changed:
        (d / n).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(HERE / n, d / n)
        data = files[n].replace("\n", "\r\n") if crlf[n] else files[n]
        tmp = HERE / (n + ".tmp")
        tmp.write_bytes(data.encode("utf-8"))
        os.replace(tmp, HERE / n)
    try:
        session_note(before, files, changed)
    except Exception:
        pass
    return ts, sorted(changed)


def undo_last():
    dirs = sorted(d for d in BK.glob("*") if d.is_dir() and not d.name.startswith("_") and not d.name.endswith("_undone"))
    if not dirs:
        raise ValueError("Nothing to undo.")
    d = dirs[-1]
    names = [f.relative_to(d).as_posix() for f in d.rglob("*") if f.is_file()]
    for n in names:
        tmp = HERE / (n + ".tmp")
        shutil.copy2(d / n, tmp)
        os.replace(tmp, HERE / n)
    d.rename(d.with_name(d.name + "_undone"))
    return names


# ───────────────────────── LITE MODE: big files are sent as parts ─────────────────────────
LITE_MIN_LINES = 400      # a file with this many lines (or LITE_MIN_CHARS characters) is "big"
LITE_MIN_CHARS = 30000
LITE_CHUNK_CHARS = 9000   # a part is also cut when it gets this large (keeps long-line CSS in sane pieces)
LITE_BUDGET = 40000       # max characters of auto-picked parts
LITE_STOP = set("the and for with that this from into make change please then when also should would could just have are was but you your its all any can will get need want".split())
_B_JS = re.compile(r"^\s*(<script\b|<style\b|<!--|/\*\s*[-=]{3,}|(async\s+)?function\s+\w|class\s+\w|(const|let|var)\s+\w+\s*=\s*(async\s*)?(function\b|\([^)]*\)\s*=>))")
_B_PY = re.compile(r"^(async\s+def\s+\w|def\s+\w|class\s+\w|@\w|#\s*[\u2500=\-]{3,})")
_B_CSS = re.compile(r"^/\*\s*[-=]{3,}")
_CLOSE = re.compile(r"</(script|style)>\s*$")
_NAME_RE = re.compile(r'function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\('
                      r'|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)'
                      r'|id="([\w$-]+)"'
                      r'|^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)'
                      r'|^[ \t]*class[ \t]+(\w+)'
                      r'|^([A-Z_][A-Z0-9_]{2,})[ \t]*=', re.M)
_LC = {"key": None, "chunks": []}  # cache: the parts are rebuilt only when file contents change


def _bound_for(name):
    if name.endswith(".py"):
        return _B_PY
    if name.endswith(".css"):
        return _B_CSS
    return _B_JS


def _names(fname, t):
    names = []

    def add(nm):
        if nm and nm not in names and len(names) < 10:
            names.append(nm)

    if fname.endswith(".css"):
        for m in re.finditer(r"#([A-Za-z_][\w-]*)", t):
            if not re.fullmatch(r"[0-9A-Fa-f]{3,8}", m.group(1)):
                add(m.group(1))
    else:
        for m in _NAME_RE.finditer(t):
            add(next((g for g in m.groups() if g), None))
    return names


def lite_build(files):
    """Splits every big file into numbered parts: [{n, file, s, e, t, low, names}]."""
    key = tuple((n, hash(t)) for n, t in files.items())
    if _LC["key"] == key:
        return _LC["chunks"]
    out = []
    for fname, text in files.items():
        L = text.split("\n")
        N = len(L)
        if N < LITE_MIN_LINES and len(text) < LITE_MIN_CHARS:
            continue
        bound, use_close = _bound_for(fname), fname.endswith((".html", ".js"))
        cuts, st, acc = [0], 0, 0
        for i in range(1, N):
            acc += len(L[i - 1]) + 1
            ln = i - st
            edge = bound.match(L[i]) or (use_close and _CLOSE.search(L[i - 1]))
            if (edge and ln >= 40) or ln >= 150 or (acc >= LITE_CHUNK_CHARS and ln >= 8):
                cuts.append(i)
                st, acc = i, 0
        for c, s in enumerate(cuts):
            e = cuts[c + 1] if c + 1 < len(cuts) else N
            t = "\n".join(L[s:e])
            out.append({"n": len(out) + 1, "file": fname, "s": s + 1, "e": e, "t": t, "low": t.lower(), "names": _names(fname, t)})
    _LC["key"], _LC["chunks"] = key, out
    return out


def lite_words(instr):
    s = re.sub(r"@[\w$-]+", " ", instr or "").lower()
    out = []
    for w in re.findall(r"[a-z0-9_$#.\-]{3,}", s):
        w = w.strip(".-")
        if len(w) >= 3 and w not in out and w not in LITE_STOP:
            out.append(w)
    return out


def lite_tags(instr):
    return [x[1:].lower() for x in re.findall(r"@[\w$-]+", instr or "")]


LEGEND = ("LEGEND (end of each part line): <<MATCH>> = words from the request were found in it; "
          "calls = functions defined in OTHER parts of the same file that this part calls, as name(part number); "
          "used by = parts that call something defined here; NOTE = author note left in the code. "
          "Links are heuristic, based on names.\n")
_DEF_RE = re.compile(r"function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\("
                     r"|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)"
                     r"|^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)", re.M)
_CALL_RE = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(")
_AI_NOTE = re.compile(r"(?://|/\*|#|<!--)[ \t]*@ai:[ \t]*([^\n]+?)[ \t]*(?:\*/|-->)?[ \t]*$", re.M)


def lite_links(chunks):
    """Fills c['calls'] (functions of the same file defined in OTHER parts that this part calls) and c['by'] (parts that call something defined here)."""
    if not chunks or "calls" in chunks[0]:
        return chunks
    defs = {}
    for c in chunks:
        c["calls"], c["by"] = [], []
        for m in _DEF_RE.finditer(c["t"]):
            nm = next((g for g in m.groups() if g), None)
            if not nm or len(nm) < 4:
                continue
            d = defs.setdefault((c["file"], nm), {"ns": [], "sig": ""})
            if c["n"] not in d["ns"]:
                d["ns"].append(c["n"])
            if not d["sig"]:
                a = c["t"].rfind("\n", 0, m.start()) + 1
                b = c["t"].find("\n", m.start())
                d["sig"] = c["t"][a:b if b >= 0 else len(c["t"])].strip()[:110]
    for c in chunks:
        seen = set()
        for m in _CALL_RE.finditer(c["t"]):
            nm = m.group(1)
            d = defs.get((c["file"], nm))
            if not d or len(d["ns"]) != 1 or d["ns"][0] == c["n"] or nm in seen:
                continue
            seen.add(nm)
            c["calls"].append({"name": nm, "n": d["ns"][0], "sig": d["sig"]})
            tgt = chunks[d["ns"][0] - 1]
            if c["n"] not in tgt["by"]:
                tgt["by"].append(c["n"])
    for c in chunks:
        c["by"].sort()
    return chunks


def lite_note(c):
    if "ai" not in c:
        c["ai"] = " / ".join(m.group(1).strip()[:110] for m in list(_AI_NOTE.finditer(c["t"]))[:3]) if "@ai:" in c["t"] else ""
    return c["ai"]


def lite_tail(c):
    """The links shown at the end of every part line of the index."""
    s = ""
    if c.get("calls"):
        s += "  | calls: " + ", ".join("%s(%d)" % (x["name"], x["n"]) for x in c["calls"][:5])
    if c.get("by"):
        s += "  | used by: " + ", ".join(str(n) for n in c["by"][:6])
    nt = lite_note(c)
    if nt:
        s += "  | NOTE: " + nt
    return s


def lite_conn(chunks, picked):
    """Connections of the parts that are shown: what they call (with the signature line) and who calls them."""
    lite_links(chunks)
    lines = []
    for c in chunks:
        if c["n"] not in picked:
            continue
        l = []
        if c["calls"]:
            l.append("  calls: " + "\n         ".join("%s (PART %d) %s" % (x["name"], x["n"], x["sig"]) for x in c["calls"][:6]))
        if c["by"]:
            l.append("  used by: PART " + ", PART ".join(str(n) for n in c["by"][:8]))
        nt = lite_note(c)
        if nt:
            l.append("  note: " + nt)
        if l:
            lines.append("PART %d %s:\n%s" % (c["n"], c["file"], "\n".join(l)))
        if len(lines) >= 8:
            break
    if not lines:
        return ""
    return "=== CONNECTIONS OF THE SHOWN PARTS (heuristic, from names; a call shows only the signature line of the callee, ask for its @partN if you need the body) ===\n" + "\n".join(lines)


def lite_index(files, instr):
    """INDEX MODE text: numbered parts with labels, no code."""
    chunks = lite_links(lite_build(files))
    hit_info = {}
    for w in lite_words(instr):
        hit = [c for c in chunks if w in c["low"]]
        if not hit or len(hit) > len(chunks) * 0.25:
            continue
        for c in hit:
            hit_info.setdefault(c["n"], []).append(w)
    lines = []
    for c in chunks:
        label = ", ".join(c["names"][:6])
        if not label:
            first = next((x.strip() for x in c["t"].split("\n") if x.strip()), "")
            label = "(" + first[:60] + ")"
        h = hit_info.get(c["n"])
        lines.append("PART %d %s L%d-%d: %s%s%s" % (c["n"], c["file"], c["s"], c["e"], label, ("  <<MATCH: %s>>" % ", ".join(h[:4])) if h else "", lite_tail(c)))
    big = {c["file"] for c in chunks}
    small = ["%s (%d lines)" % (f, t.count("\n") + 1) for f, t in files.items() if f not in big]
    return ("[INDEX MODE: No code is attached on purpose. The request is the text above. Reply in plain text with ONE line only: the request copied exactly, "
            "followed by @partN tags for every part you must see to write the patch (parts marked MATCH contain words from the request). "
            "Do NOT write any patch and do NOT guess the cause from names alone. Select parts so the full cause chain is visible in the next step: "
            "(1) the code that produces the behaviour in the request, (2) every function, timer, event listener or CSS rule that calls, sets, overrides, saves or restores it, "
            "(3) the boot, init or restore code that runs it at startup. Parts marked MATCH are only hints; follow the calls / used by links. "
            "Mind the token budget: every part you tag is sent in full, so tag the FEWEST parts that show the whole cause chain (normally 3 to 6, never more than 8). Prefer the code that produces the behaviour, its direct callers and its startup code; do not tag a part only because it is marked MATCH. Small files are always attached in full, so tag only PART numbers.]\n\n"
            "=== PARTS (%d total) ===\n%s%s\n\n=== SMALL FILES (attached in full later) ===\n%s" % (len(chunks), LEGEND, "\n".join(lines), "\n".join(small)))


def lite_source(files, instr):
    """LITE MODE text: tagged / best matching parts of big files, small files in full."""
    chunks = lite_build(files)
    tags = lite_tags(instr)
    forced = [c["n"] for c in chunks
              if ("part%d" % c["n"]) in tags or ("p%d" % c["n"]) in tags or any(x.lower() in tags for x in c["names"])]
    scores = {}
    for w in lite_words(instr):
        hit = [c for c in chunks if w in c["low"]]
        if not hit or len(hit) > len(chunks) * 0.25:
            continue
        for c in hit:
            scores[c["n"]] = scores.get(c["n"], 0) + min(c["low"].count(w), 5) / len(hit)
    rank = []
    if not forced:
        used = 0
        for c in sorted((c for c in chunks if scores.get(c["n"], 0) > 0), key=lambda c: -scores[c["n"]]):
            if used + len(c["t"]) > LITE_BUDGET:
                continue
            used += len(c["t"])
            rank.append(c["n"])
        rank = rank[:8]
    sel = forced + rank
    picked = set(sel)
    out = ["[LITE MODE: some files are large, so only the relevant parts of them are shown below (small files are shown in full). "
           "STRICT RULES: (1) Trace the cause of the request through the shown parts before writing anything: what produces the behaviour, what calls, overrides, saves or restores it, and what runs it at startup. "
           "(2) If any link of that chain is missing or you are guessing, reply in plain text with ONLY the @names you need and NO patch, not even a partial or probable one. Every part you ask for costs tokens, so ask only for the fewest parts that close the gap (usually 1 to 4). "
           "(3) Only when the cause is confirmed from the shown code, give ONE definitive set of patch blocks, with one plain sentence before them naming the confirmed cause. "
           "Never give alternatives, optional patches, or a patch together with a request for more parts. Patch format: "
           "Reply with ==== FILE: name ==== headers and OLD===SPLIT===NEW blocks whose OLD text is copied exactly from the parts shown and is unique in that whole file "
           "(include a few surrounding lines). If you need a part that is not shown, reply in plain text with only its name from the list, like @functionName.]"]
    if not sel:
        out.append("(No part of the large files matched the instruction. Name one with @name.)")
    for fname, text in files.items():
        mine = [c for c in chunks if c["file"] == fname]
        if not mine:
            out.append("==== FILE: %s ====\n%s" % (fname, text.strip()))
            continue
        shown = [c for c in mine if c["n"] in picked]
        if not shown:
            continue
        out.append("==== FILE: %s (partial: only the parts below are shown) ====\n%s" % (
            fname, "\n\n".join("=== PART %d (lines %d-%d) ===\n%s" % (c["n"], c["s"], c["e"], c["t"]) for c in shown)))
    conn = lite_conn(chunks, picked)
    if conn:
        out.append(conn)
    rest = ["%d %s L%d-%d: %s" % (c["n"], c["file"], c["s"], c["e"], ", ".join(c["names"][:3]))
            for c in chunks if c["n"] not in picked and c["names"]][:300]
    out.append("=== OTHER PARTS (names only) ===\n" + "\n".join(rest))
    return "\n\n".join(out)


def lite_auto_tags(files, instr, clip):
    """@tags found in the clipboard (the AI's reply to the index) that name real parts are added to the instruction."""
    if not clip or len(clip) > 4000 or any(k in clip for k in ("LITE MODE", "INDEX MODE", "==SPLIT")):
        return instr, 0
    found = re.findall(r"@[\w$-]+", clip)
    if not found:
        return instr, 0
    known = set()
    for c in lite_build(files):
        known.add("part%d" % c["n"])
        known.add("p%d" % c["n"])
        known.update(x.lower() for x in c["names"])
    have, add = set(lite_tags(instr)), []
    for t in found:
        k = t[1:].lower()
        if k in known and k not in have and k not in [a[1:].lower() for a in add]:
            add.append(t)
    if not add:
        return instr, 0
    return (instr.strip() + " " + " ".join(add)).strip(), len(add)


def build_payload_from(files, instr, user=True, sup=True, src=True, lite=True, clip=""):
    instr = (instr or "").strip()
    added = 0
    if lite and src and clip:
        instr, added = lite_auto_tags(files, instr, clip)
    tags = lite_tags(instr)
    auto = "auto" in tags
    has_tags = any(t != "auto" for t in tags)
    big = bool(src and lite and lite_build(files))
    idx = bool(big and user and instr and not has_tags and not auto)
    parts = []
    if sup and not idx:
        parts.append(SUPER)
        if user and instr:
            parts.append(instr)
    elif user and instr:
        parts.append("User Instruction: " + instr)
    if src:
        if idx:
            parts.append(lite_index(files, instr))
        elif big:
            parts.append(lite_source(files, instr))
        else:
            parts.append("\n\n".join("==== FILE: %s ====\n%s" % (n, t) for n, t in files.items()))
        parts.extend(ai_extra(files))
    if not parts:
        raise ValueError("Nothing to copy - turn on at least one of U / P / S.")
    text = "\n\n".join(p for p in parts if p) + SIG
    after = re.sub(r"\s*@[\w$-]+", "", instr).strip() if (has_tags or auto) else instr
    return {"text": text, "chars": len(text), "mode": "index" if idx else ("lite" if big else "full"), "instr": after, "added": added,
            "tags": [t for t in re.findall(r"@[\w$-]+", instr) if t.lower() != "@auto"]}


def build_payload(instr, names, user=True, sup=True, src=True, lite=True, clip=""):
    allf, _ = load()
    files = {n: allf[n] for n in FILES if n in (names or [])}
    if src and not files:
        raise ValueError("No files selected - tick at least one file letter.")
    return build_payload_from(files, instr, bool(user), bool(sup), bool(src), bool(lite), str(clip or ""))


# ───────────────────────── AUTO MODE: clipboard watcher support ─────────────────────────
SESSION = {"log": []}  # one line per applied patch since the patcher was started (goes into the next payload)
AUTO_SKIP = ("LITE MODE", "INDEX MODE", "RUNTIME ERROR")
_NOTES_RE = re.compile(r"<!--[ \t]*AI-NOTES([\s\S]*?)-->|/\*[ \t]*AI-NOTES([\s\S]*?)\*/")


def ai_extra(files):
    """Extra blocks added after the code: notes the author wrote inside the files, and what was patched in this session."""
    out = []
    for n, t in files.items():
        m = _NOTES_RE.search(t)
        txt = ((m.group(1) or m.group(2) or "") if m else "").strip()
        if txt:
            out.append("=== AI-NOTES (written by the author inside %s, treat as true) ===\n%s" % (n, txt))
    if SESSION["log"]:
        out.append("=== SESSION CHANGES (patches applied by this tool since it was started; part numbers refer to the files as they are now) ===\n" + "\n".join(SESSION["log"]))
    return out


def session_note(before, after, changed):
    """One line per changed file after a patch: first changed line, the part it falls in, size change."""
    stamp = time.strftime("%H:%M")
    for n in sorted(changed):
        A, B = before[n].split("\n"), after[n].split("\n")
        i = 0
        while i < len(A) and i < len(B) and A[i] == B[i]:
            i += 1
        part = next((c["n"] for c in lite_build(after) if c["file"] == n and c["s"] <= i + 1 <= c["e"]), 0)
        first = B[i].strip() if i < len(B) else "(code removed)"
        SESSION["log"].append("%s %s L%d%s (%+d lines): %s" % (stamp, n, i + 1, (" @part%d" % part) if part else "", len(B) - len(A), first[:70]))
    del SESSION["log"][:-8]


def error_report(msg, runtime=False):
    """Text for the AI after a failed patch (or a crash after a patch). The AI answers with a corrected patch, auto mode applies it."""
    fmt = "OLD" + "=" * 3 + "SPLIT" + "=" * 3 + "NEW"
    if runtime:
        head = ("RUNTIME ERROR after your last patch: the patch was applied, but the new version crashed on startup, so the previous version was restored "
                "(the files are as they were before that patch, the code you were shown is still valid).\n\n%s\n\n" % str(msg).strip())
        tail = ("Find the cause and resend a corrected patch in the same combined format (%s inside one code block). "
                "Code blocks only, plus at most one plain sentence before them naming the confirmed cause. "
                "If you need more code first, reply with ONLY the @names of the parts you need." % fmt)
    else:
        head = ("PATCH ERROR - your last patch was NOT applied (all blocks are applied together or not at all, so nothing in the files changed).\n\n"
                "Error: %s\n\n" % str(msg).strip())
        tail = ("Fix it and resend the WHOLE patch (every block) in the same combined format (%s inside one code block), with the failing block corrected. "
                "Code blocks only, plus at most one plain sentence before them naming the confirmed cause. "
                "If you cannot see the code you need, reply with ONLY the @names of the parts you need." % fmt)
    return head + tail


def auto_step(files, clip, req="", tags=None, user=True, sup=True, src=True, lite=True):
    """One step of AUTO MODE. clip = what is in the clipboard now; req / tags = the running conversation (the original request and every
    @tag already sent). Returns {"kind": "ignore" | "patch" | "payload", ...}. A reply that asks for parts builds the payload again with
    the same request and ALL parts asked so far, until the AI answers with a patch."""
    t = clip or ""
    if not t.strip() or SIG in t or re.match(r"\s*(PATCH|RUNTIME) ERROR", t) or any(k in t for k in AUTO_SKIP):
        return {"kind": "ignore", "mode": "ignore"}
    if SPLIT_RE.search(t):
        return {"kind": "patch", "mode": "patch"}
    if len(t) > 4000:
        return {"kind": "ignore", "mode": "ignore"}
    known = set()
    for c in lite_build(files):
        known.add("part%d" % c["n"])
        known.add("p%d" % c["n"])
        known.update(x.lower() for x in c["names"])
    found = []
    for x in re.findall(r"@[\w$-]+", t):
        if x[1:].lower() in known and x.lower() not in [f.lower() for f in found]:
            found.append(x)
    if not found:
        return {"kind": "ignore", "mode": "ignore"}
    req = (req or "").strip() or re.sub(r"\s+", " ", re.sub(r"@[\w$-]+", " ", t)).strip()
    have = list(tags or [])
    new = [x for x in found if x.lower() not in [h.lower() for h in have]]
    allt = have + new
    r = build_payload_from(files, (req + " " + " ".join(allt)).strip(), user, sup, src, lite)
    r.update({"kind": "payload", "req": req, "tags": allt, "new": new})
    return r


def auto_clip(d):
    allf, _ = load()
    files = {n: allf[n] for n in FILES if n in (d.get("files") or [])}
    return auto_step(files, str(d.get("clip") or ""), str(d.get("req") or ""), [str(x) for x in (d.get("tags") or [])],
                     bool(d.get("user", True)), bool(d.get("sup", True)), bool(d.get("src", True)), bool(d.get("lite", True)))


# ───────────────────────── bot process ─────────────────────────
def pump(p):
    for line in p.stdout:
        line = line.rstrip()
        S["log"].append(line)
        m = re.search(r"HTTP server listening on https?://[^\s:]+:(\d+)", line)
        if m and S["proc"] is p:
            S["port"] = int(m.group(1))


def stop_bot():
    p = S["proc"]
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(5)
        except Exception:
            p.kill()


def ensure_deps():
    """npm install on the first run, and again whenever package.json changed."""
    pj = HERE / "package.json"
    if not pj.is_file():
        return True
    h = hashlib.sha256(pj.read_bytes()).hexdigest()
    have = (HERE / "node_modules").is_dir()
    if have and S.get("pkg") in (None, h):
        S["pkg"] = h
        return True
    if not NPM:
        S["err"] = "npm was not found. Install Node.js 18+ from nodejs.org, then restart the patcher."
        S["log"].append("[ERROR] " + S["err"])
        return False
    S["log"].append("--- npm install (first run or package.json changed) ---")
    try:
        r = subprocess.run([NPM, "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=str(HERE), capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=300)
    except (subprocess.TimeoutExpired, OSError) as e:
        S["err"] = "npm install did not finish: %s" % e
        S["log"].append("[ERROR] " + S["err"])
        return False
    for line in ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-15:]:
        S["log"].append(line)
    if r.returncode != 0:
        S["err"] = "npm install failed - see the BOT OUTPUT log."
        return False
    S["pkg"] = h
    return True


def start_bot():
    with LOCK:
        stop_bot()
        S["port"] = None
        S["gen"] += 1
        if not NODE:
            S["err"] = "Node.js was not found. Install Node 18+ from nodejs.org, then restart the patcher."
            S["log"].append("[ERROR] " + S["err"])
            return
        if not ensure_deps():
            return
        port = free_port(APP_PORT)
        S["log"].append("--- starting %s on port %d ---" % (BOT, port))
        # no token for the local preview (a token set in your shell would lock the preview out)
        env = dict(os.environ, PORT=str(port), API_TOKEN="", ACCESS_TOKEN="")
        p = subprocess.Popen([NODE, BOT], cwd=str(HERE), env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
        S["proc"] = p
        threading.Thread(target=pump, args=(p,), daemon=True).start()


def after_change(changed, watch):
    """server.js / package.json changed -> restart the app (and roll back if it dies on startup). Page only -> reload preview."""
    if any(n in ("server.js", "package.json") for n in changed):
        start_bot()
        if watch:
            t0 = time.time()
            while time.time() - t0 < 20:
                time.sleep(0.5)
                if S["port"]:
                    break
                if S["proc"].poll() is not None:
                    tail = "\n".join(list(S["log"])[-15:])
                    try:
                        undo_last()
                    except Exception:
                        pass
                    start_bot()
                    S["err"] = "The new version crashed on startup. The previous version was restored and restarted.\n\n" + tail
                    return
    if any(n != PATCHER for n in changed):
        S["reload"] += 1
    if PATCHER in changed:
        restart_self()


def restart_self():
    try:
        time.sleep(1.5)
        stop_bot()
        env = dict(os.environ, BCK_PORT=str(S.get("hport") or PORT))
        args = [sys.executable, str(HERE / PATCHER)] + sys.argv[1:]
        if os.name == "nt":
            subprocess.Popen(args, cwd=str(HERE), env=env)
            os._exit(0)
        os.execve(sys.executable, args, env)
    except Exception as e:
        S["err"] = "The patcher could not restart itself (%s). Close the patcher window and start it again." % e
        start_bot()


# ---------------- GITHUB PUSH (button gp) ----------------
import base64, urllib.request, urllib.error
FB_CFG_URL = "https://system-data-bf026-default-rtdb.asia-southeast1.firebasedatabase.app/aicompiler/gh_config.json"
PUSH_FILES = ["server.js", "package.json", "public/index.html", "patcher.py", "start_patcher.bat", "start.bat", "start.sh", "package-lock.json", "README.md"]  # same paths as in the repo
PUSH_ROOT = set()
PUSH_REPO = "888znq/BCKBOT"  # change it in push_repo.txt (one line: owner/repo)
try:
    _pr_file = HERE / "push_repo.txt"
    if _pr_file.is_file() and _pr_file.read_text().strip():
        PUSH_REPO = _pr_file.read_text().strip().strip("/")
except Exception:
    pass



PUSH_REPO = "888znq/FFT"


def _ssl_ctx():
    import ssl
    if os.environ.get("FFT_INSECURE_SSL") == "1":
        return ssl._create_unverified_context()
    try:
        import certifi
    except ImportError:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "certifi"])
            import certifi
        except Exception:
            return None
    return ssl.create_default_context(cafile=certifi.where())


def _http(method, url, token=None, body=None):
    hdr = {"User-Agent": "fft-patcher", "Accept": "application/vnd.github+json"}
    data = None
    if token:
        hdr["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    ctx = None
    tried = False
    while True:
        try:
            with urllib.request.urlopen(req, timeout=40, context=ctx) as r:
                raw = r.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            msg = raw
            try:
                j = json.loads(raw)
                if isinstance(j, dict):
                    msg = j.get("message") or j.get("error") or raw
            except ValueError:
                pass
            raise ValueError("HTTP %d on %s %s: %s" % (e.code, method, url.split("?")[0][-70:], str(msg)[:300]))
        except urllib.error.URLError as e:
            if not tried and "CERTIFICATE_VERIFY_FAILED" in str(e.reason):
                tried = True
                ctx = _ssl_ctx()
                if ctx is not None:
                    continue
            raise ValueError("Network error: %s" % e.reason)
    return json.loads(raw) if raw.strip() else None


def _pick(cfg, names):
    low = {str(k).lower(): v for k, v in cfg.items()}
    for n in names:
        v = low.get(n.lower())
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _gh_cfg():
    token = os.environ.get("GH_TOKEN", "").strip()
    want = os.environ.get("GH_BRANCH", "").strip()
    fb_err = ""
    if not token:
        try:
            cfg = _http("GET", FB_CFG_URL)
            if isinstance(cfg, dict):
                token = _pick(cfg, ["token", "ghToken", "pat", "accessToken"])
                want = want or _pick(cfg, ["branch", "ghBranch"])
        except Exception as e:
            fb_err = str(e)
    if not token:
        tf = HERE / "github_token.txt"
        if tf.is_file():
            token = tf.read_text().strip()
    if not token:
        raise ValueError("No GitHub token found in Firebase (aicompiler/gh_config -> token)%s." % ((": " + fb_err) if fb_err else ""))
    return token, PUSH_REPO, want


def _gh_repo_info(api, repo, token):
    try:
        return _http("GET", api, token)
    except ValueError as e:
        if "HTTP 404" not in str(e):
            raise
        names = []
        try:
            lst = _http("GET", "https://api.github.com/user/repos?per_page=100&sort=updated", token)
            names = [str(x.get("full_name")) for x in lst if isinstance(x, dict)]
        except Exception:
            names = []
        raise ValueError("Repo '%s' was not found or the token has no access to it. Repos this token can see: %s" % (repo, ", ".join(names) or "none"))


def gh_push(dry=False):
    token, repo, want = _gh_cfg()
    api = "https://api.github.com/repos/" + repo
    info = _gh_repo_info(api, repo, token)
    note = ""
    branch = want or info.get("default_branch") or "main"
    try:
        ref = _http("GET", api + "/git/ref/heads/" + branch, token)
    except ValueError as e:
        if want and "HTTP 404" in str(e):
            branch = info.get("default_branch") or "main"
            note = " (branch '%s' not found, used '%s')" % (want, branch)
            ref = _http("GET", api + "/git/ref/heads/" + branch, token)
        else:
            raise
    head = ref["object"]["sha"]
    commit = _http("GET", api + "/git/commits/" + head, token)
    base_tree = commit["tree"]["sha"]
    tree = _http("GET", api + "/git/trees/" + base_tree + "?recursive=1", token)
    have = {t["path"]: t["sha"] for t in tree.get("tree", []) if t.get("type") == "blob"}
    pre = ""
    ents, same, plan = [], 0, []
    for n in PUSH_FILES:
        p = HERE / n
        if not p.is_file():
            if n == "requirements.txt":
                continue
            raise ValueError("%s is missing next to the patcher." % n)
        data = p.read_bytes().replace(b"\r\n", b"\n")
        path = n if n in PUSH_ROOT else pre + n
        sha1 = hashlib.sha1((b"blob %d\0" % len(data)) + data).hexdigest()
        if have.get(path) == sha1:
            same += 1
            plan.append("  same     " + path)
            continue
        plan.append("  %-8s %s" % ("UPDATE" if path in have else "NEW", path))
        if dry:
            continue
        blob = _http("POST", api + "/git/blobs", token, {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        ents.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    if dry:
        lay = "public/ (page) and repo top level (server.js, package.json)"
        warn = []
        if "server.js" not in have:
            warn.append("This repo has no bot files yet - this will be the first push.")
        return "Target: %s@%s%s\n%s\nLast commit: %s (%s)\nFront-end files go to: %s\n\n%s\n\n%d to push, %d identical%s" % (
            repo, branch, note, info.get("html_url", ""), str(commit.get("message", "")).split("\n")[0][:80],
            str(commit.get("author", {}).get("date", ""))[:10], lay, "\n".join(plan), len(plan) - same, same,
            ("\n\n" + "\n".join(warn)) if warn else "")
    if not ents:
        return "%s@%s is already identical (%d files) - nothing to push.%s" % (repo, branch, same, note)
    nt = _http("POST", api + "/git/trees", token, {"base_tree": base_tree, "tree": ents})
    nc = _http("POST", api + "/git/commits", token, {"message": "Update from BCK Patcher " + time.strftime("%Y-%m-%d %H:%M:%S"), "tree": nt["sha"], "parents": [head]})
    _http("PATCH", api + "/git/refs/heads/" + branch, token, {"sha": nc["sha"]})
    return "Pushed %d file(s) to %s@%s (%s) - Render will redeploy.%s" % (len(ents), repo, branch, ", ".join(e["path"] for e in ents), note)


def gh_pull(dry=False):
    token, repo, want = _gh_cfg()
    api = "https://api.github.com/repos/" + repo
    info = _gh_repo_info(api, repo, token)
    note = ""
    branch = want or info.get("default_branch") or "main"
    try:
        ref = _http("GET", api + "/git/ref/heads/" + branch, token)
    except ValueError as e:
        if want and "HTTP 404" in str(e):
            branch = info.get("default_branch") or "main"
            note = " (branch '%s' not found, used '%s')" % (want, branch)
            ref = _http("GET", api + "/git/ref/heads/" + branch, token)
        else:
            raise
    commit = _http("GET", api + "/git/commits/" + ref["object"]["sha"], token)
    tree = _http("GET", api + "/git/trees/" + commit["tree"]["sha"] + "?recursive=1", token)
    have = {t["path"]: t["sha"] for t in tree.get("tree", []) if t.get("type") == "blob"}
    pre = ""
    todo, same, plan = [], 0, []
    for n in PUSH_FILES:
        path = n if n in PUSH_ROOT else pre + n
        if path not in have:
            plan.append("  not in repo  " + path)
            continue
        p = HERE / n
        if p.is_file():
            data = p.read_bytes().replace(b"\r\n", b"\n")
            if hashlib.sha1((b"blob %d\0" % len(data)) + data).hexdigest() == have[path]:
                same += 1
                plan.append("  same         " + n)
                continue
        plan.append("  %-12s %s" % ("REPLACE" if p.is_file() else "NEW", n))
        todo.append((n, path))
    head = "%s@%s%s" % (repo, branch, note)
    if not todo:
        return "Nothing to pull from %s: %d identical, the others are not in the repo.\n\n%s" % (head, same, "\n".join(plan)), []
    if dry:
        return "Pull from %s\n\n%s\n\n%d file(s) will be replaced in this folder (old versions are saved first)." % (head, "\n".join(plan), len(todo)), []
    got = {}
    for n, path in todo:
        blob = _http("GET", api + "/git/blobs/" + have[path], token)
        data = base64.b64decode(blob["content"])
        if hashlib.sha1((b"blob %d\0" % len(data)) + data).hexdigest() != have[path]:
            raise ValueError("Download of %s is corrupt - nothing was changed." % n)
        bad = syntax_problem(n, data.decode("utf-8"))
        if bad:
            raise ValueError("The downloaded %s does not parse - nothing was changed.\n%s" % (n, bad))
        got[n] = data
    bdir = HERE / "pull_backups" / time.strftime("%Y%m%d_%H%M%S")
    bdir.mkdir(parents=True, exist_ok=True)
    for n in got:
        if (HERE / n).is_file():
            (bdir / n).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(HERE / n), str(bdir / n))
    for n, data in got.items():
        (HERE / n).parent.mkdir(parents=True, exist_ok=True)
        (HERE / n).write_bytes(data)
    return "Pulled %d file(s) from %s: %s. Old versions saved in pull_backups\\%s" % (len(got), head, ", ".join(got), bdir.name), list(got)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--status":
    try:
        print(gh_push(True).encode("ascii", "replace").decode("ascii"))
    except Exception as e:
        print("ERROR: %s" % e)
    sys.exit(0)


ALOG = collections.deque(maxlen=500)


def alog(msg):
    line = time.strftime("%H:%M:%S") + "  " + str(msg).replace("\r", "").strip()
    ALOG.append(line)
    try:
        with open(HERE / "patcher_log.txt", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d ") + line.replace("\n", " | ") + "\n")
    except OSError:
        pass


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ctype="application/json", code=200):
        if self.command == "POST" and code == 200 and self.path not in ("/api/clearerr", "/api/logclear"):
            try:
                j = json.loads(body)
                if j.get("ok"):
                    det = j.get("msg") or (", ".join(j["files"]) if j.get("files") else "") or (j.get("mode") or "")
                    alog("%s ok %s" % (self.path[5:], str(det).split("\n")[0][:300]))
                else:
                    alog("%s ERROR %s" % (self.path[5:], str(j.get("error", "")).replace("\n", " ")[:300]))
            except Exception:
                pass
        b = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self.send(PAGE.replace("__FILES__", json.dumps(FILES)), "text/html")
        if path == "/api/log":
            return self.send(json.dumps({"log": "\n".join(ALOG)}))
        if path == "/api/status":
            p = S["proc"]
            return self.send(json.dumps({"running": bool(p and p.poll() is None), "port": S["port"], "gen": S["gen"],
                                         "reload": S["reload"], "err": S["err"], "stale": stale(), "boot": BOOT, "log": "\n".join(S["log"]),
                                         "report": error_report(S["err"], True) if S["err"].startswith("The new version crashed") else ""}))
        self.send("{}", code=404)

    def do_POST(self):
        if self.headers.get("X-BCK") != "1" or not re.match(r"^(127\.0\.0\.1|localhost)(:\d+)?$", self.headers.get("Host", "")):
            return self.send("{}", code=403)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        d = json.loads(raw) if raw else {}
        try:
            if self.path == "/api/payload":
                r = build_payload(d.get("instr", ""), d.get("files", []), d.get("user", True), d.get("sup", True),
                                  d.get("src", True), d.get("lite", True), d.get("clip", ""))
                r["ok"] = True
                return self.send(json.dumps(r))
            if self.path == "/api/auto":
                r = auto_clip(d)
                r["ok"] = True
                return self.send(json.dumps(r))
            if self.path == "/api/apply":
                with LOCK:
                    ts, changed = apply_patch(d.get("text", ""))
                S["err"] = ""
                threading.Thread(target=after_change, args=(changed, True), daemon=True).start()
                return self.send(json.dumps({"ok": True, "files": changed}))
            if self.path == "/api/undo":
                with LOCK:
                    names = undo_last()
                S["err"] = ""
                threading.Thread(target=after_change, args=(names, False), daemon=True).start()
                return self.send(json.dumps({"ok": True, "files": names}))
            if self.path == "/api/restart":
                threading.Thread(target=start_bot, daemon=True).start()
                return self.send(json.dumps({"ok": True}))
            if self.path == "/api/quit":
                self.send(json.dumps({"ok": True}))
                stop_bot()
                threading.Timer(0.3, os._exit, args=(0,)).start()
                return
            if self.path == "/api/ghcheck":
                return self.send(json.dumps({"ok": True, "msg": gh_push(True)}))
            if self.path == "/api/glcheck":
                return self.send(json.dumps({"ok": True, "msg": gh_pull(True)[0]}))
            if self.path == "/api/ghpull":
                with LOCK:
                    msg, changed = gh_pull()
                S["err"] = ""
                if changed:
                    threading.Thread(target=after_change, args=(changed, False), daemon=True).start()
                return self.send(json.dumps({"ok": True, "msg": msg}))
            if self.path == "/api/ghpush":
                return self.send(json.dumps({"ok": True, "msg": gh_push()}))
            if self.path == "/api/logclear":
                ALOG.clear()
                return self.send(json.dumps({"ok": True}))
            if self.path == "/api/clearerr":
                S["err"] = ""
                return self.send(json.dumps({"ok": True}))
            self.send("{}", code=404)
        except Exception as e:
            out = {"ok": False, "error": str(e)}
            if self.path == "/api/apply":
                out["report"] = error_report(str(e))
            self.send(json.dumps(out))


PAGE = r"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>BCK Patcher</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#000432;color:#fff;font:12px 'JetBrains Mono',Consolas,monospace;overflow:hidden}
#pv{position:fixed;left:0;top:0;width:100%;height:calc(100% - 31px);border:0;background:#000432}
#log{position:fixed;left:0;top:0;width:100%;height:calc(100% - 36px);display:none;overflow:auto;padding:12px;white-space:pre-wrap;word-break:break-all;line-height:1.5}
#bar{position:fixed;left:0;right:0;bottom:0;height:31px;display:flex;gap:1px;border-radius:0;overflow:hidden;background:#00031C;border:0;border-top:1px solid var(--pc,#E2E8F0);box-shadow:0 -6px 18px rgba(0,0,0,.4)}
#bar>*{border:0;color:#E2E8F0;-webkit-text-fill-color:#E2E8F0;font-weight:700;letter-spacing:.05em;font-size:12px;font-family:inherit;display:flex;align-items:center;padding:0 12px;white-space:nowrap;transition:filter .12s ease}
#ins{flex:1;background:#2ED573;outline:0;min-width:80px}#ins::placeholder{color:#7F89B8;opacity:1}#fl{background:#2ED573;gap:8px}#fl label{display:flex;gap:3px;align-items:center;cursor:pointer}
#tg{background:#2ED573;gap:8px}#tg label{display:flex;gap:3px;align-items:center;cursor:pointer;font-size:10px}
#tg input{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin:0;border:1.5px solid #E2E8F0;border-radius:0;background:transparent;position:relative;cursor:pointer}
#tg input:checked{background:var(--pc,#E2E8F0)}
#tg input:checked::after{content:"";position:absolute;left:3.5px;top:0.5px;width:4px;height:8px;border:solid #000432;border-width:0 2px 2px 0;transform:rotate(45deg)}
button{cursor:pointer;font-size:14px!important}button:hover{filter:brightness(1.15)}
#pay{background:#2ED573}#gp{background:#2ED573}#gl{background:#2ED573}#app{background:#2ED573}#undo{background:#2ED573}#rs{background:#2ED573}#vw{background:#2ED573}#st{background:#2ED573;font-size:11px}
#bar>#fl,#bar>#undo,#bar>#vw,#bar>#st,#bar>#rs,#bar>#gl,#bar>#lg{display:none!important}
#lg{background:#2ED573}
#bar>*{background:linear-gradient(180deg,#0D1660,#080F4A) !important;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
#bar>#ins{background:#030836 !important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
#bar>#auto.on,#bar>#auto.watch{color:var(--pc,#E2E8F0);-webkit-text-fill-color:var(--pc,#E2E8F0);box-shadow:inset 0 -2px 0 var(--pc,#E2E8F0)}
#bar>button:active{filter:brightness(.85) !important;transform:translateY(1px)}
#bar>button:disabled{opacity:.45}
#auto{background:#2ED573}#auto.on{background:#2ED573}#auto.watch{background:#2ED573;animation:apw 1.1s ease-in-out infinite alternate}@keyframes apw{from{opacity:.55}to{opacity:1}}
#lgo{display:none;position:fixed;left:50%;top:8px;transform:translateX(-50%);width:min(760px,96vw);height:calc(100% - 56px);background:#000432;border:1px solid #fff;border-radius:10px;padding:12px;z-index:11;flex-direction:column;box-shadow:0 0 30px rgba(255,255,255,.25)}
#lgo button{background:#E2E8F0;border:0;border-radius:6px;padding:5px 12px;color:#000432;font-size:11px!important;font-weight:800}
#lb{flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word;margin-top:8px;font-weight:400;line-height:1.5;min-height:0}
#toast{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:#000432;border:1px solid #fff;padding:8px 18px;border-radius:20px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:9;max-width:94vw}
#toast.on{opacity:1}
#eo{display:none;position:fixed;bottom:48px;left:50%;transform:translateX(-50%);width:min(640px,94vw);background:#000432;border:1px solid #fff;border-radius:10px;padding:14px;z-index:10;box-shadow:0 0 30px rgba(255,255,255,.25)}
#eb{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin:8px 0 10px;font-weight:400}#eo button{background:#E2E8F0;border:0;border-radius:6px;padding:5px 12px;margin-left:6px;color:#000432;font-size:11px!important;font-weight:800}
</style></head><body>
<iframe id="pv"></iframe><pre id="log"></pre>
<div id="bar"><input id="ins" placeholder="Instructions for AI... (@part3 / @name / @auto)"><div id="fl"></div><div id="tg"></div>
<button id="pay" title="Build and copy payload">▲</button><button id="auto" title="Auto mode">↯</button>
<button id="gp" title="Push the bot files to GitHub (Render redeploys)">&#11014;&#65038;</button><button id="app" title="Read clipboard and apply the patch">⌘</button><button id="gl" title="Pull the repo files into this folder (backup first)">&#11015;&#65038;</button><button id="lg" title="Log">&#9776;</button><button id="undo" title="Undo last patch">↶</button><button id="rs" title="Restart bot">⟳</button><button id="vw" title="Preview / bot output">≡</button><span id="st">...</span></div>
<div id="toast"></div>
<div id="lgo"><div style="display:flex;gap:6px;align-items:center"><b style="margin-right:6px">LOG</b><button id="lt1">ACTIVITY</button><button id="lt2">BOT OUTPUT</button><span style="flex:1"></span><button id="lcp">COPY</button><button id="lcl">CLEAR</button><button id="lx">✕</button></div><pre id="lb"></pre></div>
<div id="eo"><b>⚠️ PATCH ERROR</b><div id="eb"></div><div style="text-align:right"><button id="ec">📋 Copy Error</button><button id="ed">✕ Dismiss</button></div></div>
<script>
const $=id=>document.getElementById(id);
const F=__FILES__,L=["server","page","pkg","tool"];
let sv={};try{sv=JSON.parse(localStorage.getItem("bckchk")||"null")||{}}catch(e){}
F.forEach((f,i)=>{const on=(f in sv)?sv[f]:i==0;$("fl").insertAdjacentHTML("beforeend",'<label title="'+f+'"><input type="checkbox" value="'+f+'"'+(on?" checked":"")+'>'+L[i]+'</label>')});
$("fl").onchange=()=>{const o={};document.querySelectorAll("#fl input").forEach(x=>o[x.value]=x.checked);try{localStorage.setItem("bckchk",JSON.stringify(o))}catch(e){}};
const TG=[["user","U","U - My prompt: include my instruction"],["sup","P","P - AI instruction: include the patch-format prompt"],["lite","L","L - Lite mode: big files are sent as an index, then only the parts you tag"],["src","S","S - Original source: include the file source code"]];
let tv={};try{tv=JSON.parse(localStorage.getItem("bcktg")||"null")||{}}catch(e){}
TG.forEach(t=>{const on=(t[0] in tv)?tv[t[0]]:true;$("tg").insertAdjacentHTML("beforeend",'<label title="'+t[2]+'"><input type="checkbox" data-k="'+t[0]+'"'+(on?" checked":"")+'></label>')});
function getTg(){const o={};document.querySelectorAll("#tg input").forEach(x=>o[x.dataset.k]=x.checked);return o}
$("tg").onchange=()=>{try{localStorage.setItem("bcktg",JSON.stringify(getTg()))}catch(e){}};
let tt;function toast(m,ms){$("toast").textContent=m;$("toast").classList.add("on");clearTimeout(tt);tt=setTimeout(()=>$("toast").classList.remove("on"),ms||2600)}
let curErr="";function showErr(m){curErr=m;$("eb").textContent=m;$("eo").style.display="block"}
$("ed").onclick=()=>{$("eo").style.display="none";api("/api/clearerr")};
async function api(p,b){const r=await fetch(p,{method:"POST",headers:{"X-BCK":"1"},body:JSON.stringify(b||{})});return r.json()}
async function copy(t){try{await navigator.clipboard.writeText(t);return true}catch(e){return false}}
$("ec").onclick=async()=>{await copy("PATCH ERROR - please fix and resend the patch.\n\nError: "+curErr);toast("📋 Error copied")};
$("pay").onclick=async()=>{const files=F.slice();
 const tg=getTg();let clip="";
 if(tg.lite&&tg.src){try{clip=await navigator.clipboard.readText()}catch(e){}}
 let instr=$("ins").value.trim();
 if(AU.on&&AU.tags.length&&instr&&instr===AU.req)instr+=" "+AU.tags.join(" ");
 const r=await api("/api/payload",Object.assign({instr:instr,files,clip},tg));
 if(!r.ok){toast("⚠️ "+r.error,4000);return}
 if(typeof r.instr==="string")$("ins").value=r.instr;
 const ok=await copy(r.text);
 if(ok){AU.req=r.instr||"";AU.tags=r.tags||[];AU.seen=r.text;AU.tries=0;auPaint()}
 const lbl={index:"🧭 Index copied (no code, "+r.chars+" chars) - paste to Claude, copy its reply, then press ▲ again",lite:"🚀 Lite payload copied ("+r.chars+" chars) - paste into Claude",full:"🚀 Payload copied ("+r.chars+" chars) - paste into Claude"};
 toast(ok?lbl[r.mode]+(r.added?"  +"+r.added+" tag(s) from clipboard":""):"❌ Copy failed",4500)};
$("app").onclick=async()=>{let t="";try{t=await navigator.clipboard.readText()}catch(e){toast("❌ Cannot read clipboard - allow it in the browser");return}
 if(!t.trim()){toast("⚠️ Clipboard is empty");return}
 await doApply(t,false)};
$("undo").onclick=async()=>{const r=await api("/api/undo");if(r.ok)toast("↩ Restored: "+r.files.join(", "));else toast("ℹ "+r.error)};
$("rs").onclick=async()=>{await api("/api/restart");toast("⟳ Restarting bot...")};
$("gp").onclick=async()=>{$("gp").disabled=true;toast("\u2B06 Checking GitHub target...",60000);try{const c=await api("/api/ghcheck");if(!c.ok){$("gp").disabled=false;toast("\u274C Check failed",4000);showErr(c.error);return}toast("\u2B06 Pushing to GitHub...",60000);const r=await api("/api/ghpush");$("gp").disabled=false;if(r.ok){$("eo").style.display="none";toast("\u2705 "+r.msg,9000)}else{toast("\u274C Push failed",4000);showErr(r.error)}}catch(e){$("gp").disabled=false;toast("\u274C "+e,5000)}};
$("gl").onclick=async()=>{$("gl").disabled=true;toast("\u2B07 Checking the repo...",60000);try{const c=await api("/api/glcheck");if(!c.ok){$("gl").disabled=false;toast("\u274C Check failed",4000);showErr(c.error);return}if(c.msg.indexOf("Nothing to pull")===0){$("gl").disabled=false;toast(c.msg.split("\n")[0],7000);return}if(!confirm(c.msg+"\n\nPull now? Your current files are backed up first.")){$("gl").disabled=false;toast("Pull cancelled",2500);return}toast("\u2B07 Pulling...",60000);const r=await api("/api/ghpull");$("gl").disabled=false;if(r.ok){$("eo").style.display="none";toast("\u2705 "+r.msg,9000)}else{toast("\u274C Pull failed",4000);showErr(r.error)}}catch(e){$("gl").disabled=false;toast("\u274C "+e,5000)}};
let AU={on:true,req:"",tags:[],seen:null,busy:false,tries:0};
const AUTO_APPLY=true,AUTO_MAX=3;
try{const a=localStorage.getItem("bckauto");if(a!==null)AU.on=a==="1"}catch(e){}
function auPaint(){$("app").style.display=AU.on?"none":"";const b=$("auto"),w=AU.on&&(AU.req||AU.tags.length);b.classList.toggle("on",!!(AU.on&&!w));b.classList.toggle("watch",!!w);
 b.title=!AU.on?"Auto mode OFF - click to turn it ON":w?"AUTO: waiting for the AI reply. Parts it asks for are added to the payload by themselves, a patch is applied by itself. Click to turn OFF":"AUTO ON: copy an AI reply (with @parts or a patch) and come back to this window. Click to turn OFF"}
$("auto").onclick=()=>{AU.on=!AU.on;AU.req="";AU.tags=[];AU.seen=null;AU.tries=0;try{localStorage.setItem("bckauto",AU.on?"1":"0")}catch(e){}auPaint();toast(AU.on?"⚡ Auto mode ON":"🖐 Auto mode OFF")};
async function auFeed(report,what){
 AU.tries++;
 if(AU.tries>AUTO_MAX){toast("⚠️ Auto-fix stopped after "+AUTO_MAX+" failed tries - fix it by hand (📋 Copy Error)",8000);return}
 const ok=await copy(report);AU.seen=report;
 toast(ok?"🥜 "+what+" - error report copied (try "+AU.tries+"/"+AUTO_MAX+"), paste it to the AI":"❌ Copy failed",7000)}
async function doApply(t,auto){
 const r=await api("/api/apply",{text:t});
 if(r.ok){$("eo").style.display="none";toast("⚡ Patched: "+r.files.join(", "));AU.req="";AU.tags=[];AU.tries=0;auPaint();return true}
 showErr(r.error);
 if(auto&&AU.on&&r.report)await auFeed(r.report,"Patch failed");
 return false}
async function auCheck(){
 if(!AU.on||AU.busy||!document.hasFocus())return;
 AU.busy=true;
 try{
  let t="";try{t=await navigator.clipboard.readText()}catch(e){return}
  t=t||"";
  if(AU.seen===null){AU.seen=t;return}
  if(t===AU.seen||!t.trim())return;
  AU.seen=t;
  if(!/@[\w$-]+/.test(t)&&!/={3}\s*SPLIT\s*={3}/.test(t))return;
  const r=await api("/api/auto",Object.assign({clip:t,req:AU.req,tags:AU.tags,files:F.slice()},getTg()));
  if(!r.ok){toast("⚠️ "+r.error,4000);return}
  if(r.kind==="patch"){
   if(AUTO_APPLY)await doApply(t,true);else toast("📋 Patch received - press ⌘ to apply",5000)
  }else if(r.kind==="payload"){
   AU.req=r.req;AU.tags=r.tags;
   const ok=await copy(r.text);AU.seen=r.text;auPaint();
   toast(ok?(r.new.length?"⚡ Auto: the AI asked for "+r.new.length+" part(s) ("+r.new.join(" ")+") - payload copied ("+r.chars+" chars), paste it to the AI":"⚡ Auto: the AI asked again for parts it already has - same payload copied ("+r.chars+" chars)"):"❌ Copy failed",7000)
  }
 }finally{AU.busy=false}}
setInterval(auCheck,700);
window.addEventListener("focus",()=>setTimeout(auCheck,60));
document.addEventListener("visibilitychange",()=>{if(!document.hidden)auCheck()});
window.addEventListener("pointerdown",()=>{auCheck()},true);
auPaint();
let lgTab=1,lgTimer=0;
async function lgLoad(){try{const t=lgTab==1?(await (await fetch("/api/log")).json()).log:(await (await fetch("/api/status")).json()).log;const b=$("lb"),end=b.scrollTop+b.clientHeight>=b.scrollHeight-30;b.textContent=t||"(empty)";if(end)b.scrollTop=b.scrollHeight;$("lt1").style.opacity=lgTab==1?1:.5;$("lt2").style.opacity=lgTab==2?1:.5}catch(e){}}
function lgShow(on){$("lgo").style.display=on?"flex":"none";clearInterval(lgTimer);if(on){lgLoad();lgTimer=setInterval(lgLoad,1000)}}
$("lg").onclick=()=>lgShow($("lgo").style.display!=="flex");
$("lx").onclick=()=>lgShow(false);
$("lt1").onclick=()=>{lgTab=1;lgLoad();$("lb").scrollTop=$("lb").scrollHeight};
$("lt2").onclick=()=>{lgTab=2;lgLoad();$("lb").scrollTop=$("lb").scrollHeight};
$("lcp").onclick=async()=>{await copy($("lb").textContent);toast("📋 Log copied")};
$("lcl").onclick=async()=>{if(lgTab==1)await api("/api/logclear");lgLoad()};
let logv=false;$("vw").onclick=()=>{logv=!logv;$("log").style.display=logv?"block":"none";$("pv").style.display=logv?"none":"block"};
let key="",seen="",stl=0,bt="";
async function poll(){try{const s=await (await fetch("/api/status")).json();
 if(bt&&s.boot&&s.boot!==bt){location.reload();return}bt=s.boot||bt;
 $("st").textContent=s.running?(s.port?"● bot :"+s.port:"● starting..."):"○ bot stopped";
 const lg=$("log"),atEnd=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-30;lg.textContent=s.log;if(atEnd)lg.scrollTop=lg.scrollHeight;
 const k=s.gen+"/"+s.port+"/"+s.reload;if(s.port&&k!==key){key=k;$("pv").src="http://127.0.0.1:"+s.port+"/?r="+Date.now()}
 if(s.stale&&!stl){stl=1;document.title="BCK Patcher (restart needed)";toast("\u26a0 patcher.py changed - restarting the patcher (if nothing happens, close this window and start it again)",9000)}
 if(!s.stale&&stl){stl=0;document.title="BCK Patcher"}
 if(s.err&&s.err!==seen){seen=s.err;showErr(s.err);if(AU.on&&s.report)auFeed(s.report,"The new version crashed")}if(!s.err)seen=""}catch(e){}}
setInterval(poll,1000);poll();
window.addEventListener("message",e=>{if(e.source!==$("pv").contentWindow)return;const d=e.data;if(d&&typeof d.bckSg==="string"&&window.CSS&&CSS.supports("color",d.bckSg)){document.documentElement.style.setProperty("--sg",d.bckSg);return}if(!d||typeof d.bckPc!=="string"||!d.bckPc||!(window.CSS&&CSS.supports("color",d.bckPc)))return;document.documentElement.style.setProperty("--pc",d.bckPc)});
</script></body></html>"""


# ───────────────────────── self test ─────────────────────────
def selftest():
    fails = []

    def check(name, cond):
        print(("  ok   " if cond else "  FAIL ") + name)
        if not cond:
            fails.append(name)

    animals = ["zebra", "yak", "walrus", "vulture", "urchin", "tapir", "snail", "raven", "quail", "panda", "otter", "newt"]
    py = ["# synthetic bot", "import os", ""]
    for a in animals:
        py.append("def handle_%s(x):" % a)
        for j in range(40):
            py.append("    v%d = x + %d  # filler %s %d" % (j, j, "line", j))
        py.append("    return 'marker_%s'" % a)
    files = {"big.py": "\n".join(py), "small.html": "<html><body>hello</body></html>"}

    print("chunking")
    ch = lite_build(files)
    check("big file split into parts, small file untouched", len(ch) >= 10 and all(c["file"] == "big.py" for c in ch))
    check("parts cover the file exactly", "\n".join(c["t"] for c in ch) == files["big.py"])
    check("function names found", any("handle_walrus" in c["names"] for c in ch))
    check("cache returns same list", lite_build(files) is ch)
    check("small files alone give no parts", lite_build({"s.html": files["small.html"]}) == [])

    print("index / lite source")
    idx = lite_index(files, "fix marker_walrus handler please")
    wal = next(c for c in ch if "handle_walrus" in c["names"])
    check("index marks the matching part", ("PART %d big.py" % wal["n"]) in idx and "<<MATCH: marker_walrus" in idx)
    check("index has no code", "v5 = x + 5" not in idx)
    check("index lists small files", "small.html (1 lines)" in idx)
    src = lite_source(files, "do it @handle_walrus")
    check("name tag shows that part only", "marker_walrus" in src and "marker_zebra'" not in src)
    check("small file sent in full", "==== FILE: small.html ====\n<html>" in src)
    src2 = lite_source(files, "@part%d" % wal["n"])
    check("@partN tag works", "marker_walrus" in src2)
    src3 = lite_source(files, "change marker_otter please")
    check("auto-match picks the matching part", "marker_otter" in src3 and "marker_zebra'" not in src3)

    print("payload modes")
    r = build_payload_from(files, "fix marker_walrus")
    check("big + plain instruction -> index (no prompt)", r["mode"] == "index" and "Reply with ONLY" not in r["text"] and "INDEX MODE" in r["text"])
    r = build_payload_from(files, "fix it @handle_walrus")
    check("tags -> lite with prompt, tags removed afterwards", r["mode"] == "lite" and "Reply with ONLY" in r["text"] and "@" not in r["instr"])
    r = build_payload_from(files, "fix marker_walrus @auto")
    check("@auto -> lite, tag removed", r["mode"] == "lite" and r["instr"] == "fix marker_walrus" and "marker_walrus" in r["text"])
    r = build_payload_from(files, "fix marker_walrus", lite=False)
    check("lite off -> full files", r["mode"] == "full" and "marker_zebra'" in r["text"] and "==== FILE: big.py ====" in r["text"])
    r = build_payload_from({"small.html": files["small.html"]}, "x")
    check("only small files -> full", r["mode"] == "full")
    r = build_payload_from(files, "x", sup=False, src=False)
    check("prompt + source off -> only the instruction", r["text"].startswith("User Instruction: x"))
    try:
        build_payload_from(files, "", user=False, sup=False, src=False)
        check("nothing selected raises", False)
    except ValueError:
        check("nothing selected raises", True)
    r = build_payload_from(files, "fix marker_walrus", clip="fix marker_walrus @handle_walrus @part99 @handle_walrus")
    check("clipboard tags auto-added (known only, once)", r["added"] == 1 and r["mode"] == "lite")
    r = build_payload_from(files, "fix marker_walrus", clip="x" * 5000 + " @handle_walrus")
    check("long clipboard ignored", r["added"] == 0)
    r = build_payload_from(files, "fix marker_walrus", clip="[LITE MODE: ...] @handle_walrus")
    check("own payload in clipboard ignored", r["added"] == 0)
    check("payload ends with the invisible signature", r["text"].endswith(SIG))

    print("patch parsing / applying")
    p = parse("```\n==== FILE: small.html ====\nhello\n===SPLIT===\nbye\n===BLOCK===\nv1 = x + 1\n===SPLIT===\nv1 = x + 100\n```")
    check("two blocks parsed", len(p) == 2)
    check("explicit file name read", p[0][2] == "small.html" and p[0][0] == "hello" and p[0][1] == "bye")
    check("later block gets the file as a hint", p[1][2] is None and p[1][3] == "small.html")
    p = parse("old\n===SPLIT===\nnew")
    check("plain block still works", p == [("old", "new", None, None)])
    check("zero-width marker ignored", parse("a\n===SPLIT===\nb" + SIG)[0][1] == "b")

    f2 = {"a.js": "x();\ny();\n", "b.js": "x();\nz();\n"}
    try:
        apply_blocks(dict(f2), parse("x();\n===SPLIT===\nq();"))
        check("duplicate across files rejected", False)
    except ValueError as e:
        check("duplicate across files rejected", "2 places" in str(e))
    g = dict(f2)
    ch2 = apply_blocks(g, parse("==== FILE: b.js ====\nx();\n===SPLIT===\nq();"))
    check("FILE header resolves the duplicate", ch2 == {"b.js"} and g["b.js"].startswith("q();") and g["a.js"].startswith("x();"))
    g = dict(f2)
    ch2 = apply_blocks(g, parse("==== FILE: a.js ====\ny();\n===SPLIT===\ny2();\n===BLOCK===\nx();\n===SPLIT===\nq();"))
    check("hint file used for the next block", ch2 == {"a.js"} and g["a.js"].startswith("q();") and g["b.js"].startswith("x();"))
    g = dict(f2)
    try:
        apply_blocks(g, parse("==== FILE: a.js ====\nz();\n===SPLIT===\nq();"))
        check("named file is searched only", False)
    except ValueError:
        check("named file is searched only", True)
    g = {"a.js": "keep;\ntail  \nend\n"}
    apply_blocks(g, parse("tail\nend\n===SPLIT===\nnew"))
    check("trailing-space tolerant match", g["a.js"] == "keep;\nnew\n")

    print("auto mode / smart parts")
    SPL = "=" * 3 + "SPLIT" + "=" * 3
    g2 = {"big.py": files["big.py"] + "\n\ndef caller_all():\n" + "\n".join("    w%d = handle_walrus(%d)" % (j, j) for j in range(45)), "small.html": files["small.html"]}
    ch3 = lite_links(lite_build(g2))
    cal = next(c for c in ch3 if "caller_all" in c["names"])
    wal3 = next(c for c in ch3 if "handle_walrus" in c["names"])
    check("links: the caller lists the part it calls", any(x["name"] == "handle_walrus" and x["n"] == wal3["n"] for x in cal["calls"]))
    check("links: the callee lists its callers", cal["n"] in wal3["by"])
    ix2 = lite_index(g2, "fix marker_walrus")
    check("index shows calls / used by", ("calls: handle_walrus(%d)" % wal3["n"]) in ix2 and ("used by: %d" % cal["n"]) in ix2)
    check("index asks for the whole cause chain, not for as few parts as possible", "cause chain" in ix2 and "as few parts" not in ix2 and "Reply with ONLY" not in ix2)
    ls2 = lite_source(g2, "@caller_all")
    check("lite source has strict rules and the connections of the shown parts", "STRICT RULES" in ls2 and "CONNECTIONS OF THE SHOWN PARTS" in ls2 and "handle_walrus (PART %d)" % wal3["n"] in ls2)
    st = auto_step(g2, "fix marker_walrus @handle_walrus @part999", "", [])
    check("auto: a reply with real tags builds the lite payload with the request", st["kind"] == "payload" and st["mode"] == "lite" and st["req"] == "fix marker_walrus" and st["tags"] == ["@handle_walrus"] and "marker_walrus" in st["text"])
    st2 = auto_step(g2, "I need @caller_all too", st["req"], st["tags"])
    check("auto: a second ask keeps the first request and adds the new part", st2["req"] == "fix marker_walrus" and st2["tags"] == ["@handle_walrus", "@caller_all"] and "caller_all" in st2["text"] and "marker_walrus" in st2["text"])
    st3 = auto_step(g2, "@caller_all", st2["req"], st2["tags"])
    check("auto: asking again for a part already sent is detected", st3["kind"] == "payload" and st3["new"] == [])
    check("auto: a reply with a patch -> patch", auto_step(g2, "a\n" + SPL + "\nb", "", [])["kind"] == "patch")
    check("auto: plain text, our own payload, error reports and unknown tags are ignored", all(auto_step(g2, x, "", [])["kind"] == "ignore" for x in ("just some text", st["text"], "PATCH ERROR - x @handle_walrus", "RUNTIME ERROR x @handle_walrus", "@nopart")))
    check("error report: nothing changed, resend the whole patch", "NOT applied" in error_report("Block 1: boom") and "Block 1: boom" in error_report("Block 1: boom") and ("OLD" + SPL + "NEW") in error_report("x"))
    check("error report after a crash", error_report("boom", True).startswith("RUNTIME ERROR") and "boom" in error_report("boom", True))
    f4 = {"a.js": "function f() {\n  var x = 1;\n  var y = 2;\n  return x + y;\n}\n"}
    try:
        apply_blocks(dict(f4), parse("var x = 1;\nvar y = 3;\n" + SPL + "\nq"))
        check("not-found error shows the closest match", False)
    except ValueError as e:
        check("not-found error shows the closest match and the real code", "Closest match: a.js line 2" in str(e) and "OLD line 2 differs" in str(e) and "var y = 2;" in str(e))
    try:
        apply_blocks({"a.js": "head1\nx();\nhead2\nx();\n"}, parse("x();\n" + SPL + "\nq"))
        check("ambiguous error shows where", False)
    except ValueError as e:
        check("ambiguous error shows the lines and what precedes them", "a.js line 2, preceded by: head1" in str(e) and "a.js line 4, preceded by: head1 | head2" in str(e).replace("head1 | head2", "head1 | head2"))
    SESSION["log"].clear()
    aft = dict(files)
    aft["big.py"] = files["big.py"].replace("v5 = x + 5", "v5 = x + 500", 1)
    session_note(files, aft, {"big.py"})
    check("session log names the file, the line and the part", bool(SESSION["log"]) and "big.py L" in SESSION["log"][-1] and "@part" in SESSION["log"][-1])
    check("session changes go into the next payload", "SESSION CHANGES" in build_payload_from(aft, "x")["text"])
    SESSION["log"].clear()
    nt = {"n.html": "<!" + "-- AI-NOTES keep the colors --" + ">\n<html></html>"}
    check("AI-NOTES written inside a file go into the payload", "keep the colors" in build_payload_from(nt, "x")["text"])
    check("page has the auto button and its endpoint", 'id="auto"' in PAGE and "/api/auto" in PAGE and "doApply" in PAGE)
    print("self patching")
    check("patcher.py is a patchable file, separate from the bot", PATCHER in FILES and BOT != PATCHER and BOT in FILES)
    check("page gets the file list injected", "__FILES__" in PAGE and '"tool"' in PAGE)
    check("running version is not reported as stale", not stale())
    try:
        selfcheck("x = (\n")
        check("selfcheck rejects a broken patcher", False)
    except ValueError:
        check("selfcheck rejects a broken patcher", True)
    try:
        selfcheck("x = 1\n")
        check("selfcheck rejects a patcher without main()", False)
    except ValueError:
        check("selfcheck rejects a patcher without main()", True)
    try:
        selfcheck((HERE / PATCHER).read_text(encoding="utf-8"))
        check("selfcheck accepts the current patcher", True)
    except ValueError as e:
        check("selfcheck accepts the current patcher: " + str(e)[:80], False)
    print("page")
    check("page has the four toggles and no triple quotes", all(k in PAGE for k in ('"user"', '"sup"', '"src"', '"lite"')))
    print("RESULT: %s" % ("ALL PASSED" if not fails else "%d FAILED" % len(fails)))
    return 1 if fails else 0


def check():
    """python patcher.py --check : tests YOUR real bot files against the lite / index / patch logic. Writes nothing."""
    import shutil as _sh
    bad = []

    def say(ok, msg):
        print(("  ok   " if ok else "  FAIL ") + msg)
        if not ok:
            bad.append(msg)

    print("BCK Patcher check - folder: %s" % HERE)
    miss = [n for n in FILES if not (HERE / n).is_file()]
    say(not miss, "all bot files present" + ("" if not miss else " - MISSING: " + ", ".join(miss)))
    if miss:
        return 1
    files, crlf = load()
    print("files")
    node = _sh.which("node")
    for n, t in files.items():
        msg = "%-22s %5d lines %7d chars%s" % (n, len(t.split("\n")), len(t), "  (CRLF)" if crlf[n] else "")
        if n.endswith(".py"):
            try:
                compile(t, n, "exec")
                say(True, msg + "  python syntax ok")
            except SyntaxError as e:
                say(False, msg + "  PYTHON SYNTAX ERROR line %s: %s" % (e.lineno, e.msg))
        elif n.endswith((".js", ".html", ".json")):
            bad_s = syntax_problem(n, t)
            say(not bad_s, msg + ("  syntax ok" if not bad_s else "  SYNTAX ERROR: " + bad_s[:200]))
        else:
            say(True, msg)
    print("lite chunking")
    ch = lite_build(files)
    if not ch:
        say(True, "no file is big enough to split - payloads are always full (nothing to index)")
        return 1 if bad else 0
    for n in files:
        cs = [c for c in ch if c["file"] == n]
        if not cs:
            print("       %-22s small - always sent whole" % n)
            continue
        say("\n".join(c["t"] for c in cs) == files[n], "%-22s %3d parts, biggest %5d chars, %d without a name - parts cover the file exactly" % (
            n, len(cs), max(len(c["t"]) for c in cs), sum(1 for c in cs if not c["names"])))
    print("payload")
    full = build_payload_from(files, "check", lite=False)["chars"]
    nm = next((x for c in ch for x in c["names"]), "main")
    ix = build_payload_from(files, "change " + nm)
    say(ix["mode"] == "index" and ix["chars"] < full, "plain instruction -> INDEX mode, %d chars (full files would be %d chars, %d%% saved)" % (
        ix["chars"], full, 100 - ix["chars"] * 100 // max(full, 1)))
    au = build_payload_from(files, "change " + nm + " @auto")
    say(au["mode"] == "lite" and au["chars"] < full, "@auto -> LITE mode, %d chars" % au["chars"])
    miss_p = [c["n"] for c in ch if (lambda r: r["mode"] != "lite" or c["t"] not in r["text"])(build_payload_from(files, "x @part%d" % c["n"]))]
    say(not miss_p, "every @partN tag returns that exact part (%d parts tested)%s" % (len(ch), "" if not miss_p else " - FAILED: " + str(miss_p[:10])))
    print("patch round-trip (in memory, nothing is written)")
    fails, tested = [], 0
    for c in ch:
        pick = next((l for l in c["t"].split("\n") if len(l.strip()) >= 12 and files[c["file"]].count(l) == 1), None)
        if pick is None:
            continue
        tested += 1
        try:
            tmp = dict(files)
            apply_blocks(tmp, [(pick, pick + "  PATCHTEST", c["file"], None)])
            if "PATCHTEST" not in tmp[c["file"]]:
                raise ValueError("not applied")
        except Exception as e:
            fails.append("part %d (%s): %s" % (c["n"], c["file"], str(e)[:80]))
    say(not fails, "FILE-header patch applied cleanly in %d of %d parts%s" % (tested - len(fails), tested, "" if not fails else " - " + "; ".join(fails[:3])))
    print("RESULT: " + ("ALL OK - your files work with the lite logic" if not bad else "%d PROBLEM(S) - see FAIL lines above" % len(bad)))
    return 1 if bad else 0


def main():
    missing = [n for n in FILES if not (HERE / n).is_file()]
    if [n for n in missing if n != PATCHER]:
        print("Missing in %s: %s" % (HERE, ", ".join(missing)))
        print("Trying to download them from GitHub (%s)..." % PUSH_REPO)
        try:
            print(gh_pull()[0])
        except Exception as e:
            print("Could not download them: %s" % e)
        missing = [n for n in FILES if not (HERE / n).is_file()]
    if missing:
        print("Still missing in %s: %s" % (HERE, ", ".join(missing)))
        input("Press Enter to close...")
        sys.exit(1)
    BK.mkdir(exist_ok=True)
    snap = BK / "_original"
    snap.mkdir(exist_ok=True)
    for n in FILES:
        if not (snap / n).exists():
            (snap / n).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(HERE / n, snap / n)
    srv = None
    want = int(os.environ.get("BCK_PORT") or 0)
    if want:
        time.sleep(0.8)
    for k in range(25 if want else 1):
        for p in ([want] if want and k < 24 else range(PORT, PORT + 20)):
            try:
                srv = ThreadingHTTPServer(("127.0.0.1", p), H)
                break
            except OSError:
                continue
        if srv:
            break
        time.sleep(0.4)
    if not srv:
        print("No free port for the patcher.")
        input("Press Enter to close...")
        sys.exit(1)
    atexit.register(stop_bot)
    threading.Thread(target=start_bot, daemon=True).start()
    S["hport"] = srv.server_address[1]
    url = "http://127.0.0.1:%d" % srv.server_address[1]
    print("BCK Patcher: %s   (close this window to stop the patcher and the bot)" % url)
    if not want:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if "--check" in sys.argv:
        sys.exit(check())
    main()
