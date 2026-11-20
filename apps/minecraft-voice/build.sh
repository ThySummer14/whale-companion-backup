#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo 'Usage: bash build.sh <Simple Voice Chat Fabric JAR> <output JAR>' >&2
  exit 2
fi

source_dir="$(cd "$(dirname "$0")" && pwd)"
classes="$(mktemp -d)"
trap 'rm -rf "$classes"' EXIT
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" --release 21 -cp "$1" -d "$classes" "$source_dir/VoiceRelay.java"
"${JAVA_HOME:+$JAVA_HOME/bin/}jar" --create --file "$2" -C "$classes" . -C "$source_dir" fabric.mod.json
