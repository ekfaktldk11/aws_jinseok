import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { ddb } from "chupa-shared";

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;

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

  for (const conn of recipientConns.Items || []) {
    try {
      await apiGw.send(new PostToConnectionCommand({
        ConnectionId: conn.connectionId,
        Data: JSON.stringify({ action: "newMessage", message }),
      }));
    } catch (err) {
      if (err.statusCode === 410) {
        await ddb.send(new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId: conn.connectionId },
        }));
      }
    }
  }

  return { statusCode: 200, body: "Message sent" };
};
