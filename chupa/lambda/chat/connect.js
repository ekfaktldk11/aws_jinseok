// ── connect.js ──
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb } = require("../shared/utils");

const TABLE = process.env.CONNECTIONS_TABLE;

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.queryStringParameters?.userId;

  if (!userId) return { statusCode: 401, body: "userId required" };

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      connectionId,
      userId,
      connectedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 86400, // 24시간 TTL
    },
  }));

  return { statusCode: 200, body: "Connected" };
};
