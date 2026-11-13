#!/usr/bin/env bash
#
# Merges an upstream branch into the current branch without ever dropping the CN
# adaptation, and reports what it had to do.
#
#   scripts/ci/merge-upstream.sh \
#       --upstream-ref upstream/v5 \
#       --base "$(git merge-base upstream/v5 HEAD)" \
#       --message "chore: merge upstream into the CN fork" \
#       --log-dir . \
#       --output "$GITHUB_OUTPUT"
#
# Writes these keys to --output (and to stdout as `key=value` lines):
#   state       merged | current | conflict
#   resolved    paths whose delta was re-planted
#   overridden  paths that kept the fork version
#   restored    CN files upstream had deleted or renamed away
#
# Resolution is three tiers per conflicted path, cheapest first:
#   1. take the upstream version and re-apply only the fork's delta for that path,
#      so the adaptation lands on top of the upstream rewrite;
#   2. take the fork version and apply only the upstream delta to it, which
#      recovers the paths where each side added a different neighbour to the same
#      region;
#   3. keep the fork version and record it, so the adaptation is never lost
#      silently.
#
# A fourth case is handled after the merge: upstream may delete or rename a file
# the fork owns without any conflict, which would drop CN behaviour without a
# trace. Every marker file that vanished is restored from the fork tip and listed
# under `restored`.
#
# The caller still runs check-cn-adaptation.sh and the build afterwards, so a
# wrong pick cannot reach the branch unnoticed.
#
set -uo pipefail

upstream_ref=""
base=""
message=""
log_dir="."
output=""
marker_list="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/ci/cn-adaptation.txt"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --upstream-ref) upstream_ref="$2"; shift 2 ;;
        --base) base="$2"; shift 2 ;;
        --message) message="$2"; shift 2 ;;
        --log-dir) log_dir="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        --marker-list) marker_list="$2"; shift 2 ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

if [ -z "${upstream_ref}" ] || [ -z "${base}" ]; then
    echo "--upstream-ref and --base are required" >&2
    exit 2
fi

mkdir -p "${log_dir}"
auto_resolved="${log_dir}/auto-resolved.txt"
overridden="${log_dir}/overridden.txt"
unresolved="${log_dir}/unresolved.txt"
restored="${log_dir}/restored.txt"
replant_log="${log_dir}/replant.log"
report="${log_dir}/merge-result.txt"
: >"${auto_resolved}"
: >"${overridden}"
: >"${unresolved}"
: >"${restored}"
: >"${replant_log}"
: >"${report}"

# Writes a key for the caller twice: into --output (which may be $GITHUB_OUTPUT) and
# into a report file the caller can read back. Keeping the two separate means the
# human-readable log lines below never have to share a stream with the key=value
# lines, which $GITHUB_OUTPUT would reject.
emit() {
    if [ -n "${output}" ]; then
        printf '%s=%s\n' "$1" "$2" >>"${output}"
    fi
    printf '%s=%s\n' "$1" "$2" >>"${report}"
}

# Apply the delta between two revisions for one path.
# --3way reports success even when it leaves conflict markers behind, so the file
# itself is inspected. When the three-way merge cannot place the hunk, retry with
# -C0, which needs no surrounding context and therefore survives a neighbouring
# insertion.
apply_delta() {
    local output_text
    if output_text=$(git diff --binary "$1" "$2" -- "$3" | git apply --3way --whitespace=nowarn - 2>&1) \
        && ! grep -q '^<<<<<<< ' "$3" 2>/dev/null; then
        return 0
    fi
    printf '%s\n' "${output_text}" >>"${replant_log}"
    [ -n "${4:-}" ] || return 1
    git checkout "$4" -- "$3" 2>>"${replant_log}" || return 1
    output_text=$(git diff --binary "$1" "$2" -- "$3" | git apply -C0 --whitespace=nowarn - 2>&1) || {
        printf '%s\n' "${output_text}" >>"${replant_log}"
        return 1
    }
    printf '%s\n' "${output_text}" >>"${replant_log}"
    ! grep -q '^<<<<<<< ' "$3" 2>/dev/null
}

# --no-commit keeps the result ours to inspect before it becomes a commit, which is
# what lets the restore pass below run before the merge is recorded.
if git merge --no-commit --no-ff "${upstream_ref}" -m "${message}" >"${log_dir}/merge.log" 2>&1; then
    echo "The merge applied without conflicts."
else
    echo "Merge conflicted; re-planting the CN delta."
    mapfile -t conflicts < <(git diff --name-only --diff-filter=U)
    echo "Conflicted paths: ${#conflicts[@]}"

    for path in "${conflicts[@]}"; do
        replayed=0
        # Tier 1: the fork delta on the upstream version.
        if git cat-file -e "${upstream_ref}:${path}" 2>/dev/null \
            && git checkout "${upstream_ref}" -- "${path}" 2>>"${replant_log}"; then
            if apply_delta "${base}" HEAD "${path}" "${upstream_ref}"; then
                replayed=1
                echo "Re-planted the fork delta on ${path}."
            fi
        fi
        # Tier 2: the upstream delta on the fork version.
        if [ "${replayed}" = "0" ] && git cat-file -e "HEAD:${path}" 2>/dev/null \
            && git checkout HEAD -- "${path}" 2>>"${replant_log}"; then
            if apply_delta "${base}" "${upstream_ref}" "${path}" HEAD; then
                replayed=1
                echo "Re-planted the upstream delta on the fork version of ${path}."
            fi
        fi
        if [ "${replayed}" = "1" ]; then
            git add -- "${path}"
            echo "${path}" >>"${auto_resolved}"
            continue
        fi
        # Tier 3: the fork version wins outright.
        if git checkout HEAD -- "${path}" 2>>"${replant_log}"; then
            git add -- "${path}"
            echo "${path}" >>"${overridden}"
            echo "::warning::Kept the fork version of ${path}; the upstream change to it was skipped."
            continue
        fi
        echo "${path} (could not be resolved)" >>"${unresolved}"
    done

    if [ -s "${unresolved}" ]; then
        cp "${unresolved}" "${log_dir}/conflicted.txt"
        echo "Paths that could not be resolved:"
        cat "${unresolved}"
        git merge --abort || true
        emit state conflict
        exit 0
    fi
fi

# Upstream can delete or rename a file the fork owns without any conflict, and the
# merge would then drop CN behaviour silently. Restore every marker file that is
# gone but still exists on the fork tip.
if [ -f "${marker_list}" ]; then
    while IFS='|' read -r path _needle; do
        # core.autocrlf hands the list back with CRLF on Windows; strip it or the
        # path never matches a real file.
        path="${path%$'\r'}"
        case "${path}" in
            '' | '#'*) continue ;;
        esac
        [ -e "${path}" ] && continue
        if git cat-file -e "HEAD:${path}" 2>/dev/null; then
            if git checkout HEAD -- "${path}" 2>>"${replant_log}"; then
                git add -- "${path}"
                echo "${path}" >>"${restored}"
                echo "::warning::Upstream dropped ${path}; restored the fork version."
            fi
        fi
    done <"${marker_list}"
fi

if ! git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && git diff --cached --quiet; then
    emit state current
    exit 0
fi

if ! git commit --no-edit >>"${log_dir}/merge.log" 2>&1; then
    echo "The resolved merge could not be committed." >"${log_dir}/conflicted.txt"
    git merge --abort || true
    emit state conflict
    exit 0
fi

resolved=$(wc -l <"${auto_resolved}" | tr -d ' ')
kept=$(wc -l <"${overridden}" | tr -d ' ')
brought_back=$(wc -l <"${restored}" | tr -d ' ')
emit state merged
emit resolved "${resolved}"
emit overridden "${kept}"
emit restored "${brought_back}"
echo "Merged; re-planted ${resolved} path(s), kept the fork version of ${kept}, restored ${brought_back}."
