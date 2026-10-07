#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

QODE="$(node -e "process.stdout.write(require('@nodegui/qode').qodePath)")"
QT_HOME="$(node -e "process.stdout.write(require('@nodegui/nodegui/config/qtConfig').qtHome)")"
QT_REL="$(node -e "const path=require('path'); const qt=require('@nodegui/nodegui/config/qtConfig').qtHome; process.stdout.write(path.relative('node_modules', qt))")"

if [ ! -x "$QODE" ]; then
  echo "Qode was not found at $QODE. Run npm install in this folder first." >&2
  exit 1
fi
if [ ! -d "$QT_HOME" ]; then
  echo "Qt was not found at $QT_HOME. Run npm install in this folder first." >&2
  exit 1
fi

OUT="build/repuber"
rm -rf "$OUT"
mkdir -p "$OUT/app"

cp -a package.json package-lock.json app.js src static cores "$OUT/app/"
cp -a node_modules "$OUT/app/node_modules"
cp "$QODE" "$OUT/qode"
chmod +x "$OUT/qode"

cat > "$OUT/repuber" << EOF
#!/bin/sh
set -eu
ROOT=\$(CDPATH= cd -- "\$(dirname "\$0")" && pwd)
QT="\$ROOT/app/node_modules/$QT_REL"
case "\$(uname -s)" in
  Darwin)
    export DYLD_FRAMEWORK_PATH="\$QT/lib\${DYLD_FRAMEWORK_PATH:+:\$DYLD_FRAMEWORK_PATH}"
    export DYLD_LIBRARY_PATH="\$QT/lib\${DYLD_LIBRARY_PATH:+:\$DYLD_LIBRARY_PATH}"
    ;;
  *)
    export LD_LIBRARY_PATH="\$QT/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
    ;;
esac
export QT_PLUGIN_PATH="\$QT/plugins"
export QT_QPA_PLATFORM_PLUGIN_PATH="\$QT/plugins/platforms"
cd "\$ROOT/app"
exec "\$ROOT/qode" "\$ROOT/app/app.js" "\$@"
EOF
chmod +x "$OUT/repuber"

echo "Executable written to $(pwd)/$OUT/repuber"
