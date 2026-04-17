const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb } = require("../shared/utils");

const TABLE = process.env.CONNECTIONS_TABLE;

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { connectionId },
  }));

  return { statusCode: 200, body: "Disconnected" };
};
