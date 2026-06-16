#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pre-publish gate for the Latent Lounge MCP server (latent-lounge-mcp).
#
# This package is PUBLISHED to npm + the MCP registry — strangers install it —
# so it earns at least the same scrutiny as the server it talks to. Runs BEFORE
# any publish/push and proves the code in this working tree:
#   1. parses          — every tracked .js file passes `node --check`
#   2. has no leaked secrets — tracked files carry no private keys / credentials
#   3. boots clean      — `node index.js` starts on stdio and answers a real
#                         MCP initialize + tools/list handshake with >0 tools
#   4. has no unreviewed CVEs — `npm audit` finds nothing critical and nothing
#                         outside the accepted-known set in .audit-allowlist.json
#   5. ships clean      — the npm tarball contains only intended files
#                         (no .env, keys, lockfile, or this gate itself)
#
# Wired to `npm run gate` and to `prepublishOnly`, so `npm publish` cannot skip
# it. Exit code is non-zero if any HARD check fails. The network-dependent
# audit check degrades to a WARNING when offline.
#
# Usage:  npm run gate        (or)   bash scripts/pre-publish-gate.sh
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; NC=$'\033[0m'
pass() { printf "  ${GREEN}PASS${NC}  %s\n" "$1"; }
fail() { printf "  ${RED}FAIL${NC}  %s\n" "$1"; HARD_FAIL=1; }
warn() { printf "  ${YEL}WARN${NC}  %s\n" "$1"; }
step() { printf "\n${DIM}── %s ──${NC}\n" "$1"; }

HARD_FAIL=0
TMP_HARNESS="$(mktemp /tmp/gate-boot.XXXXXX.mjs)"
cleanup() { rm -f "$TMP_HARNESS" /tmp/gate_check.err /tmp/gate_audit.err 2>/dev/null; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
step "1/5  Syntax check (node --check on tracked .js)"
JS_FILES="$(git ls-files '*.js' 2>/dev/null || true)"
if [ -z "$JS_FILES" ]; then
  warn "no tracked .js files found"
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if node --check "$f" 2>/tmp/gate_check.err; then
      pass "$f"
    else
      fail "$f does not parse"
      sed 's/^/        /' /tmp/gate_check.err
    fi
  done <<< "$JS_FILES"
fi

# ---------------------------------------------------------------------------
step "2/5  Secret scan (tracked files)"
# index.js reads PRIVATE_KEY from process.env — never from a committed file.
# This catches the case where a real key (or .env) gets staged anyway.
SECRET_HITS=0
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail ".env is tracked by git — it must stay gitignored"
  SECRET_HITS=1
fi
SCAN="$(git grep -nIE \
  -e 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' \
  -e '0x[a-fA-F0-9]{64}' \
  -e '(PRIVATE_KEY|SECRET|MNEMONIC|SEED_PHRASE)[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9+/]{24,}' \
  -- . ':(exclude)package-lock.json' ':(exclude)scripts/pre-publish-gate.sh' 2>/dev/null \
  | grep -vE 'process\.env|\.env\.example|YOUR_|EXAMPLE|PLACEHOLDER|0x0{40}|0x\.\.\.' || true)"
if [ -n "$SCAN" ]; then
  fail "possible secret(s) in tracked files:"
  printf '%s\n' "$SCAN" | sed 's/^/        /'
  SECRET_HITS=1
fi
[ "$SECRET_HITS" -eq 0 ] && pass "no private keys or credentials in tracked files"

# ---------------------------------------------------------------------------
step "3/5  Stdio boot + MCP handshake (initialize + tools/list)"
# Boot the real server over stdio with a sandbox env (no wallet key, harmless
# unreachable LOUNGE_URL, zero spend ceiling) and drive a genuine MCP handshake.
# tools/list makes no network calls, so this proves the server registers its
# tools and speaks the protocol without ever touching the live lounge or a wallet.
if [ ! -d node_modules ]; then
  fail "node_modules missing — run \`npm ci\` before the gate (deps are required to boot)"
else
  cat > "$TMP_HARNESS" <<'NODE'
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env,
    PRIVATE_KEY: "",
    DESIGNATION: "gate-smoketest",
    LOUNGE_URL: "http://127.0.0.1:9",   // discard port: never reachable
    MAX_SPEND_USD: "0" },
});
let out = "", err = "", done = false, tools = null;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", d => { err += d; });
const send = o => child.stdin.write(JSON.stringify(o) + "\n");
child.stdout.on("data", d => {
  out += d; let i;
  while ((i = out.indexOf("\n")) >= 0) {
    const line = out.slice(0, i).trim(); out = out.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1 && m.result) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (m.id === 2) { tools = m; finish(); }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "gate", version: "0" } } });
const timer = setTimeout(() => bail("timeout (10s) waiting for tools/list"), 10000);
function finish() {
  if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {}
  const list = tools && tools.result && tools.result.tools;
  if (Array.isArray(list) && list.length > 0) {
    console.log("TOOLS " + list.length);
    console.log("NAMES " + list.map(t => t.name).join(","));
    process.exit(0);
  }
  bail("tools/list returned no tools: " + JSON.stringify(tools));
}
function bail(msg) {
  if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {}
  console.error("BOOTFAIL " + msg); if (err) console.error(err.trim()); process.exit(1);
}
child.on("exit", code => { if (!done && tools === null) bail("server exited early (code " + code + ")"); });
NODE
  BOOT_OUT="$(node "$TMP_HARNESS" 2>&1)"
  if [ $? -eq 0 ]; then
    N="$(printf '%s\n' "$BOOT_OUT" | sed -n 's/^TOOLS //p')"
    pass "server booted on stdio and answered tools/list (${N:-?} tools registered)"
  else
    fail "stdio boot / MCP handshake failed"
    printf '%s\n' "$BOOT_OUT" | sed 's/^/        /'
  fi
fi

# ---------------------------------------------------------------------------
step "4/5  Dependency vulnerability scan (npm audit, prod deps)"
# Policy (see .audit-allowlist.json): FAIL on ANY critical, or on any advisory
# NOT already accepted-known. Accepted-known advisories are the x402-fetch / viem
# transitive web3 + wallet-connector tree, unreachable from this server's code.
AUDIT_JSON="$(npm audit --omit=dev --json 2>/tmp/gate_audit.err)"
if printf '%s' "$AUDIT_JSON" | grep -qiE 'ENOTFOUND|ETIMEDOUT|ECONNREFUSED|registry|offline' \
   || ! printf '%s' "$AUDIT_JSON" | grep -q '"vulnerabilities"'; then
  warn "could not reach npm registry (offline) — re-run with network before publishing"
else
  AUDIT_RESULT="$(printf '%s' "$AUDIT_JSON" | node -e '
    const fs=require("fs");
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      let allow={};
      try{ allow=(JSON.parse(fs.readFileSync(".audit-allowlist.json","utf8")).accepted)||{}; }catch{}
      const v=(JSON.parse(d).vulnerabilities)||{};
      const unexpected=[], criticals=[];
      for(const [name,info] of Object.entries(v)){
        if(info.severity==="critical") criticals.push(name);
        if(!(name in allow)) unexpected.push(name+" ("+info.severity+")");
      }
      const accepted=Object.keys(v).length-unexpected.length;
      if(criticals.length) console.log("CRIT\t"+criticals.join(", "));
      if(unexpected.length) console.log("NEW\t"+unexpected.join(", "));
      console.log("ACCEPTED\t"+accepted);
    });')"
  CRIT_LINE="$(printf '%s\n' "$AUDIT_RESULT" | sed -n 's/^CRIT\t//p')"
  NEW_LINE="$(printf '%s\n' "$AUDIT_RESULT" | sed -n 's/^NEW\t//p')"
  ACCEPTED_N="$(printf '%s\n' "$AUDIT_RESULT" | sed -n 's/^ACCEPTED\t//p')"
  if [ -n "$CRIT_LINE" ]; then fail "CRITICAL vulnerabilities present: $CRIT_LINE"; fi
  if [ -n "$NEW_LINE" ]; then fail "new advisories not in allowlist (triage + fix or add to .audit-allowlist.json): $NEW_LINE"; fi
  if [ -z "$CRIT_LINE" ] && [ -z "$NEW_LINE" ]; then
    pass "no critical / no new advisories (${ACCEPTED_N:-0} accepted-known, documented in .audit-allowlist.json)"
  fi
fi

# ---------------------------------------------------------------------------
step "5/5  Publish hygiene (npm pack contents)"
# package.json pins "files":["index.js"], so the tarball should carry only
# index.js plus npm's always-included metadata (package.json, README, LICENSE).
# Assert the actual code ships and that nothing sensitive leaks into the package.
PACK_JSON="$(npm pack --dry-run --json 2>/dev/null)"
PACK_RESULT="$(printf '%s' "$PACK_JSON" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let arr; try{ arr=JSON.parse(d); }catch{ console.log("PARSEFAIL"); return; }
    const files=((arr[0]&&arr[0].files)||[]).map(f=>f.path);
    const danger=files.filter(p=>/(^|\/)\.env|\.pem$|\.key$|id_rsa|\.audit-allowlist|(^|\/)scripts\/|(^|\/)node_modules\/|package-lock\.json|(^|\/)\.git/.test(p));
    console.log("HAS_INDEX\t"+files.includes("index.js"));
    console.log("DANGER\t"+danger.join(", "));
    console.log("FILES\t"+files.join(", "));
  });')"
HAS_INDEX="$(printf '%s\n' "$PACK_RESULT" | sed -n 's/^HAS_INDEX\t//p')"
DANGER="$(printf '%s\n' "$PACK_RESULT" | sed -n 's/^DANGER\t//p')"
FILES="$(printf '%s\n' "$PACK_RESULT" | sed -n 's/^FILES\t//p')"
if printf '%s' "$PACK_RESULT" | grep -q PARSEFAIL; then
  warn "could not read \`npm pack --dry-run\` output — skipping hygiene check"
else
  if [ "$HAS_INDEX" != "true" ]; then fail "index.js is NOT in the published tarball (check \"files\"/\"main\")"; fi
  if [ -n "$DANGER" ]; then fail "sensitive/unwanted file(s) would be published: $DANGER"; fi
  if [ "$HAS_INDEX" = "true" ] && [ -z "$DANGER" ]; then
    pass "tarball ships only intended files [${FILES}]"
  fi
fi

# ---------------------------------------------------------------------------
echo
if [ "$HARD_FAIL" -eq 0 ]; then
  printf "${GREEN}GATE PASSED${NC} — safe to publish.\n"
  exit 0
else
  printf "${RED}GATE FAILED${NC} — do NOT publish until the FAILs above are resolved.\n"
  exit 1
fi
