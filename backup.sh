#!/usr/bin/env bash
# ============================================================
#  Quarc Reader — Data Backup
#  Run from the project directory:
#    bash backup.sh            # database + every uploaded PDF + .env
#    bash backup.sh --no-files # database + .env only (the PDFs are the big part;
#                              # copy the volume yourself, e.g. with rsync)
#
#  Creates: ./backup_YYYYMMDD_HHMMSS/
#    reader.db    — the library: documents, annotations, share links
#    files/       — the uploaded PDFs (files/<user>/<sha256>)
#    .env         — all secrets and config (the JWT_SECRET must stay the same)
# ============================================================
set -e

WITH_FILES=1
[ "$1" = "--no-files" ] && WITH_FILES=0

BACKUP_DIR="./backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Backing up to $BACKUP_DIR ..."

BACKEND=$(docker ps -q --filter "label=com.docker.compose.service=backend" | head -1)
if [ -z "$BACKEND" ]; then
  echo "ERROR: backend container not running. Start it first: docker compose up -d backend"
  exit 1
fi

# reader.db runs in WAL mode — recent writes can sit in reader.db-wal, which
# this script doesn't copy. Checkpoint it into the main file first so the
# backup is complete and doesn't depend on -wal/-shm files.
echo "  · Checkpointing WAL into reader.db ..."
docker exec "$BACKEND" node -e "require('/app/src/db').getDb().pragma('wal_checkpoint(TRUNCATE)')" 2>/dev/null || true

echo "  · Exporting reader.db ..."
docker cp "$BACKEND:/app/data/reader.db" "$BACKUP_DIR/reader.db"

if [ "$WITH_FILES" = "1" ]; then
  echo "  · Exporting uploaded PDFs (this can take a while) ..."
  docker cp "$BACKEND:/app/data/files" "$BACKUP_DIR/files" 2>/dev/null || mkdir -p "$BACKUP_DIR/files"
fi

echo "  · Copying .env ..."
cp .env "$BACKUP_DIR/.env"

DB_SIZE=$(du -sh "$BACKUP_DIR/reader.db" | awk '{print $1}')
echo ""
echo "Backup complete: $BACKUP_DIR"
echo "  reader.db : $DB_SIZE"
if [ "$WITH_FILES" = "1" ]; then
  echo "  files/    : $(du -sh "$BACKUP_DIR/files" | awk '{print $1}')"
else
  echo "  files/    : skipped (--no-files)"
fi
echo ""
echo "Next: copy this folder to the new server."
echo "  scp -r $BACKUP_DIR user@new-server:~/Quarc_Reader/"
echo "The backup holds .env, so keep it private."
