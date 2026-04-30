import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, ok, badRequest, notFound, serverError, getUserIdFromEvent } from "chupa-shared";

const MATCHES_TABLE = process.env.MATCHES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

export const handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // GET /matches
    if (method === "GET" && path === "/matches") {
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

      matchesWithProfile.sort((a, b) =>
        new Date(b.matchedAt).getTime() - new Date(a.matchedAt).getTime()
      );

      return ok({ matches: matchesWithProfile });
    }

    // GET /matches/{matchId}
    if (method === "GET" && path === "/matches/{matchId}") {
      const { matchId } = event.pathParameters;
      const result = await ddb.send(new GetCommand({
        TableName: MATCHES_TABLE,
        Key: { matchId },
      }));

      if (!result.Item) return notFound("매칭을 찾을 수 없어요");
      if (result.Item.user1Id !== userId && result.Item.user2Id !== userId) {
        return notFound("매칭을 찾을 수 없어요");
      }

      return ok({ match: result.Item });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Match Lambda Error:", err);
    return serverError();
  }
};
