#!/usr/bin/env bash
# ============================================================
#  Quarc Reader — Full System Diagnostic
#  Run from the project root: bash check.sh
# ============================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

PASS=0; WARN=0; FAIL=0; FAILURES=()

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; PASS=$((PASS+1)); }
warn() { printf "  ${YELLOW}⚠${NC} %s\n" "$1"; WARN=$((WARN+1)); }
fail() { printf "  ${RED}✗${NC} %s\n" "$1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
info() { printf "  ${DIM}·${NC} %s\n" "$1"; }
hdr()  { printf "\n${BOLD}${CYAN}── %s ${NC}\n" "$*"; }

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true
  set +a
else
  warn "No .env file found in current directory"
fi

HTTPS_PORT=${HTTPS_PORT:-4008}
BASE="https://localhost:${HTTPS_PORT}"
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT

PROJECT=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g')
cid() { docker ps -q \
  --filter "label=com.docker.compose.project=${PROJECT}" \
  --filter "label=com.docker.compose.service=$1" | head -1; }
dexec() { local c; c=$(cid "$1"); shift; [ -n "$c" ] && docker exec -i "$c" "$@" || echo ""; }

printf "\n${BOLD}Quarc Reader — System Diagnostic${NC}  $(date '+%Y-%m-%d %H:%M:%S')\n"
if ! docker info &>/dev/null 2>&1; then
  printf "  ${RED}✗ Docker not accessible — re-run as root: sudo bash check.sh${NC}\n\n"
  exit 1
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Docker Containers"
# ════════════════════════════════════════════════════════════════════════

for svc in backend frontend; do
  CID=$(docker ps -q --filter "label=com.docker.compose.service=${svc}" | head -1)
  if [ -z "$CID" ]; then
    CID_ANY=$(docker ps -aq --filter "label=com.docker.compose.service=${svc}" | head -1)
    [ -n "$CID_ANY" ] && fail "$svc: exists but is stopped/exited" \
                      || fail "$svc: container not found (never started?)"
    continue
  fi
  STATE=$(docker inspect --format '{{.State.Status}}' "$CID" 2>/dev/null || echo "unknown")
  if [ "$STATE" = "running" ]; then ok "$svc: running"; else fail "$svc: state=${STATE}"; fi
done

QA_CID=$(docker ps -q --filter "name=quarc-auth" | head -1)
if [ -n "$QA_CID" ]; then
  ok "quarc-auth: running (shared login service)"
else
  fail "quarc-auth: not running — logins will fail. See Quarc_Store/auth/README.md"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Network & HTTPS"
# ════════════════════════════════════════════════════════════════════════

HTTPS_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/" 2>/dev/null || echo 0)
if [ "$HTTPS_CODE" = "200" ]; then
  ok "HTTPS:${HTTPS_PORT} serving frontend (200)"
else
  fail "HTTPS:${HTTPS_PORT} not responding (got: ${HTTPS_CODE})"
fi

CERT_EXP=$(echo | openssl s_client -connect "localhost:${HTTPS_PORT}" \
  -servername localhost 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || echo "")
if [ -n "$CERT_EXP" ]; then
  EXP_EPOCH=$(date -d "$CERT_EXP" +%s 2>/dev/null || echo 0)
  DAYS_LEFT=$(( (EXP_EPOCH - $(date +%s)) / 86400 ))
  if [ "$DAYS_LEFT" -gt 14 ]; then ok "TLS certificate valid for ${DAYS_LEFT} more days"
  elif [ "$DAYS_LEFT" -gt 0 ]; then warn "TLS certificate expires in ${DAYS_LEFT} days — renew it (tailscale cert)"
  else fail "TLS certificate has expired"; fi
else
  warn "Could not read the TLS certificate"
fi

for path in /sw.js /manifest.json /logo.png; do
  C=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}${path}" 2>/dev/null || echo 0)
  [ "$C" = "200" ] && ok "${path} served" || fail "${path} not served (got ${C})"
done
# A share link is a client-side route: nginx must hand it to the app, not 404.
C=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/s/some-token" 2>/dev/null || echo 0)
[ "$C" = "200" ] && ok "/s/<token> share-link route is served by the app" || fail "/s/<token> returned ${C} (nginx should fall back to index.html)"
# pdf.js's character maps and standard fonts are needed for some PDFs.
C=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/pdfjs/standard_fonts/FoxitSans.pfb" 2>/dev/null || echo 0)
[ "$C" = "200" ] && ok "pdf.js fonts and character maps are bundled" || fail "pdf.js assets missing (/pdfjs/...) — rebuild the frontend"

# ════════════════════════════════════════════════════════════════════════
hdr "Shared login (JWT)"
# ════════════════════════════════════════════════════════════════════════

AUTH_SECRET=$(docker exec quarc-auth printenv JWT_SECRET 2>/dev/null || echo "")
MY_SECRET=$(dexec backend printenv JWT_SECRET)
if [ -z "$AUTH_SECRET" ]; then
  warn "Could not read quarc-auth's JWT_SECRET to compare"
elif [ "$AUTH_SECRET" = "$MY_SECRET" ]; then
  ok "JWT_SECRET matches quarc-auth"
else
  fail "JWT_SECRET does NOT match quarc-auth — every request will be rejected. Copy it from Quarc_Store/auth/.env"
fi
[ "$MY_SECRET" = "insecure-default-change-in-production" ] && fail "JWT_SECRET is still the insecure default"

# ════════════════════════════════════════════════════════════════════════
hdr "API"
# ════════════════════════════════════════════════════════════════════════

H=$(curl -sk --max-time 5 "${BASE}/api/health" 2>/dev/null)
echo "$H" | grep -q '"ok":true' && ok "/api/health" || fail "/api/health did not answer ok (${H:-no response})"
for p in /api/sync/pull /api/files/usage /api/shares; do
  C=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}${p}" 2>/dev/null || echo 0)
  [ "$C" = "401" ] && ok "${p} requires a login (401)" || fail "${p} answered ${C} without a login — expected 401"
done
C=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/api/public/shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" 2>/dev/null || echo 0)
[ "$C" = "404" ] && ok "an unknown share link is a 404 (and reveals nothing)" || fail "unknown share link answered ${C}"

# ════════════════════════════════════════════════════════════════════════
hdr "Database and files"
# ════════════════════════════════════════════════════════════════════════

BACKEND=$(cid backend)
if [ -n "$BACKEND" ]; then
  INTEGRITY=$(dexec backend node -e "const d=require('/app/src/db').getDb();console.log(d.pragma('integrity_check',{simple:true}))" 2>/dev/null)
  [ "$INTEGRITY" = "ok" ] && ok "database integrity_check: ok" || fail "database integrity_check: ${INTEGRITY:-unreadable}"

  COUNTS=$(dexec backend node -e "
    const d=require('/app/src/db').getDb();
    const n=(t,w='')=>d.prepare('SELECT COUNT(*) c FROM '+t+' '+w).get().c;
    console.log([n('documents','WHERE is_deleted=0'),n('documents','WHERE is_deleted=1'),n('annotations'),n('files'),n('shares','WHERE revoked_at IS NULL')].join(' '))" 2>/dev/null)
  set -- $COUNTS
  info "documents: ${1:-?} (+${2:-?} in trash) · annotated pages: ${3:-?} · files: ${4:-?} · live share links: ${5:-?}"

  # Every file the database lists must exist on disk with the recorded size.
  MISSING=$(dexec backend node -e "
    const fs=require('fs');const {filePath}=require('/app/src/services/fileStore');
    const d=require('/app/src/db').getDb();
    let bad=0;
    for(const f of d.prepare('SELECT user_id,sha256,size FROM files').all()){
      try{ if(fs.statSync(filePath(f.user_id,f.sha256)).size!==f.size) bad++; }catch{ bad++; }
    }
    console.log(bad)" 2>/dev/null)
  [ "${MISSING:-?}" = "0" ] && ok "every stored PDF exists on disk with the right size" || fail "${MISSING:-?} stored PDF(s) are missing or damaged on disk (restore files/ from a backup)"

  # A document whose file never arrived (upload interrupted for good).
  PENDING=$(dexec backend node -e "
    const d=require('/app/src/db').getDb();
    console.log(d.prepare('SELECT COUNT(*) c FROM documents WHERE is_deleted=0 AND file_sha256 IS NOT NULL AND file_sha256 NOT IN (SELECT sha256 FROM files WHERE user_id=documents.user_id)').get().c)" 2>/dev/null)
  [ "${PENDING:-0}" = "0" ] && ok "no document is waiting for an upload that never finished" || warn "${PENDING} document(s) have no file on the server yet (the device that added them has to finish uploading)"

  PARTS=$(dexec backend sh -c 'ls /app/data/uploads 2>/dev/null | wc -l')
  [ "${PARTS:-0}" = "0" ] && ok "no half-finished uploads" || info "${PARTS} upload(s) in progress or interrupted (stale ones are removed after 24 h)"

  USED=$(dexec backend sh -c 'du -sh /app/data 2>/dev/null | cut -f1')
  info "data volume: ${USED:-?}"
  FREE=$(dexec backend sh -c "df -P /app/data | awk 'NR==2{print \$5}'" | tr -d '%')
  if [ -n "$FREE" ] && [ "$FREE" -ge 90 ] 2>/dev/null; then fail "the disk is ${FREE}% full — uploads will fail"
  elif [ -n "$FREE" ] && [ "$FREE" -ge 80 ] 2>/dev/null; then warn "the disk is ${FREE}% full"
  elif [ -n "$FREE" ]; then ok "disk usage ${FREE}%"; fi
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Summary"
# ════════════════════════════════════════════════════════════════════════

printf "\n  ${GREEN}%d passed${NC}  ${YELLOW}%d warnings${NC}  ${RED}%d failed${NC}\n\n" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf "${BOLD}Failures:${NC}\n"
  for f in "${FAILURES[@]}"; do printf "  ${RED}✗${NC} %s\n" "$f"; done
  echo
  exit 1
fi
exit 0
