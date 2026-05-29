import { PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, ok, created, badRequest, serverError, getUserIdFromEvent } from "./shared.js";

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
      if (!["ios", "android"].includes(platform)) return badRequest("platform은 ios 또는 android여야 해요");

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

      return created({ message: "기기가 등록되었어요" });
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

      return ok({ message: "기기 등록이 해제되었어요" });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Device Lambda Error:", err);
    return serverError();
  }
};
