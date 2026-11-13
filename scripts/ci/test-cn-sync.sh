#!/usr/bin/env bash
#
# Exercises scripts/ci/merge-upstream.sh and scripts/ci/check-cn-adaptation.sh
# against throwaway repositories, so the sync logic can be proven without waiting
# for a real upstream release.
#
#   scripts/ci/test-cn-sync.sh
#
# Each scenario builds a fork/upstream pair from the same base, applies an upstream
# change, runs the merge, and asserts on the reported state plus the CN markers.
#
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
merge_script="${here}/merge-upstream.sh"
check_script="${here}/check-cn-adaptation.sh"
workdir="$(mktemp -d)"
failures=0

cleanup() {
    rm -rf "${workdir}"
}
trap cleanup EXIT

markers="${workdir}/markers.txt"
cat >"${markers}" <<'MARKERS'
src/config/Config.ts|customCN
src/constants/urls.ts|CN_HOT_APIS
src/data/cn-list.json|"zh"
MARKERS

pass() {
    echo "  ok   $1"
}

fail() {
    echo "  FAIL $1"
    failures=$((failures + 1))
}

# Builds a repo whose fork branch carries the CN adaptation and whose upstream
# branch sits on the same base. `cn-list.json` is CN-only content that the fork
# never touches, which is what lets the delete scenario stay conflict-free.
setup() {
    local name="$1"
    repo="${workdir}/${name}"
    mkdir -p "${repo}/src/config" "${repo}/src/constants" "${repo}/src/data"
    cd "${repo}" || exit 1
    git init -q -b fork
    git config user.email 'test@example.com'
    git config user.name 'CN sync test'

    printf "export type QueryEngine = 'google' | 'local'\n" >src/config/Config.ts
    printf 'export const URLS = {}\n' >src/constants/urls.ts
    # The zh list lives in the base commit and the fork never touches it, so upstream
    # can delete it without a conflict; only the restore pass can bring it back.
    printf '{\n    "en": ["one"],\n    "zh": ["news"]\n}\n' >src/data/cn-list.json
    git add -A
    git commit -qm 'base'

    git checkout -q -b upstream
    git checkout -q fork

    printf "export type QueryEngine = 'google' | 'local' | 'customCN'\n" >src/config/Config.ts
    printf 'export const CN_HOT_APIS = []\n' >src/constants/urls.ts
    git commit -qam 'fork adds the CN adaptation'

    # The remote must not be named `upstream`, or `upstream/upstream` is ambiguous
    # against the local branch of the same name.
    git remote add source "${repo}"
    git fetch -q source
}

# Runs the merge for the current repo and echoes the reported state.
run_merge() {
    local output_file="${repo}/output.txt"
    : >"${output_file}"
    bash "${merge_script}" \
        --upstream-ref "source/upstream" \
        --base "$(git merge-base source/upstream HEAD)" \
        --message 'chore: merge upstream' \
        --log-dir "${repo}" \
        --output "${output_file}" \
        --marker-list "${markers}" >"${repo}/merge-out.log" 2>&1
    sed -n 's/^state=//p' "${output_file}" | tail -n 1
}

field() {
    sed -n "s/^$1=//p" "${repo}/output.txt" | tail -n 1
}

# --- scenario 1: upstream touches an unrelated file -------------------------
echo 'scenario: clean merge'
setup clean
git checkout -q upstream
printf 'notes\n' >NOTES.md
git add -A
git commit -qm 'upstream adds a file'
git checkout -q fork
git fetch -q source
state="$(run_merge)"
[ "${state}" = "merged" ] && pass "state=merged" || fail "state was ${state}"
[ "$(field resolved)" = "0" ] && pass "resolved=0" || fail "resolved=$(field resolved)"
[ "$(field overridden)" = "0" ] && pass "overridden=0" || fail "overridden=$(field overridden)"
[ "$(field restored)" = "0" ] && pass "restored=0" || fail "restored=$(field restored)"
[ -f NOTES.md ] && pass "upstream file present" || fail "upstream file missing"
bash "${check_script}" --root "${repo}" --list "${markers}" >/dev/null && pass "guard ok" || fail "guard failed"

# --- scenario 2: upstream edits a neighbouring line -------------------------
echo 'scenario: distant change, both sides kept'
setup distant
git checkout -q upstream
printf '// upstream addition\n' >>src/config/Config.ts
git commit -qam 'upstream appends a line'
git checkout -q fork
git fetch -q source
state="$(run_merge)"
[ "${state}" = "merged" ] && pass "state=merged" || fail "state was ${state}"
grep -Fq '// upstream addition' src/config/Config.ts && pass "upstream line kept" || fail "upstream line lost"
grep -Fq "'customCN'" src/config/Config.ts && pass "CN line kept" || fail "CN line lost"
bash "${check_script}" --root "${repo}" --list "${markers}" >/dev/null && pass "guard ok" || fail "guard failed"

# --- scenario 3: upstream rewrites the very same line ----------------------
echo 'scenario: same-line conflict, fork version kept'
setup sameline
git checkout -q upstream
printf "export type QueryEngine = 'google' | 'local' | 'hackernews'\n" >src/config/Config.ts
git commit -qam 'upstream adds an engine'
git checkout -q fork
git fetch -q source
state="$(run_merge)"
[ "${state}" = "merged" ] && pass "state=merged" || fail "state was ${state}"
[ "$(field overridden)" = "1" ] && pass "overridden=1" || fail "overridden=$(field overridden)"
grep -Fq "'customCN'" src/config/Config.ts && pass "CN line survived" || fail "CN line lost"
bash "${check_script}" --root "${repo}" --list "${markers}" >/dev/null && pass "guard ok" || fail "guard failed"

# --- scenario 4: upstream deletes a CN-only file ---------------------------
echo 'scenario: upstream deletes a CN file, fork version restored'
setup deleted
git checkout -q upstream
git rm -q src/data/cn-list.json
git commit -qm 'upstream drops the query list'
git checkout -q fork
git fetch -q source
state="$(run_merge)"
[ "${state}" = "merged" ] && pass "state=merged" || fail "state was ${state}"
[ "$(field restored)" = "1" ] && pass "restored=1" || fail "restored=$(field restored)"
grep -Fq '"zh"' src/data/cn-list.json && pass "file restored with the zh list" || fail "file not restored"
bash "${check_script}" --root "${repo}" --list "${markers}" >/dev/null && pass "guard ok" || fail "guard failed"

# --- scenario 5: the guard notices a lost marker ---------------------------
echo 'scenario: guard rejects a tree that lost a marker'
setup guard
printf "export type QueryEngine = 'google' | 'local'\n" >src/config/Config.ts
if bash "${check_script}" --root "${repo}" --list "${markers}" >"${repo}/guard.log" 2>&1; then
    fail "guard accepted a tree without customCN"
else
    pass "guard exit 1"
fi
grep -Fq 'no longer contains customCN' "${repo}/guard.log" && pass "guard names the marker" || fail "guard message unclear"

# --- scenario 6: the guard notices a deleted file --------------------------
echo 'scenario: guard rejects a tree that lost a file'
rm -f src/data/cn-list.json
if bash "${check_script}" --root "${repo}" --list "${markers}" >"${repo}/guard2.log" 2>&1; then
    fail "guard accepted a tree without the query list"
else
    pass "guard exit 1"
fi
grep -Fq 'missing entirely' "${repo}/guard2.log" && pass "guard reports the missing file" || fail "guard message unclear"

echo
if [ "${failures}" -gt 0 ]; then
    echo "${failures} check(s) failed"
    exit 1
fi
echo 'All CN sync scenarios passed.'
