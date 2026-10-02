#!/bin/sh
# 把几秒的画面拼成一张 2×N 的小图，看效果用：sh sheet.sh 输出.jpg 1 2.5 4 6
# 看手绘可爱版：PAGE=cute sh sheet.sh 输出.jpg 1 2.5
out=$1; shift
cd "$(dirname "$0")"
page=${PAGE:-video}
node render.mjs --page "$page" --stills "$(echo "$@" | tr ' ' ',')" > /dev/null
args=""; n=0; layout=""
for t in "$@"; do
  f=$(printf "out/stills/$page/t%.2f.jpg" "$t")
  args="$args -i $f"
  col=$((n % 2)); row=$((n / 2))
  layout="$layout|$([ $col = 0 ] && echo 0 || echo w0)_$([ $row = 0 ] && echo 0 || printf 'h0'; i=1; while [ $i -lt $row ]; do printf '+h0'; i=$((i+1)); done)"
  n=$((n + 1))
done
ffmpeg -loglevel error -y $args -filter_complex "xstack=inputs=$n:layout=${layout#|}:fill=black,scale=1920:-1" "$out"
