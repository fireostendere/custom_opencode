#!/bin/bash
set -euo pipefail

powershell.exe -NoProfile -NonInteractive -Command \
  '$env:OLLAMA_KEEP_ALIVE="10m"; $env:OLLAMA_CONTEXT_LENGTH="24576"; Start-Process -FilePath "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" -ArgumentList "serve" -WindowStyle Hidden'
