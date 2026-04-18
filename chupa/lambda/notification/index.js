async function sendPush(userId, payload) {
  // TODO: FCM/APNs 실제 푸시 전송
  console.log(`[PUSH] userId=${userId}`, payload);
}

export const handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    const { type, userId, data } = message;

    console.log(`Sending notification: type=${type}, userId=${userId}`);

    switch (type) {
      case "chupa_received":
        await sendPush(userId, {
          title: "추파 🫶",
          body: "누군가 추파를 던졌어요!",
          data: { screen: "ChupaList" },
        });
        break;

      case "match_success":
        await sendPush(userId, {
          title: "매칭 성공! 🎉",
          body: `${data.partnerName}님과 매칭되었어요!`,
          data: { screen: "ChatRoom", matchId: data.matchId },
        });
        break;

      case "new_message":
        await sendPush(userId, {
          title: `${data.senderName}`,
          body: data.preview,
          data: { screen: "ChatRoom", matchId: data.matchId },
        });
        break;

      case "message_deadline":
        await sendPush(userId, {
          title: "⏰ 메시지 타이머",
          body: "매칭이 3시간 뒤 만료돼요. 지금 메시지를 보내세요!",
          data: { screen: "ChatRoom", matchId: data.matchId },
        });
        break;

      default:
        console.warn(`Unknown notification type: ${type}`);
    }
  }
};
