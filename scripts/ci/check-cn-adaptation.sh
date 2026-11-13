#!/usr/bin/env bash
#
# Verifies that the CN adaptation is still present in the working tree.
#
# Reads `scripts/ci/cn-adaptation.txt` (one `path|needle` per line, `#` comments
# allowed) and greps every file for its needle. Exits 1 and prints one line per
# missing marker; exits 0 when the tree is intact.
#
#   scripts/ci/check-cn-adaptation.sh [--root DIR] [--list FILE]
#
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
list="${root}/scripts/ci/cn-adaptation.txt"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --root)
            root="$2"
            shift 2
            ;;
        --list)
            list="$2"
            shift 2
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

if [ ! -f "${list}" ]; then
    echo "marker list not found: ${list}" >&2
    exit 2
fi

missing=0
checked=0
while IFS='|' read -r path needle; do
    # A Windows checkout with core.autocrlf hands the list back with CRLF, which
    # would otherwise be glued to the needle and make every marker look missing.
    path="${path%$'\r'}"
    needle="${needle%$'\r'}"
    case "${path}" in
        '' | '#'*) continue ;;
    esac
    checked=$((checked + 1))
    if [ ! -f "${root}/${path}" ]; then
        echo "${path} is missing entirely"
        missing=$((missing + 1))
        continue
    fi
    if ! grep -Fq -- "${needle}" "${root}/${path}"; then
        echo "${path} no longer contains ${needle}"
        missing=$((missing + 1))
    fi
done <"${list}"

if [ "${missing}" -gt 0 ]; then
    echo "The CN adaptation lost ${missing} of ${checked} marker(s)." >&2
    exit 1
fi

echo "All ${checked} CN markers are present."
