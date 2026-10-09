#!/usr/bin/env bash
# Creates the Firestore indexes and the automatic-deletion (retention) policies the collector needs.
# Safe to run again: whatever already exists is left alone.
#
#   deploy/setup-firestore.sh <project-id>
#
# Needs the gcloud CLI, signed in with permission to administer Firestore in that project, and the Firestore database
# already created (Native mode):  gcloud firestore databases create --location=asia-south1 --project=<project-id>
# The same definitions are in firestore.indexes.json, for `firebase deploy --only firestore` if you prefer that.
set -euo pipefail

PROJECT="${1:?usage: deploy/setup-firestore.sh <project-id>}"
DB="${FIRESTORE_DATABASE:-(default)}"

run() {
  local out
  if out=$("$@" 2>&1); then
    echo "  created"
  elif grep -qiE "already exists|ALREADY_EXISTS" <<<"$out"; then
    echo "  already there"
  else
    echo "$out" >&2
    return 1
  fi
}

echo "Indexes (the sending queue reads these; without them it fails on real Firestore):"
index() { # <fields...> as field-config arguments
  echo "- deliveries: $(grep -o 'field-path=[A-Za-z]*' <<<"$*" | sed 's/field-path=//' | paste -sd, -)"
  run gcloud firestore indexes composite create --project="$PROJECT" --database="$DB" \
    --collection-group=deliveries --query-scope=collection-group "$@"
}
index --field-config=field-path=tenantId,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=createdAt,order=ascending
index --field-config=field-path=tenantId,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=nextRetryAt,order=ascending
index --field-config=field-path=tenantId,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=leaseUntil,order=ascending
index --field-config=field-path=tenantId,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=processingStatus,order=ascending --field-config=field-path=processingNextCheckAt,order=ascending

echo "Retention (documents delete themselves at their expiresAt time):"
for group in persons identities touches sales deliveries ingest_log; do
  echo "- $group.expiresAt"
  run gcloud firestore fields ttls update expiresAt --project="$PROJECT" --database="$DB" --collection-group="$group" --enable-ttl --async
done

echo
echo "Indexes build in the background (a few minutes on an empty database). Check:"
echo "  gcloud firestore indexes composite list --project=$PROJECT --database='$DB'"
echo "  gcloud firestore fields ttls list --project=$PROJECT --database='$DB'"
echo "Suppression records (customers who withdrew consent) are deliberately NOT given an expiry: a withdrawal must outlive the data."
