#!/bin/bash
# willpsdk Premiere Sync — macOS installer
set -e

echo
echo " =============================================="
echo "  willpsdk Premiere Sync — Premiere Pro plugin"
echo " =============================================="
echo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../extension"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_DIR/willpsdk-premiere-sync"
OLD="$EXT_DIR/willps-video-sync"

if [ ! -f "$SRC/CSXS/manifest.xml" ]; then
    echo " [ERROR] Could not find the extension files next to this installer."
    echo "         Keep the folder structure from the download intact."
    read -r -p "Press Enter to close..."
    exit 1
fi

echo " [1/3] Enabling Adobe extension debug mode (needed for unsigned extensions)..."
for V in 9 10 11 12; do
    defaults write "com.adobe.CSXS.$V" PlayerDebugMode 1
done
killall cfprefsd 2>/dev/null || true

echo " [2/3] Installing extension..."
rm -rf "$OLD"
rm -rf "$DEST"
mkdir -p "$EXT_DIR"
cp -R "$SRC" "$DEST"

echo " [3/3] Done!"
echo
echo " Next steps:"
echo "   1. Restart Premiere Pro (fully quit it first)."
echo "   2. Open:  Window > Extensions > willpsdk Premiere Sync"
echo "   3. If macOS asks about incoming network connections for"
echo "      Premiere Pro, click \"Allow\" so your computers can see"
echo "      each other."
echo
echo " Your existing shared projects and synced files are kept."
echo
read -r -p "Press Enter to close..."
