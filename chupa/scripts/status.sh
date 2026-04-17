#!/bin/bash

ENV=${1:-dev}
REGION=${2:-ap-northeast-2}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🫶 추파 인프라 상태 (${ENV})"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

STACKS=("foundation" "database" "cache" "api" "realtime")

for stack in "${STACKS[@]}"; do
  STACK_NAME="chupa-${stack}-${ENV}"
  
  STATUS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || echo "NOT_FOUND")
  
  case "$STATUS" in
    CREATE_COMPLETE|UPDATE_COMPLETE)
      ICON="✅";;
    *IN_PROGRESS*)
      ICON="⏳";;
    *FAILED*|*ROLLBACK*)
      ICON="❌";;
    NOT_FOUND)
      ICON="⬜";;
    *)
      ICON="⚠️";;
  esac
  
  printf "  %s %-20s %s\n" "$ICON" "$stack" "$STATUS"
done

echo ""

# 엔드포인트 출력
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "chupa-api-${ENV}" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text 2>/dev/null || echo "-")

WS_URL=$(aws cloudformation describe-stacks \
  --stack-name "chupa-realtime-${ENV}" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" \
  --output text 2>/dev/null || echo "-")

CDN=$(aws cloudformation describe-stacks \
  --stack-name "chupa-foundation-${ENV}" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" \
  --output text 2>/dev/null || echo "-")

echo "📋 엔드포인트:"
echo "  REST API:   ${API_URL}"
echo "  WebSocket:  ${WS_URL}"
echo "  CDN:        ${CDN}"
