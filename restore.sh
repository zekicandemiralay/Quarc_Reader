#!/usr/bin/env bash
# ============================================================
#  Quarc Reader — Data Restore
#  Run on the target server from the Quarc_Reader directory:
#    bash restore.sh ./backup_20240101_120000
# ============================================================
set -e

BACKUP_DIR="$1"

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Usage: bash restore.sh <backup-dir>"
  echo "  e.g. bash restore.sh ./backup_20240101_120000"
  exit 1
fi

if [ ! -f "$BACKUP_DIR/reader.db" ] || [ ! -f "$BACKUP_DIR/.env" ]; then
  echo "ERROR: backup directory must contain reader.db and .env"
  exit 1
fi

echo "Restoring from $BACKUP_DIR ..."

echo "  · Restoring .env ..."
cp "$BACKUP_DIR/.env" .env

echo "  · Initializing Docker volume ..."
docker compose up -d backend 2>/dev/null || true
sleep 3
docker compose stop backend

BACKEND=$(docker ps -aq --filter "label=com.docker.compose.service=backend" | head -1)
if [ -z "$BACKEND" ]; then
  echo "ERROR: backend container not found. Run 'docker compose up -d backend' first."
  exit 1
fi

echo "  · Restoring reader.db ..."
docker cp "$BACKUP_DIR/reader.db" "$BACKEND:/app/data/reader.db"
# A stale WAL from the container's first start would be replayed over the restored file.
docker run --rm --volumes-from "$BACKEND" alpine sh -c 'rm -f /app/data/reader.db-wal /app/data/reader.db-shm' 2>/dev/null || true

if [ -d "$BACKUP_DIR/files" ]; then
  echo "  · Restoring uploaded PDFs ..."
  docker cp "$BACKUP_DIR/files/." "$BACKEND:/app/data/files/" 2>/dev/null || {
    docker run --rm --volumes-from "$BACKEND" alpine mkdir -p /app/data/files
    docker cp "$BACKUP_DIR/files/." "$BACKEND:/app/data/files/"
  }
else
  echo "  · (no files/ in this backup — documents will show as 'not available' until their PDFs are re-uploaded)"
fi

echo "  · Starting all services ..."
bash deploy.sh

echo ""
echo "Restore complete. Check status: bash check.sh"
