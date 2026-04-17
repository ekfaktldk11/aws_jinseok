const { QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb, ok, badRequest, notFound, serverError, getUserIdFromEvent } = require("../shared/utils");

const MATCHES_TABLE = process.env.MATCHES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // GET /matches — 내 매칭 목록
    if (method === "GET" && path === "/matches") {
      // user1Id, user2Id 양쪽 GSI 모두 조회
      const [result1, result2] = await Promise.all([
        ddb.send(new QueryCommand({
          TableName: MATCHES_TABLE,
          IndexName: "user1Id-index",
          KeyConditionExpression: "user1Id = :uid",
          ExpressionAttributeValues: { ":uid": userId },
        })),
        ddb.send(new QueryCommand({
          TableName: MATCHES_TABLE,
          IndexName: "user2Id-index",
          KeyConditionExpression: "user2Id = :uid",
          ExpressionAttributeValues: { ":uid": userId },
        })),
      ]);

      const allMatches = [...(result1.Items || []), ...(result2.Items || [])];

      // 상대방 프로필 가져오기
      const matchesWithProfile = await Promise.all(
        allMatches.map(async (match) => {
          const partnerId = match.user1Id === userId ? match.user2Id : match.user1Id;
          const userResult = await ddb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { userId: partnerId },
          }));
          const { email, blockedUsers, ...profile } = userResult.Item || {};
          return { ...match, partner: profile };
        })
      );

      // 최신순 정렬
      matchesWithProfile.sort((a, b) =>
        new Date(b.matchedAt).getTime() - new Date(a.matchedAt).getTime()
      );

      return ok({ matches: matchesWithProfile });
    }

    // GET /matches/{matchId} — 매칭 상세
    if (method === "GET" && path === "/matches/{matchId}") {
      const { matchId } = event.pathParameters;
      const result = await ddb.send(new GetCommand({
        TableName: MATCHES_TABLE,
        Key: { matchId },
      }));

      if (!result.Item) return notFound("매칭을 찾을 수 없어요");

      const match = result.Item;
      if (match.user1Id !== userId && match.user2Id !== userId) {
        return notFound("매칭을 찾을 수 없어요");
      }

      return ok({ match });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Match Lambda Error:", err);
    return serverError();
  }
};
