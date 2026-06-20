import { PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, noContent, badRequest, serverError, getUserIdFromEvent } from "./shared.js";

const TABLE = process.env.DEVICES_TABLE;

export const handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // POST /devices
    if (method === "POST" && path === "/devices") {
      const body = JSON.parse(event.body);
      const { token, platform } = body;

      if (!token || !platform) return badRequest("token, platform이 필요해요");
      if (!["ios", "android", "web"].includes(platform)) return badRequest("platform은 ios, android, web 중 하나여야 해요");

      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          userId,
          token,
          platform,
          registeredAt: new Date().toISOString(),
          expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400, // 90일
        },
      }));

      return noContent();
    }

    // DELETE /devices
    if (method === "DELETE" && path === "/devices") {
      const body = JSON.parse(event.body || "{}");
      const { token } = body;

      if (!token) return badRequest("token이 필요해요");

      await ddb.send(new DeleteCommand({
        TableName: TABLE,
        Key: { userId, token },
      }));

      return noContent();
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Device Lambda Error:", err);
    return serverError();
  }
};
