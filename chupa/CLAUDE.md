# Chupa AWS Backend — CLAUDE.md

> 추파(Chupa) AWS 백엔드 컨텍스트. 새 세션에서 이 문서만 읽어도 현재 상태와 다음 작업을 파악할 수 있도록 작성.

---

## 1. 프로젝트 개요

**추파(Chupa)** 백엔드 인프라. AWS SAM(CloudFormation) 기반 멀티 스택 구조.

**핵심 컨셉 — 거절의 비가시성 / 사일런트 추파(단방향)**
- 추파의 유일한 정체성: "내가 어필해도 상대가 부담을 느낄 일이 없다."
- 받는 사람은 자신이 추파를 받았다는 사실을 **일절 알 수 없다**(갈림길 A).
- 매칭은 **양쪽이 독립적으로 서로에게 추파를 보냈을 때만** 성립(양방향 매칭, 유효시간 내).
- MVP는 1단계(사일런트 추파)까지만. 2단계/수신 동의(signalConsent)는 데이터 구조에 자리만 확보.

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
| PUT | `/users/{userId}` | user | ✅ `photos`(CDN URL 배열, 전체 치환) 저장 + 교체된 옛 S3 객체 정리. `birthdate`(ISO) 수신 시 나이 권위로 저장 + 만 나이 `age` 서버 계산(만 19세 미만 거부, 클라 age 불신) |
| POST | `/users/{userId}/upload-url` | user | ✅ 버전드 키(`photo-{i}-{uuid}.jpg`) presigned PUT. photoIndex(0~2)/contentType(image/jpeg) 검증 |
| POST | `/users/{userId}/block` | report | ✅ |
| POST | `/venues/nearby` | venue | ✅ 카카오 Map API |
| GET | `/venues/{venueId}` | venue | ✅ |
| POST | `/checkins` | checkin | ✅ 100m 서버 검증 |
| DELETE | `/checkins/{venueId}` | checkin | ✅ |
| GET | `/checkins/me` | checkin | ✅ |
| GET | `/checkins/venue/{venueId}` | checkin | ✅ |
| POST | `/chupas` | chupa | ✅ 양방향 매칭(유효시간 필터), level/expiresAt 저장. 미성사 시 수신자 알림 없음 |
| GET | `/chupas/received` | chupa | 🔒 MVP 항상 빈 배열(거절의 비가시성). 2단계 게이팅 자리만 |
| GET | `/chupas/sent` | chupa | ✅ |
| DELETE | `/users/{userId}` | user | ✅ 계정 영구 삭제(Cognito+추파/매칭/메시지/체크인/디바이스), 본인만 |
| GET | `/matches` | match | ✅ |
| GET | `/matches/{matchId}` | match | ✅ |
| POST | `/reports` | report | ✅ 자동 밴 로직 포함 |
| GET | `/reports/me` | report | ✅ 내가 접수한 신고 목록(reporterUserId-index) |

### WebSocket (Stack 5)

| Route | Handler | 상태 |
|---|---|---|
| `$connect` | connect.js | ✅ userId 쿼리 파라미터로 식별 |
| `$disconnect` | disconnect.js | ✅ |
| `sendMessage` | sendMessage.js | ✅ 참가자/차단/길이(≤1000)·sanitize/첫메시지 24h 검증 + 양쪽 참가자 fan-out(발신자 멀티디바이스 포함), 오프라인 시 푸시 |
| SNS → 푸시 | notification/index.js | ✅ Expo Push 발송 (DevicesTable 조회) |

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

`type` 값: `match_success`, `new_message`, `message_deadline`
> 🔒 `chupa_received` 는 notification enum에 잔존하나 **발송 경로에서 제거**(거절의 비가시성). chupa lambda는 호출하지 않고, notification lambda의 case 도 주석 처리.

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
`$connect` 에 **Lambda Authorizer**(`chat/authorizer.js`) 적용 — 클라가 `wss://.../{stage}?token={id_token}` 로 연결하면 Cognito id_token 을 검증(JWKS 서명·exp·iss·`token_use=id`·aud=clientId)하고, 통과 시 `context.userId`(=sub)를 `$connect` 로 전달. `connect.js` 는 **이 검증된 sub 만 신뢰**(쿼리스트링 `?userId=` 신뢰 제거). 토큰 없으면 API GW 가 401, 무효하면 authorizer 가 Deny→403.
> ⚠️ **클라 브레이킹**: 연결 쿼리가 `?userId=` → **`?token={id_token}`** 로 바뀜. 클라 업데이트와 함께 배포해야 함.

### 9.7 거절의 비가시성 (갈림길 A) — 미성사 추파 비노출 [1][2]
받는 사람은 추파 수신을 알 수 없어야 한다. 따라서:
- chupa lambda는 미성사(단방향) 추파에서 `chupa_received` 알림을 **발송하지 않음**. `match_success`만 발송.
- `GET /chupas/received` 는 MVP에서 **항상 빈 배열** 반환(`toUserId-index` 조회 로직은 주석 보존).
- notification lambda의 `chupa_received` case 도 주석 처리.
- 2단계 확장 자리: `signalConsent=true AND level>=2` 인 추파에 한해서만 수신자에게 노출/알림 허용(게이팅 자리 주석).

### 9.8 추파 단계/수신 동의/유효시간 — 구조만 확보 [3][4][6]
- 추파 레코드에 `level`(Number, MVP 항상 1), `expiresAt`(Number, epoch sec) 추가. ChupasTable은 스키마리스라 템플릿 변경 없음.
- `expiresAt` 에 **TTL 미설정** — 만료=삭제는 '보낸 기록 보존'과 상충. 유효성은 매칭 판정 시 `expiresAt > now` 필터로만 처리.
- **매칭 시간창**: POST 시 `expiresAt = now + CHUPA_VALID_SECONDS`(현재 7일, 클라 config와 동일 유지). 역방향 추파가 만료 전일 때만 매칭 인정 → "동시 쌍방 일치"의 가혹함 완화.
- Users 레코드에 `signalConsent`(boolean, 기본 false) 자리만 추가(2단계 게이팅용, MVP 미사용).

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

## 10.1 구현 완료 (2026-05-30) — 클라 계약 잔여 항목

| 작업 | 상태 | 비고 |
|---|---|---|
| `DELETE /users/{userId}` 계정 삭제 | ✅ | user lambda `deleteAccount()` — Cognito AdminDeleteUser + 추파(보낸/받은)/매칭+메시지/체크인/디바이스/유저 레코드 BatchWrite 삭제. 본인만. api 템플릿에 `USER_POOL_ID` env + `cognito-idp:AdminDeleteUser` 권한 + DELETE 이벤트 추가 |
| `GET /reports/me` | ✅ | report lambda. ReportsTable에 `reporterUserId-index`(HASH reporterUserId + RANGE createdAt) GSI 신설. 응답 Report shape({id, reportedName, reason, detail?, status, createdAt}), reportedName 은 Users 조회 |
| `GET /users/me/stats` 계약 정렬 | ✅ | `{ sentChupas, matches, checkins, receivedChupas, remainingChupas }` 로 교체(기존 `totalMatches`→`matches`, `checkins`/`remainingChupas` 신설). remainingChupas=서버 권위 일일 잔여(5-오늘발송) |
| 누적 체크인 카운터 | ✅ | checkin lambda `POST /checkins` 성공 시 Users 레코드에 `ADD totalCheckins :1`(원자적). stats의 `checkins`는 이 값을 읽음. CheckIns는 2h TTL이라 COUNT로는 누적 불가 → **배포 시점부터 0에서 누적**(과거 백필 불가) |
| `GET /users/{userId}/blocks` 계약 정렬 | ✅ | id 목록 대신 차단 유저 전체 프로필 배열 `{ blocks: User[], count }` 반환(email/blockedUsers 제외) |
| WS `sendMessage` 서버 권위 강화 | ✅ | ① 참가자 ② 차단(양방향) ③ sanitize+길이≤1000 ④ 첫메시지 24h 마감 검증, 양쪽 참가자 fan-out(발신자 멀티디바이스, 본인 connection 제외), 에러는 `{action:'error',code,message}` push |

## 10.2 구현 완료 (2026-06-09) — 프로필 사진 presigned 업로드 + DB 영속화

클라 핸드오프 반영. **코드 변경은 `user/index.js` 한 파일**, 템플릿(env/IAM)은 기존 그대로 충족(IMAGE_BUCKET·CDN_DOMAIN env + s3 Put/Get/Delete 권한 모두 기존재).

| 작업 | 상태 | 비고 |
|---|---|---|
| `POST /users/{userId}/upload-url` 버전드 키 | ✅ | 키를 `users/{userId}/photo-{photoIndex}-{uuid}.jpg` 로 변경(업로드마다 고유 → 같은 슬롯 교체 시에도 키가 달라져 **CDN stale 캐시 0**). photoIndex(0≤i<3 정수)·contentType(`image/jpeg` 화이트리스트) 검증 추가. `randomUUID` from `node:crypto` |
| `PUT /users/{userId}` photos 저장 | ✅ | body `photos`(CDN URL 배열) 수신 시 **전체 치환**(패치 아님). 🛡️ `https://{CDN_DOMAIN}/users/{userId}/` 접두사 하위 URL만 허용(임의 URL/타인 경로 주입 차단), 최대 3장. 갱신 전 기존 photos 읽어 **더 이상 참조 안 되는 옛 S3 객체 `DeleteObject`(best-effort)** |
| `GET /users/{userId}` / 라운지 사진 노출 | ✅ | 별도 코드 없음 — `GET /users/{userId}`는 `result.Item` 그대로, checkin `GET /checkins/venue/{venueId}`는 `{email, blockedUsers, ...profile}` 펼침이라 **`photos` 자동 포함** |

> **흐름**: ① `POST upload-url`→presigned PUT URL 발급 ② 앱이 S3에 직접 PUT ③ 성공한 `cdnUrl`만 `PUT /users` `photos`에 담아 전송 → "DB엔 URL, S3엔 파일 없음" 불일치 없음.
> **미반영(권장·선택)**: CloudFront Response Headers Policy(`Cache-Control: ...immutable`). 키가 버전드라 stale 문제는 키 차원에서 이미 해소돼 동작엔 불필요. 캐시 적중률 최적화가 필요하면 foundation 스택 `CloudFrontDistribution`에 추가. 고아 객체(presign 후 PUT /users 전 앱 종료) 정리도 MVP는 방치(비용 미미), 필요 시 S3 Lifecycle.

## 10.3 구현 완료 (2026-06-17) — 출시 전 검토 우선순위표 반영

클라 출시 전 검토(우선순위표)의 백엔드 몫을 반영. 대부분(§4·§7-1~7-6·§7-7.2~3)은 이미 구현돼 **검증만** 했고, 실제 변경은 아래 5건.

| 작업 | 상태 | 비고 |
|---|---|---|
| **§3 Apple 로그인 IdP** | ✅ 배포 완료 (2026-06-20, IdP `SignInWithApple` live) | `chupa-foundation/template.yaml` — `AppleIdentityProvider`(ProviderType/Name `SignInWithApple`) 추가. 크레덴셜 4종(`AppleServicesId`/`AppleTeamId`/`AppleKeyId`/`ApplePrivateKey`) Parameter(기본 `""`) + `HasAppleConfig` 조건 → **값 없으면 미생성**(dev 배포 안 깨짐). App Client `SupportedIdentityProviders` 에 `!If [HasAppleConfig, ...]` 로 포함, `CallbackURLs` 에 `chupa://callback` 고정. Apple Developer Service ID/Key 발급은 콘솔 수동(아래 절차) → 값 받으면 `--parameter-overrides` 주입 |
| **§4 device 계약 정렬** | ✅ | `device/index.js` — `platform` 화이트리스트에 `web` 추가, `POST/DELETE /devices` 응답을 `204`(본문 없음)로 변경 |
| **§7-7.1 birthdate→age** | ✅ | `user/index.js` `updateUser` — `birthdate`(ISO) 저장 + 만 나이 `age` 서버 계산(`calcAge`), 만 19세 미만 거부, 클라 `age` 불신(birthdate 있으면 파생값으로 덮어씀). birthdate 없이 age 만 보내는 구버전은 하위호환 |
| **§7-2 messages 계약 정렬** | ✅ | `match/index.js` — 비참가자 응답 `404`→**`403`**, 메시지 **시간 오름차순**(최신순 페이지를 페이지 내부에서 `reverse`). 포맷은 WS `newMessage.message` 와 동일 |
| **§7-3/§7-5 DELETE 응답 정렬** | ✅ | `user/index.js` — `DELETE /users/{userId}`, `DELETE /users/{userId}/block` 응답을 `204`(본문 없음)로 변경 |
| (공통) `noContent()` 헬퍼 | ✅ | `lambda/shared/utils.js` 에 204 헬퍼 추가 후 `node sync-shared.js` 동기화 |

> **Apple Developer 콘솔 수동 절차(값 발급 → CFN 주입)**
> 1. Apple Developer → **Certificates, IDs & Profiles**.
> 2. **Identifiers → App ID** 생성/선택 후 *Sign In with Apple* capability 활성화.
> 3. **Identifiers → Services ID** 생성(예: `kr.chupa.signin`). 이 값이 `AppleServicesId`(= Cognito `client_id`).
>    - *Sign In with Apple* 설정에서 **Domains**: `chupa-auth-dev.auth.ap-northeast-2.amazoncognito.com`,
>      **Return URLs**: `https://chupa-auth-dev.auth.ap-northeast-2.amazoncognito.com/oauth2/idpresponse` 등록.
> 4. **Keys** → 새 Key 생성, *Sign In with Apple* 체크 → `.p8` 다운로드. Key 의 **Key ID** = `AppleKeyId`, `.p8` 본문 = `ApplePrivateKey`.
> 5. 우상단 멤버십의 **Team ID**(10자) = `AppleTeamId`.
> 6. 배포: `cd chupa-foundation && sam build && sam deploy --config-env dev --parameter-overrides KakaoClientId=... KakaoClientSecret=... AppleServicesId=kr.chupa.signin AppleTeamId=XXXXXXXXXX AppleKeyId=YYYYYYYYYY ApplePrivateKey="$(cat AuthKey_YYYYYYYYYY.p8)"`
> 7. (참고) Kakao Custom OIDC IdP(`Kakao`)는 이미 등록돼 있음 — 별도 작업 불필요.

### 10.3.1 클라 계약 영향 (핸드오프 — 클라가 맞춰야 하는 변경)

- **204 No Content(본문 없음)** — `POST /devices`, `DELETE /devices`, `DELETE /users/{userId}`, `DELETE /users/{userId}/block`. 클라는 응답 body 파싱 금지, 2xx/204 로 성공 판정(이전 `200/201` + `{message}` 폐기).
- **`PUT /users/{userId}`** — `age` 직접 전송 금지, **`birthdate`(ISO, 예 `2000-05-15`)** 전송 → 서버가 만 나이 `age` 계산해 응답. 만 19세 미만/형식오류 `400`. (`photos` 전체 치환·`bio`≤50·`interests`≤5 는 기존 그대로)
- **`GET /matches/{matchId}/messages`** — **시간 오름차순**, 비참가자 **403**(매칭 없음 404), `?nextToken=&limit=`(기본 50/최대 100). 메시지 포맷은 WS `newMessage.message` 와 동일(`{matchId,timestamp,senderId,content,type}`).
- **`POST /devices`** — `platform` 에 `web` 허용(`ios|android|web`). 해제는 `DELETE /devices` **body** `{token}`.
- **WebSocket 연결** ⚠️ 브레이킹 — 연결 URL 이 `wss://.../{stage}?userId={sub}` → **`wss://.../{stage}?token={id_token}`** 로 변경. userId 는 서버가 토큰에서 도출(쿼리 userId 무시). 토큰 없음/무효 시 핸드셰이크 거부(401/403). (백엔드 realtime 재배포와 **동시 전환** 필요)
- **Apple 로그인** — provider 이름 정확히 **`SignInWithApple`**, callback `chupa://callback`, scope `openid email profile`. Hosted UI authorize:
  `…/oauth2/authorize?identity_provider=SignInWithApple&redirect_uri=chupa://callback&response_type=code&client_id={clientId}&scope=openid+email+profile`
  (Apple 은 name 을 최초 1회만 제공 → 최초 로그인 직후 `PUT /users` 로 저장 권장. Kakao 는 provider 이름 `Kakao` 그대로.)

## 11. 다음 할 일

| 우선순위 | 작업 | 어디에 |
|---|---|---|
| ~~1~~ | ~~전체 재배포(DB→foundation→api→realtime) + Apple IdP~~ **(완료 2026-06-20, 전 스택 배포 + Apple `SignInWithApple` live)** | — |
| ~~2~~ | ~~WebSocket `$connect` Lambda Authorizer~~ **(코드 완료 2026-06-20 — `chat/authorizer.js`)**. ⚠️ **클라 브레이킹**: 클라가 `?token={id_token}` 적용한 뒤 realtime 재배포(미적용 시 WS 전면 401) | `chupa-realtime` |
| **1** | realtime 재배포 — **클라 `?token=` 전환과 동시에** | `cd chupa-realtime && sam build && sam deploy --config-env dev` |
| **2** | E2E 검증 — Apple 로그인 왕복 + 바뀐 엔드포인트 스모크(204/birthdate·age/messages 403·오름차순) + WS `?token=` 연결 | 클라 앱 / 실제 id_token |
| **3** | EAS Build + 앱스토어 메타데이터 (클라이언트 작업) | — |
| **4** | prod 환경 구성 (🔴1) — prod Cognito/스택 + Apple **prod용 Services ID** 세트 | prod 스택 |

---

## 11. 알려진 이슈 및 제약

- **Cognito dev CallbackURL**: `template.yaml`에 `exp://localhost:8081/callback`만 등록. Expo Go 실기기에서 테스트하려면 `exp://192.168.x.x:8081/--/callback` 콘솔에서 수동 추가 필요.
- ~~**WS 인증 미구현**~~ **(해결됨, 코드)**: `$connect` Lambda Authorizer 가 id_token 검증(`chat/authorizer.js`). 연결 쿼리 `?token={id_token}`. **클라 브레이킹** — 클라 `?token=` 적용 후 realtime 재배포 필요.
- ~~**채팅 히스토리 없음**~~ **(해결됨)**: `GET /matches/{matchId}/messages` 로 과거 메시지 조회 가능(페이지네이션).
- ~~**notification 미구현**~~ **(해결됨)**: notification lambda가 DevicesTable 조회 후 Expo Push API 로 실제 발송.
- ~~**추파 일일 한도 로직 버그**~~ **(해결됨, [5])**: 구버전 `begins_with(createdAt, :today)` 를 ISO 8601 사전식 범위 비교 `createdAt >= :todayStart`(= `YYYY-MM-DDT00:00:00.000Z`)로 교체. `chupa/index.js` POST `/chupas` 참고. 추후 트래픽 증가 시 날짜 GSI/카운터로 전환 검토.
- **체크인 반경 검증 의존성**: VenueCache에 venue가 없으면 체크인 불가. 반드시 `/venues/nearby` 호출 → 캐시 저장 → 체크인 순서여야 함.
