import { PutCommand, DeleteCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, ok, created, badRequest, forbidden, serverError, getUserIdFromEvent } from "./shared.js";

const CHECKINS_TABLE = process.env.CHECKINS_TABLE;
const VENUE_CACHE_TABLE = process.env.VENUE_CACHE_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const CHECKIN_RADIUS_M = 100;
const CHECKIN_TTL_HOURS = 2;

function toRad(deg) { return deg * Math.PI / 180; }

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // POST /checkins
    if (method === "POST" && path === "/checkins") {
      const body = JSON.parse(event.body);
      const { venueId, lat, lng } = body;

      if (!venueId || !lat || !lng) return badRequest("venueId, lat, lng가 필요해요");

      const venueResult = await ddb.send(new GetCommand({
        TableName: VENUE_CACHE_TABLE,
        Key: { venueId },
      }));
      if (!venueResult.Item) return badRequest("매장 정보를 찾을 수 없어요");
      const venue = venueResult.Item;

      const distance = getDistanceMeters(lat, lng, venue.lat, venue.lng);
      if (distance > CHECKIN_RADIUS_M) {
        return forbidden(`매장에서 너무 멀어요 (${Math.round(distance)}m). ${CHECKIN_RADIUS_M}m 이내에서 체크인해주세요.`);
      }

      const now = new Date();
      const expiresAt = Math.floor(now.getTime() / 1000) + (CHECKIN_TTL_HOURS * 3600);

      await ddb.send(new PutCommand({
        TableName: CHECKINS_TABLE,
        Item: {
          venueId,
          userId,
          venueName: venue.name,
          venueType: venue.category,
          checkedInAt: now.toISOString(),
          expiresAt,
          userLat: lat,
          userLng: lng,
          distance: Math.round(distance),
        },
      }));

      // 누적 체크인 카운터(원자적 증가). CheckIns는 2h TTL이라 이력이 남지 않으므로
      //   "지금까지 체크인한 총 횟수"는 Users 레코드에 누적한다. (POST 1회 = +1)
      //   ※ 통계 실패가 체크인 자체를 막지 않도록 await 하되 에러는 삼킨다.
      try {
        await ddb.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { userId },
          UpdateExpression: "ADD totalCheckins :one",
          ExpressionAttributeValues: { ":one": 1 },
        }));
      } catch (err) {
        console.error("totalCheckins increment failed:", err);
      }

      return created({
        message: "체크인 완료!",
        checkin: {
          venueId,
          venueName: venue.name,
          checkedInAt: now.toISOString(),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
          distance: Math.round(distance),
        },
      });
    }

    // DELETE /checkins/{venueId}
    if (method === "DELETE" && path === "/checkins/{venueId}") {
      const { venueId } = event.pathParameters;
      await ddb.send(new DeleteCommand({
        TableName: CHECKINS_TABLE,
        Key: { venueId, userId },
      }));
      return ok({ message: "체크아웃 완료!" });
    }

    // GET /checkins/venue/{venueId}
    if (method === "GET" && path === "/checkins/venue/{venueId}") {
      const { venueId } = event.pathParameters;
      const now = Math.floor(Date.now() / 1000);

      const result = await ddb.send(new QueryCommand({
        TableName: CHECKINS_TABLE,
        KeyConditionExpression: "venueId = :vid",
        FilterExpression: "expiresAt > :now",
        ExpressionAttributeValues: { ":vid": venueId, ":now": now },
      }));

      const users = [];
      for (const checkin of result.Items || []) {
        if (checkin.userId === userId) continue;
        const userResult = await ddb.send(new GetCommand({
          TableName: USERS_TABLE,
          Key: { userId: checkin.userId },
        }));
        if (userResult.Item) {
          const { email, blockedUsers, ...profile } = userResult.Item;
          users.push({ ...profile, checkedInAt: checkin.checkedInAt });
        }
      }

      return ok({ users, count: users.length });
    }

    // GET /checkins/me
    if (method === "GET" && path === "/checkins/me") {
      const result = await ddb.send(new QueryCommand({
        TableName: CHECKINS_TABLE,
        IndexName: "userId-index",
        KeyConditionExpression: "userId = :uid",
        FilterExpression: "expiresAt > :now",
        ExpressionAttributeValues: {
          ":uid": userId,
          ":now": Math.floor(Date.now() / 1000),
        },
      }));

      return ok({ checkin: result.Items?.[0] || null });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("CheckIn Lambda Error:", err);
    return serverError();
  }
};
