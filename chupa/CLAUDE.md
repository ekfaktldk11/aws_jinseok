# Chupa AWS Backend — CLAUDE.md

> 추파(Chupa) AWS 백엔드 컨텍스트. 새 세션에서 이 문서만 읽어도 현재 상태와 다음 작업을 파악할 수 있도록 작성.

---

## 1. 프로젝트 개요

**추파(Chupa)** 백엔드 인프라. AWS SAM(CloudFormation) 기반 멀티 스택 구조.

- **위치**: `aws_jinseok/chupa/`
- **클라이언트**: 별도 React Native 저장소 (Expo SDK 54)
- **환경**: dev (현재 운영 중) / prod (미구성)
- **AWS 리전**: `ap-northeast-2` (서울)

---

## 2. 스택 구조 (5개)

배포 순서 = 의존성 순서. **반드시 이 순서대로 배포.**

```
Stack 1: chupa-foundation   → Cognito, S3, CloudFront, SSM
Stack 2: chupa-database     → DynamoDB 8개 테이블
Stack 3: chupa-cache        → VPC + ElastiCache Redis (prod 전용, dev 스킵 가능)
Stack 4: chupa-api          → REST API Gateway + 6 Lambda + SNS Topic
Stack 5: chupa-realtime     → WebSocket API + 4 Lambda (connect/disconnect/sendMessage/notification)
```

스택 간 의존성은 `!ImportValue`로 주고받음. 각 스택의 `Outputs`가 다음 스택의 `ImportValue` 소스.

---

## 3. 디렉토리 구조

```
chupa/
├── chupa-foundation/
│   ├── template.yaml         # Stack 1: Cognito, S3, CloudFront, SSM
│   └── samconfig.toml
├── chupa-database/
│   └── template.yaml         # Stack 2: DynamoDB 테이블 8개
├── chupa-cache/
│   └── template.yaml         # Stack 3: VPC + Redis (prod only)
├── chupa-api/
│   ├── template.yaml         # Stack 4: REST API + Lambda 6개
│   └── samconfig.toml
├── chupa-realtime/
│   ├── template.yaml         # Stack 5: WebSocket + Lambda 4개
│   └── samconfig.toml
├── lambda/
│   ├── shared/
│   │   └── utils.js          # 공유 유틸리티 원본
│   └── functions/
│       ├── user/             # GET/PUT /users/{userId}, POST upload-url
│       ├── venue/            # POST /venues/nearby, GET /venues/{venueId}
│       ├── checkin/          # POST/DELETE /checkins, GET /checkins/me, /checkins/venue/{id}
│       ├── chupa/            # POST /chupas, GET /chupas/received, /chupas/sent
│       ├── match/            # GET /matches, /matches/{matchId}
│       ├── report/           # POST /reports, POST /users/{userId}/block
│       ├── notification/     # SNS 구독 → 푸시 발송 (FCM/APNs 미구현)
│       └── chat/             # connect.js, disconnect.js, sendMessage.js (WebSocket)
└── sync-shared.js            # shared/utils.js → 각 함수 shared.js 동기화 스크립트
```

> **공유 코드 패턴**: Lambda Layer 없음. `sync-shared.js`로 `shared/utils.js`를 각 함수 폴더의 `shared.js`로 복사. 함수 수정 시 원본(`shared/utils.js`)만 수정하고 sync 실행.

---

## 4. 현재 배포된 dev 리소스

| 리소스 | 값 |
|---|---|
| REST API | `https://05h8pas01e.execute-api.ap-northeast-2.amazonaws.com/dev` |
| WebSocket | `wss://nht8x6i13c.execute-api.ap-northeast-2.amazonaws.com/dev` |
| Cognito User Pool | `ap-northeast-2_KqZPRMTRR` |
| Cognito Client ID | `4nitnpefo0c6im9mpgppf6cf9l` |
| Cognito Domain | `chupa-auth-dev.auth.ap-northeast-2.amazoncognito.com` |
| S3 Bucket | `chupa-images-dev-338976212569` |

---

## 5. 구현 완료 엔드포인트

### REST API (Stack 4)

| Method | Path | Lambda | 상태 |
|---|---|---|---|
| GET | `/users/{userId}` | user | ✅ |
| PUT | `/users/{userId}` | user | ✅ |
| POST | `/users/{userId}/upload-url` | user | ✅ |
| POST | `/users/{userId}/block` | report | ✅ |
| POST | `/venues/nearby` | venue | ✅ 카카오 Map API |
| GET | `/venues/{venueId}` | venue | ✅ |
| POST | `/checkins` | checkin | ✅ 100m 서버 검증 |
| DELETE | `/checkins/{venueId}` | checkin | ✅ |
| GET | `/checkins/me` | checkin | ✅ |
| GET | `/checkins/venue/{venueId}` | checkin | ✅ |
| POST | `/chupas` | chupa | ✅ 양방향 매칭 + 알림 |
| GET | `/chupas/received` | chupa | ✅ |
| GET | `/chupas/sent` | chupa | ✅ |
| GET | `/matches` | match | ✅ |
| GET | `/matches/{matchId}` | match | ✅ |
| POST | `/reports` | report | ✅ 자동 밴 로직 포함 |

### WebSocket (Stack 5)

| Route | Handler | 상태 |
|---|---|---|
| `$connect` | connect.js | ✅ userId 쿼리 파라미터로 식별 |
| `$disconnect` | disconnect.js | ✅ |
| `sendMessage` | sendMessage.js | ✅ 오프라인 시 푸시 트리거 |
| SNS → 푸시 | notification/index.js | ⚠️ 로깅만, FCM/APNs 미구현 |

---

## 6. 미구현 — 추가해야 할 리소스

클라이언트에서 **mock-only**로 동작 중인 항목들. 이것들을 구현해야 실제 서비스 가능.

### 6.1 누락 DynamoDB 테이블

**어디**: `chupa-database/template.yaml`에 추가

| 테이블 | 용도 | PK | 비고 |
|---|---|---|---|
| `chupa-devices-${env}` | 푸시 토큰 등록 | `userId` (HASH) + `token` (RANGE) | TTL: `expiresAt` |

```yaml
# chupa-database/template.yaml 에 추가
DevicesTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: !Sub "chupa-devices-${Environment}"
    BillingMode: PAY_PER_REQUEST
    KeySchema:
      - AttributeName: userId
        KeyType: HASH
      - AttributeName: token
        KeyType: RANGE
    AttributeDefinitions:
      - AttributeName: userId
        AttributeType: S
      - AttributeName: token
        AttributeType: S
    TimeToLiveSpecification:
      AttributeName: expiresAt
      Enabled: true
    GlobalSecondaryIndexes:
      - IndexName: token-index
        KeySchema:
          - AttributeName: token
            KeyType: HASH
        Projection:
          ProjectionType: ALL
```

그리고 Outputs에 Export 추가 (`chupa-${Environment}-DevicesTable`, `chupa-${Environment}-DevicesTableArn`).

### 6.2 누락 REST 엔드포인트 — user lambda 확장

**어디**: `lambda/functions/user/index.js`에 케이스 추가, `chupa-api/template.yaml` UserFunction Events에 추가

| Method | Path | 내용 |
|---|---|---|
| `GET` | `/users/me/stats` | 내 추파 횟수, 매칭 횟수 등 통계 반환 |
| `GET` | `/users/{userId}/blocks` | 내 차단 목록 조회 (`blockedUsers` Set 반환) |
| `DELETE` | `/users/{userId}/block` | 특정 유저 차단 해제 (`blockedUsers`에서 제거) |

> `GET /users/me/stats`는 Chupas, Matches 테이블 조회가 필요하므로 user lambda의 env var에 해당 테이블이 이미 있는지 확인 필요 (현재 없음 → Globals에 추가하거나 별도 처리).

### 6.3 누락 REST 엔드포인트 — 새 device lambda

**어디**: `lambda/functions/device/` 신규 생성, `chupa-api/template.yaml`에 DeviceFunction 추가

| Method | Path | 내용 |
|---|---|---|
| `POST` | `/devices` | Expo 푸시 토큰 등록 (`{ token, platform }` body) |
| `DELETE` | `/devices/{token}` | 푸시 토큰 해제 |

클라이언트가 보내는 형식: `{ token: "ExponentPushToken[xxx]", platform: "ios" | "android" }`.  
저장 시 `userId`는 JWT에서 추출 (`getUserIdFromEvent`).

> Expo 푸시 토큰이면 FCM/APNs 직접 연동 없이 `expo-server-sdk`로 발송 가능. SNS 플랫폼 앱 없이도 동작하므로 단기적으로는 이쪽이 더 빠름.

### 6.4 누락 REST 엔드포인트 — 채팅 히스토리

**어디**: `lambda/functions/match/index.js`에 케이스 추가, `chupa-api/template.yaml` MatchFunction Events에 추가

| Method | Path | 내용 |
|---|---|---|
| `GET` | `/matches/{matchId}/messages` | Messages 테이블 Query, 최신순, 페이지네이션 지원 |

현재 클라이언트는 WebSocket 수신만으로 메시지를 관리하고 과거 메시지를 불러오지 못함.

### 6.5 누락 REST 엔드포인트 — 역지오코딩

**어디**: `chupa-api/template.yaml`에 VenueFunction Events에 추가하거나 별도 lambda

| Method | Path | 내용 |
|---|---|---|
| `GET` | `/geocode/reverse?lat={lat}&lng={lng}` | 카카오 좌표 → 주소 변환 프록시 |

현재 클라이언트에서 직접 카카오 API를 호출하려 하나 API 키 노출 문제로 mock fallback 중. 백엔드 프록시로 처리해야 함.

### 6.6 Cognito PostConfirmation Lambda — 신규 유저 자동 생성

**어디**: `chupa-foundation/template.yaml`에 추가

클라이언트 코드는 사용자가 최초 로그인 시 DynamoDB Users 테이블에 레코드가 자동 생성된다고 가정하고 있음. 현재 이 Lambda가 없으면 카카오 로그인 후 Users 테이블이 비어있어서 `GET /users/{userId}` 404 발생.

추가할 리소스:
- `PostConfirmationFunction` Lambda (Node.js 24.x)
- Cognito UserPool의 `LambdaConfig.PostConfirmation`에 연결
- Lambda → DynamoDB Users 테이블 PutItem 권한

```yaml
# chupa-foundation/template.yaml 에 추가
PostConfirmationFunction:
  Type: AWS::Serverless::Function
  Properties:
    FunctionName: !Sub "chupa-post-confirmation-${Environment}"
    Handler: index.handler
    Runtime: nodejs24.x
    CodeUri: ../../lambda/functions/postConfirmation/
    Environment:
      Variables:
        USERS_TABLE: !ImportValue
          Fn::Sub: "chupa-${Environment}-UsersTable"
    Policies:
      - DynamoDBCrudPolicy:
          TableName: !ImportValue
            Fn::Sub: "chupa-${Environment}-UsersTable"
```

> 주의: foundation 스택이 database 스택보다 먼저 배포되나 database의 Export를 ImportValue해야 함 → **실제로는 database 스택을 먼저 배포한 후 foundation 스택을 재배포해야 하는 순환 문제 발생**. 해결 방법: PostConfirmation Lambda를 별도 Stack 6으로 분리하거나, hardcoded 테이블명 사용(`chupa-users-${env}`).

### 6.7 FCM/APNs 실제 푸시 구현

**어디**: `lambda/functions/notification/index.js`

현재 `sendPush()` 함수가 `console.log`만 실행. 두 가지 구현 옵션:

**옵션 A (권장 — Expo Push Service 경유)**
- `expo-server-sdk` npm 패키지 사용
- 토큰이 `ExponentPushToken[xxx]` 형식이면 Expo 서버가 FCM/APNs 대신 처리
- AWS SNS Platform Application 불필요, 설정 간단
- notification lambda에서 DevicesTable 조회 → Expo Push API 호출

**옵션 B (직접 연동)**
- AWS SNS Platform Application (FCM v1, APNs) 생성
- notification lambda에서 `sns.publish()` → platform endpoint
- SNS 권한 추가 필요

어떤 옵션이든 notification lambda에 **DevicesTable 조회 권한 + 환경변수** 추가 필요.

---

## 7. 빌드 및 배포

```bash
# 공유 코드 동기화 (shared/utils.js → 각 함수 shared.js)
node sync-shared.js

# 각 스택 빌드 + 배포 (순서 준수)
cd chupa-foundation && sam build && sam deploy --config-env dev
cd chupa-database   && sam build && sam deploy --config-env dev
# (chupa-cache는 dev에서 스킵 가능)
cd chupa-api        && sam build && sam deploy --config-env dev --parameter-overrides KakaoMapApiKey=xxx
cd chupa-realtime   && sam build && sam deploy --config-env dev

# 빌드만 (배포 전 확인용)
sam build --template-file template.yaml

# 로컬 테스트
sam local invoke UserFunction --event events/get-user.json
sam local start-api --port 3001
```

### samconfig.toml 파라미터 (dev 기준)

`chupa-api/samconfig.toml`에 `KakaoMapApiKey`는 들어있지 않음 → 배포 시 반드시 `--parameter-overrides`로 전달.  
`chupa-foundation/samconfig.toml`에 `KakaoClientId`, `KakaoClientSecret` 동일.

---

## 8. 핵심 코드 패턴

### 인증 — JWT에서 userId 추출

```js
// shared.js
export function getUserIdFromEvent(event) {
  const claims = event.requestContext?.authorizer?.claims;
  return claims?.sub;
}
```

API Gateway Cognito Authorizer가 `requestContext.authorizer.claims`에 JWT claims 주입. `sub` = Cognito userId = 클라이언트의 `getCurrentUserId()` 반환값과 일치.

### 공통 응답 헬퍼

```js
// shared.js
ok(data)          // 200
created(data)     // 201
badRequest(msg)   // 400
forbidden(msg)    // 403
notFound(msg)     // 404
serverError()     // 500
```

모든 응답에 CORS 헤더 포함 (`Access-Control-Allow-Origin: *`).

### SNS 알림 발행

```js
// shared.js
publishNotification({ type, userId, data })
// → PUSH_TOPIC_ARN SNS → NotificationFunction
```

`type` 값: `chupa_received`, `match_success`, `new_message`, `message_deadline`

### DynamoDB 클라이언트

```js
// shared.js
export const ddb = new DynamoDBDocumentClient(new DynamoDBClient({}));
```

---

## 9. 주요 결정사항

### 9.1 Lambda Layer 미사용
공유 코드(`shared/utils.js`)를 각 함수 폴더에 직접 복사. `sync-shared.js`로 관리.  
Layer 사용 시 cold start 증가 + 배포 복잡도 증가 문제 회피.

### 9.2 arm64 아키텍처
모든 Lambda가 `arm64` (Graviton). x86 대비 약 20% 저렴, 성능 동등.

### 9.3 Cognito User Pool Authorizer (id_token)
클라이언트가 `Authorization: Bearer {id_token}` 전송 → API Gateway Cognito Authorizer 검증 → `requestContext.authorizer.claims.sub`로 userId 추출. access_token이 아닌 id_token 사용.

### 9.4 DynamoDB 테이블 분리 전략
- 영구 데이터 (Users, Chupas, Matches, Messages, Reports): `DeletionPolicy: Retain`
- 일회성 데이터 (CheckIns, VenueCache, Connections): TTL 기반 자동 만료, Retain 없음

### 9.5 카카오 Map API 키
클라이언트 노출 금지 → `chupa-api` 스택의 Lambda 환경변수로만 관리. venue lambda에서 서버사이드 호출.

### 9.6 WebSocket 인증
현재 `$connect` 시 query parameter `?userId={cognitoSub}`로 식별. 토큰 검증 없음 — **보안 취약점**. 추후 Lambda Authorizer 추가 필요 (현재는 dev 단계라 허용).

---

## 10. 구현 완료 (2026-05-27)

| 작업 | 상태 | 비고 |
|---|---|---|
| Cognito PostConfirmation Lambda | ✅ | `lambda/functions/postConfirmation/`, foundation 템플릿 연결 |
| DevicesTable | ✅ | `chupa-database/template.yaml` |
| `POST /devices`, `DELETE /devices` | ✅ | `lambda/functions/device/`, api 템플릿 추가 |
| notification lambda Expo Push | ✅ | `lambda/functions/notification/index.js` — DevicesTable 조회 → Expo Push API |
| `GET /users/me/stats` | ✅ | user lambda |
| `GET /users/{userId}/blocks` | ✅ | user lambda |
| `DELETE /users/{userId}/block` | ✅ | user lambda |
| `GET /matches/{matchId}/messages` | ✅ | match lambda, 페이지네이션(nextToken) 지원 |
| `GET /geocode/reverse` | ✅ | venue lambda, 카카오 coord2address API 프록시 |

## 11. 다음 할 일

| 우선순위 | 작업 | 어디에 |
|---|---|---|
| **1** | `sam deploy` 순서대로 재배포 (database → foundation → api → realtime) | 아래 배포 명령 참고 |
| **2** | WebSocket `$connect` Lambda Authorizer 추가 (보안) | `chupa-realtime/template.yaml` |
| **3** | EAS Build + 앱스토어 메타데이터 (클라이언트 작업) | — |

---

## 11. 알려진 이슈 및 제약

- **Cognito dev CallbackURL**: `template.yaml`에 `exp://localhost:8081/callback`만 등록. Expo Go 실기기에서 테스트하려면 `exp://192.168.x.x:8081/--/callback` 콘솔에서 수동 추가 필요.
- **WS 인증 미구현**: `$connect` 시 userId query param만 확인, JWT 검증 없음.
- **채팅 히스토리 없음**: WebSocket 연결 중 수신한 메시지만 클라이언트에 존재. 앱 재시작 시 과거 메시지 소실.
- **notification 미구현**: SNS 메시지 수신 후 `console.log`만 실행. 실제 푸시 미발송.
- ~~**추파 일일 한도 로직 버그**~~ **(해결됨, [5])**: 구버전 `begins_with(createdAt, :today)` 를 ISO 8601 사전식 범위 비교 `createdAt >= :todayStart`(= `YYYY-MM-DDT00:00:00.000Z`)로 교체. `chupa/index.js` POST `/chupas` 참고. 추후 트래픽 증가 시 날짜 GSI/카운터로 전환 검토.
- **체크인 반경 검증 의존성**: VenueCache에 venue가 없으면 체크인 불가. 반드시 `/venues/nearby` 호출 → 캐시 저장 → 체크인 순서여야 함.
