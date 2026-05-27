#!/usr/bin/env bash
# Local test harness for hsh-deploy.sh — uses local bare git repos +
# mocked external CLIs. No real GitHub/Cloudflare/Pinata/Hetzner side-effects.
# Runs hsh-deploy.sh TWICE to verify idempotency.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/hsh-deploy.sh"
[[ -x "$DEPLOY_SCRIPT" ]] || { echo "✗ $DEPLOY_SCRIPT not executable"; exit 1; }

MOCK_DIR="$(mktemp -d)"
TEST_LOG_1="$MOCK_DIR/run1.log"
TEST_LOG_2="$MOCK_DIR/run2.log"
STATE_DIR="$MOCK_DIR/state"
BARE_DIR="$MOCK_DIR/bares"
mkdir -p "$STATE_DIR" "$BARE_DIR"

cleanup() { rm -rf "$MOCK_DIR"; }
# Cleanup is enabled — comment out below if debugging
trap cleanup EXIT

REAL_GIT="$(command -v git)"

# ── Seed bare repos ──────────────────────────────────────────
"$REAL_GIT" init --bare "$BARE_DIR/test-svc.git" --quiet --initial-branch=main
"$REAL_GIT" init --bare "$BARE_DIR/fork-test-svc.git" --quiet --initial-branch=main

seed_tmp="$MOCK_DIR/seed-test-svc"
"$REAL_GIT" clone "$BARE_DIR/test-svc.git" "$seed_tmp" --quiet
(
  cd "$seed_tmp"
  "$REAL_GIT" -c user.email=t@t -c user.name=t commit --allow-empty -m "init" --quiet
  "$REAL_GIT" push origin main --quiet
)
rm -rf "$seed_tmp"

# ── Write mocks directly (kimi-recommended pattern: no $(cat <<EOF)) ────

cat > "$MOCK_DIR/gh" <<'GHEOF'
#!/usr/bin/env bash
# Mock gh CLI — minimal subset for hsh-deploy
STATE_DIR="STATE_DIR_PLACEHOLDER"
BARE_DIR="BARE_DIR_PLACEHOLDER"
REAL_GIT="REAL_GIT_PLACEHOLDER"

case "${1:-}" in
  repo)
    case "${2:-}" in
      view)
        [[ -f "$STATE_DIR/repo_exists" ]] && exit 0 || exit 1
        ;;
      create)
        touch "$STATE_DIR/repo_exists"
        echo "https://github.com/${3:-mock/repo}"
        exit 0
        ;;
      clone)
        slug="${3:-}"
        dest="${4:-$(basename "$slug")}"
        "$REAL_GIT" clone "$BARE_DIR/test-svc.git" "$dest" --quiet
        exit 0
        ;;
      edit|fork|delete) exit 0 ;;
    esac
    ;;
  api)
    if [[ "$*" == *"/user"* ]]; then
      echo '{"login":"testuser","id":12345}'
    elif [[ "$*" == *"has_discussions"* ]]; then
      echo '{"has_discussions":true}'
    else
      echo '{}'
    fi
    exit 0
    ;;
  auth) exit 0 ;;
esac
exit 0
GHEOF
sed -i.bak -e "s|STATE_DIR_PLACEHOLDER|$STATE_DIR|g" \
           -e "s|BARE_DIR_PLACEHOLDER|$BARE_DIR|g" \
           -e "s|REAL_GIT_PLACEHOLDER|$REAL_GIT|g" \
           "$MOCK_DIR/gh"
rm "$MOCK_DIR/gh.bak"
chmod +x "$MOCK_DIR/gh"

cat > "$MOCK_DIR/wrangler" <<'EOF'
#!/usr/bin/env bash
echo "Uploaded mock-worker"
echo "Deployed mock-worker"
echo "  https://mock.workers.dev"
exit 0
EOF
chmod +x "$MOCK_DIR/wrangler"

cat > "$MOCK_DIR/npx" <<'EOF'
#!/usr/bin/env bash
# Forward "npx wrangler" / "npx --yes wrangler@latest" to our wrangler mock
for arg in "$@"; do
  if [[ "$arg" == wrangler* ]]; then
    found=0
    cmd_args=()
    for a in "$@"; do
      if [[ "$found" -eq 1 ]]; then cmd_args+=("$a"); fi
      [[ "$a" == wrangler* ]] && found=1
    done
    exec wrangler "${cmd_args[@]}"
  fi
done
exit 0
EOF
chmod +x "$MOCK_DIR/npx"

cat > "$MOCK_DIR/curl" <<'EOF'
#!/usr/bin/env bash
# Mock curl — return JSON for known URLs, OK otherwise
for arg in "$@"; do
  case "$arg" in
    *pinata.cloud*pinJSONToIPFS*)     echo '{"IpfsHash":"QmTESTCANARY"}'; exit 0 ;;
    *workers.dev/services.json*)       echo '{"count":1,"services":[{"id":"test-svc","name":"TestSvc"}]}'; exit 0 ;;
    *workers.dev*)                     echo "OK"; exit 0 ;;
    *localhost:3000/services*)         echo '[{"id":"test-svc","name":"TestSvc","version":"0.1.0"}]'; exit 0 ;;
    *localhost:3000*)                  echo "OK"; exit 0 ;;
    *broadcasting.hshintelligence.com*) echo "OK"; exit 0 ;;
  esac
done
echo "OK"
exit 0
EOF
chmod +x "$MOCK_DIR/curl"

cat > "$MOCK_DIR/mcp-publisher" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  validate) echo "✅ server.json is valid"; exit 0 ;;
  publish)  echo "✓ Successfully published"; exit 0 ;;
  login)    echo "✓ Successfully logged in"; exit 0 ;;
  *) echo "MCP Registry Publisher Tool"; exit 0 ;;
esac
EOF
chmod +x "$MOCK_DIR/mcp-publisher"

# Stub-only mocks
for cmd in ssh scp rsync pm2 npm; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$MOCK_DIR/$cmd"
  chmod +x "$MOCK_DIR/$cmd"
done

export PATH="$MOCK_DIR:$PATH"

# ── Sanity ─────────────────────────────────────────────────────
echo "=== Mock sanity ==="
for c in gh wrangler npx ssh scp curl mcp-publisher pm2 npm; do
  printf "  %-20s -> %s\n" "$c" "$(command -v "$c")"
done
echo ""

# ── Run script-under-test inside if-guard (kimi pattern: suppresses set -e) ─
run_deploy() {
  local svc_id="$1" log="$2" exit_code=0
  if bash "$DEPLOY_SCRIPT" "$svc_id" "TestSvc" "Test tagline" "Test desc" "test-cat" > "$log" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi
  echo "$exit_code"
}

echo "=== RUN 1: Fresh deploy ==="
RC1=$(run_deploy "test-svc" "$TEST_LOG_1")
if [[ "$RC1" -eq 0 ]]; then
  echo "  Run 1 PASS (exit 0)"
else
  echo "  Run 1 FAIL (exit $RC1)"
  echo "─── tail run1.log ───"
  tail -40 "$TEST_LOG_1"
  exit 1
fi

echo ""
echo "=== RUN 2: Idempotent re-run ==="
RC2=$(run_deploy "test-svc" "$TEST_LOG_2")
if [[ "$RC2" -eq 0 ]]; then
  echo "  Run 2 PASS (exit 0)"
else
  echo "  Run 2 FAIL (exit $RC2)"
  echo "─── tail run2.log ───"
  tail -40 "$TEST_LOG_2"
  exit 1
fi

echo ""
echo "=== Idempotency assertions on Run 2 ==="
FAILED=0
assert_in_run2() {
  if grep -qF "$1" "$TEST_LOG_2"; then echo "  ✓ contains: $1"; else echo "  ✗ MISSING: $1"; FAILED=1; fi
}
assert_not_in_run2() {
  if grep -qF "$1" "$TEST_LOG_2"; then echo "  ✗ UNEXPECTED: $1"; FAILED=1; else echo "  ✓ absent:    $1"; fi
}

assert_in_run2 "Repo already exists, skipping creation"
assert_not_in_run2 "nothing to commit, working tree clean"
assert_not_in_run2 "fatal:"
assert_not_in_run2 "No such file or directory"
assert_not_in_run2 "unbound variable"

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "✓ ALL ASSERTIONS PASSED"
  exit 0
else
  echo "✗ ASSERTIONS FAILED"
  echo ""
  echo "─── full run2.log ───"
  cat "$TEST_LOG_2"
  exit 1
fi
