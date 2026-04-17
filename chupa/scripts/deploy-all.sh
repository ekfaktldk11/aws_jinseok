#!/bin/bash
set -e

ENV=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🫶 추파 전체 인프라 배포 시작"
echo "  환경: ${ENV}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

STACKS=("foundation" "database" "api" "realtime")

# cache는 prod에서만 배포 (비용 절약)
if [ "$ENV" == "prod" ]; then
  STACKS=("foundation" "database" "cache" "api" "realtime")
fi

TOTAL=${#STACKS[@]}
CURRENT=0

for stack in "${STACKS[@]}"; do
  CURRENT=$((CURRENT + 1))
  echo ""
  echo "━━━ [${CURRENT}/${TOTAL}] ${stack} 배포 중 ━━━"
  echo ""
  "$SCRIPT_DIR/deploy-stack.sh" "$stack" "$ENV"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 전체 배포 완료!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# API URL 출력
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "chupa-api-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text 2>/dev/null || echo "N/A")

WS_URL=$(aws cloudformation describe-stacks \
  --stack-name "chupa-realtime-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" \
  --output text 2>/dev/null || echo "N/A")

echo "📋 엔드포인트:"
echo "  REST API: ${API_URL}"
echo "  WebSocket: ${WS_URL}"
echo ""
echo "💡 앱에서 사용할 환경변수:"
echo "  EXPO_PUBLIC_API_URL=${API_URL}"
echo "  EXPO_PUBLIC_WS_URL=${WS_URL}"
