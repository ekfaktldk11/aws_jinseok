import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { ddb, publishNotification } from "./shared.js";

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const MAX_CONTENT_LENGTH = 1000;

// 제어문자(0x00-0x1F, 0x7F) 제거 + 트림. 단 줄바꿈/탭(\t \n \r)은 보존.
// RN 클라 렌더라 HTML 이스케이프는 불필요하나, 제어문자/길이는 서버에서 강제한다.
function sanitize(raw) {
  const s = String(raw ?? "");
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    out += ch;
  }
  return out.trim();
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = process.env.WEBSOCKET_ENDPOINT;
  const apiGw = new ApiGatewayManagementApiClient({ endpoint });

  // 에러는 발신 connection 에 { action:'error', code, message } 로 push.
  const sendError = async (code, message) => {
    try {
      await apiGw.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ action: "error", code, message }),
      }));
    } catch { /* 연결 끊김 등은 무시 */ }
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    await sendError("bad_request", "잘못된 요청 형식이에요");
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { matchId, type = "text" } = body;
  const content = sanitize(body.content);

  if (!matchId || !content) {
    await sendError("bad_request", "matchId, content가 필요해요");
    return { statusCode: 400, body: "matchId and content required" };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    await sendError("too_long", `메시지는 ${MAX_CONTENT_LENGTH}자까지 보낼 수 있어요`);
    return { statusCode: 400, body: "content too long" };
  }

  // ① 발신자 식별 (connectionId → userId 매핑)
  const connResult = await ddb.send(new GetCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
  }));
  const senderId = connResult.Item?.userId;
  if (!senderId) {
    await sendError("unauthenticated", "인증되지 않은 연결이에요");
    return { statusCode: 401, body: "Not authenticated" };
  }

  // ① 발신자가 matchId 참가자인지 검증
  const matchResult = await ddb.send(new GetCommand({
    TableName: MATCHES_TABLE,
    Key: { matchId },
  }));
  const match = matchResult.Item;
  if (!match || (match.user1Id !== senderId && match.user2Id !== senderId)) {
    await sendError("forbidden", "이 대화에 접근할 수 없어요");
    return { statusCode: 403, body: "Not authorized for this match" };
  }

  const recipientId = match.user1Id === senderId ? match.user2Id : match.user1Id;

  // ② 차단 관계 검증 (양방향) — 어느 쪽이든 차단했으면 전송 거부
  const [senderUser, recipientUser] = await Promise.all([
    ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: senderId } })),
    ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: recipientId } })),
  ]);
  const senderBlocked = senderUser.Item?.blockedUsers?.has?.(recipientId);
  const recipientBlocked = recipientUser.Item?.blockedUsers?.has?.(senderId);
  if (senderBlocked || recipientBlocked) {
    await sendError("blocked", "이 사용자에게는 메시지를 보낼 수 없어요");
    return { statusCode: 403, body: "Blocked relationship" };
  }

  // ④ 첫 메시지 24h 마감 검증 — 아직 메시지가 하나도 없고 마감이 지났으면 거부
  if (match.firstMessageDeadline) {
    const existing = await ddb.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "matchId = :mid",
      ExpressionAttributeValues: { ":mid": matchId },
      Limit: 1,
    }));
    const isFirstMessage = (existing.Items?.length || 0) === 0;
    if (isFirstMessage && Date.now() > new Date(match.firstMessageDeadline).getTime()) {
      await sendError("deadline_passed", "첫 메시지 시간이 지나 대화가 만료됐어요");
      return { statusCode: 403, body: "First message deadline passed" };
    }
  }

  const timestamp = new Date().toISOString();
  const message = { matchId, timestamp, senderId, content, type };

  await ddb.send(new PutCommand({
    TableName: MESSAGES_TABLE,
    Item: message,
  }));

  // ⚠️ fan-out: 매칭 양쪽 참가자의 모든 활성 connection 에 push.
  //   - 수신자: 안 읽음 배지/목록/정렬 실시간 갱신
  //   - 발신자: 멀티디바이스 동기화 (요청을 보낸 connection 자신은 제외)
  const [recipientConns, senderConns] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: "userId-index",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": recipientId },
    })),
    ddb.send(new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: "userId-index",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": senderId },
    })),
  ]);

  const targets = [
    ...(recipientConns.Items || []).map((c) => ({ connectionId: c.connectionId, isRecipient: true })),
    ...(senderConns.Items || [])
      .filter((c) => c.connectionId !== connectionId)
      .map((c) => ({ connectionId: c.connectionId, isRecipient: false })),
  ];

  let deliveredToRecipient = false;
  await Promise.all(targets.map(async (target) => {
    try {
      await apiGw.send(new PostToConnectionCommand({
        ConnectionId: target.connectionId,
        Data: JSON.stringify({ action: "newMessage", message }),
      }));
      if (target.isRecipient) deliveredToRecipient = true;
    } catch (err) {
      if (err.statusCode === 410 || err.name === "GoneException") {
        await ddb.send(new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId: target.connectionId },
        }));
      }
    }
  }));

  // 수신자가 오프라인이면 푸시 알림 발송
  if (!deliveredToRecipient) {
    await publishNotification({
      type: "new_message",
      userId: recipientId,
      data: {
        matchId,
        senderName: senderUser.Item?.name || "상대",
        preview: content.slice(0, 50),
      },
    });
  }

  return { statusCode: 200, body: "Message sent" };
};
