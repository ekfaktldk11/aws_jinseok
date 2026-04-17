const { PutCommand, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");
const { ddb } = require("../shared/utils");

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const MATCHES_TABLE = process.env.MATCHES_TABLE;

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body);
  const { matchId, content, type = "text" } = body;

  if (!matchId || !content) {
    return { statusCode: 400, body: "matchId and content required" };
  }

  // 1. 연결에서 userId 가져오기
  const connResult = await ddb.send(new GetCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
  }));
  const senderId = connResult.Item?.userId;
  if (!senderId) return { statusCode: 401, body: "Not authenticated" };

  // 2. 매칭 확인 (이 사용자가 이 매칭에 속하는지)
  const matchResult = await ddb.send(new GetCommand({
    TableName: MATCHES_TABLE,
    Key: { matchId },
  }));
  const match = matchResult.Item;
  if (!match || (match.user1Id !== senderId && match.user2Id !== senderId)) {
    return { statusCode: 403, body: "Not authorized for this match" };
  }

  // 3. 메시지 저장
  const timestamp = new Date().toISOString();
  const message = {
    matchId,
    timestamp,
    senderId,
    content,
    type,
  };

  await ddb.send(new PutCommand({
    TableName: MESSAGES_TABLE,
    Item: message,
  }));

  // 4. 상대방에게 메시지 전달
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
        Data: JSON.stringify({
          action: "newMessage",
          message,
        }),
      }));
    } catch (err) {
      if (err.statusCode === 410) {
        // 끊어진 연결 정리
        await ddb.send(new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId: conn.connectionId },
        }));
      }
    }
  }

  return { statusCode: 200, body: "Message sent" };
};
