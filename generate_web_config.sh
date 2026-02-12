#!/usr/bin/env bash
set -e

source .env

cat << CONFIG > web/config.js
window.APP_CONFIG = {
  API_BASE_URL: "$API_BASE_URL"
};
CONFIG

echo "✔ web/config.js generated"
