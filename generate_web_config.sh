#!/usr/bin/env bash
set -e

source .env

# Different functions are deployed at different base paths
INTERPRET_BASE="https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala"
DISPERSE_BASE="https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/disperse"

cat << CONFIG > web/config.js
window.APP_CONFIG = {
  API_BASE_URL: "$API_BASE_URL",
  ENDPOINTS: {
    // Disperse functions (entropy/beacon/distribute)
    disperse: "${DISPERSE_BASE}",
    disperseSwarna: "${DISPERSE_BASE}/swarna",
    distribute: "${DISPERSE_BASE}/distribute",
    
    // Interpret functions (Rishi analysis)
    interpret: "${INTERPRET_BASE}/interpret",
    interpretStructure: "${INTERPRET_BASE}/interpret/structure",
    interpretAdvice: "${INTERPRET_BASE}/interpret/advice",
    export: "${INTERPRET_BASE}/export"
  }
};
CONFIG

echo "✔ web/config.js generated"
