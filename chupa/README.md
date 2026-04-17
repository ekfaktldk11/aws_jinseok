# 🫶 추파(Chupa) AWS 인프라 배포 가이드

## 스택 분리 전략

CloudFormation은 스택당 리소스 500개 제한이 있고,
한 템플릿이 너무 크면 배포 실패/롤백이 전체에 영향을 줍니다.
따라서 **5개 스택**으로 분리합니다.

```
배포 순서 (의존성 순서):

  1. chupa-foundation     기반 (Cognito, S3, CloudFront)
       ↓
  2. chupa-database       데이터베이스 (DynamoDB 전체)
       ↓
  3. chupa-cache          캐시 (VPC, ElastiCache Redis)
       ↓
  4. chupa-api            API (API Gateway + Lambda 전체)
       ↓
  5. chupa-realtime       실시간 (WebSocket API + 푸시 알림)
```

## 스택별 리소스 상세

### Stack 1: chupa-foundation
```
- Cognito User Pool + 카카오/Apple 연동
- S3 버킷 (프로필 이미지)
- CloudFront 배포 (이미지 CDN)
- SSM Parameter Store (공유 설정값)

리소스 수: ~15개
의존성: 없음 (첫 번째로 배포)
```

### Stack 2: chupa-database
```
- DynamoDB: Users 테이블
- DynamoDB: CheckIns 테이블 + TTL + GSI
- DynamoDB: VenueCache 테이블 + TTL
- DynamoDB: Chupas 테이블 + GSI
- DynamoDB: Matches 테이블 + GSI
- DynamoDB: Messages 테이블
- DynamoDB: Reports 테이블
- DynamoDB: Connections 테이블 (WebSocket)

리소스 수: ~20개
의존성: 없음 (foundation과 병렬 배포 가능)
```

### Stack 3: chupa-cache
```
- VPC (Lambda → Redis 연결용)
- 서브넷 (Private x2)
- 보안 그룹
- ElastiCache Redis 클러스터

리소스 수: ~12개
의존성: 없음 (병렬 배포 가능, 하지만 비용 발생)
※ 초기에는 이 스택을 건너뛰고 DynamoDB만으로 운영 가능
```

### Stack 4: chupa-api
```
- API Gateway REST API
- Lambda 함수 7개 (auth, user, venue, checkin, chupa, match, report)
- Lambda Layer (공통 모듈)
- IAM Role (Lambda 실행 역할)
- Cognito Authorizer

리소스 수: ~35개
의존성: foundation (Cognito), database (DynamoDB)
```

### Stack 5: chupa-realtime
```
- API Gateway WebSocket API
- Lambda 함수 3개 ($connect, $disconnect, sendMessage)
- SNS 토픽 (푸시 알림)
- Lambda 함수 1개 (알림 발송)

리소스 수: ~15개
의존성: foundation (Cognito), database (Messages, Connections)
```

## 배포 명령어

```bash
# 전체 순차 배포
./infra/scripts/deploy-all.sh dev

# 개별 스택 배포
./infra/scripts/deploy-stack.sh foundation dev
./infra/scripts/deploy-stack.sh database dev
./infra/scripts/deploy-stack.sh cache dev      # 선택적
./infra/scripts/deploy-stack.sh api dev
./infra/scripts/deploy-stack.sh realtime dev

# 스택 삭제 (역순)
./infra/scripts/destroy-all.sh dev
```

## 환경별 설정

```
dev:  개발 (DynamoDB 온디맨드, Redis 없음)
prod: 운영 (DynamoDB 프로비저닝, Redis 포함)
```

## 예상 비용 (dev 환경)

```
Cognito:     무료 (50,000 MAU까지)
DynamoDB:    ~$10/월 (온디맨드)
S3:          ~$1/월
CloudFront:  ~$1/월
Lambda:      ~$5/월 (프리티어 포함)
API Gateway: ~$5/월
─────────────────────
Redis 없이:  약 $22/월 (~3만원)
Redis 포함:  약 $37/월 (~5만원)
```
