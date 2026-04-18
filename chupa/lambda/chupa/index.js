import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, ok, created, badRequest, forbidden, serverError, getUserIdFromEvent } from "../shared/utils.js";

const CHUPAS_TABLE = process.env.CHUPAS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const CHECKINS_TABLE = process.env.CHECKINS_TABLE;
const MAX_DAILY_CHUPAS = 5;

export const handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // POST /chupas
    if (method === "POST" && path === "/chupas") {
      const body = JSON.parse(event.body);
      const { toUserId, venueId } = body;

      if (!toUserId || !venueId) return badRequest("toUserId, venueId가 필요해요");
      if (toUserId === userId) return badRequest("자신에게는 추파를 던질 수 없어요");

      const today = new Date().toISOString().slice(0, 10);
      const sentResult = await ddb.send(new QueryCommand({
        TableName: CHUPAS_TABLE,
        KeyConditionExpression: "fromUserId = :uid",
        FilterExpression: "begins_with(createdAt, :today)",
        ExpressionAttributeValues: { ":uid": userId, ":today": today },
      }));
      if ((sentResult.Items?.length || 0) >= MAX_DAILY_CHUPAS) {
        return forbidden("오늘 추파를 다 사용했어요. 추파 패스로 무제한 이용하세요!");
      }

      const existing = await ddb.send(new GetCommand({
        TableName: CHUPAS_TABLE,
        Key: { fromUserId: userId, toUserId },
      }));
      if (existing.Item) return badRequest("이미 추파를 보냈어요");

      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: CHUPAS_TABLE,
        Item: { fromUserId: userId, toUserId, venueId, createdAt: now, status: "pending" },
      }));

      // 양방향 매칭 확인
      const reverse = await ddb.send(new GetCommand({
        TableName: CHUPAS_TABLE,
        Key: { fromUserId: toUserId, toUserId: userId },
      }));

      if (reverse.Item) {
        const matchId = `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

        const checkinResult = await ddb.send(new QueryCommand({
          TableName: CHECKINS_TABLE,
          KeyConditionExpression: "venueId = :vid",
          Limit: 1,
          ExpressionAttributeValues: { ":vid": venueId },
        }));
        const venueName = checkinResult.Items?.[0]?.venueName || "알 수 없는 매장";

        await ddb.send(new PutCommand({
          TableName: MATCHES_TABLE,
          Item: {
            matchId, user1Id: userId, user2Id: toUserId,
            venueId, venueName, matchedAt: now,
            firstMessageDeadline: deadline, status: "active",
          },
        }));

        const updateStatus = { "#s": "status" };
        const matchedVal = { ":matched": "matched" };
        await ddb.send(new UpdateCommand({
          TableName: CHUPAS_TABLE, Key: { fromUserId: userId, toUserId },
          UpdateExpression: "SET #s = :matched",
          ExpressionAttributeNames: updateStatus, ExpressionAttributeValues: matchedVal,
        }));
        await ddb.send(new UpdateCommand({
          TableName: CHUPAS_TABLE, Key: { fromUserId: toUserId, toUserId: userId },
          UpdateExpression: "SET #s = :matched",
          ExpressionAttributeNames: updateStatus, ExpressionAttributeValues: matchedVal,
        }));

        return created({ matched: true, matchId, message: "매칭 성공! 🎉", firstMessageDeadline: deadline });
      }

      return created({ matched: false, message: "추파를 보냈어요! 🫶" });
    }

    // GET /chupas/received
    if (method === "GET" && path === "/chupas/received") {
      const result = await ddb.send(new QueryCommand({
        TableName: CHUPAS_TABLE,
        IndexName: "toUserId-index",
        KeyConditionExpression: "toUserId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        ScanIndexForward: false,
      }));
      return ok({ chupas: result.Items || [] });
    }

    // GET /chupas/sent
    if (method === "GET" && path === "/chupas/sent") {
      const result = await ddb.send(new QueryCommand({
        TableName: CHUPAS_TABLE,
        KeyConditionExpression: "fromUserId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        ScanIndexForward: false,
      }));
      return ok({ chupas: result.Items || [] });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Chupa Lambda Error:", err);
    return serverError();
  }
};
