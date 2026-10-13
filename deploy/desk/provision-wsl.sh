#!/usr/bin/env bash
# Provisions a Vasudev desk on a host that has no cloud-init: a WSL2 Ubuntu distro on an office
# PC, or any bare Ubuntu 24.04 box an operator already reaches as root. It replays the
# provider-neutral parts of deploy/desk/cloud-init.yaml.tmpl (packages, service user, Node/pnpm,
# claude, gog, fork checkout + runtime build, managed Chromium, keyfile, units) and deliberately
# skips everything a cloud host owns: the metadata guard, the swapfile (WSL sizes swap in
# .wslconfig), Tailscale join (done by hand before this script so the operator can reach the box)
# and the desk's openclaw.json + secrets (written by the operator afterwards; the Gateway unit is
# enabled but NOT started here for that reason).
#
# Run it on the target as root, fed over SSH by the operator's checkout:
#   DESK_GIT_REF=<full commit hash or branch> DESK_FORK_REPO_URL=<fork url> \
#     ssh root@<host> 'bash -s' < deploy/desk/provision-wsl.sh
# Idempotent: every step checks what already exists, so a re-run after a network drop resumes.
# Secrets never pass through here; it prints no values.
set -euo pipefail

git_ref="${DESK_GIT_REF:?DESK_GIT_REF: full commit hash or branch to check out}"
repo_url="${DESK_FORK_REPO_URL:?DESK_FORK_REPO_URL: the fork to install, e.g. https://github.com/<owner>/openclaw.git}"
pnpm_pm="${DESK_PNPM_PACKAGE_MANAGER:-}"
root=/opt/openclaw
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "provision-wsl.sh: run as root" >&2; exit 2; }
command -v systemctl >/dev/null && systemctl is-system-running --quiet 2>/dev/null \
  || systemctl is-system-running 2>/dev/null | grep -qx degraded \
  || { echo "provision-wsl.sh: systemd is not running (WSL: set [boot] systemd=true in /etc/wsl.conf and wsl --shutdown)" >&2; exit 2; }

step "packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git jq xvfb x11-utils fonts-liberation \
  fonts-noto-core fonts-noto-color-emoji fonts-dejavu unattended-upgrades sudo rsync >/dev/null
install -m 0644 /dev/stdin /etc/apt/apt.conf.d/51openclaw-desk <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

step "service user and directories"
id openclaw >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/openclaw --shell /usr/sbin/nologin openclaw
install -d -o openclaw -g openclaw -m 0700 /home/openclaw/.openclaw
install -d -o root -g root -m 0755 /var/lib/openclaw
install -d -o root -g root -m 0755 /etc/openclaw/secrets   # files inside are 0600; the service user must traverse the dir

step "Chromium sandbox sysctl (Ubuntu 24.04 AppArmor userns restriction)"
install -m 0644 /dev/stdin /etc/sysctl.d/60-openclaw-desk-chromium.conf <<'EOF'
# Restores Chromium's own sandbox on Ubuntu 24.04+ (see cloud-init.yaml.tmpl for why). Never run
# Chromium with --no-sandbox instead - that disables the sandbox for every renderer.
kernel.apparmor_restrict_unprivileged_userns = 0
EOF
sysctl --system >/dev/null

step "Node 26 + corepack + pnpm"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != 26 ]; then
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors https://deb.nodesource.com/setup_26.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v corepack >/dev/null || npm install -g corepack >/dev/null
corepack enable

step "Claude Code CLI"
if ! command -v claude >/dev/null; then
  npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code >/dev/null
fi
claude --version

step "gog (pinned, checksum-verified)"
if ! command -v gog >/dev/null || [ "$(gog --version 2>/dev/null | grep -o '0\.40\.0' || true)" != 0.40.0 ]; then
  workdir="$(mktemp -d)"
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64) sum=5f73815950f30de4165b7b767103ca45c4950e84a1da601eda5294e9ff94f767 ;;
    arm64) sum=21ca9757f67a573115b517854184561cef6b3b73c21e0f60c72229522c7198ac ;;
    *) echo "provision-wsl.sh: no gog build for $arch" >&2; exit 1 ;;
  esac
  ( cd "$workdir" \
    && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o gogcli.tgz \
         "https://github.com/openclaw/gogcli/releases/download/v0.40.0/gogcli_0.40.0_linux_$arch.tar.gz" \
    && echo "$sum  gogcli.tgz" | sha256sum -c - >/dev/null \
    && tar -xzf gogcli.tgz && install -m 0755 ./gog /usr/local/bin/gog ) \
    || { rm -rf "$workdir"; echo "provision-wsl.sh: gog install failed" >&2; exit 1; }
  rm -rf "$workdir"
fi
gog --version

step "fork checkout at $git_ref"
if [ ! -f "$root/package.json" ]; then
  for attempt in 1 2 3 4; do
    rm -rf "$root"
    if git clone --depth 1 --no-checkout "$repo_url" "$root" \
      && git -C "$root" fetch --depth 1 origin "$git_ref" \
      && git -C "$root" checkout --detach FETCH_HEAD; then
      break
    fi
    echo "checkout attempt $attempt failed, retrying in 30s" >&2
    sleep 30
  done
  test -f "$root/package.json" || { echo "provision-wsl.sh: checkout failed" >&2; exit 1; }
elif [ "$(git -C "$root" rev-parse HEAD)" != "$(git -C "$root" rev-parse --verify -q "$git_ref^{commit}" || echo none)" ]; then
  git -C "$root" fetch --depth 1 origin "$git_ref"
  git -C "$root" checkout --detach FETCH_HEAD
fi
git -C "$root" rev-parse HEAD

step "pnpm (pinned by the checkout's package.json)"
pnpm_pm="${pnpm_pm:-$(node -p "require('$root/package.json').packageManager")}"
corepack prepare "$pnpm_pm" --activate >/dev/null
pnpm --version

step "vasudev / openclaw launchers"
printf '%s\n' '#!/bin/sh' '# Vasudev CLI on a hosted desk: the entry point the Gateway service runs.' \
  'exec /usr/bin/node /opt/openclaw/openclaw.mjs "$@"' > /usr/local/bin/vasudev
chmod 755 /usr/local/bin/vasudev
ln -sf /usr/local/bin/vasudev /usr/local/bin/openclaw

step "install + runtime build"
cd "$root"
npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false \
  pnpm install --frozen-lockfile --ignore-scripts
if [ ! -f "$root/dist/.provision-built-ref" ] || [ "$(cat "$root/dist/.provision-built-ref")" != "$(git rev-parse HEAD)" ]; then
  OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build
  git rev-parse HEAD > "$root/dist/.provision-built-ref"
fi
chown -R root:openclaw "$root"
chmod -R g+rX,o-rwx "$root"
chmod +x "$root/deploy/desk/desk-health.sh"

step "Chromium policies + managed Chromium for the service user"
install -d /etc/chromium/policies/managed /etc/opt/chrome/policies/managed
install -m 0644 "$root/deploy/desk/chromium-policy.json" /etc/chromium/policies/managed/desk.json
install -m 0644 "$root/deploy/desk/chromium-policy.json" /etc/opt/chrome/policies/managed/desk.json
( cd "$root" && npx playwright install-deps chromium >/dev/null )
sudo -H -u openclaw bash -lc "cd $root && npx playwright install chromium" >/dev/null
ls -d /home/openclaw/.cache/ms-playwright/chromium-*/chrome-linux*/chrome

step "credential keyfile (only if absent)"
test -f /etc/openclaw/keyfile || head -c 32 /dev/urandom > /etc/openclaw/keyfile
chown root:openclaw /etc/openclaw/keyfile
chmod 640 /etc/openclaw/keyfile

step "systemd units"
for unit in xvfb.service openclaw-gateway.service desk-health.service desk-health.timer; do
  install -m 0644 "$root/deploy/desk/units/$unit" "/etc/systemd/system/$unit"
done
touch /etc/openclaw/secrets/gateway.env && chmod 600 /etc/openclaw/secrets/gateway.env
systemctl daemon-reload
systemctl enable --now xvfb.service desk-health.timer >/dev/null
systemctl enable openclaw-gateway.service >/dev/null

step "done"
echo "Next: write /home/openclaw/.openclaw/openclaw.json and /etc/openclaw/secrets/gateway-token, then systemctl start openclaw-gateway"
