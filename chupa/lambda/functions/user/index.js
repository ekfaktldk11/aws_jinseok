import { GetCommand, UpdateCommand, QueryCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { ddb, ok, badRequest, forbidden, notFound, serverError, getUserIdFromEvent } from "./shared.js";

const TABLE = process.env.USERS_TABLE;
const CHUPAS_TABLE = process.env.CHUPAS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const CHECKINS_TABLE = process.env.CHECKINS_TABLE;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const BUCKET = process.env.IMAGE_BUCKET;
const CDN_DOMAIN = process.env.CDN_DOMAIN;
const MAX_DAILY_CHUPAS = 5; // 📡 chupa lambda 와 동일 값 유지 (서버 권위 일일 잔여 계산용)
const PHOTO_SLOTS = 3;      // 프로필 사진 슬롯 수 (클라 PHOTO_SLOTS 와 동일)
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg"]); // presign ContentType 화이트리스트 (클라 고정 전송)
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

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

export const handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const currentUserId = getUserIdFromEvent(event);

  try {
    // GET /users/{userId}
    if (method === "GET" && path === "/users/{userId}") {
      const { userId } = event.pathParameters;
      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { userId },
      }));

      if (!result.Item) return notFound("사용자를 찾을 수 없어요");

      if (userId !== currentUserId) {
        delete result.Item.email;
        delete result.Item.blockedUsers;
      }

      return ok(result.Item);
    }

    // PUT /users/{userId}
    if (method === "PUT" && path === "/users/{userId}") {
      const { userId } = event.pathParameters;
      if (userId !== currentUserId) return badRequest("본인 프로필만 수정할 수 있어요");

      const body = JSON.parse(event.body);
      const { name, bio, interests, age, photos } = body;

      if (bio && bio.length > 50) return badRequest("한 줄 소개는 50자까지예요");
      if (interests && interests.length > 5) return badRequest("관심사는 5개까지예요");

      const values = {
        ":name": name,
        ":bio": bio || "",
        ":interests": interests || [],
        ":age": age,
        ":now": new Date().toISOString(),
      };
      let setExpr = "#name = :name, bio = :bio, interests = :interests, age = :age, updatedAt = :now";

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

        setExpr += ", photos = :photos";
        values[":photos"] = nextPhotos;
      }

      const result = await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: `SET ${setExpr}`,
        ExpressionAttributeNames: { "#name": "name" },
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
    if (method === "POST" && path === "/users/{userId}/upload-url") {
      const { userId } = event.pathParameters;
      if (userId !== currentUserId) return badRequest("본인만 업로드할 수 있어요");

      const body = JSON.parse(event.body);
      const { photoIndex, contentType } = body;

      if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= PHOTO_SLOTS)
        return badRequest("photoIndex 가 올바르지 않아요");
      if (!ALLOWED_CONTENT_TYPES.has(contentType))
        return badRequest("이미지는 image/jpeg 만 업로드할 수 있어요");

      // 버전드 키: 업로드마다 uuid 가 바뀌어 같은 슬롯을 교체해도 키가 달라짐 → CDN stale 캐시 0.
      const key = `users/${userId}/photo-${photoIndex}-${randomUUID()}.jpg`;
      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
      const cdnUrl = `https://${CDN_DOMAIN}/${key}`;

      return ok({ uploadUrl, cdnUrl, key });
    }

    // GET /users/me/stats
    // 클라 계약: { sentChupas, matches, checkins }. receivedChupas/remainingChupas 도 함께 내려준다.
    //  - receivedChupas: 🔒 클라가 숨김(사일런트 추파). 집계값만 제공.
    //  - remainingChupas: 서버 권위 일일 잔여(클라 로컬 자정 리셋 스톱갭 대체).
    if (method === "GET" && path === "/users/me/stats") {
      const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
      const [sentResult, sentTodayResult, receivedResult, m1Result, m2Result, meResult] = await Promise.all([
        ddb.send(new QueryCommand({
          TableName: CHUPAS_TABLE,
          KeyConditionExpression: "fromUserId = :uid",
          ExpressionAttributeValues: { ":uid": currentUserId },
          Select: "COUNT",
        })),
        ddb.send(new QueryCommand({
          TableName: CHUPAS_TABLE,
          KeyConditionExpression: "fromUserId = :uid",
          FilterExpression: "createdAt >= :todayStart",
          ExpressionAttributeValues: { ":uid": currentUserId, ":todayStart": todayStart },
          Select: "COUNT",
        })),
        ddb.send(new QueryCommand({
          TableName: CHUPAS_TABLE,
          IndexName: "toUserId-index",
          KeyConditionExpression: "toUserId = :uid",
          ExpressionAttributeValues: { ":uid": currentUserId },
          Select: "COUNT",
        })),
        ddb.send(new QueryCommand({
          TableName: MATCHES_TABLE,
          IndexName: "user1Id-index",
          KeyConditionExpression: "user1Id = :uid",
          ExpressionAttributeValues: { ":uid": currentUserId },
          Select: "COUNT",
        })),
        ddb.send(new QueryCommand({
          TableName: MATCHES_TABLE,
          IndexName: "user2Id-index",
          KeyConditionExpression: "user2Id = :uid",
          ExpressionAttributeValues: { ":uid": currentUserId },
          Select: "COUNT",
        })),
        // 누적 체크인은 Users 레코드의 카운터에서 읽는다(checkin lambda가 ADD 로 증가).
        //   CheckIns 테이블은 2h TTL 이라 과거 이력이 없어 COUNT 로는 누적 불가.
        ddb.send(new GetCommand({ TableName: TABLE, Key: { userId: currentUserId } })),
      ]);

      const sentToday = sentTodayResult.Count || 0;
      return ok({
        sentChupas: sentResult.Count || 0,
        matches: (m1Result.Count || 0) + (m2Result.Count || 0),
        checkins: meResult.Item?.totalCheckins || 0,
        receivedChupas: receivedResult.Count || 0,
        remainingChupas: Math.max(0, MAX_DAILY_CHUPAS - sentToday),
      });
    }

    // GET /users/{userId}/blocks
    // 클라 계약: { blocks: User[] } — 클라에 어댑터가 없으므로 차단된 유저의 전체 프로필을 직렬화한다.
    //   (id 목록만으론 화면 구성 불가) email/blockedUsers 는 타인 정보라 제외.
    if (method === "GET" && path === "/users/{userId}/blocks") {
      const { userId } = event.pathParameters;
      if (userId !== currentUserId) return forbidden("본인 차단 목록만 조회할 수 있어요");

      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { userId },
      }));
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
    if (method === "DELETE" && path === "/users/{userId}") {
      const { userId } = event.pathParameters;
      if (userId !== currentUserId) return forbidden("본인 계정만 삭제할 수 있어요");

      await deleteAccount(userId);
      return ok({ message: "계정이 삭제되었어요" });
    }

    // DELETE /users/{userId}/block
    if (method === "DELETE" && path === "/users/{userId}/block") {
      const { userId: targetUserId } = event.pathParameters;
      if (targetUserId === currentUserId) return badRequest("자신을 차단 해제할 수 없어요");

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId: currentUserId },
        UpdateExpression: "DELETE blockedUsers :target",
        ExpressionAttributeValues: { ":target": new Set([targetUserId]) },
      }));

      return ok({ message: "차단이 해제되었어요" });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("User Lambda Error:", err);
    return serverError();
  }
};
