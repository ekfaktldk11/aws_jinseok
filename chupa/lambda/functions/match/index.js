import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, ok, badRequest, forbidden, notFound, serverError, getUserIdFromEvent } from "./shared.js";

const MATCHES_TABLE = process.env.MATCHES_TABLE;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
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

    // GET /matches/{matchId}/messages
    if (method === "GET" && path === "/matches/{matchId}/messages") {
      const { matchId } = event.pathParameters;

      const matchResult = await ddb.send(new GetCommand({
        TableName: MATCHES_TABLE,
        Key: { matchId },
      }));
      if (!matchResult.Item) return notFound("매칭을 찾을 수 없어요");
      if (matchResult.Item.user1Id !== userId && matchResult.Item.user2Id !== userId) {
        return forbidden("이 대화에 접근할 수 없어요");
      }

      const limit = Math.min(parseInt(event.queryStringParameters?.limit || "50"), 100);
      const nextTokenRaw = event.queryStringParameters?.nextToken;
      const exclusiveStartKey = nextTokenRaw
        ? JSON.parse(Buffer.from(nextTokenRaw, "base64url").toString())
        : undefined;

      const params = {
        TableName: MESSAGES_TABLE,
        KeyConditionExpression: "matchId = :mid",
        ExpressionAttributeValues: { ":mid": matchId },
        ScanIndexForward: false,
        Limit: limit,
      };
      if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

      const result = await ddb.send(new QueryCommand(params));

      const nextToken = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
        : null;

      // 시간 오름차순 반환 — DDB 는 최신순(ScanIndexForward:false)으로 페이지를 받아
      //   "최근 메시지 우선" 페이지네이션은 유지하되, 페이지 내부는 오래된→최신 순으로 뒤집어 내려준다.
      //   (포맷은 WebSocket newMessage.message 와 동일: { matchId, timestamp, senderId, content, type })
      const messages = (result.Items || []).reverse();

      return ok({ messages, nextToken });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Match Lambda Error:", err);
    return serverError();
  }
};
