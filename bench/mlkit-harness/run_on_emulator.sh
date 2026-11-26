#!/bin/bash
# Runs the ML Kit harness on the running emulator-5554 (ai-renderer) over bench/data images (CORD, Commons,
# usercrop_*, userraw_*) and pulls the OCR JSON to ~/silo-build/bench/ocr_mlkit_all; copy that to bench/cache/ocr_mlkit.
# Then score items with: node bench/eval/items_eval.js
set -uo pipefail
B=$HOME/silo-build
ADB="$B/sdk/platform-tools/adb -s emulator-5554"
$ADB install -r $B/mlkit-harness/app/build/outputs/apk/debug/app-debug.apk >/dev/null
D=/sdcard/Android/data/dev.silo.bench/files
T=/data/local/tmp/mlin
$ADB shell rm -rf $T $D/in $D/out; $ADB shell mkdir -p $T
$ADB shell am start -n dev.silo.bench/.MainActivity >/dev/null; sleep 3; $ADB shell am force-stop dev.silo.bench
for f in $B/bench/data/images/*; do $ADB push -q "$f" $T/; done
for f in $B/bench/data/user_crop/*; do n=$(basename "$f"); $ADB push -q "$f" "$T/usercrop_$n"; done
for f in $B/bench/data/user_raw/*; do n=$(basename "$f"); $ADB push -q "$f" "$T/userraw_$n"; done
$ADB shell chmod -R a+rX $T
# API 30 scoped storage: adb-pushed files in the app's external dir are unreadable to it; the emulator shell is
# root, so copy into the backing /data/media path and hand the files to the app's uid.
U=$($ADB shell stat -c %u /data/data/dev.silo.bench | tr -d '\r')
M=/data/media/0/Android/data/dev.silo.bench/files
$ADB shell "mkdir -p $M/in $M/out && cp $T/* $M/in/ && chown -R $U:$U $M && chmod -R 770 $M"
echo pushed $($ADB shell ls $M/in | wc -l)
$ADB logcat -c
$ADB shell am force-stop dev.silo.bench
$ADB shell am start -n dev.silo.bench/.MainActivity >/dev/null
until $ADB logcat -d -s BENCH:I | grep -q BENCH_DONE; do sleep 10; done
rm -rf $B/bench/ocr_mlkit_all && mkdir -p $B/bench/ocr_mlkit_all && $ADB pull $M/out/. $B/bench/ocr_mlkit_all/ >/dev/null
echo pulled $(ls $B/bench/ocr_mlkit_all | wc -l)
$ADB logcat -d -s BENCH:E | tail -5
echo MLKIT_DONE
