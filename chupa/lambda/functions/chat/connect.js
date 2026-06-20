import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./shared.js";

const TABLE = process.env.CONNECTIONS_TABLE;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  // 🛡️ userId 는 검증된 토큰(authorizer context)에서만 받는다.
  //   쿼리스트링 ?userId= 신뢰 제거 → 연결 주체 위조 차단(authorizer 가 sub 를 주입).
  const userId = event.requestContext.authorizer?.userId;

  if (!userId) return { statusCode: 401, body: "Unauthorized" };

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
