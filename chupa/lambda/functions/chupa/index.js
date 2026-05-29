import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ddb, ok, created, badRequest, forbidden, serverError,
  getUserIdFromEvent, publishNotification,
} from "./shared.js";

const CHUPAS_TABLE = process.env.CHUPAS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const CHECKINS_TABLE = process.env.CHECKINS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const MAX_DAILY_CHUPAS = 5;
// 추파 유효시간(초). 이 시간 안에 상대도 나에게 추파를 보내야 매칭 성립.
// "동시 쌍방 일치"의 가혹함을 시간창으로 완화한다. ※ 만료돼도 레코드는 삭제하지 않음(보낸 기록 보존).
// 📡 TODO: 클라 constants/config.ts TIMING 의 추파 유효시간과 반드시 동일 값으로 유지할 것.
const CHUPA_VALID_SECONDS = 7 * 24 * 60 * 60; // 7일

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

      // 🛡️ 일일 한도 카운트: createdAt(ISO 8601 문자열) 의 사전식 범위 비교로 '오늘' 을 판정.
      //    구버전 begins_with(createdAt, :today) 는 의도대로 동작하지 않아 범위 조건으로 교체.
      const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
      const sentResult = await ddb.send(new QueryCommand({
        TableName: CHUPAS_TABLE,
        KeyConditionExpression: "fromUserId = :uid",
        FilterExpression: "createdAt >= :todayStart",
        ExpressionAttributeValues: { ":uid": userId, ":todayStart": todayStart },
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
      const nowSec = Math.floor(Date.now() / 1000);
      await ddb.send(new PutCommand({
        TableName: CHUPAS_TABLE,
        Item: {
          fromUserId: userId, toUserId, venueId,
          createdAt: now, status: "pending",
          level: 1,                                // MVP는 항상 1단계(사일런트 추파). 2단계는 구조만 확보.
          expiresAt: nowSec + CHUPA_VALID_SECONDS, // epoch sec. ※ ChupasTable에 TTL 미설정 → 만료돼도 삭제 안 됨.
        },
      }));

      // 양방향 매칭 확인 — 유효시간(expiresAt)이 지나지 않은 역방향 추파만 인정.
      //   구버전 레코드(expiresAt 없음)는 만료 없음으로 간주(하위호환).
      const reverse = await ddb.send(new GetCommand({
        TableName: CHUPAS_TABLE,
        Key: { fromUserId: toUserId, toUserId: userId },
      }));
      const reverseValid = reverse.Item
        && (reverse.Item.expiresAt == null || reverse.Item.expiresAt > nowSec);

      if (reverseValid) {
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

        // 매칭 성공 알림 양쪽에 발송
        const [u1, u2] = await Promise.all([
          ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } })),
          ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: toUserId } })),
        ]);
        await Promise.all([
          publishNotification({
            type: "match_success",
            userId,
            data: { matchId, partnerName: u2.Item?.name || "상대" },
          }),
          publishNotification({
            type: "match_success",
            userId: toUserId,
            data: { matchId, partnerName: u1.Item?.name || "상대" },
          }),
        ]);

        return created({ matched: true, matchId, message: "매칭 성공! 🎉", firstMessageDeadline: deadline });
      }

      // 🛡️ 거절의 비가시성(갈림길 A): 미성사 단방향 추파는 받는 사람에게
      //    어떤 알림/노출도 하지 않는다. (구버전의 chupa_received 발송 제거)
      // 📡 TODO(2단계): signalConsent=true AND level>=2 인 경우에 한해 수신 동의 기반 알림 허용.
      return created({ matched: false, message: "추파를 보냈어요! 🫶" });
    }

    // GET /chupas/received
    // 🔒 제한(갈림길 A): MVP(1단계)에서는 받는 사람에게 미성사 pending 추파를 노출하지 않는다.
    //    "추파를 받았다는 사실"조차 알 수 없어야 하므로 항상 빈 배열을 반환한다.
    // 📡 TODO(2단계): signalConsent=true AND level>=2 인 추파에 한해서만 아래 조회 결과를
    //    필터링해 반환하도록 게이팅. (toUserId-index 조회 로직은 보존)
    if (method === "GET" && path === "/chupas/received") {
      // const result = await ddb.send(new QueryCommand({
      //   TableName: CHUPAS_TABLE,
      //   IndexName: "toUserId-index",
      //   KeyConditionExpression: "toUserId = :uid",
      //   ExpressionAttributeValues: { ":uid": userId },
      //   ScanIndexForward: false,
      // }));
      return ok({ chupas: [] });
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
