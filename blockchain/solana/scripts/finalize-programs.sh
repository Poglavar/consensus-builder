#!/usr/bin/env bash
# Shows the upgrade authority of every program listed in Anchor.toml for a cluster and, only with
# --apply on a non-dev cluster after a typed confirmation, makes each program immutable (--final).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANCHOR_TOML="$SCRIPT_DIR/../Anchor.toml"

usage() {
    cat <<'EOF'
Usage: finalize-programs.sh <cluster> [--apply] [--section <name>] [--upgrade-authority <keypair>]

  <cluster>   devnet | mainnet-beta | testnet | localnet | an http(s) RPC URL (required)

For each program in Anchor.toml's [programs.<section>] it runs `solana program show` and prints the
current upgrade authority. The section follows the cluster: devnet -> devnet, mainnet-beta ->
mainnet, testnet -> testnet, localnet -> localnet. For an RPC URL it is guessed from the host
(devnet/testnet/mainnet in the name, localhost/127.0.0.1 -> localnet); pass --section otherwise.

Without --apply this is a dry run: it only shows the authorities and prints the commands it would run.

--apply makes every program IMMUTABLE (`solana program set-upgrade-authority <id> --final`). This
cannot be undone: no fix can ever be deployed to a finalized program. It is refused for devnet and
localnet (they keep their dev upgrade authority on purpose), asks you to type the cluster exactly,
then re-shows each program to confirm its authority reads "none".

--upgrade-authority <keypair>  the current authority's keypair (default: the solana CLI config keypair)
--help                         print this and exit
EOF
}

die() { echo "finalize-programs: $*" >&2; exit 1; }

cluster=""
apply=0
section=""
authority_keypair=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --apply) apply=1 ;;
        --section) [[ $# -ge 2 ]] || die "--section needs a name"; section="$2"; shift ;;
        --upgrade-authority) [[ $# -ge 2 ]] || die "--upgrade-authority needs a keypair path"; authority_keypair="$2"; shift ;;
        -*) die "unknown option $1 (see --help)" ;;
        *) [[ -z "$cluster" ]] || die "only one cluster may be given (got '$cluster' and '$1')"; cluster="$1" ;;
    esac
    shift
done
if [[ -z "$cluster" ]]; then usage; exit 0; fi

# The cluster as solana --url takes it, and the Anchor.toml section it reads.
case "$cluster" in
    devnet) url="devnet"; default_section="devnet" ;;
    mainnet-beta) url="mainnet-beta"; default_section="mainnet" ;;
    testnet) url="testnet"; default_section="testnet" ;;
    localnet) url="localhost"; default_section="localnet" ;;
    http://*|https://*)
        url="$cluster"
        case "$cluster" in
            *devnet*) default_section="devnet" ;;
            *testnet*) default_section="testnet" ;;
            *mainnet*) default_section="mainnet" ;;
            *://localhost*|*://127.0.0.1*) default_section="localnet" ;;
            *) default_section="" ;;
        esac ;;
    *) die "unknown cluster '$cluster': use devnet, mainnet-beta, testnet, localnet or an http(s) RPC URL" ;;
esac
section="${section:-$default_section}"
[[ -n "$section" ]] || die "cannot tell which Anchor.toml section $cluster is: pass --section <name>"
if [[ $apply -eq 1 && ( "$section" == "devnet" || "$section" == "localnet" ) ]]; then
    die "refusing --apply on $cluster: devnet and localnet keep their dev upgrade authority on purpose"
fi

[[ -f "$ANCHOR_TOML" ]] || die "Anchor.toml not found at $ANCHOR_TOML"
# name=id lines of [programs.<section>], comments and blank lines skipped.
programs="$(awk -v want="[programs.$section]" '
    /^[[:space:]]*\[/ { inside = ($0 == want); next }
    inside && /^[[:space:]]*[A-Za-z0-9_]+[[:space:]]*=/ {
        line = $0; sub(/#.*/, "", line)
        split(line, kv, "=")
        name = kv[1]; id = kv[2]
        gsub(/[[:space:]"]/, "", name); gsub(/[[:space:]"]/, "", id)
        if (name != "" && id != "") print name "=" id
    }' "$ANCHOR_TOML")"
[[ -n "$programs" ]] || die "Anchor.toml has no [programs.$section] section with program ids; refusing"

command -v solana >/dev/null 2>&1 || die "the solana CLI is not on PATH"

# The upgrade authority `solana program show` reports ("none" once finalized).
authority_of() {
    local out
    out="$(solana program show "$1" --url "$url")" || return 1
    awk '/^Authority:/ { print $2; found = 1 } END { if (!found) exit 1 }' <<<"$out"
}

authority_args=()
if [[ -n "$authority_keypair" ]]; then authority_args=(--upgrade-authority "$authority_keypair"); fi

echo "Cluster: $cluster (solana --url $url), Anchor.toml section [programs.$section]"
pending=()
while IFS='=' read -r name id; do
    authority="$(authority_of "$id")" || die "could not read program $name ($id) on $cluster"
    printf '  %-16s %s  upgrade authority: %s\n' "$name" "$id" "$authority"
    [[ "$authority" == "none" ]] || pending+=("$name=$id")
done <<<"$programs"

if [[ ${#pending[@]} -eq 0 ]]; then
    echo "Every program is already final; nothing to do."
    exit 0
fi

if [[ $apply -eq 0 ]]; then
    echo
    echo "Dry run. With --apply it would run (IRREVERSIBLE):"
    for entry in "${pending[@]}"; do
        echo "  solana program set-upgrade-authority ${entry#*=} --final --url $url${authority_keypair:+ --upgrade-authority $authority_keypair}"
    done
    exit 0
fi

echo
echo "This makes ${#pending[@]} program(s) on $cluster IMMUTABLE. It cannot be undone."
[[ -r /dev/tty ]] || die "--apply needs a terminal to confirm on"
printf 'Type the cluster (%s) exactly to continue: ' "$cluster" >/dev/tty
read -r typed </dev/tty
[[ "$typed" == "$cluster" ]] || die "confirmation did not match; nothing changed"

failed=0
for entry in "${pending[@]}"; do
    name="${entry%%=*}"; id="${entry#*=}"
    echo "Finalizing $name ($id)"
    solana program set-upgrade-authority "$id" --final --url "$url" ${authority_args[@]+"${authority_args[@]}"}
    authority="$(authority_of "$id")" || authority="unreadable"
    if [[ "$authority" == "none" ]]; then
        echo "  $name: upgrade authority none (final)"
    else
        echo "  $name: upgrade authority still reads '$authority'" >&2
        failed=1
    fi
done
[[ $failed -eq 0 ]] || die "not every program reads authority none; check the output above"
echo "All ${#pending[@]} program(s) on $cluster are final."
