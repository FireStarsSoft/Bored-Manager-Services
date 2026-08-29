#!/usr/bin/env bash
# Install, update or remove BoredAgent on this machine.
#
# Three phases, in this order and never out of it:
#
#   0. Preflight  - read-only. Nothing is changed. A required check that fails
#                   stops the script before it has touched anything, so a
#                   machine that cannot run the agent is left exactly as it was.
#   1. Install    - eight numbered steps, each printing what it did.
#   2. Result     - a fixed block, printed whether it succeeded or failed, so
#                   there is always something to paste when asking for help.
#
# Run: sudo bash agent-install.sh [--uninstall|--purge] [--yes]

set -u
set -o pipefail

APP_DIR=/opt/boredagent
CONFIG_DIR=/etc/boredagent
STATE_DIR=/var/lib/boredagent
UNIT_FILE=/etc/systemd/system/boredagent.service
CLI_LINK=/usr/local/bin/boredagent
SERVICE_USER=boredagent
PORT=8741
TOTAL_STEPS=8

MODE=install
ASSUME_YES=0
FAILED_STEP=""
RESULT=FAILED
TOKEN_TO_PRINT=""

# ---------------------------------------------------------------- appearance

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_BAD=$'\033[31m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
else
  C_RESET=; C_OK=; C_WARN=; C_BAD=; C_DIM=; C_BOLD=
fi

OK_COUNT=0; WARN_COUNT=0; FAIL_COUNT=0

check() {
  # check <required 0|1> <label> <result OK|FAIL|WARN|SKIP> [detail]
  local required="$1" label="$2" state="$3" detail="${4:-}"
  local dots
  dots=$(printf '%*s' $((34 - ${#label})) '' | tr ' ' '.')
  [ ${#label} -ge 34 ] && dots=""
  local colour="$C_OK"
  case "$state" in
    FAIL) colour="$C_BAD"; FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    WARN) colour="$C_WARN"; WARN_COUNT=$((WARN_COUNT + 1)) ;;
    SKIP) colour="$C_DIM" ;;
    *)    OK_COUNT=$((OK_COUNT + 1)) ;;
  esac
  printf '[CHECK] %s %s %s%s%s' "$label" "$dots" "$colour" "$state" "$C_RESET"
  [ -n "$detail" ] && printf ' - %s' "$detail"
  printf '\n'
  if [ "$state" = FAIL ] && [ "$required" = 1 ]; then
    REQUIRED_FAILED=1
  fi
}

step() {
  printf '\n%s==> [%d/%d] %s%s\n' "$C_BOLD" "$1" "$TOTAL_STEPS" "$2" "$C_RESET"
}

die_step() {
  FAILED_STEP="$1"
  printf '%s    failed: %s%s\n' "$C_BAD" "$2" "$C_RESET"
  finish
  exit 1
}

# ------------------------------------------------------------------ arguments

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE=uninstall ;;
    --purge)     MODE=purge ;;
    --yes|-y)    ASSUME_YES=1 ;;
    --help|-h)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      printf 'Unknown option: %s (try --help)\n' "$arg" >&2
      exit 2 ;;
  esac
done

# Where this script was run from, so it can find the tree to copy.
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR=$SCRIPT_DIR
# Support both `agent/install/agent-install.sh` and a copy sitting beside the
# package, so the script works from a checkout and from an unpacked tarball.
if [ -d "$SCRIPT_DIR/../boredagent" ]; then
  SOURCE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
elif [ -d "$SCRIPT_DIR/boredagent" ]; then
  SOURCE_DIR=$SCRIPT_DIR
fi

# --------------------------------------------------------------- final block

lan_url() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip" ] && printf 'http://%s:%s' "$ip" "$PORT" || printf '(no LAN address found)'
}

finish() {
  local service_state health
  service_state=$(systemctl is-active boredagent 2>/dev/null || echo inactive)
  if curl -sf -m 3 "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
    health=OK
  else
    health=FAIL
  fi
  printf '\n'
  printf '========== KET QUA CAI DAT BOREDAGENT ==========\n'
  if [ "$RESULT" = SUCCESS ]; then
    printf 'Ket qua     : %sSUCCESS%s\n' "$C_OK" "$C_RESET"
  else
    printf 'Ket qua     : %sFAILED%s%s\n' "$C_BAD" "$C_RESET" \
      "${FAILED_STEP:+ (buoc: $FAILED_STEP)}"
  fi
  printf 'Service     : %s\n' "$service_state"
  printf 'Health HTTP : %s\n' "$health"
  printf 'Bind        : 0.0.0.0:%s\n' "$PORT"
  printf 'URL LAN     : %s\n' "$(lan_url)"
  printf 'Token file  : %s\n' "$CONFIG_DIR/token"
  if [ -n "$TOKEN_TO_PRINT" ]; then
    printf 'Token       : %s%s%s\n' "$C_BOLD" "$TOKEN_TO_PRINT" "$C_RESET"
    printf '              (shown once - it is also in the file above)\n'
  fi
  printf 'CLI         : %s\n' "$CLI_LINK"
  printf 'Lenh ke     : boredagent status\n'
  printf '              boredagent net\n'
  printf '              journalctl -u boredagent -f\n'
  printf 'UFW goi y   : sudo ufw allow from 192.168.0.0/16 to any port %s proto tcp\n' "$PORT"
  printf '===============================================\n'
}

# ------------------------------------------------------------------ uninstall

if [ "$MODE" = uninstall ] || [ "$MODE" = purge ]; then
  if [ "$(id -u)" -ne 0 ]; then
    printf 'This has to run as root: sudo bash %s --%s\n' "$0" "$MODE" >&2
    exit 1
  fi
  printf '%sRemoving BoredAgent (%s)%s\n' "$C_BOLD" "$MODE" "$C_RESET"
  # The containers and units this agent installed are NOT touched. Removing the
  # manager is not the same as removing what it manages, and a household that
  # reinstalls tomorrow should not have to set every platform up again.
  printf '%sNote: containers and units installed through the agent are left running.%s\n' \
    "$C_DIM" "$C_RESET"
  systemctl disable --now boredagent >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload >/dev/null 2>&1 || true
  rm -f "$CLI_LINK"
  rm -rf "$APP_DIR"
  if [ "$MODE" = purge ]; then
    rm -rf "$CONFIG_DIR" "$STATE_DIR"
    printf 'Removed %s, %s, %s, %s\n' "$APP_DIR" "$CONFIG_DIR" "$STATE_DIR" "$UNIT_FILE"
  else
    printf 'Removed %s and %s. Kept %s and %s.\n' "$APP_DIR" "$UNIT_FILE" "$CONFIG_DIR" "$STATE_DIR"
  fi
  exit 0
fi

# ------------------------------------------------------- phase 0: preflight

printf '%s========== PHA 0: PREFLIGHT (khong thay doi gi) ==========%s\n\n' "$C_BOLD" "$C_RESET"
REQUIRED_FAILED=0

if [ "$(id -u)" -eq 0 ]; then
  check 1 "Root / sudo" OK
else
  check 1 "Root / sudo" FAIL "run it as: sudo bash $0"
fi

if [ -r /etc/os-release ]; then
  . /etc/os-release
  case "${ID_LIKE:-$ID}" in
    *debian*|debian|ubuntu) check 1 "Debian-family OS" OK "${PRETTY_NAME:-$ID}" ;;
    *) check 1 "Debian-family OS" FAIL "${PRETTY_NAME:-$ID} - this installer only knows apt" ;;
  esac
  if [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = "24.04" ]; then
    check 0 "Ubuntu 24.04" OK
  else
    check 0 "Ubuntu 24.04" WARN "${PRETTY_NAME:-unknown} - untested, installing anyway"
  fi
else
  check 1 "Debian-family OS" FAIL "/etc/os-release is missing"
fi

ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
case "$ARCH" in
  amd64|x86_64|arm64|aarch64) check 1 "Architecture" OK "$ARCH" ;;
  *) check 1 "Architecture" FAIL "$ARCH is not amd64 or arm64" ;;
esac

if command -v systemctl >/dev/null 2>&1; then
  check 1 "systemctl" OK
else
  check 1 "systemctl" FAIL "this agent runs as a systemd service"
fi

if command -v python3 >/dev/null 2>&1; then
  PY_VERSION=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 0.0)
  PY_MAJOR=${PY_VERSION%%.*}; PY_MINOR=${PY_VERSION##*.}
  if [ "${PY_MAJOR:-0}" -ge 3 ] && [ "${PY_MINOR:-0}" -ge 12 ]; then
    check 0 "Python >= 3.12" OK "$PY_VERSION"
  else
    check 0 "Python >= 3.12" WARN "$PY_VERSION - step 1 will try to install a newer one"
  fi
else
  check 0 "Python >= 3.12" WARN "absent - step 1 will install it"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    check 0 "Docker daemon" OK
  else
    check 0 "Docker daemon" WARN "installed but not answering - container templates will not work until it is"
  fi
else
  check 0 "Docker" WARN "absent - step 1 installs docker.io; host-native templates work without it"
fi

command -v curl >/dev/null 2>&1 \
  && check 0 "curl" OK \
  || check 0 "curl" WARN "absent - step 1 installs it (the health check needs it)"

if command -v ss >/dev/null 2>&1; then
  check 0 "ss (iproute2)" OK
else
  check 0 "ss (iproute2)" WARN "absent - per-process bandwidth for host units will read as unknown"
fi

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"; then
  check 0 "Port $PORT free" WARN "something is already listening - an existing agent will be replaced"
else
  check 0 "Port $PORT free" OK
fi

WRITABLE_OK=1
for dir in /opt /var/lib /etc; do
  [ -w "$dir" ] || WRITABLE_OK=0
done
[ "$WRITABLE_OK" = 1 ] \
  && check 1 "Writable /opt /var/lib /etc" OK \
  || check 1 "Writable /opt /var/lib /etc" FAIL "run as root"

FREE_MB=$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${FREE_MB:-}" ] && [ "$FREE_MB" -ge 300 ]; then
  check 0 "Free space >= 300 MB" OK "${FREE_MB} MB"
else
  check 0 "Free space >= 300 MB" WARN "${FREE_MB:-unknown} MB"
fi

if [ -d "$SOURCE_DIR/boredagent" ] && [ -f "$SOURCE_DIR/requirements.txt" ]; then
  check 1 "Agent source found" OK "$SOURCE_DIR"
else
  check 1 "Agent source found" FAIL "no boredagent/ next to $SCRIPT_DIR"
fi

if ping -4 -c 1 -W 1 1.1.1.1 >/dev/null 2>&1; then
  check 0 "Internet" OK
else
  check 0 "Internet" WARN "1.1.1.1 did not answer - apt and image pulls may fail"
fi

printf '\n%d OK, %d warning(s), %d failure(s)\n' "$OK_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
if [ "$REQUIRED_FAILED" = 1 ]; then
  printf '\n%sA required check failed. Nothing has been changed on this machine.%s\n' "$C_BAD" "$C_RESET"
  exit 1
fi

# --------------------------------------------------------- phase 1: install

printf '\n%s========== PHA 1: CAI DAT ==========%s\n' "$C_BOLD" "$C_RESET"

step 1 "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update || die_step 1 "apt-get update failed"
PACKAGES="python3-venv python3-pip dnsutils iputils-ping curl iproute2"
command -v docker >/dev/null 2>&1 || PACKAGES="$PACKAGES docker.io"
apt-get install -y $PACKAGES || die_step 1 "could not install: $PACKAGES"
if ! docker info >/dev/null 2>&1; then
  printf '%s    Docker is installed but not answering - container templates will not run yet.%s\n' \
    "$C_WARN" "$C_RESET"
fi

step 2 "Creating the service user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  printf '    %s already exists\n' "$SERVICE_USER"
else
  useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" \
    || die_step 2 "useradd failed"
fi
getent group docker >/dev/null 2>&1 && usermod -aG docker "$SERVICE_USER"
mkdir -p "$STATE_DIR" || die_step 2 "could not create $STATE_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
chmod 0750 "$STATE_DIR"

step 3 "Copying the agent to $APP_DIR"
mkdir -p "$APP_DIR" || die_step 3 "could not create $APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '__pycache__' --exclude '.git' --exclude 'venv' --exclude 'tests' \
    "$SOURCE_DIR/boredagent" "$SOURCE_DIR/requirements.txt" "$SOURCE_DIR/pyproject.toml" \
    "$APP_DIR/" || die_step 3 "rsync failed"
else
  rm -rf "$APP_DIR/boredagent"
  cp -r "$SOURCE_DIR/boredagent" "$APP_DIR/" || die_step 3 "copy failed"
  cp "$SOURCE_DIR/requirements.txt" "$SOURCE_DIR/pyproject.toml" "$APP_DIR/" 2>/dev/null || true
  find "$APP_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
fi
chown -R root:root "$APP_DIR/boredagent"

step 4 "Building the virtual environment"
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
  python3 -m venv "$APP_DIR/venv" || die_step 4 "python3 -m venv failed"
fi
"$APP_DIR/venv/bin/pip" install --upgrade pip || die_step 4 "pip could not update itself"
"$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" \
  || die_step 4 "dependencies could not be installed"

step 5 "Token and configuration"
mkdir -p "$CONFIG_DIR" || die_step 5 "could not create $CONFIG_DIR"
chmod 0755 "$CONFIG_DIR"
if [ -s "$CONFIG_DIR/token" ]; then
  printf '    keeping the existing token (an update must not lock out a manager)\n'
else
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$CONFIG_DIR/token" || die_step 5 "could not generate a token"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CONFIG_DIR/token" \
      || die_step 5 "could not generate a token"
  fi
  TOKEN_TO_PRINT=$(cat "$CONFIG_DIR/token")
fi
# Owned by root, readable by the service group and nobody else. The service
# runs as `boredagent`, so it has to be able to read this - 0600 root:root
# would mean the daemon could not start. Group ownership rather than an ACL
# keeps it working on a filesystem mounted without ACL support.
chown "root:$SERVICE_USER" "$CONFIG_DIR/token"
chmod 0640 "$CONFIG_DIR/token"

if [ -f "$CONFIG_DIR/config.toml" ]; then
  printf '    keeping the existing config.toml\n'
else
  cp "$SOURCE_DIR/config/config.example.toml" "$CONFIG_DIR/config.toml" \
    || die_step 5 "could not write config.toml"
  chmod 0644 "$CONFIG_DIR/config.toml"
fi

step 6 "Installing the systemd unit"
cp "$SOURCE_DIR/systemd/boredagent.service" "$UNIT_FILE" || die_step 6 "could not write $UNIT_FILE"
chmod 0644 "$UNIT_FILE"
systemctl daemon-reload || die_step 6 "systemctl daemon-reload failed"

step 7 "Linking the CLI and starting the service"
ln -sf "$APP_DIR/venv/bin/boredagent" "$CLI_LINK" 2>/dev/null || true
if [ ! -x "$CLI_LINK" ]; then
  # The console script only exists if the package was pip-installed into the
  # venv; a plain requirements install has not produced one, so wrap `-m`.
  cat > "$CLI_LINK" <<WRAPPER
#!/bin/sh
exec $APP_DIR/venv/bin/python -m boredagent "\$@"
WRAPPER
  chmod 0755 "$CLI_LINK"
fi
systemctl enable --now boredagent || die_step 7 "the service would not start"

step 8 "Waiting for the health check"
HEALTHY=0
for _ in $(seq 1 15); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "$HEALTHY" != 1 ]; then
  printf '%s    the service did not answer within 15s. Recent log:%s\n' "$C_BAD" "$C_RESET"
  journalctl -u boredagent -n 20 --no-pager 2>/dev/null || true
  die_step 8 "no answer on http://127.0.0.1:$PORT/v1/health"
fi
printf '    healthy\n'

RESULT=SUCCESS
finish
exit 0
