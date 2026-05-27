import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { ddb, publishNotification } from "./shared.js";

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body);
  const { matchId, content, type = "text" } = body;

  if (!matchId || !content) {
    return { statusCode: 400, body: "matchId and content required" };
  }

  const connResult = await ddb.send(new GetCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
  }));
  const senderId = connResult.Item?.userId;
  if (!senderId) return { statusCode: 401, body: "Not authenticated" };

  const matchResult = await ddb.send(new GetCommand({
    TableName: MATCHES_TABLE,
    Key: { matchId },
  }));
  const match = matchResult.Item;
  if (!match || (match.user1Id !== senderId && match.user2Id !== senderId)) {
    return { statusCode: 403, body: "Not authorized for this match" };
  }

  const timestamp = new Date().toISOString();
  const message = { matchId, timestamp, senderId, content, type };

  await ddb.send(new PutCommand({
    TableName: MESSAGES_TABLE,
    Item: message,
  }));

  const recipientId = match.user1Id === senderId ? match.user2Id : match.user1Id;

  const recipientConns = await ddb.send(new QueryCommand({
    TableName: CONNECTIONS_TABLE,
    IndexName: "userId-index",
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": recipientId },
  }));

  const endpoint = process.env.WEBSOCKET_ENDPOINT;
  const apiGw = new ApiGatewayManagementApiClient({ endpoint });

  let delivered = false;
  for (const conn of recipientConns.Items || []) {
    try {
      await apiGw.send(new PostToConnectionCommand({
        ConnectionId: conn.connectionId,
        Data: JSON.stringify({ action: "newMessage", message }),
      }));
      delivered = true;
    } catch (err) {
      if (err.statusCode === 410) {
        await ddb.send(new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId: conn.connectionId },
        }));
      }
    }
  }

  // 수신자가 오프라인이면 푸시 알림 발송
  if (!delivered) {
    const senderResult = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId: senderId },
    }));
    await publishNotification({
      type: "new_message",
      userId: recipientId,
      data: {
        matchId,
        senderName: senderResult.Item?.name || "상대",
        preview: content.slice(0, 50),
      },
    });
  }

  return { statusCode: 200, body: "Message sent" };
};
