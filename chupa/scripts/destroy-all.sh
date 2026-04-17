#!/bin/bash
set -e

ENV=${1:-dev}
REGION=${2:-ap-northeast-2}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚠️  추파 전체 인프라 삭제"
echo "  환경: ${ENV}"
echo "  리전: ${REGION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⚠️  이 작업은 되돌릴 수 없습니다!"
echo "    ${ENV} 환경의 모든 리소스가 삭제됩니다."
echo ""
read -p "정말 삭제하시겠습니까? (yes 입력): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "취소되었습니다."
  exit 0
fi

# 역순으로 삭제 (의존성 순서)
STACKS=("realtime" "api" "cache" "database" "foundation")

for stack in "${STACKS[@]}"; do
  STACK_NAME="chupa-${stack}-${ENV}"
  
  echo ""
  echo "🗑️  ${STACK_NAME} 삭제 중..."
  
  # 스택이 존재하는지 확인
  if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" &>/dev/null; then
    
    # S3 버킷이 있으면 먼저 비우기 (foundation 스택)
    if [ "$stack" == "foundation" ]; then
      BUCKET=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='ImageBucketName'].OutputValue" \
        --output text 2>/dev/null || echo "")
      
      if [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; then
        echo "  🪣 S3 버킷 비우는 중: ${BUCKET}"
        aws s3 rm "s3://${BUCKET}" --recursive --region "$REGION" 2>/dev/null || true
      fi
    fi
    
    aws cloudformation delete-stack \
      --stack-name "$STACK_NAME" \
      --region "$REGION"
    
    echo "  ⏳ 삭제 대기 중..."
    aws cloudformation wait stack-delete-complete \
      --stack-name "$STACK_NAME" \
      --region "$REGION" 2>/dev/null || true
    
    echo "  ✅ ${STACK_NAME} 삭제 완료"
  else
    echo "  ⏭️  ${STACK_NAME} 스택이 존재하지 않음 (건너뜀)"
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 전체 삭제 완료!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
