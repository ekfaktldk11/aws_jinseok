import { GetCommand, UpdateCommand, QueryCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { ddb, ok, noContent, badRequest, forbidden, notFound, serverError, getUserIdFromEvent } from "./shared.js";

const TABLE = process.env.USERS_TABLE;
const CHUPAS_TABLE = process.env.CHUPAS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const CHECKINS_TABLE = process.env.CHECKINS_TABLE;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const BUCKET = process.env.IMAGE_BUCKET;
const CDN_DOMAIN = process.env.CDN_DOMAIN;
const MAX_DAILY_CHUPAS = 3; // 📡 chupa lambda 와 동일 값 유지 (서버 권위 일일 잔여 계산용)
const PHOTO_SLOTS = 3;      // 프로필 사진 슬롯 수 (클라 PHOTO_SLOTS 와 동일)
const MIN_AGE = 19;         // 만 19세 (서버 권위 가입/이용 연령 하한)
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg"]); // presign ContentType 화이트리스트 (클라 고정 전송)
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

// ════════════════════════════════════════════
// 헬퍼
// ════════════════════════════════════════════

// 만 나이 계산 — birthdate(ISO 8601 날짜)로부터 오늘 기준 만 나이를 반환.
//   형식이 잘못됐으면 null. (미래 날짜는 음수가 나와 MIN_AGE 미만으로 걸러진다.)
function calcAge(birthdate) {
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const monthDiff = now.getMonth() - b.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

// DynamoDB BatchWrite 는 한 번에 25개까지 → 청크 단위로 삭제.
async function batchDelete(tableName, keys) {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    if (!chunk.length) continue;
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [tableName]: chunk.map((Key) => ({ DeleteRequest: { Key } })) },
    }));
  }
}

// 계정 영구 삭제: Cognito 유저 + 추파(보낸/받은) + 매칭/메시지 + 체크인 + 디바이스 + 유저 레코드.
// Cognito 삭제가 실패해도 데이터 정리는 계속 진행한다(고아 데이터 방지).
async function deleteAccount(userId) {
  try {
    if (USER_POOL_ID) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: userId }));
    }
  } catch (err) {
    console.error("Cognito AdminDeleteUser failed:", err);
  }

  // 보낸 추파 (PK = fromUserId)
  const sent = await ddb.send(new QueryCommand({
    TableName: CHUPAS_TABLE,
    KeyConditionExpression: "fromUserId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
  }));
  await batchDelete(CHUPAS_TABLE, (sent.Items || []).map((c) => ({ fromUserId: c.fromUserId, toUserId: c.toUserId })));

  // 받은 추파 (toUserId-index)
  const received = await ddb.send(new QueryCommand({
    TableName: CHUPAS_TABLE,
    IndexName: "toUserId-index",
    KeyConditionExpression: "toUserId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
  }));
  await batchDelete(CHUPAS_TABLE, (received.Items || []).map((c) => ({ fromUserId: c.fromUserId, toUserId: c.toUserId })));

  // 매칭 (user1Id-index + user2Id-index) + 각 매칭의 메시지
  const [m1, m2] = await Promise.all([
    ddb.send(new QueryCommand({ TableName: MATCHES_TABLE, IndexName: "user1Id-index", KeyConditionExpression: "user1Id = :uid", ExpressionAttributeValues: { ":uid": userId } })),
    ddb.send(new QueryCommand({ TableName: MATCHES_TABLE, IndexName: "user2Id-index", KeyConditionExpression: "user2Id = :uid", ExpressionAttributeValues: { ":uid": userId } })),
  ]);
  const matches = [...(m1.Items || []), ...(m2.Items || [])];
  for (const match of matches) {
    const msgs = await ddb.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "matchId = :mid",
      ExpressionAttributeValues: { ":mid": match.matchId },
    }));
    await batchDelete(MESSAGES_TABLE, (msgs.Items || []).map((msg) => ({ matchId: msg.matchId, timestamp: msg.timestamp })));
  }
  await batchDelete(MATCHES_TABLE, matches.map((m) => ({ matchId: m.matchId })));

  // 체크인 (userId-index)
  const checkins = await ddb.send(new QueryCommand({
    TableName: CHECKINS_TABLE,
    IndexName: "userId-index",
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
  }));
  await batchDelete(CHECKINS_TABLE, (checkins.Items || []).map((c) => ({ venueId: c.venueId, userId: c.userId })));

  // 디바이스 (PK = userId)
  const devices = await ddb.send(new QueryCommand({
    TableName: DEVICES_TABLE,
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
  }));
  await batchDelete(DEVICES_TABLE, (devices.Items || []).map((d) => ({ userId: d.userId, token: d.token })));

  // 유저 레코드
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { userId } }));
}

// ════════════════════════════════════════════
// 라우트 핸들러 — 각 (event, currentUserId) => 응답
// ════════════════════════════════════════════

// GET /users/{userId}
async function getUser(event, currentUserId) {
  const { userId } = event.pathParameters;
  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }));
  if (!result.Item) return notFound("사용자를 찾을 수 없어요");

  // 타인 프로필이면 민감 정보 제거.
  if (userId !== currentUserId) {
    delete result.Item.email;
    delete result.Item.blockedUsers;
  }
  return ok(result.Item);
}

// PUT /users/{userId}
async function updateUser(event, currentUserId) {
  const { userId } = event.pathParameters;
  if (userId !== currentUserId) return badRequest("본인 프로필만 수정할 수 있어요");

  const { name, bio, interests, age, birthdate, photos } = JSON.parse(event.body);

  if (bio && bio.length > 50) return badRequest("한 줄 소개는 50자까지예요");
  if (interests && interests.length > 5) return badRequest("관심사는 5개까지예요");

  // 보낸 필드만 부분 갱신한다(모든 필드 동일 규칙).
  //   미전송 필드를 값에 undefined 로 넣으면 마샬링 단계에서 빠져, 표현식엔 ":x" 가 남지만
  //   값이 없어 ValidationException 이 난다 → 정의된 필드만 SET 절+값에 함께 추가.
  const sets = ["updatedAt = :now"];
  const values = { ":now": new Date().toISOString() };
  const names = {};

  if (name !== undefined) {
    sets.push("#name = :name"); // name 은 DynamoDB 예약어 → #name 별칭 필수
    names["#name"] = "name";
    values[":name"] = name;
  }
  if (bio !== undefined) {
    sets.push("bio = :bio");
    values[":bio"] = bio || "";
  }
  if (interests !== undefined) {
    sets.push("interests = :interests");
    values[":interests"] = interests || [];
  }
  // 나이 권위: birthdate(ISO 8601 날짜)를 저장하고 만 나이를 서버에서 계산한다.
  //   🛡️ 클라가 보낸 age 는 신뢰하지 않는다 — birthdate 가 있으면 항상 파생값으로 덮어쓴다.
  if (birthdate !== undefined) {
    const derivedAge = calcAge(birthdate);
    if (derivedAge === null) return badRequest("생년월일 형식이 올바르지 않아요");
    if (derivedAge < MIN_AGE) return badRequest(`만 ${MIN_AGE}세 이상만 이용할 수 있어요`);
    sets.push("birthdate = :birthdate", "age = :age");
    values[":birthdate"] = birthdate;
    values[":age"] = derivedAge;
  } else if (age !== undefined) {
    // 하위호환: birthdate 없이 age 만 보내는 구버전 클라 — 그대로 저장.
    sets.push("age = :age");
    values[":age"] = age;
  }

  // 프로필 사진: 클라가 보낸 "현재 전체 목록"으로 전체 치환(패치 아님).
  //   🛡️ 우리 CDN + 본인 경로(/users/{userId}/) 하위 URL만 허용 — 임의 URL/타인 경로 주입 차단.
  let removedPhotos = [];
  if (Array.isArray(photos)) {
    const prefix = `https://${CDN_DOMAIN}/users/${userId}/`;
    const nextPhotos = photos
      .filter((u) => typeof u === "string" && u.startsWith(prefix))
      .slice(0, PHOTO_SLOTS);

    // 교체로 더 이상 참조되지 않는 옛 객체 정리용 — 기존 photos 미리 읽기.
    const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }));
    const oldPhotos = cur.Item?.photos || [];
    const keep = new Set(nextPhotos);
    removedPhotos = oldPhotos.filter((u) => !keep.has(u));

    sets.push("photos = :photos");
    values[":photos"] = nextPhotos;
  }

  const result = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { userId },
    UpdateExpression: `SET ${sets.join(", ")}`,
    // #name 별칭은 name 을 보낸 경우에만 존재 — 비었으면 키 자체 생략(빈/미사용 맵은 거부됨).
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  }));

  // 더 이상 참조 안 되는 옛 S3 객체 삭제(best-effort) — 실패해도 응답엔 영향 없음.
  if (removedPhotos.length) {
    await Promise.allSettled(removedPhotos.map((url) =>
      s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: url.replace(`https://${CDN_DOMAIN}/`, "") }))
    ));
  }

  return ok(result.Attributes);
}

// POST /users/{userId}/upload-url
async function createUploadUrl(event, currentUserId) {
  const { userId } = event.pathParameters;
  if (userId !== currentUserId) return badRequest("본인만 업로드할 수 있어요");

  const { photoIndex, contentType } = JSON.parse(event.body);

  if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= PHOTO_SLOTS)
    return badRequest("photoIndex 가 올바르지 않아요");
  if (!ALLOWED_CONTENT_TYPES.has(contentType))
    return badRequest("이미지는 image/jpeg 만 업로드할 수 있어요");

  // 버전드 키: 업로드마다 uuid 가 바뀌어 같은 슬롯을 교체해도 키가 달라짐 → CDN stale 캐시 0.
  const key = `users/${userId}/photo-${photoIndex}-${randomUUID()}.jpg`;
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  }), { expiresIn: 300 });

  return ok({ uploadUrl, cdnUrl: `https://${CDN_DOMAIN}/${key}`, key });
}

// GET /users/me/stats
// 클라 계약: { sentChupas, matches, checkins }. receivedChupas/remainingChupas 도 함께 내려준다.
//  - receivedChupas: 🔒 클라가 숨김(사일런트 추파). 집계값만 제공.
//  - remainingChupas: 서버 권위 일일 잔여(클라 로컬 자정 리셋 스톱갭 대체).
//  - checkins: 누적 체크인은 Users 레코드 카운터에서 읽음(CheckIns 는 2h TTL 이라 COUNT 불가).
async function getStats(_event, currentUserId) {
  const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const countQuery = (params) => ddb.send(new QueryCommand({ ...params, Select: "COUNT" }));

  const [sent, sentToday, received, m1, m2, me] = await Promise.all([
    countQuery({ TableName: CHUPAS_TABLE, KeyConditionExpression: "fromUserId = :uid", ExpressionAttributeValues: { ":uid": currentUserId } }),
    countQuery({ TableName: CHUPAS_TABLE, KeyConditionExpression: "fromUserId = :uid", FilterExpression: "createdAt >= :todayStart", ExpressionAttributeValues: { ":uid": currentUserId, ":todayStart": todayStart } }),
    countQuery({ TableName: CHUPAS_TABLE, IndexName: "toUserId-index", KeyConditionExpression: "toUserId = :uid", ExpressionAttributeValues: { ":uid": currentUserId } }),
    countQuery({ TableName: MATCHES_TABLE, IndexName: "user1Id-index", KeyConditionExpression: "user1Id = :uid", ExpressionAttributeValues: { ":uid": currentUserId } }),
    countQuery({ TableName: MATCHES_TABLE, IndexName: "user2Id-index", KeyConditionExpression: "user2Id = :uid", ExpressionAttributeValues: { ":uid": currentUserId } }),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { userId: currentUserId } })),
  ]);

  return ok({
    sentChupas: sent.Count || 0,
    matches: (m1.Count || 0) + (m2.Count || 0),
    checkins: me.Item?.totalCheckins || 0,
    receivedChupas: received.Count || 0,
    remainingChupas: Math.max(0, MAX_DAILY_CHUPAS - (sentToday.Count || 0)),
  });
}

// GET /users/{userId}/blocks
// 클라 계약: { blocks: User[] } — id 목록만으론 화면 구성 불가라 차단 유저 전체 프로필을 직렬화.
//   email/blockedUsers 는 타인 정보라 제외.
async function getBlocks(event, currentUserId) {
  const { userId } = event.pathParameters;
  if (userId !== currentUserId) return forbidden("본인 차단 목록만 조회할 수 있어요");

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }));
  if (!result.Item) return notFound("사용자를 찾을 수 없어요");

  const blockedIds = [...(result.Item.blockedUsers || [])];
  const blocks = (await Promise.all(blockedIds.map(async (id) => {
    const u = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId: id } }));
    if (!u.Item) return null;
    const { email, blockedUsers, ...profile } = u.Item;
    return profile;
  }))).filter(Boolean);

  return ok({ blocks, count: blocks.length });
}

// DELETE /users/{userId} — 계정 영구 삭제 (본인만)
async function deleteUser(event, currentUserId) {
  const { userId } = event.pathParameters;
  if (userId !== currentUserId) return forbidden("본인 계정만 삭제할 수 있어요");

  await deleteAccount(userId);
  return noContent();
}

// DELETE /users/{userId}/block — 차단 해제
async function unblockUser(event, currentUserId) {
  const { userId: targetUserId } = event.pathParameters;
  if (targetUserId === currentUserId) return badRequest("자신을 차단 해제할 수 없어요");

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { userId: currentUserId },
    UpdateExpression: "DELETE blockedUsers :target",
    ExpressionAttributeValues: { ":target": new Set([targetUserId]) },
  }));

  return noContent();
}

// ════════════════════════════════════════════
// 라우터 — "METHOD resource" → 핸들러
// ════════════════════════════════════════════
const routes = {
  "GET /users/{userId}": getUser,
  "PUT /users/{userId}": updateUser,
  "POST /users/{userId}/upload-url": createUploadUrl,
  "GET /users/me/stats": getStats,
  "GET /users/{userId}/blocks": getBlocks,
  "DELETE /users/{userId}": deleteUser,
  "DELETE /users/{userId}/block": unblockUser,
};

export const handler = async (event) => {
  const route = routes[`${event.httpMethod} ${event.resource}`];
  if (!route) return badRequest("지원하지 않는 요청이에요");

  try {
    return await route(event, getUserIdFromEvent(event));
  } catch (err) {
    console.error("User Lambda Error:", err);
    return serverError();
  }
};
