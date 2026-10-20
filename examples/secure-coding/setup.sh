#!/usr/bin/env bash
# Creates the secure-coding demo repository in a new directory: a small Spring users API with one baseline commit,
# because the review nodes read the change as `git diff HEAD`.
set -euo pipefail

target=${1:?usage: setup.sh <new directory>}
if [ -e "$target" ]; then
  echo "$target already exists; choose a new directory" >&2
  exit 1
fi
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$target"
cp -R "$here/fixture/." "$target/"
cd "$target"
git init -q -b main
git add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "Users API baseline"
echo "demo repository: $(pwd)"
