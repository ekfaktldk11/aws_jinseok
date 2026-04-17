const { GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { ddb, ok, badRequest, notFound, serverError, getUserIdFromEvent } = require("../shared/utils");

const TABLE = process.env.USERS_TABLE;
const BUCKET = process.env.IMAGE_BUCKET;
const s3 = new S3Client({});

exports.handler = async (event) => {
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

      // 다른 사용자 프로필 조회 시 민감 정보 제거
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
      const cdnUrl = `https://${process.env.CDN_DOMAIN}/${key}`;

      return ok({ uploadUrl, cdnUrl, key });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("User Lambda Error:", err);
    return serverError();
  }
};
