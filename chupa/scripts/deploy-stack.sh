#!/bin/bash
set -e

# 사용법: ./deploy-stack.sh <stack-name> <environment>
# 예시:  ./deploy-stack.sh foundation dev

STACK=$1
ENV=${2:-dev}
REGION=${3:-ap-northeast-2}

if [ -z "$STACK" ]; then
  echo "사용법: ./deploy-stack.sh <foundation|database|cache|api|realtime> <dev|prod>"
  exit 1
fi

TEMPLATE_MAP=(
  "foundation:01-foundation.yaml"
  "database:02-database.yaml"
  "cache:03-cache.yaml"
  "api:04-api.yaml"
  "realtime:05-realtime.yaml"
)

TEMPLATE_FILE=""
for entry in "${TEMPLATE_MAP[@]}"; do
  key="${entry%%:*}"
  value="${entry##*:}"
  if [ "$key" == "$STACK" ]; then
    TEMPLATE_FILE="$value"
    break
  fi
done

if [ -z "$TEMPLATE_FILE" ]; then
  echo "❌ 알 수 없는 스택: $STACK"
  echo "사용 가능: foundation, database, cache, api, realtime"
  exit 1
fi

STACK_NAME="chupa-${STACK}-${ENV}"
TEMPLATE_PATH="$(dirname "$0")/../templates/${TEMPLATE_FILE}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🫶 추파 인프라 배포"
echo "  스택: ${STACK_NAME}"
echo "  템플릿: ${TEMPLATE_FILE}"
echo "  환경: ${ENV}"
echo "  리전: ${REGION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# SAM 템플릿 (api, realtime)은 sam deploy 사용
if [ "$STACK" == "api" ] || [ "$STACK" == "realtime" ]; then
  echo "📦 Lambda 의존성 설치 중..."
  cd "$(dirname "$0")/../lambda"
  npm install --production
  cd -

  echo "🔨 SAM 빌드 중..."
  sam build \
    --template-file "$TEMPLATE_PATH" \
    --build-dir ".aws-sam/build-${STACK}"

  echo "🚀 SAM 배포 중..."
  sam deploy \
    --template-file ".aws-sam/build-${STACK}/template.yaml" \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
    --parameter-overrides "Environment=${ENV}" \
    --no-fail-on-empty-changeset \
    --resolve-s3
else
  # 일반 CloudFormation 배포
  echo "🚀 CloudFormation 배포 중..."

  PARAMS="ParameterKey=Environment,ParameterValue=${ENV}"

  # foundation 스택은 추가 파라미터 필요
  if [ "$STACK" == "foundation" ]; then
    if [ -z "$KAKAO_CLIENT_ID" ] || [ -z "$KAKAO_CLIENT_SECRET" ] || [ -z "$KAKAO_MAP_API_KEY" ]; then
      echo "⚠️  다음 환경변수를 설정해주세요:"
      echo "  export KAKAO_CLIENT_ID=..."
      echo "  export KAKAO_CLIENT_SECRET=..."
      echo "  export KAKAO_MAP_API_KEY=..."
      exit 1
    fi
    PARAMS="${PARAMS} ParameterKey=KakaoClientId,ParameterValue=${KAKAO_CLIENT_ID}"
    PARAMS="${PARAMS} ParameterKey=KakaoClientSecret,ParameterValue=${KAKAO_CLIENT_SECRET}"
    PARAMS="${PARAMS} ParameterKey=KakaoMapApiKey,ParameterValue=${KAKAO_MAP_API_KEY}"
  fi

  aws cloudformation deploy \
    --template-file "$TEMPLATE_PATH" \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides $PARAMS \
    --no-fail-on-empty-changeset
fi

echo ""
echo "✅ ${STACK_NAME} 배포 완료!"
echo ""

# Output 출력
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output table 2>/dev/null || true
