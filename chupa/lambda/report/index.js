const { PutCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb, ok, created, badRequest, serverError, getUserIdFromEvent } = require("../shared/utils");

const REPORTS_TABLE = process.env.REPORTS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const AUTO_BAN_THRESHOLD = 3;

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserIdFromEvent(event);

  try {
    // POST /reports — 신고
    if (method === "POST" && path === "/reports") {
      const body = JSON.parse(event.body);
      const { reportedUserId, reason, detail } = body;

      if (!reportedUserId || !reason) return badRequest("reportedUserId, reason이 필요해요");
      if (reportedUserId === userId) return badRequest("자신을 신고할 수 없어요");

      const validReasons = [
        "inappropriate_photo",
        "harassment",
        "spam",
        "fake_profile",
        "underage",
        "other",
      ];
      if (!validReasons.includes(reason)) return badRequest("올바른 신고 사유를 선택해주세요");

      const reportId = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await ddb.send(new PutCommand({
        TableName: REPORTS_TABLE,
        Item: {
          reportId,
          reporterUserId: userId,
          reportedUserId,
          reason,
          detail: detail || "",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      }));

      // 누적 신고 수 확인 → 자동 이용정지
      const reportCount = await ddb.send(new QueryCommand({
        TableName: REPORTS_TABLE,
        IndexName: "reportedUserId-index",
        KeyConditionExpression: "reportedUserId = :uid",
        ExpressionAttributeValues: { ":uid": reportedUserId },
        Select: "COUNT",
      }));

      if ((reportCount.Count || 0) >= AUTO_BAN_THRESHOLD) {
        await ddb.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { userId: reportedUserId },
          UpdateExpression: "SET #s = :banned, bannedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":banned": "banned",
            ":now": new Date().toISOString(),
          },
        }));
      }

      return created({ message: "신고가 접수되었어요. 검토 후 조치할게요.", reportId });
    }

    // POST /users/{userId}/block — 차단
    if (method === "POST" && path === "/users/{userId}/block") {
      const { userId: targetUserId } = event.pathParameters;
      if (targetUserId === userId) return badRequest("자신을 차단할 수 없어요");

      await ddb.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId },
        UpdateExpression: "ADD blockedUsers :target",
        ExpressionAttributeValues: {
          ":target": new Set([targetUserId]),
        },
      }));

      return ok({ message: "차단되었어요. 이 사용자는 더 이상 보이지 않아요." });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Report Lambda Error:", err);
    return serverError();
  }
};
