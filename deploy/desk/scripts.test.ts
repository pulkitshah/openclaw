import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Exercises new-desk.sh, new-desk-oci.sh, roll.sh, migrate-desk.sh, and snapshot.sh against stub `doctl`/`oci`/`ssh`/`tailscale`/`node`
// executables placed ahead of the real PATH in a temp bin dir. Each stub logs its argv (one line
// per invocation) to a log file and, for the handful of calls whose output the scripts actually
// parse, prints canned JSON driven by env vars the test sets per case. `node` is a passthrough
// spy — it logs argv, then execs the real `node` (captured before PATH is overridden) — so
// `render-cloud-init.mjs` really renders; `doctl`/`ssh`/`tailscale` are pure fakes: nothing here
// ever touches a real DigitalOcean account, tailnet, or SSH session.

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_DESK = join(HERE, "new-desk.sh");
const ROLL = join(HERE, "roll.sh");
const ROLL_REMOTE = join(HERE, "remote", "roll-remote.sh");
const SNAPSHOT = join(HERE, "snapshot.sh");
const NEW_DESK_OCI = join(HERE, "new-desk-oci.sh");
const MIGRATE = join(HERE, "migrate-desk.sh");
const NEW_DESK_AZURE = join(HERE, "new-desk-azure.sh");
const PUSH_BUILD = join(HERE, "windows", "push-build.sh");
const REAL_NODE = process.execPath;

const TS_AUTHKEY_SECRET = "tskey-auth-FIXTURE-SECRET-0123456789";
const TG_TOKEN_SECRET = "999999999:FIXTURE-SECRET-telegram-bot-token";

function writeStub(binDir: string, name: string, body: string): void {
  writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** Installs the four stub executables. Each fixture-driven response is read from an env var the
 *  test sets before invoking the script under test; when unset, list-style calls default to an
 *  empty JSON array and mutating calls simply succeed with no output. */
function installStubs(binDir: string): void {
  writeStub(
    binDir,
    "doctl",
    `set -euo pipefail
printf '%s\\n' "doctl $*" >> "\${DOCTL_LOG:?}"
args="$*"
case "$args" in
  "compute ssh-key list -o json")
    printf '%s' "\${DOCTL_SSH_KEY_LIST_JSON:-[]}" ;;
  "compute firewall list -o json")
    printf '%s' "\${DOCTL_FIREWALL_LIST_JSON:-[]}" ;;
  compute\\ firewall\\ create*)
    printf '%s' "\${DOCTL_FIREWALL_CREATE_JSON:-[]}" ;;
  compute\\ droplet\\ create*)
    printf '%s' "\${DOCTL_DROPLET_CREATE_JSON:-[]}" ;;
  "compute droplet list -o json")
    printf '%s' "\${DOCTL_DROPLET_LIST_JSON:-[]}" ;;
  compute\\ snapshot\\ list*)
    printf '%s' "\${DOCTL_SNAPSHOT_LIST_JSON:-[]}" ;;
  *)
    : ;;
esac
exit 0`,
  );

  writeStub(
    binDir,
    "ssh",
    `set -euo pipefail
printf '%s\\n' "ssh $*" >> "\${SSH_LOG:?}"
# roll.sh's mutate step pipes a heredoc script to \`bash -s --\` over ssh instead of putting the
# whole script in argv; capture stdin too so tests can assert on that script's structure. Reading
# stdin is safe even when the caller sent nothing (the busy check) — spawnSync gives every child
# an already-closed stdin pipe by default, so \`cat\` returns immediately with no output.
stdin_content="$(cat)"
if [ -n "$stdin_content" ]; then
  printf '%s\\n' "$stdin_content" >> "\${SSH_LOG:?}"
  if [ -n "\${SSH_STDIN_LOG:-}" ]; then printf '%s\\n' "$stdin_content" >> "$SSH_STDIN_LOG"; fi
fi
# new-desk-azure.sh: the SSH readiness probe must answer "ready" on its own; every other call
# prints the canned SSH_STDOUT (all lines, the script greps for markers) and exits SSH_EXIT_CODE.
case "$*" in
  *"Write-Output ready"*)
    if [ -n "\${SSH_READY_HOSTS:-}" ]; then
      case "$*" in *"$SSH_READY_HOSTS"*) printf 'ready\\n'; exit 0 ;; *) exit 255 ;; esac
    fi
    printf 'ready\\n'; exit 0 ;;
  *"first-boot-fresh"*) printf '%s\\n' "\${SSH_FRESH_BOOT:-first-boot-fresh}"; exit 0 ;;
esac
if [ -n "\${SSH_STDOUT:-}" ]; then
  printf '%s\\n' "$SSH_STDOUT"
  exit "\${SSH_EXIT_CODE:-0}"
fi
remote="\${*: -1}"
case "$remote" in
  *duties.runs.recent*)
    if [ "\${SSH_RUNS_RECENT_EXIT_CODE:-0}" != "0" ]; then
      exit "\${SSH_RUNS_RECENT_EXIT_CODE}"
    fi
    if [ -n "\${SSH_RUNS_RECENT_JSON:-}" ]; then
      printf '%s' "$SSH_RUNS_RECENT_JSON"
    else
      printf '{"runs":[]}'
    fi
    ;;
  # new-desk.sh's post-readiness check for cloud-init's provision-failed marker. A real desk
  # answers non-zero when the marker is absent (the common case), so the stub does too unless the
  # test asks for the failed-provisioning scenario.
  *provision-failed*)
    if [ "\${SSH_PROVISION_FAILED:-0}" = "1" ]; then
      exit 0
    fi
    exit 1
    ;;
  # migrate-desk.sh: both desks' refs (SSH_GIT_REF_MISMATCH makes the target differ), the
  # source's Caddyfile, the target's public IP and tailnet name, and the copy pipeline.
  *"rev-parse HEAD"*)
    if [ "\${SSH_GIT_REF_MISMATCH:-0}" = "1" ] && [ "\${*: -2:1}" = "root@desk-target" ]; then
      printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'
    else
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'
    fi
    ;;
  "test -f /etc/caddy/Caddyfile")
    [ -n "\${SSH_CADDYFILE:-}" ] ;;
  "cat /etc/caddy/Caddyfile")
    printf '%s' "\${SSH_CADDYFILE:-}" ;;
  *api.ipify.org*)
    printf '%s' "\${SSH_PUBLIC_IP:-}" ;;
  *"tailscale status --json"*)
    printf '%s' "\${SSH_TAILSCALE_SELF_JSON:-}" ;;
  *"tar -C / -czf"*)
    exit "\${SSH_COPY_EXIT_CODE:-0}" ;;
  *"ip -4 route get"*)
    printf '%s' "\${SSH_BIND_IP:-}" ;;
  "systemctl disable --now openclaw-gateway")
    if [ "\${*: -2:1}" = "root@desk-target" ]; then exit "\${SSH_TARGET_STOP_EXIT_CODE:-0}"; fi ;;
  # migrate-desk.sh's on-target /healthz wait (a remote loop; the stub answers at once).
  *"/healthz; then exit 0; fi"*)
    exit "\${SSH_TARGET_HEALTH_EXIT_CODE:-0}" ;;
  "uname -m")
    if [ "\${*: -2:1}" = "root@desk-target" ]; then printf '%s' "\${SSH_TARGET_ARCH:-x86_64}"; else printf '%s' "\${SSH_SOURCE_ARCH:-x86_64}"; fi ;;
  *"/home/openclaw/.local/bin/*"*)
    printf '%s' "\${SSH_FOREIGN_BINARIES:-}" ;;
  *)
    : ;;
esac
# This stub never actually executes the piped roll.sh remote script (it only captures it above)
# — so a "the remote build failed" scenario is simulated by exiting with the code the real
# remote script's own recovery path would exit with, on exactly the mutate call ("bash -s --",
# never the busy check, which must keep behaving normally so roll.sh reaches the mutate call at
# all). SSH_ROLL_REMOTE_EXIT_CODE drives which code; unset means the ordinary success path (0).
case "$*" in
  *"bash -s --"*)
    if [ -n "\${SSH_ROLL_REMOTE_EXIT_CODE:-}" ]; then
      exit "\${SSH_ROLL_REMOTE_EXIT_CODE}"
    fi
    ;;
esac
exit 0`,
  );

  writeStub(
    binDir,
    "tailscale",
    `set -euo pipefail
printf '%s\\n' "tailscale $*" >> "\${TAILSCALE_LOG:?}"
if [ "$*" = "status --json" ]; then
  if [ -n "\${TAILSCALE_STATUS_JSON:-}" ]; then
    printf '%s' "$TAILSCALE_STATUS_JSON"
  else
    printf '{}'
  fi
fi
exit 0`,
  );

  // new-desk-oci.sh's launch loop: the first OCI_LAUNCH_FAIL_COUNT `compute instance launch`
  // calls fail the way Oracle's Always Free A1 pool usually does ("Out of host capacity"), then
  // one succeeds with OCI_LAUNCH_JSON. Attempts are counted in a file because each call is a
  // fresh process. Lookups answer the canned JSON the script parses.
  writeStub(
    binDir,
    "oci",
    `set -euo pipefail
printf '%s\\n' "oci $*" >> "\${OCI_LOG:?}"
args="$*"
case "$args" in
  compute\\ instance\\ launch*)
    # Record whether the user-data handed over is gzip (magic 1f 8b): Oracle's 32 KB metadata cap
    # is what the compression exists for, and the stub is the only place that sees the file.
    user_data=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--user-data-file" ]; then user_data="$2"; fi
      shift
    done
    if [ -n "$user_data" ] && [ "$(head -c 2 "$user_data" | od -An -tx1 | tr -d ' \\n')" = "1f8b" ]; then
      printf '%s\\n' "oci user-data is gzip" >> "\${OCI_LOG:?}"
    fi
    count_file="\${OCI_LAUNCH_COUNT_FILE:?}"
    count=0
    if [ -f "$count_file" ]; then count="$(cat "$count_file")"; fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if [ "$count" -le "\${OCI_LAUNCH_FAIL_COUNT:-0}" ]; then
      printf '%s\\n' 'ServiceError:' '{' '    "code": "InternalError",' '    "message": "Out of host capacity.",' '    "status": 500' '}' >&2
      exit 1
    fi
    if [ -n "\${OCI_LAUNCH_FATAL:-}" ]; then
      printf '%s\\n' "$OCI_LAUNCH_FATAL" >&2
      exit 1
    fi
    # The real CLI narrates --wait-for-state on stderr next to the JSON on stdout; a script that
    # parses the two streams together mistakes this success for a failure.
    printf '%s\\n' "Action completed. Waiting until the resource has entered state: ('RUNNING',)" >&2
    printf '%s' "\${OCI_LAUNCH_JSON:-}" ;;
  compute\\ instance\\ list-vnics*)
    printf '%s' "\${OCI_VNICS_JSON:-}" ;;
  iam\\ availability-domain\\ list*)
    printf '%s' "\${OCI_AD_LIST_JSON:-}" ;;
  network\\ subnet\\ list*)
    printf '%s' "\${OCI_SUBNET_LIST_JSON:-}" ;;
  compute\\ image\\ list*)
    printf '%s' "\${OCI_IMAGE_LIST_JSON:-}" ;;
  *)
    : ;;
esac
exit 0`,
  );

  writeStub(
    binDir,
    "node",
    `printf '%s\\n' "node $*" >> "\${NODE_LOG:?}"
exec "\${REAL_NODE:?}" "$@"`,
  );

  // windows/push-build.sh builds with `pnpm build` when dist is stale; the stub only records it.
  writeStub(
    binDir,
    "pnpm",
    `printf '%s\\n' "pnpm $*" >> "\${NODE_LOG:?}"
exit 0`,
  );

  // Simulates new-desk.sh's post-tailnet-join Control UI /healthz poll: fails the first
  // CURL_FAIL_COUNT invocations (default 0, i.e. succeeds immediately), then succeeds. Each
  // script invocation is a fresh process, so the attempt count is persisted to a file.
  writeStub(
    binDir,
    "curl",
    `set -euo pipefail
printf '%s\\n' "curl $*" >> "\${CURL_LOG:?}"
count_file="\${CURL_COUNT_FILE:?}"
count=0
if [ -f "$count_file" ]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
fail_count="\${CURL_FAIL_COUNT:-0}"
if [ "$count" -le "$fail_count" ]; then
  exit 22
fi
exit 0`,
  );
  // new-desk-azure.sh: every `az` call is logged; the handful whose output the script parses
  // answer canned JSON (existence probes exit 3 like the real CLI's "not found"). Canned JSON is
  // single-quoted literal text, never a `\${VAR:-{...}}` default: bash ends such a default at the
  // first unbalanced brace and hands jq a truncated document.
  writeStub(
    binDir,
    "az",
    `set -euo pipefail
printf '%s\\n' "az $*" >> "\${AZ_LOG:?}"
args="$*"
case "$args" in
  "account show"*)            printf '%s' "\${AZ_ACCOUNT_JSON:-}"; [ -n "\${AZ_ACCOUNT_JSON:-}" ] || printf '%s' '{"id":"sub-fixture","state":"Enabled"}' ;;
  "group exists"*)            printf '%s' "\${AZ_GROUP_EXISTS:-false}" ;;
  "network vnet show"*)       if [ "\${AZ_VNET_EXISTS:-0}" = 1 ]; then printf '{"name":"vasudev"}'; else exit 3; fi ;;
  "network nsg show"*)        if [ "\${AZ_NSG_EXISTS:-0}" = 1 ]; then printf '{"name":"vasudev-desks"}'; else exit 3; fi ;;
  "vm show"*)                 if [ "\${AZ_VM_EXISTS:-0}" = 1 ]; then printf '%s' '{"name":"existing"}'; else exit 3; fi ;;
  "vm create"*)               if [ "\${AZ_VM_CREATE_EXIT:-0}" != 0 ]; then echo "az: create failed (fixture)" >&2; exit "\${AZ_VM_CREATE_EXIT}"; fi; printf '%s' '{"publicIpAddress":"20.0.0.5"}' ;;
  "vm list-ip-addresses"*)    printf '%s' '[{"virtualMachine":{"network":{"publicIpAddresses":[{"ipAddress":"20.0.0.5"}]}}}]' ;;
  "vm run-command invoke"*)   printf '%s' "\${AZ_RUN_COMMAND_JSON:-}"; [ -n "\${AZ_RUN_COMMAND_JSON:-}" ] || printf '%s' '{"value":[{"message":"bootstrap-ssh: ok"}]}' ;;
  *) : ;;
esac
exit 0`,
  );
}

type RunResult = { status: number | null; stdout: string; stderr: string };

describe("deploy/desk operator scripts", () => {
  let dir: string;
  let binDir: string;
  let doctlLog: string;
  let ociLog: string;
  let ociLaunchCountFile: string;
  let sshLog: string;
  let tailscaleLog: string;
  let nodeLog: string;
  let curlLog: string;
  let curlCountFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-scripts-test-"));
    binDir = join(dir, "bin");
    mkdirSync(binDir);
    installStubs(binDir);
    doctlLog = join(dir, "doctl.log");
    ociLog = join(dir, "oci.log");
    ociLaunchCountFile = join(dir, "oci-launch-count");
    sshLog = join(dir, "ssh.log");
    tailscaleLog = join(dir, "tailscale.log");
    nodeLog = join(dir, "node.log");
    curlLog = join(dir, "curl.log");
    curlCountFile = join(dir, "curl-count");
    for (const log of [doctlLog, ociLog, sshLog, tailscaleLog, nodeLog, curlLog]) {
      writeFileSync(log, "");
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REAL_NODE,
      DOCTL_LOG: doctlLog,
      OCI_LOG: ociLog,
      OCI_LAUNCH_COUNT_FILE: ociLaunchCountFile,
      SSH_LOG: sshLog,
      TAILSCALE_LOG: tailscaleLog,
      NODE_LOG: nodeLog,
      CURL_LOG: curlLog,
      CURL_COUNT_FILE: curlCountFile,
      // Real new-desk.sh sleeps 10s between /healthz polls; tests shrink that so a
      // several-attempts case doesn't take tens of real seconds.
      DESK_READY_POLL_INTERVAL_SECONDS: "1",
      HOME: process.env.HOME ?? dir,
      ...extra,
    };
  }

  function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: baseEnv(env),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function readLog(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  function allLogsAndOutput(...runs: RunResult[]): string {
    const logs = [
      readLog(doctlLog),
      readLog(ociLog),
      readLog(sshLog),
      readLog(tailscaleLog),
      readLog(nodeLog),
      readLog(curlLog),
    ];
    const outputs = runs.flatMap((r) => [r.stdout, r.stderr]);
    return [...logs, ...outputs].join("\n");
  }

  describe("new-desk.sh", () => {
    let tsAuthkeyFile: string;
    let tgTokenFile: string;
    const deskName = "desk-proof";

    beforeEach(() => {
      tsAuthkeyFile = join(dir, "ts-authkey");
      tgTokenFile = join(dir, "tg-token");
      writeFileSync(tsAuthkeyFile, `${TS_AUTHKEY_SECRET}\n`);
      writeFileSync(tgTokenFile, `${TG_TOKEN_SECRET}\n`);
    });

    function happyPathEnv(extra: Record<string, string> = {}): Record<string, string> {
      return {
        DESK_POLL_SECONDS: "5",
        DESK_SSH_KEY_NAME: "ci-operator-key",
        DOCTL_SSH_KEY_LIST_JSON: JSON.stringify([{ id: "98765", name: "ci-operator-key" }]),
        DOCTL_FIREWALL_LIST_JSON: "[]",
        DOCTL_FIREWALL_CREATE_JSON: JSON.stringify([{ id: "fw-1", name: "desk-no-inbound" }]),
        DOCTL_DROPLET_CREATE_JSON: JSON.stringify([{ id: 555, name: deskName }]),
        TAILSCALE_STATUS_JSON: JSON.stringify({
          MagicDNSSuffix: "tailnet-fixture.ts.net.",
          Peer: { peer1: { HostName: deskName, Online: true } },
        }),
        ...extra,
      };
    }

    it("auto-detects the doctl key whose fingerprint matches a local public key when DESK_SSH_KEY_NAME is unset", () => {
      const home = join(dir, "home");
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(home, ".ssh", "id_fixture.pub"), "ssh-ed25519 AAAAfixture fixture@test\n");
      // ssh-keygen stub: prints the fingerprint line the script parses (`-E md5 -lf <pub>`).
      writeStub(
        binDir,
        "ssh-keygen",
        `printf '%s\\n' "256 MD5:aa:bb:cc:dd:ee:ff fixture@test (ED25519)"`,
      );
      const env = happyPathEnv({
        HOME: home,
        DOCTL_SSH_KEY_LIST_JSON: JSON.stringify([
          { id: "111", name: "someone-elses-key", fingerprint: "11:22:33:44:55:66" },
          { id: "222", name: "this-machine", fingerprint: "aa:bb:cc:dd:ee:ff" },
        ]),
      });
      delete env.DESK_SSH_KEY_NAME;
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        env,
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Using doctl SSH key "this-machine"');
      const createLine = readLog(doctlLog)
        .split("\n")
        .find((line) => line.includes("compute droplet create"));
      expect(createLine).toContain("--ssh-keys 222");
    });

    it("refuses when no doctl key matches a local public key and no name is given", () => {
      const home = join(dir, "home-nomatch");
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(home, ".ssh", "id_fixture.pub"), "ssh-ed25519 AAAAfixture fixture@test\n");
      writeStub(
        binDir,
        "ssh-keygen",
        `printf '%s\\n' "256 MD5:aa:bb:cc:dd:ee:ff fixture@test (ED25519)"`,
      );
      const env = happyPathEnv({
        HOME: home,
        DOCTL_SSH_KEY_LIST_JSON: JSON.stringify([
          { id: "111", name: "someone-elses-key", fingerprint: "11:22:33" },
        ]),
      });
      delete env.DESK_SSH_KEY_NAME;
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        env,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("none of the doctl SSH keys match");
      expect(result.stderr).toContain("someone-elses-key");
      expect(readLog(doctlLog)).not.toContain("compute droplet create");
    });

    it("creates the firewall when missing, creates the droplet with the right doctl args, attaches it, and prints the Control UI URL", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv(),
      );

      expect(result.status).toBe(0);

      const doctlCalls = readLog(doctlLog);
      expect(doctlCalls).toContain("doctl compute ssh-key list -o json");
      expect(doctlCalls).toContain("doctl compute firewall list -o json");
      expect(doctlCalls).toContain("doctl compute firewall create --name desk-no-inbound");
      expect(doctlCalls).toContain("--inbound-rules");
      expect(doctlCalls).toContain("--outbound-rules");
      expect(doctlCalls).toContain("protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0");

      const createLine = doctlCalls
        .split("\n")
        .find((line) => line.includes("compute droplet create"));
      expect(createLine).toBeDefined();
      expect(createLine).toContain(`compute droplet create ${deskName}`);
      expect(createLine).toContain("--region blr1");
      expect(createLine).toContain("--size s-2vcpu-4gb");
      expect(createLine).toContain("--image ubuntu-24-04-x64");
      expect(createLine).toContain("--ssh-keys 98765");
      expect(createLine).toContain("--tag-names desk");
      expect(createLine).toContain("--user-data-file");
      expect(createLine).toContain("--wait");
      expect(createLine).toContain("-o json");

      expect(doctlCalls).toContain("doctl compute firewall add-droplets fw-1 --droplet-ids 555");

      expect(result.stdout).toContain(`Control UI: https://${deskName}.tailnet-fixture.ts.net`);
      // `ssh -t` and `sudo -H` are both load-bearing on this very first operator step:
      // `gateway auth-token --show` refuses to print outside an interactive terminal (no TTY on a
      // plain `ssh host 'cmd'`), and plain `sudo -u openclaw` leaves HOME=/root so the CLI reads
      // /root/.openclaw and dies with "Gateway config is invalid" instead.
      expect(result.stdout).toContain(
        `Sign in:    ssh -t root@${deskName} 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'`,
      );
      expect(result.stdout).not.toContain("'sudo -u openclaw");
    });

    it("does not create a firewall that already exists, but still attaches the droplet to it", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv({
          DOCTL_FIREWALL_LIST_JSON: JSON.stringify([
            { id: "fw-existing", name: "desk-no-inbound" },
          ]),
        }),
      );

      expect(result.status).toBe(0);
      const doctlCalls = readLog(doctlLog);
      expect(doctlCalls).not.toContain("compute firewall create");
      expect(doctlCalls).toContain(
        "doctl compute firewall add-droplets fw-existing --droplet-ids 555",
      );
    });

    it("creates a client desk with no Telegram token or owner target, and says what the client sees first", () => {
      // The owner requirement this profile serves: a client's desk starts like a fresh install,
      // so the two flags that would bake the operator's own channel into it are not needed.
      const result = run(
        NEW_DESK,
        [deskName, "--profile", "client", "--ts-authkey-file", tsAuthkeyFile],
        happyPathEnv(),
      );

      expect(result.status).toBe(0);
      const renderCall = readLog(nodeLog)
        .split("\n")
        .find((line) => line.includes("render-cloud-init.mjs"));
      expect(renderCall).toBeDefined();
      expect(renderCall).toContain("--profile client");
      expect(renderCall).not.toContain("--tg-token-file");
      expect(renderCall).not.toContain("--owner-target");

      expect(result.stdout).toContain(`Control UI: https://${deskName}.tailnet-fixture.ts.net`);
      expect(result.stdout).toContain("Model Setup");
      expect(result.stdout).toContain("Settings > Telegram");
    });

    it("passes a bot token given with --profile client through to the renderer instead of dropping it silently", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--profile",
          "client",
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv(),
      );

      expect(result.status).toBe(0);
      // The renderer owns what each profile configures, and warns there that it goes unused.
      const renderCall = readLog(nodeLog)
        .split("\n")
        .find((line) => line.includes("render-cloud-init.mjs"));
      expect(renderCall).toContain("--tg-token-file");
      expect(result.stderr).toContain("ignoring --tg-token-file");
    });

    it("refuses an unknown --profile, and still requires the bot token and owner target for the owner profile", () => {
      const badProfile = run(
        NEW_DESK,
        [deskName, "--profile", "customer", "--ts-authkey-file", tsAuthkeyFile],
        happyPathEnv(),
      );
      expect(badProfile.status).toBe(2);
      expect(badProfile.stderr).toContain("--profile");
      expect(readLog(doctlLog)).not.toContain("compute droplet create");

      const missingOwnerFlags = run(
        NEW_DESK,
        [deskName, "--ts-authkey-file", tsAuthkeyFile],
        happyPathEnv(),
      );
      expect(missingOwnerFlags.status).toBe(2);
      expect(missingOwnerFlags.stderr).toContain("Usage: new-desk.sh");
      expect(readLog(doctlLog)).not.toContain("compute droplet create");
    });

    it("fails before creating a droplet when the configured SSH key name is not found", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv({ DOCTL_SSH_KEY_LIST_JSON: "[]" }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no doctl SSH key named");
      expect(readLog(doctlLog)).not.toContain("compute droplet create");
    });

    it("never echoes the Tailscale auth key or Telegram bot token to any log or its own output", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv(),
      );

      expect(result.status).toBe(0);
      const everything = allLogsAndOutput(result);
      expect(everything).not.toContain(TS_AUTHKEY_SECRET);
      expect(everything).not.toContain(TG_TOKEN_SECRET);
    });

    it("prints the Control UI URL only once the Gateway starts answering /healthz over the tailnet", () => {
      // Joining the tailnet only means cloud-init's early `tailscale up` step finished — the
      // checkout/install/build/Chromium/reboot happen after that, so the URL must not be
      // printed until the Gateway (behind Tailscale Serve) actually answers.
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv({ CURL_FAIL_COUNT: "2" }),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Control UI: https://${deskName}.tailnet-fixture.ts.net`);
      const curlCalls = readLog(curlLog);
      expect(curlCalls).toContain(`https://${deskName}.tailnet-fixture.ts.net/healthz`);
      expect(curlCalls.split("\n").filter((line) => line.trim().length > 0).length).toBe(3);
    });

    it("exits 4 with a diagnostic ssh command when the Gateway never answers /healthz", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv({
          CURL_FAIL_COUNT: "999999",
          DESK_READY_POLL_SECONDS: "2",
        }),
      );

      expect(result.status).toBe(4);
      expect(result.stdout).not.toContain("Control UI:");
      expect(result.stderr).toContain("never answered");
      expect(result.stderr).toContain(`ssh root@${deskName} journalctl`);
    });

    it("warns when cloud-init left a provision-failed marker, but still prints the URL", () => {
      const args = [
        deskName,
        "--ts-authkey-file",
        tsAuthkeyFile,
        "--tg-token-file",
        tgTokenFile,
        "--owner-target",
        "123456789",
      ];
      // A desk whose managed Chromium (or fork checkout, or Claude CLI) install failed still
      // answers /healthz, so "the Gateway is up" is not "provisioning succeeded" — without this
      // check the failure only surfaced later as a browser step dying mid-Duty.
      const failed = run(NEW_DESK, args, happyPathEnv({ SSH_PROVISION_FAILED: "1" }));
      expect(failed.status).toBe(0);
      expect(failed.stderr).toContain("provision-failed");
      expect(failed.stderr).toContain("browser Duties will fail");
      expect(failed.stdout).toContain(`Desk "${deskName}" is up.`);
      expect(readLog(sshLog)).toContain("test -f /var/lib/openclaw/provision-failed");
    });

    it("says nothing about provisioning when no marker is present", () => {
      const result = run(
        NEW_DESK,
        [
          deskName,
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          "123456789",
        ],
        happyPathEnv(),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("provision-failed");
      expect(result.stdout).toContain(`Desk "${deskName}" is up.`);
    });
  });

  describe("new-desk-oci.sh", () => {
    let tsAuthkeyFile: string;
    const deskName = "desk-oci-proof";
    const instanceId = "ocid1.instance.oc1.ap-mumbai-1.fixtureinstance";

    beforeEach(() => {
      tsAuthkeyFile = join(dir, "ts-authkey");
      writeFileSync(tsAuthkeyFile, `${TS_AUTHKEY_SECRET}\n`);
      // The script embeds a local public key; point it at a fixture rather than the runner's own.
      writeFileSync(join(dir, "fixture.pub"), "ssh-ed25519 AAAAfixture fixture@test\n");
    });

    function happyPathEnv(extra: Record<string, string> = {}): Record<string, string> {
      return {
        DESK_POLL_SECONDS: "5",
        DESK_OCI_RETRY_SECONDS: "0",
        DESK_OCI_COMPARTMENT_ID: "ocid1.tenancy.oc1..fixture",
        DESK_SSH_PUBLIC_KEY: join(dir, "fixture.pub"),
        OCI_AD_LIST_JSON: JSON.stringify({ data: [{ name: "XXXX:AP-MUMBAI-1-AD-1" }] }),
        OCI_SUBNET_LIST_JSON: JSON.stringify({ data: [{ id: "ocid1.subnet.oc1..fixture" }] }),
        OCI_IMAGE_LIST_JSON: JSON.stringify({ data: [{ id: "ocid1.image.oc1..fixture" }] }),
        OCI_LAUNCH_JSON: JSON.stringify({ data: { id: instanceId, "lifecycle-state": "RUNNING" } }),
        OCI_VNICS_JSON: JSON.stringify({ data: [{ "public-ip": "10.0.0.5" }] }),
        TAILSCALE_STATUS_JSON: JSON.stringify({
          MagicDNSSuffix: "tailnet-fixture.ts.net.",
          Peer: { peer1: { HostName: deskName, Online: true } },
        }),
        ...extra,
      };
    }

    it("renders the oci cloud-init, launches an A1 instance with it, retries capacity refusals, and prints the Control UI URL", () => {
      const result = run(
        NEW_DESK_OCI,
        [deskName, "--profile", "client", "--ts-authkey-file", tsAuthkeyFile],
        happyPathEnv({ OCI_LAUNCH_FAIL_COUNT: "2" }),
      );
      expect(result.status, result.stderr).toBe(0);

      const nodeCalls = readLog(nodeLog);
      expect(nodeCalls).toContain("render-cloud-init.mjs");
      expect(nodeCalls).toContain("--cloud oci");
      expect(nodeCalls).toContain("--profile client");

      const ociCalls = readLog(ociLog);
      const launches = ociCalls
        .split("\n")
        .filter((line) => line.includes("compute instance launch"));
      expect(launches).toHaveLength(3);
      expect(result.stderr).toContain("attempt 1: Out of host capacity.");
      expect(result.stderr).toContain("attempt 2: Out of host capacity.");
      const launch = launches[2];
      expect(launch).toContain("--shape VM.Standard.A1.Flex");
      expect(launch).toContain('--shape-config {"ocpus":1,"memoryInGBs":6}');
      expect(launch).toContain("--image-id ocid1.image.oc1..fixture");
      expect(launch).toContain("--subnet-id ocid1.subnet.oc1..fixture");
      expect(launch).toContain("--availability-domain XXXX:AP-MUMBAI-1-AD-1");
      expect(launch).toContain(`--display-name ${deskName} --hostname-label ${deskName}`);
      expect(launch).toContain("--assign-public-ip true");
      expect(launch).toContain("--user-data-file ");
      expect(ociCalls).toContain("oci user-data is gzip");
      expect(launch).toContain(`--ssh-authorized-keys-file ${join(dir, "fixture.pub")}`);
      expect(launch).toContain("--boot-volume-size-in-gbs 60");
      expect(launch).toContain("--wait-for-state RUNNING");
      expect(ociCalls).toContain(`compute instance list-vnics --instance-id ${instanceId}`);
      expect(result.stderr).toContain(`Instance ${instanceId} is RUNNING`);

      expect(result.stdout).toContain(`Control UI: https://${deskName}.tailnet-fixture.ts.net`);
      expect(result.stdout).toContain(`ssh -t root@${deskName}`);
      expect(result.stdout).toContain("Public IP:  10.0.0.5");
      expect(result.stdout).toContain("10-0-0-5.sslip.io");
      expect(readLog(curlLog)).toContain(`https://${deskName}.tailnet-fixture.ts.net/healthz`);
      // Secrets never reach argv, stdout or stderr - only the 0600 rendered file, which is gone.
      expect(allLogsAndOutput(result)).not.toContain(TS_AUTHKEY_SECRET);
    });

    it("refuses a shape above the Always Free allowance unless --allow-paid is given", () => {
      const refused = run(
        NEW_DESK_OCI,
        [deskName, "--profile", "client", "--ts-authkey-file", tsAuthkeyFile, "--ocpus", "3"],
        happyPathEnv(),
      );
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("exceeds the Always Free A1 allowance");
      expect(readLog(ociLog)).not.toContain("compute instance launch");
      const bigDisk = run(
        NEW_DESK_OCI,
        [deskName, "--profile", "client", "--ts-authkey-file", tsAuthkeyFile, "--boot-gb", "250"],
        happyPathEnv(),
      );
      expect(bigDisk.status).toBe(2);
      expect(bigDisk.stderr).toContain("block-storage allowance");

      const allowed = run(
        NEW_DESK_OCI,
        [
          deskName,
          "--profile",
          "client",
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--ocpus",
          "3",
          "--memory-gb",
          "18",
          "--allow-paid",
        ],
        happyPathEnv(),
      );
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(readLog(ociLog)).toContain('--shape-config {"ocpus":3,"memoryInGBs":18}');
    });

    it("stops on a launch error that is not a capacity refusal, and gives up when the retry window runs out", () => {
      const fatal = run(
        NEW_DESK_OCI,
        [deskName, "--profile", "client", "--ts-authkey-file", tsAuthkeyFile],
        happyPathEnv({
          OCI_LAUNCH_FATAL: '{"code": "LimitExceeded", "message": "boot volume quota"}',
        }),
      );
      expect(fatal.status).toBe(1);
      expect(fatal.stderr).toContain("launch failed");
      expect(fatal.stderr).toContain("LimitExceeded");
      expect(
        readLog(ociLog)
          .split("\n")
          .filter((l) => l.includes("compute instance launch")),
      ).toHaveLength(1);

      writeFileSync(ociLaunchCountFile, "0");
      const gaveUp = run(
        NEW_DESK_OCI,
        [
          deskName,
          "--profile",
          "client",
          "--ts-authkey-file",
          tsAuthkeyFile,
          "--retry-minutes",
          "0",
        ],
        happyPathEnv({ OCI_LAUNCH_FAIL_COUNT: "5" }),
      );
      expect(gaveUp.status).toBe(1);
      expect(gaveUp.stderr).toContain("gave up after 1 attempts");
      expect(gaveUp.stderr).toContain("Pay-As-You-Go");
    });

    it("requires the Telegram token and owner target under the owner profile, like new-desk.sh", () => {
      const result = run(
        NEW_DESK_OCI,
        [deskName, "--ts-authkey-file", tsAuthkeyFile],
        happyPathEnv(),
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Usage: new-desk-oci.sh");
      expect(readLog(ociLog)).not.toContain("compute instance launch");
    });
  });

  describe("migrate-desk.sh", () => {
    const sourceCaddyfile = [
      "206-189-128-145.sslip.io {",
      "\tbind 206.189.128.145",
      "\tbasicauth {",
      '\t\t"client@example.com" $2a$14$fixturehash',
      "\t}",
      "\treverse_proxy 127.0.0.1:18789 {",
      "\t\theader_up X-Forwarded-User {http.auth.user.id}",
      "\t}",
      "}",
      "",
    ].join("\n");

    function env(extra: Record<string, string> = {}): Record<string, string> {
      return {
        SSH_PUBLIC_IP: "10.9.8.7",
        SSH_BIND_IP: "10.9.8.7",
        SSH_TAILSCALE_SELF_JSON: JSON.stringify({
          Self: { DNSName: "desk-target.tailnet-fixture.ts.net." },
        }),
        ...extra,
      };
    }

    it("refuses when the two desks run different refs, before stopping anything", () => {
      const result = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({ SSH_GIT_REF_MISMATCH: "1" }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("roll the target to the same ref first");
      expect(readLog(sshLog)).not.toContain("systemctl disable --now openclaw-gateway");
    });

    it("exits 3 and never stops the source when a Duty run is busy", () => {
      const result = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({
          SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [{ id: "run-busy", status: "running" }] }),
        }),
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("run run-busy is running");
      expect(readLog(sshLog)).not.toContain("systemctl disable --now openclaw-gateway");
    });

    it("stops+disables the source, stops the target, streams the state, carries the Caddy front to the new host, and starts the target", () => {
      const result = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({ SSH_CADDYFILE: sourceCaddyfile }),
      );
      expect(result.status, result.stderr).toBe(0);
      const ssh = readLog(sshLog);
      const lines = ssh.split("\n");
      const at = (needle: string) => {
        const index = lines.findIndex((line) => line.includes(needle));
        expect(index, needle).toBeGreaterThanOrEqual(0);
        return index;
      };
      const disableSource = at("root@desk-source systemctl disable --now openclaw-gateway");
      const stopTarget = at("root@desk-target systemctl disable --now openclaw-gateway");
      const copyOut = at(
        "root@desk-source tar -C / -czf - --ignore-failed-read home/openclaw/.openclaw",
      );
      const copyIn = at(
        "root@desk-target rm -rf /home/openclaw/.openclaw && tar -C / -xzpf - --same-owner",
      );
      const startTarget = at("root@desk-target systemctl enable --now openclaw-gateway");
      expect(stopTarget).toBeLessThan(disableSource);
      expect(disableSource).toBeLessThan(Math.min(copyOut, copyIn));
      expect(Math.max(copyOut, copyIn)).toBeLessThan(startTarget);
      // Everything that must move, nothing that must not.
      for (const moved of [
        "home/openclaw/.claude",
        "home/openclaw/.gogcli",
        "etc/openclaw/keyfile",
        "etc/openclaw/secrets",
      ]) {
        expect(lines[copyOut]).toContain(moved);
      }
      expect(lines[copyOut]).not.toContain("home/openclaw/.cache");
      expect(lines[copyOut]).not.toContain("opt/openclaw");
      // The Caddyfile written to the target (captured from the ssh stdin) names the new host/IP
      // and keeps the credential; the Gateway's allowed origins are rewritten the same way.
      expect(ssh).toContain("10-9-8-7.sslip.io {");
      expect(ssh).toContain("bind 10.9.8.7");
      expect(ssh).toContain("$2a$14$fixturehash");
      expect(ssh).not.toContain("206-189-128-145.sslip.io {");
      expect(ssh).toContain("caddy validate --config /etc/caddy/Caddyfile");
      expect(ssh).toContain("https://10-9-8-7.sslip.io");
      expect(ssh).toContain("https://desk-target.tailnet-fixture.ts.net");
      expect(result.stdout).toContain("Public host:    https://10-9-8-7.sslip.io");
      expect(result.stdout).toContain("point this client's route at https://10-9-8-7.sslip.io");
      // The source is never started again on the success path.
      expect(ssh).not.toContain("root@desk-source systemctl enable --now openclaw-gateway");
    });

    it("skips the Caddy step for a desk without its own front, and honours --public-host", () => {
      const plain = run(MIGRATE, ["desk-source", "desk-target"], env());
      expect(plain.status, plain.stderr).toBe(0);
      expect(readLog(sshLog)).not.toContain("caddy validate");
      expect(plain.stdout).not.toContain("Public host:");

      writeFileSync(sshLog, "");
      const named = run(
        MIGRATE,
        ["desk-source", "desk-target", "--public-host", "desk.example.com"],
        env({ SSH_CADDYFILE: sourceCaddyfile }),
      );
      expect(named.status, named.stderr).toBe(0);
      expect(readLog(sshLog)).toContain("desk.example.com {");
      expect(named.stdout).toContain("https://desk.example.com");
    });

    it("starts the source again and exits 5 when the copy fails, leaving the target stopped and disabled", () => {
      const result = run(MIGRATE, ["desk-source", "desk-target"], env({ SSH_COPY_EXIT_CODE: "1" }));
      expect(result.status).toBe(5);
      expect(result.stderr).toContain("copying the state failed");
      const ssh = readLog(sshLog);
      expect(ssh).toContain("root@desk-source systemctl enable --now openclaw-gateway");
      expect(ssh).not.toContain("root@desk-target systemctl enable --now openclaw-gateway");
      expect(
        ssh
          .split("\n")
          .filter((l) => l.includes("root@desk-target systemctl disable --now openclaw-gateway")),
      ).toHaveLength(2);
    });

    it("waits for /healthz with the configured budget, and exits 6 with the source back when the target never answers", () => {
      const result = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({ SSH_TARGET_HEALTH_EXIT_CODE: "1", DESK_MIGRATE_READY_SECONDS: "1234" }),
      );
      expect(result.status).toBe(6);
      expect(result.stderr).toContain("did not answer /healthz within 1234s");
      const ssh = readLog(sshLog);
      // The wait itself runs on the target with that budget and gives up on a crash loop.
      expect(ssh).toContain("deadline=$((SECONDS + 1234))");
      expect(ssh).toContain("NRestarts");
      expect(ssh).toContain("root@desk-source systemctl enable --now openclaw-gateway");
      expect(ssh).toContain("root@desk-target systemctl disable --now openclaw-gateway");
    });

    it("lists the service user's binaries that cannot run on a target of another architecture", () => {
      const result = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({
          SSH_SOURCE_ARCH: "x86_64",
          SSH_TARGET_ARCH: "aarch64",
          SSH_FOREIGN_BINARIES: "/home/openclaw/.local/bin/typst",
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("came from an x86_64 box and will not run on aarch64");
      expect(result.stdout).toContain("/home/openclaw/.local/bin/typst");
    });

    it("never scans for foreign binaries when both desks share an architecture", () => {
      const result = run(MIGRATE, ["desk-source", "desk-target"], env({}));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("will not run on");
      expect(readLog(sshLog)).not.toContain("/home/openclaw/.local/bin/*");
    });

    it("leaves the source untouched when the target cannot be stopped, and treats a failed busy check as busy", () => {
      const stop = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({ SSH_TARGET_STOP_EXIT_CODE: "1" }),
      );
      expect(stop.status).not.toBe(0);
      expect(readLog(sshLog)).not.toContain(
        "root@desk-source systemctl disable --now openclaw-gateway",
      );

      writeFileSync(sshLog, "");
      const unknown = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({ SSH_RUNS_RECENT_EXIT_CODE: "255" }),
      );
      expect(unknown.status).not.toBe(0);
      expect(readLog(sshLog)).not.toContain("systemctl disable --now openclaw-gateway");
    });

    it("binds Caddy to the address the target's interface holds, not the NATed public IP", () => {
      const result = run(
        MIGRATE,
        ["desk-source", "desk-target"],
        env({
          SSH_CADDYFILE: sourceCaddyfile,
          SSH_PUBLIC_IP: "129.1.2.3",
          SSH_BIND_IP: "10.20.1.9",
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      const ssh = readLog(sshLog);
      expect(ssh).toContain("129-1-2-3.sslip.io {");
      expect(ssh).toContain("bind 10.20.1.9");
      expect(ssh).not.toContain("bind 129.1.2.3");
    });

    it("refuses the same desk twice, a bad name, or a missing argument before touching ssh", () => {
      for (const args of [["desk-a", "desk-a"], ["desk-a"], ["Desk_A", "desk-b"]]) {
        const result = run(MIGRATE, args, env());
        expect(result.status, args.join(" ")).toBe(2);
      }
      expect(readLog(sshLog)).toBe("");
    });
  });

  describe("roll.sh", () => {
    const deskName = "desk-proof";

    it("exits 3 and never mutates when a run is busy", () => {
      const result = run(ROLL, [deskName], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [{ id: "r-1", status: "running" }] }),
      });

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("desk is busy: run r-1 is running; retry later or --force");
      const sshCalls = readLog(sshLog);
      expect(sshCalls).not.toContain("git checkout");
      expect(sshCalls).not.toContain("systemctl stop");
      expect(sshCalls).not.toContain("systemctl start");
    });

    it("stops rather than rolls when the busy check itself fails (ssh or Gateway down)", () => {
      const result = run(ROLL, [deskName], { SSH_RUNS_RECENT_EXIT_CODE: "255" });
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(3);
      const sshCalls = readLog(sshLog);
      expect(sshCalls).not.toContain("bash -s --");
    });

    it("treats a needs_input run as busy too", () => {
      const result = run(ROLL, [deskName], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [{ id: "r-2", status: "needs_input" }] }),
      });

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("run r-2 is needs_input");
    });

    it("exits 3 on the first busy run without a SIGPIPE-triggered abort when two runs are busy at once", () => {
      // The fix for the Important #2 review finding: the busy-check jq filter must take its
      // first match itself (`.[0] // empty`) instead of piping through `head -n1`, which could
      // deliver jq a SIGPIPE under `set -o pipefail` the moment more than one run is busy — the
      // exact condition this check exists to catch. This asserts the busy path still completes
      // (rather than aborting with an unrelated pipe error) when it does.
      const result = run(ROLL, [deskName], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({
          runs: [
            { id: "r-5", status: "running" },
            { id: "r-6", status: "queued" },
          ],
        }),
      });

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("desk is busy: run r-5 is running; retry later or --force");
    });

    it("rejects an abbreviated commit hash before touching ssh, since the remote cannot fetch one", () => {
      const result = run(ROLL, [deskName, "717f12ff11"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("abbreviated commit hash");
      expect(readLog(sshLog)).toBe("");
      // A full hash is still accepted.
      const full = run(ROLL, [deskName, "717f12ff1128023e5a5305aeac66c1d337af1745"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
      });
      expect(full.status, full.stderr).toBe(0);
    });

    it("rejects a git-ref containing shell-unsafe characters before touching ssh", () => {
      const result = run(ROLL, [deskName, "main'; touch /tmp/pwned #"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("is invalid");
      expect(readLog(sshLog)).toBe("");
    });

    it("rejects a git-ref that starts with a dash before touching ssh", () => {
      const result = run(ROLL, [deskName, "--upload-pack=evil"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
      });

      // `--upload-pack=evil` is itself parsed as an unknown roll.sh option (exit 2), which is
      // also the correct outcome — either way ssh must never be touched.
      expect(result.status).toBe(2);
      expect(readLog(sshLog)).toBe("");
    });

    it("rolls to the given ref, restarts, waits for /healthz, and prints the version when idle", () => {
      const result = run(ROLL, [deskName, "feat/hosted-desk"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [{ id: "r-3", status: "success" }] }),
      });

      expect(result.status).toBe(0);
      const sshCalls = readLog(sshLog);
      // <git-ref> travels as its own `bash -s --` positional argument, not interpolated into
      // the remote script text (Important #1 fix) — the script text itself is fully static.
      expect(sshCalls).toContain(
        `ssh root@${deskName} bash -s -- ${deskName} feat/hosted-desk 18789 restart`,
      );
      expect(sshCalls).toContain('git fetch origin "$git_ref"');
      expect(sshCalls).toContain("git checkout --detach FETCH_HEAD");
      expect(sshCalls).toContain("pnpm install --frozen-lockfile --ignore-scripts");
      // Runtime-only, with the same explicit heap ceiling cloud-init's first-boot build uses — a
      // plain `pnpm build` emits declarations and OOMs on the documented default 4 GB desk, so
      // every roll of a default-size desk used to fail deterministically.
      expect(sshCalls).toContain(
        "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build",
      );
      expect(sshCalls).toContain('chown -R root:openclaw "$root"');
      expect(sshCalls).toContain("systemctl stop openclaw-gateway");
      expect(sshCalls).toContain("systemctl start openclaw-gateway");
      expect(sshCalls).not.toContain("systemctl restart openclaw-gateway");
      expect(sshCalls).toContain("Gateway stopped, building");
      expect(sshCalls).toContain("http://127.0.0.1:${gateway_port}/healthz");
      expect(sshCalls).toContain('sudo -H -u openclaw node "$root/openclaw.mjs" --version');
      expect(result.stdout).toContain(`rolled to feat/hosted-desk and is healthy`);

      // The whole point of stopping first: the Gateway must be down for the entire
      // fetch/install/build, and back up only once the rebuilt tree is ready.
      const stopIndex = sshCalls.indexOf("systemctl stop openclaw-gateway");
      const fetchIndex = sshCalls.indexOf('git fetch origin "$git_ref"');
      // The bare substring "pnpm build" also appears earlier in explanatory comments (e.g. "this
      // project's own live proof once OOM'd mid-`pnpm build`") — match the actual command line.
      const buildIndex = sshCalls.indexOf("pnpm build || return 1");
      // The success-path start, not the recovery path's own (earlier, `|| true`-suffixed) start.
      const startIndex = sshCalls.lastIndexOf("systemctl start openclaw-gateway");
      expect(stopIndex).toBeGreaterThan(-1);
      expect(stopIndex).toBeLessThan(fetchIndex);
      expect(fetchIndex).toBeLessThan(buildIndex);
      expect(buildIndex).toBeLessThan(startIndex);

      // The build snapshot (taken before the stop, in case fetch/install/build fails) is
      // discarded once the new build is actually in place — nothing left over on success.
      expect(sshCalls).toContain('cp -a "$root/dist" "$root/dist.prev"');
      expect(sshCalls).toContain('rm -rf "$root/dist.prev" "$root/dist.prev.ref"');
    });

    it("sends the tree's own remote/roll-remote.sh over stdin, and refuses when it is missing", () => {
      const result = run(ROLL, [deskName], { SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }) });
      expect(result.status).toBe(0);
      // Byte-for-byte what the operator's checkout carries: the remote body is a shipped file, not
      // a heredoc, which is what lets the execution tests below run the real thing.
      expect(readLog(sshLog)).toContain(readFileSync(ROLL_REMOTE, "utf8").trimEnd());

      // Run a copy of roll.sh from a directory with no remote/ next to it: it must fail before
      // touching the desk rather than piping an empty script into a live shell.
      const orphan = join(dir, "roll-copy.sh");
      writeFileSync(orphan, readFileSync(ROLL, "utf8"), { mode: 0o755 });
      const missing = run(orphan, [deskName, "--force"]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("the remote roll script is missing");
    });

    it("restores the previous build and restarts the Gateway when the remote build fails, exiting 5", () => {
      const result = run(ROLL, [deskName, "feat/hosted-desk"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
        SSH_ROLL_REMOTE_EXIT_CODE: "5",
      });

      // This stub never really executes the piped script (see the ssh stub's own comment), so
      // "the build failed" is simulated by the mutate ssh call itself returning 5 — exactly the
      // exit code the real remote recovery path uses once it has restored the previous build and
      // restarted the Gateway. What this test can and does verify for real: the static remote
      // script actually captured over stdin contains the restore-and-restart sequence the
      // recovery path depends on, and that roll.sh propagates the remote's exit code untouched.
      expect(result.status).toBe(5);
      const sshCalls = readLog(sshLog);
      expect(sshCalls).toContain("restore_previous_build()");
      expect(sshCalls).toContain('mv "$root/dist.prev" "$root/dist"');
      expect(sshCalls).toContain('git checkout --detach "$(cat "$root/dist.prev.ref")"');
      expect(sshCalls).toContain("restore_previous_build || true");
      expect(sshCalls).toContain("systemctl start openclaw-gateway || true");
      expect(sshCalls).toContain(
        "roll FAILED at ${build_step}; previous build restored and Gateway restarted",
      );
      expect(sshCalls).toContain(
        "roll FAILED at ${build_step}; previous build restored but Gateway did not answer /healthz",
      );
      expect(sshCalls).toContain("exit 5");
      expect(sshCalls).toContain("exit 6");
      // The recovery block is reached before the success-path cleanup/reboot/start below it —
      // an early `exit 5`/`exit 6` inside the failure branch, not merely present later.
      expect(sshCalls.indexOf("if ! build_new_ref; then")).toBeLessThan(
        sshCalls.indexOf('rm -rf "$root/dist.prev" "$root/dist.prev.ref"'),
      );
    });

    it("connects as DESK_SSH_USER instead of root when overridden", () => {
      const result = run(ROLL, [deskName], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
        DESK_SSH_USER: "ops",
      });

      expect(result.status).toBe(0);
      const sshCalls = readLog(sshLog);
      expect(sshCalls).toContain(`ssh ops@${deskName}`);
      expect(sshCalls).not.toContain(`ssh root@${deskName}`);
    });

    it("--force skips the busy check entirely", () => {
      const result = run(ROLL, [deskName, "--force"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [{ id: "r-4", status: "running" }] }),
      });

      expect(result.status).toBe(0);
      const sshCalls = readLog(sshLog);
      expect(sshCalls).not.toContain("duties.runs.recent");
      expect(sshCalls).toContain("systemctl stop openclaw-gateway");
      expect(sshCalls).toContain("systemctl start openclaw-gateway");
    });

    it("--reboot reboots instead of restarting the Gateway service, but still stops it first", () => {
      const result = run(ROLL, [deskName, "--reboot"], {
        SSH_RUNS_RECENT_JSON: JSON.stringify({ runs: [] }),
      });

      expect(result.status).toBe(0);
      const sshCalls = readLog(sshLog);
      // The remote script is one static heredoc that branches on its own $4 ("mode") argument
      // at runtime — reboot-vs-restart is selected by the argv marker below, not by which
      // branch's text is present (both are always present in the static script source; the
      // fake ssh here logs but never executes it).
      expect(sshCalls).toContain(`ssh root@${deskName} bash -s -- ${deskName} main 18789 reboot`);
      expect(sshCalls).not.toContain(
        `ssh root@${deskName} bash -s -- ${deskName} main 18789 restart`,
      );
      expect(sshCalls).toContain("systemctl stop openclaw-gateway");
      expect(sshCalls).toContain('if [ "$mode" = "reboot" ]; then');
      expect(sshCalls).toContain("systemctl reboot");
      expect(sshCalls.indexOf("systemctl stop openclaw-gateway")).toBeLessThan(
        sshCalls.indexOf("systemctl reboot"),
      );
      expect(result.stdout).toContain("is rebooting");
    });
  });

  // The body that actually runs ON a desk, EXECUTED here rather than string-matched: the recovery
  // branch is the one piece of this that runs on a live client desk after a failed roll, so it is
  // exercised for real against a temp checkout with stubbed git/pnpm/systemctl/curl/chown/sudo.
  // `cp`/`mv`/`rm` are deliberately NOT stubbed — the whole point is to assert on the resulting
  // file state (which build ended up in `dist`, whether the snapshot was cleaned up), and every
  // one of those operations stays inside the temp OPENCLAW_DESK_ROOT below.
  describe("remote/roll-remote.sh", () => {
    const deskName = "desk-proof";
    let deskRoot: string;
    let gitLog: string;
    let pnpmLog: string;
    let systemctlLog: string;

    beforeEach(() => {
      deskRoot = join(dir, "opt-openclaw");
      mkdirSync(join(deskRoot, "dist"), { recursive: true });
      writeFileSync(join(deskRoot, "dist", "marker.txt"), "OLD");
      gitLog = join(dir, "git.log");
      pnpmLog = join(dir, "pnpm.log");
      systemctlLog = join(dir, "systemctl.log");
      for (const log of [gitLog, pnpmLog, systemctlLog]) {
        writeFileSync(log, "");
      }

      writeStub(
        binDir,
        "git",
        `printf '%s\\n' "git $*" >> "\${GIT_LOG:?}"
case "$1" in
  rev-parse) printf '%s\\n' "\${GIT_HEAD_SHA:-oldsha0000000000}" ;;
  fetch) exit "\${GIT_FETCH_EXIT:-0}" ;;
esac
exit 0`,
      );
      writeStub(
        binDir,
        "pnpm",
        `printf '%s\\n' "pnpm $*" >> "\${PNPM_LOG:?}"
case "$1" in
  install) exit "\${PNPM_INSTALL_EXIT:-0}" ;;
  build)
    if [ "\${PNPM_BUILD_EXIT:-0}" != 0 ]; then
      exit "\${PNPM_BUILD_EXIT}"
    fi
    # A successful build replaces dist, so the file state below can tell the new build from the
    # restored one.
    mkdir -p "\${OPENCLAW_DESK_ROOT:?}/dist"
    printf 'NEW' > "\${OPENCLAW_DESK_ROOT}/dist/marker.txt"
    ;;
esac
exit 0`,
      );
      writeStub(
        binDir,
        "systemctl",
        `printf '%s\\n' "systemctl $*" >> "\${SYSTEMCTL_LOG:?}"
exit 0`,
      );
      // Not root here, so a real chown would fail and abort the script for the wrong reason.
      writeStub(binDir, "chown", `printf '%s\\n' "chown $*" >> "\${SYSTEMCTL_LOG:?}"\nexit 0`);
      writeStub(binDir, "sudo", `printf '%s\\n' "sudo $*" >> "\${SYSTEMCTL_LOG:?}"\nexit 0`);
    });

    function runRemote(env: Record<string, string> = {}, mode = "restart"): RunResult {
      return run(ROLL_REMOTE, [deskName, "feat/hosted-desk", "18789", mode], {
        OPENCLAW_DESK_ROOT: deskRoot,
        OPENCLAW_DESK_HEALTH_ATTEMPTS: "2",
        OPENCLAW_DESK_HEALTH_INTERVAL_SECONDS: "0",
        GIT_LOG: gitLog,
        PNPM_LOG: pnpmLog,
        SYSTEMCTL_LOG: systemctlLog,
        ...env,
      });
    }

    function marker(): string {
      return readFileSync(join(deskRoot, "dist", "marker.txt"), "utf8");
    }

    it("builds the new ref, discards the snapshot, and starts the Gateway after the build", () => {
      const result = runRemote();

      expect(result.status).toBe(0);
      expect(marker()).toBe("NEW");
      // Nothing left over on success — a stale dist.prev would be restored by a LATER failed roll.
      expect(existsSync(join(deskRoot, "dist.prev"))).toBe(false);
      expect(existsSync(join(deskRoot, "dist.prev.ref"))).toBe(false);

      const systemctlCalls = readLog(systemctlLog);
      const buildIndex = readLog(pnpmLog).indexOf("pnpm build");
      expect(buildIndex).toBeGreaterThan(-1);
      expect(readLog(pnpmLog).indexOf("pnpm install")).toBeLessThan(buildIndex);
      expect(systemctlCalls).toContain("systemctl stop openclaw-gateway");
      expect(systemctlCalls).toContain("systemctl start openclaw-gateway");
      expect(systemctlCalls.indexOf("systemctl stop openclaw-gateway")).toBeLessThan(
        systemctlCalls.indexOf("systemctl start openclaw-gateway"),
      );
      expect(systemctlCalls).toContain("sudo -H -u openclaw node");
      expect(readLog(gitLog)).toContain("git checkout --detach FETCH_HEAD");
    });

    it("restores dist, the previous ref AND its node_modules, restarts, and exits 5 when the build fails", () => {
      const result = runRemote({ PNPM_BUILD_EXIT: "1", GIT_HEAD_SHA: "prevsha111" });

      expect(result.status).toBe(5);
      expect(result.stderr).toContain("roll failed at pnpm build");
      expect(result.stderr).toContain("previous build restored and Gateway restarted");
      // The build that was serving before the roll is back, and the snapshot is consumed.
      expect(marker()).toBe("OLD");
      expect(existsSync(join(deskRoot, "dist.prev"))).toBe(false);
      expect(readLog(gitLog)).toContain("git checkout --detach prevsha111");
      // The forward install already replaced node_modules with the NEW ref's dependency tree, so
      // the restored dist would otherwise run against dependencies it was never built for.
      expect(readLog(pnpmLog)).toContain(
        "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
      );
      expect(readLog(systemctlLog)).toContain("systemctl start openclaw-gateway");
    });

    it("exits 6 when the Gateway will not come back even on the restored build", () => {
      const result = runRemote({ PNPM_BUILD_EXIT: "1", CURL_FAIL_COUNT: "999999" });

      expect(result.status).toBe(6);
      expect(result.stderr).toContain("did not answer /healthz");
      expect(result.stderr).toContain("journalctl -u openclaw-gateway");
      expect(marker()).toBe("OLD");
    });

    it("recovers from a failed fetch without ever stopping short of restarting the Gateway", () => {
      const result = runRemote({ GIT_FETCH_EXIT: "1" });

      expect(result.status).toBe(5);
      expect(result.stderr).toContain("roll failed at git fetch");
      expect(marker()).toBe("OLD");
      expect(readLog(pnpmLog)).not.toContain("pnpm build");
      expect(readLog(systemctlLog)).toContain("systemctl start openclaw-gateway");
    });

    it("reboots instead of starting the Gateway in reboot mode, after a successful build", () => {
      const result = runRemote({}, "reboot");

      expect(result.status).toBe(0);
      expect(marker()).toBe("NEW");
      const systemctlCalls = readLog(systemctlLog);
      expect(systemctlCalls).toContain("systemctl reboot");
      expect(systemctlCalls).not.toContain("systemctl start openclaw-gateway");
    });

    it("refuses to run without its four arguments rather than acting on defaults", () => {
      const result = run(ROLL_REMOTE, [deskName], {
        OPENCLAW_DESK_ROOT: deskRoot,
        GIT_LOG: gitLog,
        PNPM_LOG: pnpmLog,
        SYSTEMCTL_LOG: systemctlLog,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing <git-ref>");
      expect(readLog(systemctlLog)).toBe("");
    });
  });

  describe("snapshot.sh", () => {
    const deskName = "desk-proof";

    it("fails when no droplet matches the desk name", () => {
      const result = run(SNAPSHOT, [deskName], { DOCTL_DROPLET_LIST_JSON: "[]" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`no droplet named "${deskName}"`);
    });

    it("snapshots the droplet and prunes down to the newest 4 desk-<name>-* snapshots", () => {
      const snapshots = [1, 2, 3, 4, 5, 6].map((n) => ({
        id: `snap-${n}`,
        name: `desk-${deskName}-2026010${n}000000`,
        created_at: `2026-01-0${n}T00:00:00Z`,
      }));
      snapshots.push({
        id: "snap-other",
        name: "desk-some-other-desk-20260101000000",
        created_at: "2026-01-09T00:00:00Z",
      });

      const result = run(SNAPSHOT, [deskName], {
        DOCTL_DROPLET_LIST_JSON: JSON.stringify([{ id: "777", name: deskName }]),
        DOCTL_SNAPSHOT_LIST_JSON: JSON.stringify(snapshots),
      });

      expect(result.status).toBe(0);
      const doctlCalls = readLog(doctlLog);
      const createLine = doctlCalls
        .split("\n")
        .find((line) => line.includes("droplet-action snapshot"));
      expect(createLine).toBeDefined();
      expect(createLine).toContain("droplet-action snapshot 777 --snapshot-name desk-desk-proof-");
      expect(createLine).toContain("--wait");

      expect(doctlCalls).toContain("snapshot delete snap-1 --force");
      expect(doctlCalls).toContain("snapshot delete snap-2 --force");
      expect(doctlCalls).not.toContain("snapshot delete snap-3");
      expect(doctlCalls).not.toContain("snapshot delete snap-4");
      expect(doctlCalls).not.toContain("snapshot delete snap-5");
      expect(doctlCalls).not.toContain("snapshot delete snap-6");
      expect(doctlCalls).not.toContain("snapshot delete snap-other");
    });

    it("respects DESK_SNAPSHOT_KEEP", () => {
      const snapshots = [1, 2, 3].map((n) => ({
        id: `keep-snap-${n}`,
        name: `desk-${deskName}-2026010${n}000000`,
        created_at: `2026-01-0${n}T00:00:00Z`,
      }));

      const result = run(SNAPSHOT, [deskName], {
        DOCTL_DROPLET_LIST_JSON: JSON.stringify([{ id: "777", name: deskName }]),
        DOCTL_SNAPSHOT_LIST_JSON: JSON.stringify(snapshots),
        DESK_SNAPSHOT_KEEP: "1",
      });

      expect(result.status).toBe(0);
      const doctlCalls = readLog(doctlLog);
      expect(doctlCalls).toContain("snapshot delete keep-snap-1 --force");
      expect(doctlCalls).toContain("snapshot delete keep-snap-2 --force");
      expect(doctlCalls).not.toContain("snapshot delete keep-snap-3");
    });

    it("never prunes a longer-named desk's snapshots that share this desk's name as a prefix", () => {
      // `desk-a-b-<timestamp>` starts with `desk-a-`, so pruning desk `a` with a bare prefix
      // filter could delete desk `a-b`'s snapshots. The prune anchors on the full
      // `desk-<name>-<14 digits>` shape instead.
      const mine = [1, 2].map((n) => ({
        id: `mine-${n}`,
        name: `desk-a-2026010${n}000000`,
        created_at: `2026-01-0${n}T00:00:00Z`,
      }));
      const neighbour = [1, 2, 3].map((n) => ({
        id: `neighbour-${n}`,
        name: `desk-a-b-2026010${n}000000`,
        created_at: `2026-01-0${n}T00:00:00Z`,
      }));

      const result = run(SNAPSHOT, ["a"], {
        DOCTL_DROPLET_LIST_JSON: JSON.stringify([{ id: "777", name: "a" }]),
        DOCTL_SNAPSHOT_LIST_JSON: JSON.stringify([...mine, ...neighbour]),
        DESK_SNAPSHOT_KEEP: "1",
      });

      expect(result.status).toBe(0);
      const doctlCalls = readLog(doctlLog);
      expect(doctlCalls).toContain("snapshot delete mine-1 --force");
      expect(doctlCalls).not.toContain("snapshot delete mine-2");
      for (const id of ["neighbour-1", "neighbour-2", "neighbour-3"]) {
        expect(doctlCalls).not.toContain(`snapshot delete ${id}`);
      }
    });

    it("refuses a desk name that is not a plain hostname, before any doctl call", () => {
      const result = run(SNAPSHOT, ["desk-.*"], {});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must be a plain hostname");
      expect(readLog(doctlLog)).toBe("");
    });
  });
  describe("new-desk-azure.sh", () => {
    const deskName = "vasudev-acme-az";
    let envFile: string;
    let azLog: string;

    beforeEach(() => {
      envFile = join(dir, "acme.env");
      writeFileSync(
        envFile,
        [
          "OWNER_EMAIL=owner@example.com",
          `TS_AUTHKEY=${TS_AUTHKEY_SECRET}`,
          "DESK_ADMIN_PASSWORD=Fixture-Admin-Pass-1!",
          "GATEWAY_ADMIN_PASSWORD=fixture-gateway-admin",
          "DESK_FRONT_PASSWORD=fixture-front",
          "VNC_PASSWORD=fixtvnc1",
          "WHITELIST_ADDRESSES=203.0.113.10,203.0.113.11",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      writeFileSync(join(dir, "fixture.pub"), "ssh-ed25519 AAAAfixture fixture@test\n");
      azLog = join(dir, "az.log");
    });

    function azureEnv(extra: Record<string, string> = {}): Record<string, string> {
      return {
        AZ_LOG: azLog,
        DESK_OPERATOR_IP: "198.51.100.7",
        DESK_SSH_PUBLIC_KEY: join(dir, "fixture.pub"),
        DESK_POLL_SECONDS: "5",
        DESK_SSH_WAIT_SECONDS: "5",
        TAILSCALE_STATUS_JSON: JSON.stringify({
          MagicDNSSuffix: "tailnet-fixture.ts.net.",
          Peer: { peer1: { HostName: "acme-az", Online: true, TailscaleIPs: ["100.64.0.9"] } },
        }),
        ...extra,
      };
    }

    it("refuses an env file that is missing a key, before any az call", () => {
      writeFileSync(envFile, "OWNER_EMAIL=owner@example.com\n", { mode: 0o600 });
      const result = run(NEW_DESK_AZURE, [deskName, "--env-file", envFile], azureEnv());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("TS_AUTHKEY");
      expect(existsSync(azLog)).toBe(false);
    });

    it("refuses a group- or world-readable env file", () => {
      chmodSync(envFile, 0o644);
      const result = run(NEW_DESK_AZURE, [deskName, "--env-file", envFile], azureEnv());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("0600");
      expect(existsSync(azLog)).toBe(false);
    });

    it("creates group, network, NSG with a temporary operator SSH rule, and the VM, in that order", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--client", "acme", "--stop-after", "create"],
        azureEnv(),
      );
      expect(result.status, result.stderr).toBe(0);
      const calls = readLog(azLog).split("\n");
      const idx = (needle: string) => calls.findIndex((line) => line.includes(needle));
      expect(idx("group create --name vasudev --location centralindia")).toBeGreaterThanOrEqual(0);
      expect(idx("network vnet create")).toBeGreaterThan(idx("group create"));
      expect(
        idx("network nsg create --resource-group vasudev --name vasudev-desks"),
      ).toBeGreaterThan(idx("network vnet create"));
      expect(idx("network nsg rule create")).toBeGreaterThan(idx("network nsg create"));
      const rule = calls[idx("network nsg rule create")];
      expect(rule).toContain("--source-address-prefixes 198.51.100.7/32");
      expect(rule).toContain("--destination-port-ranges 22");
      expect(rule).toContain("--name operator-ssh-temp");
      const create = calls[idx("vm create")];
      expect(create).toContain(`--name ${deskName}`);
      expect(create).toContain(
        "--image MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest",
      );
      expect(create).toContain("--size Standard_B2as_v2");
      expect(create).toContain("--os-disk-size-gb 128");
      expect(create).toContain("--storage-sku Premium_LRS");
      expect(create).toContain("--admin-username vasudev");
      expect(create).toContain("--computer-name acme-az ");
      expect(create).toContain("--nsg vasudev-desks");
      expect(create).toContain("--public-ip-sku Standard");
      expect(create).not.toContain("Fixture-Admin-Pass-1!");
      expect(create).toContain("--admin-password @");
      expect(readLog(azLog)).not.toContain(TS_AUTHKEY_SECRET);
    });

    it("reuses existing group, network and NSG on a rerun", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "create"],
        azureEnv({ AZ_GROUP_EXISTS: "true", AZ_VNET_EXISTS: "1", AZ_NSG_EXISTS: "1" }),
      );
      expect(result.status, result.stderr).toBe(0);
      const log = readLog(azLog);
      expect(log).not.toContain("group create");
      expect(log).not.toContain("vnet create");
      expect(log).not.toContain("nsg create --resource-group");
      expect(log).toContain("vm create");
    });

    it("never opens the operator SSH rule when the VM already exists and --resume was not given", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "create"],
        azureEnv({ AZ_VM_EXISTS: "1" }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--resume");
      expect(readLog(azLog)).not.toContain("nsg rule create");
    });

    it("closes the operator SSH rule when az vm create fails", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "create"],
        azureEnv({ AZ_VM_CREATE_EXIT: "1" }),
      );
      expect(result.status).not.toBe(0);
      const log = readLog(azLog);
      expect(log).toContain("nsg rule create");
      expect(log).toContain("nsg rule delete");
      expect(result.stderr).toContain("--resume");
    });

    it("skips the bootstrap and first boot on --resume when the desk already answers SSH over the tailnet", () => {
      const head = spawnSync("git", ["-C", HERE, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      const fakeDist = join(dir, "fake-dist");
      mkdirSync(fakeDist, { recursive: true });
      writeFileSync(join(fakeDist, "index.js"), "console.log(1)\n");
      writeFileSync(join(fakeDist, ".provision-built-ref"), `${head}\n`);
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--resume", "--skip-pairing", "--git-ref", head],
        azureEnv({
          AZ_VM_EXISTS: "1",
          SSH_LOG: sshLog,
          SSH_STDIN_LOG: join(dir, "ssh-stdin.log"),
          SSH_READY_HOSTS: "acme-az.tailnet-fixture.ts.net",
          SSH_STDOUT: "receive-build: ok 2 files\nprovision-desk: ok",
          DESK_BUILD_DIR: fakeDist,
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readLog(azLog)).not.toContain("vm run-command invoke");
      expect(readLog(azLog)).not.toContain("nsg rule create");
      // argv lines only: the staged provisioning script's own comments mention first-boot.ps1.
      const sshArgv = readLog(sshLog)
        .split("\n")
        .filter((line) => line.startsWith("ssh "))
        .join("\n");
      expect(sshArgv).not.toContain("first-boot.ps1");
      expect(result.stderr).toContain("already answers over the tailnet");
      expect(result.stdout).toContain("SSH:        ssh vasudev@acme-az.tailnet-fixture.ts.net");
    });

    it("bootstraps OpenSSH with a run-command that carries the operator key and no secrets, then waits for SSH", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "first-boot", "--skip-first-boot"],
        azureEnv({ SSH_LOG: sshLog, SSH_STDIN_LOG: join(dir, "ssh-stdin.log") }),
      );
      expect(result.status, result.stderr).toBe(0);
      const log = readLog(azLog);
      const runCommand =
        log.split("\n").find((line) => line.includes("vm run-command invoke")) ?? "";
      expect(runCommand).toContain("--command-id RunPowerShellScript");
      expect(runCommand).toContain("--scripts @");
      expect(runCommand).toContain("--parameters PublicKey=ssh-ed25519 AAAAfixture fixture@test");
      expect(runCommand).not.toContain("Fixture-Admin-Pass-1!");
      expect(readLog(sshLog)).toContain("vasudev@20.0.0.5");
    });

    it("sends first-boot.ps1 with the env secrets on stdin, closes the operator SSH rule, and waits for the tailnet host", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "first-boot"],
        azureEnv({
          SSH_LOG: sshLog,
          SSH_STDIN_LOG: join(dir, "ssh-stdin.log"),
          SSH_STDOUT: "first-boot: ok",
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      // The ssh stub appends stdin to the same log; the argv lines are the ones that must stay
      // free of secrets (a process list shows argv, never stdin).
      const sshCalls = readLog(sshLog)
        .split("\n")
        .filter((line) => line.startsWith("ssh "))
        .join("\n");
      expect(sshCalls).toContain("-File C:\\opt\\stage\\first-boot.ps1");
      expect(sshCalls).not.toContain(TS_AUTHKEY_SECRET);
      expect(sshCalls).not.toContain("Fixture-Admin-Pass-1!");
      const stdinLog = readFileSync(join(dir, "ssh-stdin.log"), "utf8");
      expect(stdinLog).toContain(`"tsAuthKey":"${TS_AUTHKEY_SECRET}"`);
      expect(stdinLog).toContain('"tailnetName":"acme-az"');
      // The staged script is self-contained: the pins and the Caddyfile template travel inside it.
      expect(stdinLog).toContain("tailscale-setup-");
      expect(stdinLog).toContain("reverse_proxy 127.0.0.1:18789");
      const log = readLog(azLog);
      expect(log).toContain("network nsg rule delete");
      expect(log.indexOf("nsg rule delete")).toBeGreaterThan(log.indexOf("vm create"));
      expect(result.stderr).toContain("acme-az.tailnet-fixture.ts.net");
      expect(result.stderr).toContain("100.64.0.9");
      // After the reboot the script waits for a fresh boot over the tailnet, not just for the peer.
      expect(readLog(sshLog)).toContain("first-boot-fresh");
    });

    it("keeps the operator SSH rule open and stops when the tailnet join fails", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "first-boot"],
        azureEnv({
          SSH_LOG: sshLog,
          SSH_STDOUT: "first-boot: tailscale-failed invalid key",
          SSH_EXIT_CODE: "3",
        }),
      );
      expect(result.status).toBe(3);
      expect(readLog(azLog)).not.toContain("network nsg rule delete");
      expect(result.stderr).toContain("tailscale-failed");
      expect(result.stderr).toContain("--resume");
    });

    it("closes the operator SSH rule when a later step fails", () => {
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--stop-after", "first-boot"],
        azureEnv({
          SSH_LOG: sshLog,
          SSH_STDOUT: "first-boot: ok",
          TAILSCALE_STATUS_JSON: JSON.stringify({ MagicDNSSuffix: "x.ts.net.", Peer: {} }),
        }),
      );
      expect(result.status).not.toBe(0);
      expect(readLog(azLog)).toContain("network nsg rule delete");
    });

    it("pushes the build, provisions over the tailnet host, and prints the front-door Control UI", () => {
      const head = spawnSync("git", ["-C", HERE, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      const fakeDist = join(dir, "fake-dist");
      mkdirSync(fakeDist, { recursive: true });
      writeFileSync(join(fakeDist, "index.js"), "console.log(1)\n");
      writeFileSync(join(fakeDist, ".provision-built-ref"), `${head}\n`);
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--resume", "--skip-pairing", "--git-ref", head],
        azureEnv({
          AZ_VM_EXISTS: "1",
          SSH_LOG: sshLog,
          SSH_STDIN_LOG: join(dir, "ssh-stdin.log"),
          SSH_STDOUT: "first-boot: ok\nreceive-build: ok 2 files\nprovision-desk: ok",
          DESK_BUILD_DIR: fakeDist,
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      const sshCalls = readLog(sshLog);
      expect(sshCalls).toContain("vasudev@acme-az.tailnet-fixture.ts.net");
      expect(sshCalls).toContain("-File C:\\opt\\stage\\provision-desk.ps1");
      const stdin = readFileSync(join(dir, "ssh-stdin.log"), "utf8");
      expect(stdin).toContain('"gatewayAdminPassword":"fixture-gateway-admin"');
      expect(stdin).toContain('"frontDoorOrigin":"https://vasudev.tripinstudio.com"');
      expect(stdin).toContain('"tailnetIp":"100.64.0.9"');
      // The staged provisioning script carries the desk config template.
      expect(stdin).toContain('"mode": "trusted-proxy"');
      expect(stdin).toContain('"allow": ["desktop.stream"]');
      expect(result.stdout).toContain("Control UI: https://vasudev.tripinstudio.com");
      expect(readLog(nodeLog)).not.toContain("pnpm build");
    });

    it("pairs the desktop node over the Tailscale ingress and prints the ready banner", () => {
      const head = spawnSync("git", ["-C", HERE, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      const fakeDist = join(dir, "fake-dist");
      mkdirSync(fakeDist, { recursive: true });
      writeFileSync(join(fakeDist, "index.js"), "console.log(1)\n");
      writeFileSync(join(fakeDist, ".provision-built-ref"), `${head}\n`);
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--resume", "--git-ref", head],
        azureEnv({
          AZ_VM_EXISTS: "1",
          SSH_LOG: sshLog,
          SSH_STDIN_LOG: join(dir, "ssh-stdin.log"),
          SSH_STDOUT:
            "first-boot: ok\nreceive-build: ok 2 files\nprovision-desk: ok\npair-node: ok",
          DESK_BUILD_DIR: fakeDist,
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readLog(sshLog)).toContain("-File C:\\opt\\stage\\pair-node.ps1");
      const stdin = readFileSync(join(dir, "ssh-stdin.log"), "utf8");
      expect(stdin).toContain('"displayName":"acme desktop"');
      expect(stdin).toContain('"tailnetHost":"acme-az.tailnet-fixture.ts.net"');
      expect(result.stdout).toContain("Desktop node: acme desktop");
      expect(result.stdout).toContain("ssh vasudev@acme-az.tailnet-fixture.ts.net");
    });

    it("stops with exit 7 and points at the runbook when the Gateway's ingress is unreachable from the VM", () => {
      const head = spawnSync("git", ["-C", HERE, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      const fakeDist = join(dir, "fake-dist");
      mkdirSync(fakeDist, { recursive: true });
      writeFileSync(join(fakeDist, "index.js"), "console.log(1)\n");
      writeFileSync(join(fakeDist, ".provision-built-ref"), `${head}\n`);
      const result = run(
        NEW_DESK_AZURE,
        [deskName, "--env-file", envFile, "--resume", "--git-ref", head],
        azureEnv({
          AZ_VM_EXISTS: "1",
          SSH_LOG: sshLog,
          SSH_STDOUT:
            "first-boot: ok\nreceive-build: ok 2 files\nprovision-desk: ok\npair-node: ingress-unreachable https://acme-az.tailnet-fixture.ts.net",
          DESK_BUILD_DIR: fakeDist,
        }),
      );
      expect(result.status).toBe(7);
      expect(result.stderr).toContain("Loopback entrance fallback");
    });
  });

  describe("windows/push-build.sh", () => {
    it("builds when dist was not built from this commit, streams a tar over ssh, and reports the sha and count", () => {
      const head = spawnSync("git", ["-C", HERE, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      const fakeDist = join(dir, "fake-dist");
      mkdirSync(join(fakeDist, "extensions", "demo", "node_modules"), { recursive: true });
      writeFileSync(join(fakeDist, "index.js"), "console.log(1)\n");
      writeFileSync(join(fakeDist, "extensions", "demo", "index.js"), "export {}\n");
      writeFileSync(join(fakeDist, "extensions", "demo", "node_modules", "dep.js"), "ignored\n");
      const result = run(PUSH_BUILD, ["acme-az.tailnet-fixture.ts.net", "--git-ref", head], {
        SSH_LOG: sshLog,
        SSH_STDOUT: "receive-build: ok 2 files",
        DESK_BUILD_DIR: fakeDist,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readLog(nodeLog)).toContain("pnpm build");
      expect(readFileSync(join(fakeDist, ".provision-built-ref"), "utf8").trim()).toBe(head);
      const sshCalls = readLog(sshLog);
      expect(sshCalls).toContain("vasudev@acme-az.tailnet-fixture.ts.net");
      expect(sshCalls).toContain("receive-build.ps1");
      // index.js, extensions/demo/index.js and the ref file travel; the plugin node_modules does not.
      expect(sshCalls).toContain(`-GitRef ${head} -ExpectedCount 3 -ExpectedManifest `);
      expect(result.stdout).toContain(`push-build: ok ${head} 3`);
    });

    it("refuses to push when this checkout is not at the requested commit", () => {
      const result = run(
        PUSH_BUILD,
        ["acme-az.tailnet-fixture.ts.net", "--git-ref", "0000000000000000000000000000000000000000"],
        { SSH_LOG: sshLog },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("check out the commit");
      expect(readLog(sshLog)).toBe("");
    });
  });
});
