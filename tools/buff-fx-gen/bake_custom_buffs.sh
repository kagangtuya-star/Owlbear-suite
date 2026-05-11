#!/bin/bash
# Bake the FULL custom buff lineup per user spec (2026-05-12).
#
# Each persistent emoji buff is assigned a slot on the token edge
# (territory division so multiple stacked buffs don't overlap):
#
#   TL (0.18, 0.18)   T (0.50, 0.10)   TR (0.82, 0.18)
#   L (0.10, 0.50)                     R (0.90, 0.50)
#   BL (0.18, 0.82)   B (0.50, 0.90)   BR (0.82, 0.82)
#                  CENTER (0.50, 0.50)
#
# Animated buffs get unique --seed values so when stacked their
# particles don't visually align.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../public/buff-fx"
mkdir -p "$OUT"

run() {
  echo "→ $@"
  python "$HERE/buff_fx.py" "$@"
}

# ============================================================
# ANIMATED / DIRECTIONAL
# ============================================================

# 魅惑 charmed — pink concentric ripples outward (unchanged)
run ripple --out "$OUT/custom-charmed.webm" \
           --count 3 --cycles 1 --color "#ff66cc" --alpha-peak 0.75 --line-width 4

# 诗人激励 bardic — emit notes from token CENTRE toward upper-right
# (NOT full-canvas drift). Smaller canvas + tight angle jitter.
run launch --out "$OUT/custom-bardic.webm" \
           --emoji musical_note --count 4 --angle 45 \
           --cycles-min 1 --cycles-max 2 \
           --scale-min 0.14 --scale-max 0.22 \
           --reach 0.55 --angle-jitter 18 \
           --seed 600

# 劣势 disadvantage — ⬇ down arrow falling, NO rotation, blue tint
run drift --out "$OUT/custom-disadvantage.webm" \
          --emoji down_arrow --count 3 --angle 180 \
          --cycles-min 1 --cycles-max 1 \
          --scale-min 0.26 --scale-max 0.36 \
          --spread 0.22 --tint "#3b82f6" \
          --no-rotation --seed 200

# 优势 advantage NEW — ⬆ up arrow rising, NO rotation, yellow tint
run drift --out "$OUT/custom-advantage.webm" \
          --emoji up_arrow --count 3 --angle 0 \
          --cycles-min 1 --cycles-max 1 \
          --scale-min 0.26 --scale-max 0.36 \
          --spread 0.22 --tint "#ffcc00" \
          --no-rotation --seed 300

# 飞行术 flying — feathers on both sides (unchanged)
run compose --out "$OUT/custom-flying.webm" --layers '[
  {"template":"place","emoji":"feather","x_frac":0.18,"y_frac":0.55,"scale":0.45,"rotation":-25,"mirror_x":true},
  {"template":"place","emoji":"feather","x_frac":0.82,"y_frac":0.55,"scale":0.45,"rotation":25}
]'

# 冰冻 frozen — whole-token ice cube (unchanged params)
run place --out "$OUT/custom-frozen.webm" \
          --emoji ice_cube --x-frac 0.5 --y-frac 0.5 \
          --scale 0.85 --opacity 0.80 \
          --pulse-pulses 1 --pulse-amp 0.04

# ============================================================
# EDGE-SLOT PERSISTENT EMOJI (territory division)
# Each at its assigned compass position + smaller scale so
# multiple stacked don't visually fight.
# ============================================================

# T — 猎人印记 hunter's mark (green X above head, breathes)
run place --out "$OUT/custom-hunters_mark.webm" \
          --emoji cross_mark --x-frac 0.5 --y-frac 0.12 \
          --scale 0.26 --pulse-pulses 2 --pulse-amp 0.20 \
          --tint "#00ff44"

# TR — 专注 focused (brain pulse)
run place --out "$OUT/custom-focused.webm" \
          --emoji brain --x-frac 0.82 --y-frac 0.20 \
          --scale 0.28 --pulse-pulses 2 --pulse-amp 0.10

# R — 耳聋 deafened (ear + red X overlay) — compose at right edge
run compose --out "$OUT/custom-deafened.webm" --layers '[
  {"template":"place","emoji":"ear","x_frac":0.86,"y_frac":0.50,"scale":0.32},
  {"template":"place","emoji":"cross_mark","x_frac":0.86,"y_frac":0.50,"scale":0.22,"opacity":0.92}
]'

# BR — 失能 incapacitated (broken heart)
run place --out "$OUT/custom-incapacitated.webm" \
          --emoji broken_heart --x-frac 0.82 --y-frac 0.80 \
          --scale 0.28

# B — 倒地 prone (otter laying down)
run place --out "$OUT/custom-prone.webm" \
          --emoji otter --x-frac 0.50 --y-frac 0.88 \
          --scale 0.28

# BL — 缓慢术 slowed (hourglass rotating)
run place --out "$OUT/custom-slowed.webm" \
          --emoji hourglass --x-frac 0.18 --y-frac 0.82 \
          --scale 0.28 --rotation-speed 360

# L — 目盲 blinded (sunglasses on the side)
run place --out "$OUT/custom-blinded.webm" \
          --emoji sunglasses --x-frac 0.14 --y-frac 0.50 \
          --scale 0.30

# TL — 力竭 exhaustion (sleepy sloth pulse)
run place --out "$OUT/custom-exhaustion.webm" \
          --emoji sloth --x-frac 0.20 --y-frac 0.20 \
          --scale 0.30 --pulse-pulses 1 --pulse-amp 0.06

# ============================================================
# CENTRE / CHARACTER-WIDE PERSISTENT EMOJI
# Smaller than the old default 0.55 + fully centred. These are
# mostly mutually-exclusive game states (you're either dead, OR
# petrified, OR grappled) so stacking is rare.
# ============================================================

# 死亡 dead (skull, centered, slight fade)
run place --out "$OUT/custom-dead.webm" \
          --emoji skull --x-frac 0.50 --y-frac 0.50 \
          --scale 0.50 --opacity 0.85

# 石化 petrified (moai face)
run place --out "$OUT/custom-petrified.webm" \
          --emoji moai --x-frac 0.50 --y-frac 0.50 \
          --scale 0.50

# 束缚 restrained (chains wrap, slightly below centre)
run place --out "$OUT/custom-restrained.webm" \
          --emoji chains --x-frac 0.50 --y-frac 0.55 \
          --scale 0.42

# 擒抱 grappled (hugging at centre)
run place --out "$OUT/custom-grappled.webm" \
          --emoji people_hugging --x-frac 0.50 --y-frac 0.55 \
          --scale 0.45

# 狂暴 raging (angry face, centre, shaking)
run shake --out "$OUT/custom-raging.webm" \
          --emoji angry --shakes 6 --amplitude 0.06 \
          --tilt 6 --scale 0.42

# 冻僵 frozen_stiff (cold face on face area, shake)
run shake --out "$OUT/custom-frozen_stiff.webm" \
          --emoji cold_face --shakes 10 --amplitude 0.04 \
          --tilt 4 --scale 0.42

echo
echo "Custom buff bake complete."
ls -la "$OUT"/custom-*.webm 2>&1 | awk '{ printf "  %-50s %5.1f KB\n", $9, $5/1024 }'
