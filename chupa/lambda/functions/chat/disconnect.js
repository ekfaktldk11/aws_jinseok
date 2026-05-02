import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "chupa-shared";

const TABLE = process.env.CONNECTIONS_TABLE;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { connectionId },
  }));

  return { statusCode: 200, body: "Disconnected" };
};
