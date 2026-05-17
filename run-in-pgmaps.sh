#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pgmaps_root="${PGMAPS_ROOT:-${repo_dir}/../PGMaps}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 64
fi

resolved=()
for arg in "$@"; do
  case "$arg" in
    datascrapers/*|docs/*)
      resolved+=("${repo_dir}/${arg}")
      ;;
    *)
      resolved+=("$arg")
      ;;
  esac
done

cd "$pgmaps_root"
exec "${resolved[@]}"
