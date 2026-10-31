#!/usr/bin/env bash
# Konwertuje surowe pliki PCM z Gemini TTS (s16le, 24 kHz, mono) do MP3 dla przeglądarki:
# przycięcie ciszy na początku i końcu, normalizacja głośności (EBU R128), mono 64 kb/s.
# Użycie: scripts/encode-vo.sh <katalog z plikami <id>.pcm> [katalog wyjściowy]
set -euo pipefail
src="${1:?katalog z plikami .pcm}"
out="${2:-public/audio/vo}"
mkdir -p "$out"
for f in "$src"/*.pcm; do
  id="$(basename "$f" .pcm)"
  ffmpeg -hide_banner -loglevel error -y -f s16le -ar 24000 -ac 1 -i "$f" \
    -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,apad=pad_dur=0.15,loudnorm=I=-16:TP=-1.5:LRA=11" \
    -ar 24000 -ac 1 -b:a 64k "$out/$id.mp3"
  echo "$id.mp3"
done
