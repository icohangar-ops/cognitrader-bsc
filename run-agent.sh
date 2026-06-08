#!/bin/bash
# ============================================================
# CogniTrader BSC — Production Launcher
# Multi-Signal AI Trading Agent on BNB Chain
# ============================================================

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="${PROJECT_ROOT}/logs"
ENV_FILE="${PROJECT_ROOT}/.env"

# ─── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ─── Helper Functions ────────────────────────────────────────

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Pre-flight Checks ────────────────────────────────────────

check_env() {
    info "Checking environment configuration..."

    if [ ! -f "$ENV_FILE" ]; then
        error "No .env file found at ${ENV_FILE}"
        error "Copy .env.example to .env and fill in your credentials"
        exit 1
    fi

    # Required env vars
    local required_vars=(
        "BSC_RPC_URL"
        "BSC_WALLET_ADDRESS"
        "BSC_PRIVATE_KEY"
        "CMC_API_KEY"
    )

    local missing=0
    for var in "${required_vars[@]}"; do
        if ! grep -q "${var}=" "$ENV_FILE" | grep -v "^#"; then
            error "Missing required env var: ${var}"
            missing=$((missing + 1))
        fi
    done

    if [ $missing -gt 0 ]; then
        error "Please set all required environment variables"
        exit 1
    fi

    success "Environment configuration valid"
}

check_node() {
    info "Checking Node.js version..."

    if ! command -v node &> /dev/null; then
        error "Node.js is not installed"
        exit 1
    fi

    local version
    version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$version" -lt 18 ]; then
        error "Node.js 18+ required (found v${version})"
        exit 1
    fi

    success "Node.js $(node --version) detected"
}

check_dependencies() {
    info "Installing dependencies..."

    if [ ! -d "${PROJECT_ROOT}/node_modules" ]; then
        cd "$PROJECT_ROOT"
        npm install --production
        success "Dependencies installed"
    else
        success "Dependencies already installed"
    fi
}

setup_logs() {
    mkdir -p "$LOG_DIR"
    success "Log directory created at ${LOG_DIR}"
}

# ─── Mode Selection ──────────────────────────────────────────

MODE="${1:-run}"

case "$MODE" in
    run)
        info "Starting CogniTrader BSC..."
        ;;

    dry-run)
        export AGENT_DRY_RUN="true"
        warn "Starting in DRY RUN mode — no real trades"
        ;;

    dev)
        export AGENT_LOG_LEVEL="debug"
        export AGENT_DRY_RUN="true"
        warn "Starting in DEVELOPMENT mode (dry run + debug logs)"
        ;;

    *)
        echo "Usage: $0 {run|dry-run|dev}"
        echo ""
        echo "  run      — Start the agent (live trading)"
        echo "  dry-run  — Start in simulation mode (no real trades)"
        echo "  dev      — Development mode (debug logs + dry run)"
        exit 1
        ;;
esac

# ─── Startup ──────────────────────────────────────────────────

main() {
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  CogniTrader BSC — Production Launcher          ║"
    echo "║  Mode: ${MODE}$(printf '%*s' $((28 - ${#MODE})) '')║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""

    check_node
    check_env
    check_dependencies
    setup_logs

    info "Launching agent..."
    cd "$PROJECT_ROOT"

    # Run with tsx for TypeScript, or compiled JS for production
    if [ "$MODE" = "dev" ]; then
        npx tsx src/index.ts
    else
        node dist/index.js
    fi
}

main "$@"
