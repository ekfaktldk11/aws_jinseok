import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ddb, ok, badRequest, forbidden, notFound, serverError, getUserIdFromEvent } from "./shared.js";

const TABLE = process.env.USERS_TABLE;
const CHUPAS_TABLE = process.env.CHUPAS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const BUCKET = process.env.IMAGE_BUCKET;
const CDN_DOMAIN = process.env.CDN_DOMAIN;
const s3 = new S3Client({});

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
      const { name, bio, interests, age } = body;

      if (bio && bio.length > 50) return badRequest("한 줄 소개는 50자까지예요");
      if (interests && interests.length > 5) return badRequest("관심사는 5개까지예요");

      const result = await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: "SET #name = :name, bio = :bio, interests = :interests, age = :age, updatedAt = :now",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: {
          ":name": name,
          ":bio": bio || "",
          ":interests": interests || [],
          ":age": age,
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }));

      return ok(result.Attributes);
    }

    // POST /users/{userId}/upload-url
    if (method === "POST" && path === "/users/{userId}/upload-url") {
      const { userId } = event.pathParameters;
      if (userId !== currentUserId) return badRequest("본인만 업로드할 수 있어요");

      const body = JSON.parse(event.body);
      const { photoIndex, contentType } = body;

      const key = `users/${userId}/photo-${photoIndex}.jpg`;
      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType || "image/jpeg",
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
      const cdnUrl = `https://${CDN_DOMAIN}/${key}`;

      return ok({ uploadUrl, cdnUrl, key });
    }

    // GET /users/me/stats
    if (method === "GET" && path === "/users/me/stats") {
      const [sentResult, receivedResult, m1Result, m2Result] = await Promise.all([
        ddb.send(new QueryCommand({
          TableName: CHUPAS_TABLE,
          KeyConditionExpression: "fromUserId = :uid",
          ExpressionAttributeValues: { ":uid": currentUserId },
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
      ]);

      return ok({
        sentChupas: sentResult.Count || 0,
        receivedChupas: receivedResult.Count || 0,
        totalMatches: (m1Result.Count || 0) + (m2Result.Count || 0),
      });
    }

    // GET /users/{userId}/blocks
    if (method === "GET" && path === "/users/{userId}/blocks") {
      const { userId } = event.pathParameters;
      if (userId !== currentUserId) return forbidden("본인 차단 목록만 조회할 수 있어요");

      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { userId },
      }));
      if (!result.Item) return notFound("사용자를 찾을 수 없어요");

      const blockedUsers = [...(result.Item.blockedUsers || [])];
      return ok({ blockedUsers, count: blockedUsers.length });
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
