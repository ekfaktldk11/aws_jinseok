const { PutCommand, DeleteCommand, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb, ok, created, badRequest, forbidden, serverError, getUserIdFromEvent } = require("../shared/utils");

const CHECKINS_TABLE = process.env.CHECKINS_TABLE;
const VENUE_CACHE_TABLE = process.env.VENUE_CACHE_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const CHECKIN_RADIUS_M = 100;
const CHECKIN_TTL_HOURS = 2;
const MAX_DAILY_CHECKINS = 3;

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // POST /checkins — 체크인
    if (method === "POST" && path === "/checkins") {
      const body = JSON.parse(event.body);
      const { venueId, lat, lng } = body;

      if (!venueId || !lat || !lng) return badRequest("venueId, lat, lng가 필요해요");

      // 1. 매장 정보 가져오기
      const venueResult = await ddb.send(new GetCommand({
        TableName: VENUE_CACHE_TABLE,
        Key: { venueId },
      }));
      if (!venueResult.Item) return badRequest("매장 정보를 찾을 수 없어요");
      const venue = venueResult.Item;

      // 2. GPS 거리 검증
      const distance = getDistanceMeters(lat, lng, venue.lat, venue.lng);
      if (distance > CHECKIN_RADIUS_M) {
        return forbidden(`매장에서 너무 멀어요 (${Math.round(distance)}m). ${CHECKIN_RADIUS_M}m 이내에서 체크인해주세요.`);
      }

      // 3. 일일 체크인 횟수 확인 (프리미엄 체크 추후 추가)
      // TODO: 오늘 체크인 횟수 조회

      // 4. 체크인 생성 (TTL: 2시간)
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
          expiresAt, // DynamoDB TTL (epoch seconds)
          userLat: lat,
          userLng: lng,
          distance: Math.round(distance),
        },
      }));

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

    // DELETE /checkins/{venueId} — 체크아웃
    if (method === "DELETE" && path === "/checkins/{venueId}") {
      const { venueId } = event.pathParameters;
      await ddb.send(new DeleteCommand({
        TableName: CHECKINS_TABLE,
        Key: { venueId, userId },
      }));
      return ok({ message: "체크아웃 완료!" });
    }

    // GET /checkins/venue/{venueId} — 매장 내 사용자 목록
    if (method === "GET" && path === "/checkins/venue/{venueId}") {
      const { venueId } = event.pathParameters;
      const now = Math.floor(Date.now() / 1000);

      const result = await ddb.send(new QueryCommand({
        TableName: CHECKINS_TABLE,
        KeyConditionExpression: "venueId = :vid",
        FilterExpression: "expiresAt > :now",
        ExpressionAttributeValues: {
          ":vid": venueId,
          ":now": now,
        },
      }));

      // 각 체크인된 사용자의 프로필 가져오기
      const users = [];
      for (const checkin of result.Items || []) {
        if (checkin.userId === userId) continue; // 본인 제외
        const userResult = await ddb.send(new GetCommand({
          TableName: USERS_TABLE,
          Key: { userId: checkin.userId },
        }));
        if (userResult.Item) {
          const { email, blockedUsers, ...profile } = userResult.Item;
          users.push({
            ...profile,
            checkedInAt: checkin.checkedInAt,
          });
        }
      }

      return ok({ users, count: users.length });
    }

    // GET /checkins/me — 내 현재 체크인
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

      const activeCheckin = result.Items?.[0] || null;
      return ok({ checkin: activeCheckin });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("CheckIn Lambda Error:", err);
    return serverError();
  }
};

// Haversine formula
function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }
