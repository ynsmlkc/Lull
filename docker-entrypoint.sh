#!/bin/sh
set -e

# Railway diski root'a ait olarak baglanir; uygulama root DEGIL calisiyor.
# Sahiplik duzeltilmezse SQLite ilk yazmada EACCES alir ve sunucu, veritabani
# yokmus gibi degil, ANLASILMAZ bir hatayla oler.
if [ -n "$LULL_DB" ]; then
  dir=$(dirname "$LULL_DB")
  mkdir -p "$dir"
  chown -R lull:lull "$dir" 2>/dev/null || true
fi

# `exec` SART. Olmazsa bu shell 1 numarali surec olarak kalir, SIGTERM ona
# gider ve Node hic duymaz — temiz kapanis calismaz, platform 30 saniye
# sonra zorla oldurur.
exec su-exec lull "$@"
