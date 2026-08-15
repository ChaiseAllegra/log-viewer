#!/usr/bin/env bash
# Build the image locally, push it to Google Artifact Registry, and deploy
# it to Cloud Run.
#
# Prereqs (one-time):
#   - gcloud CLI installed and authenticated: gcloud auth login
#   - Docker installed and running
#
# Usage:
#   PROJECT_ID=my-gcp-project ./deploy-gcp.sh
#   PROJECT_ID=my-gcp-project REGION=us-west1 SERVICE=log-viewer ./deploy-gcp.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=my-project ./deploy-gcp.sh}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-log-viewer}"
SERVICE="${SERVICE:-log-viewer}"
TAG="${TAG:-latest}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:${TAG}"

echo "==> Enabling required GCP APIs"
gcloud services enable artifactregistry.googleapis.com run.googleapis.com \
    --project "$PROJECT_ID"

echo "==> Ensuring Artifact Registry repo '${REPO}' exists in ${REGION}"
if ! gcloud artifacts repositories describe "$REPO" \
        --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$REPO" \
        --repository-format docker \
        --location "$REGION" \
        --project "$PROJECT_ID"
fi

echo "==> Configuring Docker auth for ${REGION}-docker.pkg.dev"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> Building image ${IMAGE} (linux/amd64)"
docker build --platform linux/amd64 -t "$IMAGE" .

echo "==> Pushing image"
docker push "$IMAGE"

echo "==> Deploying to Cloud Run"
gcloud run deploy "$SERVICE" \
    --image "$IMAGE" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --platform managed \
    --port 8000 \
    --memory 2Gi \
    --cpu 2 \
    --execution-environment gen2 \
    --max-instances 1 \
    --allow-unauthenticated

echo "==> Done. Service URL:"
gcloud run services describe "$SERVICE" \
    --project "$PROJECT_ID" --region "$REGION" \
    --format 'value(status.url)'
