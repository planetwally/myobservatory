#!/usr/bin/env bash
#
# Washington Valley Observatory  ·  myobservatory.org
# Copyright (c) 2025-2026 Washington Valley Observatory. All rights reserved.
# Not licensed for reuse or redistribution. See LICENSE.
#
# Build responsive derivatives for the gallery.
#
# Originals live in images/ and are never referenced by the site directly --
# they are the archive. Everything the browser loads comes out of images/opt/.
#
# The ladder is deliberately generous: the widest step is far larger than any
# slot on the page actually needs, so a lightbox on a 4K display still has
# headroom and the grid lands a step above "just enough" on ordinary screens.
# Quality is set high for the same reason -- these are astrophotographs, and
# faint nebulosity is exactly what aggressive chroma quantisation eats first.
#
# Usage:  tools/build-images.sh [--force]
# Needs:  ImageMagick 7 with the WebP delegate.

set -euo pipefail

cd "$(dirname "$0")/.."

SRC=images
OUT=images/opt
WIDTHS=(800 1280 1920 2560)
Q_WEBP=92
Q_JPEG=92

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

command -v magick >/dev/null || { echo "magick (ImageMagick 7) not found" >&2; exit 1; }
magick -list format | grep -q 'WEBP.*rw' || { echo "ImageMagick has no WebP delegate" >&2; exit 1; }

mkdir -p "$OUT"

# One encode pass. Strips metadata but keeps the colour profile, because
# dropping that is what turns a calibrated red channel muddy in Safari.
encode() {
  local src=$1 dst=$2 w=$3 quality=$4
  magick "$src" \
    -auto-orient \
    -colorspace sRGB \
    -filter Lanczos \
    -resize "${w}x>" \
    -strip \
    -quality "$quality" \
    -define webp:method=6 \
    -interlace Plane \
    "$dst"
}

total_src=0
total_out=0
count=0

shopt -s nullglob
for src in "$SRC"/*.jpg "$SRC"/*.jpeg "$SRC"/*.png; do
  [[ -f "$src" ]] || continue
  base=$(basename "$src"); base=${base%.*}
  # Skip anything with characters that make a URL awkward; those are archive-only.
  [[ "$base" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "skip (name): $src"; continue; }
  # Archive-only originals the site does not reference. Leo-triplet.jpg is a
  # case-duplicate of leo-triplet.jpg -- building both would produce derivatives
  # that collide on any case-insensitive filesystem.
  case "$base" in
    Leo-triplet|m45-1) echo "skip (archive-only): $src"; continue ;;
  esac

  srcw=$(magick identify -format '%w' "$src[0]")
  srcbytes=$(stat -c%s "$src")
  total_src=$((total_src + srcbytes))

  # Ladder steps strictly below the original -- never upscale.
  steps=()
  for w in "${WIDTHS[@]}"; do
    (( w < srcw )) && steps+=("$w")
  done
  top=${WIDTHS[${#WIDTHS[@]}-1]}
  if (( ${#steps[@]} == 0 )); then
    # Source is smaller than the whole ladder: one derivative at native width.
    steps=("$srcw")
  elif (( srcw < top )); then
    # Source never reached the top rung, so the ladder is leaving resolution on
    # the table. Add native width, but only when it is a real step up -- a 5%
    # gap is not worth another pair of files.
    last=${steps[${#steps[@]}-1]}
    (( srcw > last * 115 / 100 )) && steps+=("$srcw")
  fi
  # Source >= top rung: the ladder already tops out where we want it to. A
  # near-original step there is pure weight -- 2560px is more than the lightbox
  # can show on any display we are targeting.

  for w in "${steps[@]}"; do
    for ext in webp jpg; do
      dst="$OUT/${base}-${w}.${ext}"
      if (( FORCE )) || [[ ! -f "$dst" ]] || [[ "$src" -nt "$dst" ]]; then
        q=$Q_WEBP; [[ $ext == jpg ]] && q=$Q_JPEG
        encode "$src" "$dst" "$w" "$q"
        printf '  %-44s %6s KB\n' "$(basename "$dst")" "$(( $(stat -c%s "$dst") / 1024 ))"
      fi
      total_out=$((total_out + $(stat -c%s "$dst")))
      count=$((count + 1))
    done
  done
  echo "$base: ${srcw}px source -> ${steps[*]}"
done

echo
echo "originals:   $((total_src / 1024 / 1024)) MB"
echo "derivatives: $((total_out / 1024 / 1024)) MB across $count files"
