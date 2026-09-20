#!/usr/bin/env bash
# Build the 1200x630 Open Graph cards.
#
# These are what a myobservatory.org link renders as when it is pasted into
# Discord, Slack, Reddit, Cloudy Nights or a forum signature. Without them the
# link is bare text, which for a site whose whole point is photographs is a
# waste of the best asset available.
#
# Fonts are Liberation Serif / Mono: stand-ins for the site's Cormorant Garamond
# and JetBrains Mono, which are Google-hosted and not installed locally. These
# render once, here, so the substitution never reaches a visitor's browser.

set -euo pipefail
cd "$(dirname "$0")/.."

SERIF="Liberation-Serif"
MONO="Liberation-Mono"

card() {
  local src=$1 out=$2 title=$3 eyebrow=$4
  magick "$src" \
    -auto-orient -colorspace sRGB \
    -resize 1200x630^ -gravity center -extent 1200x630 \
    -modulate 92,105,100 \
    \( -size 1200x630 gradient:none-'rgba(7,8,12,0.92)' \) -composite \
    -font "$MONO" -pointsize 21 -fill '#c9a84c' \
    -gravity southwest -annotate +54+150 "$eyebrow" \
    -font "$SERIF" -pointsize 62 -fill '#e8e4df' \
    -gravity southwest -annotate +50+72 "$title" \
    -quality 90 -strip -interlace Plane \
    "$out"
  printf '  %-28s %s KB\n' "$(basename "$out")" "$(( $(stat -c%s "$out") / 1024 ))"
}

mkdir -p images/social

card images/cygnus-wall-hoo.jpg images/social/og-home.jpg \
  "Washington Valley Observatory" \
  "ASTROPHOTOGRAPHY  ·  BORTLE 7  ·  MORRISTOWN, NJ"

card images/trunk.jpg images/social/og-tools.jpg \
  "The Observatory Toolkit" \
  "SKY ATLAS  ·  FOV VIEWER  ·  PLANNER  ·  CALCULATORS"

card images/tadpoles.jpg images/social/og-gallery.jpg \
  "A Journey Through the Night" \
  "DEEP SKY FROM A SUBURBAN BACKYARD"
