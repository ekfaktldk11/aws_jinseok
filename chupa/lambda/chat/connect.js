import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../shared/utils.js";

const TABLE = process.env.CONNECTIONS_TABLE;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.queryStringParameters?.userId;

  if (!userId) return { statusCode: 401, body: "userId required" };

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      connectionId,
      userId,
      connectedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    },
  }));

  return { statusCode: 200, body: "Connected" };
};
