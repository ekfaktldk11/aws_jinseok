import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function getTokensForUser(userId) {
  if (!DEVICES_TABLE) return [];
  const result = await ddb.send(new QueryCommand({
    TableName: DEVICES_TABLE,
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
  }));
  return (result.Items || []).map((item) => item.token);
}

async function sendExpoNotifications(tokens, payload) {
  if (!tokens.length) return;

  const messages = tokens.map((to) => ({ to, sound: "default", ...payload }));

  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    console.error(`Expo Push API HTTP ${res.status}`);
    return;
  }

  const json = await res.json();
  for (const ticket of json.data || []) {
    if (ticket.status === "error") {
      console.error("Expo ticket error:", ticket.message, ticket.details);
    }
  }
}

export const handler = async (event) => {
  for (const record of event.Records) {
    const { type, userId, data } = JSON.parse(record.Sns.Message);

    const tokens = await getTokensForUser(userId);
    if (!tokens.length) {
      console.log(`No tokens: userId=${userId} type=${type}`);
      continue;
    }

    let payload;
    switch (type) {
      // 🔒 제한(갈림길 A): chupa_received 는 받는 사람에게 추파 수신을 알리므로
      //    MVP에서 발송 경로에서 제거. (chupa lambda의 publishNotification 호출 자체도 제거됨)
      // case "chupa_received":
      //   payload = {
      //     title: "추파 🫶",
      //     body: "누군가 추파를 던졌어요!",
      //     data: { screen: "ChupaList" },
      //   };
      //   break;
      case "match_success":
        payload = {
          title: "매칭 성공! 🎉",
          body: `${data.partnerName}님과 매칭되었어요!`,
          data: { screen: "ChatRoom", matchId: data.matchId },
        };
        break;
      case "new_message":
        payload = {
          title: data.senderName,
          body: data.preview,
          data: { screen: "ChatRoom", matchId: data.matchId },
        };
        break;
      case "message_deadline":
        payload = {
          title: "⏰ 메시지 타이머",
          body: "매칭이 3시간 뒤 만료돼요. 지금 메시지를 보내세요!",
          data: { screen: "ChatRoom", matchId: data.matchId },
        };
        break;
      default:
        console.warn(`Unknown notification type: ${type}`);
        continue;
    }

    await sendExpoNotifications(tokens, payload);
    console.log(`Pushed type=${type} userId=${userId} tokens=${tokens.length}`);
  }
};
